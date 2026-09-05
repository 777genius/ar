import type {
  RunProcessAliveReason,
  RunProcessSupervisorKind,
} from "./run-observability";
import type { RunEventProviderKind } from "./run-provider-kind";

export enum RunEventType {
  ObservationRecorded = "run.observation.recorded",
  ProgressUpdated = "run.progress.updated",
  OutputGrew = "run.output.grew",
  WorkspaceChanged = "run.workspace.changed",
  ResultUpdated = "run.result.updated",
  DecisionChanged = "run.decision.changed",
  CapacityChanged = "run.capacity.changed",
  ControlInboxChanged = "run.control_inbox.changed",
  MaintenancePaused = "run.maintenance.paused",
  Completed = "run.completed",
  Blocked = "run.blocked",
  Failed = "run.failed",
  Stale = "run.stale",
  UnsafeStateDetected = "run.unsafe_state_detected",
}

export enum RunEventSeverity {
  Info = "info",
  Warning = "warning",
  Blocked = "blocked",
  Critical = "critical",
}

export enum RunEventRedactionStatus {
  Safe = "safe",
}

export enum RunRuntimeIssueKind {
  None = "none",
  WorkerObservable = "worker_observable",
  TerminalResultCompleted = "terminal_result_completed",
  CompletedResultWithLiveProcess = "completed_result_with_live_process",
  StoppedRunWithRunningProgress = "stopped_run_with_running_progress",
  ObservableProgressStale = "observable_progress_stale",
  HeartbeatOnlyNoOutput = "heartbeat_only_no_output",
  AccountOrCapacityUnavailable = "account_or_capacity_unavailable",
  DirtyWorkspaceWithoutRunningWorker = "dirty_workspace_without_running_worker",
  StoppedWithoutTerminalResult = "stopped_without_terminal_result",
  NonRunningOrUnknownFailure = "non_running_or_unknown_failure",
  GuidancePending = "guidance_pending",
  GuidanceDelivered = "guidance_delivered",
  ManualReviewRequired = "manual_review_required",
  ControlInboxBlocked = "control_inbox_blocked",
  Unknown = "unknown",
}

export enum RunSafetyStatus {
  Safe = "safe",
  Watch = "watch",
  ReviewRequired = "review_required",
  Blocked = "blocked",
  Unsafe = "unsafe",
  Unknown = "unknown",
}

export enum RunSafetyConfidence {
  Low = "low",
  Medium = "medium",
  High = "high",
}

export enum RunLivenessStatus {
  Alive = "alive",
  Dead = "dead",
  Stale = "stale",
  Quiet = "quiet",
  CompletedLive = "completed_live",
  Unknown = "unknown",
}

export enum RunWorkspaceStatus {
  Clean = "clean",
  Dirty = "dirty",
  Missing = "missing",
  Unknown = "unknown",
  Warning = "warning",
}

export enum RunAccountCapacityStatus {
  Available = "available",
  Blocked = "blocked",
  Cooldown = "cooldown",
  Unknown = "unknown",
}

export enum RunOutcomeStatus {
  Running = "running",
  Completed = "completed",
  Failed = "failed",
  Blocked = "blocked",
  Partial = "partial",
  NeedsAttention = "needs_attention",
  Unknown = "unknown",
}

