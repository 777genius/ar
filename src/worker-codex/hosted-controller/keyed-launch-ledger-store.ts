import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, renameSync,
  writeFileSync, type Stats } from "node:fs";
import { dirname, join } from "node:path";
import { assertHostedActivationFence, assertHostedActivationOperator, withHostedActivationFence,
  type HostedActivationFence } from "@vioxen/subscription-runtime/provider-codex";
import { KeyedChildLedger, keyedChildSnapshotMaxBytes, type ChildScope, type ChildSlotAllocation,
  type ReviewedChildAuthority } from "../../worker-core/project-control/domain/keyed-child-launch";
import type { KeyedChildLedgerTransactionPort } from "../../worker-core/project-control/ports/keyed-child-launch-ports";
import { readHostedPrivateBytes } from "../hosted-readonly-inputs";

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
  readonly #parent: Stats;

  constructor(authority: ReviewedChildAuthority, slots: readonly ChildSlotAllocation[]) {
    this.#seed = KeyedChildLedger.create(authority, slots);
    this.#scope = Object.freeze({ projectId: authority.projectId, workstreamId: authority.workstreamId,
      controllerId: authority.controllerId });
    const name = createHash("sha256").update(JSON.stringify(["keyed-child-scope", 1,
      this.#scope.projectId, this.#scope.workstreamId, this.#scope.controllerId])).digest("hex");
    this.#path = join(root, name + ".json"); this.#birth = join(root, name + ".birth");
    this.#next = join(root, name + ".next");
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
  #fenced<T>(fence: HostedActivationFence, action: (parent: number) => T): T {
    assertHostedActivationFence(fence); assertHostedActivationOperator(); this.#checkParent();
    const parent = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      if (!sameInode(fstatSync(parent), this.#parent)) throw new Error("keyed_ledger_parent_changed");
      const result = action(parent); this.#checkParent(); return result;
    } finally { closeSync(parent); }
  }
  #read(path: string): Buffer | null {
    this.#checkParent();
    const bytes = readHostedPrivateBytes(path, keyedChildSnapshotMaxBytes);
    if (bytes !== null) privateFile(lstatSync(path));
    this.#checkParent(); return bytes;
  }
  #syncFile(path: string, bytes: Buffer): void {
    const before = lstatSync(path); privateFile(before);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = fstatSync(fd); privateFile(opened);
      if (!sameInode(before, opened) || !this.#read(path)?.equals(bytes)) throw new Error("keyed_ledger_file_changed");
      fsyncSync(fd);
      if (!sameInode(opened, lstatSync(path))) throw new Error("keyed_ledger_file_changed");
    } finally { closeSync(fd); }
  }
  #create(path: string, bytes: Buffer, parent: number): void {
    this.#checkParent();
    let fd: number;
    try { fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!this.#read(path)?.equals(bytes)) throw new Error("keyed_ledger_publication_conflict");
      this.#syncFile(path, bytes); fsyncSync(parent); return;
    }
    // Never remove a partial publication on failure.
    try { privateFile(fstatSync(fd)); writeFileSync(fd, bytes); fsyncSync(fd); }
    finally { closeSync(fd); }
    if (!this.#read(path)?.equals(bytes)) throw new Error("keyed_ledger_file_changed");
    fsyncSync(parent); this.#checkParent();
  }
  #noPending(): void {
    if (this.#read(this.#next) !== null) throw new Error("keyed_ledger_pending_publication");
  }
  #current(parent: number): KeyedChildLedger {
    this.#noPending();
    const seed = Buffer.from(this.#seed.serialize());
    if (!this.#read(this.#birth)?.equals(seed)) throw new Error("keyed_ledger_birth_required");
    const bytes = this.#read(this.#path);
    if (!bytes) throw new Error("keyed_ledger_existing_state_required");
    const current = KeyedChildLedger.restore(new TextDecoder("utf-8", { fatal: true }).decode(bytes), this.#seed);
    // An interrupted post-rename directory sync is reconfirmed before return.
    this.#syncFile(this.#path, bytes); fsyncSync(parent); return current;
  }
  /** Explicit first enrollment. Birth survives loss of the mutable file, so a
   * missing/corrupt existing ledger can never become a fresh empty aggregate. */
  initialize(fence: HostedActivationFence): KeyedChildLedger {
    return this.#fenced(fence, parent => {
      this.#noPending();
      if (this.#read(this.#birth) !== null || this.#read(this.#path) !== null) return this.#current(parent);
      const bytes = Buffer.from(this.#seed.serialize());
      this.#create(this.#birth, bytes, parent);
      this.#create(this.#path, bytes, parent);
      // Host preparation owns directory creation; reconfirm ancestry durability.
      for (let directory = dirname(root);; directory = dirname(directory)) {
        const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try { fsyncSync(fd); } finally { closeSync(fd); }
        if (directory === "/") break;
      }
      return this.#seed;
    });
  }
  async transact(scope: ChildScope, authorityDigest: string, expectedGeneration: number,
    successor: (current: KeyedChildLedger) => KeyedChildLedger): Promise<KeyedChildLedger> {
    // Authorization precedes even common-fence or target reads.
    this.#authenticate(scope, authorityDigest);
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) throw new Error("keyed_ledger_invalid_generation");
    return withHostedActivationFence(fence => this.#fenced(fence, parent => {
      const current = this.#current(parent);
      if (current.generation !== expectedGeneration) throw new Error("keyed_ledger_stale_generation");
      const next = successor(current);
      if (next && (typeof next === "object" || typeof next === "function") && "then" in next) {
        throw new Error("keyed_ledger_synchronous_callback_required");
      }
      current.assertSuccessor(next);
      const bytes = Buffer.from(next.serialize());
      KeyedChildLedger.restore(bytes.toString("utf8"), this.#seed);
      this.#checkParent(); this.#noPending();
      if (next.serialize() === current.serialize()) {
        this.#syncFile(this.#path, bytes); fsyncSync(parent); return current;
      }
      const prior = lstatSync(this.#path);
      this.#create(this.#next, bytes, parent);
      // A changed final name is never overwritten, even under the host fence.
      if (!sameInode(prior, lstatSync(this.#path)) ||
          !this.#read(this.#path)?.equals(Buffer.from(current.serialize()))) throw new Error("keyed_ledger_file_changed");
      this.#checkParent(); renameSync(this.#next, this.#path); fsyncSync(parent);
      this.#checkParent(); return next;
    }));
  }
}
