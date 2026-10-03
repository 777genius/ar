import { ClaudeProviderFailureError } from "./failure-classifier";
import type { AgentUsage, ProviderTaskTelemetry } from "@vioxen/subscription-runtime/core";
import { AgentRuntimeCostCurrency } from "@vioxen/subscription-runtime/core";

/** Only numeric measurements cross failure boundaries; never provider session data. */
export function numericClaudeTelemetry(value: ProviderTaskTelemetry | undefined): ProviderTaskTelemetry {
  const telemetry: { durationMs?: number; turns?: number; usage?: AgentUsage; cost?: NonNullable<ProviderTaskTelemetry["cost"]> } = {};
  for (const key of ["durationMs", "turns"] as const) {
    const number = finiteNonnegative(value?.[key]);
    if (number !== undefined) telemetry[key] = number;
  }
  const usage: Record<string, number> = {};
  for (const key of ["inputTokens", "outputTokens", "totalTokens", "cachedInputTokens", "cacheWriteInputTokens", "reasoningOutputTokens"] as const) {
    const number = finiteNonnegative(value?.usage?.[key]);
    if (number !== undefined) usage[key] = number;
  }
  if (Object.keys(usage).length) telemetry.usage = usage;
  const amount = finiteNonnegative(value?.cost?.amount);
  if (amount !== undefined && value?.cost?.currency === AgentRuntimeCostCurrency.Usd) {
    telemetry.cost = { amount, currency: AgentRuntimeCostCurrency.Usd };
  }
  return telemetry;
}

export class ClaudeTaskTelemetryError extends Error {
  readonly telemetry: ProviderTaskTelemetry;
  constructor(cause: unknown, telemetry: ProviderTaskTelemetry) {
    super("Claude task failed after reporting telemetry.", { cause });
    this.telemetry = numericClaudeTelemetry(telemetry);
  }
}

export function claudeTelemetryFromError(error: unknown): ProviderTaskTelemetry | undefined {
  const seen = new Set<unknown>();
  while (error instanceof Error && !seen.has(error)) {
    seen.add(error);
    if ((error instanceof ClaudeTaskTelemetryError || error instanceof ClaudeProviderFailureError) && error.telemetry !== undefined) return error.telemetry;
    error = error.cause;
  }
  return undefined;
}

export function finiteNonnegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
