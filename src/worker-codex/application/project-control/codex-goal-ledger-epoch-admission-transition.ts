import type {
  ConsumedOutputLedgerEpochAdmissionSummary,
  ConsumedOutputLedgerEpochPlan,
} from "@vioxen/subscription-runtime/worker-core";

export function assertConsumedOutputLedgerEpochAdmissionTransition(input: {
  readonly plan: ConsumedOutputLedgerEpochPlan;
  readonly before: ConsumedOutputLedgerEpochAdmissionSummary;
  readonly proposed: ConsumedOutputLedgerEpochAdmissionSummary;
}): void {
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

function count(
  summary: ConsumedOutputLedgerEpochAdmissionSummary,
  key: string,
): number {
  return summary.counts?.[key] ?? 0;
}
