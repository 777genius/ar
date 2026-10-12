import { describe, expect, it } from "vitest";
import { FileBackendCodexWorker } from "../file-backend-codex-worker";
import { resolveFileBackendCodexWorkerOptions } from "../file-backend-codex-worker-options";
import { openWorkerFactorySecretRoots } from "../file-backend-codex-runtime-factory";
import { resolveFileBackendCodexSafeExecutorOptions } from "../file-backend-codex-safe-executor";

const worker = {
  providerInstanceId: "TEST-storage", codexBinaryPath: "codex",
  encryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", sourceEnv: {},
};

describe("standalone Codex storage composition", () => {
  it("protects derived state and its inherited session home in direct factory grants", () => {
    expect(openWorkerFactorySecretRoots({ ...worker, storageRootDir: "/external/runtime" })).toEqual([
      "/external/runtime/state/codex-workers", "/external/runtime/state/codex-workers",
      "/external/runtime/state/codex-workers/codex-session-cache",
    ]);
    expect(openWorkerFactorySecretRoots({ ...worker, storageRootDir: "/external/runtime",
      stateRootDir: "/legacy/state" })).toEqual([
      "/legacy/state", "/legacy/state", "/legacy/state/codex-session-cache",
    ]);
    expect(openWorkerFactorySecretRoots({ ...worker, storageRootDir: "/external/runtime",
      stateRootDir: "/legacy/state", runtimeHomeRootDir: "/payload/home" })).toEqual([
      "/legacy/state", "/payload/home", "/payload/home/codex-session-cache",
    ]);
  });

  it("rejects an invalid explicit root at the constructor before creating runtime adapters", () => {
    expect(() => new FileBackendCodexWorker({ ...worker,
      storageRootDir: "/external/../elsewhere", stateRootDir: "/legacy/state",
    })).toThrow("Invalid runtime storageRootDir");
    expect(resolveFileBackendCodexWorkerOptions({ ...worker, stateRootDir: "/legacy/state",
      sourceEnv: { SUBSCRIPTION_RUNTIME_STORAGE_ROOT: "/external/runtime" },
    }).stateRootDir).toBe("/legacy/state");
    expect(resolveFileBackendCodexWorkerOptions({ ...worker, storageRootDir: "/request/root",
      sourceEnv: { SUBSCRIPTION_RUNTIME_STORAGE_ROOT: "/env/root" },
    }).stateRootDir).toBe("/request/root/state/codex-workers");
  });

  it("resolves safe executor and account inputs before constructing durable stores", () => {
    const resolved = resolveFileBackendCodexSafeExecutorOptions({
      storageRootDir: "/executor/root", workspacePath: "/workspace",
      accounts: [{ worker }, { worker: { ...worker, storageRootDir: "/account/root" } },
        { worker: { ...worker, stateRootDir: "/legacy/account-state" } }],
    });
    expect(resolved.stateRootDir).toBe("/executor/root/state/codex-workers");
    expect(resolved.accounts[0]?.worker.stateRootDir).toBe("/executor/root/state/codex-workers");
    expect(resolved.accounts[1]?.worker.stateRootDir).toBe("/account/root/state/codex-workers");
    expect(resolved.accounts[2]?.worker.stateRootDir).toBe("/legacy/account-state");
  });
});
