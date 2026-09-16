import type { AgentUsage } from "@vioxen/subscription-runtime/core";
import { readRecord } from "./app-server-record";

export function readUsageFromRecords(
  ...values: readonly unknown[]
): AgentUsage | undefined {
  let usage: AgentUsage | undefined;
  for (const value of values) {
    usage = mergeAgentUsage(usage, readUsage(value));
  }
  return usage;
}

export function mergeAgentUsage(
  left: AgentUsage | undefined,
  right: AgentUsage | undefined,
): AgentUsage | undefined {
  if (!left) return right;
  if (!right) return left;
  const inputTokens = sumOptional(left.inputTokens, right.inputTokens);
  const outputTokens = sumOptional(left.outputTokens, right.outputTokens);
  const totalTokens = sumOptional(left.totalTokens, right.totalTokens);
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  };
}

export function preferredUsage(
  turnUsage: AgentUsage | undefined,
  goalUsage: AgentUsage | undefined,
): AgentUsage | undefined {
  if (hasDetailedUsage(turnUsage)) return turnUsage;
  return turnUsage ?? goalUsage;
}

export function usageField(
  usage: AgentUsage | undefined,
): { readonly usage: AgentUsage } | Record<string, never> {
  return usage === undefined ? {} : { usage };
}

function readUsage(value: unknown): AgentUsage | undefined {
  const record = readRecord(value);
  if (!record) return undefined;
  const direct = normalizeUsageRecord(record);
  const nested = readUsageFromRecords(
    record.usage,
    record.tokenUsage,
    record.token_usage,
    record.tokens,
    record.metrics,
    readRecord(record.status)?.usage,
  );
  return mergeAgentUsage(direct, nested);
}

function normalizeUsageRecord(
  record: Record<string, unknown>,
): AgentUsage | undefined {
  const inputTokens = numberField(
    record,
    "inputTokens",
    "input_tokens",
    "promptTokens",
    "prompt_tokens",
    "totalInputTokens",
    "total_input_tokens",
  );
  const outputTokens = numberField(
    record,
    "outputTokens",
    "output_tokens",
    "completionTokens",
    "completion_tokens",
    "totalOutputTokens",
    "total_output_tokens",
  );
  const totalTokens =
    numberField(
      record,
      "totalTokens",
      "total_tokens",
      "tokensUsed",
      "tokens_used",
      "usedTokens",
      "used_tokens",
    ) ?? derivedTotalTokens(inputTokens, outputTokens);
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined
  ) {
    return undefined;
  }
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  };
}

function numberField(
  record: Record<string, unknown>,
  ...keys: readonly string[]
): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return value;
    }
  }
  return undefined;
}

function derivedTotalTokens(
  inputTokens: number | undefined,
  outputTokens: number | undefined,
): number | undefined {
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return (inputTokens ?? 0) + (outputTokens ?? 0);
}

function hasDetailedUsage(usage: AgentUsage | undefined): boolean {
  return usage?.inputTokens !== undefined || usage?.outputTokens !== undefined;
}

function sumOptional(
  left: number | undefined,
  right: number | undefined,
): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return left + right;
}
