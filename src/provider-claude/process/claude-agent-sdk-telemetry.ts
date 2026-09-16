import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { AgentRuntimeCostCurrency, type ProviderTaskTelemetry } from "@vioxen/subscription-runtime/core";
import { finiteNonnegative, numericClaudeTelemetry } from "../protocol/task-telemetry";

export function sdkClaudeTelemetry(message: SDKResultMessage): ProviderTaskTelemetry {
  // modelUsage covers the whole query pipeline; usage only covers the main loop.
  // Accept complete numeric model records, otherwise use the SDK usage fallback.
  const models = modelTotals(message.modelUsage);
  const input = models?.inputTokens ?? finiteNonnegative(message.usage?.input_tokens);
  const outputTokens = models?.outputTokens ?? finiteNonnegative(message.usage?.output_tokens);
  const cachedInputTokens = models?.cacheReadInputTokens ?? finiteNonnegative(message.usage?.cache_read_input_tokens);
  const cacheWriteInputTokens = models?.cacheCreationInputTokens ?? finiteNonnegative(message.usage?.cache_creation_input_tokens);
  // Anthropic input_tokens excludes both cache categories; our cache fields are subsets.
  const inputTokens = input === undefined ? undefined
    : finiteNonnegative(input + (cachedInputTokens ?? 0) + (cacheWriteInputTokens ?? 0));
  const totalTokens = inputTokens === undefined || outputTokens === undefined ? undefined
    : finiteNonnegative(inputTokens + outputTokens);
  return numericClaudeTelemetry({
    durationMs: message.duration_ms,
    turns: message.num_turns,
    cost: { amount: message.total_cost_usd, currency: AgentRuntimeCostCurrency.Usd },
    usage: {
      ...(inputTokens === undefined ? {} : { inputTokens }),
      ...(outputTokens === undefined ? {} : { outputTokens }),
      ...(totalTokens === undefined ? {} : { totalTokens }),
      ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
      ...(cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens }),
    },
  });
}


const modelTokenKeys = ["inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens"] as const;
type ModelTotals = Record<typeof modelTokenKeys[number], number>;

function modelTotals(value: unknown): ModelTotals | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.values(value);
  if (entries.length === 0) return undefined;
  const totals: ModelTotals = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return undefined;
    for (const key of modelTokenKeys) {
      const count = finiteNonnegative((entry as Record<string, unknown>)[key]);
      if (count === undefined) return undefined;
      const sum = finiteNonnegative(totals[key] + count);
      if (sum === undefined) return undefined;
      totals[key] = sum;
    }
  }
  return totals;
}
