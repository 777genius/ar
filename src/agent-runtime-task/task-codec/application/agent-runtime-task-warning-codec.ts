import type { RuntimeWarning } from "@vioxen/subscription-runtime/core";
import {
  objectAt,
  protocolError,
  stringAt,
} from "./agent-runtime-task-validation";

export function parseWarnings(
  value: unknown,
  path: string,
): readonly RuntimeWarning[] {
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

export function parseWarning(value: unknown, path: string): RuntimeWarning {
  const input = objectAt(value, path);
  return {
    code: stringAt(input.code, `${path}.code`),
    safeMessage: stringAt(input.safeMessage, `${path}.safeMessage`),
    ...optionalDetails(input, path),
  };
}

function optionalDetails(
  input: Record<string, unknown>,
  path: string,
): { readonly details?: Readonly<Record<string, string>> } {
  if (input.details === undefined) return {};
  const details = objectAt(input.details, `${path}.details`);
  const parsed: Record<string, string> = {};
  for (const [key, value] of Object.entries(details)) {
    parsed[key] = stringAt(value, `${path}.details.${key}`);
  }
  return { details: parsed };
}
