import type {
  ProviderTaskControls,
  UnsupportedControlPolicy,
} from "@vioxen/subscription-runtime/core";
import {
  AgentRuntimeAccessBoundary,
  AgentRuntimeBudgetMetric,
  AgentRuntimeEditMode,
  AgentRuntimeProviderSandboxMode,
  AgentRuntimeResponseFormat,
  AgentRuntimeTool,
  AgentRuntimeUnsupportedControlPolicy,
} from "@vioxen/subscription-runtime/core";
import {
  AgentRuntimeTaskProtocolError,
  type AgentRuntimeTaskBudget,
  type AgentRuntimeTaskControls,
  type AgentRuntimeTaskToolPolicy,
  type JsonObject,
  type JsonValue,
} from "../domain/agent-runtime-task-contracts";

const accessBoundaries = new Set<
  NonNullable<AgentRuntimeTaskControls["accessBoundary"]>
>([
  AgentRuntimeAccessBoundary.ReadOnly,
  AgentRuntimeAccessBoundary.IsolatedWorkspaceWrite,
  AgentRuntimeAccessBoundary.DangerFullAccess,
]);
const responseFormats = new Set<NonNullable<ProviderTaskControls["responseFormat"]>>([
  AgentRuntimeResponseFormat.Text,
  AgentRuntimeResponseFormat.Json,
]);
const unsupportedControlPolicies = new Set<UnsupportedControlPolicy>(
  Object.values(AgentRuntimeUnsupportedControlPolicy),
);
const agentRuntimeTools = new Set<string>(Object.values(AgentRuntimeTool));
const budgetMetrics = new Set<string>(Object.values(AgentRuntimeBudgetMetric));

export function providerTaskControls(
  controls: AgentRuntimeTaskControls,
): ProviderTaskControls {
  const boundaryControls = controlsForAccessBoundary(controls, "request.task.controls");
  return {
    ...(controls.model ? { model: controls.model } : {}),
    ...(controls.maxTurns === undefined ? {} : { maxTurns: controls.maxTurns }),
    ...(controls.toolPolicy ? { toolPolicy: controls.toolPolicy } : {}),
    ...(controls.budget ? { budget: controls.budget } : {}),
    ...(controls.accessBoundary
      ? { accessBoundary: controls.accessBoundary }
      : {}),
    ...boundaryControls,
    ...(controls.responseFormat
      ? { responseFormat: controls.responseFormat }
      : {}),
    ...(controls.outputSchemaName
      ? { outputSchemaName: controls.outputSchemaName }
      : {}),
  };
}

export function parseControls(
  value: unknown,
  path: string,
): AgentRuntimeTaskControls {
  const input = objectAt(value, path);
  assertOnlyKeys(input, [
    "model",
    "maxTurns",
    "toolPolicy",
    "budget",
    "accessBoundary",
    "allowDangerFullAccess",
    "responseFormat",
    "outputSchemaName",
    "outputSchema",
  ], path);
  const controls: AgentRuntimeTaskControls = {
    ...optionalStringField(input, "model", `${path}.model`),
    ...optionalPositiveIntegerField(input, "maxTurns", `${path}.maxTurns`),
    ...optionalToolPolicyField(input, "toolPolicy", `${path}.toolPolicy`),
    ...optionalBudgetField(input, "budget", `${path}.budget`),
    ...optionalEnumField(
      input,
      "accessBoundary",
      `${path}.accessBoundary`,
      accessBoundaries,
    ),
    ...optionalBooleanField(
      input,
      "allowDangerFullAccess",
      `${path}.allowDangerFullAccess`,
    ),
    ...optionalEnumField(
      input,
      "responseFormat",
      `${path}.responseFormat`,
      responseFormats,
    ),
    ...optionalStringField(input, "outputSchemaName", `${path}.outputSchemaName`),
    ...optionalJsonObjectField(input, "outputSchema", `${path}.outputSchema`),
  };
  assertDangerAcknowledgementAllowed(controls, path);
  assertReadOnlyToolPolicy(controls, path);
  return controls;
}

