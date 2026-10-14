import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync,
  realpathSync, writeFileSync, type Stats } from "node:fs";
import { dirname } from "node:path";
import { assertHostedActivationFence, type HostedActivationFence } from "@vioxen/subscription-runtime/provider-codex";
import { stableChildDigest } from "../../worker-core/hosted-custody/domain/scoped-termination";
import { PreparationEffect, type OriginalPreparationOwner } from "../../worker-core/hosted-custody/domain/preintent-preparation";
import type { ChildCorrelation } from "../../worker-core/project-control/domain/keyed-child-launch";
import { ScopedStopReason } from "../../worker-core/project-control/ports/keyed-child-application-ports";
import { RetainedKeyedAuthority } from "./retained-authority";

const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const encode = (value: unknown) => Buffer.from(JSON.stringify(value) + "\n");
interface OwnershipRecord {
  readonly schemaVersion: 1;
  readonly identityDigest: string;
  readonly preparationGeneration: number;
  readonly deadlineEpochMs: number;
  readonly maxGoalTurns: number;
  readonly slotDigest: string;
  readonly preparationPlanDigest: string;
}
interface ClosureRecord {
  readonly schemaVersion: 1;
  readonly ownershipDigest: string;
  readonly preparationGeneration: number;
  readonly closureGeneration: number;
  readonly reason: ScopedStopReason;
}
/** Sanitized durable obligations only. This does not prove native quiescence,
 * complete dispatch inventory or terminal authority. Missing prefixes are data,
 * never a NeverCreated disposition. */
export interface ClosedPreparationRecordInventory {
  readonly identityDigest: string;
  readonly ownershipDigest: string;
  readonly preparationGeneration: number;
  readonly closureGeneration: number;
  readonly ledgerGeneration: number;
  readonly closureDigest: string;
  readonly prefixDigests: Readonly<Record<PreparationEffect, string | null>>;
  readonly inventoryDigest: string;
}

/** Fixed per-slot create-only records. Partial writes remain obligations;
 * reconstruction reads original bytes and never creates another admission. */
