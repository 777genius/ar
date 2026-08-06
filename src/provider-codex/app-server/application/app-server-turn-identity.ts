export class AppServerTurnIdentityTracker {
  private readonly completed = new Set<string>();
  private readonly unmatchedCompleted = new Set<string>();
  private readonly started = new Set<string>();

  onStarted(actualTurnId: string | null, expectedTurnId: string | undefined): Error | null {
    if (expectedTurnId) this.started.add(expectedTurnId);
    if (actualTurnId && expectedTurnId && actualTurnId !== expectedTurnId) {
      this.unmatchedCompleted.delete(actualTurnId);
    }
    return actualTurnId && expectedTurnId && actualTurnId === expectedTurnId &&
        this.unmatchedCompleted.size > 0
      ? new Error("codex_app_server_turn_usage_wrong_turn")
      : null;
  }

  onCompleted(
    turnId: string,
    canonicalTurnId: string,
    pendingTurnIds: ReadonlySet<string>,
  ): Error | null {
    if (this.completed.has(turnId)) {
      return new Error("codex_app_server_turn_usage_duplicate");
    }
    this.completed.add(turnId);
    if (pendingTurnIds.size === 0 || pendingTurnIds.has(canonicalTurnId)) return null;
    for (const pendingTurnId of pendingTurnIds) {
      if (this.started.has(pendingTurnId)) {
        return new Error("codex_app_server_turn_usage_wrong_turn");
      }
    }
    this.unmatchedCompleted.add(turnId);
    return null;
  }

  clear(): void {
    this.completed.clear();
    this.unmatchedCompleted.clear();
    this.started.clear();
  }
}

export function deleteAppServerTurnAliases(
  aliases: Map<string, string>,
  turnId: string,
): void {
  for (const [actualTurnId, expectedTurnId] of aliases) {
    if (actualTurnId === turnId || expectedTurnId === turnId) {
      aliases.delete(actualTurnId);
    }
  }
}
