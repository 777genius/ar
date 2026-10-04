import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readSync,
  realpathSync, renameSync, statfsSync, unlinkSync, writeFileSync, type BigIntStats } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { DependencyInstallProofKind as Install, DependencyPreservationKind as Preserve, DependencyReceiptState as State,
  DependencyUnverifiedReason, sameDependencyTree, sameDependencyWorkspace,
  type DependencyReceipt, type DependencyTreeIdentity, type DependencyWorkspaceIdentity,
} from "../../worker-core/dependency-environment/domain/dependency-receipt";
import { DependencyReceiptParseStatus, parseDependencyReceipt } from "../../worker-core/dependency-environment/domain/parse-dependency-receipt";
import { detectSecretLikeContent } from "../../worker-core/secret-detection";
import type { DependencyCommittedAbsentReceipt, DependencyReceiptStore } from "../../worker-core/dependency-environment/ports/dependency-receipt-store";

export enum DependencyReceiptStorageFailure {
  Unsupported = "unsupported", InvalidConfig = "invalid_config", UnsafeRoot = "unsafe_root", UnsafeStore = "unsafe_store",
  InvalidReceipt = "invalid_receipt", InvalidTransition = "invalid_transition", WorkspaceChanged = "workspace_changed",
  StaleRevision = "stale_revision", Busy = "busy", Bounds = "bounds", Corrupt = "corrupt", Closed = "closed",
}
export class DependencyReceiptStorageError extends Error {
  constructor(readonly reason: DependencyReceiptStorageFailure) { super(`dependency_receipt_storage:${reason}`); }
}
const Failure = DependencyReceiptStorageFailure;
function fail(reason: DependencyReceiptStorageFailure): never { throw new DependencyReceiptStorageError(reason); }
type Reference = { name: string; identity: DependencyTreeIdentity; sha256: string };
type Commit = { version: 1; workspace: DependencyWorkspaceIdentity; revision: number; receipt: Reference; previous: Reference | null };
type Head = { version: 1; workspace: DependencyWorkspaceIdentity; revision: number; commit: Reference };
type Leaf = { bytes: Buffer; stat: BigIntStats };
type Captured = { head: Head; commit: Commit; receipt: DependencyReceipt };
const encode = (value: unknown): Buffer => Buffer.from(JSON.stringify(value) + "\n");
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const identity = (stat: BigIntStats): DependencyTreeIdentity => ({ dev: String(stat.dev), ino: String(stat.ino) });
const same = (left: BigIntStats, right: BigIntStats): boolean => sameDependencyTree(identity(left), identity(right)) &&
  left.mode === right.mode && left.uid === right.uid && left.nlink === right.nlink && left.size === right.size &&
  left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;

/** Immutable receipt+commit history, with a synced replaceable head. Files are
 * protected by caller-selected private storage, never a worker claim. Hash-linked
 * commit references pin predecessor bytes AND inode; history is not pruned here.
 * A failed publication retains its mutex/partials for explicit reconciliation.
 */
export class LocalDependencyReceiptStore implements DependencyReceiptStore {
  private closed = false;
  private constructor(private readonly rootPath: string, private readonly root: number, private readonly rootIdentity: BigIntStats,
    private readonly rootMount: string, private readonly maxRecordBytes: number, private readonly maxHistorySteps: number) {}

  static open(input: { readonly rootPath: string; readonly maxRecordBytes: number; readonly maxHistorySteps: number }): LocalDependencyReceiptStore {
    if (process.platform !== "linux" || statfsSync("/proc/self/fd", { bigint: true }).type !== 0x9fa0n) fail(Failure.Unsupported);
    if (!isAbsolute(input.rootPath) || resolve(input.rootPath) !== input.rootPath || input.rootPath.includes("\0") ||
      ![input.maxRecordBytes, input.maxHistorySteps].every(n => Number.isSafeInteger(n) && n > 0)) fail(Failure.InvalidConfig);
    if (realpathSync(input.rootPath) !== input.rootPath) fail(Failure.UnsafeRoot);
    const root = openSync(input.rootPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(root, { bigint: true });
      if (!stat.isDirectory() || !privateMode(stat, 0o700n) || !same(stat, lstatSync(input.rootPath, { bigint: true }))) fail(Failure.UnsafeRoot);
      return new LocalDependencyReceiptStore(input.rootPath, root, stat, mount(root), input.maxRecordBytes, input.maxHistorySteps);
    } catch (error) { closeSync(root); throw error; }
  }

