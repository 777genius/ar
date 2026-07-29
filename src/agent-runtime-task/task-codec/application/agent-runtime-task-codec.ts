import {
  AgentRuntimeExecutionMode,
  AgentRuntimeTaskEventType,
  AgentRuntimeTaskResultStatus,
  isProviderFailureCode,
  providerTaskSystemPromptValidationError,
  type AgentCost,
  type AgentToolCall,
  type AgentUsage,
  type ManagedRunInputRequest,
  type ManagedRunResumeHandle,
  type ProviderFailure,
  type ProviderFailureCode,
  type ProviderTask,
  type ProviderTaskEvent,
  type ProviderTaskKind,
  type ProviderTaskResult,
  type ProviderTaskTelemetry,
  type RuntimeWarning,
} from "@vioxen/subscription-runtime/core";
import {
  agentRuntimeTaskProtocolVersion,
  agentRuntimeTaskProtocolVersionV1,
  agentRuntimeTaskProtocolVersionV2,
  AgentRuntimeFailureLifecycleState,
  AgentRuntimeTaskProtocolError,
  makeAgentRuntimeTaskFailure,
  type AgentRuntimeTaskContext,
  type AgentRuntimeTaskControls,
  type AgentRuntimeTaskEvent,
  type AgentRuntimeTaskPayload,
  type AgentRuntimeTaskPayloadV1,
  type AgentRuntimeTaskPayloadV2,
  type AgentRuntimeTaskProtocolVersion,
  type AgentRuntimeTaskRequest,
  type AgentRuntimeTaskRequestV1,
  type AgentRuntimeTaskRequestV2,
  type AgentRuntimeTaskResult,
  type AgentRuntimeTaskResultV1,
  type AgentRuntimeTaskResultV2,
  type AgentRuntimeFailureLifecycle,
  type AgentRuntimeTaskRoundContext,
  type AgentRuntimeTaskRoundMemberIdentity,
  type JsonObject,
  type JsonValue,
} from "../domain/agent-runtime-task-contracts";
import {
  parseControls,
  providerTaskControls,
} from "./agent-runtime-task-controls";
import {
  assertOnlyKeys,
  booleanAt,
  isoStringAt,
  isPlainObject,
  nonEmptyStringAt,
  nonNegativeNumberAt,
  objectAt,
  parseJsonValue,
  parseProtocolVersion,
  positiveIntegerAt,
  protocolError,
  stringAt,
} from "./agent-runtime-task-validation";
import {
  parseFailureLifecycle,
  parseTaskExecution,
} from "./agent-runtime-task-v2-codec";

export { parseJsonValue } from "./agent-runtime-task-validation";

const providerTaskKinds = new Set<ProviderTaskKind>([
  "review",
  "structured-prompt",
  "health-check",
]);
const toolCallStatuses = new Set<NonNullable<AgentToolCall["status"]>>([
  "started",
  "completed",
  "failed",
  "denied",
]);
const finishReasons = new Set<
  NonNullable<ProviderTaskTelemetry["finishReason"]>
>([
  "completed",
  "waiting_for_input",
  "max_turns",
  "cancelled",
  "timeout",
  "budget_exceeded",
  "provider_error",
]);
export function createAgentRuntimeTaskRequest(
  input: Omit<AgentRuntimeTaskRequestV1, "protocolVersion">,
): AgentRuntimeTaskRequestV1 {
  return createAgentRuntimeTaskRequestV1(input);
}

export function createAgentRuntimeTaskRequestV1(
  input: Omit<AgentRuntimeTaskRequestV1, "protocolVersion">,
): AgentRuntimeTaskRequestV1 {
  return parseAgentRuntimeTaskRequest({
    protocolVersion: agentRuntimeTaskProtocolVersionV1,
    ...input,
  }) as AgentRuntimeTaskRequestV1;
}

export function createAgentRuntimeTaskRequestV2(
  input: Omit<AgentRuntimeTaskRequestV2, "protocolVersion">,
): AgentRuntimeTaskRequestV2 {
  return parseAgentRuntimeTaskRequest({
    protocolVersion: agentRuntimeTaskProtocolVersionV2,
    ...input,
  }) as AgentRuntimeTaskRequestV2;
}

