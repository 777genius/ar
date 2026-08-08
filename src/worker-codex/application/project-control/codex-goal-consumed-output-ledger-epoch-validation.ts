import { readFile } from "node:fs/promises";
import { isAbsolute, normalize, sep } from "node:path";
import type {
  ConsumedOutputLedgerEpochEvidenceBinding,
  ConsumedOutputLedgerEpochFilePlan,
  ConsumedOutputLedgerEpochOrphanWorkspaceBinding,
  ConsumedOutputLedgerEpochPlan,
  ConsumedOutputLedgerEpochReceipt,
  ConsumedOutputLedgerEpochState,
} from "@vioxen/subscription-runtime/worker-core";

export async function assertEpochArtifactsAbsent(
  paths: readonly string[],
): Promise<void> {
  for (const path of paths) {
    try {
      await readFile(path);
      throw new Error("ledger_epoch_partial_artifacts");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) continue;
      throw error;
    }
  }
}

export function isEpochReceipt(
  value: unknown,
): value is ConsumedOutputLedgerEpochReceipt {
  if (!isRecord(value)) return false;
  return value.schemaVersion === 1 && value.status === "active" &&
    typeof value.controllerJobId === "string" &&
    typeof value.projectId === "string" &&
    typeof value.oldRoot === "string" && typeof value.newRoot === "string" &&
    typeof value.cutoff === "string" && isSha256(value.oldRootHash) &&
    nonNegativeInteger(value.epochNumber) && value.epochNumber > 0 &&
    isSha256(value.genesisOldRootHash) &&
    (value.previousEpochPlanSha256 === undefined ||
      isSha256(value.previousEpochPlanSha256)) &&
    isSha256(value.planSha256) && nonNegativeInteger(value.oldRootFileCount) &&
    nonNegativeInteger(value.migratedCount) &&
    nonNegativeInteger(value.quarantinedCount) &&
    nonNegativeInteger(value.inheritedQuarantinedCount) &&
    Array.isArray(value.deniedRoots) &&
    value.deniedRoots.every((root) => typeof root === "string") &&
    Array.isArray(value.orphanWorkspaceBindings) &&
    value.orphanWorkspaceBindings.every(isEpochOrphanWorkspaceBinding) &&
    (value.legacyAttemptQuarantine === undefined ||
      isLegacyAttemptQuarantineAnchor(value.legacyAttemptQuarantine)) &&
    typeof value.createdAt === "string" && Number.isFinite(Date.parse(value.createdAt)) &&
    typeof value.activatedAt === "string" &&
    Number.isFinite(Date.parse(value.activatedAt)) &&
    isAdmissionSummary(value.admissionBefore) &&
    isAdmissionSummary(value.admissionAfter);
}

export function isEpochState(value: unknown): value is ConsumedOutputLedgerEpochState {
  if (!isRecord(value) || value.schemaVersion !== 1 ||
    !(value.phase === "prepared" || value.phase === "scope_switched" ||
      value.phase === "receipt_prepared" || value.phase === "active") ||
    typeof value.ownerToken !== "string" || !isSha256(value.planSha256) ||
    !isAdmissionSummary(value.admissionBefore)
  ) return false;
  return value.phase === "receipt_prepared" || value.phase === "active"
    ? isEpochReceipt(value.receipt) && isSha256(value.receiptSha256)
    : value.receipt === undefined && value.receiptSha256 === undefined;
}

export function isEpochPlan(value: unknown): value is ConsumedOutputLedgerEpochPlan {
  if (!isRecord(value) || value.schemaVersion !== 1 ||
    !Array.isArray(value.evidenceBindings) ||
    !Array.isArray(value.orphanWorkspaceBindings) || !Array.isArray(value.files)
  ) return false;
  const valid = typeof value.controllerJobId === "string" &&
    typeof value.projectId === "string" &&
    typeof value.oldRoot === "string" && typeof value.newRoot === "string" &&
    typeof value.cutoff === "string" && Number.isFinite(Date.parse(value.cutoff)) &&
    isSha256(value.oldRootHash) && isSha256(value.planSha256) &&
    nonNegativeInteger(value.oldRootFileCount) &&
    nonNegativeInteger(value.oldRootDevice) && nonNegativeInteger(value.oldRootInode) &&
    nonNegativeInteger(value.newRootParentDevice) &&
    nonNegativeInteger(value.newRootParentInode) &&
    nonNegativeInteger(value.epochNumber) && value.epochNumber > 0 &&
    isSha256(value.genesisOldRootHash) &&
    (value.previousEpochPlanSha256 === undefined ||
      isSha256(value.previousEpochPlanSha256)) &&
    isSha256(value.controllerManifestSha256) &&
    isSha256(value.controllerStableScopeSha256) &&
    isSha256(value.registryJobIdsSha256) &&
    nonNegativeInteger(value.registryJobCount) &&
    nonNegativeInteger(value.migratedCount) &&
    nonNegativeInteger(value.quarantinedCount) &&
    nonNegativeInteger(value.inheritedQuarantinedCount) &&
    Array.isArray(value.deniedRoots) &&
    value.deniedRoots.every((root) => typeof root === "string") &&
    value.evidenceBindings.every(isEpochEvidenceBinding) &&
    value.orphanWorkspaceBindings.every(isEpochOrphanWorkspaceBinding) &&
    (value.legacyAttemptQuarantine === undefined ||
      isLegacyAttemptQuarantineAnchor(value.legacyAttemptQuarantine)) &&
    value.files.every(isEpochFilePlan);
  if (!valid) return false;
  return value.oldRootFileCount === value.files.length &&
    value.migratedCount === value.files.filter((file) =>
      isRecord(file) && file.disposition === "migrate"
    ).length &&
    value.quarantinedCount === value.files.filter((file) =>
      isRecord(file) && file.disposition === "quarantine"
    ).length;
}