function controlsForAccessBoundary(
  controls: AgentRuntimeTaskControls,
  path: string,
): Pick<ProviderTaskControls, "editMode" | "providerSandboxMode"> | undefined {
  switch (controls.accessBoundary) {
    case undefined:
      return undefined;
    case AgentRuntimeAccessBoundary.ReadOnly:
      return { editMode: AgentRuntimeEditMode.ReadOnly };
    case AgentRuntimeAccessBoundary.IsolatedWorkspaceWrite:
      return {
        editMode: AgentRuntimeEditMode.AllowEdits,
        providerSandboxMode: AgentRuntimeProviderSandboxMode.WorkspaceWrite,
      };
    case AgentRuntimeAccessBoundary.DangerFullAccess:
      if (controls.allowDangerFullAccess !== true) {
        throw protocolError(
          "agent_runtime_task_request_invalid",
          `${path}.accessBoundary danger_full_access requires ${path}.allowDangerFullAccess=true`,
        );
      }
      return {
        editMode: AgentRuntimeEditMode.AllowEdits,
        providerSandboxMode: AgentRuntimeProviderSandboxMode.DangerFullAccess,
      };
  }
  throw protocolError(
    "agent_runtime_task_request_invalid",
    `${path}.accessBoundary is unsupported`,
  );
}

function optionalToolPolicyField(
  input: Record<string, unknown>,
  key: string,
  path: string,
): { readonly toolPolicy?: AgentRuntimeTaskToolPolicy } {
  if (input[key] === undefined) return {};
  const value = objectAt(input[key], path);
  assertOnlyKeys(value, ["allow", "deny", "onUnsupported"], path);
  return {
    toolPolicy: {
      ...optionalAgentRuntimeToolArrayField(value, "allow", `${path}.allow`),
      ...optionalAgentRuntimeToolArrayField(value, "deny", `${path}.deny`),
      ...optionalUnsupportedControlPolicyField(
        value,
        "onUnsupported",
        `${path}.onUnsupported`,
      ),
    },
  };
}

function optionalAgentRuntimeToolArrayField(
  input: Record<string, unknown>,
  key: string,
  path: string,
): { readonly [P in string]?: readonly AgentRuntimeTool[] } {
  if (input[key] === undefined) return {};
  if (!Array.isArray(input[key])) {
    throw protocolError(
      "agent_runtime_task_request_invalid",
      `${path} must be an array`,
    );
  }
  return {
    [key]: input[key].map((item, index) => {
      const value = stringAt(item, `${path}[${index}]`);
      if (!agentRuntimeTools.has(value)) {
        throw protocolError(
          "agent_runtime_task_request_invalid",
          `${path}[${index}] is unsupported`,
        );
      }
      return value as AgentRuntimeTool;
    }),
  };
}

function optionalBudgetField(
  input: Record<string, unknown>,
  key: string,
  path: string,
): { readonly budget?: AgentRuntimeTaskBudget } {
  if (input[key] === undefined) return {};
  const value = objectAt(input[key], path);
  assertOnlyKeys(value, ["metric", "limit", "onUnsupported"], path);
  const metric = stringAt(value.metric, `${path}.metric`);
  if (!budgetMetrics.has(metric)) {
    throw protocolError(
      "agent_runtime_task_request_invalid",
      `${path}.metric is unsupported`,
    );
  }
  const limit = metric === AgentRuntimeBudgetMetric.WeightedTokens
    ? positiveIntegerAt(value.limit, `${path}.limit`)
    : positiveNumberAt(value.limit, `${path}.limit`);
  return {
    budget: {
      metric: metric as AgentRuntimeBudgetMetric,
      limit,
      ...optionalUnsupportedControlPolicyField(
        value,
        "onUnsupported",
        `${path}.onUnsupported`,
      ),
    },
  };
}

