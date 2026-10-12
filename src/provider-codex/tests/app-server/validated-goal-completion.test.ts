import { describe, expect, it, vi } from "vitest";
import { completeValidatedNativeGoal } from "../../app-server/application/app-server-validated-goal-completion";
import type { CodexThreadGoal } from "../../app-server/domain/app-server-types";

const active: CodexThreadGoal = { threadId: "TEST-thread", objective: "Prepare accepted output", status: "active" };
const complete: CodexThreadGoal = { ...active, status: "complete" };

function fixture() {
  const controller = new AbortController();
  const client = {
    getGoal: vi.fn().mockResolvedValueOnce(active).mockResolvedValue(complete),
    setGoal: vi.fn().mockResolvedValue(complete),
    assertExecutionActive: vi.fn((signal: AbortSignal) => {
      if (signal.aborted) throw new Error("TEST-aborted");
    }),
  };
  const validate = vi.fn(async () => {});
  return { client, validate, controller, input: {
    client, validate, goal: active, threadId: active.threadId, objective: active.objective,
    runId: "TEST-run", turnNumber: 1, outputText: '{"accepted":true}',
    timeoutMs: 1000, abortSignal: controller.signal,
  } };
}

describe("trusted completed output and real native Goal completion", () => {
  it("validates before real set and requires native completion readback", async () => {
    const f = fixture();
    expect(await completeValidatedNativeGoal(f.input)).toEqual(complete);
    expect(f.validate).toHaveBeenCalledWith('{"accepted":true}', { runId: "TEST-run", turnNumber: 1 });
    expect(f.client.setGoal).toHaveBeenCalledExactlyOnceWith({
      threadId: active.threadId, objective: active.objective, status: "complete",
      timeoutMs: 1000, abortSignal: f.controller.signal,
    });
    expect(f.client.getGoal).toHaveBeenCalledTimes(2);
    expect(f.validate.mock.invocationCallOrder[0]).toBeLessThan(f.client.setGoal.mock.invocationCallOrder[0]!);
  });

  it.each(["blocked", "paused", "usageLimited", "budgetLimited"] as const)("preserves original %s Goal", async (status) => {
    const f = fixture(); const goal = { ...active, status };
    expect(await completeValidatedNativeGoal({ ...f.input, goal })).toEqual(goal);
    expect(f.validate).not.toHaveBeenCalled(); expect(f.client.setGoal).not.toHaveBeenCalled();
  });

  it("does not overwrite a pause appearing during host acceptance", async () => {
    const f = fixture(); f.client.getGoal.mockReset().mockResolvedValue({ ...active, status: "paused" });
    await expect(completeValidatedNativeGoal(f.input)).rejects.toThrow("completion_status_changed");
    expect(f.client.setGoal).not.toHaveBeenCalled();
  });

  it.each(["threadId", "objective"] as const)("rejects a different native %s", async (key) => {
    const f = fixture(); f.client.getGoal.mockReset().mockResolvedValue({ ...active, [key]: "other" });
    await expect(completeValidatedNativeGoal(f.input)).rejects.toThrow("completion_identity_conflict");
    expect(f.client.setGoal).not.toHaveBeenCalled();
  });

  it("rejects missing Goal and mismatched setter/readback instead of manufacturing success", async () => {
    for (const phase of ["missing", "setter", "readback"] as const) {
      const f = fixture();
      if (phase === "missing") f.client.getGoal.mockReset().mockResolvedValue(null);
      if (phase === "setter") f.client.setGoal.mockResolvedValue(active);
      if (phase === "readback") f.client.getGoal.mockReset().mockResolvedValueOnce(active).mockResolvedValue(active);
      await expect(completeValidatedNativeGoal(f.input)).rejects.toThrow(/completion_/);
    }
  });

  it("does not mark rejected output complete or expose the validator error payload", async () => {
    const f = fixture(); f.validate.mockRejectedValue(new Error("TEST-private-source"));
    await expect(completeValidatedNativeGoal(f.input)).rejects.toThrow("codex_goal_completed_output_rejected");
    expect(f.client.setGoal).not.toHaveBeenCalled(); expect(f.client.getGoal).not.toHaveBeenCalled();
  });

  it("honors cancellation after acceptance before native mutation", async () => {
    const f = fixture(); f.validate.mockImplementation(async () => { f.controller.abort(); });
    await expect(completeValidatedNativeGoal(f.input)).rejects.toThrow("TEST-aborted");
    expect(f.client.setGoal).not.toHaveBeenCalled();
  });

  it("validates an already complete Goal without setting it again", async () => {
    const f = fixture(); f.client.getGoal.mockReset().mockResolvedValue(complete);
    expect(await completeValidatedNativeGoal({ ...f.input, goal: complete })).toEqual(complete);
    expect(f.validate).toHaveBeenCalledOnce(); expect(f.client.setGoal).not.toHaveBeenCalled();
  });

  it("refuses cancellation delivered with an already complete readback", async () => {
    const f = fixture(); f.client.getGoal.mockReset().mockImplementation(async () => {
      f.controller.abort(); return complete;
    });
    await expect(completeValidatedNativeGoal(f.input)).rejects.toThrow("TEST-aborted");
    expect(f.client.setGoal).not.toHaveBeenCalled();
  });
});
