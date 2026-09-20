import { afterEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ fail: true }));
// These cases verify CLI formatting and exit codes, without consulting the host
// installation or launching a runtime when CI inherits hosted admission markers.
vi.mock("../hosted-readonly-foreground", () => ({
  routeHostedRuntimeCommand: async () => undefined,
}));
vi.mock("../codex-goal-mcp-client", async (original) => {
  const actual = await original<typeof import("../codex-goal-mcp-client")>();
  return {
    ...actual,
    superviseCodexGoalProjectController: async ({ onEvent }: Parameters<typeof actual.superviseCodexGoalProjectController>[0]) => {
      const status = { ok: true, run: { status: "running" }, liveController: { live: false, providerStatusFailed: true } };
      onEvent?.({ type: "status", result: status });
      return harness.fail
        ? {
          ok: false,
          start: { ok: true },
          finalStatus: status,
          reason: actual.ControllerSupervisorFailureReason.ProviderStatusFailed,
          safeMessage: "Controller state is unconfirmed and needs attention.",
        }
        : { ok: true, start: { ok: true } };
    },
  };
});

import { runCodexGoalCli } from "../codex-goal-cli";

function fakeIo() {
  const io = {
    stdout: "", stderr: "",
    writeStdout(value: string) { io.stdout += value; },
    writeStderr(value: string) { io.stderr += value; },
    cwd: () => process.env.TMPDIR!,
    env: () => ({}),
  };
  return io;
}

afterEach(() => { harness.fail = true; });

describe("controller supervisor CLI outcome", () => {
  it("ends JSON output with a compact honest failure event", async () => {
    const io = fakeIo();
    const exitCode = await runCodexGoalCli([
      "controller-supervise", "--controller-job-id", "fake-test-controller", "--format", "json",
    ], io);
    expect(exitCode, io.stderr).toBe(1);
    const events = io.stdout.trim().split("\n").map((line) => JSON.parse(line));
    expect(events).toHaveLength(2);
    expect(events.at(-1)).toEqual({
      type: "failure",
      result: {
        ok: false,
        reason: "provider_status_failed",
        safeMessage: "Controller state is unconfirmed and needs attention.",
      },
    });
    expect(io.stderr).toBe("");
  });

  it("prints a clear terminal failure message in text mode", async () => {
    const io = fakeIo();
    const exitCode = await runCodexGoalCli([
      "controller-supervise", "--controller-job-id", "fake-test-controller", "--format", "text",
    ], io);
    expect(exitCode, io.stderr).toBe(1);
    expect(io.stdout.trim().split("\n").at(-1)).toBe(
      "failure provider_status_failed: Controller state is unconfirmed and needs attention.",
    );
  });

  it("does not add a failure diagnostic on success", async () => {
    harness.fail = false;
    const io = fakeIo();
    const exitCode = await runCodexGoalCli([
      "controller-supervise", "--controller-job-id", "fake-test-controller", "--format", "json",
    ], io);
    expect(exitCode, io.stderr).toBe(0);
    expect(io.stdout.trim().split("\n")).toHaveLength(1);
    expect(io.stdout).not.toContain('"type":"failure"');
  });
});
