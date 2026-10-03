import type { CodexGoalProcessSnapshot } from "../codex-goal-process-snapshot";
import { describe, expect, it, vi } from "vitest";
import {
  RunProcessAliveReason,
  RunProcessSupervisorKind,
} from "@vioxen/subscription-runtime/worker-core";
import {
  resolveCodexGoalWorkerLiveness,
  stopCodexGoalDirectProcess,
  summarizeCodexGoalProcessTree,
} from "../codex-goal-ops";

describe("codex goal ops - worker liveness", () => {
  it("summarizes child process CPU as active worker progress", () => {
    expect(summarizeCodexGoalProcessTree(100, [
      { pid: 100, ppid: 1, cpu: 0, command: "node subscription-runtime-codex-goal" },
      { pid: 101, ppid: 100, cpu: 0, command: "sh -c npm test" },
      { pid: 102, ppid: 101, cpu: 84.2, command: "npm test -- --runInBand" },
    ])).toMatchObject({
      alive: true,
      cpuActive: true,
      command: "npm test -- --runInBand",
    });
  });

  it("detects an idle Codex app-server child process", () => {
    expect(summarizeCodexGoalProcessTree(100, [
      { pid: 100, ppid: 1, cpu: 0, command: "node subscription-runtime-codex-goal" },
      { pid: 101, ppid: 100, cpu: 0, command: "codex app-server --listen stdio://" },
    ])).toMatchObject({
      alive: true,
      cpuActive: false,
      appServerAlive: true,
      appServerPid: 101,
    });
  });

  it("does not summarize defunct process rows as live worker progress", () => {
    expect(summarizeCodexGoalProcessTree(100, [
      {
        pid: 100,
        ppid: 1,
        stat: "Z",
        cpu: 52.1,
        command: "[ps] <defunct>",
      },
    ])).toEqual({});
  });

  it("treats fresh running progress as observable liveness without tmux", () => {
    expect(resolveCodexGoalWorkerLiveness({
      status: {
        progressExists: true,
        progressStatus: "running",
        progressHeartbeatAgeMs: 1_000,
      },
      progressStale: false,
    })).toMatchObject({
      alive: true,
      supervisorKind: RunProcessSupervisorKind.External,
      processAlive: false,
      freshProgressAlive: true,
      aliveReason: RunProcessAliveReason.FreshProgress,
    });
  });

  it("does not treat fresh progress as liveness after tmux and pid are gone", () => {
    expect(resolveCodexGoalWorkerLiveness({
      status: {
        tmuxAlive: false,
        progressExists: true,
        progressStatus: "running",
        progressHeartbeatAgeMs: 1_000,
        progressProcessAlive: false,
      },
      progressStale: false,
    })).toMatchObject({
      alive: false,
      supervisorKind: RunProcessSupervisorKind.None,
      processAlive: false,
      freshProgressAlive: false,
      aliveReason: RunProcessAliveReason.Unknown,
    });
  });

  it("does not treat maintenance-paused progress as a live worker", () => {
    expect(resolveCodexGoalWorkerLiveness({
      status: {
        progressExists: true,
        progressStatus: "maintenance_paused",
        progressHeartbeatAgeMs: 1_000,
        progressProcessAlive: true,
      },
      progressStale: false,
    })).toMatchObject({
      alive: false,
      supervisorKind: RunProcessSupervisorKind.None,
      processAlive: false,
      freshProgressAlive: false,
      aliveReason: RunProcessAliveReason.TerminalResult,
    });
  });

  it("does not treat partial progress as a live worker", () => {
    expect(resolveCodexGoalWorkerLiveness({
      status: {
        progressExists: true,
        progressStatus: "partial",
        progressHeartbeatAgeMs: 1_000,
        progressProcessAlive: true,
        progressCommand: "node subscription-runtime-codex-goal run",
      },
      progressStale: false,
    })).toMatchObject({
      alive: false,
      supervisorKind: RunProcessSupervisorKind.None,
      processAlive: false,
      freshProgressAlive: false,
      aliveReason: RunProcessAliveReason.TerminalResult,
    });
  });

  it("does not trust bracketed kernel worker commands as progress pid liveness", () => {
    expect(resolveCodexGoalWorkerLiveness({
      status: {
        tmuxAlive: false,
        progressExists: true,
        progressStatus: "running",
        progressHeartbeatAgeMs: 1_000,
        progressProcessAlive: true,
        progressCommand: "[kworker/R-slub_]",
      },
      progressStale: false,
    })).toMatchObject({
      alive: false,
      supervisorKind: RunProcessSupervisorKind.None,
      processAlive: false,
      freshProgressAlive: false,
      aliveReason: RunProcessAliveReason.Unknown,
    });
  });

  it("stops only trusted no-tmux direct worker pids", async () => {
    const kill = vi.spyOn(process, "kill").mockImplementation((() => true) as typeof process.kill);
    const command = "node subscription-runtime-codex-goal run --no-tmux";
    const startedAt = "2026-10-03T00:00:00.000Z";
    const inspectProcess = vi.fn<(pid: number) => Promise<CodexGoalProcessSnapshot>>()
      .mockResolvedValueOnce({
        alive: true,
        supervisorCommand: command,
        supervisorStartedAt: startedAt,
      })
      .mockResolvedValueOnce({ alive: false });
    try {
      expect(await stopCodexGoalDirectProcess({
        progressPid: 123,
        progressProcessAlive: true,
        progressCommand: command,
        progressProcessStartedAt: startedAt,
      }, inspectProcess)).toEqual({
        preview: "kill -TERM 123",
        status: "terminated",
        pid: 123,
      });
      expect(kill).toHaveBeenCalledWith(123, "SIGTERM");
      expect(kill).toHaveBeenCalledTimes(1);
      expect(inspectProcess.mock.calls).toEqual([[123], [123]]);
    } finally {
      kill.mockRestore();
    }
  });

  it("refuses untrusted no-tmux direct worker pids without signaling them", async () => {
    const kill = vi.spyOn(process, "kill").mockImplementation((() => true) as typeof process.kill);
    try {
      expect(await stopCodexGoalDirectProcess({
        progressPid: 123,
        progressProcessAlive: true,
        progressCommand: "[kworker/R-slub_]",
      })).toEqual({
        preview: "kill -TERM 123",
        status: "untrusted_process",
        pid: 123,
      });
      expect(await stopCodexGoalDirectProcess({
        progressPid: 124,
        progressProcessAlive: true,
        progressCommand: "bash unrelated-script.sh",
      })).toEqual({
        preview: "kill -TERM 124",
        status: "untrusted_process",
        pid: 124,
      });
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });
});
