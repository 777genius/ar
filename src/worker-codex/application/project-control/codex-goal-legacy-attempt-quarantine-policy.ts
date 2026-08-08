import type { StaleIntegrationReconciliationEntry } from
  "./codex-goal-stale-integration-reconciliation";

export const LEGACY_ATTEMPT_QUARANTINE_MINIMUM_STABLE_AGE_MS =
  24 * 60 * 60 * 1_000;

const expectedRefusalCounts = new Map<string, number>([
  ["target_workspace_dirty", 3],
  ["attempt_patch_partial_or_ambiguous", 7],
  ["patch_outside_reviewed_store", 5],
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
  if (input.entries.length !== 17) {
    throw new Error("legacy_attempt_quarantine_incident_count_mismatch");
  }
  const eligibleCount = input.entries.filter((entry) => entry.eligible).length;
  if (eligibleCount !== 2) {
    throw new Error("legacy_attempt_quarantine_eligible_count_mismatch");
  }
  const actualRefusalCounts = new Map<string, number>();
  for (const entry of input.entries) {
    if (!entry.eligible &&
      (!entry.refusalReason || !expectedRefusalCounts.has(entry.refusalReason))) {
      throw new Error("legacy_attempt_quarantine_refusal_not_allowed");
    }
    if (!entry.eligible) {
      actualRefusalCounts.set(
        entry.refusalReason!,
        (actualRefusalCounts.get(entry.refusalReason!) ?? 0) + 1,
      );
    }
  }
  for (const [reason, expected] of expectedRefusalCounts) {
    if (actualRefusalCounts.get(reason) !== expected) {
      throw new Error("legacy_attempt_quarantine_refusal_distribution_mismatch");
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
