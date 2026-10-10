import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, rename, unlink, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { JobStorageSettlementService } from "../../worker-core/job-storage/application/job-storage-settlement";
import { assertJobStorageIdentity, assertJobStorageIntent, JobStorageCapabilityStatus, JobStorageIntentKind,
  JobStorageSettlementStatus, sameJobStorageIdentity, type JobStorageAdmissionReceipt,
  type JobStorageIdentity, type JobStorageIntent, type JobStorageSettlement } from "../../worker-core/job-storage/domain/job-storage";
import type { JobStorageGenerationAuthority, JobStorageSettlementStore,
  JobStorageSourceHandoffPort } from "../../worker-core/job-storage/ports/job-storage-ports";

export enum JobStorageStoreFailure {
  Unsupported = "unsupported", Unsafe = "unsafe-store", Busy = "busy",
  Uncertain = "publication-uncertain", Stale = "stale", Invalid = "invalid-transition",
}
export class JobStorageStoreError extends Error {
  constructor(readonly reason: JobStorageStoreFailure) { super(`job_storage_store_${reason}`); }
}
export const settlementRecordName = "settlement.json";
export const settlementFenceName = "settlement.lock";
export const settlementIntentName = "settlement.intent";
const maxBytes = 64 * 1024;
type Lease = { handle: FileHandle; identity: BigIntStats; active: boolean; uncertain: boolean };
export type RegisteredSettlementRoot = Readonly<{ path: string; device: string; inode: string }>;
export type LocalJobStorageSettlementOptions = Readonly<{
  /** One existing private control root per generation, registered by the host
   * outside payload grants and on an independent persistent filesystem. Trusted
   * registration owns reboot durability and singleton binding; no self-registration. */
  controlRoot: RegisteredSettlementRoot;
  identity: JobStorageIdentity;
  /** Required existing native/shared authority; metadata locks do not replace it. */
  authority: JobStorageGenerationAuthority;
  /** Trusted host composition authenticates the registered immutable receipt.
   * Never wire caller/tool JSON, an in-memory boolean or a raw worker receipt. */
  readAuthenticatedReceipt: (identity: JobStorageIdentity) => Promise<JobStorageAdmissionReceipt>;
}>;

/** Durable implementation of the existing settlement CAS. Effects must run
 * inside the SAME outer native generation fence used by resume/close/admission.
 * createService wires that existing service/authority; direct update is a trusted
 * adapter boundary, not a worker endpoint. No native pin/drain proof is supplied
 * here. Interrupted locks/intents require trusted reconciliation, never takeover. */
export class LocalJobStorageSettlementStore implements JobStorageSettlementStore {
  private closed = false;
  private operations = 0;
  private constructor(private readonly options: LocalJobStorageSettlementOptions,
    private readonly root: FileHandle, private readonly rootIdentity: BigIntStats,
    private readonly initial: JobStorageSettlement) {}

