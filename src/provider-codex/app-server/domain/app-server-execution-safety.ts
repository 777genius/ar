import { safeMessage } from "./app-server-errors";
import { AppServerUsageError } from "./app-server-usage-error";

/**
 * Marks a request whose bytes were accepted by the app-server transport.  A
 * later timeout or transport failure cannot prove that the provider did not
 * receive it, so callers must not replay work through another engine.
 */
export class AppServerRequestMayHaveReachedProviderError extends Error {
  constructor(error: unknown, readonly method: string) {
    super(safeMessage(error), { cause: error });
    this.name = "AppServerRequestMayHaveReachedProviderError";
  }
}

/** Marks a turn after app-server acknowledged its start. */
export class AppServerExecutionMayHaveStartedError extends Error {
  constructor(error: unknown) {
    super(safeMessage(error), { cause: error });
    this.name = "AppServerExecutionMayHaveStartedError";
  }
}

export function isAppServerExecutionReplayUnsafe(error: unknown): boolean {
  const seen = new Set<Error>();
  while (error instanceof Error && !seen.has(error)) {
    if (
      error instanceof AppServerRequestMayHaveReachedProviderError ||
      error instanceof AppServerExecutionMayHaveStartedError ||
      (error instanceof AppServerUsageError && error.executionMayHaveStarted)
    ) {
      return true;
    }
    seen.add(error);
    error = error.cause;
  }
  return false;
}
