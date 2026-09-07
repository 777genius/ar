import type { AgentUsage } from "@vioxen/subscription-runtime/core";
import { readRecord } from "./app-server-record";

const usageKeys = ["inputTokens", "outputTokens", "totalTokens", "cachedInputTokens", "cacheWriteInputTokens", "reasoningOutputTokens"] as const;

type UsageKey = (typeof usageKeys)[number];

export function readUsageFromRecords(
  ...values: readonly unknown[]
): AgentUsage | undefined {
  let usage: AgentUsage | undefined;
  for (const value of values) {
    usage = mergeAgentUsage(usage, readUsage(value));
  }
  return usage;
}

/**
 * Outcome of reading `thread/tokenUsage/updated`'s `tokenUsage.last`, the
 * provider's exact usage for one model response.
 *
 * `absent` and `invalid` are deliberately distinct outcomes. Absent means the
 * provider reported nothing for this update, so it carries no exact billing
 * signal. Invalid means it reported something we cannot trust, which must never
 * be silently downgraded to "no data" — the caller fails the turn's usage closed
 * instead of billing a number it cannot stand behind.
 */
export type ExactTurnUsageSnapshot =
  | { readonly kind: "absent" }
  | { readonly kind: "invalid" }
  | { readonly kind: "occupancy"; readonly usage: AgentUsage }
  | { readonly kind: "exact"; readonly usage: AgentUsage };

/**
 * The accepted spellings of one counter, derived from {@link usageKeys} so a
 * seventh field cannot be added to the counter list and forgotten here.
 */
function exactUsageAliases(key: UsageKey): readonly string[] {
  return [key, key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)];
}

/**
 * Strictly reads one exact usage snapshot.
 *
 * Deliberately stricter than {@link readUsageFromRecords}, which stays lenient
 * for the cumulative and goal-fallback parsers: here a single counter that is
 * negative, fractional, non-finite, beyond safe-integer range, contradicted by
 * its own alias, or inconsistent with its own total rejects the WHOLE snapshot
 * rather than dropping one field. A partially-believed billing number is worse
 * than no number at all.
 */
export function readExactTurnUsage(value: unknown): ExactTurnUsageSnapshot {
  if (value === undefined || value === null) return { kind: "absent" };
  const record = readRecord(value);
  if (!record) return { kind: "invalid" };
  const usage: Record<string, number> = {};
  for (const key of usageKeys) {
    for (const alias of exactUsageAliases(key)) {
      const counter = record[alias];
      if (counter === undefined) continue;
      // Every present alias is checked, not just the first one that resolves.
      if (typeof counter !== "number" || !Number.isSafeInteger(counter) || counter < 0) {
        return { kind: "invalid" };
      }
      // Two spellings of one counter disagreeing is a contradiction, not a
      // preference: a first-wins read would carry the loser past every check.
      if (usage[key] !== undefined && usage[key] !== counter) return { kind: "invalid" };
      usage[key] = counter;
    }
  }
  const kind = classifyTotalTokens(usage);
  if (kind === "invalid") return { kind: "invalid" };
  if (Object.keys(usage).length === 0) return { kind: "absent" };
  return { kind, usage };
}

