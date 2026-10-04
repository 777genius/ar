import type { DependencyTreeIdentity, DependencyWorkspaceIdentity } from "./dependency-receipt";

export enum DependencyManifestEntryKind {
  Directory = "directory",
  File = "file",
  Symlink = "symlink",
}

// Paths are arrays of base64-encoded original filename bytes, including [] for
// the root. Display decoding must never be used for lookup or filesystem effects.
export type DependencyManifestEntry = {
  readonly path: readonly string[];
  readonly mode: number;
} & (
  | { readonly kind: DependencyManifestEntryKind.Directory }
  | { readonly kind: DependencyManifestEntryKind.File; readonly size: string; readonly sha256: string }
  | { readonly kind: DependencyManifestEntryKind.Symlink; readonly target: string }
);

export type DependencyTreeObservationLimits = {
  readonly maxEntries: number;
  readonly maxTotalBytes: number;
  readonly maxManifestBytes: number;
  readonly maxDurationMs: number;
};

export enum DependencyTreeObservationStatus {
  Complete = "complete",
  Incomplete = "incomplete",
}

export enum DependencyTreeObservationFailure {
  UnsupportedPlatform = "unsupported_platform",
  InvalidRequest = "invalid_request",
  UnsafeNamespace = "unsafe_namespace",
  IdentityChanged = "identity_changed",
  MountCrossing = "mount_crossing",
  SpecialFile = "special_file",
  Hardlink = "hardlink",
  ExternalSymlink = "external_symlink",
  Unstable = "unstable",
  Bounds = "bounds",
  Access = "access",
}

export type DependencyObservedEntryIdentity = {
  readonly path: readonly string[];
  readonly identity: DependencyTreeIdentity;
  readonly mountId: string;
};

// Content identity deliberately excludes inode, device, timestamps and mount
// IDs. Equal independent installs can share the protected content blob.
export type DependencyCapturedTreeObservation =
  | { readonly status: DependencyTreeObservationStatus.Complete;
      readonly workspace: DependencyWorkspaceIdentity; readonly tree: DependencyTreeIdentity;
      readonly mountId: string; readonly canonicalBytes: Uint8Array; readonly digest: string;
      readonly entries: readonly DependencyManifestEntry[];
      readonly identities: readonly DependencyObservedEntryIdentity[]; readonly totalBytes: string }
  | { readonly status: DependencyTreeObservationStatus.Incomplete;
      readonly reason: DependencyTreeObservationFailure };

export function encodeDependencyTreeManifest(entries: readonly DependencyManifestEntry[]): string {
  return JSON.stringify({ version: 1, entries: entries.map((entry) => {
    const base = { path: entry.path, kind: entry.kind, mode: entry.mode };
    switch (entry.kind) {
      case DependencyManifestEntryKind.Directory: return base;
      case DependencyManifestEntryKind.File: return { ...base, size: entry.size, sha256: entry.sha256 };
      case DependencyManifestEntryKind.Symlink: return { ...base, target: entry.target };
    }
  }) }) + "\n";
}