export function parseAgentRuntimeTaskRequest(value: unknown): AgentRuntimeTaskRequest {
  const input = objectAt(value, "request");
  assertOnlyKeys(
    input,
    ["protocolVersion", "runId", "providerInstanceId", "cwd", "timeoutMs", "task", "context"],
    "request",
  );
  const protocolVersion = parseProtocolVersion(
    input.protocolVersion,
    "request.protocolVersion",
  );
  const common = {
    ...optionalStringField(input, "runId", "request.runId"),
    ...optionalStringField(
      input,
      "providerInstanceId",
      "request.providerInstanceId",
    ),
    ...optionalStringField(input, "cwd", "request.cwd"),
    ...optionalPositiveIntegerField(input, "timeoutMs", "request.timeoutMs"),
    task: parseAgentRuntimeTaskPayload(
      input.task,
      "request.task",
      protocolVersion,
    ),
    ...optionalContextField(input, "context", "request.context"),
  };
  if (protocolVersion === agentRuntimeTaskProtocolVersionV1) {
    return {
      ...common,
      protocolVersion,
      task: common.task as AgentRuntimeTaskPayloadV1,
    };
  }
  return {
    ...common,
    protocolVersion,
    task: common.task as AgentRuntimeTaskPayloadV2,
  };
}

export function agentRuntimeTaskRequestToProviderTask(
  request: AgentRuntimeTaskRequest,
): ProviderTask {
  return {
    kind: request.task.kind,
    prompt: request.task.prompt,
    execution: request.protocolVersion === agentRuntimeTaskProtocolVersionV2
      ? request.task.execution
      : { mode: AgentRuntimeExecutionMode.SingleRun },
    ...(request.task.systemPrompt !== undefined
      ? { systemPrompt: request.task.systemPrompt }
      : {}),
    ...(request.task.outputSchemaName
      ? { outputSchemaName: request.task.outputSchemaName }
      : {}),
    ...(request.task.controls
      ? { controls: providerTaskControls(request.task.controls) }
      : {}),
    ...(request.task.metadata ? { metadata: request.task.metadata } : {}),
  };
}

export function providerTaskResultToAgentRuntimeTaskResult(
  result: ProviderTaskResult,
  options: {
    readonly protocolVersion?: AgentRuntimeTaskProtocolVersion;
    readonly failureLifecycle?: AgentRuntimeFailureLifecycle;
  } = {},
): AgentRuntimeTaskResult {
  const protocolVersion =
    options.protocolVersion ?? agentRuntimeTaskProtocolVersionV1;
  if (result.status === "completed") {
    return {
      protocolVersion,
      status: AgentRuntimeTaskResultStatus.Completed,
      outputText: result.outputText,
      ...(result.structuredOutput === undefined
        ? {}
        : {
            structuredOutput: parseJsonValue(
              result.structuredOutput,
              "result.structuredOutput",
            ),
          }),
      ...(result.telemetry ? { telemetry: parseTelemetry(result.telemetry) } : {}),
      warnings: result.warnings.map((warning, index) =>
        parseWarning(warning, `result.warnings[${index}]`),
      ),
    } as AgentRuntimeTaskResult;
  }
  if (result.status === "waiting_for_input") {
    return {
      protocolVersion,
      status: AgentRuntimeTaskResultStatus.WaitingForInput,
      runId: result.runId,
      outputText: result.outputText,
      ...(result.structuredOutput === undefined
        ? {}
        : {
            structuredOutput: parseJsonValue(
              result.structuredOutput,
              "result.structuredOutput",
            ),
          }),
      request: result.request,
      resumeHandle: result.resumeHandle,
      ...(result.telemetry ? { telemetry: parseTelemetry(result.telemetry) } : {}),
      warnings: result.warnings.map((warning, index) =>
        parseWarning(warning, `result.warnings[${index}]`),
      ),
    } as AgentRuntimeTaskResult;
  }
  return {
    protocolVersion,
    status: AgentRuntimeTaskResultStatus.Failed,
    failure: parseFailure(result.failure, "result.failure"),
    ...(protocolVersion === agentRuntimeTaskProtocolVersionV2
      ? {
          lifecycle: options.failureLifecycle ?? {
            state: AgentRuntimeFailureLifecycleState.ExecutionFailed,
            taskStarted: true,
          },
        }
      : {}),
    ...(result.telemetry ? { telemetry: parseTelemetry(result.telemetry) } : {}),
    warnings: result.warnings.map((warning, index) =>
      parseWarning(warning, `result.warnings[${index}]`),
    ),
  } as AgentRuntimeTaskResult;
}