/**
 * Decides what a well-formed snapshot actually reports, and fills in a missing
 * total only when both parts are known.
 *
 * Three outcomes, and the middle one is the whole point:
 *
 * - **occupancy.** Both itemised counters reported as ZERO against a positive
 *   total is not a model response — a response always consumes input. It is the
 *   shape the provider uses to report how full the context window is:
 *   `TokenUsageInfo::fill_to_context_window` emits it when a turn exhausts the
 *   window, and `Session::recompute_token_usage` emits it after a successful
 *   mid-turn auto-compaction, where the number is an estimate of the ENTIRE
 *   conversation history. Billing either one charges a whole context window, or
 *   a whole history, to a single turn.
 * - **invalid.** With both parts known, `totalTokens` must equal their sum.
 *   `cachedInputTokens` is a subset of `inputTokens` and `reasoningOutputTokens`
 *   a subset of `outputTokens`, so nothing legitimately pushes the total above
 *   the sum. One-sidedly, a present part may still not exceed the total that
 *   contains it: `{ inputTokens: 100, totalTokens: 5 }` is a contradiction even
 *   though `outputTokens` is missing.
 * - **exact.** Everything else, and only then is it a cost.
 *
 * A missing total is never derived from a single part: `{ outputTokens: 500 }`
 * would implicitly assert `inputTokens === 0`, fabricating a billing number out
 * of an incomplete snapshot rather than reporting the part we actually read.
 */
function classifyTotalTokens(usage: Record<string, number>): "exact" | "occupancy" | "invalid" {
  const { inputTokens, outputTokens, totalTokens } = usage;
  if (totalTokens === undefined) {
    if (inputTokens !== undefined && outputTokens !== undefined) {
      usage.totalTokens = inputTokens + outputTokens;
    }
    return "exact";
  }
  if (inputTokens === 0 && outputTokens === 0 && totalTokens > 0) return "occupancy";
  if (inputTokens !== undefined && outputTokens !== undefined) {
    return totalTokens === inputTokens + outputTokens ? "exact" : "invalid";
  }
  return (inputTokens ?? outputTokens ?? 0) > totalTokens ? "invalid" : "exact";
}

export function mergeAgentUsage(
  left: AgentUsage | undefined,
  right: AgentUsage | undefined,
): AgentUsage | undefined {
  if (!left) return right;
  if (!right) return left;
  const result: Record<string, number> = {};
  for (const key of usageKeys) {
    const value = sumOptional(left[key], right[key]);
    if (value !== undefined) result[key] = value;
  }
  return result;
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
  const cachedInputTokens = numberField(record, "cachedInputTokens", "cached_input_tokens");
  const cacheWriteInputTokens = numberField(record, "cacheWriteInputTokens", "cache_write_input_tokens");
  const reasoningOutputTokens = numberField(record, "reasoningOutputTokens", "reasoning_output_tokens");
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
  // Deliberately lenient: this parser also serves cumulative and goal-fallback
  // payloads, where dropping one unreadable field beats rejecting the snapshot.
  const counters: Record<UsageKey, number | undefined> = {
    inputTokens,
    outputTokens,
    totalTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    reasoningOutputTokens,
  };
  const result: Record<string, number> = {};
  for (const key of usageKeys) {
    const value = counters[key];
    if (value !== undefined) result[key] = value;
  }
  return Object.keys(result).length ? result : undefined;
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

// Both operands are snapshots, never additive deltas.
export function subtractAgentUsage(total: AgentUsage | undefined, baseline: AgentUsage | undefined): AgentUsage | undefined {
  if (!total) return undefined;
  const result: Record<string, number> = {};
  for (const key of usageKeys) {
    const value = total[key];
    if (value !== undefined) result[key] = Math.max(0, value - (baseline?.[key] ?? 0));
  }
  return Object.keys(result).length ? result : undefined;
}

export function sanitizeAgentUsage(usage: AgentUsage | undefined): AgentUsage | undefined {
  const result: Record<string, number> = {};
  for (const key of usageKeys) {
    const value = usage?.[key];
    if (value !== undefined && Number.isFinite(value) && value >= 0) result[key] = value;
  }
  return Object.keys(result).length ? result : undefined;
}

export function maximumAgentUsage(left: AgentUsage | undefined, right: AgentUsage | undefined): AgentUsage | undefined {
  if (!left) return right;
  if (!right) return left;
  return Object.fromEntries(Object.entries({ ...left, ...right }).map(
    ([key, value]) => [key, Math.max(value, left[key as keyof AgentUsage] ?? 0)],
  ));
}
