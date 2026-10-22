import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CodexModelBackend } from "@vioxen/subscription-runtime/provider-codex";
import { FileBackendCodexSafeExecutor } from "../index";
import {
  FakeAppServerFactory,
  StaticRunner,
  gitWorkspace,
} from "./file-backend-codex-worker-test-support";

describe("owned MiMo transient repair", () => {
  it("under the owned MiMo policy a transient failure still triggers one same-account re-run", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-safe-owned-mimo-transient-"));
    const workspacePath = await gitWorkspace("codex-safe-owned-mimo-transient-workspace-");
    const clock = {
      now: () => new Date("2026-05-31T00:05:00.000Z"),
      monotonicMs: () => performance.now(),
    };
    const transientProxy = 'codex_app_server_error: proxy_upstream_failed {"upstream_status":503}';
    const appServer = new FakeAppServerFactory({
      emitTopLevelErrorsOnTurns: [transientProxy, null],
    });
    const executor = new FileBackendCodexSafeExecutor({
      stateRootDir: rootDir,
      workspacePath,
      safeExecutionPolicy: {
        maxAttempts: 1,
        continuationMode: "disabled",
        retryOnCapacity: false,
        retryOnAccountUnavailable: false,
        retryOnReconnectRequired: false,
      },
      accounts: [{
        worker: {
          providerInstanceId: "codex-owned-mimo-transient-account",
          stateRootDir: rootDir,
          codexBinaryPath: "codex",
          encryptionKey: new Uint8Array(32).fill(68),
          modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
          executionEngine: "app-server-goal",
          appServerProcessFactory: appServer.create,
          runner: new StaticRunner({ exitCode: 1, stdout: "", stderr: transientProxy }),
          capacityPolicy: {
            reconnectCooldownMs: 10,
            maxReconnectRetriesPerAccount: 3,
          },
          sourceEnv: { MIMO_TOKEN_PLAN_API_KEY: "tp-fake-owned-transient-key" },
          clock,
        },
      }],
      clock,
    });

    try {
      const result = await executor.run({
        taskId: "codex-safe-owned-mimo-transient-task",
        prompt: "Implement the owned mimo transient task.",
        controls: { editMode: "allow-edits" },
      });

      // The owned MiMo policy disables safe-execution continuation entirely, so
      // recovery after a transient failure must come from the run itself: one
      // same-account re-run of the original prompt, bounded like the rotating
      // session's guarded repair.
      if (result.status !== "completed") {
        throw new Error(`expected completed: ${result.reason}:${result.safeMessage}`);
      }
      expect(result.attempts).toHaveLength(1);
      expect(appServer.prompts).toEqual([
        "Implement the owned mimo transient task.",
        "Implement the owned mimo transient task.",
      ]);
    } finally {
      await executor.dispose();
      await rm(rootDir, { recursive: true, force: true });
      await rm(workspacePath, { recursive: true, force: true });
    }
  });
});