  read(workspace: DependencyWorkspaceIdentity): DependencyReceipt | null {
    return this.publicRead(workspace, key => this.capture(workspace, key)?.receipt ?? null);
  }

  getCommittedAbsent(workspace: DependencyWorkspaceIdentity, revision: number): DependencyCommittedAbsentReceipt {
    if (!Number.isSafeInteger(revision) || revision < 1) fail(Failure.InvalidReceipt);
    return this.publicRead(workspace, key => {
      const current = this.capture(workspace, key);
      if (!current || revision > current.receipt.revision) fail(Failure.StaleRevision);
      let ref = current.head.commit, expected = current.receipt.revision;
      for (let step = 0; step < this.maxHistorySteps; step++) {
        const commit = this.readCommit(workspace, key, expected, ref);
        const receipt = this.readReceipt(workspace, key, expected, commit.receipt);
        if (expected === revision) {
          if (receipt.state !== State.Absent) fail(Failure.InvalidReceipt);
          return { receipt, reference: { path: join(this.rootPath, commit.receipt.name),
            identity: { ...commit.receipt.identity }, sha256: commit.receipt.sha256 } };
        }
        if (!commit.previous) fail(Failure.Corrupt);
        ref = commit.previous; expected--;
      }
      return fail(Failure.Bounds);
    });
  }

