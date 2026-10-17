/** Full captured-manifest diagnostics only. No install, receipt publication,
 * baseline minting, admission, eviction or future-reference authority. The
 * original registered producer remains the ONLY LegacyCompared publisher. */
import { DependencyTreeObservationStatus as Observed,
  DependencyManifestEntryKind as Kind, type DependencyCapturedTreeObservation,
  type DependencyManifestEntry }
  from "../../dist/worker-core/dependency-environment/domain/dependency-tree-manifest.js";

export enum LegacyManifestComparison {
  MatchFactsOnly = "match_facts_only", PreserveMismatch = "preserve_mismatch",
  PreserveIncomplete = "preserve_incomplete", PreserveNotIndependent = "preserve_not_independent",
  PreserveChanged = "preserve_changed",
}
type Complete = Extract<DependencyCapturedTreeObservation, { status: Observed.Complete }>;
export type LegacyDifferenceCounts = {
  readonly added: number; readonly missing: number; readonly kinds: number;
  readonly modes: number; readonly fileBytes: number; readonly symlinkTargets: number;
};
const noAuthority = { legacyComparedPublished: false, deletionAuthority: false } as const;
const equalBytes = (a: Uint8Array, b: Uint8Array): boolean => Buffer.from(a).equals(Buffer.from(b));
const sameCapture = (a: Complete, b: Complete): boolean =>
  a.workspace.canonicalPath === b.workspace.canonicalPath && a.workspace.dev === b.workspace.dev &&
  a.workspace.ino === b.workspace.ino && a.tree.dev === b.tree.dev && a.tree.ino === b.tree.ino &&
  a.mountId === b.mountId && a.digest === b.digest && equalBytes(a.canonicalBytes, b.canonicalBytes);

function differences(original: readonly DependencyManifestEntry[], reference: readonly DependencyManifestEntry[]): LegacyDifferenceCounts {
  // Lossless segment arrays are keys only. Never decode them into FS paths.
  const left = new Map(original.map(entry => [JSON.stringify(entry.path), entry]));
  const right = new Map(reference.map(entry => [JSON.stringify(entry.path), entry]));
  let added = 0, missing = 0, kinds = 0, modes = 0, fileBytes = 0, symlinkTargets = 0;
  for (const [path, entry] of left) {
    const other = right.get(path);
    if (!other) { ++added; continue; }
    if (entry.kind !== other.kind) ++kinds;
    if (entry.mode !== other.mode) ++modes;
    if (entry.kind === Kind.File && other.kind === Kind.File &&
        (entry.size !== other.size || entry.sha256 !== other.sha256)) ++fileBytes;
    if (entry.kind === Kind.Symlink && other.kind === Kind.Symlink && entry.target !== other.target) ++symlinkTargets;
  }
  for (const path of right.keys()) if (!left.has(path)) ++missing;
  return { added, missing, kinds, modes, fileBytes, symlinkTargets };
}

/** All four inputs are factual captures, NOT permissions. Caller retains its
 * exclusion gate and original physical exposures across the observation window.
 * Re-observing a modified candidate never resets the original content baseline. */
export function compareIndependentLegacyCaptures(original: DependencyCapturedTreeObservation,
  reference: DependencyCapturedTreeObservation, currentOriginal: DependencyCapturedTreeObservation,
  currentReference: DependencyCapturedTreeObservation) {
  if (original.status !== Observed.Complete || reference.status !== Observed.Complete ||
      currentOriginal.status !== Observed.Complete || currentReference.status !== Observed.Complete)
    return { outcome: LegacyManifestComparison.PreserveIncomplete, ...noAuthority } as const;
  if ((original.tree.dev === reference.tree.dev && original.tree.ino === reference.tree.ino) ||
      (original.workspace.dev === reference.workspace.dev && original.workspace.ino === reference.workspace.ino) ||
      original.workspace.canonicalPath === reference.workspace.canonicalPath)
    return { outcome: LegacyManifestComparison.PreserveNotIndependent, ...noAuthority } as const;
  if (!sameCapture(original, currentOriginal) || !sameCapture(reference, currentReference))
    return { outcome: LegacyManifestComparison.PreserveChanged, ...noAuthority } as const;
  const counts = differences(original.entries, reference.entries);
  const equal = original.digest === reference.digest && equalBytes(original.canonicalBytes, reference.canonicalBytes);
  // Canonical bytes additionally cover logical source-link bindings, including
  // distinctions not represented by entry mismatch counts. Never normalize them.
  return { outcome: equal ? LegacyManifestComparison.MatchFactsOnly : LegacyManifestComparison.PreserveMismatch,
    originalManifestDigest: original.digest, referenceManifestDigest: reference.digest,
    counts, canonicalBytesEqual: equal, ...noAuthority } as const;
}