export function agentRuntimeTaskResultToProviderTaskResult(
  result: AgentRuntimeTaskResult,
): ProviderTaskResult {
  const parsed = parseAgentRuntimeTaskResult(result);
  if (parsed.status === AgentRuntimeTaskResultStatus.Completed) {
    return {
      status: "completed",
      outputText: parsed.outputText,
      ...(parsed.structuredOutput === undefined
        ? {}
        : { structuredOutput: parsed.structuredOutput }),
      ...(parsed.telemetry ? { telemetry: parsed.telemetry } : {}),
      warnings: parsed.warnings,
    };
  }
  if (parsed.status === AgentRuntimeTaskResultStatus.WaitingForInput) {
    return {
      status: "waiting_for_input",
      runId: parsed.runId,
      outputText: parsed.outputText,
      ...(parsed.structuredOutput === undefined
        ? {}
        : { structuredOutput: parsed.structuredOutput }),
      request: parsed.request,
      resumeHandle: parsed.resumeHandle,
      ...(parsed.telemetry ? { telemetry: parsed.telemetry } : {}),
      warnings: parsed.warnings,
    };
  }
  return {
    status: "failed",
    failure: parsed.failure,
    ...(parsed.telemetry ? { telemetry: parsed.telemetry } : {}),
    warnings: parsed.warnings,
  };
}

export function parseAgentRuntimeTaskResult(value: unknown): AgentRuntimeTaskResult {
  const input = objectAt(value, "result");
  const protocolVersion = parseProtocolVersion(
    input.protocolVersion,
    "result.protocolVersion",
  );
  const status = stringAt(input.status, "result.status");
  if (status === AgentRuntimeTaskResultStatus.Completed) {
    return {
      protocolVersion,
      status: AgentRuntimeTaskResultStatus.Completed,
      outputText: stringAt(input.outputText, "result.outputText"),
      ...(input.structuredOutput === undefined
        ? {}
        : {
            structuredOutput: parseJsonValue(
              input.structuredOutput,
              "result.structuredOutput",
            ),
          }),
      ...optionalTelemetryField(input, "telemetry", "result.telemetry"),
      warnings: parseWarnings(input.warnings, "result.warnings"),
    } as AgentRuntimeTaskResult;
  }
  if (status === AgentRuntimeTaskResultStatus.Failed) {
    return {
      protocolVersion,
      status: AgentRuntimeTaskResultStatus.Failed,
      failure: parseFailure(input.failure, "result.failure"),
      ...(protocolVersion === agentRuntimeTaskProtocolVersionV2
        ? { lifecycle: parseFailureLifecycle(input.lifecycle, "result.lifecycle") }
        : {}),
      ...optionalTelemetryField(input, "telemetry", "result.telemetry"),
      warnings: parseWarnings(input.warnings, "result.warnings"),
    } as AgentRuntimeTaskResult;
  }
  if (status === AgentRuntimeTaskResultStatus.WaitingForInput) {
    return {
      protocolVersion,
      status: AgentRuntimeTaskResultStatus.WaitingForInput,
      runId: nonEmptyStringAt(input.runId, "result.runId"),
      outputText: stringAt(input.outputText, "result.outputText"),
      ...(input.structuredOutput === undefined
        ? {}
        : {
            structuredOutput: parseJsonValue(
              input.structuredOutput,
              "result.structuredOutput",
            ),
          }),
      request: parseManagedRunInputRequest(
        input.request,
        "result.request",
      ),
      resumeHandle: parseManagedRunResumeHandle(
        input.resumeHandle,
        "result.resumeHandle",
      ),
      ...optionalTelemetryField(input, "telemetry", "result.telemetry"),
      warnings: parseWarnings(input.warnings, "result.warnings"),
    } as AgentRuntimeTaskResult;
  }
  throw protocolError(
    "agent_runtime_task_result_invalid",
    `result.status must be completed, waiting_for_input or failed at result.status`,
  );
}

