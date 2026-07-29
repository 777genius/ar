import type {
  AgentRuntimeTaskRequestV3,
  AgentRuntimeTaskResultV3,
  AgentRuntimeThreadOutcome,
} from "@vioxen/subscription-runtime/agent-runtime-task";
import type {
  ProviderTaskResult,
} from "@vioxen/subscription-runtime/core";

export enum LogicalThreadExecutionStatus {
  Active = "active",
  Completed = "completed",
}

export type LogicalThreadActiveExecution = {
  readonly status: LogicalThreadExecutionStatus.Active;
  readonly executionId: string;
  readonly requestHash: string;
  readonly startedAt: string;
};

export type LogicalThreadCompletedExecution = {
  readonly status: LogicalThreadExecutionStatus.Completed;
  readonly executionId: string;
  readonly requestHash: string;
  readonly result: AgentRuntimeTaskResultV3;
  readonly workspaceEffectFingerprint?: string;
  readonly completedAt: string;
};

export type LogicalThreadExecutionRecord =
  | LogicalThreadActiveExecution
  | LogicalThreadCompletedExecution;

export type LogicalThreadState = {
  readonly threadId: string;
  readonly generation: number;
  readonly compatibilityHash: string;
  readonly providerCheckpoint?: string;
  readonly activeExecution?: LogicalThreadActiveExecution;
  readonly lastCompletedExecution?: LogicalThreadCompletedExecution;
  readonly updatedAt: string;
};

export type ProviderThreadExecutionInput = {
  readonly request: AgentRuntimeTaskRequestV3;
  readonly previousCheckpoint?: string;
  readonly signal: AbortSignal;
};

export type ProviderThreadExecutionResult = {
  readonly result: ProviderTaskResult;
  readonly taskStarted: boolean;
  readonly candidateCheckpoint?: string;
  readonly outcome?: AgentRuntimeThreadOutcome;
};

export class LogicalThreadBusyError extends Error {
  constructor(readonly threadId: string) {
    super("agent_runtime_logical_thread_busy");
    this.name = "LogicalThreadBusyError";
  }
}

export class LogicalThreadStoreCorruptError extends Error {
  constructor() {
    super("agent_runtime_logical_thread_store_corrupt");
    this.name = "LogicalThreadStoreCorruptError";
  }
}
