import type { StorageAmounts, StorageFilesystem, StorageGeneration } from "../job-storage-exposure/domain/storage-exposure";

export enum BoundedStorageBackend { Ext4ProjectImage = "ext4_project_image" }
export enum BoundedStoragePhase { Pending = "pending", Prepared = "prepared", Unknown = "unknown", Blocked = "blocked" }
export enum BoundedStorageFailure {
  Invalid = "invalid", Conflict = "conflict", Capacity = "capacity", Identity = "identity",
  Uncertain = "uncertain", Unsupported = "unsupported", UnsafeControl = "unsafe_control", Exhausted = "exhausted",
}
export class BoundedStorageError extends Error {
  constructor(readonly reason: BoundedStorageFailure) { super(`bounded_storage:${reason}`); }
}
/** Installed host composition supplies this binding. Serialized data describes
 * the identity; it never grants A write authority or a native start barrier. */
export type BoundedStorageBinding = {
  readonly filesystem: StorageFilesystem;
  readonly bootId: string;
  readonly policySha256: string;
  readonly admissionReceiptSha256: string;
  readonly admissionRevision: number;
};
export type BoundedStorageRequest = {
  readonly backend: BoundedStorageBackend.Ext4ProjectImage;
  readonly binding: BoundedStorageBinding;
  readonly generation: StorageGeneration;
  readonly operationId: string;
  readonly baseline: StorageAmounts;
  readonly growth: StorageAmounts;
  readonly cap: StorageAmounts;
  /** P, including proved inner metadata. It is never a payload quota. */
  readonly physicalBytes: string;
  /** E >= full Q; the allocated image is also charged by fresh outer statfs. */
  readonly exposure: StorageAmounts;
};
export type BoundedStorageNativeFacts = {
  readonly requestSha256: string;
  readonly backingDevice: string;
  readonly backingInode: string;
  readonly backingBytes: string;
  readonly allocatedBytes: string;
  readonly loopDevice: string;
  readonly innerUuid: string;
  readonly payloadDevice: string;
  readonly payloadInode: string;
  readonly payloadMountId: string;
  readonly nativeNamespaceInode: string;
  readonly projectId: number;
  readonly hardLimit: StorageAmounts;
  readonly usage: StorageAmounts;
  readonly reachable: StorageAmounts;
};
export type BoundedStorageReservation = {
  readonly request: BoundedStorageRequest;
  readonly requestSha256: string;
  readonly revision: number;
  readonly phase: BoundedStoragePhase;
  readonly facts: BoundedStorageNativeFacts | null;
};
export type BoundedStorageLedger = {
  readonly version: 1;
  readonly filesystem: StorageFilesystem;
  readonly revision: number;
  readonly reservations: readonly BoundedStorageReservation[];
};
export type BoundedStorageCapacity = {
  readonly available: StorageAmounts;
  readonly rootAvailableBytes: string;
};
export enum BoundedStorageInspection { Absent = "absent", Prepared = "prepared", Partial = "partial" }
export type BoundedStorageObservation =
  | { readonly kind: BoundedStorageInspection.Prepared; readonly facts: BoundedStorageNativeFacts }
  | { readonly kind: BoundedStorageInspection.Absent | BoundedStorageInspection.Partial };

/** One native process retains the stable filesystem flock and all native pins.
 * Ledger publication itself runs in that holder, so parent death cannot leave
 * a TS filesystem write proceeding after its native fence has disappeared. */
export interface BoundedStorageNativeSession {
  assertHeld(): Promise<void>;
  /** Actual syscall/module/loop inputs only, not enforcement qualification. */
  requirePreparationCapability(request: BoundedStorageRequest, requestSha256: string): Promise<void>;
  readCapacity(): Promise<BoundedStorageCapacity>;
  readLedger(): Promise<string | null>;
  publishLedger(expected: string | null, next: string): Promise<void>;
  prepare(request: BoundedStorageRequest, requestSha256: string): Promise<BoundedStorageNativeFacts>;
  inspect(request: BoundedStorageRequest, requestSha256: string): Promise<BoundedStorageObservation>;
}
export interface BoundedStorageNativeHost {
  withFilesystemFence<T>(effect: (session: BoundedStorageNativeSession) => Promise<T>): Promise<T>;
}
/** B1 returns physical preparation only. A owns authenticated service namespace,
 * source-FD propagation, current-generation CAS and the existing start barrier.
 * No activation/release/grow dummy implementation is provided by this slice. */
export interface BoundedStoragePreparationPort {
  prepare(request: BoundedStorageRequest): Promise<BoundedStorageReservation>;
  reconcile(generation: StorageGeneration): Promise<BoundedStorageReservation>;
  verifyPrepared(generation: StorageGeneration): Promise<BoundedStorageNativeFacts>;
}
