import { parseNativeWebEvidence } from "../domain/native-web-receipt";
import type {
  AgentCost,
  AgentToolCall,
  AgentUsage,
  ManagedRunResumeHandle,
  ProviderTaskTelemetry,
} from "../domain/types";

/** Primitive validation stays with the caller's versioned protocol boundary. */
export interface ProviderTaskPayloadValidation {
  readonly objectAt: (value: unknown, path: string) => Record<string, unknown>;
  readonly stringAt: (value: unknown, path: string) => string;
  readonly nonEmptyStringAt: (value: unknown, path: string) => string;
  readonly positiveIntegerAt: (value: unknown, path: string) => number;
  readonly nonNegativeNumberAt: (value: unknown, path: string) => number;
  readonly optionalJsonObjectField: (
    input: Record<string, unknown>,
    key: string,
    path: string,
  ) => { readonly [key: string]: Readonly<Record<string, unknown>> | undefined };
  readonly resultError: (message: string) => Error;
}

/**
 * Parses only core-owned provider payloads. Version dispatch, error identities,
 * JSON sanitization and the accepted finish reasons belong to each task codec.
 */
export function createProviderTaskPayloadParser({
  objectAt,
  stringAt,
  nonEmptyStringAt,
  positiveIntegerAt,
  nonNegativeNumberAt,
  optionalJsonObjectField,
  resultError,
}: ProviderTaskPayloadValidation) {
  const toolCallStatuses = new Set<NonNullable<AgentToolCall["status"]>>([
    "started",
    "completed",
    "failed",
    "denied",
  ]);

  return {
    parseManagedRunResumeHandle,
    parseTelemetry,
    parseUsage,
    parseToolCall,
  };

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

  function parseTelemetry(
    value: unknown,
    finishReasons: ReadonlySet<NonNullable<ProviderTaskTelemetry["finishReason"]>>,
  ): ProviderTaskTelemetry {
    const input = objectAt(value, "telemetry");
    let nativeWeb: ProviderTaskTelemetry["nativeWeb"];
    try {
      nativeWeb = input.nativeWeb === undefined
        ? undefined
        : parseNativeWebEvidence(input.nativeWeb);
    } catch {
      throw resultError(
        "telemetry.nativeWeb must contain finite validated transport observations",
      );
    }
    return {
      ...(nativeWeb === undefined ? {} : { nativeWeb }),
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
    return Object.assign({}, ...[
      "inputTokens", "outputTokens", "totalTokens", "cachedInputTokens",
      "cacheWriteInputTokens", "reasoningOutputTokens",
    ].map((key) => optionalPositiveIntegerField(input, key, `${path}.${key}`)));
  }

  function parseCost(value: unknown, path: string): AgentCost {
    const input = objectAt(value, path);
    const currency = stringAt(input.currency, `${path}.currency`);
    if (currency !== "USD") {
      throw resultError(`${path}.currency must be USD`);
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
      throw resultError(`${path} must be an array`);
    }
    return {
      toolCalls: input[key].map((toolCall, index) =>
        parseToolCall(toolCall, `${path}[${index}]`),
      ),
    };
  }

  function optionalStringField(
    input: Record<string, unknown>,
    key: string,
    path: string,
  ): { readonly [P in string]?: string } {
    return input[key] === undefined ? {} : { [key]: stringAt(input[key], path) };
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

  function optionalResultEnumField<T extends string>(
    input: Record<string, unknown>,
    key: string,
    path: string,
    allowed: ReadonlySet<T>,
  ): { readonly [P in string]?: T } {
    if (input[key] === undefined) return {};
    const value = stringAt(input[key], path);
    if (!allowed.has(value as T)) {
      throw resultError(`${path} is unsupported`);
    }
    return { [key]: value as T };
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
}
