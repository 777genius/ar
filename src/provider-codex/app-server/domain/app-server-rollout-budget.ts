export type CodexAppServerRolloutBudget = {
  readonly weightedTokenLimit: number;
};

export function codexAppServerRolloutBudgetConfig(
  budget: CodexAppServerRolloutBudget | undefined,
): Readonly<Record<string, unknown>> {
  if (!budget) return {};
  if (
    !Number.isSafeInteger(budget.weightedTokenLimit) ||
    budget.weightedTokenLimit <= 0
  ) {
    throw new Error("codex_app_server_rollout_budget_invalid");
  }
  return {
    rollout_budget: {
      enabled: true,
      limit_tokens: budget.weightedTokenLimit,
      reminder_at_remaining_tokens: reminderThresholds(
        budget.weightedTokenLimit,
      ),
      sampling_token_weight: 1,
      prefill_token_weight: 1,
    },
  };
}

function reminderThresholds(limit: number): readonly number[] {
  return [...new Set([0.75, 0.5, 0.25].map((ratio) => Math.floor(limit * ratio)))]
    .filter((value) => value > 0 && value < limit)
    .sort((left, right) => right - left);
}
