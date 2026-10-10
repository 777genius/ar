import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, rename, unlink, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { exposureFailure, parseStorageFilesystem, parseStorageLedger, sameStorageFilesystem,
  sameStorageGeneration, storageUInt, StorageExposureFailure, StorageExposurePhase,
  type StorageExposureLedger, type StorageExposureClaim, type StorageExposureStore,
  type StorageExposureTransaction, type StorageFilesystem } from "../../worker-core/job-storage-exposure/index";

export const storageExposureLedgerName = "filesystem-exposure.json";
export const storageExposureFenceName = "filesystem-exposure.lock";
const intentName = "filesystem-exposure.intent";
const maxLedgerBytes = 4 * 1024 * 1024;
type Lease = { readonly handle: FileHandle; readonly identity: BigIntStats; active: boolean; uncertain: boolean };

/** Existing private control root is supplied by trusted host composition, never
 * worker/tool JSON. It must be outside all payload write grants and on a device
 * distinct from accounted scratch. Exactly one root is registered per physical
 * filesystem. This adapter neither discovers that registry nor authenticates
 * a host mount; the future trusted native adapter owns those prerequisites.
 * All operations are bounded metadata IO. No auto root creation, lock takeover,
 * generation expiry, ledger reset or removal of interrupted publication. */
export class LocalStorageExposureStore implements StorageExposureStore {
  private closed = false;
  private activeOperations = 0;
  private constructor(private readonly rootPath: string, private readonly root: FileHandle,
    private readonly rootIdentity: BigIntStats, private readonly filesystem: StorageFilesystem) {}

