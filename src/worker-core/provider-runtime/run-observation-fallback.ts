import {
  decideRunObservation,
  type RunObservationSnapshot,
} from "../run-observability";
import type { RunEventProviderKind } from "../run-provider-kind";

/**
 * Neutral read-only snapshot for a run that failed observation and has no
 * provider-specific fallback (e.g. orphan-artifact handling). Mirrors the shape
 * historically produced by the bespoke Claude watch path.
 */
export function providerFailedRunObservationSnapshot(input: {
  readonly runId: string;
  readonly providerKind: RunEventProviderKind;
  readonly error: unknown;
}): RunObservationSnapshot {
  const message = input.error instanceof Error
    ? input.error.message
    : String(input.error);
  const warnings = [{
    code: "run_observation_failed",
    message,
    severity: "warning" as const,
  }];
  const manualReviewReasons = ["run_observation_failed"];
  return {
    runId: input.runId,
    providerKind: input.providerKind,
    observedAt: new Date().toISOString(),
    status: "unknown",
    liveness: "unknown",
    warnings,
    manualReviewReasons,
    readOnlyDecision: decideRunObservation({
      status: "unknown",
      liveness: "unknown",
      manualReviewReasons,
      warnings,
    }),
  };
}