export function providerTaskEventToAgentRuntimeTaskEvent(
  event: ProviderTaskEvent,
  protocolVersion: AgentRuntimeTaskProtocolVersion =
    agentRuntimeTaskProtocolVersionV1,
): AgentRuntimeTaskEvent {
  const base = {
    protocolVersion,
    occurredAt: event.occurredAt.toISOString(),
    ...(event.telemetry ? { telemetry: parseTelemetry(event.telemetry) } : {}),
  };
  switch (event.type) {
    case "started":
      return { ...base, type: AgentRuntimeTaskEventType.Started } as AgentRuntimeTaskEvent;
    case "text_delta":
      return {
        ...base,
        type: AgentRuntimeTaskEventType.TextDelta,
        text: event.text,
      } as AgentRuntimeTaskEvent;
    case "tool_call":
      return {
        ...base,
        type: AgentRuntimeTaskEventType.ToolCall,
        toolCall: parseToolCall(event.toolCall, "event.toolCall"),
      } as AgentRuntimeTaskEvent;
    case "usage":
      return {
        ...base,
        type: AgentRuntimeTaskEventType.Usage,
        usage: parseUsage(event.usage, "event.usage"),
      } as AgentRuntimeTaskEvent;
    case "warning":
      return {
        ...base,
        type: AgentRuntimeTaskEventType.Warning,
        warning: parseWarning(event.warning, "event.warning"),
      } as AgentRuntimeTaskEvent;
    case "completed":
      return {
        ...base,
        type: AgentRuntimeTaskEventType.Completed,
        result: providerTaskResultToAgentRuntimeTaskResult(event.result, {
          protocolVersion,
        }),
      } as AgentRuntimeTaskEvent;
  }
}

export function parseAgentRuntimeTaskEvent(value: unknown): AgentRuntimeTaskEvent {
  const input = objectAt(value, "event");
  const protocolVersion = parseProtocolVersion(
    input.protocolVersion,
    "event.protocolVersion",
  );
  const type = stringAt(input.type, "event.type");
  const base = {
    protocolVersion,
    occurredAt: isoStringAt(input.occurredAt, "event.occurredAt"),
    ...optionalTelemetryField(input, "telemetry", "event.telemetry"),
  };
  if (type === AgentRuntimeTaskEventType.Started) {
    return { ...base, type: AgentRuntimeTaskEventType.Started } as AgentRuntimeTaskEvent;
  }
  if (type === AgentRuntimeTaskEventType.TextDelta) {
    return {
      ...base,
      type: AgentRuntimeTaskEventType.TextDelta,
      text: stringAt(input.text, "event.text"),
    } as AgentRuntimeTaskEvent;
  }
  if (type === AgentRuntimeTaskEventType.ToolCall) {
    return {
      ...base,
      type: AgentRuntimeTaskEventType.ToolCall,
      toolCall: parseToolCall(input.toolCall, "event.toolCall"),
    } as AgentRuntimeTaskEvent;
  }
  if (type === AgentRuntimeTaskEventType.Usage) {
    return {
      ...base,
      type: AgentRuntimeTaskEventType.Usage,
      usage: parseUsage(input.usage, "event.usage"),
    } as AgentRuntimeTaskEvent;
  }
  if (type === AgentRuntimeTaskEventType.Warning) {
    return {
      ...base,
      type: AgentRuntimeTaskEventType.Warning,
      warning: parseWarning(input.warning, "event.warning"),
    } as AgentRuntimeTaskEvent;
  }
  if (type === AgentRuntimeTaskEventType.Completed) {
    return {
      ...base,
      type: AgentRuntimeTaskEventType.Completed,
      result: parseAgentRuntimeTaskResultForVersion(input.result, protocolVersion),
    } as AgentRuntimeTaskEvent;
  }
  throw protocolError(
    "agent_runtime_task_event_invalid",
    `event.type is unsupported at event.type`,
  );
}

function parseAgentRuntimeTaskResultForVersion(
  value: unknown,
  protocolVersion: AgentRuntimeTaskProtocolVersion,
): AgentRuntimeTaskResult {
  const result = parseAgentRuntimeTaskResult(value);
  if (result.protocolVersion !== protocolVersion) {
    throw protocolError(
      "agent_runtime_task_event_invalid",
      "event.result.protocolVersion must match event.protocolVersion",
    );
  }
  return result;
}

