import { afterEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  call: undefined as undefined | ((name: string) => Record<string, unknown>),
  delays: [] as number[],
  onSleep: undefined as undefined | (() => void),
}));

vi.mock("node:timers/promises", () => ({
  setTimeout: async (delay: number, _value: unknown, options: { signal?: AbortSignal }) => {
    harness.delays.push(delay);
    harness.onSleep?.();
    if (options.signal?.aborted) {
      const error = new Error("Aborted");
      error.name = "AbortError";
      throw error;
    }
  },
}));

vi.mock("../codex-goal-mcp", async () => {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  return {
    createCodexGoalMcpServer: () => {
      const server = new McpServer({ name: "fake-supervisor-test", version: "0.0.0" });
      for (const name of [
        "codex_goal_project_recover_operations", "codex_goal_project_controller_start",
        "codex_goal_project_controller_status", "codex_goal_control_decision",
        "codex_goal_project_controller_stop", "codex_goal_project_controller_reconcile",
      ]) {
        server.registerTool(name, { inputSchema: {} }, async () => {
          const data = harness.call!(name);
          return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
        });
      }
      return server;
    },
  };
});

import {
  ControllerSupervisorFailureReason,
  controllerSupervisorObservedStatus,
  superviseCodexGoalProjectController,
} from "../codex-goal-mcp-client";

const failedObservation = {
  ok: true,
  reason: "provider_status_failed",
  run: { status: "running" },
  liveController: { live: false, providerStatusFailed: true },
  providerObservedError: { safeMessage: "Provider disconnected" },
};
const running = { ok: true, providerObserved: { status: "running" } };
const completed = { ok: true, providerObserved: { status: "completed" } };

function setup(statuses: Record<string, unknown>[]) {
  const calls: string[] = [];
  let probe = 0;
  harness.call = (name) => {
    calls.push(name);
    if (name === "codex_goal_project_controller_status") {
      const status = statuses[probe++];
      if (!status) throw new Error("Unexpected extra status probe");
      return status;
    }
    if (name === "codex_goal_control_decision") return { ok: true, decision: { deliverableCount: 0 } };
    return { ok: true };
  };
  return calls;
}

const args = { controllerJobId: "sandbox-fake-controller" };

afterEach(() => {
  harness.delays.length = 0;
  harness.onSleep = undefined;
});

describe("controller supervisor failed observation policy", () => {
  it.each([
    failedObservation,
    { ok: true, liveController: { providerStatusFailed: true } },
    { ok: true, reason: "provider_status_failed" },
    { ok: true, providerObservedError: { safeMessage: "Disconnected" } },
  ])("does not derive even contradictory terminal status from a failed observation", (failure) => {
    expect(controllerSupervisorObservedStatus({
      ...failure,
      run: { status: "running" },
      providerObserved: { status: "completed" },
    })).toBeUndefined();
  });

  it("bounds consecutive failures without decisions, reconciliation or restart", async () => {
    const calls = setup([failedObservation, failedObservation, failedObservation]);
    const result = await superviseCodexGoalProjectController({ args });
    expect(result).toMatchObject({
      ok: false,
      reason: ControllerSupervisorFailureReason.ProviderStatusFailed,
      finalStatus: failedObservation,
    });
    expect(calls).toEqual([
      "codex_goal_project_recover_operations", "codex_goal_project_controller_start",
      ...Array(3).fill("codex_goal_project_controller_status"),
    ]);
    expect(harness.delays).toEqual([60_000, 120_000, 240_000]);
  });

  it("resets the failure budget after recovery and still handles running and terminal states", async () => {
    const calls = setup([failedObservation, failedObservation, running, failedObservation, failedObservation, completed]);
    const result = await superviseCodexGoalProjectController({ args, statusIntervalMs: 10 });
    expect(result.ok).toBe(true);
    expect(harness.delays).toEqual([10, 20, 40, 10, 20, 40]);
    expect(calls.filter((name) => name === "codex_goal_control_decision")).toHaveLength(1);
    expect(calls.at(-1)).toBe("codex_goal_project_controller_reconcile");
    expect(calls.filter((name) => name === "codex_goal_project_controller_start")).toHaveLength(1);
    expect(calls).not.toContain("codex_goal_project_controller_stop");
  });

  it("caps the backoff delay", async () => {
    setup([failedObservation, failedObservation, failedObservation]);
    await superviseCodexGoalProjectController({ args, statusIntervalMs: 200_000 });
    expect(harness.delays).toEqual([200_000, 300_000, 300_000]);
  });

  it("preserves stop cleanup when aborted during error backoff", async () => {
    const calls = setup([failedObservation]);
    const abort = new AbortController();
    harness.onSleep = () => {
      if (harness.delays.length === 2) abort.abort();
    };
    const result = await superviseCodexGoalProjectController({ args, signal: abort.signal });
    expect(result).toMatchObject({ ok: true, stop: { ok: true }, finalStatus: failedObservation });
    expect(calls.at(-1)).toBe("codex_goal_project_controller_stop");
    expect(calls.filter((name) => name === "codex_goal_project_controller_status")).toHaveLength(1);
    expect(calls).not.toContain("codex_goal_control_decision");
  });

  it("returns ordinary status errors immediately", async () => {
    const failure = { ok: false, reason: "session_not_found" };
    const calls = setup([failure]);
    expect(await superviseCodexGoalProjectController({ args })).toMatchObject({ ok: false, finalStatus: failure });
    expect(harness.delays).toHaveLength(1);
    expect(calls.at(-1)).toBe("codex_goal_project_controller_status");
  });
});
