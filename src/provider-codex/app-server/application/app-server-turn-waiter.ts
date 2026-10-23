import { AppServerUsageError } from "../domain/app-server-usage-error";
import type { AppServerWarning } from "../domain/app-server-types";
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

/** A turn abandoned before the provider completed it keeps running on the
 * shared process, which can outlive this run while its siblings drain. */
export function releaseAppServerTurn(input: {
  readonly turn: TurnState;
  readonly terminal: boolean;
  readonly interrupt: () => void;
  readonly warn: (warning: AppServerWarning) => void;
  readonly clear: () => void;
}): void {
  try {
    if (!input.turn.completed && !input.terminal) input.interrupt();
  } catch {
    // Best effort: the poisoned session's disposal still stops the turn.
    input.warn({
      code: "codex_app_server_turn_interrupt_failed",
      safeMessage: "Codex app-server turn interrupt could not be sent.",
    });
  } finally {
    input.clear();
  }
}
