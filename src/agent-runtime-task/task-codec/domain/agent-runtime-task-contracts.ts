import {
  AgentRuntimeExecutionMode,
  AgentRuntimeTaskEventType,
  AgentRuntimeTaskResultStatus,
  type AgentRuntimeTaskExecution,
  type AgentRuntimeBudgetMetricCode,
  type AgentToolCall,
  type AgentUsage,
  type ManagedRunInputRequest,
  type ManagedRunResumeHandle,
  type ProviderFailure,
  type ProviderFailureCode,
  type ProviderTaskKind,
  type ProviderTaskTelemetry,
  type RuntimeWarning,
  type AgentRuntimeToolName,
  type ProviderTaskAccessBoundary,
  type ProviderTaskResponseFormat,
  type UnsupportedControlPolicy,
} from "@vioxen/subscription-runtime/core";

export const agentRuntimeTaskProtocolVersionV1 = 1 as const;
export const agentRuntimeTaskProtocolVersionV2 = 2 as const;
export const agentRuntimeTaskProtocolVersionV3 = 3 as const;
export const agentRuntimeTaskProtocolVersion = agentRuntimeTaskProtocolVersionV1;
export type AgentRuntimeTaskProtocolVersion =
  | typeof agentRuntimeTaskProtocolVersionV1
  | typeof agentRuntimeTaskProtocolVersionV2
  | typeof agentRuntimeTaskProtocolVersionV3;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;
export type JsonObject = { readonly [key: string]: JsonValue };
export type JsonArray = readonly JsonValue[];

type AgentRuntimeTaskRequestBase<TTask> = {
  readonly runId?: string;
  readonly providerInstanceId?: string;
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly task: TTask;
  readonly context?: AgentRuntimeTaskContext;
};

export type AgentRuntimeTaskPayloadV1 = {
  readonly kind: ProviderTaskKind;
  readonly prompt: string;
  readonly systemPrompt?: string;
  readonly outputSchemaName?: string;
  readonly controls?: AgentRuntimeTaskControls;
  readonly metadata?: Readonly<Record<string, string>>;
};

export type AgentRuntimeTaskPayloadV2 = AgentRuntimeTaskPayloadV1 & {
  readonly execution: AgentRuntimeTaskExecution;
};

export type AgentRuntimeTaskPayloadV3 = AgentRuntimeTaskPayloadV2;

export type AgentRuntimeTaskPayload =
  | AgentRuntimeTaskPayloadV1
  | AgentRuntimeTaskPayloadV2
  | AgentRuntimeTaskPayloadV3;

export type AgentRuntimeTaskRequestV1 = AgentRuntimeTaskRequestBase<
  AgentRuntimeTaskPayloadV1
> & {
  readonly protocolVersion: typeof agentRuntimeTaskProtocolVersionV1;
};

export type AgentRuntimeTaskRequestV2 = AgentRuntimeTaskRequestBase<
  AgentRuntimeTaskPayloadV2
> & {
  readonly protocolVersion: typeof agentRuntimeTaskProtocolVersionV2;
};

export type AgentRuntimeLogicalThread = {
  readonly id: string;
};

export type AgentRuntimeTaskRequestV3 = AgentRuntimeTaskRequestBase<
  AgentRuntimeTaskPayloadV3
> & {
  readonly protocolVersion: typeof agentRuntimeTaskProtocolVersionV3;
  readonly executionId: string;
  readonly thread: AgentRuntimeLogicalThread;
};

export type AgentRuntimeTaskRequest =
  | AgentRuntimeTaskRequestV1
  | AgentRuntimeTaskRequestV2
  | AgentRuntimeTaskRequestV3;

export type AgentRuntimeTaskToolPolicy = {
  readonly allow?: readonly AgentRuntimeToolName[];
  readonly deny?: readonly AgentRuntimeToolName[];
  readonly onUnsupported?: UnsupportedControlPolicy;
};

export type AgentRuntimeTaskBudget = {
  readonly metric: AgentRuntimeBudgetMetricCode;
  readonly limit: number;
  readonly onUnsupported?: UnsupportedControlPolicy;
};

export type AgentRuntimeTaskControls = {
  readonly model?: string;
  readonly maxTurns?: number;
  readonly toolPolicy?: AgentRuntimeTaskToolPolicy;
  readonly budget?: AgentRuntimeTaskBudget;
  readonly accessBoundary?: Exclude<
    ProviderTaskAccessBoundary,
    "project_scoped_control"
  >;
  readonly allowDangerFullAccess?: boolean;
  readonly responseFormat?: ProviderTaskResponseFormat;
  readonly outputSchemaName?: string;
  readonly outputSchema?: JsonObject;
};

