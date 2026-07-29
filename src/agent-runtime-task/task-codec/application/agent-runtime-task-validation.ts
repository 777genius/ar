import {
  agentRuntimeTaskProtocolVersionV1,
  agentRuntimeTaskProtocolVersionV2,
  AgentRuntimeTaskProtocolError,
  type AgentRuntimeTaskProtocolVersion,
  type JsonValue,
} from "../domain/agent-runtime-task-contracts";

export function parseProtocolVersion(
  value: unknown,
  path: string,
): AgentRuntimeTaskProtocolVersion {
  if (
    value !== agentRuntimeTaskProtocolVersionV1 &&
    value !== agentRuntimeTaskProtocolVersionV2
  ) {
    throw protocolError(
      "agent_runtime_task_protocol_version_invalid",
      `${path} must be ${agentRuntimeTaskProtocolVersionV1} or ${agentRuntimeTaskProtocolVersionV2}`,
    );
  }
  return value;
}

export function parseJsonValue(value: unknown, path = "json"): JsonValue {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw protocolError(
        "agent_runtime_task_json_invalid",
        `${path} must be a finite JSON number`,
      );
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => parseJsonValue(item, `${path}[${index}]`));
  }
  if (isPlainObject(value)) {
    const parsed: Record<string, JsonValue> = {};
    for (const [key, nested] of Object.entries(value)) {
      if (nested === undefined) continue;
      parsed[key] = parseJsonValue(nested, `${path}.${key}`);
    }
    return parsed;
  }
  throw protocolError(
    "agent_runtime_task_json_invalid",
    `${path} must be JSON serializable`,
  );
}

export function objectAt(
  value: unknown,
  path: string,
): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw protocolError(
      "agent_runtime_task_request_invalid",
      `${path} must be an object`,
    );
  }
  return value;
}

export function assertOnlyKeys(
  input: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  path: string,
): void {
  const known = new Set(allowed);
  const unknown = Object.keys(input).find((key) => !known.has(key));
  if (unknown === undefined) return;
  throw protocolError(
    "agent_runtime_task_request_invalid",
    `${path}.${unknown} is unsupported`,
  );
}

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringAt(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw protocolError(
      "agent_runtime_task_request_invalid",
      `${path} must be a string`,
    );
  }
  return value;
}

export function nonEmptyStringAt(value: unknown, path: string): string {
  const text = stringAt(value, path).trim();
  if (text.length === 0) {
    throw protocolError(
      "agent_runtime_task_request_invalid",
      `${path} must be a non-empty string`,
    );
  }
  return text;
}

export function isoStringAt(value: unknown, path: string): string {
  const text = stringAt(value, path);
  if (Number.isNaN(Date.parse(text))) {
    throw protocolError(
      "agent_runtime_task_event_invalid",
      `${path} must be an ISO timestamp`,
    );
  }
  return text;
}

export function booleanAt(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw protocolError(
      "agent_runtime_task_result_invalid",
      `${path} must be a boolean`,
    );
  }
  return value;
}

export function positiveIntegerAt(value: unknown, path: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw protocolError(
      "agent_runtime_task_request_invalid",
      `${path} must be a positive integer`,
    );
  }
  return value as number;
}

export function nonNegativeNumberAt(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw protocolError(
      "agent_runtime_task_result_invalid",
      `${path} must be a non-negative finite number`,
    );
  }
  return value;
}

export function protocolError(
  code: ConstructorParameters<typeof AgentRuntimeTaskProtocolError>[0],
  message: string,
): AgentRuntimeTaskProtocolError {
  return new AgentRuntimeTaskProtocolError(code, message);
}