  static async create(input: LocalJobStorageSettlementOptions): Promise<LocalJobStorageSettlementStore> {
    return this.connect(input, true);
  }
  static async open(input: LocalJobStorageSettlementOptions): Promise<LocalJobStorageSettlementStore> {
    return this.connect(input, false);
  }
  private static async connect(input: LocalJobStorageSettlementOptions, initialize: boolean): Promise<LocalJobStorageSettlementStore> {
    if (process.platform !== "linux" || typeof input?.authority?.withGenerationFence !== "function" ||
        typeof input.authority.verifyNativeDrain !== "function" || typeof input.readAuthenticatedReceipt !== "function") fail(JobStorageStoreFailure.Unsupported);
    assertJobStorageIdentity(input.identity);
    const options = Object.freeze({ ...input, identity: Object.freeze({ ...input.identity }), controlRoot: Object.freeze({ ...input.controlRoot }) });
    const registration = options.controlRoot;
    if (!registration || typeof registration.path !== "string" || !isAbsolute(registration.path) || resolve(registration.path) !== registration.path ||
        !uint(registration.device) || !uint(registration.inode) || registration.inode === "0") fail(JobStorageStoreFailure.Unsafe);
    return options.authority.withGenerationFence(options.identity, async () => {
      const trusted = await options.readAuthenticatedReceipt(options.identity);
      // Keep the authenticated binding immutable across real filesystem awaits.
      // A caller-owned receipt must not change device/intent after validation.
      const receipt = Object.freeze({ ...trusted, intent: Object.freeze({ ...trusted.intent }),
        layout: Object.freeze({ ...trusted.layout }) });
      assertJobStorageIdentity(receipt); assertJobStorageIntent(receipt.intent);
      if (receipt.schemaVersion !== 1 || !sameJobStorageIdentity(receipt, options.identity) || !uint(receipt.device)) fail(JobStorageStoreFailure.Stale);
      const initial = parse({ ...options.identity, intent: receipt.intent, revision: 0, status: JobStorageSettlementStatus.Active });
      if (await realpath(registration.path) !== registration.path) fail(JobStorageStoreFailure.Unsafe);
      const root = await open(registration.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      let store: LocalJobStorageSettlementStore | undefined;
      try {
        const info = await root.stat({ bigint: true });
        if (!info.isDirectory() || !privateMode(info, 0o700n) || info.dev.toString() !== registration.device ||
            info.ino.toString() !== registration.inode || info.dev.toString() === receipt.device) fail(JobStorageStoreFailure.Unsafe);
        store = new this(options, root, info, initial);
        await store.fenced(async lease => {
          if (initialize) {
            if (await store!.exists(settlementRecordName)) fail(JobStorageStoreFailure.Stale);
            await store!.publish(lease, undefined, initial);
          } else await store!.readRecord(); // Missing or foreign existing authority is never reset.
        });
        return store;
      } catch (error) { await root.close(); throw error; }
    });
  }

  createService(handoff?: JobStorageSourceHandoffPort): JobStorageSettlementService {
    return new JobStorageSettlementService(this, this.options.authority, handoff ?? {
      async verify() { return { status: JobStorageCapabilityStatus.Unsupported }; },
    });
  }
  async update<T>(identity: JobStorageIdentity, expectedRevision: number,
    effect: (current: JobStorageSettlement) => Promise<{ readonly next?: JobStorageSettlement; readonly result: T }>): Promise<T> {
    assertJobStorageIdentity(identity);
    const boundIdentity = Object.freeze({ ...identity });
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision === Number.MAX_SAFE_INTEGER) fail(JobStorageStoreFailure.Invalid);
    if (!sameJobStorageIdentity(boundIdentity, this.initial)) fail(JobStorageStoreFailure.Stale);
    return this.fenced(async lease => {
      const before = await this.readRecord();
      if (before.revision !== expectedRevision) fail(JobStorageStoreFailure.Stale);
      const outcome = await effect(before);
      await this.assertLease(lease);
      if (outcome.next !== undefined) {
        const next = parse(outcome.next); successor(before, next);
        await this.publish(lease, before, next);
      }
      return outcome.result;
    });
  }
  async close(): Promise<void> {
    if (this.closed) return;
    if (this.operations) fail(JobStorageStoreFailure.Busy);
    this.closed = true; await this.root.close();
  }

