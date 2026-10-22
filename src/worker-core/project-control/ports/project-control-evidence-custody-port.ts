import type {
  ProjectControlRecoveryDirectoryIdentity,
  ProjectControlRecoveryPendingDirectory,
} from "../domain/project-control-recovery";

/** All callbacks complete only after their journal checkpoint is durable. */
export interface ProjectControlCustodyMaterializationRecovery {
  readonly operationId: string;
  readonly identities: readonly ProjectControlRecoveryDirectoryIdentity[];
  readonly pendingDirectory?: ProjectControlRecoveryPendingDirectory;
  revalidate(): Promise<void>;
  prepare(directory: ProjectControlRecoveryPendingDirectory): Promise<void>;
  applied(directory: ProjectControlRecoveryDirectoryIdentity): Promise<void>;
}

export type ImmutableEvidenceFile = {
  readonly canonicalPath: string;
  readonly sha256: string;
  readonly length: number;
  readonly bytes: Uint8Array;
  /** Permission bits (mode & 0o777) read from the same held descriptor as the bytes. */
  readonly mode: number;
};

export type EvidenceDirectoryEntry = {
  readonly name: string;
  readonly kind: "file" | "directory" | "symlink" | "other";
};

export type EvidencePathKind =
  | "absent"
  | "file"
  | "directory"
  | "symlink"
  | "other";

export interface EvidenceDirectoryInspection {
  readonly canonicalPath: string;
  pathKind(entryName: string): Promise<EvidencePathKind>;
  close(): Promise<void>;
}

/**
 * A held certification for newly configured project-control custody roots.
 * Callers must revalidate it immediately before publishing the scope that
 * makes these paths authoritative, then close it in all cases.
 */
export interface ProjectControlCustodyBootstrapCertification {
  readonly approvedAnchor: string;
  readonly ledgerRoots: readonly string[];
  readonly evidenceRoots: readonly string[];
  revalidate(): Promise<void>;
  close(): Promise<void>;
}

export type ImmutablePatchEvidence = Omit<ImmutableEvidenceFile, "bytes" | "mode"> & {
  readonly commits: readonly string[];
  readonly baseCommits: readonly string[];
  readonly changedPathPairs: readonly (readonly [string, string])[];
};

/** Host-filesystem effects required by project-control evidence use cases. */
export interface ProjectControlEvidenceCustodyPort {
  materializeApprovedProjectControlCustody(input: {
    readonly approvedAnchor: string;
    readonly ledgerRoots: readonly string[];
    readonly evidenceRoots: readonly string[];
    readonly deniedRoots: readonly string[];
    readonly recovery?: ProjectControlCustodyMaterializationRecovery;
  }): Promise<ProjectControlCustodyBootstrapCertification>;
  canonicalDirectory(path: string, allowMissing?: boolean): Promise<string>;
  readImmutableFile(path: string, maxBytes: number): Promise<ImmutableEvidenceFile>;
  /**
   * Like readImmutableFile, but a missing leaf yields undefined. Absence is accepted
   * only beneath a held, canonical, non-symlink ancestor chain; a missing, dangling
   * or aliased parent, or a symlink leaf, refuses instead of reading as absent.
   */
  readOptionalImmutableFile(path: string, maxBytes: number): Promise<ImmutableEvidenceFile | undefined>;
  inspectImmutablePatch(path: string, maxBytes: number): Promise<ImmutablePatchEvidence>;
  pathKind(path: string): Promise<EvidencePathKind>;
  openDirectoryForInspection(path: string): Promise<EvidenceDirectoryInspection>;
  listDirectory(path: string): Promise<readonly EvidenceDirectoryEntry[]>;
  publishImmutableBytes(input: {
    readonly root: string;
    readonly directories: readonly string[];
    readonly fileName: string;
    readonly bytes: Uint8Array;
    readonly expectedSha256: string;
  }): Promise<{ readonly path: string; readonly created: boolean }>;
  copyImmutableFile(input: {
    readonly sourcePath: string;
    readonly expectedSha256: string;
    readonly expectedLength: number;
    readonly maxBytes: number;
    readonly root: string;
    readonly directories: readonly string[];
    readonly fileName: string;
  }): Promise<{ readonly path: string; readonly created: boolean }>;
}
