export function isCodexAppServerReconnectProgressMessage(
  message: string,
): boolean {
  return /\breconnecting(?:\.{3}|…)?\s*\d+\s*\/\s*\d+\b/i.test(message);
}

/** Turn-scoped notifications that prove the turn is alive after a reconnect. */
export function isCodexAppServerTurnProgressMethod(method: string): boolean {
  return /^item\/(?:started|completed)$/.test(method) || /^item\/[^/]+\/(?:delta|[A-Za-z]*Delta)$/.test(method) ||
    method === "thread/tokenUsage/updated" || method === "turn/diff/updated" || method === "turn/plan/updated";
}
