import type { AgentUsage } from "@vioxen/subscription-runtime/core";

export type AppServerTurnResult = {
  readonly threadId: string;
  readonly turnId: string;
  readonly outputText: string;
  readonly usage: AgentUsage | undefined;
  readonly completed: boolean;
  readonly error: Error | null;
};

export type AppServerTurnState = {
  outputText: string;
  onTextDelta?: ((text: string) => void) | null;
  usage: AgentUsage | undefined;
  completed: boolean;
  error: Error | null;
  waiters: ((state: AppServerTurnState) => void)[];
  reconnectGraceTimer: NodeJS.Timeout | null;
};

export function createAppServerTurnState(): AppServerTurnState {
  return {
    outputText: "",
    usage: undefined,
    completed: false,
    error: null,
    waiters: [],
    reconnectGraceTimer: null,
  };
}

export function clearAppServerReconnectGraceTimer(
  turn: AppServerTurnState,
): void {
  if (!turn.reconnectGraceTimer) return;
  clearTimeout(turn.reconnectGraceTimer);
  turn.reconnectGraceTimer = null;
}