function isLegacyAttemptQuarantineAnchor(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return value.schemaVersion === 1 && isSha256(value.planSha256) &&
    isSha256(value.quarantineRootSha256) && isSha256(value.receiptSha256) &&
    nonNegativeInteger(value.attemptCount) && value.attemptCount > 0 &&
    nonNegativeInteger(value.reconciliationEvidenceBoundCount) &&
    nonNegativeInteger(value.unresolvedEvidenceQuarantineCount) &&
    value.attemptCount === value.reconciliationEvidenceBoundCount +
      value.unresolvedEvidenceQuarantineCount;
}

function isEpochOrphanWorkspaceBinding(
  value: unknown,
): value is ConsumedOutputLedgerEpochOrphanWorkspaceBinding {
  if (!isRecord(value) || typeof value.declaredPath !== "string" ||
    !["quarantined", "denied"].includes(String(value.state)) ||
    (value.canonicalPath !== undefined && typeof value.canonicalPath !== "string")
  ) return false;
  if (value.state === "denied") {
    return value.device === undefined && value.inode === undefined &&
      value.headSha === undefined && value.statusSha256 === undefined &&
      value.contentSha256 === undefined && value.statusPreview === undefined;
  }
  return typeof value.canonicalPath === "string" &&
    nonNegativeInteger(value.device) && nonNegativeInteger(value.inode) &&
    typeof value.headSha === "string" && /^[a-f0-9]{40,64}$/.test(value.headSha) &&
    isSha256(value.statusSha256) && nonNegativeInteger(value.statusSize) &&
    isSha256(value.trackedDiffSha256) &&
    nonNegativeInteger(value.trackedDiffSize) &&
    nonNegativeInteger(value.untrackedFileCount) &&
    isSha256(value.contentSha256) && Array.isArray(value.statusPreview) &&
    value.statusPreview.every((entry) => typeof entry === "string");
}

function isEpochEvidenceBinding(
  value: unknown,
): value is ConsumedOutputLedgerEpochEvidenceBinding {
  if (!isRecord(value) || typeof value.declaredPath !== "string" ||
    !["file", "directory", "missing", "denied", "symlink"].includes(
      String(value.state),
    ) || (value.canonicalPath !== undefined && typeof value.canonicalPath !== "string")
  ) return false;
  if (value.state === "file") {
    return typeof value.canonicalPath === "string" &&
      nonNegativeInteger(value.size) && isSha256(value.sha256);
  }
  return value.size === undefined && value.sha256 === undefined;
}

function isEpochFilePlan(value: unknown): value is ConsumedOutputLedgerEpochFilePlan {
  if (!isRecord(value) || typeof value.relativePath !== "string" ||
    value.relativePath === "" || isAbsolute(value.relativePath) ||
    normalize(value.relativePath) !== value.relativePath ||
    value.relativePath === ".." || value.relativePath.startsWith(`..${sep}`) ||
    !nonNegativeInteger(value.size) || !isSha256(value.sha256) ||
    !["migrate", "quarantine", "preserve_only"].includes(String(value.disposition))
  ) return false;
  const reasons = ["invalid_json", "invalid_or_missing_evidence", "legacy_before_cutoff"];
  return value.disposition === "quarantine"
    ? reasons.includes(String(value.quarantineReason))
    : value.quarantineReason === undefined;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isAdmissionSummary(value: unknown): boolean {
  if (!isRecord(value) || !nonNegativeInteger(value.debtCount)) return false;
  if (value.counts === undefined) return true;
  return isRecord(value.counts) && Object.values(value.counts).every(
    nonNegativeInteger,
  );
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}