  private async fenced<T>(effect: (lease: Lease) => Promise<T>): Promise<T> {
    if (this.closed) fail(JobStorageStoreFailure.Unsafe);
    this.operations += 1;
    let handle: FileHandle | undefined, lease: Lease | undefined;
    try {
      await this.assertRoot();
      try { handle = await open(this.path(settlementFenceName), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
      catch (error) { if (hasCode(error, "EEXIST")) fail(JobStorageStoreFailure.Busy); throw error; }
      const identity = await handle.stat({ bigint: true }); this.privateLeaf(identity);
      lease = { handle, identity, active: true, uncertain: true };
      await handle.writeFile(encode({ schemaVersion: 1, fenceId: randomUUID(), identity: this.options.identity }));
      await handle.sync(); await this.root.sync(); await this.assertLease(lease);
      if (await this.exists(settlementIntentName)) fail(JobStorageStoreFailure.Uncertain);
      lease.uncertain = false;
      return await effect(lease);
    } finally {
      try {
        if (lease) {
          if (!lease.uncertain) {
            await this.assertLease(lease);
            await unlink(this.path(settlementFenceName)); await this.root.sync();
          }
          lease.active = false;
        }
      } finally { await handle?.close(); this.operations -= 1; }
    }
  }
  private async publish(lease: Lease, before: JobStorageSettlement | undefined, next: JobStorageSettlement): Promise<void> {
    await this.assertLease(lease);
    const bytes = encode({ schemaVersion: 1, settlement: next }), pending = `settlement.pending-${randomUUID()}`;
    if (bytes.length > maxBytes) fail(JobStorageStoreFailure.Invalid);
    lease.uncertain = true;
    const intentIdentity = await this.writeNew(settlementIntentName, encode({ schemaVersion: 1,
      identity: this.options.identity, expectedRevision: before?.revision ?? null, nextRevision: next.revision,
      pending, sha256: createHash("sha256").update(bytes).digest("hex") }));
    await this.root.sync(); await this.assertLease(lease);
    const pendingIdentity = await this.writeNew(pending, bytes);
    await this.assertLease(lease);
    await this.assertLeaf(pending, pendingIdentity);
    if (before ? JSON.stringify(await this.readRecord()) !== JSON.stringify(before) : await this.exists(settlementRecordName)) fail(JobStorageStoreFailure.Stale);
    await rename(this.path(pending), this.path(settlementRecordName)); await this.root.sync();
    await this.assertLease(lease);
    if (JSON.stringify(await this.readRecord()) !== JSON.stringify(next)) fail(JobStorageStoreFailure.Unsafe);
    await this.assertLeaf(settlementIntentName, intentIdentity);
    await unlink(this.path(settlementIntentName)); await this.root.sync(); await this.assertLease(lease);
    lease.uncertain = false;
  }
  private async writeNew(name: string, bytes: Buffer): Promise<BigIntStats> {
    const file = await open(this.path(name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { const info = await file.stat({ bigint: true }); this.privateLeaf(info); await file.writeFile(bytes); await file.sync(); return info; }
    finally { await file.close(); }
  }
  private async readRecord(): Promise<JobStorageSettlement> {
    await this.assertRoot();
    const path = this.path(settlementRecordName), observed = await lstat(path, { bigint: true }); this.privateLeaf(observed);
    if (observed.size < 1n || observed.size > BigInt(maxBytes)) fail(JobStorageStoreFailure.Unsafe);
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await file.stat({ bigint: true }); this.privateLeaf(before);
      if (!sameInode(before, observed) || before.size !== observed.size) fail(JobStorageStoreFailure.Unsafe);
      const bytes = Buffer.alloc(Number(before.size)); let offset = 0;
      while (offset < bytes.length) { const read = await file.read(bytes, offset, bytes.length - offset, offset); if (!read.bytesRead) fail(JobStorageStoreFailure.Unsafe); offset += read.bytesRead; }
      if ((await file.read(Buffer.alloc(1), 0, 1, offset)).bytesRead) fail(JobStorageStoreFailure.Unsafe);
      const after = await file.stat({ bigint: true }); this.privateLeaf(after); await this.assertLeaf(settlementRecordName, after);
      if (!sameInode(before, after) || before.size !== after.size || before.ctimeNs !== after.ctimeNs || before.mtimeNs !== after.mtimeNs) fail(JobStorageStoreFailure.Unsafe);
      let raw: unknown;
      try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { fail(JobStorageStoreFailure.Unsafe); }
      const record = object(raw, "schemaVersion,settlement"); if (record.schemaVersion !== 1) fail(JobStorageStoreFailure.Unsafe);
      const settlement = parse(record.settlement);
      if (!sameJobStorageIdentity(settlement, this.initial) || JSON.stringify(settlement.intent) !== JSON.stringify(this.initial.intent)) fail(JobStorageStoreFailure.Stale);
      await this.assertRoot(); return settlement;
    } finally { await file.close(); }
  }
  private async assertRoot(): Promise<void> {
    if (this.closed) fail(JobStorageStoreFailure.Unsafe);
    const retained = await this.root.stat({ bigint: true }), observed = await lstat(this.options.controlRoot.path, { bigint: true });
    if (!retained.isDirectory() || !observed.isDirectory() || !privateMode(retained, 0o700n) || !privateMode(observed, 0o700n) ||
        !sameInode(retained, this.rootIdentity) || !sameInode(observed, this.rootIdentity) || await realpath(this.options.controlRoot.path) !== this.options.controlRoot.path) fail(JobStorageStoreFailure.Unsafe);
  }
  private async assertLease(lease: Lease): Promise<void> {
    if (!lease.active) fail(JobStorageStoreFailure.Busy);
    await this.assertRoot(); await this.assertLeaf(settlementFenceName, lease.identity);
    const retained = await lease.handle.stat({ bigint: true }); this.privateLeaf(retained);
    if (!sameInode(retained, lease.identity)) fail(JobStorageStoreFailure.Unsafe);
  }
  private async assertLeaf(name: string, identity: BigIntStats): Promise<void> {
    const observed = await lstat(this.path(name), { bigint: true }); this.privateLeaf(observed);
    if (!sameInode(observed, identity)) fail(JobStorageStoreFailure.Unsafe);
  }
  private privateLeaf(info: BigIntStats): void {
    if (!info.isFile() || !privateMode(info, 0o600n) || info.nlink !== 1n || info.dev !== this.rootIdentity.dev) fail(JobStorageStoreFailure.Unsafe);
  }
  private path(name: string): string { return join(`/proc/self/fd/${this.root.fd}`, name); }
  private async exists(name: string): Promise<boolean> {
    try { await lstat(this.path(name)); return true; } catch (error) { if (hasCode(error, "ENOENT")) return false; throw error; }
  }
}

function parse(value: unknown): JobStorageSettlement {
  const row = object(value, "jobId,generationId,receiptSha256,revision,intent,status");
  const identity = { jobId: row.jobId, generationId: row.generationId, receiptSha256: row.receiptSha256 } as JobStorageIdentity;
  assertJobStorageIdentity(identity);
  const intentRow = object(row.intent, row.intent && typeof row.intent === "object" && "kind" in row.intent &&
    row.intent.kind === JobStorageIntentKind.Continuation ? "kind,sessionId" : "kind,homeStateRequirement");
  const intent = intentRow as unknown as JobStorageIntent; assertJobStorageIntent(intent);
  if (intent.kind === JobStorageIntentKind.Continuation && (intent.sessionId.length > 512 || /[\u0000-\u001f\u007f]/.test(intent.sessionId))) fail(JobStorageStoreFailure.Invalid);
  if (!Number.isSafeInteger(row.revision) || (row.revision as number) < 0 ||
      !Object.values(JobStorageSettlementStatus).includes(row.status as JobStorageSettlementStatus)) fail(JobStorageStoreFailure.Invalid);
  return Object.freeze({ ...identity, revision: row.revision as number, status: row.status as JobStorageSettlementStatus, intent: Object.freeze({ ...intent }) });
}
function successor(before: JobStorageSettlement, next: JobStorageSettlement): void {
  if (!sameJobStorageIdentity(before, next) || next.revision !== before.revision + 1 ||
      JSON.stringify(before.intent) !== JSON.stringify(next.intent)) fail(JobStorageStoreFailure.Invalid);
  const allowed = before.status === JobStorageSettlementStatus.Active ? next.status === JobStorageSettlementStatus.Resumable :
    before.status === JobStorageSettlementStatus.Resumable && (next.status === JobStorageSettlementStatus.Active ?
      before.intent.kind === JobStorageIntentKind.Continuation : next.status === JobStorageSettlementStatus.Closed && before.intent.kind === JobStorageIntentKind.NoResume);
  if (!allowed) fail(JobStorageStoreFailure.Invalid);
}
function object(value: unknown, keys: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== keys.split(",").sort().join(",")) fail(JobStorageStoreFailure.Unsafe);
  return value as Record<string, unknown>;
}
function fail(reason: JobStorageStoreFailure): never { throw new JobStorageStoreError(reason); }
function uint(value: unknown): value is string { return typeof value === "string" && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= 18446744073709551615n; }
function encode(value: unknown): Buffer { return Buffer.from(`${JSON.stringify(value)}\n`); }
function sameInode(left: BigIntStats, right: BigIntStats): boolean { return left.dev === right.dev && left.ino === right.ino; }
function privateMode(info: BigIntStats, mode: bigint): boolean { return info.uid === BigInt(process.geteuid!()) && (info.mode & 0o7777n) === mode; }
function hasCode(error: unknown, code: string): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === code; }