export function makeFailedAgentRuntimeTaskResult(input: {
  readonly code: ProviderFailureCode;
  readonly safeMessage: string;
  readonly retryable?: boolean;
  readonly reconnectRequired?: boolean;
  readonly causeCategory?: string;
  readonly details?: Readonly<Record<string, string>>;
  readonly warnings?: readonly RuntimeWarning[];
  readonly telemetry?: ProviderTaskTelemetry;
  readonly protocolVersion?: AgentRuntimeTaskProtocolVersion;
  readonly lifecycle?: AgentRuntimeFailureLifecycle;
}): AgentRuntimeTaskResult {
  const protocolVersion =
    input.protocolVersion ?? agentRuntimeTaskProtocolVersionV1;
  return {
    protocolVersion,
    status: AgentRuntimeTaskResultStatus.Failed,
    failure: makeAgentRuntimeTaskFailure(input.code, input.safeMessage, input),
    ...(protocolVersion === agentRuntimeTaskProtocolVersionV2
      ? {
          lifecycle: input.lifecycle ?? {
            state: AgentRuntimeFailureLifecycleState.PreflightFailed,
            taskStarted: false,
          },
        }
      : {}),
    ...(input.telemetry ? { telemetry: parseTelemetry(input.telemetry) } : {}),
    warnings: (input.warnings ?? []).map((warning, index) =>
      parseWarning(warning, `warnings[${index}]`),
    ),
  } as AgentRuntimeTaskResult;
}

function parseAgentRuntimeTaskPayload(
  value: unknown,
  path: string,
  protocolVersion: AgentRuntimeTaskProtocolVersion,
): AgentRuntimeTaskPayload {
  const input = objectAt(value, path);
  assertOnlyKeys(
    input,
    protocolVersion === agentRuntimeTaskProtocolVersionV2
      ? [
          "kind",
          "prompt",
          "systemPrompt",
          "outputSchemaName",
          "controls",
          "metadata",
          "execution",
        ]
      : ["kind", "prompt", "systemPrompt", "outputSchemaName", "controls", "metadata"],
    path,
  );
  const kind = stringAt(input.kind, `${path}.kind`);
  if (!providerTaskKinds.has(kind as ProviderTaskKind)) {
    throw protocolError(
      "agent_runtime_task_request_invalid",
      `${path}.kind is unsupported`,
    );
  }
  const prompt = stringAt(input.prompt, `${path}.prompt`);
  if (prompt.length === 0) {
    throw protocolError(
      "agent_runtime_task_request_invalid",
      `${path}.prompt must not be empty`,
    );
  }
  const parsedSystemPrompt = optionalStringField(
    input,
    "systemPrompt",
    `${path}.systemPrompt`,
  );
  const systemPrompt = parsedSystemPrompt.systemPrompt;
  const systemPromptError = providerTaskSystemPromptValidationError(
    systemPrompt,
    `${path}.systemPrompt`,
  );
  if (systemPromptError !== null) {
    throw protocolError(
      "agent_runtime_task_request_invalid",
      systemPromptError,
    );
  }
  const base: AgentRuntimeTaskPayloadV1 = {
    kind: kind as ProviderTaskKind,
    prompt,
    ...parsedSystemPrompt,
    ...optionalStringField(input, "outputSchemaName", `${path}.outputSchemaName`),
    ...optionalControlsField(input, "controls", `${path}.controls`),
    ...optionalMetadataField(input, "metadata", `${path}.metadata`),
  };
  if (protocolVersion === agentRuntimeTaskProtocolVersionV1) return base;
  return {
    ...base,
    execution: parseTaskExecution(input.execution, `${path}.execution`),
  } satisfies AgentRuntimeTaskPayloadV2;
}

function parseContext(value: unknown, path: string): AgentRuntimeTaskContext {
  const input = objectAt(value, path);
  assertOnlyKeys(
    input,
    ["application", "purpose", "correlationId", "metadata", "round"],
    path,
  );
  return {
    ...optionalStringField(input, "application", `${path}.application`),
    ...optionalStringField(input, "purpose", `${path}.purpose`),
    ...optionalStringField(input, "correlationId", `${path}.correlationId`),
    ...optionalMetadataField(input, "metadata", `${path}.metadata`),
    ...optionalRoundContextField(input, "round", `${path}.round`),
  };
}

function parseRoundContext(value: unknown, path: string): AgentRuntimeTaskRoundContext {
  const input = objectAt(value, path);
  assertOnlyKeys(
    input,
    ["roundId", "roundIndex", "totalRounds", "member", "adversaryOf"],
    path,
  );
  return {
    ...optionalStringField(input, "roundId", `${path}.roundId`),
    ...optionalPositiveIntegerField(input, "roundIndex", `${path}.roundIndex`),
    ...optionalPositiveIntegerField(input, "totalRounds", `${path}.totalRounds`),
    member: parseRoundMemberIdentity(input.member, `${path}.member`),
    ...optionalRoundMemberIdentityField(
      input,
      "adversaryOf",
      `${path}.adversaryOf`,
    ),
  };
}

