/** All quantities are canonical decimal uint64 values, never floating point. */
export type StorageAmounts = { readonly bytes: string; readonly inodes: string };
export type StorageFilesystem = {
  readonly machineId: string;
  readonly uuid: string;
  readonly device: string;
};
export type StorageGeneration = {
  readonly jobId: string;
  readonly generationId: string;
  readonly projectId: number;
};
export enum StorageExposurePhase {
  Pending = "pending", Verified = "verified", Active = "active",
  GrowPending = "grow_pending", Unknown = "unknown", Sealed = "sealed", Released = "released",
}
export enum StorageExposureFailure {
  Invalid = "invalid", IdentityChanged = "identity_changed", Conflict = "conflict",
  Capacity = "capacity", Busy = "busy", Stale = "stale", UnsafeStore = "unsafe_store",
  PublicationUncertain = "publication_uncertain", UnsupportedStore = "unsupported_store",
}
export class StorageExposureError extends Error {
  constructor(readonly reason: StorageExposureFailure) { super(`storage_exposure:${reason}`); }
}
export const storageFreeFloor: StorageAmounts = Object.freeze({ bytes: "5368709120", inodes: "50000" });
export type StorageQuotaProof = {
  readonly filesystem: StorageFilesystem;
  readonly generation: StorageGeneration;
  readonly operationId: string;
  readonly cap: StorageAmounts;
  readonly baseline: StorageAmounts;
  readonly inheritanceVerified: true;
  readonly writeSurfaceVerified: true;
  readonly sealedBaselineVerified: true;
  readonly digest: string;
};
export type StorageDrainSealProof = {
  readonly filesystem: StorageFilesystem;
  readonly generation: StorageGeneration;
  readonly claimRevision: number;
  readonly operationId: string;
  readonly writerDrained: true;
  readonly descendantsDrained: true;
  readonly referencesDrained: true;
  readonly quotaSealed: true;
  readonly digest: string;
};
export type StorageExposureClaim = {
  readonly generation: StorageGeneration;
  readonly revision: number;
  readonly operationId: string;
  readonly baseline: StorageAmounts;
  readonly growth: StorageAmounts;
  readonly cap: StorageAmounts;
  readonly phase: StorageExposurePhase;
  readonly quotaProof: StorageQuotaProof | null;
  readonly drainSealProof: StorageDrainSealProof | null;
};
export type StorageExposureLedger = {
  readonly version: 1;
  readonly filesystem: StorageFilesystem;
  readonly revision: number;
  readonly claims: readonly StorageExposureClaim[];
};
export type StorageCapacitySnapshot = {
  readonly filesystem: StorageFilesystem;
  readonly available: StorageAmounts;
  readonly rootAvailableBytes: string;
};

