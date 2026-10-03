import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileBackendCodexSafeExecutor } from "../index";
import {
  FakeAppServerFactory,
  StaticRunner,
  codexAuthJson,
  gitWorkspace,
} from "./file-backend-codex-worker-test-support";

describe("FileBackendCodexSafeExecutor live rate limits", () => {
  it("rotates before thread start when the app-server reports a limited account", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-safe-quota-preflight-"));
    const workspacePath = await gitWorkspace(
      "codex-safe-quota-preflight-workspace-",
    );
    const clock = {
      now: () => new Date("2026-09-04T10:00:00.000Z"),
      monotonicMs: () => performance.now(),
    };
    const resetAt = new Date("2026-09-04T12:00:00.000Z");
    const appServers = [
      new FakeAppServerFactory({
        rateLimitsResult: limitedRateLimits(resetAt),
      }),
      new FakeAppServerFactory({
        rateLimitsResult: availableRateLimits(resetAt),
      }),
    ];
    const executor = new FileBackendCodexSafeExecutor({
      stateRootDir: rootDir,
      workspacePath,
      maxAccountCycles: 1,
      accounts: appServers.map((appServer, index) => ({
        codexAuthJson: codexAuthJson(`quota-preflight-account-${index + 1}`),
        worker: {
          providerInstanceId: `codex-quota-preflight-account-${index + 1}`,
          capacityAccountId: `quota-preflight-account-${index + 1}`,
          stateRootDir: rootDir,
          codexBinaryPath: "codex",
          encryptionKey: new Uint8Array(32).fill(index + 70),
          appServerProcessFactory: appServer.create,
          runner: new StaticRunner({ exitCode: 0, stdout: "", stderr: "" }),
          clock,
        },
      })),
      clock,
    });

    try {
      const result = await executor.run({
        taskId: "codex-safe-quota-preflight-task",
        prompt: "Run only on an account with available quota.",
        controls: { editMode: "allow-edits" },
      });

      if (result.status !== "completed") {
        throw new Error(
          `expected completed after preflight rotation: ${result.reason}:${result.safeMessage}`,
        );
      }
      expect(result.attempts).toHaveLength(2);
      expect(result.attempts[0]?.failureReason).toBe("quota_limited");
      expect(appServers[0]!.rateLimitsReadCount).toBe(1);
      expect(appServers[0]!.prompts).toEqual([]);
      expect(appServers[1]!.rateLimitsReadCount).toBe(1);
      expect(appServers[1]!.prompts).toHaveLength(1);
    } finally {
      await executor.dispose();
      await rm(rootDir, { recursive: true, force: true });
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("continues when rate-limit telemetry is temporarily unavailable", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-safe-quota-fail-open-"));
    const workspacePath = await gitWorkspace(
      "codex-safe-quota-fail-open-workspace-",
    );
    const appServer = new FakeAppServerFactory({
      rateLimitsError: "temporary rate-limit telemetry failure",
    });
    const executor = new FileBackendCodexSafeExecutor({
      stateRootDir: rootDir,
      workspacePath,
      maxAccountCycles: 1,
      accounts: [{
        codexAuthJson: codexAuthJson("quota-fail-open-account"),
        worker: {
          providerInstanceId: "codex-quota-fail-open-account",
          stateRootDir: rootDir,
          codexBinaryPath: "codex",
          encryptionKey: new Uint8Array(32).fill(72),
          appServerProcessFactory: appServer.create,
          runner: new StaticRunner({ exitCode: 0, stdout: "", stderr: "" }),
        },
      }],
    });

    try {
      const result = await executor.run({
        taskId: "codex-safe-quota-fail-open-task",
        prompt: "Continue despite unavailable quota telemetry.",
        controls: { editMode: "allow-edits" },
      });

      expect(result.status).toBe("completed");
      expect(appServer.rateLimitsReadCount).toBe(1);
      expect(appServer.prompts).toEqual([
        "Continue despite unavailable quota telemetry.",
      ]);
    } finally {
      await executor.dispose();
      await rm(rootDir, { recursive: true, force: true });
      await rm(workspacePath, { recursive: true, force: true });
    }
  });
});

function limitedRateLimits(resetAt: Date): unknown {
  return {
    rateLimits: {
      primary: {
        usedPercent: 100,
        windowDurationMins: 300,
        resetsAt: Math.floor(resetAt.getTime() / 1000),
      },
      rateLimitReachedType: "usage_limit_reached",
    },
  };
}

function availableRateLimits(resetAt: Date): unknown {
  return {
    rateLimits: {
      primary: {
        usedPercent: 20,
        windowDurationMins: 300,
        resetsAt: Math.floor(resetAt.getTime() / 1000),
      },
      rateLimitReachedType: null,
    },
  };
}
