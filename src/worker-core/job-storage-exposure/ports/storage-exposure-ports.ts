import type { StorageCapacitySnapshot, StorageDrainSealProof, StorageExposureClaim,
  StorageExposureLedger, StorageFilesystem, StorageQuotaProof } from "../domain/storage-exposure";

export interface StorageExposureTransaction {
  read(): Promise<StorageExposureLedger>;
  persist(expectedRevision: number, next: StorageExposureLedger): Promise<StorageExposureLedger>;
  assertFence(): Promise<void>;
}
/** Trusted composition owns the existing private control root, outside payload grants.
 * One fence covers the entire physical filesystem, never one lock per job.
 * Publication uncertainty preserves the fence; no PID/TTL claim release. */
export interface StorageExposureStore {
  withFilesystemFence<T>(effect: (transaction: StorageExposureTransaction) => Promise<T>): Promise<T>;
}
export interface StorageExposureCapacityPort {
  /** Native/host adapter returns fresh statfs under the held filesystem fence,
   * including verified physical identity, not caller-supplied availability. */
  readCapacity(filesystem: StorageFilesystem): Promise<StorageCapacitySnapshot>;
}
export enum StorageKernelResultKind { Verified = "verified", Unsupported = "unsupported", Uncertain = "uncertain" }
export enum StorageKernelUnsupportedReason {
  NoTrustedAdapter = "no_trusted_adapter", QuotaNotEnabled = "quota_not_enabled",
  UnboundedWriteSurface = "unbounded_write_surface",
}
export type StorageKernelResult<T> =
  | { readonly kind: StorageKernelResultKind.Verified; readonly value: T }
  | { readonly kind: StorageKernelResultKind.Unsupported; readonly reason: StorageKernelUnsupportedReason }
  | { readonly kind: StorageKernelResultKind.Uncertain };
export enum StorageObservedWriter { Inactive = "inactive", Active = "active" }
export type StorageObservedQuota = { readonly proof: StorageQuotaProof; readonly writer: StorageObservedWriter };
/** Not a payload/tool API. The trusted native adapter must authenticate job/A
 * lifetime authority, namespace/backing pin, baseline, whole write surface and
 * project-id custody. A typed proof or stored digest alone grants no authority.
 * The same operationId is idempotent at the host and cannot open two writers. */
export interface StorageExposureKernelPort {
  prepareOrVerifyQuota(filesystem: StorageFilesystem, claim: StorageExposureClaim): Promise<StorageKernelResult<StorageQuotaProof>>;
  openWriterBarrier(filesystem: StorageFilesystem, claim: StorageExposureClaim): Promise<StorageKernelResult<StorageQuotaProof>>;
  growQuota(filesystem: StorageFilesystem, claim: StorageExposureClaim): Promise<StorageKernelResult<StorageQuotaProof>>;
  reconcileQuota(filesystem: StorageFilesystem, claim: StorageExposureClaim): Promise<StorageKernelResult<StorageObservedQuota>>;
  /** Retain the generation/drain fence and quota seal through commit. A boolean
   * supplied by the caller, terminal status or TTL is never drain authority. */
  withDrainedQuotaSeal<T>(filesystem: StorageFilesystem, claim: StorageExposureClaim, operationId: string,
    commit: (proof: StorageDrainSealProof) => Promise<T>): Promise<StorageKernelResult<T>>;
}
/** Explicit unavailable capability; cannot accidentally return success. */
export function unsupportedStorageExposureKernel(): StorageExposureKernelPort {
  const unsupported = { kind: StorageKernelResultKind.Unsupported, reason: StorageKernelUnsupportedReason.NoTrustedAdapter } as const;
  return { async prepareOrVerifyQuota() { return unsupported; }, async openWriterBarrier() { return unsupported; },
    async growQuota() { return unsupported; }, async reconcileQuota() { return unsupported; },
    async withDrainedQuotaSeal() { return unsupported; } };
}