export class PreintentPreparationRecords {
  readonly #parents = new Map<string, Stats>();
  constructor(private readonly retained: RetainedKeyedAuthority) {
    RetainedKeyedAuthority.prototype.assertCleanup.call(retained);
    for (const slot of retained.slots) for (let path = slot.jobRootDir;; path = dirname(path)) {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022) || realpathSync(path) !== path) fail();
      this.#parents.set(path, stat);
      if (path === "/") break;
    }
  }
  #check(): void {
    RetainedKeyedAuthority.prototype.assertCleanup.call(this.retained);
    for (const [path, pinned] of this.#parents) {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022) ||
          !same(stat, pinned) || realpathSync(path) !== path) fail();
    }
  }
  #withParent<T>(binding: ChildCorrelation, action: (parent: number) => T): T {
    this.#check();
    const allocation = this.retained.seed.snapshot().slots.find(s => s.slotId === binding.slotId);
    if (binding.authorityDigest !== this.retained.seed.authorityDigest || !allocation ||
        Object.keys(allocation).some(k => allocation[k as keyof typeof allocation] !== binding[k as keyof ChildCorrelation])) fail();
    const path = RetainedKeyedAuthority.prototype.cleanupSlot.call(this.retained, binding.slotId).jobRootDir;
    const parent = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      if (!same(fstatSync(parent), this.#parents.get(path)!)) fail();
      const result = action(parent); this.#check(); return result;
    } finally { closeSync(parent); }
  }
  #read(parent: number, name: string): Buffer | null {
    const path = `/proc/self/fd/${parent}/keyed-preparation-${name}.json`;
    let fd: number;
    try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || before.uid !== 0 || before.nlink !== 1 || (before.mode & 0o7777) !== 0o600 || before.size > 16384) fail();
      const bytes = readFileSync(fd), after = fstatSync(fd);
      if (!same(before, lstatSync(path)) || bytes.length !== before.size || after.size !== before.size ||
          after.ctimeMs !== before.ctimeMs || after.mtimeMs !== before.mtimeMs) fail();
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (!encode(value).equals(bytes)) fail();
      return bytes;
    } finally { closeSync(fd); }
  }
  #publish(parent: number, name: string, bytes: Buffer): void {
    const prior = this.#read(parent, name);
    if (prior && !prior.equals(bytes)) fail();
    const path = `/proc/self/fd/${parent}/keyed-preparation-${name}.json`;
    const ancestors: number[] = [];
    try {
      // Retain the actual directory descriptors before any creation/write.
      // A later pathname reread cannot substitute for the original fsync owner.
      for (const [path, pinned] of this.#parents) {
        const ancestor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        ancestors.push(ancestor);
        if (!same(fstatSync(ancestor), pinned)) fail();
      }
      this.#check();
      const fd = openSync(path, prior ? constants.O_RDONLY | constants.O_NOFOLLOW :
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.uid !== 0 || stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o600) fail();
      if (!prior) writeFileSync(fd, bytes);
      fsyncSync(fd); fsyncSync(parent);
      for (const ancestor of ancestors) fsyncSync(ancestor);
      if (!same(stat, lstatSync(path)) || !this.#read(parent, name)?.equals(bytes)) fail();
      this.#check();
      } finally { closeSync(fd); }
    } finally { for (const ancestor of ancestors) closeSync(ancestor); }
  }
  #owner(parent: number, binding: ChildCorrelation): { record: OwnershipRecord; bytes: Buffer } {
    const bytes = this.#read(parent, "owner");
    if (!bytes) throw new Error("preparation_original_owner_required");
    const record = JSON.parse(bytes.toString("utf8")) as OwnershipRecord;
    const slot = RetainedKeyedAuthority.prototype.cleanupSlot.call(this.retained, binding.slotId);
    if (Object.keys(record).sort().join(",") !== "deadlineEpochMs,identityDigest,maxGoalTurns,preparationGeneration,preparationPlanDigest,schemaVersion,slotDigest" ||
        record.schemaVersion !== 1 || record.identityDigest !== stableChildDigest(binding, 0) ||
        !Number.isSafeInteger(record.preparationGeneration) || record.preparationGeneration < 1 ||
        record.preparationGeneration > binding.generation || record.deadlineEpochMs !== slot.lifetime.deadlineEpochMs ||
        record.maxGoalTurns !== slot.lifetime.maxGoalTurns || record.slotDigest !== digest(encode(slot)) ||
        !/^[a-f0-9]{64}$/.test(record.preparationPlanDigest)) fail();
    return { record, bytes };
  }
  retain(fence: HostedActivationFence, binding: ChildCorrelation, preparationPlanDigest: string): OriginalPreparationOwner {
    assertHostedActivationFence(fence);
    if (!/^[a-f0-9]{64}$/.test(preparationPlanDigest)) fail();
    return this.#withParent(binding, parent => {
      if (this.#read(parent, "owner") || this.#read(parent, "closed")) throw new Error("preparation_original_owner_exists");
      const slot = RetainedKeyedAuthority.prototype.cleanupSlot.call(this.retained, binding.slotId);
      const bytes = encode({ schemaVersion: 1, identityDigest: stableChildDigest(binding, 0),
        preparationGeneration: binding.generation, deadlineEpochMs: slot.lifetime.deadlineEpochMs,
        maxGoalTurns: slot.lifetime.maxGoalTurns, slotDigest: digest(encode(slot)), preparationPlanDigest });
      this.#publish(parent, "owner", bytes);
      return Object.freeze({ correlation: Object.freeze({ ...binding }), preparationGeneration: binding.generation,
        ownershipDigest: digest(bytes), preparationPlanDigest, deadlineEpochMs: slot.lifetime.deadlineEpochMs, maxGoalTurns: slot.lifetime.maxGoalTurns });
    });
  }
  assertOpen(fence: HostedActivationFence, binding: ChildCorrelation): void {
    assertHostedActivationFence(fence);
    this.#withParent(binding, parent => {
      this.#owner(parent, binding);
      if (this.#read(parent, "closed")) throw new Error("preparation_admission_closed");
    });
  }
  prefix(fence: HostedActivationFence, binding: ChildCorrelation, effect: PreparationEffect): void {
    this.assertOpen(fence, binding);
    if (!Object.values(PreparationEffect).includes(effect)) fail();
    this.#withParent(binding, parent => {
      const { bytes } = this.#owner(parent, binding);
      if (this.#read(parent, `effect-${effect}`)) throw new Error("preparation_effect_already_started");
      this.#publish(parent, `effect-${effect}`, encode({ schemaVersion: 1, ownershipDigest: digest(bytes),
        generation: binding.generation, effect }));
    });
  }
  #closure(parent: number, binding: ChildCorrelation, owner: OwnershipRecord, ownershipDigest: string):
    { record: ClosureRecord; bytes: Buffer } | null {
    const bytes = this.#read(parent, "closed");
    if (!bytes) return null;
    const record = JSON.parse(bytes.toString("utf8")) as ClosureRecord;
    if (Object.keys(record).sort().join(",") !== "closureGeneration,ownershipDigest,preparationGeneration,reason,schemaVersion" ||
        record.schemaVersion !== 1 || record.ownershipDigest !== ownershipDigest ||
        record.preparationGeneration !== owner.preparationGeneration ||
        !Number.isSafeInteger(record.closureGeneration) || record.closureGeneration <= owner.preparationGeneration ||
        record.closureGeneration > binding.generation || !Object.values(ScopedStopReason).includes(record.reason)) fail();
    return { record, bytes };
  }
  closedInventory(fence: HostedActivationFence, binding: ChildCorrelation): ClosedPreparationRecordInventory {
    assertHostedActivationFence(fence);
    return this.#withParent(binding, parent => {
      const owner = this.#owner(parent, binding), ownershipDigest = digest(owner.bytes);
      const closure = this.#closure(parent, binding, owner.record, ownershipDigest);
      if (!closure) throw new Error("preparation_original_closure_required");
      const effects = Object.values(PreparationEffect);
      const known = new Set(effects.map(effect => `keyed-preparation-effect-${effect}.json`));
      const names = () => readdirSync(`/proc/self/fd/${parent}`).filter(name => name.startsWith("keyed-preparation-effect-")).sort();
      const before = names();
      if (before.some(name => !known.has(name))) fail();
      const prefixDigests = {} as Record<PreparationEffect, string | null>;
      const captured = new Map<string, Buffer | null>();
      for (const effect of effects) {
        const name = `effect-${effect}`, bytes = this.#read(parent, name);
        captured.set(name, bytes); prefixDigests[effect] = bytes ? digest(bytes) : null;
        if (!bytes) continue;
        const prefix = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
        if (Object.keys(prefix).sort().join(",") !== "effect,generation,ownershipDigest,schemaVersion" ||
            prefix.schemaVersion !== 1 || prefix.ownershipDigest !== ownershipDigest || prefix.effect !== effect ||
            !Number.isSafeInteger(prefix.generation) || (prefix.generation as number) < owner.record.preparationGeneration ||
            (prefix.generation as number) >= closure.record.closureGeneration) fail();
      }
      // Reread the captured fixed records under this same fence. Interrupted,
      // replaced or newly discovered prefixes remain unresolved obligations.
      if (JSON.stringify(before) !== JSON.stringify(names()) ||
          !this.#read(parent, "owner")?.equals(owner.bytes) ||
          !this.#read(parent, "closed")?.equals(closure.bytes)) fail();
      for (const [name, bytes] of captured) {
        const current = this.#read(parent, name);
        if (bytes ? !current?.equals(bytes) : current !== null) fail();
      }
      const inventory = Object.freeze({ identityDigest: owner.record.identityDigest, ownershipDigest,
        preparationGeneration: owner.record.preparationGeneration, closureGeneration: closure.record.closureGeneration,
        ledgerGeneration: binding.generation, closureDigest: digest(closure.bytes), prefixDigests: Object.freeze(prefixDigests) });
      return Object.freeze({ ...inventory, inventoryDigest: digest(encode(inventory)) });
    });
  }
  close(fence: HostedActivationFence, binding: ChildCorrelation, reason: ScopedStopReason): void {
    assertHostedActivationFence(fence);
    if (!Object.values(ScopedStopReason).includes(reason)) fail();
    this.#withParent(binding, parent => {
      const { bytes, record } = this.#owner(parent, binding);
      const prior = this.#closure(parent, binding, record, digest(bytes));
      if (prior) {
        this.#publish(parent, "closed", prior.bytes); return;
      }
      this.#publish(parent, "closed", encode({ schemaVersion: 1, ownershipDigest: digest(bytes),
        preparationGeneration: record.preparationGeneration, closureGeneration: binding.generation, reason }));
    });
  }
}
function fail(): never { throw new Error("preparation_ownership_conflict"); }