export type AgentRuntimeTaskContext = {
  readonly application?: string;
  readonly purpose?: string;
  readonly correlationId?: string;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly round?: AgentRuntimeTaskRoundContext;
};

export type AgentRuntimeTaskRoundContext = {
  readonly roundId?: string;
  readonly roundIndex?: number;
  readonly totalRounds?: number;
  readonly member: AgentRuntimeTaskRoundMemberIdentity;
  readonly adversaryOf?: AgentRuntimeTaskRoundMemberIdentity;
};

export type AgentRuntimeTaskRoundMemberIdentity = {
  readonly id: string;
  readonly adapterId: string;
  readonly agentType: string;
  readonly provider: string;
  readonly model: string;
  readonly independenceGroup: string;
  readonly label?: string;
};

type AgentRuntimeTaskSuccessfulResult =
  | {
      readonly status: AgentRuntimeTaskResultStatus.Completed;
      readonly outputText: string;
      readonly structuredOutput?: JsonValue;
      readonly telemetry?: ProviderTaskTelemetry;
      readonly warnings: readonly RuntimeWarning[];
    }
  | {
      readonly status: AgentRuntimeTaskResultStatus.WaitingForInput;
      readonly runId: string;
      readonly outputText: string;
      readonly structuredOutput?: JsonValue;
      readonly request: ManagedRunInputRequest;
      readonly resumeHandle: ManagedRunResumeHandle;
      readonly telemetry?: ProviderTaskTelemetry;
      readonly warnings: readonly RuntimeWarning[];
    };

type AgentRuntimeTaskFailedResult = {
      readonly status: AgentRuntimeTaskResultStatus.Failed;
      readonly failure: ProviderFailure;
      readonly telemetry?: ProviderTaskTelemetry;
      readonly warnings: readonly RuntimeWarning[];
    };

export enum AgentRuntimeThreadOutcome {
  StartedFresh = "started_fresh",
  Continued = "continued",
  RecoveredFresh = "recovered_fresh",
}

export type AgentRuntimeThreadResult = {
  readonly id: string;
  readonly outcome: AgentRuntimeThreadOutcome;
};

export enum AgentRuntimeFailureLifecycleState {
  PreflightFailed = "preflight_failed",
  ExecutionFailed = "execution_failed",
  CleanupUnconfirmed = "cleanup_unconfirmed",
}

export enum AgentRuntimePendingAuthority {
  ProviderProcess = "provider_process",
  ProviderSession = "provider_session",
  ToolServer = "tool_server",
}

export type AgentRuntimeFailureLifecycle =
  | {
      readonly state: AgentRuntimeFailureLifecycleState.PreflightFailed;
      readonly taskStarted: false;
    }
  | {
      readonly state: AgentRuntimeFailureLifecycleState.ExecutionFailed;
      readonly taskStarted: true;
    }
  | {
      readonly state: AgentRuntimeFailureLifecycleState.CleanupUnconfirmed;
      readonly taskStarted: boolean;
      readonly pendingAuthorities: readonly [
        AgentRuntimePendingAuthority,
        ...AgentRuntimePendingAuthority[],
      ];
    };

type WithProtocolVersion<T, TVersion extends AgentRuntimeTaskProtocolVersion> =
  T extends unknown ? T & { readonly protocolVersion: TVersion } : never;

export type AgentRuntimeTaskResultV1 = WithProtocolVersion<
  AgentRuntimeTaskSuccessfulResult | AgentRuntimeTaskFailedResult,
  typeof agentRuntimeTaskProtocolVersionV1
>;

export type AgentRuntimeTaskResultV2 =
  | WithProtocolVersion<
      AgentRuntimeTaskSuccessfulResult,
      typeof agentRuntimeTaskProtocolVersionV2
    >
  | WithProtocolVersion<
      AgentRuntimeTaskFailedResult & {
        readonly lifecycle: AgentRuntimeFailureLifecycle;
      },
      typeof agentRuntimeTaskProtocolVersionV2
    >;

type AgentRuntimeTaskCompletedResult = Extract<
  AgentRuntimeTaskSuccessfulResult,
  { readonly status: AgentRuntimeTaskResultStatus.Completed }
