import { parseStorageAmounts, parseStorageFilesystem, parseStorageGeneration, parseStorageOperation,
  sameStorageAmounts, sameStorageFilesystem, storageFreeFloor, storageSum, storageUInt,
  type StorageAmounts, type StorageFilesystem } from "../job-storage-exposure/domain/storage-exposure";
import { BoundedStorageBackend, BoundedStorageError, BoundedStorageFailure, BoundedStoragePhase,
  type BoundedStorageBinding, type BoundedStorageCapacity, type BoundedStorageLedger,
  type BoundedStorageNativeFacts, type BoundedStorageRequest, type BoundedStorageReservation } from "./bounded-storage-contract";

export function boundedFailure(reason: BoundedStorageFailure): never { throw new BoundedStorageError(reason); }
/** Own enumerable DATA descriptors only; capture before any async host call. */
export function boundedFields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) boundedFailure(BoundedStorageFailure.Invalid);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== keys.length) boundedFailure(BoundedStorageFailure.Invalid);
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) boundedFailure(BoundedStorageFailure.Invalid);
    result[key] = descriptor.value;
  }
  return result;
}
export function boundedDigest(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) boundedFailure(BoundedStorageFailure.Invalid);
  return value;
}
export function boundedRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) boundedFailure(BoundedStorageFailure.Invalid);
  return value as number;
}
const amounts = (value: unknown): StorageAmounts => parseStorageAmounts(boundedFields(value, ["bytes", "inodes"]));
/** Standing publication buffer for the <=4MiB next ledger, temporary/intent,
 * one native state update and bounded directory/filesystem metadata. Existing
 * ledger/state allocation is already charged by fresh root statfs. */
export const boundedRootPublicationBytes = "33554432";
export function assertBoundedRootCapacity(availableBytes: string): void {
  if (storageUInt(availableBytes) - storageUInt(boundedRootPublicationBytes) < storageUInt(storageFreeFloor.bytes)) boundedFailure(BoundedStorageFailure.Capacity);
}
export function parseBoundedBinding(value: unknown): BoundedStorageBinding {
  const r = boundedFields(value, ["filesystem", "bootId", "policySha256", "admissionReceiptSha256", "admissionRevision"]);
  return Object.freeze({ filesystem: parseStorageFilesystem(boundedFields(r.filesystem, ["machineId", "uuid", "device"])),
    bootId: parseStorageOperation(r.bootId), policySha256: boundedDigest(r.policySha256),
    admissionReceiptSha256: boundedDigest(r.admissionReceiptSha256), admissionRevision: boundedRevision(r.admissionRevision) });
}
/** Conservative envelope; actual formatted geometry must independently prove
 * reachability. This estimate never authorizes a larger Q or supplies proof. */
