import type {
  ConsumedOutputLedgerEpochAdmissionSummary,
  ConsumedOutputLedgerEpochPlan,
} from "@vioxen/subscription-runtime/worker-core";

const SOCIAL_PROPOSED_ADMISSION_PLAN_SHA256 =
  "e8d9c821ddf973b11796b2780f2adb1b22760291650998dfb7b0f41ce7c1ea99";

export function assertConsumedOutputLedgerEpochAdmissionTransition(input: {
  readonly plan: ConsumedOutputLedgerEpochPlan;
  readonly before: ConsumedOutputLedgerEpochAdmissionSummary;
  readonly proposed: ConsumedOutputLedgerEpochAdmissionSummary;
}): void {
  if (input.plan.planSha256 === SOCIAL_PROPOSED_ADMISSION_PLAN_SHA256) {
    if (input.plan.projectId !== "social-monitor" || input.before.debtCount !== 1110) {
      throw new Error("ledger_epoch_proposed_admission_before_mismatch");
    }
    if (input.proposed.debtCount !== 2448 ||
      count(input.proposed, "unconsumedCompletedJobs") !== 495 ||
      count(input.proposed, "orphanLegacyWorkspaces") !== 205 ||
      count(input.proposed, "activeWriterConflicts") !== 6 ||
      count(input.proposed, "inactiveDirtyWorkspaces") !== 4 ||
      count(input.proposed, "unreadableWorkspaces") !== 0 ||
      count(input.proposed, "legacyOutputQuarantineRequired") !== 1738) {
      throw new Error("ledger_epoch_proposed_admission_summary_mismatch");
    }
    return;
  }
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
