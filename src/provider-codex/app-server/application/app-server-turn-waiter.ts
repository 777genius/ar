import { AppServerUsageError } from "../domain/app-server-usage-error";
import type { TurnState } from "./app-server-turn-state";

export function waitForAppServerTurn(input: {
  readonly turn: TurnState;
  readonly turnId: string;
  readonly timeoutMs: number;
  readonly abortSignal: AbortSignal;
  readonly register: () => void;
  readonly clear: () => void;
}): Promise<TurnState> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let waiter: (state: TurnState) => void;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      input.abortSignal.removeEventListener("abort", abort);
      const waiterIndex = input.turn.waiters.indexOf(waiter);
      if (waiterIndex >= 0) input.turn.waiters.splice(waiterIndex, 1);
      input.clear();
    };
    const rejectWith = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new AppServerUsageError(error, input.turn.usage));
    };
    const abort = () =>
      rejectWith(new Error(`codex_app_server_turn_aborted:${input.turnId}`));
    timer = setTimeout(() => {
      rejectWith(new Error(`codex_app_server_turn_timeout:${input.turnId}`));
    }, input.timeoutMs);
    waiter = (state) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(state);
    };
    input.turn.waiters.push(waiter);
    input.register();
    input.abortSignal.addEventListener("abort", abort, { once: true });
    if (input.abortSignal.aborted) abort();
  });
}
