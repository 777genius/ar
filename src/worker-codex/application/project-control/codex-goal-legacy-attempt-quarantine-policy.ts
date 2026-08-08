import type { StaleIntegrationReconciliationEntry } from
  "./codex-goal-stale-integration-reconciliation";

export const LEGACY_ATTEMPT_QUARANTINE_MINIMUM_STABLE_AGE_MS =
  24 * 60 * 60 * 1_000;

const allowedRefusalReasons = new Set([
  "target_workspace_dirty",
  "attempt_patch_partial_or_ambiguous",
  "patch_outside_reviewed_store",
]);

export function assertLegacyAttemptQuarantineIncidentPolicy(input: {
  readonly entries: readonly StaleIntegrationReconciliationEntry[];
  readonly cutoff: string;
  readonly now: Date;
}): void {
  const cutoffMs = Date.parse(input.cutoff);
  const nowMs = input.now.getTime();
  if (!Number.isFinite(cutoffMs) || !Number.isFinite(nowMs) ||
    cutoffMs >= nowMs ||
    cutoffMs > nowMs - LEGACY_ATTEMPT_QUARANTINE_MINIMUM_STABLE_AGE_MS) {
    throw new Error("legacy_attempt_quarantine_cutoff_not_stable");
  }
  for (const entry of input.entries) {
    if (!entry.eligible &&
      (!entry.refusalReason || !allowedRefusalReasons.has(entry.refusalReason))) {
      throw new Error("legacy_attempt_quarantine_refusal_not_allowed");
    }
  }
}

export function legacyAttemptQuarantineDispositionCounts(
  entries: readonly StaleIntegrationReconciliationEntry[],
): {
  readonly attemptCount: number;
  readonly reconciliationEvidenceBoundCount: number;
  readonly unresolvedEvidenceQuarantineCount: number;
} {
  const reconciliationEvidenceBoundCount = entries.filter(
    (entry) => entry.eligible,
  ).length;
  return {
    attemptCount: entries.length,
    reconciliationEvidenceBoundCount,
    unresolvedEvidenceQuarantineCount:
      entries.length - reconciliationEvidenceBoundCount,
  };
}
