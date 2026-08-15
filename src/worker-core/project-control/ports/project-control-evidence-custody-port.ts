export type ImmutableEvidenceFile = {
  readonly canonicalPath: string;
  readonly sha256: string;
  readonly length: number;
  readonly bytes: Uint8Array;
};

export type EvidenceDirectoryEntry = {
  readonly name: string;
  readonly kind: "file" | "directory" | "other";
};

export type ImmutablePatchEvidence = Omit<ImmutableEvidenceFile, "bytes"> & {
  readonly commits: readonly string[];
  readonly baseCommits: readonly string[];
  readonly changedPathPairs: readonly (readonly [string, string])[];
};

/** Host-filesystem effects required by project-control evidence use cases. */
export interface ProjectControlEvidenceCustodyPort {
  canonicalDirectory(path: string, allowMissing?: boolean): Promise<string>;
  readImmutableFile(path: string, maxBytes: number): Promise<ImmutableEvidenceFile>;
  inspectImmutablePatch(path: string, maxBytes: number): Promise<ImmutablePatchEvidence>;
  pathKind(path: string): Promise<"absent" | "file" | "directory" | "symlink" | "other">;
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
