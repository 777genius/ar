import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, constants, fsyncSync, fstatSync, lstatSync, openSync, readSync,
  realpathSync, renameSync, unlinkSync, writeFileSync, readFileSync, type BigIntStats,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  DependencyAdmissionError, DependencyAdmissionFailure as AdmissionFailure,
  parseDependencyOwner, sameDependencyOwnerIdentity, sameDependencyWorkspace,
  DependencyOwnerPhase, DependencyOwnerKind, isDependencyConsumerOwner, sameDependencyProtectedReference,
  type DependencyOwnerRecord, type DependencyOwnerStore, type DependencyWorkspaceIdentity,
} from "@vioxen/subscription-runtime/worker-core";

import type { DependencyGenerationRetirementVerifier } from "../../worker-core/dependency-environment/ports/dependency-generation-continuity";

export enum DependencyOwnerStorageFailure {
  Unsupported = "unsupported", InvalidConfig = "invalid_config", UnsafeRoot = "unsafe_root",
  UnsafeStore = "unsafe_store", Closed = "closed",
}
export class DependencyOwnerStorageError extends Error {
  constructor(readonly reason: DependencyOwnerStorageFailure) { super(`dependency_owner_storage:${reason}`); }
}

/** Trusted composition provides an existing private root outside tool grants.
 * The store serializes facts; it does not authenticate launches or authorize
 * release. Mutexes have no PID/TTL takeover. Failed publication retains its
 * mutex and any temporary record for authenticated reconciliation.
 */
export class LocalDependencyOwnerStore implements DependencyOwnerStore {
  private closed = false;
  private constructor(
    private readonly rootPath: string,
    private readonly fd: number,
    private readonly identity: BigIntStats,
    private readonly maxRecordBytes: number,
    private readonly generationRetirementVerifier?: DependencyGenerationRetirementVerifier,
  ) {}

  static open(input: { readonly rootPath: string; readonly maxRecordBytes: number; readonly generationRetirementVerifier?: DependencyGenerationRetirementVerifier }): LocalDependencyOwnerStore {
    if (process.platform !== "linux") storageFailure(DependencyOwnerStorageFailure.Unsupported);
    if (!isAbsolute(input.rootPath) || resolve(input.rootPath) !== input.rootPath
      || !Number.isSafeInteger(input.maxRecordBytes) || input.maxRecordBytes < 1) {
      storageFailure(DependencyOwnerStorageFailure.InvalidConfig);
    }
    if (realpathSync(input.rootPath) !== input.rootPath) storageFailure(DependencyOwnerStorageFailure.UnsafeRoot);
    const fd = openSync(input.rootPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const info = fstatSync(fd, { bigint: true });
      const observed = lstatSync(input.rootPath, { bigint: true });
      if (!info.isDirectory() || !privateMode(info, 0o700n) || !sameIdentity(info, observed)) {
        storageFailure(DependencyOwnerStorageFailure.UnsafeRoot);
      }
      return new LocalDependencyOwnerStore(input.rootPath, fd, info, input.maxRecordBytes, input.generationRetirementVerifier);
    } catch (error) { closeSync(fd); throw error; }
  }

  read(workspace: DependencyWorkspaceIdentity): DependencyOwnerRecord | null {
    const key = this.key(workspace);
    this.assertRoot();
    this.assertNoMutex(key);
    const result = this.readRecord(workspace, key);
    this.assertRoot();
    this.assertNoMutex(key);
    return result;
  }

