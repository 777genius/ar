import type {
  ConsumedOutputLedgerEpochAdmissionSummary,
  ConsumedOutputLedgerEpochPlan,
} from "@vioxen/subscription-runtime/worker-core";

export function assertConsumedOutputLedgerEpochAdmissionTransition(input: {
  readonly plan: ConsumedOutputLedgerEpochPlan;
  readonly before: ConsumedOutputLedgerEpochAdmissionSummary;
  readonly proposed: ConsumedOutputLedgerEpochAdmissionSummary;
}): void {
  if (input.plan.legacyAdmission) {
    assertExactLegacyAdmissionCounts(input.before, {
      activeWriterConflicts: 6,
      inactiveDirtyWorkspaces: 4,
      orphanLegacyWorkspaces: 205,
      unconsumedCompletedJobs: 495,
    });
  }
  const expectedQuarantine = input.plan.inheritedQuarantinedCount +
    input.plan.quarantinedCount +
    input.plan.orphanWorkspaceBindings.filter((binding) =>
      binding.state === "quarantined"
    ).length;
  if (count(input.proposed, "legacyOutputQuarantineRequired") !== expectedQuarantine) {
    throw new Error("ledger_epoch_proposed_admission_quarantine_count_mismatch");
  }
  if (count(input.proposed, "consumedDirtyWorkspaces") !==
    count(input.before, "consumedDirtyWorkspaces")) {
    throw new Error("ledger_epoch_proposed_admission_consumed_debt_drift");
  }
  for (const key of [
    "orphanLegacyWorkspaces",
    "incompleteConsumedOutputRecords",
    "retentionEvidenceMissing",
  ]) {
    if (count(input.proposed, key) !== 0) {
      throw new Error(`ledger_epoch_proposed_admission_blocking_debt:${key}`);
    }
  }
}

function assertExactLegacyAdmissionCounts(
  summary: ConsumedOutputLedgerEpochAdmissionSummary,
  expected: Readonly<Record<string, number>>,
): void {
  if (summary.debtCount !== 710 || Object.entries(expected).some(
    ([key, value]) => count(summary, key) !== value
  )) throw new Error("ledger_epoch_legacy_admission_summary_mismatch");
}

function count(
  summary: ConsumedOutputLedgerEpochAdmissionSummary,
  key: string,
): number {
  return summary.counts?.[key] ?? 0;
}