function parseRoundMemberIdentity(
  value: unknown,
  path: string,
): AgentRuntimeTaskRoundMemberIdentity {
  const input = objectAt(value, path);
  assertOnlyKeys(
    input,
    ["id", "adapterId", "agentType", "provider", "model", "independenceGroup", "label"],
    path,
  );
  return {
    id: nonEmptyStringAt(input.id, `${path}.id`),
    adapterId: nonEmptyStringAt(input.adapterId, `${path}.adapterId`),
    agentType: nonEmptyStringAt(input.agentType, `${path}.agentType`),
    provider: nonEmptyStringAt(input.provider, `${path}.provider`),
    model: nonEmptyStringAt(input.model, `${path}.model`),
    independenceGroup: nonEmptyStringAt(
      input.independenceGroup,
      `${path}.independenceGroup`,
    ),
    ...optionalStringField(input, "label", `${path}.label`),
  };
}

function parseWarnings(value: unknown, path: string): readonly RuntimeWarning[] {
  if (!Array.isArray(value)) {
    throw protocolError(
      "agent_runtime_task_result_invalid",
      `${path} must be an array`,
    );
  }
  return value.map((warning, index) =>
    parseWarning(warning, `${path}[${index}]`),
  );
}

function parseManagedRunInputRequest(
  value: unknown,
  path: string,
): ManagedRunInputRequest {
  const input = objectAt(value, path);
  const kind = stringAt(input.kind, `${path}.kind`);
  if (
    kind !== "missing_context" &&
    kind !== "decision_required" &&
    kind !== "permission_required"
  ) {
    throw protocolError(
      "agent_runtime_task_result_invalid",
      `${path}.kind is unsupported`,
    );
  }
  const audience = stringAt(input.audience, `${path}.audience`);
  if (audience !== "orchestrator" && audience !== "user") {
    throw protocolError(
      "agent_runtime_task_result_invalid",
      `${path}.audience is unsupported`,
    );
  }
  return {
    id: nonEmptyStringAt(input.id, `${path}.id`),
    kind,
    question: nonEmptyStringAt(input.question, `${path}.question`),
    ...optionalStringField(input, "contextSummary", `${path}.contextSummary`),
    ...optionalStringArrayField(
      input,
      "suggestedAnswers",
      `${path}.suggestedAnswers`,
    ),
    audience,
  };
}

function parseManagedRunResumeHandle(
  value: unknown,
  path: string,
): ManagedRunResumeHandle {
  const input = objectAt(value, path);
  return {
    runId: nonEmptyStringAt(input.runId, `${path}.runId`),
    providerId: nonEmptyStringAt(input.providerId, `${path}.providerId`),
    ...optionalStringField(
      input,
      "providerInstanceId",
      `${path}.providerInstanceId`,
    ),
    ...optionalStringField(input, "agentId", `${path}.agentId`),
    ...optionalStringField(input, "workerId", `${path}.workerId`),
    workspacePath: nonEmptyStringAt(input.workspacePath, `${path}.workspacePath`),
    ...optionalStringField(input, "threadId", `${path}.threadId`),
    ...optionalStringRecordField(
      input,
      "providerState",
      `${path}.providerState`,
    ),
  };
}

function parseWarning(value: unknown, path: string): RuntimeWarning {
  const input = objectAt(value, path);
  return {
    code: stringAt(input.code, `${path}.code`),
    safeMessage: stringAt(input.safeMessage, `${path}.safeMessage`),
    ...optionalMetadataField(input, "details", `${path}.details`),
  };
}

function parseFailure(value: unknown, path: string): ProviderFailure {
  const input = objectAt(value, path);
  const code = stringAt(input.code, `${path}.code`);
  if (!isProviderFailureCode(code)) {
    throw protocolError(
      "agent_runtime_task_result_invalid",
      `${path}.code is unsupported`,
    );
  }
  return {
    code,
    retryable: booleanAt(input.retryable, `${path}.retryable`),
    reconnectRequired: booleanAt(
      input.reconnectRequired,
      `${path}.reconnectRequired`,
    ),
    safeMessage: stringAt(input.safeMessage, `${path}.safeMessage`),
    ...optionalStringField(input, "causeCategory", `${path}.causeCategory`),
    ...optionalMetadataField(input, "details", `${path}.details`),
  };
}

