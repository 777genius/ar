/** Recovery is an explicit write operation; reads never reconcile journals. */
export enum ProjectControlRecoveryPhase {
  Prepared = "prepared",
  Materialized = "materialized",
  Committed = "committed",
}

export enum ProjectControlRecoveryOutcome {
  Committed = "committed",
  PartialSuccess = "partial_success",
}

export enum ProjectControlRecoveryOperation {
  ControllerScope = "controller_scope",
}

export enum ProjectControlRecoveryAuditPhase {
  Requested = "requested",
  Applied = "applied",
}

export interface ProjectControlRecoveryDirectoryIdentity {
  readonly path: string;
  readonly device: number;
  readonly inode: number;
}

/** A durable inode allocated before it is linked at the authorized final path. */
export interface ProjectControlRecoveryPendingDirectory extends ProjectControlRecoveryDirectoryIdentity {
  readonly stagingPath: string;
}

/** Hashes bind reconciliation to the exact authorized before/after manifests. */
export interface ProjectControlRecoveryRecord {
  readonly operationId: string;
  readonly operation: ProjectControlRecoveryOperation;
  readonly phase: ProjectControlRecoveryPhase;
  readonly controllerJobId: string;
  readonly beforeManifestSha256: string;
  readonly afterManifestSha256: string;
  readonly proposedScopeSha256: string;
  readonly at: string;
  readonly identities: readonly ProjectControlRecoveryDirectoryIdentity[];
  readonly pendingDirectory?: ProjectControlRecoveryPendingDirectory;
  readonly approvedAnchor?: string;
}
