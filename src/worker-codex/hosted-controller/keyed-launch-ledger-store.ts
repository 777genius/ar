import { assertRuntimeValidatedTermination } from "./scoped-termination-validation";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, readdirSync,
  writeFileSync, type Stats } from "node:fs";
import { basename, dirname, join } from "node:path";
import { assertHostedActivationFence, assertHostedActivationOperator, withHostedActivationFence,
  type HostedActivationFence } from "@vioxen/subscription-runtime/provider-codex";
import { KeyedChildLedger, KeyedChildState, keyedTerminalAuthority, keyedChildSnapshotMaxBytes, type ChildScope, type ChildSlotAllocation,
  type ReviewedChildAuthority } from "../../worker-core/project-control/domain/keyed-child-launch";
import type { KeyedChildLedgerTransactionPort } from "../../worker-core/project-control/ports/keyed-child-launch-ports";
import { archiveKeyedLedgerFiles, exchangeKeyedLedgerFiles } from "./keyed-ledger-linux-publication";

const root = "/var/lib/subscription-runtime-host-policy/keyed-child-ledgers";
const sameInode = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
function privateFile(s: Stats): void {
  if (!s.isFile() || s.uid !== 0 || s.nlink !== 1 || (s.mode & 0o7777) !== 0o600 ||
      s.size > keyedChildSnapshotMaxBytes) throw new Error("keyed_ledger_private_file_required");
}

/** Trusted host composition alone supplies authority/slots. No path input or
 * model-facing constructor. Host preparation must durably create the fixed
 * root and call initialize with a live common fence before any effects.
 *
 * Caller must own controller/workspace coordination before transact; this
 * adapter then acquires the common host fence for read/validate/publish. The
 * callback is synchronous and effect-free; the Promise resolves only after
 * durable publication. No await, retry, submission permit,
 * generic recovery or stale-lock takeover occurs here. Pending bytes always
 * require separate host investigation and prevent all reads/updates. */
export class KeyedLaunchLedgerStore implements KeyedChildLedgerTransactionPort {
  readonly #seed: KeyedChildLedger;
  readonly #scope: ChildScope;
  readonly #path: string;
  readonly #birth: string;
  readonly #next: string;
  readonly #hold: string;
  readonly #parent: Stats;

