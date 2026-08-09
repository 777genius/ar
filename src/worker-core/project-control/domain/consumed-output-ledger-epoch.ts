export const CONSUMED_OUTPUT_LEDGER_RETIRED_MARKER =
  ".consumed-output-ledger-retired.json";

export type ConsumedOutputLedgerEpochDisposition =
  | "migrate"
  | "quarantine"
  | "preserve_only";

export type ConsumedOutputLedgerEpochFilePlan = {
  readonly relativePath: string;
  readonly size: number;
  readonly sha256: string;
  readonly disposition: ConsumedOutputLedgerEpochDisposition;
  readonly quarantineReason?:
    | "invalid_json"
    | "invalid_or_missing_evidence"
    | "legacy_before_cutoff";
};

export type ConsumedOutputLedgerEpochEvidenceBinding = {
  readonly declaredPath: string;
  readonly state: "file" | "directory" | "missing" | "denied" | "symlink";
  readonly canonicalPath?: string;
  readonly size?: number;
  readonly sha256?: string;
};

export type ConsumedOutputLedgerEpochOrphanWorkspaceBinding = {
  readonly declaredPath: string;
  readonly state: "quarantined" | "denied";
  readonly canonicalPath?: string;
  readonly device?: number;
  readonly inode?: number;
  readonly headSha?: string;
  readonly statusSha256?: string;
  readonly statusSize?: number;
  readonly trackedDiffSha256?: string;
  readonly trackedDiffSize?: number;
  readonly untrackedFileCount?: number;
  readonly contentSha256?: string;
  readonly statusPreview?: readonly string[];
};

export type ConsumedOutputLedgerEpochLegacyAttemptQuarantineAnchor = {
  readonly schemaVersion: 1;
  readonly planSha256: string;
  readonly quarantineRootSha256: string;
  readonly receiptSha256: string;
  readonly attemptCount: number;
  readonly reconciliationEvidenceBoundCount: number;
  readonly unresolvedEvidenceQuarantineCount: number;
};

export type ConsumedOutputLedgerEpochLegacyAdmissionAnchor = {
  readonly schemaVersion: 1;
  readonly debtCount: 710;
  readonly blockingDebtCount: number;
  readonly categoryCounts: Readonly<Record<string, number>>;
  readonly debtSha256: string;
  readonly subjectsSha256: string;
  readonly cutoff: string;
  readonly processInventorySha256: string;
  readonly inspectedPidCount: number;
  readonly processCustodyPathsSha256: string;
  readonly processCustodyPaths: readonly string[];
};

export type ConsumedOutputLedgerEpochPlan = {
  readonly schemaVersion: 1;
  /** Absent only for immutable v1 roots created before transactional intents. */
  readonly transactionVersion?: 2;
  readonly controllerJobId: string;
  readonly projectId: string;
  readonly oldRoot: string;
  readonly newRoot: string;
  readonly cutoff: string;
  readonly oldRootHash: string;
  readonly oldRootFileCount: number;
  readonly oldRootDevice: number;
  readonly oldRootInode: number;
  readonly newRootParentDevice: number;
  readonly newRootParentInode: number;
  readonly epochNumber: number;
  readonly genesisOldRootHash: string;
  readonly previousEpochPlanSha256?: string;
  readonly controllerManifestSha256: string;
  readonly controllerStableScopeSha256: string;
  readonly registryJobIdsSha256: string;
  readonly registryJobCount: number;
  readonly migratedCount: number;
  readonly quarantinedCount: number;
  readonly inheritedQuarantinedCount: number;
  readonly deniedRoots: readonly string[];
  readonly evidenceBindings: readonly ConsumedOutputLedgerEpochEvidenceBinding[];
  readonly orphanWorkspaceBindings:
    readonly ConsumedOutputLedgerEpochOrphanWorkspaceBinding[];
  readonly legacyAttemptQuarantine?:
    ConsumedOutputLedgerEpochLegacyAttemptQuarantineAnchor;
  readonly legacyAdmission?: ConsumedOutputLedgerEpochLegacyAdmissionAnchor;
  readonly files: readonly ConsumedOutputLedgerEpochFilePlan[];
  readonly planSha256: string;
};

export type ConsumedOutputLedgerEpochAdmissionSummary = {
  readonly debtCount: number;
  readonly counts?: Readonly<Record<string, number>>;
};

export type ConsumedOutputLedgerEpochReceipt = {
  readonly schemaVersion: 1;
  readonly status: "active";
  readonly controllerJobId: string;
  readonly projectId: string;
  readonly oldRoot: string;
  readonly newRoot: string;
  readonly cutoff: string;
  readonly oldRootHash: string;
  readonly oldRootFileCount: number;
  readonly epochNumber: number;
  readonly genesisOldRootHash: string;
  readonly previousEpochPlanSha256?: string;
  readonly migratedCount: number;
  readonly quarantinedCount: number;
  readonly inheritedQuarantinedCount: number;
  readonly deniedRoots: readonly string[];
  readonly orphanWorkspaceBindings:
    readonly ConsumedOutputLedgerEpochOrphanWorkspaceBinding[];
  readonly legacyAttemptQuarantine?:
    ConsumedOutputLedgerEpochLegacyAttemptQuarantineAnchor;
  readonly legacyAdmission?: ConsumedOutputLedgerEpochLegacyAdmissionAnchor;
  readonly planSha256: string;
  readonly transactionUpgradeSha256?: string;
  readonly proposedAdmissionAnchorSha256?: string;
  readonly createdAt: string;
  readonly activatedAt: string;
  readonly admissionBefore: ConsumedOutputLedgerEpochAdmissionSummary;
  readonly admissionAfter: ConsumedOutputLedgerEpochAdmissionSummary;
};

export type ConsumedOutputLedgerEpochState = {
  readonly schemaVersion: 1;
  readonly phase: "prepared" | "scope_switched" | "receipt_prepared" | "active";
  readonly ownerToken: string;
  readonly planSha256: string;
  readonly admissionBefore: ConsumedOutputLedgerEpochAdmissionSummary;
  readonly receipt?: ConsumedOutputLedgerEpochReceipt;
  readonly receiptSha256?: string;
};