  static async create(input: { readonly rootPath: string; readonly filesystem: StorageFilesystem }): Promise<LocalStorageExposureStore> {
    const store = await this.openRoot(input);
    try {
      await store.runFenced(async lease => {
        if (await store.exists(storageExposureLedgerName)) exposureFailure(StorageExposureFailure.Conflict);
        const ledger = parseStorageLedger({ version: 1, filesystem: store.filesystem, revision: 1, claims: [] });
        lease.uncertain = true;
        const file = await open(store.path(storageExposureLedgerName), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { store.privateLeaf(await file.stat({ bigint: true })); await file.writeFile(encode(ledger)); await file.sync(); }
        finally { await file.close(); }
        await store.root.sync(); await store.assertLease(lease);
        if (JSON.stringify(await store.readLedger()) !== JSON.stringify(ledger)) exposureFailure(StorageExposureFailure.UnsafeStore);
        lease.uncertain = false;
      });
      return store;
    } catch (error) { await store.close(); throw error; }
  }

  static async open(input: { readonly rootPath: string; readonly filesystem: StorageFilesystem }): Promise<LocalStorageExposureStore> {
    const store = await this.openRoot(input);
    try {
      // Missing existing authority must never be silently initialized/reset.
      store.privateLeaf(await lstat(store.path(storageExposureLedgerName), { bigint: true }));
      return store;
    } catch (error) {
      await store.close();
      if (hasCode(error, "ENOENT")) exposureFailure(StorageExposureFailure.UnsafeStore);
      throw error;
    }
  }

  private static async openRoot(input: { readonly rootPath: string; readonly filesystem: StorageFilesystem }): Promise<LocalStorageExposureStore> {
    if (process.platform !== "linux") exposureFailure(StorageExposureFailure.UnsupportedStore);
    const filesystem = parseStorageFilesystem(input.filesystem);
    if (!isAbsolute(input.rootPath) || resolve(input.rootPath) !== input.rootPath || await realpath(input.rootPath) !== input.rootPath) {
      exposureFailure(StorageExposureFailure.UnsafeStore);
    }
    const root = await open(input.rootPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const stat = await root.stat({ bigint: true }), observed = await lstat(input.rootPath, { bigint: true });
      if (!stat.isDirectory() || !privateMode(stat, 0o700n) || !sameInode(stat, observed) || stat.dev === storageUInt(filesystem.device)) {
        exposureFailure(StorageExposureFailure.UnsafeStore);
      }
      return new LocalStorageExposureStore(input.rootPath, root, stat, filesystem);
    } catch (error) { await root.close(); throw error; }
  }

  async withFilesystemFence<T>(effect: (transaction: StorageExposureTransaction) => Promise<T>): Promise<T> {
    return this.runFenced(async lease => {
      const transaction: StorageExposureTransaction = {
        assertFence: () => this.assertLease(lease),
        read: async () => {
          await this.assertUsable(lease); const record = await this.readLedger(); await this.assertUsable(lease); return record;
        },
        persist: (revision, next) => this.publish(lease, revision, next),
      };
      return effect(Object.freeze(transaction));
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (this.activeOperations) exposureFailure(StorageExposureFailure.Busy);
    this.closed = true; await this.root.close();
  }

  private async runFenced<T>(effect: (lease: Lease) => Promise<T>): Promise<T> {
    if (this.closed) exposureFailure(StorageExposureFailure.UnsafeStore);
    this.activeOperations += 1;
    let handle: FileHandle | undefined, lease: Lease | undefined;
    try {
      await this.assertRoot();
      try {
        handle = await open(this.path(storageExposureFenceName), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      } catch (error) { if (hasCode(error, "EEXIST")) exposureFailure(StorageExposureFailure.Busy); throw error; }
      const identity = await handle.stat({ bigint: true }); this.privateLeaf(identity);
      lease = { handle, identity, active: true, uncertain: true };
      await handle.writeFile(`${JSON.stringify({ version: 1, fenceId: randomUUID(), filesystem: this.filesystem })}\n`);
      await handle.sync(); await this.root.sync(); await this.assertLease(lease);
      // An interrupted publisher's intent is protected even if its fence was
      // removed externally. No operation is allowed to erase or overwrite it.
      if (await this.exists(intentName)) exposureFailure(StorageExposureFailure.PublicationUncertain);
      lease.uncertain = false;
      return await effect(lease);
    } finally {
      try {
        if (lease) {
          if (!lease.uncertain) {
            await this.assertLease(lease);
            await unlink(this.path(storageExposureFenceName)); await this.root.sync();
          }
          lease.active = false;
        }
      } finally { await handle?.close(); this.activeOperations -= 1; }
    }
  }

  private async publish(lease: Lease, expectedRevision: number, input: StorageExposureLedger): Promise<StorageExposureLedger> {
    const next = parseStorageLedger(input);
    await this.assertUsable(lease);
    const before = await this.readLedger();
    if (!Number.isSafeInteger(expectedRevision) || before.revision !== expectedRevision) exposureFailure(StorageExposureFailure.Stale);
    if (!sameStorageFilesystem(next.filesystem, this.filesystem)) exposureFailure(StorageExposureFailure.IdentityChanged);
    assertSuccessor(before, next);
    const bytes = encode(next), temporaryName = `filesystem-exposure.pending-${randomUUID()}`;
    if (bytes.length > maxLedgerBytes) exposureFailure(StorageExposureFailure.Invalid);
    const intentBytes = Buffer.from(`${JSON.stringify({ version: 1, expectedRevision, nextRevision: next.revision,
      temporaryName, digest: createHash("sha256").update(bytes).digest("hex") })}\n`);
    lease.uncertain = true; // Before the first publication effect, including a failed fsync.
    const intent = await open(this.path(intentName), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let intentIdentity: BigIntStats;
    try {
      intentIdentity = await intent.stat({ bigint: true }); this.privateLeaf(intentIdentity);
      await intent.writeFile(intentBytes); await intent.sync();
    } finally { await intent.close(); }
    await this.root.sync(); await this.assertLease(lease);
    const temporary = await open(this.path(temporaryName), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let temporaryIdentity: BigIntStats;
    try {
      temporaryIdentity = await temporary.stat({ bigint: true }); this.privateLeaf(temporaryIdentity);
      await temporary.writeFile(bytes); await temporary.sync();
    } finally { await temporary.close(); }
    await this.assertLease(lease);
    const observedTemporary = await lstat(this.path(temporaryName), { bigint: true });
    this.privateLeaf(observedTemporary);
    if (!sameInode(temporaryIdentity, observedTemporary) || JSON.stringify(await this.readLedger()) !== JSON.stringify(before)) {
      exposureFailure(StorageExposureFailure.UnsafeStore);
    }
    await rename(this.path(temporaryName), this.path(storageExposureLedgerName)); await this.root.sync();
    await this.assertLease(lease);
    const committed = await this.readLedger();
    if (JSON.stringify(committed) !== JSON.stringify(next)) exposureFailure(StorageExposureFailure.UnsafeStore);
    const observedIntent = await lstat(this.path(intentName), { bigint: true });
    this.privateLeaf(observedIntent);
    if (!sameInode(intentIdentity, observedIntent)) exposureFailure(StorageExposureFailure.UnsafeStore);
    await unlink(this.path(intentName)); await this.root.sync(); await this.assertLease(lease);
    lease.uncertain = false;
    return committed;
  }

  private async readLedger(): Promise<StorageExposureLedger> {
    await this.assertRoot();
    const path = this.path(storageExposureLedgerName), observed = await lstat(path, { bigint: true });
    this.privateLeaf(observed);
    if (observed.size < 1n || observed.size > BigInt(maxLedgerBytes)) exposureFailure(StorageExposureFailure.UnsafeStore);
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await file.stat({ bigint: true }); this.privateLeaf(before);
      if (!sameInode(before, observed) || before.size !== observed.size) exposureFailure(StorageExposureFailure.UnsafeStore);
      const bytes = Buffer.alloc(Number(before.size)); let offset = 0;
      while (offset < bytes.length) {
        const read = await file.read(bytes, offset, bytes.length - offset, offset);
        if (!read.bytesRead) exposureFailure(StorageExposureFailure.UnsafeStore);
        offset += read.bytesRead;
      }
      if ((await file.read(Buffer.alloc(1), 0, 1, offset)).bytesRead) exposureFailure(StorageExposureFailure.UnsafeStore);
      const after = await file.stat({ bigint: true }); this.privateLeaf(after);
      const rebound = await lstat(path, { bigint: true }); this.privateLeaf(rebound);
      if (!sameInode(before, after) || !sameInode(after, rebound) || before.size !== after.size ||
          before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) exposureFailure(StorageExposureFailure.UnsafeStore);
      const text = bytes.toString("utf8");
      if (!Buffer.from(text, "utf8").equals(bytes)) exposureFailure(StorageExposureFailure.UnsafeStore);
      let raw: unknown; try { raw = JSON.parse(text); } catch { exposureFailure(StorageExposureFailure.UnsafeStore); }
      const ledger = parseStorageLedger(raw);
      if (!sameStorageFilesystem(ledger.filesystem, this.filesystem)) exposureFailure(StorageExposureFailure.IdentityChanged);
      await this.assertRoot(); return ledger;
    } finally { await file.close(); }
  }
  private async assertUsable(lease: Lease): Promise<void> {
    await this.assertLease(lease);
    if (lease.uncertain) exposureFailure(StorageExposureFailure.PublicationUncertain);
  }
  private async assertLease(lease: Lease): Promise<void> {
    if (!lease.active) exposureFailure(StorageExposureFailure.Busy);
    await this.assertRoot();
    const observed = await lstat(this.path(storageExposureFenceName), { bigint: true }); this.privateLeaf(observed);
    const retained = await lease.handle.stat({ bigint: true }); this.privateLeaf(retained);
    if (!sameInode(observed, lease.identity) || !sameInode(retained, lease.identity)) exposureFailure(StorageExposureFailure.UnsafeStore);
  }
  private async assertRoot(): Promise<void> {
    if (this.closed) exposureFailure(StorageExposureFailure.UnsafeStore);
    const retained = await this.root.stat({ bigint: true }), observed = await lstat(this.rootPath, { bigint: true });
    if (!retained.isDirectory() || !observed.isDirectory() || !privateMode(retained, 0o700n) || !privateMode(observed, 0o700n) ||
        !sameInode(retained, this.rootIdentity) || !sameInode(observed, this.rootIdentity) || await realpath(this.rootPath) !== this.rootPath) {
      exposureFailure(StorageExposureFailure.UnsafeStore);
    }
  }
  private privateLeaf(info: BigIntStats): void {
    if (!info.isFile() || info.dev !== this.rootIdentity.dev || info.nlink !== 1n || !privateMode(info, 0o600n)) {
      exposureFailure(StorageExposureFailure.UnsafeStore);
    }
  }
  private path(name: string): string { return join(`/proc/self/fd/${this.root.fd}`, name); }
  private async exists(name: string): Promise<boolean> {
    try { await lstat(this.path(name)); return true; } catch (error) { if (hasCode(error, "ENOENT")) return false; throw error; }
  }
}

/** The store cannot be used as a CAS escape that deletes another full-Q claim.
 * Semantic native proof authenticity remains the trusted adapter's contract. */
function assertSuccessor(before: StorageExposureLedger, next: StorageExposureLedger): void {
  if (next.revision !== before.revision + 1 || next.claims.length < before.claims.length || next.claims.length > before.claims.length + 1) {
    exposureFailure(StorageExposureFailure.Invalid);
  }
  let changes = 0;
  for (const old of before.claims) {
    const claim = next.claims.find(row => sameStorageGeneration(row.generation, old.generation));
    if (!claim) exposureFailure(StorageExposureFailure.Conflict);
    if (JSON.stringify(old) === JSON.stringify(claim)) continue;
    changes += 1;
    if (claim.revision !== old.revision + 1 || claim.baseline.bytes !== old.baseline.bytes || claim.baseline.inodes !== old.baseline.inodes ||
        storageUInt(claim.growth.bytes) < storageUInt(old.growth.bytes) || storageUInt(claim.growth.inodes) < storageUInt(old.growth.inodes)) {
      exposureFailure(StorageExposureFailure.Invalid);
    }
    assertPhaseSuccessor(old, claim);
  }
  const added = next.claims.filter(row => !before.claims.some(old => sameStorageGeneration(old.generation, row.generation)));
  if (added.some(row => row.revision !== 1 || row.phase !== StorageExposurePhase.Pending || row.quotaProof !== null || row.drainSealProof !== null) ||
      changes + added.length !== 1) exposureFailure(StorageExposureFailure.Invalid);
}
function assertPhaseSuccessor(before: StorageExposureClaim, next: StorageExposureClaim): void {
  const changedCap = before.cap.bytes !== next.cap.bytes || before.cap.inodes !== next.cap.inodes;
  if (before.phase === StorageExposurePhase.Released ||
      (next.phase === StorageExposurePhase.GrowPending && !changedCap) ||
      (changedCap && (before.phase !== StorageExposurePhase.Active || next.phase !== StorageExposurePhase.GrowPending || before.operationId === next.operationId)) ||
      (!changedCap && before.operationId !== next.operationId)) exposureFailure(StorageExposureFailure.Conflict);
  const allowed: Record<StorageExposurePhase, readonly StorageExposurePhase[]> = {
    [StorageExposurePhase.Pending]: [StorageExposurePhase.Verified, StorageExposurePhase.Unknown, StorageExposurePhase.Sealed],
    [StorageExposurePhase.Verified]: [StorageExposurePhase.Verified, StorageExposurePhase.Active, StorageExposurePhase.Unknown, StorageExposurePhase.Sealed],
    [StorageExposurePhase.Active]: [StorageExposurePhase.Active, StorageExposurePhase.Verified, StorageExposurePhase.GrowPending, StorageExposurePhase.Unknown, StorageExposurePhase.Sealed],
    [StorageExposurePhase.GrowPending]: [StorageExposurePhase.Active, StorageExposurePhase.Verified, StorageExposurePhase.Unknown, StorageExposurePhase.Sealed],
    [StorageExposurePhase.Unknown]: [StorageExposurePhase.Active, StorageExposurePhase.Verified, StorageExposurePhase.Unknown, StorageExposurePhase.Sealed],
    [StorageExposurePhase.Sealed]: [StorageExposurePhase.Sealed, StorageExposurePhase.Released],
    [StorageExposurePhase.Released]: [],
  };
  if (!allowed[before.phase].includes(next.phase)) exposureFailure(StorageExposureFailure.Conflict);
}
function encode(value: unknown): Buffer { return Buffer.from(`${JSON.stringify(value)}\n`); }
function sameInode(left: BigIntStats, right: BigIntStats): boolean { return left.dev === right.dev && left.ino === right.ino; }
function privateMode(info: BigIntStats, mode: bigint): boolean { return info.uid === BigInt(process.geteuid!()) && (info.mode & 0o7777n) === mode; }
function hasCode(error: unknown, code: string): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === code; }