  constructor(authority: ReviewedChildAuthority, slots: readonly ChildSlotAllocation[]) {
    this.#seed = KeyedChildLedger.create(authority, slots);
    this.#scope = Object.freeze({ projectId: authority.projectId, workstreamId: authority.workstreamId,
      controllerId: authority.controllerId });
    const name = createHash("sha256").update(JSON.stringify(["keyed-child-scope", 1,
      this.#scope.projectId, this.#scope.workstreamId, this.#scope.controllerId])).digest("hex");
    this.#path = join(root, name + ".json"); this.#birth = join(root, name + ".birth");
    this.#next = join(root, name + ".next"); this.#hold = join(root, name + ".hold");
    assertHostedActivationOperator();
    // Pin the host-provisioned directory without opening any ledger record.
    // Private readers later check ancestry after scope/fence authentication.
    this.#parent = lstatSync(root);
    this.#checkParent();
    Object.freeze(this);
  }
  #authenticate(scope: ChildScope, authorityDigest: string): void {
    if (scope.projectId !== this.#scope.projectId || scope.workstreamId !== this.#scope.workstreamId ||
        scope.controllerId !== this.#scope.controllerId || authorityDigest !== this.#seed.authorityDigest) {
      throw new Error("keyed_ledger_foreign_authority");
    }
  }
  #checkParent(): void {
    const stat = lstatSync(root);
    if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o077) ||
        !sameInode(stat, this.#parent)) throw new Error("keyed_ledger_parent_changed");
  }
  #fenced<T>(fence: HostedActivationFence, action: (parent: number, ancestors: readonly number[]) => T): T {
    assertHostedActivationFence(fence); assertHostedActivationOperator();
    const ancestry: { path: string; stat: Stats }[] = [];
    for (let directory = root;; directory = dirname(directory)) {
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022)) throw new Error("keyed_ledger_private_parent_required");
      if (directory !== root) ancestry.push({ path: directory, stat });
      if (directory === "/") break;
    }
    this.#checkParent();
    const parent = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const ancestors: number[] = [];
    try {
      if (!sameInode(fstatSync(parent), this.#parent)) throw new Error("keyed_ledger_parent_changed");
      // Pin every ancestor before any data write; initialization fsync never
      // reopens a mutable absolute parent after publication has started.
      for (const directory of ancestry) {
        const fd = openSync(directory.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        ancestors.push(fd);
        if (!sameInode(fstatSync(fd), directory.stat)) throw new Error("keyed_ledger_parent_changed");
      }
      const result = action(parent, ancestors); this.#checkParent(); return result;
    } finally { for (const fd of ancestors) closeSync(fd); closeSync(parent); }
  }
  #anchored(path: string, parent: number): string {
    // Linux procfs resolves the already verified directory descriptor. No
    // mutable absolute parent is traversed for any record operation.
    return `/proc/self/fd/${parent}/${basename(path)}`;
  }
  #bytes(fd: number): Buffer {
    const before = fstatSync(fd); privateFile(before);
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, length);
      if (!count) break;
      length += count;
    }
    const after = fstatSync(fd); privateFile(after);
    if (length !== before.size || after.size !== before.size || after.ctimeMs !== before.ctimeMs ||
        after.mtimeMs !== before.mtimeMs) throw new Error("keyed_ledger_file_changed");
    return bytes.subarray(0, length);
  }
  #read(path: string, parent: number): Buffer | null {
    this.#checkParent();
    let fd: number;
    try { fd = openSync(this.#anchored(path, parent), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    try {
      const bytes = this.#bytes(fd);
      if (!sameInode(fstatSync(fd), lstatSync(this.#anchored(path, parent)))) throw new Error("keyed_ledger_file_changed");
      this.#checkParent(); return bytes;
    } finally { closeSync(fd); }
  }
  #syncFile(path: string, bytes: Buffer, parent: number): Stats {
    const fd = openSync(this.#anchored(path, parent), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = fstatSync(fd); privateFile(opened);
      if (!this.#bytes(fd).equals(bytes)) throw new Error("keyed_ledger_file_changed");
      fsyncSync(fd);
      const synced = fstatSync(fd); privateFile(synced);
      if (!this.#bytes(fd).equals(bytes) || synced.size !== opened.size ||
          synced.ctimeMs !== opened.ctimeMs || synced.mtimeMs !== opened.mtimeMs ||
          !sameInode(opened, lstatSync(this.#anchored(path, parent)))) throw new Error("keyed_ledger_file_changed");
      this.#checkParent(); return opened;
    } finally { closeSync(fd); }
  }
  #verifyTarget(bytes: Buffer, expected: Stats, parent: number): void {
    // Read after the LAST durability action, without introducing another fsync
    // interval. This is interleaving detection, not inode-conditional CAS.
    this.#checkParent();
    const fd = openSync(this.#anchored(this.#path, parent), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const actualBytes = this.#bytes(fd);
      const opened = fstatSync(fd); privateFile(opened);
      if (!actualBytes.equals(bytes) || !sameInode(expected, opened) ||
          opened.size !== expected.size || opened.ctimeMs !== expected.ctimeMs ||
          opened.mtimeMs !== expected.mtimeMs ||
          !sameInode(opened, lstatSync(this.#anchored(this.#path, parent)))) {
        throw new Error("keyed_ledger_file_changed");
      }
      this.#checkParent();
    } finally { closeSync(fd); }
  }
  #create(path: string, bytes: Buffer, parent: number): Stats {
    this.#checkParent();
    // O_EXCL refuses every preexisting inode, including exactly matching
    // retained pending bytes. Only explicit host recovery may resolve those.
    const fd = openSync(this.#anchored(path, parent), constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      privateFile(fstatSync(fd)); // Validate the opened inode BEFORE task bytes.
      writeFileSync(fd, bytes); fsyncSync(fd);
      const opened = fstatSync(fd);
      if (!this.#bytes(fd).equals(bytes) || !sameInode(opened, lstatSync(this.#anchored(path, parent)))) {
        throw new Error("keyed_ledger_file_changed");
      }
      fsyncSync(parent); this.#checkParent(); return opened;
    } finally { closeSync(fd); } // Never remove partial publication on failure.
  }
  #noPending(parent: number): void {
    if (this.#read(this.#next, parent) !== null || this.#read(this.#hold, parent) !== null) {
      throw new Error("keyed_ledger_pending_publication");
    }
  }
  #current(parent: number): KeyedChildLedger {
    this.#noPending(parent);
    const seed = Buffer.from(this.#seed.serialize());
    if (!this.#read(this.#birth, parent)?.equals(seed)) throw new Error("keyed_ledger_birth_required");
    const bytes = this.#read(this.#path, parent);
    if (!bytes) throw new Error("keyed_ledger_existing_state_required");
    const current = KeyedChildLedger.restore(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes), this.#seed);
    if (!bytes.equals(Buffer.from(current.serialize()))) throw new Error("keyed_ledger_noncanonical_bytes");
    // Archived obligations are immutable high-water evidence. A replaced seed
    // or older canonical target cannot silently discard accepted history.
    const prefix = basename(this.#path).slice(0, -5) + ".history.";
    const priorPrefix = basename(this.#path).slice(0, -5) + ".previous.";
    let latest = 0;
    for (const name of readdirSync(`/proc/self/fd/${parent}`)) {
      const selected = name.startsWith(prefix) ? prefix : name.startsWith(priorPrefix) ? priorPrefix : null;
      if (!selected) continue;
      const generation = name.slice(selected.length);
      if (!/^[1-9][0-9]*$/.test(generation) || !Number.isSafeInteger(Number(generation))) {
        throw new Error("keyed_ledger_invalid_history");
      }
      latest = Math.max(latest, Number(generation));
    }
    if (latest && (current.generation !== latest ||
        !this.#read(join(root, prefix + latest), parent)?.equals(bytes))) {
      throw new Error("keyed_ledger_history_conflict");
    }
    const synced = this.#syncFile(this.#path, bytes, parent); fsyncSync(parent);
    this.#verifyTarget(bytes, synced, parent); return current;
  }
  /** Explicit first enrollment. Birth survives loss of the mutable file, so a
   * missing/corrupt existing ledger can never become a fresh empty aggregate. */
  initialize(fence: HostedActivationFence): KeyedChildLedger {
    return this.#fenced(fence, (parent, ancestors) => {
      this.#noPending(parent);
      const name = basename(this.#path).slice(0, -5);
      if (this.#read(this.#birth, parent) !== null || this.#read(this.#path, parent) !== null ||
          readdirSync(`/proc/self/fd/${parent}`).some(file =>
            file.startsWith(name + ".history.") || file.startsWith(name + ".previous."))) return this.#current(parent);
      const bytes = Buffer.from(this.#seed.serialize());
      this.#create(this.#birth, bytes, parent);
      const created = this.#create(this.#path, bytes, parent);
      // Host preparation owns creation; reconfirm pinned ancestry durability.
      for (const fd of ancestors) fsyncSync(fd);
      this.#verifyTarget(bytes, created, parent); return this.#seed;
    });
  }
  async transact(scope: ChildScope, authorityDigest: string, expectedGeneration: number,
    successor: (current: KeyedChildLedger) => KeyedChildLedger): Promise<KeyedChildLedger> {
    this.#authenticate(scope, authorityDigest);
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) throw new Error("keyed_ledger_invalid_generation");
    return withHostedActivationFence(fence =>
      this.transactHeld(fence, scope, authorityDigest, expectedGeneration, successor));
  }
  /** Private same-fence composition: no Promise, acquisition or replay permit. */
  readHeld(fence: HostedActivationFence, scope: ChildScope, authorityDigest: string): KeyedChildLedger {
    this.#authenticate(scope, authorityDigest);
    return this.#fenced(fence, parent => this.#current(parent));
  }
  transactHeld(fence: HostedActivationFence, scope: ChildScope, authorityDigest: string,
    expectedGeneration: number, successor: (current: KeyedChildLedger) => KeyedChildLedger): KeyedChildLedger {
    // Authorization precedes even common-fence or target reads.
    this.#authenticate(scope, authorityDigest);
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) throw new Error("keyed_ledger_invalid_generation");
    return this.#fenced(fence, parent => {
      const current = this.#current(parent);
      if (current.generation !== expectedGeneration) throw new Error("keyed_ledger_stale_generation");
      const prior = this.#syncFile(this.#path, Buffer.from(current.serialize()), parent);
      const next = successor(current);
      if (next && (typeof next === "object" || typeof next === "function") && "then" in next) {
        throw new Error("keyed_ledger_synchronous_callback_required");
      }
      current.assertSuccessor(next);
      for (const child of next.snapshot().accepted) {
        if (child.dispatchIntent && child.state === KeyedChildState.Terminal) {
          const priorChild = current.observe(this.#scope, child.allocation.childHandle);
          if (priorChild.state === KeyedChildState.Terminal) continue;
          const authority = keyedTerminalAuthority(next);
          if (!authority) throw new Error("scoped_terminal_authority_required");
          assertRuntimeValidatedTermination(authority, priorChild, child.dispatchIntent.generation);
        }
      }
      const bytes = Buffer.from(next.serialize());
      KeyedChildLedger.restore(bytes.toString("utf8"), this.#seed);
      this.#checkParent(); this.#noPending(parent);
      if (next.serialize() === current.serialize()) {
        const synced = this.#syncFile(this.#path, bytes, parent); fsyncSync(parent);
        this.#verifyTarget(bytes, synced, parent); return current;
      }
      const oldBytes = Buffer.from(current.serialize());
      const staged = this.#create(this.#next, bytes, parent);
      // Independently durable intent survives substitution of either exchange
      // operand. Never promote this retained obligation automatically.
      const retained = this.#create(this.#hold, bytes, parent);
      if (!sameInode(prior, this.#syncFile(this.#path, oldBytes, parent))) throw new Error("keyed_ledger_file_changed");
      exchangeKeyedLedgerFiles(parent, basename(this.#path));
      fsyncSync(parent);
      // EXCHANGE preserves a foreign destination inode at .next on conflict.
      // This is detection with retained evidence, NOT an inode-conditional CAS
      // or protection against a malicious root repeatedly mutating all names.
      if (!sameInode(staged, this.#syncFile(this.#path, bytes, parent)) ||
          !sameInode(prior, this.#syncFile(this.#next, oldBytes, parent))) {
        throw new Error("keyed_ledger_publication_conflict");
      }
      this.#syncFile(this.#hold, bytes, parent); this.#checkParent();
      // Do not unlink a pathname after checking it: a substituted foreign
      // inode could be deleted. NOREPLACE archives both names without clobber,
      // and the successor history also prevents later target rollback.
      try {
        archiveKeyedLedgerFiles(parent, basename(this.#path), next.generation);
        const name = basename(this.#path).slice(0, -5);
        if (!sameInode(prior, this.#syncFile(join(root, `${name}.previous.${next.generation}`), oldBytes, parent)) ||
            !sameInode(retained, this.#syncFile(join(root, `${name}.history.${next.generation}`), bytes, parent))) {
          throw new Error("keyed_ledger_publication_conflict");
        }
        // Archival changes inode metadata. Pin the final live-file sync's
        // snapshot, rather than the pre-publication staging snapshot.
        const synced = this.#syncFile(this.#path, bytes, parent);
        if (!sameInode(staged, synced)) throw new Error("keyed_ledger_publication_conflict");
        fsyncSync(parent);
        this.#verifyTarget(bytes, synced, parent);
      } catch (error) {
        // Archive may have moved both guard names before failing. Reinstate a
        // no-clobber obligation; a partial guard also denies every future read.
        try { this.#create(this.#hold, bytes, parent); } catch { /* Existing guard or retained history; never overwrite. */ }
        throw error;
      }
      this.#checkParent(); return next;
    });
  }
}
