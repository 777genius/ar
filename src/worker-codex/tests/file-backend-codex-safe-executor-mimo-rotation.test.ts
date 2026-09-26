import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CodexModelBackend } from "@vioxen/subscription-runtime/provider-codex";
import {
  FileBackendCodexSafeExecutor,
  FileBackendCodexWorker,
  type FileBackendCodexSafeExecutorAccount,
} from "../index";

/**
 * SR-AP-2 fail-closed: `BoundedSubscriptionWorkerPool`'s round-robin slot
 * selector and its retry-on-failure path (see
 * `FileBackendCodexSafeExecutor.selectRoundRobinSlot` /
 * `runOnSlotWithRetry`) pick any available slot purely by index. They have
 * no notion of `CodexModelBackend`, so nothing at that layer would stop
 * account rotation from silently handing a retried attempt to a slot backed
 * by a *different* provider credential than the one that just failed.
 *
 * These tests assert the fix is at construction time: an executor rejects a
 * mixed-backend account pool outright, so a MiMo slot and a ChatGPT slot can
 * never coexist in the same rotation pool in the first place.
 */
describe("FileBackendCodexSafeExecutor — fail-closed account-backend rotation", () => {
  it("accepts a pool where every account is the (implicit or explicit) ChatGPT backend", () => {
    expect(() => new FileBackendCodexSafeExecutor(fixtureOptions([
      account("chatgpt-a"),
      account("chatgpt-b", { modelBackend: CodexModelBackend.OpenAiChatGpt }),
    ]))).not.toThrow();
  });

  it("accepts a pool where every account is the MiMo backend", () => {
    expect(() => new FileBackendCodexSafeExecutor(fixtureOptions([
      account("mimo-a", { modelBackend: CodexModelBackend.XiaomiMimoTokenPlan }),
      account("mimo-b", { modelBackend: CodexModelBackend.XiaomiMimoTokenPlan }),
    ]))).not.toThrow();
  });

  it("rejects a pool mixing an explicit ChatGPT account with a MiMo account", () => {
    expect(() => new FileBackendCodexSafeExecutor(fixtureOptions([
      account("chatgpt-a", { modelBackend: CodexModelBackend.OpenAiChatGpt }),
      account("mimo-a", { modelBackend: CodexModelBackend.XiaomiMimoTokenPlan }),
    ]))).toThrow("file_backend_codex_safe_mixed_model_backend");
  });

  it("rejects a pool mixing a MiMo account with an account that omits modelBackend (defaults to ChatGPT)", () => {
    // The omission case matters: a caller must not be able to accidentally
    // smuggle a ChatGPT slot into a MiMo pool just by leaving the field
    // unset on one account.
    expect(() => new FileBackendCodexSafeExecutor(fixtureOptions([
      account("mimo-a", { modelBackend: CodexModelBackend.XiaomiMimoTokenPlan }),
      account("chatgpt-implicit"),
    ]))).toThrow("file_backend_codex_safe_mixed_model_backend");
  });

  it("rejects a three-account pool with a single MiMo outlier among ChatGPT accounts", () => {
    expect(() => new FileBackendCodexSafeExecutor(fixtureOptions([
      account("chatgpt-a"),
      account("chatgpt-b"),
      account("mimo-a", { modelBackend: CodexModelBackend.XiaomiMimoTokenPlan }),
    ]))).toThrow("file_backend_codex_safe_mixed_model_backend");
  });

  it("never reads or seeds ChatGPT auth.json paths for a MiMo account", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-safe-mimo-auth-skip-"));
    const seedAuthFile = vi
      .spyOn(FileBackendCodexWorker.prototype, "seedCodexAuthJsonFile")
      .mockResolvedValue();
    const executor = new FileBackendCodexSafeExecutor({
      stateRootDir: join(root, "state"),
      workspacePath: join(root, "workspace"),
      requireGitWorkspace: false,
      accounts: [
        {
          codexAuthJsonPath: join(root, "forbidden-chatgpt-auth.json"),
          worker: {
            providerInstanceId: "codex-mimo-auth-skip",
            stateRootDir: join(root, "state"),
            codexBinaryPath: "codex",
            encryptionKey: new Uint8Array(32).fill(13),
            executionEngine: "app-server-goal",
            modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
            mimoApiKeyEnvVarName: "MIMO_SAFE_EXECUTOR_KEY",
            sourceEnv: { MIMO_SAFE_EXECUTOR_KEY: "tp-safe-executor-key" },
          },
        },
      ],
    });
    try {
      await executor.start();
      expect(seedAuthFile).not.toHaveBeenCalled();
    } finally {
      await executor.dispose();
      seedAuthFile.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
});

function account(
  label: string,
  overrides: Partial<FileBackendCodexSafeExecutorAccount["worker"]> = {},
): FileBackendCodexSafeExecutorAccount {
  return {
    codexAuthJsonPath: `/tmp/does-not-need-to-exist-for-construction/${label}/auth.json`,
    worker: {
      providerInstanceId: `codex-${label}`,
      stateRootDir: "/tmp/does-not-need-to-exist-for-construction/state",
      codexBinaryPath: "codex",
      encryptionKey: new Uint8Array(32).fill(11),
      ...overrides,
    },
  };
}

function fixtureOptions(accounts: readonly FileBackendCodexSafeExecutorAccount[]) {
  return {
    stateRootDir: "/tmp/does-not-need-to-exist-for-construction/state",
    workspacePath: "/tmp/does-not-need-to-exist-for-construction/workspace",
    requireGitWorkspace: false,
    accounts,
  };
}