export function boundedImageEnvelope(capInput: StorageAmounts): { physicalBytes: string; exposure: StorageAmounts } {
  const cap = amounts(capInput), q = storageUInt(cap.bytes), inodes = storageUInt(cap.inodes);
  if (!q || q % 1024n || inodes <= 8n || inodes > 0xffff0000n) boundedFailure(BoundedStorageFailure.Invalid);
  const metadata = q / 64n + inodes * 512n + 335544320n;
  const physicalBytes = ((q + metadata + 4095n) / 4096n * 4096n).toString();
  storageUInt(physicalBytes);
  if (BigInt(physicalBytes) > (1n << 63n) - 1n) boundedFailure(BoundedStorageFailure.Invalid);
  return { physicalBytes, exposure: amounts({ bytes: (BigInt(physicalBytes) + 1048576n).toString(), inodes: (inodes + 16n).toString() }) };
}
export function parseBoundedRequest(value: unknown): BoundedStorageRequest {
  const r = boundedFields(value, ["backend", "binding", "generation", "operationId", "baseline", "growth", "cap", "physicalBytes", "exposure"]);
  if (r.backend !== BoundedStorageBackend.Ext4ProjectImage) boundedFailure(BoundedStorageFailure.Invalid);
  const baseline = amounts(r.baseline), growth = amounts(r.growth), cap = amounts(r.cap), exposure = amounts(r.exposure);
  if (!sameStorageAmounts(storageSum(baseline, growth), cap)) boundedFailure(BoundedStorageFailure.Invalid);
  const minimum = boundedImageEnvelope(cap);
  const p = storageUInt(r.physicalBytes);
  if (p % 4096n || p < BigInt(minimum.physicalBytes) || p > (1n << 63n) - 1n ||
      storageUInt(exposure.bytes) !== p + 1048576n || storageUInt(exposure.inodes) !== storageUInt(cap.inodes) + 16n) boundedFailure(BoundedStorageFailure.Invalid);
  return Object.freeze({ backend: BoundedStorageBackend.Ext4ProjectImage, binding: parseBoundedBinding(r.binding),
    generation: parseStorageGeneration(boundedFields(r.generation, ["jobId", "generationId", "projectId"])),
    operationId: parseStorageOperation(r.operationId), baseline, growth, cap, physicalBytes: r.physicalBytes as string, exposure });
}
export function parseBoundedFacts(value: unknown, request: BoundedStorageRequest, digest: string): BoundedStorageNativeFacts {
  const r = boundedFields(value, ["requestSha256", "backingDevice", "backingInode", "backingBytes", "allocatedBytes", "loopDevice",
    "innerUuid", "payloadDevice", "payloadInode", "payloadMountId", "nativeNamespaceInode", "projectId", "hardLimit", "usage", "reachable"]);
  for (const key of ["backingDevice", "backingInode", "backingBytes", "allocatedBytes", "loopDevice", "payloadDevice", "payloadInode", "payloadMountId", "nativeNamespaceInode"]) {
    if (!storageUInt(r[key])) boundedFailure(BoundedStorageFailure.Identity);
  }
  const hardLimit = amounts(r.hardLimit), usage = amounts(r.usage), reachable = amounts(r.reachable);
  if (boundedDigest(r.requestSha256) !== digest || r.backingDevice !== request.binding.filesystem.device || r.backingBytes !== request.physicalBytes ||
      storageUInt(r.allocatedBytes) < storageUInt(request.physicalBytes) || r.payloadDevice === r.backingDevice || r.projectId !== request.generation.projectId ||
      !sameStorageAmounts(hardLimit, request.cap) || storageUInt(usage.bytes) > storageUInt(hardLimit.bytes) || storageUInt(usage.inodes) > storageUInt(hardLimit.inodes) ||
      storageUInt(reachable.bytes) < storageUInt(hardLimit.bytes) || storageUInt(reachable.inodes) < storageUInt(hardLimit.inodes)) boundedFailure(BoundedStorageFailure.Identity);
  parseStorageOperation(r.innerUuid);
  return Object.freeze({ ...r, hardLimit, usage, reachable }) as BoundedStorageNativeFacts;
}
export function parseBoundedReservation(value: unknown): BoundedStorageReservation {
  const r = boundedFields(value, ["request", "requestSha256", "revision", "phase", "facts"]), request = parseBoundedRequest(r.request), digest = boundedDigest(r.requestSha256);
  if (!Object.values(BoundedStoragePhase).includes(r.phase as BoundedStoragePhase)) boundedFailure(BoundedStorageFailure.Invalid);
  const facts = r.facts === null ? null : parseBoundedFacts(r.facts, request, digest);
  if (r.phase === BoundedStoragePhase.Prepared && !facts) boundedFailure(BoundedStorageFailure.Invalid);
  return Object.freeze({ request, requestSha256: digest, revision: boundedRevision(r.revision), phase: r.phase as BoundedStoragePhase, facts });
}
export function parseBoundedLedger(value: unknown, filesystem: StorageFilesystem): BoundedStorageLedger {
  const r = boundedFields(value, ["version", "filesystem", "revision", "reservations"]);
  if (r.version !== 1 || !Array.isArray(r.reservations) || r.reservations.length > 1024 ||
      !sameStorageFilesystem(parseStorageFilesystem(boundedFields(r.filesystem, ["machineId", "uuid", "device"])), filesystem)) boundedFailure(BoundedStorageFailure.Identity);
  const reservations = r.reservations.map(parseBoundedReservation), ids = new Set<string>(), projects = new Set<number>(), jobs = new Set<string>();
  for (const row of reservations) {
    if (!sameStorageFilesystem(row.request.binding.filesystem, filesystem) || ids.has(row.request.generation.generationId) ||
        projects.has(row.request.generation.projectId) || jobs.has(row.request.generation.jobId)) boundedFailure(BoundedStorageFailure.Conflict);
    ids.add(row.request.generation.generationId); projects.add(row.request.generation.projectId); jobs.add(row.request.generation.jobId);
  }
  return Object.freeze({ version: 1, filesystem, revision: boundedRevision(r.revision), reservations: Object.freeze(reservations) });
}
/** No live-usage, deletion, terminal or cleanup-credit argument exists. B1 has
 * no release transition; pending, prepared, blocked and unknown all count E. */
export function assertBoundedCapacity(snapshot: BoundedStorageCapacity, reservations: readonly BoundedStorageReservation[]): void {
  const available = amounts(snapshot.available); let bytes = 0n, inodes = 0n;
  for (const row of reservations) { bytes += storageUInt(row.request.exposure.bytes); inodes += storageUInt(row.request.exposure.inodes); }
  if (storageUInt(available.bytes) - bytes < storageUInt(storageFreeFloor.bytes) ||
      storageUInt(available.inodes) - inodes < storageUInt(storageFreeFloor.inodes)) boundedFailure(BoundedStorageFailure.Capacity);
  assertBoundedRootCapacity(snapshot.rootAvailableBytes);
}
