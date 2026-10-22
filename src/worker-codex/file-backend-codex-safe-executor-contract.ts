import type { SafeExecutionPolicy, TaskEffectMode } from "@vioxen/subscription-runtime/worker-core";
import type { FileBackendCodexWorkerJob } from "./file-backend-codex-worker";

export type FileBackendCodexSafeExecutorRunInput = FileBackendCodexWorkerJob & {
  readonly jobId?: string;
  readonly taskId: string;
  readonly originalPrompt?: string;
  readonly effectMode?: TaskEffectMode;
  readonly staleLockMs?: number;
  readonly maxAccountCycles?: number;
  readonly safeExecutionPolicy?: SafeExecutionPolicy;
};