function parseTelemetry(value: unknown): ProviderTaskTelemetry {
  const input = objectAt(value, "telemetry");
  return {
    ...optionalStringField(input, "providerRunId", "telemetry.providerRunId"),
    ...optionalStringField(
      input,
      "providerSessionId",
      "telemetry.providerSessionId",
    ),
    ...optionalNonNegativeNumberField(
      input,
      "durationMs",
      "telemetry.durationMs",
    ),
    ...optionalPositiveIntegerField(input, "turns", "telemetry.turns"),
    ...optionalUsageField(input, "usage", "telemetry.usage"),
    ...optionalCostField(input, "cost", "telemetry.cost"),
    ...optionalToolCallsField(input, "toolCalls", "telemetry.toolCalls"),
    ...optionalResultEnumField(
      input,
      "finishReason",
      "telemetry.finishReason",
      finishReasons,
    ),
  } as ProviderTaskTelemetry;
}

function parseUsage(value: unknown, path: string): AgentUsage {
  const input = objectAt(value, path);
  return {
    ...optionalPositiveIntegerField(input, "inputTokens", `${path}.inputTokens`),
    ...optionalPositiveIntegerField(
      input,
      "outputTokens",
      `${path}.outputTokens`,
    ),
    ...optionalPositiveIntegerField(input, "totalTokens", `${path}.totalTokens`),
  };
}

function parseCost(value: unknown, path: string): AgentCost {
  const input = objectAt(value, path);
  const currency = stringAt(input.currency, `${path}.currency`);
  if (currency !== "USD") {
    throw protocolError(
      "agent_runtime_task_result_invalid",
      `${path}.currency must be USD`,
    );
  }
  return {
    amount: nonNegativeNumberAt(input.amount, `${path}.amount`),
    currency,
  };
}

function parseToolCall(value: unknown, path: string): AgentToolCall {
  const input = objectAt(value, path);
  return {
    ...optionalStringField(input, "id", `${path}.id`),
    name: stringAt(input.name, `${path}.name`),
    ...optionalResultEnumField(input, "status", `${path}.status`, toolCallStatuses),
    ...optionalJsonObjectField(input, "safeInput", `${path}.safeInput`),
    ...optionalStringField(input, "safeInputPreview", `${path}.safeInputPreview`),
    ...optionalStringField(input, "safeOutputPreview", `${path}.safeOutputPreview`),
  } as AgentToolCall;
}

function optionalContextField(
  input: Record<string, unknown>,
  key: string,
  path: string,
): { readonly context?: AgentRuntimeTaskContext } {
  return input[key] === undefined ? {} : { context: parseContext(input[key], path) };
}

function optionalControlsField(
  input: Record<string, unknown>,
  key: string,
  path: string,
): { readonly controls?: AgentRuntimeTaskControls } {
  return input[key] === undefined ? {} : { controls: parseControls(input[key], path) };
}

function optionalRoundContextField(
  input: Record<string, unknown>,
  key: string,
  path: string,
): { readonly round?: AgentRuntimeTaskRoundContext } {
  return input[key] === undefined ? {} : { round: parseRoundContext(input[key], path) };
}

function optionalRoundMemberIdentityField(
  input: Record<string, unknown>,
  key: string,
  path: string,
): { readonly adversaryOf?: AgentRuntimeTaskRoundMemberIdentity } {
  return input[key] === undefined
    ? {}
    : { adversaryOf: parseRoundMemberIdentity(input[key], path) };
}

function optionalTelemetryField(
  input: Record<string, unknown>,
  key: string,
  path: string,
): { readonly telemetry?: ProviderTaskTelemetry } {
  return input[key] === undefined
    ? {}
    : { telemetry: parseTelemetryAt(input[key], path) };
}

function parseTelemetryAt(value: unknown, path: string): ProviderTaskTelemetry {
  try {
    return parseTelemetry(value);
  } catch (error) {
    if (error instanceof AgentRuntimeTaskProtocolError) {
      throw protocolError(error.code, error.message.replace("telemetry", path));
    }
    throw error;
  }
}

