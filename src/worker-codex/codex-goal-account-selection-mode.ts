export enum CodexGoalAccountSelectionMode {
  Explicit = "explicit",
  Automatic = "automatic",
}

export function optionalCodexGoalAccountSelectionMode(value: unknown):
  { readonly accountSelectionMode?: CodexGoalAccountSelectionMode } {
  if (value === undefined) return {};
  if (value === CodexGoalAccountSelectionMode.Explicit ||
      value === CodexGoalAccountSelectionMode.Automatic) {
    return { accountSelectionMode: value };
  }
  throw new Error("codex_goal_job_accountSelectionMode_invalid");
}

export function assertAccountReplacementHasKnownOrigin(input: {
  readonly existing: { readonly accounts: readonly string[]; readonly accountSelectionMode?: CodexGoalAccountSelectionMode };
  readonly patch: { readonly accounts?: readonly string[]; readonly accountSelectionMode?: CodexGoalAccountSelectionMode };
}): void {
  const { existing, patch } = input;
  if (patch.accounts === undefined || patch.accountSelectionMode !== undefined ||
      existing.accountSelectionMode === undefined) return;
  if (patch.accounts.length === existing.accounts.length &&
      patch.accounts.every((account, index) => account === existing.accounts[index])) return;
  throw new Error("codex_goal_job_account_selection_origin_required");
}