const uint64Max = (1n << 64n) - 1n;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function exposureFailure(reason: StorageExposureFailure): never { throw new StorageExposureError(reason); }
export function storageUInt(value: unknown): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(value)) exposureFailure(StorageExposureFailure.Invalid);
  const result = BigInt(value);
  if (result > uint64Max) exposureFailure(StorageExposureFailure.Invalid);
  return result;
}
export function parseStorageAmounts(value: unknown): StorageAmounts {
  const object = fields(value, ["bytes", "inodes"]);
  storageUInt(object.bytes); storageUInt(object.inodes);
  return Object.freeze({ bytes: object.bytes as string, inodes: object.inodes as string });
}
export function storageSum(left: StorageAmounts, right: StorageAmounts): StorageAmounts {
  return parseStorageAmounts({ bytes: (storageUInt(left.bytes) + storageUInt(right.bytes)).toString(),
    inodes: (storageUInt(left.inodes) + storageUInt(right.inodes)).toString() });
}
export function sameStorageAmounts(left: StorageAmounts, right: StorageAmounts): boolean {
  return left.bytes === right.bytes && left.inodes === right.inodes;
}
export function parseStorageFilesystem(value: unknown): StorageFilesystem {
  const object = fields(value, ["machineId", "uuid", "device"]);
  if (typeof object.machineId !== "string" || !/^[0-9a-f]{32}$/.test(object.machineId) ||
      typeof object.uuid !== "string" || !uuid.test(object.uuid) || storageUInt(object.device) === 0n) {
    exposureFailure(StorageExposureFailure.Invalid);
  }
  return Object.freeze({ machineId: object.machineId, uuid: object.uuid, device: object.device as string });
}
export function parseStorageCapacitySnapshot(value: unknown): StorageCapacitySnapshot {
  const object = fields(value, ["filesystem", "available", "rootAvailableBytes"]);
  storageUInt(object.rootAvailableBytes);
  return Object.freeze({ filesystem: parseStorageFilesystem(object.filesystem), available: parseStorageAmounts(object.available),
    rootAvailableBytes: object.rootAvailableBytes as string });
}
export function sameStorageFilesystem(left: StorageFilesystem, right: StorageFilesystem): boolean {
  return left.machineId === right.machineId && left.uuid === right.uuid && left.device === right.device;
}
export function parseStorageGeneration(value: unknown): StorageGeneration {
  const object = fields(value, ["jobId", "generationId", "projectId"]);
  if (typeof object.jobId !== "string" || !/^[a-z0-9][a-z0-9-]{0,95}$/.test(object.jobId) ||
      typeof object.generationId !== "string" || !uuid.test(object.generationId) ||
      !Number.isSafeInteger(object.projectId) || (object.projectId as number) < 1 || (object.projectId as number) > 0xffffffff) {
    exposureFailure(StorageExposureFailure.Invalid);
  }
  return Object.freeze({ jobId: object.jobId, generationId: object.generationId, projectId: object.projectId as number });
}
export function sameStorageGeneration(left: StorageGeneration, right: StorageGeneration): boolean {
  return left.jobId === right.jobId && left.generationId === right.generationId && left.projectId === right.projectId;
}
export function parseStorageOperation(value: unknown): string {
  if (typeof value !== "string" || !uuid.test(value)) exposureFailure(StorageExposureFailure.Invalid);
  return value;
}
export function parseStorageQuotaProof(value: unknown): StorageQuotaProof {
  const object = fields(value, ["filesystem", "generation", "operationId", "cap", "baseline",
    "inheritanceVerified", "writeSurfaceVerified", "sealedBaselineVerified", "digest"]);
  if (object.inheritanceVerified !== true || object.writeSurfaceVerified !== true ||
      object.sealedBaselineVerified !== true) exposureFailure(StorageExposureFailure.Invalid);
  return Object.freeze({ filesystem: parseStorageFilesystem(object.filesystem), generation: parseStorageGeneration(object.generation),
    operationId: parseStorageOperation(object.operationId), cap: parseStorageAmounts(object.cap),
    baseline: parseStorageAmounts(object.baseline), inheritanceVerified: true, writeSurfaceVerified: true,
    sealedBaselineVerified: true, digest: digest(object.digest) });
}
export function parseStorageDrainSealProof(value: unknown): StorageDrainSealProof {
  const object = fields(value, ["filesystem", "generation", "claimRevision", "operationId", "writerDrained",
    "descendantsDrained", "referencesDrained", "quotaSealed", "digest"]);
  if (object.writerDrained !== true || object.descendantsDrained !== true || object.referencesDrained !== true ||
      object.quotaSealed !== true) exposureFailure(StorageExposureFailure.Invalid);
  return Object.freeze({ filesystem: parseStorageFilesystem(object.filesystem), generation: parseStorageGeneration(object.generation),
    claimRevision: revision(object.claimRevision), operationId: parseStorageOperation(object.operationId),
    writerDrained: true, descendantsDrained: true, referencesDrained: true, quotaSealed: true, digest: digest(object.digest) });
}
export function parseStorageClaim(value: unknown, filesystem: StorageFilesystem): StorageExposureClaim {
  const object = fields(value, ["generation", "revision", "operationId", "baseline", "growth", "cap", "phase", "quotaProof", "drainSealProof"]);
  const baseline = parseStorageAmounts(object.baseline), growth = parseStorageAmounts(object.growth), cap = parseStorageAmounts(object.cap);
  if (!sameStorageAmounts(storageSum(baseline, growth), cap) || storageUInt(cap.bytes) === 0n || storageUInt(cap.inodes) === 0n ||
      !Object.values(StorageExposurePhase).includes(object.phase as StorageExposurePhase)) exposureFailure(StorageExposureFailure.Invalid);
  const claim: StorageExposureClaim = { generation: parseStorageGeneration(object.generation), revision: revision(object.revision),
    operationId: parseStorageOperation(object.operationId), baseline, growth, cap, phase: object.phase as StorageExposurePhase,
    quotaProof: object.quotaProof === null ? null : parseStorageQuotaProof(object.quotaProof),
    drainSealProof: object.drainSealProof === null ? null : parseStorageDrainSealProof(object.drainSealProof) };
  if (claim.quotaProof) assertStorageQuotaProof(claim.quotaProof, filesystem, claim);
  if ([StorageExposurePhase.Active, StorageExposurePhase.Verified].includes(claim.phase) && !claim.quotaProof) exposureFailure(StorageExposureFailure.Invalid);
  if ([StorageExposurePhase.Sealed, StorageExposurePhase.Released].includes(claim.phase)) {
    if (!claim.drainSealProof || !sameStorageFilesystem(claim.drainSealProof.filesystem, filesystem) ||
        !sameStorageGeneration(claim.drainSealProof.generation, claim.generation) ||
        claim.drainSealProof.claimRevision !== claim.revision - (claim.phase === StorageExposurePhase.Released ? 2 : 1)) exposureFailure(StorageExposureFailure.Invalid);
  } else if (claim.drainSealProof !== null) exposureFailure(StorageExposureFailure.Invalid);
  return Object.freeze(claim);
}
export function parseStorageLedger(value: unknown): StorageExposureLedger {
  const object = fields(value, ["version", "filesystem", "revision", "claims"]);
  if (object.version !== 1 || !Array.isArray(object.claims) || object.claims.length > 4096) exposureFailure(StorageExposureFailure.Invalid);
  const filesystem = parseStorageFilesystem(object.filesystem);
  const claims = object.claims.map(claim => parseStorageClaim(claim, filesystem));
  const generations = new Set<string>(), projects = new Set<number>(), liveJobs = new Set<string>();
  for (const claim of claims) {
    const key = `${claim.generation.jobId}/${claim.generation.generationId}`;
    if (generations.has(key) || projects.has(claim.generation.projectId)) exposureFailure(StorageExposureFailure.Conflict);
    generations.add(key); projects.add(claim.generation.projectId);
    if (claim.phase !== StorageExposurePhase.Released) {
      if (liveJobs.has(claim.generation.jobId)) exposureFailure(StorageExposureFailure.Conflict);
      liveJobs.add(claim.generation.jobId);
    }
  }
  return Object.freeze({ version: 1, filesystem, revision: revision(object.revision), claims: Object.freeze(claims) });
}
export function assertStorageQuotaProof(proof: StorageQuotaProof, filesystem: StorageFilesystem, claim: StorageExposureClaim): void {
  if (!sameStorageFilesystem(proof.filesystem, filesystem) || !sameStorageGeneration(proof.generation, claim.generation) ||
      proof.operationId !== claim.operationId || !sameStorageAmounts(proof.cap, claim.cap) ||
      !sameStorageAmounts(proof.baseline, claim.baseline)) exposureFailure(StorageExposureFailure.IdentityChanged);
}
/** Live usage and cleanup receipts are deliberately absent from this formula. */
export function storageFullExposure(claims: readonly StorageExposureClaim[]): StorageAmounts {
  let bytes = 0n, inodes = 0n;
  for (const claim of claims) if (claim.phase !== StorageExposurePhase.Released) {
    bytes += storageUInt(claim.cap.bytes); inodes += storageUInt(claim.cap.inodes);
  }
  return parseStorageAmounts({ bytes: bytes.toString(), inodes: inodes.toString() });
}
export function assertStorageCapacity(snapshot: StorageCapacitySnapshot, ledger: StorageExposureLedger,
  proposedClaims: readonly StorageExposureClaim[]): void {
  if (!sameStorageFilesystem(parseStorageFilesystem(snapshot.filesystem), ledger.filesystem)) exposureFailure(StorageExposureFailure.IdentityChanged);
  const available = parseStorageAmounts(snapshot.available), exposure = storageFullExposure(proposedClaims);
  if (storageUInt(available.bytes) - storageUInt(exposure.bytes) < storageUInt(storageFreeFloor.bytes) ||
      storageUInt(available.inodes) - storageUInt(exposure.inodes) < storageUInt(storageFreeFloor.inodes) ||
      storageUInt(snapshot.rootAvailableBytes) < storageUInt(storageFreeFloor.bytes)) exposureFailure(StorageExposureFailure.Capacity);
}
function fields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) exposureFailure(StorageExposureFailure.Invalid);
  const object = value as Record<string, unknown>;
  if (Object.keys(object).length !== keys.length || keys.some(key => !Object.hasOwn(object, key))) exposureFailure(StorageExposureFailure.Invalid);
  return object;
}
function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) exposureFailure(StorageExposureFailure.Invalid);
  return value as number;
}
function digest(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) exposureFailure(StorageExposureFailure.Invalid);
  return value;
}
