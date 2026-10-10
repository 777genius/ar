import type { JobStorageHandoffVerification, JobStorageSettlement } from "@vioxen/subscription-runtime/worker-core";
import { JobStorageCapabilityStatus } from "@vioxen/subscription-runtime/worker-core";

export enum SourceHandoffEntryKind { Directory = "directory", File = "file" }
export enum SourceHandoffRoot { Workspace = "workspace", Output = "output", Evidence = "evidence" }
export enum SourceHandoffCaptureStatus { Captured = "captured-awaiting-readback" }
export enum SourceHandoffKeyPurpose { Capture = "capture", Readback = "readback" }
export enum SourceHandoffFailure {
  Unsupported = "source-handoff-unsupported", Changed = "source-handoff-source-changed",
  Invalid = "source-handoff-invalid", Authentication = "source-handoff-authentication-failed",
  Destination = "source-handoff-destination-untrusted", Bounds = "source-handoff-bounds-exceeded",
}
export class SourceHandoffError extends Error {
  constructor(readonly code: SourceHandoffFailure) { super(code); this.name = "SourceHandoffError"; }
}
/** Values come from the trusted owner, never serialized model configuration.
 * Native owner must anchor/pin roots and all their ancestors for the whole effect,
 * exclude alias/path replacement and all writers, and revalidate UUID/mount view.
 * JS dev/inode checks supplement that authority; they do not implement it. */
export type SourceHandoffDirectory = {
  readonly path: string; readonly device: number; readonly inode: number; readonly uid: number;
};
export type SourceHandoffFilesystemIdentity = { readonly machineId: string; readonly filesystemUuid: string };
export type SourceHandoffLease = {
  readonly sourceFilesystem: SourceHandoffFilesystemIdentity;
  /** Exact required producer result/evidence paths under their respective roots. */
  readonly requiredArtifacts: Readonly<Record<SourceHandoffRoot.Output | SourceHandoffRoot.Evidence, readonly string[]>>;
  readonly destinationFilesystem: SourceHandoffFilesystemIdentity;
  readonly source: Readonly<Record<SourceHandoffRoot, SourceHandoffDirectory>>;
  readonly destination: SourceHandoffDirectory;
  readonly independentDestinationId: string;
  readonly nativeFenceSha256: string;
  assertCurrent(): void;
};
export type SourceHandoffReadbackLease = {
  readonly destinationFilesystem: SourceHandoffFilesystemIdentity;
  readonly destination: SourceHandoffDirectory;
  /** Existing empty private parent for a NEW offline restore. No activation. */
  readonly restoreParent: SourceHandoffDirectory;
  readonly independentDestinationId: string;
  assertCurrent(): void;
};
export type SourceHandoffNativeResult<T> =
  | { readonly status: JobStorageCapabilityStatus.Unknown | JobStorageCapabilityStatus.Unsupported }
  | { readonly status: JobStorageCapabilityStatus.Verified; readonly value: T };
export interface SourceHandoffNativePort {
  /** Same settlement/generation fence as resume/close/A2; no ACTIVE or unknown
   * writer. Qualified kernel quiescence/drain and immutable pinned source roots
   * span inventory, capture, destination fsync and receipt publication. */
  withQuiescedCapture<T>(current: JobStorageSettlement, handoffId: string,
    effect: (lease: SourceHandoffLease) => Promise<T>): Promise<SourceHandoffNativeResult<T>>;
  /** Native current authority plus independently pinned destination and exclusive
   * private offline parent. The SAME authenticated ciphertext is immutable across
   * BOTH passes: native exclusion blocks path replacement, in-place writes and
   * all preopened FD/bind/hardlink aliases until restore/readback completes. A
   * directory pin alone is insufficient. Unsupported exclusion returns Unsupported
   * without callback effects. Does not need the original source to exist. */
  withOfflineReadback<T>(current: JobStorageSettlement, receipt: SourceHandoffReceipt,
    effect: (lease: SourceHandoffReadbackLease) => Promise<T>): Promise<SourceHandoffNativeResult<T>>;
}
export interface SourceHandoffKeyCustody {
  /** Reuse trusted key custody. No raw auth read/copy, key creation or key path in
   * request/receipt; key availability at the independent destination is required. */
  withKey<T>(keyId: string, purpose: SourceHandoffKeyPurpose,
    effect: (key: Uint8Array) => Promise<T>): Promise<T>;
}
export type SourceHandoffEntry = {
  readonly path: string; readonly kind: SourceHandoffEntryKind; readonly mode: number;
  readonly size: number; readonly sha256: string;
};
export type SourceHandoffManifest = {
  readonly schemaVersion: 1; readonly entries: readonly SourceHandoffEntry[];
  readonly gitFactsSha256: string;
  readonly requiredArtifacts: Readonly<Record<SourceHandoffRoot.Output | SourceHandoffRoot.Evidence, readonly string[]>>;
};
/** Bounded host control metadata only. Full inventory/paths remain encrypted. */
export type SourceHandoffReceipt = {
  readonly schemaVersion: 1; readonly handoffId: string; readonly jobId: string;
  readonly generationId: string; readonly receiptSha256: string; readonly settlementRevision: number;
  readonly keyId: string; readonly independentDestinationId: string; readonly nativeFenceSha256: string;
  readonly sourcePhysicalSha256: string; readonly destinationPhysicalSha256: string;
  readonly envelopeSha256: string; readonly envelopeBytes: number;
  readonly sourceManifestSha256: string; readonly outputManifestSha256: string; readonly evidenceManifestSha256: string;
};
export interface SourceHandoffReceiptStore {
  /** Host-owned bounded atomic metadata; cannot overwrite a conflicting handoff. */
  publish(receipt: SourceHandoffReceipt): Promise<void>;
  read(handoffId: string): Promise<SourceHandoffReceipt | undefined>;
}
export type SourceHandoffCaptureResult =
  | { readonly status: JobStorageCapabilityStatus.Unknown | JobStorageCapabilityStatus.Unsupported }
  | { readonly status: SourceHandoffCaptureStatus.Captured; readonly receipt: SourceHandoffReceipt };
export type SourceHandoffDependencies = {
  readonly native?: SourceHandoffNativePort; readonly keys: SourceHandoffKeyCustody;
  readonly receipts: SourceHandoffReceiptStore; readonly keyId: string;
};
export type SourceHandoffVerification = JobStorageHandoffVerification;
export function sourceHandoffFail(code: SourceHandoffFailure): never { throw new SourceHandoffError(code); }