>;

export type AgentRuntimeTaskResultV3 =
  | WithProtocolVersion<
      AgentRuntimeTaskCompletedResult & {
        readonly thread: AgentRuntimeThreadResult;
      },
      typeof agentRuntimeTaskProtocolVersionV3
    >
  | WithProtocolVersion<
      AgentRuntimeTaskFailedResult & {
        readonly lifecycle: AgentRuntimeFailureLifecycle;
      },
      typeof agentRuntimeTaskProtocolVersionV3
    >;

export type AgentRuntimeTaskResult =
  | AgentRuntimeTaskResultV1
  | AgentRuntimeTaskResultV2
  | AgentRuntimeTaskResultV3;

type AgentRuntimeTaskEventPayload<TResult extends AgentRuntimeTaskResult> =
  | {
      readonly type: AgentRuntimeTaskEventType.Started;
      readonly occurredAt: string;
      readonly telemetry?: ProviderTaskTelemetry;
    }
  | {
      readonly type: AgentRuntimeTaskEventType.TextDelta;
      readonly occurredAt: string;
      readonly text: string;
      readonly telemetry?: ProviderTaskTelemetry;
    }
  | {
      readonly type: AgentRuntimeTaskEventType.ToolCall;
      readonly occurredAt: string;
      readonly toolCall: AgentToolCall;
      readonly telemetry?: ProviderTaskTelemetry;
    }
  | {
      readonly type: AgentRuntimeTaskEventType.Usage;
      readonly occurredAt: string;
      readonly usage: AgentUsage;
      readonly telemetry?: ProviderTaskTelemetry;
    }
  | {
      readonly type: AgentRuntimeTaskEventType.Warning;
      readonly occurredAt: string;
      readonly warning: RuntimeWarning;
      readonly telemetry?: ProviderTaskTelemetry;
    }
  | {
      readonly type: AgentRuntimeTaskEventType.Completed;
      readonly occurredAt: string;
      readonly result: TResult;
      readonly telemetry?: ProviderTaskTelemetry;
    };

export type AgentRuntimeTaskEventV1 = WithProtocolVersion<
  AgentRuntimeTaskEventPayload<AgentRuntimeTaskResultV1>,
  typeof agentRuntimeTaskProtocolVersionV1
>;

export type AgentRuntimeTaskEventV2 = WithProtocolVersion<
  AgentRuntimeTaskEventPayload<AgentRuntimeTaskResultV2>,
  typeof agentRuntimeTaskProtocolVersionV2
>;

export type AgentRuntimeTaskEventV3 = WithProtocolVersion<
  AgentRuntimeTaskEventPayload<AgentRuntimeTaskResultV3>,
  typeof agentRuntimeTaskProtocolVersionV3
>;

export type AgentRuntimeTaskEvent =
  | AgentRuntimeTaskEventV1
  | AgentRuntimeTaskEventV2
  | AgentRuntimeTaskEventV3;

export type AgentRuntimeTaskBridgeRunResult = {
  readonly request: AgentRuntimeTaskRequest;
  readonly result: AgentRuntimeTaskResult;
  readonly events: readonly AgentRuntimeTaskEvent[];
};

export type AgentRuntimeTaskProtocolErrorCode =
  | "agent_runtime_task_protocol_version_invalid"
  | "agent_runtime_task_request_invalid"
  | "agent_runtime_task_result_invalid"
  | "agent_runtime_task_event_invalid"
  | "agent_runtime_task_handler_invalid"
  | "agent_runtime_task_json_invalid";

export class AgentRuntimeTaskProtocolError extends Error {
  constructor(
    readonly code: AgentRuntimeTaskProtocolErrorCode,
    safeMessage: string,
  ) {
    super(safeMessage);
    this.name = "AgentRuntimeTaskProtocolError";
  }
}

export function makeAgentRuntimeTaskFailure(
  code: ProviderFailureCode,
  safeMessage: string,
  input?: {
    readonly retryable?: boolean;
    readonly reconnectRequired?: boolean;
    readonly causeCategory?: string;
    readonly details?: Readonly<Record<string, string>>;
  },
): ProviderFailure {
  return {
    code,
    retryable: input?.retryable ?? false,
    reconnectRequired: input?.reconnectRequired ?? false,
    safeMessage,
    ...(input?.causeCategory ? { causeCategory: input.causeCategory } : {}),
    ...(input?.details ? { details: input.details } : {}),
  };
}