  compareAndSwap(workspace: DependencyWorkspaceIdentity, expectedRevision: number | null,
    next: DependencyOwnerRecord): DependencyOwnerRecord {
    const key = this.key(workspace);
    const record = parseDependencyOwner(next);
    if (!sameDependencyWorkspace(record.workspace, workspace)) admissionFailure(AdmissionFailure.WorkspaceChanged);
    if (expectedRevision !== null && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) {
      admissionFailure(AdmissionFailure.InvalidRecord);
    }
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
    if (bytes.length > this.maxRecordBytes) admissionFailure(AdmissionFailure.InvalidRecord);
    this.assertRoot();
    const mutexPath = this.path(`${key}.lock`);
    let mutex: number;
    try {
      mutex = openSync(mutexPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    } catch (error) {
      if (hasCode(error, "EEXIST")) admissionFailure(AdmissionFailure.Busy);
      throw error;
    }
    let mutexIdentity: BigIntStats | undefined;
    let publicationStarted = false;
    let publicationComplete = false;
    try {
      mutexIdentity = fstatSync(mutex, { bigint: true });
      this.assertPrivateLeaf(mutexIdentity);
      const current = this.readRecordUnderOwnMutex(workspace, key, mutexIdentity);
      if ((current?.revision ?? null) !== expectedRevision) admissionFailure(AdmissionFailure.StaleAttempt);
      if (record.version === 3 && (!current || current.version === 1)) admissionFailure(AdmissionFailure.InvalidRecord);
      if (current?.version === 3 && record.version !== 3) admissionFailure(AdmissionFailure.InvalidRecord);
      const custodyUpgrade = current?.version === 2 && record.version === 3;
      if (current?.version === 2 && record.version !== 2 && !custodyUpgrade) admissionFailure(AdmissionFailure.InvalidRecord);
      if (custodyUpgrade) {
        if (current.owner || record.owner) admissionFailure(AdmissionFailure.Busy);
        if (record.epoch !== current.epoch || JSON.stringify(record.activity) !== JSON.stringify(current.activity)) {
          admissionFailure(AdmissionFailure.InvalidRecord);
        }
      }
      // Slice A is storage/data only. Later fixed B-D handoff must authenticate
      // completed transfer+receipt before enabling an actual binding replacement.
      if (current?.version === 3 && record.version === 3 &&
          !sameDependencyProtectedReference(current.custodyBinding, record.custodyBinding)) admissionFailure(AdmissionFailure.InvalidRecord);
      if (current?.version === 1 && record.version === 2 && current.owner) admissionFailure(AdmissionFailure.Busy);
      if (record.revision !== (current?.revision ?? 0) + 1 || record.epoch < (current?.epoch ?? 1)
        || record.epoch > (current?.epoch ?? 0) + 1) admissionFailure(AdmissionFailure.InvalidRecord);
      if (current?.owner && record.owner && record.epoch === current.epoch
        && !sameDependencyOwnerIdentity(current.owner, record.owner)) admissionFailure(AdmissionFailure.StaleAttempt);
      if (current?.owner && record.epoch !== current.epoch) admissionFailure(AdmissionFailure.Busy);
      if (record.owner && !current?.owner && record.epoch !== (current?.epoch ?? 0) + 1) {
        admissionFailure(AdmissionFailure.StaleAttempt);
      }
      if (record.version !== 1 && record.generationContinuity && (!current || current.version === 1)) admissionFailure(AdmissionFailure.InvalidRecord);
      if (current && current.version !== 1 && record.version !== 1) {
        const before = current.generationContinuity, after = record.generationContinuity;
        if (before && !after) admissionFailure(AdmissionFailure.InvalidRecord);
        if (JSON.stringify(before) !== JSON.stringify(after)) {
          // Retirement cannot release/change the held actual owner in this CAS.
          // The immutable receipt successor must already have been read back.
          if (!after || current.version !== record.version || !current.owner || !record.owner || current.epoch !== record.epoch ||
              current.owner.phase !== DependencyOwnerPhase.ExclusiveMutation ||
              record.owner.phase !== DependencyOwnerPhase.ExclusiveMutation ||
              !sameDependencyOwnerIdentity(current.owner, record.owner) ||
              after.operationId !== (current.owner.kind === DependencyOwnerKind.Maintenance ? current.owner.attempt.operationId : current.owner.attempt.attemptId) ||
              (before && after.readyRevision <= before.unverifiedRevision) || !this.generationRetirementVerifier) {
            admissionFailure(AdmissionFailure.InvalidRecord);
          }
          try {
            const result = this.generationRetirementVerifier.assertGenerationRetirement({ previousOwner: current, proposedOwner: record, invalidation: after });
            if (result !== undefined) admissionFailure(AdmissionFailure.InvalidRecord);
          } catch { admissionFailure(AdmissionFailure.InvalidRecord); }
        }
      }
      assertActivitySuccessor(current, record);

      if (current && ((current.version === 1 && record.version === 2) || custodyUpgrade)) {
        // Idle-only upgrades retain exact original bytes before replacement.
        const original = openSync(this.path(`${key}.json`), constants.O_RDONLY | constants.O_NOFOLLOW);
        let bytes: Buffer;
        try {
          const before = fstatSync(original, { bigint: true }); this.assertPrivateLeaf(before);
          bytes = readFileSync(original);
          const after = fstatSync(original, { bigint: true });
          if (!sameIdentity(before, after) || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs ||
              JSON.stringify(parseDependencyOwner(JSON.parse(bytes.toString("utf8")))) !== JSON.stringify(current)) {
            storageFailure(DependencyOwnerStorageFailure.UnsafeStore);
          }
        } finally { closeSync(original); }
        // Preservation itself is a durable publication phase. Any uncertainty
        // keeps the same mutex rather than admitting a second upgrade.
        publicationStarted = true;
        const preserved = openSync(this.path(`${key}.v${current.version}-${createHash("sha256").update(bytes).digest("hex")}.json`),
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { writeFileSync(preserved, bytes); fsyncSync(preserved); } finally { closeSync(preserved); }
        fsyncSync(this.fd);
      }

      // From here even a failed sync is uncertain. Never discard the intent.
      publicationStarted = true;
      const temporaryName = `${key}.pending-${randomUUID()}`;
      writeFileSync(mutex, `${JSON.stringify({ version: 1, operationId: randomUUID(), temporaryName,
        expectedRevision, nextRevision: record.revision, digest: createHash("sha256").update(bytes).digest("hex") })}\n`);
      fsyncSync(mutex);
      fsyncSync(this.fd);
      const temporaryPath = this.path(temporaryName);
      const temporary = openSync(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      let temporaryIdentity: BigIntStats;
      try {
        temporaryIdentity = fstatSync(temporary, { bigint: true });
        this.assertPrivateLeaf(temporaryIdentity);
        writeFileSync(temporary, bytes);
        fsyncSync(temporary);
      } finally { closeSync(temporary); }
      this.assertRoot();
      const observedTemporary = lstatSync(temporaryPath, { bigint: true });
      this.assertPrivateLeaf(observedTemporary);
      if (!sameIdentity(temporaryIdentity, observedTemporary)) storageFailure(DependencyOwnerStorageFailure.UnsafeStore);
      // The private root and per-key mutex exclude other governed publishers.
      // A fresh read also vetoes corrupt/substituted destination records.
      const beforeRename = this.readRecordUnderOwnMutex(workspace, key, mutexIdentity);
      if (JSON.stringify(beforeRename) !== JSON.stringify(current)) admissionFailure(AdmissionFailure.StaleAttempt);
      renameSync(temporaryPath, this.path(`${key}.json`));
      fsyncSync(this.fd);
      const committed = this.readRecordUnderOwnMutex(workspace, key, mutexIdentity);
      if (JSON.stringify(committed) !== JSON.stringify(record)) storageFailure(DependencyOwnerStorageFailure.UnsafeStore);
      publicationComplete = true;
      return committed!;
    } finally {
      closeSync(mutex);
      if (mutexIdentity && (!publicationStarted || publicationComplete)) {
        this.assertRoot();
        const observed = lstatSync(mutexPath, { bigint: true });
        this.assertPrivateLeaf(observed);
        if (!sameIdentity(mutexIdentity, observed)) storageFailure(DependencyOwnerStorageFailure.UnsafeStore);
        unlinkSync(mutexPath);
        fsyncSync(this.fd);
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    closeSync(this.fd);
  }

  private key(workspace: DependencyWorkspaceIdentity): string {
    if (this.closed) storageFailure(DependencyOwnerStorageFailure.Closed);
    return ownerKey(workspace);
  }
  private path(name: string): string { return join(`/proc/self/fd/${this.fd}`, name); }
  private assertRoot(): void {
    if (this.closed) storageFailure(DependencyOwnerStorageFailure.Closed);
    const observed = lstatSync(this.rootPath, { bigint: true });
    const retained = fstatSync(this.fd, { bigint: true });
    if (!observed.isDirectory() || !privateMode(observed, 0o700n) || !sameIdentity(observed, this.identity)
      || !sameIdentity(retained, this.identity) || realpathSync(this.rootPath) !== this.rootPath) {
      storageFailure(DependencyOwnerStorageFailure.UnsafeRoot);
    }
  }
  private assertPrivateLeaf(info: BigIntStats): void {
    if (!info.isFile() || info.dev !== this.identity.dev || info.nlink !== 1n || !privateMode(info, 0o600n)) {
      storageFailure(DependencyOwnerStorageFailure.UnsafeStore);
    }
  }
  private assertNoMutex(key: string): void {
    let present = true;
    try {
      lstatSync(this.path(`${key}.lock`));
    } catch (error) {
      if (hasCode(error, "ENOENT")) present = false;
      else throw error;
    }
    this.assertRoot();
    if (present) admissionFailure(AdmissionFailure.Busy);
  }
  private readRecordUnderOwnMutex(workspace: DependencyWorkspaceIdentity, key: string,
    mutexIdentity: BigIntStats): DependencyOwnerRecord | null {
    this.assertRoot();
    this.assertOwnedMutex(key, mutexIdentity);
    const result = this.readRecord(workspace, key);
    this.assertRoot();
    this.assertOwnedMutex(key, mutexIdentity);
    return result;
  }
  private assertOwnedMutex(key: string, expected: BigIntStats): void {
    const observed = lstatSync(this.path(`${key}.lock`), { bigint: true });
    this.assertPrivateLeaf(observed);
    if (!sameIdentity(observed, expected)) storageFailure(DependencyOwnerStorageFailure.UnsafeStore);
  }
  private readRecord(workspace: DependencyWorkspaceIdentity, key: string): DependencyOwnerRecord | null {
    const result = this.readLeaf(key);
    if (result && !sameDependencyWorkspace(result.workspace, workspace)) admissionFailure(AdmissionFailure.WorkspaceChanged);
    return result;
  }
  private readLeaf(key: string): DependencyOwnerRecord | null {
    const path = this.path(`${key}.json`);
    let observed: BigIntStats;
    try { observed = lstatSync(path, { bigint: true }); } catch (error) {
      if (hasCode(error, "ENOENT")) return null;
      throw error;
    }
    this.assertPrivateLeaf(observed);
    if (observed.size < 1n || observed.size > BigInt(this.maxRecordBytes)) admissionFailure(AdmissionFailure.InvalidRecord);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = fstatSync(fd, { bigint: true });
      this.assertPrivateLeaf(before);
      if (!sameIdentity(before, observed) || before.size !== observed.size) storageFailure(DependencyOwnerStorageFailure.UnsafeStore);
      const bytes = Buffer.alloc(Number(before.size));
      let offset = 0;
      while (offset < bytes.length) {
        const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (count === 0) admissionFailure(AdmissionFailure.InvalidRecord);
        offset += count;
      }
      if (readSync(fd, Buffer.alloc(1), 0, 1, offset) !== 0) admissionFailure(AdmissionFailure.InvalidRecord);
      const after = fstatSync(fd, { bigint: true });
      this.assertPrivateLeaf(after);
      if (!sameIdentity(before, after) || before.size !== after.size || before.mtimeNs !== after.mtimeNs
        || before.ctimeNs !== after.ctimeNs) storageFailure(DependencyOwnerStorageFailure.UnsafeStore);
      const text = bytes.toString("utf8");
      if (!Buffer.from(text, "utf8").equals(bytes)) admissionFailure(AdmissionFailure.InvalidRecord);
      let value: unknown;
      try { value = JSON.parse(text); } catch { admissionFailure(AdmissionFailure.InvalidRecord); }
      return parseDependencyOwner(value);
    } finally { closeSync(fd); }
  }
}

function privateMode(info: BigIntStats, mode: bigint): boolean {
  return (info.mode & 0o7777n) === mode && info.uid === BigInt(process.geteuid!());
}
function assertActivitySuccessor(current: DependencyOwnerRecord | null, next: DependencyOwnerRecord): void {
  const before = current?.activity, after = next.activity;
  if (before !== undefined && after === undefined) admissionFailure(AdmissionFailure.InvalidRecord);
  const consumer = current && isDependencyConsumerOwner(current.owner) ? current.owner : null;
  const entry = consumer?.phase === DependencyOwnerPhase.ExclusiveMutation &&
    isDependencyConsumerOwner(next.owner) && next.owner.phase === DependencyOwnerPhase.Running;
  if (entry) {
    if (!after?.lastEntry || after.lastEntry.epoch !== next.epoch ||
        (before?.lastEntry && after.lastEntry.epoch <= before.lastEntry.epoch) ||
        JSON.stringify(after.lastRelease) !== JSON.stringify(before?.lastRelease ?? null)) admissionFailure(AdmissionFailure.InvalidRecord);
    return;
  }
  const release = consumer !== null && next.owner === null &&
    before?.lastEntry?.epoch === current?.epoch;
  if (release) {
    if (consumer.phase !== DependencyOwnerPhase.Fenced || !after?.lastRelease || after.lastRelease.epoch !== current!.epoch ||
        JSON.stringify(after.lastEntry) !== JSON.stringify(before!.lastEntry)) admissionFailure(AdmissionFailure.InvalidRecord);
    return;
  }
  if (JSON.stringify(before) !== JSON.stringify(after)) admissionFailure(AdmissionFailure.InvalidRecord);
}
export function dependencyOwnerStorageName(workspace: DependencyWorkspaceIdentity): string { return `${ownerKey(workspace)}.json`; }
function ownerKey(workspace: DependencyWorkspaceIdentity): string {
  // Reuse the core schema, without treating this validation as authority.
  parseDependencyOwner({ version: 1, workspace, revision: 1, epoch: 1, owner: null });
  if (workspace.dev.length > 40 || workspace.ino.length > 40) admissionFailure(AdmissionFailure.InvalidRecord);
  return `${workspace.dev}-${workspace.ino}`;
}
function sameIdentity(left: BigIntStats, right: BigIntStats): boolean { return left.dev === right.dev && left.ino === right.ino; }
function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
function admissionFailure(reason: AdmissionFailure): never { throw new DependencyAdmissionError(reason); }
function storageFailure(reason: DependencyOwnerStorageFailure): never { throw new DependencyOwnerStorageError(reason); }
