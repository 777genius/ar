import { createHash } from "node:crypto";
import type {
  ConsumedOutputLedgerEpochLegacyAdmissionAnchor,
  ConsumedOutputLedgerEpochFilePlan,
  ProjectAdmissionSnapshot,
  ProjectDebtItem,
} from "@vioxen/subscription-runtime/worker-core";

const APPROVED_COUNTS = {
  active_writer_conflict: 6,
  inactive_dirty_workspace: 4,
  orphan_legacy_workspace: 205,
  unconsumed_completed_job: 495,
} as const;
export const APPROVED_LEGACY_ADMISSION_DEBT_COUNT = 710;

export function buildLedgerEpochLegacyAdmissionAnchor(input: {
  readonly snapshot: ProjectAdmissionSnapshot;
  readonly cutoff: string;
  readonly processEvidence?: {
    readonly inventorySha256: string;
    readonly inspectedPidCount: number;
    readonly custodyPaths: readonly string[];
    readonly blockers: readonly unknown[];
  };
}): ConsumedOutputLedgerEpochLegacyAdmissionAnchor | undefined {
  const blocking = input.snapshot.debt.filter(isBlockingDebt);
  if (blocking.length === 0) return undefined;
  const observedCounts = debtCategoryCounts(input.snapshot.debt);
  const legacyCandidate = Object.entries(APPROVED_COUNTS).some(
    ([reason, count]) => (observedCounts[reason] ?? 0) >= count - 1,
  );
  if (!legacyCandidate) {
    return undefined;
  }
  if (input.snapshot.debt.length !== APPROVED_LEGACY_ADMISSION_DEBT_COUNT ||
    JSON.stringify(observedCounts) !== JSON.stringify(APPROVED_COUNTS) ||
    blocking.length !== 710
  ) {
    throw new Error("ledger_epoch_legacy_admission_exact_count_mismatch");
  }
  const debt = canonicalDebt(input.snapshot.debt);
  const processEvidence = input.processEvidence;
  if (!processEvidence || processEvidence.blockers.length !== 0 ||
    !/^[a-f0-9]{64}$/.test(processEvidence.inventorySha256) ||
    !Number.isSafeInteger(processEvidence.inspectedPidCount)
  ) throw new Error("ledger_epoch_legacy_admission_process_evidence_required");
  return {
    schemaVersion: 1,
    debtCount: APPROVED_LEGACY_ADMISSION_DEBT_COUNT,
    blockingDebtCount: blocking.length,
    categoryCounts: observedCounts,
    debtSha256: sha256Json(debt),
    subjectsSha256: sha256Json(debt.map((item) => item.subject).sort()),
    cutoff: normalizedCutoff(input.cutoff),
    processInventorySha256: processEvidence.inventorySha256,
    inspectedPidCount: processEvidence.inspectedPidCount,
    processCustodyPathsSha256: sha256Json(processEvidence.custodyPaths),
    processCustodyPaths: [...processEvidence.custodyPaths],
  };
}

function debtCategoryCounts(
  debt: readonly ProjectDebtItem[],
): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const item of debt) counts[item.reason] = (counts[item.reason] ?? 0) + 1;
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function assertLedgerEpochLegacyAdmissionUnchanged(input: {
  readonly expected: ConsumedOutputLedgerEpochLegacyAdmissionAnchor;
  readonly snapshot: ProjectAdmissionSnapshot;
}): void {
  let current: ConsumedOutputLedgerEpochLegacyAdmissionAnchor | undefined;
  try {
    current = buildLedgerEpochLegacyAdmissionAnchor({
      snapshot: input.snapshot,
      cutoff: input.expected.cutoff,
      processEvidence: {
        inventorySha256: input.expected.processInventorySha256,
        inspectedPidCount: input.expected.inspectedPidCount,
        custodyPaths: [],
        blockers: [],
      },
    });
  } catch {
    throw new Error("ledger_epoch_legacy_admission_drift");
  }
  if (!current || current.debtSha256 !== input.expected.debtSha256 ||
    current.subjectsSha256 !== input.expected.subjectsSha256 ||
    current.debtCount !== input.expected.debtCount ||
    JSON.stringify(current.categoryCounts) !==
      JSON.stringify(input.expected.categoryCounts)) {
    throw new Error("ledger_epoch_legacy_admission_drift");
  }
}

export function ledgerEpochLegacyAdmissionPlanCounts(input: {
  readonly anchor: ConsumedOutputLedgerEpochLegacyAdmissionAnchor | undefined;
  readonly files: readonly ConsumedOutputLedgerEpochFilePlan[];
  readonly orphanWorkspaceCount: number;
}): { readonly migratedCount: number; readonly quarantinedCount: number } {
  const migratedCount = input.files.filter((file) =>
    file.disposition === "migrate"
  ).length;
  const quarantinedCount = input.files.filter((file) =>
    file.disposition === "quarantine"
  ).length;
  if (input.anchor && (migratedCount !== 495 ||
    quarantinedCount !== 209 || input.orphanWorkspaceCount !== 205
  )) throw new Error("ledger_epoch_legacy_admission_plan_count_mismatch");
  return { migratedCount, quarantinedCount };
}

function canonicalDebt(debt: readonly ProjectDebtItem[]): readonly ProjectDebtItem[] {
  return debt.map((item) => ({
    reason: item.reason,
    subject: item.subject,
    severity: item.severity ?? "blocking",
    evidence: [...item.evidence],
    ...(item.affectedPaths
      ? { affectedPaths: [...item.affectedPaths].sort() }
      : {}),
    ...(item.pathDisjointProducerEligible
      ? { pathDisjointProducerEligible: true as const }
      : {}),
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function isBlockingDebt(item: ProjectDebtItem): boolean {
  return item.severity !== "info" && item.severity !== "warning";
}

function normalizedCutoff(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error("ledger_epoch_cutoff_invalid");
  return new Date(time).toISOString();
}

function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