function optionalUsageField(
  input: Record<string, unknown>,
  key: string,
  path: string,
): { readonly usage?: AgentUsage } {
  return input[key] === undefined ? {} : { usage: parseUsage(input[key], path) };
}

function optionalCostField(
  input: Record<string, unknown>,
  key: string,
  path: string,
): { readonly cost?: AgentCost } {
  return input[key] === undefined ? {} : { cost: parseCost(input[key], path) };
}

function optionalToolCallsField(
  input: Record<string, unknown>,
  key: string,
  path: string,
): { readonly toolCalls?: readonly AgentToolCall[] } {
  if (input[key] === undefined) return {};
  if (!Array.isArray(input[key])) {
    throw protocolError(
      "agent_runtime_task_result_invalid",
      `${path} must be an array`,
    );
  }
  return {
    toolCalls: input[key].map((toolCall, index) =>
      parseToolCall(toolCall, `${path}[${index}]`),
    ),
  };
}

function optionalMetadataField(
  input: Record<string, unknown>,
  key: string,
  path: string,
): { readonly [P in string]?: Readonly<Record<string, string>> } {
  if (input[key] === undefined) return {};
  const metadata = objectAt(input[key], path);
  const parsed: Record<string, string> = {};
  for (const [metadataKey, metadataValue] of Object.entries(metadata)) {
    parsed[metadataKey] = stringAt(metadataValue, `${path}.${metadataKey}`);
  }
  return { [key]: parsed };
}

function optionalStringField(
  input: Record<string, unknown>,
  key: string,
  path: string,
): { readonly [P in string]?: string } {
  return input[key] === undefined ? {} : { [key]: stringAt(input[key], path) };
}

function optionalStringArrayField(
  input: Record<string, unknown>,
  key: string,
  path: string,
): { readonly [P in string]?: readonly string[] } {
  if (input[key] === undefined) return {};
  if (!Array.isArray(input[key])) {
    throw protocolError(
      "agent_runtime_task_request_invalid",
      `${path} must be an array`,
    );
  }
  return {
    [key]: input[key].map((item, index) => stringAt(item, `${path}[${index}]`)),
  };
}

function optionalStringRecordField(
  input: Record<string, unknown>,
  key: string,
  path: string,
): { readonly [P in string]?: Readonly<Record<string, string>> } {
  if (input[key] === undefined) return {};
  const value = objectAt(input[key], path);
  const parsed: Record<string, string> = {};
  for (const [recordKey, recordValue] of Object.entries(value)) {
    parsed[recordKey] = stringAt(recordValue, `${path}.${recordKey}`);
  }
  return { [key]: parsed };
}

function optionalEnumField<T extends string>(
  input: Record<string, unknown>,
  key: string,
  path: string,
  allowed: ReadonlySet<T>,
): { readonly [P in string]?: T } {
  if (input[key] === undefined) return {};
  const value = stringAt(input[key], path);
  if (!allowed.has(value as T)) {
    throw protocolError("agent_runtime_task_request_invalid", `${path} is unsupported`);
  }
  return { [key]: value as T };
}

function optionalResultEnumField<T extends string>(
  input: Record<string, unknown>,
  key: string,
  path: string,
  allowed: ReadonlySet<T>,
): { readonly [P in string]?: T } {
  if (input[key] === undefined) return {};
  const value = stringAt(input[key], path);
  if (!allowed.has(value as T)) {
    throw protocolError("agent_runtime_task_result_invalid", `${path} is unsupported`);
  }
  return { [key]: value as T };
}

function optionalJsonObjectField(
  input: Record<string, unknown>,
  key: string,
  path: string,
): { readonly [P in string]?: JsonObject } {
  if (input[key] === undefined) return {};
  const value = parseJsonValue(input[key], path);
  if (!isPlainObject(value)) {
    throw protocolError(
      "agent_runtime_task_json_invalid",
      `${path} must be a JSON object`,
    );
  }
  return { [key]: value as JsonObject };
}

function optionalPositiveIntegerField(
  input: Record<string, unknown>,
  key: string,
  path: string,
): { readonly [P in string]?: number } {
  if (input[key] === undefined) return {};
  return { [key]: positiveIntegerAt(input[key], path) };
}

function optionalNonNegativeNumberField(
  input: Record<string, unknown>,
  key: string,
  path: string,
): { readonly [P in string]?: number } {
  if (input[key] === undefined) return {};
  return { [key]: nonNegativeNumberAt(input[key], path) };
}
