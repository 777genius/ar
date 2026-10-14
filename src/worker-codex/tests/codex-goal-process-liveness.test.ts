import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  RunProcessAliveReason,
  RunProcessSupervisorKind,
} from "@vioxen/subscription-runtime/worker-core";
import {
  resolveCodexGoalWorkerLiveness,
  stopCodexGoalDirectProcess,
  waitForCodexGoalProcessTreeTermination,
} from "../application/codex-goal-process-liveness";

describe("codex goal process liveness", () => {
  it("retains tree custody when both actual ps executions are unavailable", async () => {
    await withUnavailablePs(async () => {
      let now = 0;
      const date = vi.spyOn(Date, "now").mockImplementation(() => now);
      try {
        await expect(waitForCodexGoalProcessTreeTermination({
          progressPid: 123,
          progressProcessStartedAt: "Thu Aug 21 02:00:00 2026",
        }, undefined, async () => { now += 10_000; }))
          .rejects.toThrow("worker_process_termination_unconfirmed");
      } finally { date.mockRestore(); }
    });
  });

  it("refuses direct stop when both actual ps executions are unavailable", async () => {
    await withUnavailablePs(async () => {
      const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
      try {
        await expect(stopCodexGoalDirectProcess({
          progressPid: 123,
          progressProcessAlive: true,
          progressCommand: "node subscription-runtime-codex-goal run --no-tmux",
          progressProcessStartedAt: "Thu Aug 21 02:00:00 2026",
        })).rejects.toThrow("worker_process_observation_unavailable");
        expect(kill).not.toHaveBeenCalled();
      } finally { kill.mockRestore(); }
    });
  });

  it("retains tree custody when a live observation lacks its start identity", async () => {
    let now = 0;
    const date = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      await expect(waitForCodexGoalProcessTreeTermination({
        progressPid: 123, progressProcessStartedAt: "original-start",
      }, async () => ({ alive: true }), async () => { now += 10_000; }))
        .rejects.toThrow("worker_process_termination_unconfirmed");
    } finally { date.mockRestore(); }
  });

  it("confirms that a reused PID no longer has the captured identity", async () => {
    await expect(waitForCodexGoalProcessTreeTermination({
      progressPid: 123, progressProcessStartedAt: "original-start",
    }, async () => ({ alive: true, supervisorStartedAt: "replacement-start" })))
      .resolves.toBeUndefined();
  });

  it("rechecks an unavailable observation until affirmative absence", async () => {
    let observations = 0;
    await expect(waitForCodexGoalProcessTreeTermination({
      progressPid: 123, progressProcessStartedAt: "original-start",
    }, async () => ++observations === 1 ? {} : { alive: false }, async () => undefined))
      .resolves.toBeUndefined();
    expect(observations).toBe(2);
  });

  it("does not rely on a cached dead flag when current observation is unknown", async () => {
    await withUnavailablePs(async () => {
      await expect(stopCodexGoalDirectProcess({
        progressPid: 123,
        progressProcessAlive: false,
        progressCommand: "node subscription-runtime-codex-goal run --no-tmux",
        progressProcessStartedAt: "original-start",
      })).rejects.toThrow("worker_process_observation_unavailable");
    });
  });

  it("does not treat stopped progress as a live worker", () => {
    expect(
      resolveCodexGoalWorkerLiveness({
        status: {
          progressExists: true,
          progressStatus: "stopped",
          progressHeartbeatAgeMs: 1_000,
          progressProcessAlive: true,
          progressCommand: "node subscription-runtime-codex-goal run",
        },
        progressStale: false,
      }),
    ).toMatchObject({
      alive: false,
      supervisorKind: RunProcessSupervisorKind.None,
      processAlive: false,
      freshProgressAlive: false,
      aliveReason: RunProcessAliveReason.TerminalResult,
    });
  });

  it("never signals a legacy control-plane pid stored in stopped progress", async () => {
    const kill = vi
      .spyOn(process, "kill")
      .mockImplementation((() => true) as typeof process.kill);
    try {
      await expect(
        stopCodexGoalDirectProcess({
          progressStatus: "stopped",
          progressPid: process.pid,
          progressProcessAlive: true,
          progressCommand: "node subscription-runtime-codex-goal-mcp",
        }),
      ).resolves.toEqual({
        preview: "terminal progress has no stoppable worker process",
        status: "process_gone",
        pid: process.pid,
      });
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });

  it("refuses a pid whose command identity changed before signaling", async () => {
    const kill = vi
      .spyOn(process, "kill")
      .mockImplementation((() => true) as typeof process.kill);
    try {
      await expect(
        stopCodexGoalDirectProcess(
          {
            progressPid: 123,
            progressProcessAlive: true,
            progressCommand:
              "node subscription-runtime-codex-goal run --no-tmux",
          },
          async () => ({
            alive: true,
            command: "bash unrelated-process.sh",
          }),
        ),
      ).resolves.toMatchObject({
        status: "untrusted_process",
        pid: 123,
      });
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });

  it("signals only a freshly reverified trusted direct worker", async () => {
    const kill = vi
      .spyOn(process, "kill")
      .mockImplementation((() => true) as typeof process.kill);
    const command = "node subscription-runtime-codex-goal run --no-tmux";
    const startedAt = "Thu Aug 21 02:00:00 2026";
    const inspect = vi
      .fn()
      .mockResolvedValueOnce({
        alive: true,
        supervisorCommand: command,
        supervisorStartedAt: startedAt,
      })
      .mockResolvedValue({ alive: false });
    try {
      await expect(
        stopCodexGoalDirectProcess(
          {
            progressPid: 123,
            progressProcessAlive: true,
            progressCommand: command,
            progressProcessStartedAt: startedAt,
            progressProcessTreeIdentities: [{ pid: 123, startedAt }],
          },
          inspect,
        ),
      ).resolves.toEqual({
        preview: "kill -TERM 123",
        status: "terminated",
        pid: 123,
      });
      expect(kill).toHaveBeenCalledWith(123, "SIGTERM");
    } finally {
      kill.mockRestore();
    }
  });

  it("refuses a same-command pid whose immutable start identity changed", async () => {
    const kill = vi
      .spyOn(process, "kill")
      .mockImplementation((() => true) as typeof process.kill);
    const command = "node subscription-runtime-codex-goal run --no-tmux";
    try {
      await expect(
        stopCodexGoalDirectProcess(
          {
            progressPid: 123,
            progressProcessAlive: true,
            progressCommand: command,
            progressProcessStartedAt: "Thu Aug 21 02:00:00 2026",
          },
          async () => ({
            alive: true,
            supervisorCommand: command,
            supervisorStartedAt: "Thu Aug 21 02:05:00 2026",
          }),
        ),
      ).resolves.toMatchObject({
        status: "untrusted_process",
        pid: 123,
      });
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });

  it("waits for the captured process tree identities to disappear", async () => {
    const kill = vi
      .spyOn(process, "kill")
      .mockImplementation((() => true) as typeof process.kill);
    const command = "node subscription-runtime-codex-goal run --no-tmux";
    const rootStartedAt = "Thu Aug 21 02:00:00 2026";
    const childStartedAt = "Thu Aug 21 02:00:01 2026";
    const snapshots = new Map<number, number>();
    const inspect = vi.fn(async (pid: number) => {
      const count = (snapshots.get(pid) ?? 0) + 1;
      snapshots.set(pid, count);
      if (pid === 123 && count === 1) {
        return {
          alive: true,
          supervisorCommand: command,
          supervisorStartedAt: rootStartedAt,
        };
      }
      if (pid === 124 && count === 1) {
        return { alive: true, supervisorStartedAt: childStartedAt };
      }
      return { alive: false };
    });
    try {
      await expect(
        stopCodexGoalDirectProcess(
          {
            progressPid: 123,
            progressProcessAlive: true,
            progressCommand: command,
            progressProcessStartedAt: rootStartedAt,
            progressProcessTreeIdentities: [
              { pid: 123, startedAt: rootStartedAt },
              { pid: 124, startedAt: childStartedAt },
            ],
          },
          inspect,
          async () => undefined,
        ),
      ).resolves.toMatchObject({
        status: "terminated",
      });
      expect(inspect).toHaveBeenCalledWith(124);
    } finally {
      kill.mockRestore();
    }
  });

  it("waits for a captured descendant after the supervisor is already gone", async () => {
    const command = "node subscription-runtime-codex-goal run --no-tmux";
    const rootStartedAt = "Thu Aug 21 02:00:00 2026";
    const childStartedAt = "Thu Aug 21 02:00:01 2026";
    let childChecks = 0;
    const inspect = vi.fn(async (pid: number) => {
      if (pid === 124 && ++childChecks === 1) {
        return { alive: true, supervisorStartedAt: childStartedAt };
      }
      return { alive: false };
    });

    await expect(
      stopCodexGoalDirectProcess(
        {
          progressPid: 123,
          progressProcessAlive: true,
          progressCommand: command,
          progressProcessStartedAt: rootStartedAt,
          progressProcessTreeIdentities: [
            { pid: 123, startedAt: rootStartedAt },
            { pid: 124, startedAt: childStartedAt },
          ],
        },
        inspect,
        async () => undefined,
      ),
    ).resolves.toMatchObject({
      status: "process_gone",
    });
    expect(inspect).toHaveBeenCalledWith(124);
    expect(childChecks).toBe(2);
  });

  it("refuses initially untrusted direct worker commands", async () => {
    const kill = vi
      .spyOn(process, "kill")
      .mockImplementation((() => true) as typeof process.kill);
    try {
      for (const [pid, progressCommand] of [
        [123, "[kworker/R-slub_]"],
        [124, "bash unrelated-script.sh"],
      ] as const) {
        await expect(
          stopCodexGoalDirectProcess({
            progressPid: pid,
            progressProcessAlive: true,
            progressCommand,
          }),
        ).resolves.toMatchObject({
          status: "untrusted_process",
          pid,
        });
      }
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });
});

async function withUnavailablePs(action: () => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pr135-unavailable-ps-"));
  const originalPath = process.env.PATH;
  // Real execFile calls fail with ENOENT; no host process table is read.
  process.env.PATH = directory;
  try { await action(); } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await rm(directory, { recursive: true, force: true });
  }
}
