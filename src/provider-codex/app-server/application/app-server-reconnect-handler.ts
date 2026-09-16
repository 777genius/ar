import type { TurnState } from "./app-server-turn-state";

export function handleAppServerReconnectProgress(input: {
  readonly turnId: string | null;
  readonly message: string;
  readonly turns: () => Iterable<TurnState>;
  readonly findTurn: (turnId: string) => TurnState | null;
  readonly warn: (message: string) => void;
  readonly schedule: (turn: TurnState, message: string) => void;
}): void {
  const tracked = input.turnId === null ? null : input.findTurn(input.turnId);
  if (input.turnId !== null && !tracked) return;
  const turns = input.turnId === null ? [...input.turns()] : [tracked!];
  if (turns.length === 0) {
    input.warn(input.message);
    return;
  }
  for (const turn of turns) input.schedule(turn, input.message);
}
