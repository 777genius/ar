import { ChildLifetimeError, ChildLifetimeFailure } from "@vioxen/subscription-runtime/core";
import { AppServerTurnCheckpointError } from "../../app-server/application/app-server-turn-checkpoint";
import { AppServerUsageError } from "../../app-server/domain/app-server-usage-error";
import { describe, expect, it, vi } from "vitest";
import { completeValidatedNativeGoal } from "../../app-server/application/app-server-validated-goal-completion";
import { AppServerOutputValidationError, AppServerOutputValidationStage as Stage, AppServerOutputValidationCode as Code, validateAppServerCompletedOutput } from "../../app-server/application/app-server-output-validation-error";
import { classifyCodexFailure } from "../../failure-classifier";
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
      return 0;
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
    const f = fixture(); const original = new Error("TEST-private-source"); f.validate.mockRejectedValue(original);
    const failure = await completeValidatedNativeGoal(f.input).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AppServerOutputValidationError);
    expect((failure as Error).cause).toBeUndefined();
    expect((failure as Error).message).toBe("codex_goal_completed_output_rejected");
    expect(JSON.stringify(classifyCodexFailure(failure))).not.toContain("TEST-private-source");
    expect(f.client.setGoal).not.toHaveBeenCalled(); expect(f.client.getGoal).not.toHaveBeenCalled();
  });

  it.each([
    ["parse", Stage.Parse, Code.ParseFailed],
    ["normalize", Stage.Normalize, Code.NormalizeFailed],
    ["throw", Stage.Product, Code.ProductException],
    ["false", Stage.Product, Code.ProductRejected],
  ] as const)("reports finite %s rejection without completing or retaining private causes", async (mode, stage, code) => {
    const f = fixture(); const original = Object.assign(new Error("TEST-private-output-and-credential"), {
      details: { arbitrary: "TEST-private-details" }, stdout: "TEST-private-stdout", stderr: "TEST-private-stderr",
    });
    f.validate.mockImplementation(async () => validateAppServerCompletedOutput({
      text: "TEST-private-source",
      parse: () => { if (mode === "parse") throw original; return {}; },
      normalize: (value) => { if (mode === "normalize") throw original; return value; },
      validate: () => { if (mode === "throw") throw original; return mode !== "false"; },
    }));
    const failure = await completeValidatedNativeGoal(f.input).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AppServerOutputValidationError);
    expect((failure as AppServerOutputValidationError).cause).toBeUndefined();
    expect(JSON.stringify(failure)).not.toContain("TEST-private");
    const projected = classifyCodexFailure(failure);
    expect(projected).toEqual({ code: "unknown_runtime_failure", retryable: true,
      reconnectRequired: false, safeMessage: "Codex completed output did not pass host validation.",
      details: { rawCause: "codex_goal_completed_output_rejected", outputValidationStage: stage, outputValidationCode: code } });
    const legacy = classifyCodexFailure(new Error("codex_goal_completed_output_rejected"));
    expect({ code: projected.code, retryable: projected.retryable, reconnectRequired: projected.reconnectRequired })
      .toEqual({ code: legacy.code, retryable: legacy.retryable, reconnectRequired: legacy.reconnectRequired });
    expect(JSON.stringify(projected)).not.toContain("TEST-private");
    expect(f.client.setGoal).not.toHaveBeenCalled();
    expect(f.client.getGoal).not.toHaveBeenCalled();
  });

  it("preserves checkpoint and child-lifetime classification ahead of nested validation diagnostics", () => {
    const validation = new AppServerOutputValidationError(Stage.Product, Code.ProductRejected);
    for (const error of [new AppServerTurnCheckpointError(validation),
      new AppServerUsageError(new AppServerTurnCheckpointError(validation))]) {
      expect(classifyCodexFailure(error)).toMatchObject({
        code: "checkpoint_unprotected", retryable: false, reconnectRequired: false,
      });
    }
    const lifetime = new ChildLifetimeError(ChildLifetimeFailure.Expired);
    const nested = new Error("TEST-wrapper", { cause: lifetime });
    expect(classifyCodexFailure(nested)).toEqual(classifyCodexFailure(lifetime));
    const projected = classifyCodexFailure(new AppServerUsageError(validation));
    expect(projected.details?.outputValidationCode).toBe(Code.ProductRejected);
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