export enum RunControlInboxStatus {
  Clear = "clear",
  Pending = "pending",
  Delivered = "delivered",
  Blocked = "blocked",
  Unsafe = "unsafe",
  Unknown = "unknown",
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject;
export type JsonObject = { readonly [key: string]: JsonValue };

export type RunEventSource = {
  readonly providerKind: RunEventProviderKind;
  readonly hostId?: string;
  readonly registryRootDir?: string;
  readonly workspaceKey?: string;
};

export type RunEvent = {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly runId: string;
  readonly jobId?: string;
  readonly type: RunEventType;
  readonly severity: RunEventSeverity;
  readonly occurredAt: string;
  readonly observedAt: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly sequence?: number;
  readonly source: RunEventSource;
  readonly redaction: RunEventRedactionStatus;
  readonly payload: JsonObject;
};

export type RunEventCursor = {
  readonly value: string;
};

export enum RunEventCompactionSafetyMode {
  PreserveDeliveryCursors = "preserve_delivery_cursors",
  Force = "force",
}

export type RunEventRetentionPolicy = {
  readonly safetyMode?: RunEventCompactionSafetyMode;
  readonly keepEventsAfter?: string;
  readonly keepLatestEventsPerRun?: number;
  readonly compactDeliveredEvents?: boolean;
  readonly dropInvalidLines?: boolean;
};

export type RunEventDeliveryCursorSnapshot = {
  readonly consumerId: string;
  readonly cursor: RunEventCursor;
  readonly lineNumber: number;
};

export type RunEventDeliveryCursorRewrite = {
  readonly consumerId: string;
  readonly previousCursor: RunEventCursor;
  readonly nextCursor: RunEventCursor;
  readonly invalidatedUnreadEvents: boolean;
};

export type RunEventCompactionPlan = {
  readonly schemaVersion: 1;
  readonly safetyMode: RunEventCompactionSafetyMode;
  readonly totalLineCount: number;
  readonly validEventCount: number;
  readonly invalidLineCount: number;
  readonly retainedLineCount: number;
  readonly removableLineCount: number;
  readonly blockedByCursorLineCount: number;
  readonly cursorFloorLine?: number;
  readonly deliveryCursors: readonly RunEventDeliveryCursorSnapshot[];
  readonly cursorRewrites: readonly RunEventDeliveryCursorRewrite[];
  readonly warnings: readonly RunEventReadWarning[];
};

export type RunEventCompactionResult = RunEventCompactionPlan & {
  readonly compacted: boolean;
};

export type RunEventCompactionPort = {
  planCompaction(policy?: RunEventRetentionPolicy): Promise<RunEventCompactionPlan>;
  compact(policy?: RunEventRetentionPolicy): Promise<RunEventCompactionResult>;
};

export type RunEventAppendResult = {
  readonly appendedCount: number;
  readonly skippedDuplicateCount: number;
  readonly appendedEventIds?: readonly string[];
  readonly skippedDuplicateEventIds?: readonly string[];
};

export type RunEventReadWarning = {
  readonly code: string;
  readonly message: string;
  readonly lineNumber?: number;
};

export type RunEventReadRequest = {
  readonly cursor?: RunEventCursor;
  readonly limit?: number;
  readonly runId?: string;
  readonly runIds?: readonly string[];
  readonly sourceProviderKind?: RunEventProviderKind;
  readonly sourceRegistryRootDir?: string;
  readonly types?: readonly RunEventType[];
  readonly maxScannedBytes?: number;
  readonly maxScannedLines?: number;
  readonly maxWarnings?: number;
  readonly maxLineBytes?: number;
};

export type RunEventReadResult = {
  readonly events: readonly RunEvent[];
  readonly nextCursor?: RunEventCursor;
  readonly warnings: readonly RunEventReadWarning[];
  readonly eventCursors?: readonly RunEventCursor[];
  readonly hasMore?: boolean;
  readonly scanStopReason?: "event_limit" | "scan_limit" | "end_of_log";
  readonly scannedBytes?: number;
  readonly scannedLines?: number;
  readonly totalWarningCount?: number;
  readonly warningsTruncated?: boolean;
  readonly warningCounts?: Readonly<Record<string, number>>;
};

export type RunEventStorePort = {
  append(events: readonly RunEvent[]): Promise<RunEventAppendResult>;
  read(input?: RunEventReadRequest): Promise<RunEventReadResult>;
};

export type RunEventProjectionStateStorePort = {
  /** Serialize the complete recovery/observation/append/commit transaction per run. */
  withProjectionLock<T>(runId: string, operation: () => Promise<T>, source?: RunEventSource): Promise<T>;
  readPendingProjection(runId: string, source?: RunEventSource): Promise<RunEventProjectionResult | null>;
  writePendingProjection(projection: RunEventProjectionResult): Promise<void>;
  clearPendingProjection(runId: string, source?: RunEventSource): Promise<void>;
  readProjectionState(runId: string, source?: RunEventSource): Promise<RunEventProjectionState | null>;
  writeProjectionState(state: RunEventProjectionState): Promise<void>;
};

export type RunEventPublisherPort = {
  publish(events: readonly RunEvent[]): Promise<void>;
};

export type RunEventDeliveryCursorStorePort = {
  readDeliveryCursor(consumerId: string): Promise<RunEventCursor | null>;
  writeDeliveryCursor(input: {
    readonly consumerId: string;
    readonly cursor: RunEventCursor;
  }): Promise<void>;
};

export type RunEventRelayResult = {
  readonly consumerId: string;
  readonly readCount: number;
  readonly publishedCount: number;
  readonly nextCursor?: RunEventCursor;
  readonly warnings: readonly RunEventReadWarning[];
};

export type RunEventProjectionState = {
  readonly source?: RunEventSource;
  readonly lifecycleSignature?: string;
  /** Absent on legacy projection state. */
  readonly revision?: number;
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly providerKind: RunEventProviderKind;
  readonly observedAt: string;
  readonly status: string;
  readonly liveness: string;
  readonly progressStatus?: string;
  readonly progressUpdatedAt?: string;
  readonly resultStatus?: string;
  readonly resultReason?: string;
  readonly resultUpdatedAt?: string;
  readonly logByteLength?: number;
  readonly workspaceSignature?: string;
  readonly capacitySignature?: string;
  readonly controlInboxSignature?: string;
  readonly decisionKind?: string;
  readonly decisionReason?: string;
  readonly readModels: RunEventReadModels;
};

export type RunEventProjectionResult = {
  readonly events: readonly RunEvent[];
  readonly nextState: RunEventProjectionState;
};

export type RunEventReadModels = {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly providerKind: RunEventProviderKind;
  readonly observedAt: string;
  readonly safety: RunSafetyReadModel;
  readonly liveness: RunLivenessReadModel;
  readonly workspace: RunWorkspaceReadModel;
  readonly accountCapacity: RunAccountCapacityReadModel;
  readonly outcome: RunOutcomeReadModel;
  readonly controlInbox: RunControlInboxReadModel;
};

export type RunSafetyReadModel = {
  readonly status: RunSafetyStatus;
  readonly safeToContinue: boolean;
  readonly reviewOnly: boolean;
  readonly issueKind: RunRuntimeIssueKind;
  readonly reason: string;
  readonly confidence: RunSafetyConfidence;
  readonly evidence: readonly string[];
};

export type RunLivenessReadModel = {
  readonly status: RunLivenessStatus;
  readonly processAlive?: boolean;
  readonly aliveReason?: RunProcessAliveReason;
  readonly supervisor?: RunProcessSupervisorKind;
  readonly processPid?: number;
  readonly heartbeatAgeMs?: number;
  readonly staleAfterMs?: number;
  readonly logByteLength?: number;
  readonly lastProgressAt?: string;
  readonly lastLogAt?: string;
};

export type RunWorkspaceReadModel = {
  readonly status: RunWorkspaceStatus;
  readonly reviewOnly: boolean;
  readonly exists?: boolean;
  readonly dirty?: boolean;
  readonly changedFilesCount?: number;
  readonly changedFilesSample: readonly string[];
  readonly warning?: string;
};

export type RunAccountCapacityReadModel = {
  readonly status: RunAccountCapacityStatus;
  readonly totalHints: number;
  readonly blockedCount: number;
  readonly cooldownCount: number;
  readonly maskedAccounts: readonly string[];
  readonly reasons: readonly string[];
};

export type RunOutcomeReadModel = {
  readonly status: RunOutcomeStatus;
  readonly resultStatus?: string;
  readonly reason?: string;
  readonly updatedAt?: string;
};

export type RunControlInboxReadModel = {
  readonly status: RunControlInboxStatus;
  readonly pendingCount: number;
  readonly deliveredCount: number;
  readonly blockedDeliveryCount: number;
  readonly safeToContinue?: boolean;
  readonly latestSignalAt?: string;
  readonly latestDeliveredAt?: string;
};