  compareAndSwap(workspace: DependencyWorkspaceIdentity, expectedRevision: number | null, next: DependencyReceipt): DependencyReceipt {
    const key = this.key(workspace); let receipt: DependencyReceipt;
    try { receipt = parsed(JSON.parse(encode(next).toString("utf8"))); } catch { return fail(Failure.InvalidReceipt); }
    if (!sameDependencyWorkspace(receipt.workspace, workspace)) fail(Failure.WorkspaceChanged);
    if (expectedRevision !== null && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) fail(Failure.InvalidReceipt);
    const bytes = encode(receipt);
    if (detectSecretLikeContent(bytes.toString("utf8"))) fail(Failure.InvalidReceipt);
    if (bytes.length > this.maxRecordBytes) fail(Failure.Bounds);
    this.assertRoot();
    let mutex: number;
    try { mutex = openSync(this.path(`${key}.lock`), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) { if (code(error, "EEXIST")) fail(Failure.Busy); throw error; }
    let mutexIdentity: BigIntStats | undefined, started = false, complete = false;
    try {
      mutexIdentity = fstatSync(mutex, { bigint: true }); this.privateLeaf(mutexIdentity, mount(mutex));
      const current = this.underMutex(key, mutexIdentity, () => this.capture(workspace, key));
      if ((current?.receipt.revision ?? null) !== expectedRevision) fail(Failure.StaleRevision);
      transition(current?.receipt ?? null, receipt);
      const receiptName = `${key}.r${receipt.revision}-${sha(bytes)}.receipt.json`;
      const temporaryName = `${key}.pending-${randomUUID()}`;
      started = true;
      writeFileSync(mutex, encode({ version: 1, expectedRevision, nextRevision: receipt.revision, receiptName, temporaryName }));
      fsyncSync(mutex); fsyncSync(this.root);
      const receiptRef = this.publishImmutable(receiptName, bytes);
      const commit: Commit = { version: 1, workspace: receipt.workspace, revision: receipt.revision, receipt: receiptRef,
        previous: current?.head.commit ?? null };
      const commitBytes = encode(commit);
      const commitRef = this.publishImmutable(`${key}.r${receipt.revision}-${sha(commitBytes)}.commit.json`, commitBytes);
      const head: Head = { version: 1, workspace: receipt.workspace, revision: receipt.revision, commit: commitRef };
      // A durable first-head anchor distinguishes never-created state from a
      // lost current pointer. Head loss must not restart revision/history at one.
      if (!current) this.publishImmutable(`${key}.birth.json`, encode(head));
      const temporaryRef = this.publishImmutable(temporaryName, encode(head));
      this.underMutex(key, mutexIdentity, () => {
        const before = this.capture(workspace, key, current === null);
        if (JSON.stringify(before?.head ?? null) !== JSON.stringify(current?.head ?? null)) fail(Failure.StaleRevision);
        const temporary = this.readLeaf(temporaryName);
        if (!temporary || !sameDependencyTree(identity(temporary.stat), temporaryRef.identity) || sha(temporary.bytes) !== temporaryRef.sha256) fail(Failure.UnsafeStore);
        renameSync(this.path(temporaryName), this.path(`${key}.json`)); fsyncSync(this.root);
      });
      const after = this.underMutex(key, mutexIdentity, () => this.capture(workspace, key));
      if (!after || JSON.stringify(after.head) !== JSON.stringify(head)) fail(Failure.Corrupt);
      complete = true; return after.receipt;
    } finally {
      closeSync(mutex);
      if (mutexIdentity && (!started || complete)) {
        this.assertRoot(); this.ownedMutex(key, mutexIdentity); unlinkSync(this.path(`${key}.lock`)); fsyncSync(this.root);
      }
    }
  }

  close(): void { if (!this.closed) { this.closed = true; closeSync(this.root); } }
  private publicRead<T>(workspace: DependencyWorkspaceIdentity, read: (key: string) => T): T {
    const key = this.key(workspace); this.assertRoot(); this.noMutex(key);
    const result = read(key); this.assertRoot(); this.noMutex(key); return result;
  }
  private underMutex<T>(key: string, expected: BigIntStats, operation: () => T): T {
    this.assertRoot(); this.ownedMutex(key, expected); const result = operation();
    this.assertRoot(); this.ownedMutex(key, expected); return result;
  }
  private capture(workspace: DependencyWorkspaceIdentity, key: string, unpublishedBirth = false): Captured | null {
    const leaf = this.readLeaf(`${key}.json`), birth = this.readLeaf(`${key}.birth.json`);
    if (!leaf) {
      if (birth && !unpublishedBirth) fail(Failure.Corrupt);
      return null;
    }
    if (!birth) fail(Failure.Corrupt);
    const first = decode(birth.bytes);
    if (!encode(first).equals(birth.bytes)) fail(Failure.Corrupt);
    exact(first, ["version", "workspace", "revision", "commit"]);
    const firstHead = first as unknown as Head;
    this.metadata(firstHead, workspace);
    if (firstHead.revision !== 1) fail(Failure.Corrupt);
    this.readCommit(workspace, key, 1, firstHead.commit);
    const value = decode(leaf.bytes);
    if (!encode(value).equals(leaf.bytes)) fail(Failure.Corrupt);
    exact(value, ["version", "workspace", "revision", "commit"]);
    const head = value as unknown as Head;
    this.metadata(head, workspace);
    if (head.revision === 1 && JSON.stringify(head) !== JSON.stringify(firstHead)) fail(Failure.Corrupt);
    const commit = this.readCommit(workspace, key, head.revision, head.commit);
    return { head, commit, receipt: this.readReceipt(workspace, key, head.revision, commit.receipt) };
  }
  private metadata(value: { version: number; workspace: DependencyWorkspaceIdentity; revision: number }, workspace: DependencyWorkspaceIdentity): void {
    if (value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1) fail(Failure.Corrupt);
    workspaceKey(value.workspace);
    if (!sameDependencyWorkspace(value.workspace, workspace)) fail(Failure.WorkspaceChanged);
  }
  private readCommit(workspace: DependencyWorkspaceIdentity, key: string, revision: number, ref: Reference): Commit {
    const leaf = this.referenced(key, revision, "commit", ref), value = decode(leaf.bytes);
    if (!encode(value).equals(leaf.bytes)) fail(Failure.Corrupt);
    exact(value, ["version", "workspace", "revision", "receipt", "previous"]);
    const commit = value as unknown as Commit; this.metadata(commit, workspace);
    if (commit.revision !== revision || (revision === 1 ? commit.previous !== null : commit.previous === null)) fail(Failure.Corrupt);
    if (commit.previous !== null) reference(key, revision - 1, "commit", commit.previous);
    reference(key, revision, "receipt", commit.receipt);
    return commit;
  }
  private readReceipt(workspace: DependencyWorkspaceIdentity, key: string, revision: number, ref: Reference): DependencyReceipt {
    const leaf = this.referenced(key, revision, "receipt", ref), receipt = parsed(decode(leaf.bytes));
    if (receipt.revision !== revision || !sameDependencyWorkspace(receipt.workspace, workspace) || !encode(receipt).equals(leaf.bytes)) fail(Failure.Corrupt);
    return receipt;
  }
  private referenced(key: string, revision: number, kind: "receipt" | "commit", ref: Reference): Leaf {
    reference(key, revision, kind, ref);
    const leaf = this.readLeaf(ref.name);
    if (!leaf || !sameDependencyTree(identity(leaf.stat), ref.identity) || sha(leaf.bytes) !== ref.sha256) fail(Failure.Corrupt);
    return leaf;
  }
  private publishImmutable(name: string, bytes: Buffer): Reference {
    if (bytes.length > this.maxRecordBytes) fail(Failure.Bounds);
    this.assertRoot();
    const fd = openSync(this.path(name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let stat: BigIntStats;
    try { stat = fstatSync(fd, { bigint: true }); this.privateLeaf(stat, mount(fd)); writeFileSync(fd, bytes); fsyncSync(fd); }
    finally { closeSync(fd); }
    fsyncSync(this.root);
    const leaf = this.readLeaf(name);
    if (!leaf || !sameDependencyTree(identity(leaf.stat), identity(stat)) || !leaf.bytes.equals(bytes)) fail(Failure.UnsafeStore);
    return { name, identity: identity(leaf.stat), sha256: sha(bytes) };
  }
  private readLeaf(name: string): Leaf | null {
    const path = this.path(name); let observed: BigIntStats;
    try { observed = lstatSync(path, { bigint: true }); } catch (error) { if (code(error, "ENOENT")) return null; throw error; }
    this.privateLeaf(observed, this.rootMount);
    if (observed.size < 1n || observed.size > BigInt(this.maxRecordBytes)) fail(Failure.Bounds);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = fstatSync(fd, { bigint: true }); this.privateLeaf(before, mount(fd));
      if (!same(before, observed)) fail(Failure.UnsafeStore);
      const bytes = Buffer.alloc(Number(before.size)); let offset = 0;
      while (offset < bytes.length) { const count = readSync(fd, bytes, offset, bytes.length - offset, offset); if (!count) fail(Failure.Corrupt); offset += count; }
      if (readSync(fd, Buffer.alloc(1), 0, 1, offset) || !same(before, fstatSync(fd, { bigint: true })) ||
        !same(before, lstatSync(path, { bigint: true }))) fail(Failure.UnsafeStore);
      return { bytes, stat: before };
    } finally { closeSync(fd); }
  }
  private privateLeaf(stat: BigIntStats, mountId: string): void {
    if (!stat.isFile() || stat.nlink !== 1n || stat.dev !== this.rootIdentity.dev || mountId !== this.rootMount || !privateMode(stat, 0o600n)) fail(Failure.UnsafeStore);
  }
  private assertRoot(): void {
    if (this.closed) fail(Failure.Closed);
    const observed = lstatSync(this.rootPath, { bigint: true }), retained = fstatSync(this.root, { bigint: true });
    if (!observed.isDirectory() || !privateMode(observed, 0o700n) || !sameDependencyTree(identity(observed), identity(this.rootIdentity)) ||
      !sameDependencyTree(identity(retained), identity(this.rootIdentity)) || !privateMode(retained, 0o700n) || realpathSync(this.rootPath) !== this.rootPath) fail(Failure.UnsafeRoot);
    const fresh = openSync(this.rootPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const current = fstatSync(fresh, { bigint: true });
      if (!sameDependencyTree(identity(current), identity(this.rootIdentity)) || !privateMode(current, 0o700n) ||
        mount(fresh) !== this.rootMount || mount(this.root) !== this.rootMount) fail(Failure.UnsafeRoot);
    }
    finally { closeSync(fresh); }
  }
  private key(workspace: DependencyWorkspaceIdentity): string { if (this.closed) fail(Failure.Closed); return workspaceKey(workspace); }
  private path(name: string): string { return join(`/proc/self/fd/${this.root}`, name); }
  private noMutex(key: string): void {
    try { lstatSync(this.path(`${key}.lock`)); } catch (error) { if (code(error, "ENOENT")) return; throw error; }
    fail(Failure.Busy);
  }
  private ownedMutex(key: string, expected: BigIntStats): void {
    const fd = openSync(this.path(`${key}.lock`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const current = fstatSync(fd, { bigint: true }); this.privateLeaf(current, mount(fd));
      if (!sameDependencyTree(identity(current), identity(expected))) fail(Failure.UnsafeStore);
    } finally { closeSync(fd); }
  }
}

function transition(previous: DependencyReceipt | null, next: DependencyReceipt): void {
  if (next.revision !== (previous?.revision ?? 0) + 1) fail(Failure.StaleRevision);
  if (!previous) {
    if (next.state === State.Unverified || (next.state === State.Installing && next.preservation.kind === Preserve.KnownFreshAbsence)) return;
    fail(Failure.InvalidTransition);
  }
  if (!sameDependencyWorkspace(previous.workspace, next.workspace) || previous.coverageRevision !== next.coverageRevision) fail(Failure.InvalidTransition);
  if (previous.state === State.Unverified && next.state === State.Installing && next.generation !== previous.generation &&
    next.preservation.kind === Preserve.CommittedPreservation && sameDependencyTree(previous.tree, next.preservation.originalTree)) return;
  if (previous.generation !== next.generation) fail(Failure.InvalidTransition);
  if (previous.state === State.Installing && next.state === State.Ready && next.provenance.kind === Install.CompletedInstall &&
    next.provenance.operationId === previous.operationId && next.installKey === previous.requestedKey) return;
  if (previous.state === State.Unverified && next.state === State.Ready && next.provenance.kind === Install.LegacyCompared && sameDependencyTree(previous.tree, next.tree)) return;
  if (previous.state === State.Ready && next.state === State.Unverified &&
    (sameDependencyTree(previous.tree, next.tree) || next.reason === DependencyUnverifiedReason.TreeChanged)) return;
  if (previous.state === State.Ready && next.state === State.Evicting && previous.installKey === next.installKey &&
    previous.manifestDigest === next.manifestDigest && sameDependencyTree(previous.tree, next.tree)) return;
  if (previous.state === State.Evicting && next.state === State.Absent && previous.operationId === next.operationId &&
    previous.installKey === next.installKey && previous.manifestDigest === next.evictionCommit.manifestDigest &&
    sameDependencyTree(previous.tree, next.evictionCommit.tree) && sameDependencyTree(previous.trash.originalTree, next.evictionCommit.trash.originalTree) &&
    sameDependencyWorkspace(previous.trash.destinationParent, next.evictionCommit.trash.destinationParent) &&
    previous.trash.operationId === next.evictionCommit.trash.operationId && previous.trash.destinationName === next.evictionCommit.trash.destinationName) return;
  // Absent->Installing requires a distinct committed-absence preservation proof,
  // absent from the current domain. Never relabel an evicted tree as fresh absence.
  fail(Failure.InvalidTransition);
}
function parsed(value: unknown): DependencyReceipt {
  const result = parseDependencyReceipt(value); if (result.status !== DependencyReceiptParseStatus.Valid) fail(Failure.InvalidReceipt); return result.receipt;
}
function workspaceKey(workspace: DependencyWorkspaceIdentity): string {
  if (!workspace || Object.keys(workspace).sort().join(",") !== "canonicalPath,dev,ino" ||
    typeof workspace.canonicalPath !== "string" || !isAbsolute(workspace.canonicalPath) || resolve(workspace.canonicalPath) !== workspace.canonicalPath ||
    workspace.canonicalPath.length > 1024 || /[\x00-\x1f\x7f]/.test(workspace.canonicalPath) ||
    Buffer.from(workspace.canonicalPath).toString() !== workspace.canonicalPath ||
    ![workspace.dev, workspace.ino].every(n => typeof n === "string" && /^(0|[1-9][0-9]*)$/.test(n) && n.length <= 40)) fail(Failure.InvalidReceipt);
  return `${workspace.dev}-${workspace.ino}`;
}
export function dependencyReceiptStorageName(workspace: DependencyWorkspaceIdentity): string { return `${workspaceKey(workspace)}.json`; }
function reference(key: string, revision: number, kind: "receipt" | "commit", value: Reference): void {
  if (!value || typeof value !== "object" || Object.keys(value).sort().join(",") !== "identity,name,sha256" ||
    typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256) || value.name !== `${key}.r${revision}-${value.sha256}.${kind}.json` ||
    !value.identity || Object.keys(value.identity).sort().join(",") !== "dev,ino" ||
    ![value.identity.dev, value.identity.ino].every(n => typeof n === "string" && /^(0|[1-9][0-9]*)$/.test(n) && n.length <= 40)) fail(Failure.Corrupt);
}
function decode(bytes: Buffer): Record<string, unknown> {
  try { const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(Failure.Corrupt); return value as Record<string, unknown>; }
  catch { return fail(Failure.Corrupt); }
}
function exact(value: Record<string, unknown>, names: readonly string[]): void {
  if (Object.keys(value).length !== names.length || !names.every(name => Object.hasOwn(value, name))) fail(Failure.Corrupt);
}
function privateMode(stat: BigIntStats, mode: bigint): boolean { return stat.uid === BigInt(process.geteuid!()) && (stat.mode & 0o7777n) === mode; }
function mount(fd: number): string {
  const info = readFileSync(`/proc/self/fdinfo/${fd}`, "utf8"), id = /^mnt_id:\s*(\d+)\s*$/m.exec(info)?.[1];
  if (!id || info.length > 65536) fail(Failure.UnsafeStore); return id;
}
function code(error: unknown, expected: string): boolean { return !!error && typeof error === "object" && "code" in error && error.code === expected; }
