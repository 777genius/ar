import { safeMessage } from "../domain/app-server-errors";

export type AppServerTurnFailurePhase =
  | "turn_start_rejected"
  | "turn_error_before_output"
  | "turn_error_after_output";

export type AppServerTurnFailureDetails = {
  readonly phase: AppServerTurnFailurePhase;
  readonly turnNumber: number;
  readonly outputObserved: boolean;
  readonly outputCharCount: number;
  readonly elapsedMs: number;
};

export class CodexAppServerTurnError extends Error {
  readonly code = "codex_app_server_turn_error" as const;
  readonly failureDetails: AppServerTurnFailureDetails;

  constructor(input: {
    readonly cause: unknown;
    readonly phase: AppServerTurnFailurePhase;
    readonly turnNumber: number | undefined;
    readonly outputText?: string;
    readonly elapsedMs: number;
  }) {
    const outputCharCount = boundedTurnMetric(input.outputText?.length ?? 0);
    const failureDetails: AppServerTurnFailureDetails = {
      phase: input.phase,
      turnNumber: boundedTurnNumber(input.turnNumber),
      outputObserved: outputCharCount > 0,
      outputCharCount,
      elapsedMs: boundedTurnMetric(input.elapsedMs),
    };
    super(
      `codex_app_server_turn_error:${safeMessage(input.cause)}:details=${JSON.stringify(
        failureDetails,
      )}`,
      { cause: input.cause },
    );
    this.name = "CodexAppServerTurnError";
    this.failureDetails = failureDetails;
  }

  details(): Readonly<Record<string, string>> {
    return {
      phase: this.failureDetails.phase,
      turnNumber: String(this.failureDetails.turnNumber),
      outputObserved: String(this.failureDetails.outputObserved),
      outputCharCount: String(this.failureDetails.outputCharCount),
      elapsedMs: String(this.failureDetails.elapsedMs),
    };
  }
}

export function turnFailureError(
  error: unknown,
  input: {
    readonly phase: AppServerTurnFailurePhase;
    readonly turnNumber: number | undefined;
    readonly outputText?: string;
    readonly elapsedMs: number;
  },
): CodexAppServerTurnError {
  if (error instanceof CodexAppServerTurnError) return error;
  return new CodexAppServerTurnError({
    cause: error,
    ...input,
  });
}

export function isExplicitTurnStartRejection(error: unknown): boolean {
  return error instanceof CodexAppServerTurnError &&
    error.failureDetails.phase === "turn_start_rejected";
}

function boundedTurnNumber(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(10_000, Math.trunc(value)));
}

function boundedTurnMetric(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(value)));
}
