import type { OpenWorkerLaunch } from "../project-control-worker-mode";
import type { ObservabilityPort } from "@vioxen/subscription-runtime/core";
import type { AppServerExecutionLifetime, CodexAppServerProcessFactory, CodexProviderEgressPolicy } from "@vioxen/subscription-runtime/provider-codex";
import type { InMemoryActiveAttemptRegistry, JobStorageAdmissionPort, SafeExecutionRunResult, WorkerControlService } from "@vioxen/subscription-runtime/worker-core";
import type { CodexGoalRunConfig } from "../codex-goal-runner";
import type { CodexGoalTurnCheckpointPublisher } from "../codex-goal-turn-checkpoint";
import type { TerminalHandoffPublicationDependencies } from "../codex-goal-terminal-handoff-materialization";
import type { FileBackendCodexSafeExecutor, FileBackendCodexSafeExecutorOptions } from "../file-backend-codex-safe-executor";
import type { FileBackendCodexWorkerResult } from "../file-backend-codex-worker";
import type { admitHostedTestEgress } from "../hosted-test-egress-admission";
import type { MimoSnapshotTiming } from "../owned-mimo-snapshot-git";

/** Trusted runner dependencies are separate from serialized run configuration. */
export type CodexGoalRunDeps = TerminalHandoffPublicationDependencies & {
  readonly admitProviderEgress?: typeof admitHostedTestEgress;
  readonly createExecutor?: (options: FileBackendCodexSafeExecutorOptions) => CodexGoalExecutor;
  readonly observability?: ObservabilityPort;
  readonly checkpointPublisher?: CodexGoalTurnCheckpointPublisher;
  /** Host port, never caller receipt data or job configuration. */
  readonly storageAdmission?: JobStorageAdmissionPort;
};

export type CodexGoalExecutor = {
  run(input: Parameters<FileBackendCodexSafeExecutor["run"]>[0]): Promise<SafeExecutionRunResult<FileBackendCodexWorkerResult>>;
  dispose(): Promise<void>;
};

export type CodexGoalExecutorOptionsInput = {
  readonly observeOwnedMimoSnapshotTiming?: (timing: MimoSnapshotTiming) => void;
  readonly config: CodexGoalRunConfig;
  readonly initialBaseCommit?: string;
  readonly checkpointPublisher?: CodexGoalTurnCheckpointPublisher;
  readonly executionLifetime?: AppServerExecutionLifetime;
  readonly providerEgressPolicy?: CodexProviderEgressPolicy;
  readonly openWorker?: OpenWorkerLaunch;
  readonly appServerProcessFactory?: CodexAppServerProcessFactory;
  readonly stateRootDir: string;
  readonly executionGeneration?: string;
  readonly assertStorageAdmission?: () => void;
  readonly encryptionKey: Uint8Array;
  readonly observability?: ObservabilityPort;
  readonly controlInbox?: WorkerControlService;
  readonly activeAttemptRegistry?: InMemoryActiveAttemptRegistry;
};