function optionalUnsupportedControlPolicyField(
  input: Record<string, unknown>,
  key: string,
  path: string,
): { readonly onUnsupported?: UnsupportedControlPolicy } {
  if (input[key] === undefined) return {};
  const value = stringAt(input[key], path);
  if (!unsupportedControlPolicies.has(value as UnsupportedControlPolicy)) {
    throw protocolError("agent_runtime_task_request_invalid", `${path} is unsupported`);
  }
  return { onUnsupported: value as UnsupportedControlPolicy };
}

function assertDangerAcknowledgementAllowed(
  controls: AgentRuntimeTaskControls,
  path: string,
): void {
  if (
    controls.accessBoundary === AgentRuntimeAccessBoundary.DangerFullAccess &&
    controls.allowDangerFullAccess !== true
  ) {
    throw protocolError(
      "agent_runtime_task_request_invalid",
      `${path}.accessBoundary danger_full_access requires ${path}.allowDangerFullAccess=true`,
    );
  }
  if (
    controls.allowDangerFullAccess === true &&
    controls.accessBoundary !== AgentRuntimeAccessBoundary.DangerFullAccess
  ) {
    throw protocolError(
      "agent_runtime_task_request_invalid",
      `${path}.allowDangerFullAccess is valid only with danger_full_access`,
    );
  }
}

function assertReadOnlyToolPolicy(
  controls: AgentRuntimeTaskControls,
  path: string,
): void {
  if (
    controls.accessBoundary !== AgentRuntimeAccessBoundary.ReadOnly ||
    controls.toolPolicy?.allow === undefined
  ) {
    return;
  }
  const unsafe = controls.toolPolicy.allow.filter(
    (tool) =>
      tool !== AgentRuntimeTool.ReadFile &&
      tool !== AgentRuntimeTool.SearchFiles &&
      // ReadOnly limits workspace mutation; web remains an explicit tool opt-in.
      tool !== AgentRuntimeTool.WebAccess,
  );
  if (unsafe.length === 0) return;
  throw protocolError(
    "agent_runtime_task_request_invalid",
    `${path}.toolPolicy.allow contains tools incompatible with read_only: ${unsafe.join(",")}`,
  );
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

function optionalBooleanField(
  input: Record<string, unknown>,
  key: string,
  path: string,
): { readonly [P in string]?: boolean } {
  if (input[key] === undefined) return {};
  if (typeof input[key] !== "boolean") {
    throw protocolError("agent_runtime_task_request_invalid", `${path} must be a boolean`);
  }
  return { [key]: input[key] };
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

function optionalPositiveIntegerField(
  input: Record<string, unknown>,
  key: string,
  path: string,
): { readonly [P in string]?: number } {
  if (input[key] === undefined) return {};
  return { [key]: positiveIntegerAt(input[key], path) };
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

function parseJsonValue(value: unknown, path = "json"): JsonValue {
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
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      parsed[key] = parseJsonValue(item, `${path}.${key}`);
    }
    return parsed;
  }
  throw protocolError("agent_runtime_task_json_invalid", `${path} must be JSON`);
}

function objectAt(value: unknown, path: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw protocolError("agent_runtime_task_request_invalid", `${path} must be an object`);
  }
  return value;
}

function assertOnlyKeys(
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringAt(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw protocolError("agent_runtime_task_request_invalid", `${path} must be a string`);
  }
  return value;
}

function positiveIntegerAt(value: unknown, path: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw protocolError(
      "agent_runtime_task_request_invalid",
      `${path} must be a positive integer`,
    );
  }
  return value as number;
}

function positiveNumberAt(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw protocolError(
      "agent_runtime_task_request_invalid",
      `${path} must be a positive finite number`,
    );
  }
  return value;
}

function protocolError(
  code: ConstructorParameters<typeof AgentRuntimeTaskProtocolError>[0],
  message: string,
): AgentRuntimeTaskProtocolError {
  return new AgentRuntimeTaskProtocolError(code, message);
}
