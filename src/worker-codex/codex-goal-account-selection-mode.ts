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
