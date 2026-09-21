import { CodexSessionHomeProfileKind } from "./codex-session-home-profile";
import {
  FileBackendCodexSafeExecutor,
  type FileBackendCodexSafeExecutorOptions,
} from "./file-backend-codex-safe-executor";

export type FileBackendCodexOneShotExecutorOptions = Omit<
  FileBackendCodexSafeExecutorOptions,
  "sessionHomeProfile"
>;

export type FileBackendCodexContinuationExecutorOptions = Omit<
  FileBackendCodexSafeExecutorOptions,
  "sessionHomeProfile"
> & {
  readonly sessionId: string;
};

/**
 * Creates an executor whose materialized CODEX_HOME is removed on disposal.
 * Logical-thread and managed-run continuation inputs are rejected.
 */
export function createOneShotExecutor(
  options: FileBackendCodexOneShotExecutorOptions,
): FileBackendCodexSafeExecutor {
  return new FileBackendCodexSafeExecutor({
    ...options,
    sessionHomeProfile: { kind: CodexSessionHomeProfileKind.OneShot },
  });
}

/**
 * Creates an executor whose materialized CODEX_HOME is retained under a stable
 * session identity while auth.json is scrubbed on disposal.
 */
export function createContinuationExecutor(
  options: FileBackendCodexContinuationExecutorOptions,
): FileBackendCodexSafeExecutor {
  const { sessionId, ...executorOptions } = options;
  return new FileBackendCodexSafeExecutor({
    ...executorOptions,
    sessionHomeProfile: {
      kind: CodexSessionHomeProfileKind.Continuation,
      sessionId: sessionId.trim(),
    },
  });
}
