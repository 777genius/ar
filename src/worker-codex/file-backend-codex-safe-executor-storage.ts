import { deriveRuntimeStorageRoots } from "@vioxen/subscription-runtime/core";
import { join } from "node:path";
import { resolveFileBackendCodexWorkerOptions } from "./file-backend-codex-worker-options";
import type { FileBackendCodexSafeExecutorInput, FileBackendCodexSafeExecutorOptions } from "./file-backend-codex-safe-executor";

export function resolveFileBackendCodexSafeExecutorOptions(input: FileBackendCodexSafeExecutorInput): FileBackendCodexSafeExecutorOptions {
  const roots = input.storageRootDir === undefined ? undefined : deriveRuntimeStorageRoots(input.storageRootDir);
  const stateRootDir = input.stateRootDir ?? (roots ? join(roots.stateRootDir, "codex-workers") : undefined);
  if (stateRootDir === undefined) throw new Error("file_backend_codex_safe_state_root_required");
  const accounts = input.accounts.map(account => {
    const worker = account.worker;
    if (worker.stateRootDir !== undefined) {
      return { ...account, worker: resolveFileBackendCodexWorkerOptions({ ...worker, stateRootDir: worker.stateRootDir }) };
    }
    const storageRootDir = worker.storageRootDir ?? input.storageRootDir;
    if (storageRootDir === undefined) throw new Error("file_backend_codex_state_root_required");
    return { ...account, worker: resolveFileBackendCodexWorkerOptions({ ...worker, storageRootDir }) };
  });
  return { ...input, stateRootDir, accounts };
}
