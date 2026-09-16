const APP_SERVER_TURN_ERROR_PREFIX = "codex_app_server_turn_error:";
const APP_SERVER_TURN_ERROR_DETAILS_SEPARATOR = ":details=";
const APP_SERVER_TURN_ERROR_DETAIL_KEYS = [
  "elapsedMs",
  "outputCharCount",
  "outputObserved",
  "phase",
  "turnNumber",
] as const;
const APP_SERVER_TURN_ERROR_PHASES = new Set([
  "turn_start_rejected",
  "turn_error_before_output",
  "turn_error_after_output",
]);

export function directCodexAppServerFailureCause(rawCause: string): string {
  if (!rawCause.startsWith(APP_SERVER_TURN_ERROR_PREFIX)) return rawCause;
  const detailsAt = rawCause.lastIndexOf(
    APP_SERVER_TURN_ERROR_DETAILS_SEPARATOR,
  );
  if (detailsAt <= APP_SERVER_TURN_ERROR_PREFIX.length) return rawCause;
  try {
    const details: unknown = JSON.parse(
      rawCause.slice(detailsAt + APP_SERVER_TURN_ERROR_DETAILS_SEPARATOR.length),
    );
    if (!isAppServerTurnFailureDetails(details)) return rawCause;
  } catch {
    return rawCause;
  }
  return rawCause.slice(APP_SERVER_TURN_ERROR_PREFIX.length, detailsAt);
}

function isAppServerTurnFailureDetails(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const details = value as Record<string, unknown>;
  const keys = Object.keys(details).sort();
  const outputCharCount = details.outputCharCount;
  return (
    keys.length === APP_SERVER_TURN_ERROR_DETAIL_KEYS.length &&
    keys.every(
      (key, index) => key === APP_SERVER_TURN_ERROR_DETAIL_KEYS[index],
    ) &&
    typeof details.phase === "string" &&
    APP_SERVER_TURN_ERROR_PHASES.has(details.phase) &&
    safeIntegerInRange(details.turnNumber, 1, 10_000) &&
    typeof details.outputObserved === "boolean" &&
    typeof outputCharCount === "number" &&
    safeIntegerInRange(outputCharCount, 0, Number.MAX_SAFE_INTEGER) &&
    outputMatchesTurnFailurePhase(
      details.phase,
      details.outputObserved,
      outputCharCount,
    ) &&
    safeIntegerInRange(details.elapsedMs, 0, Number.MAX_SAFE_INTEGER)
  );
}

function outputMatchesTurnFailurePhase(
  phase: string,
  outputObserved: boolean,
  outputCharCount: number,
): boolean {
  return phase === "turn_error_after_output"
    ? outputObserved && outputCharCount > 0
    : !outputObserved && outputCharCount === 0;
}

function safeIntegerInRange(value: unknown, min: number, max: number): boolean {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= min &&
    (value as number) <= max
  );
}
