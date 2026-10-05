import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, statfsSync, type BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";

export enum DependencyVolumeStatus { Measured = "measured", Unmeasured = "unmeasured" }
export enum DependencyVolumeFailure {
  Unsupported = "unsupported", Unavailable = "unavailable", Bounds = "bounds", InvalidCounters = "invalid_counters",
  IdentityChanged = "identity_changed", NamespaceChanged = "namespace_changed", MountChanged = "mount_changed",
  Closed = "closed", ForeignObservation = "foreign_observation", ConflictingAlias = "conflicting_alias",
}
type Unmeasured = { readonly status: DependencyVolumeStatus.Unmeasured; readonly reason: DependencyVolumeFailure };
type Identity = { readonly dev: string; readonly ino: string };
export type DependencyVolumeCounters = {
  readonly type: bigint; readonly bsize: bigint; readonly blocks: bigint; readonly bfree: bigint;
  readonly bavail: bigint; readonly files: bigint; readonly ffree: bigint;
};
export type DependencyVolumeCapacity = {
  readonly filesystemType: string; readonly blockSizeBytes: string; readonly totalBytes: string;
  readonly freeBytes: string; readonly availableBytes: string; readonly totalInodes: string; readonly freeInodes: string;
};
export type DependencyVolumePin = {
  readonly volumeId: string; readonly dev: string; readonly mountId: string; readonly mountInfoSha256: string;
  readonly namespace: Identity; readonly bootId: string;
};
export type DependencyVolumeObservation = {
  readonly status: DependencyVolumeStatus.Measured; readonly anchor: Identity; readonly volume: DependencyVolumePin;
  readonly capacity: DependencyVolumeCapacity;
};
export type DependencyPhysicalTreeObservation = {
  readonly status: DependencyVolumeStatus.Measured; readonly identity: Identity; readonly volume: DependencyVolumePin;
};
type CapacityResult = { readonly status: DependencyVolumeStatus.Measured; readonly capacity: DependencyVolumeCapacity } | Unmeasured;
class ObservationError extends Error { constructor(readonly reason: DependencyVolumeFailure) { super(reason); } }
function fail(reason: DependencyVolumeFailure): never { throw new ObservationError(reason); }
const unavailable = (e: unknown): Unmeasured => ({ status: DependencyVolumeStatus.Unmeasured,
  reason: e instanceof ObservationError ? e.reason : DependencyVolumeFailure.Unavailable });
const decimal = /^(?:0|[1-9][0-9]{0,127})$/;
const digest = (bytes: string): string => createHash("sha256").update(bytes).digest("hex");
const identity = (s: BigIntStats): Identity => Object.freeze({ dev: String(s.dev), ino: String(s.ino) });
const same = (a: BigIntStats, b: BigIntStats): boolean => a.isDirectory() && b.isDirectory() &&
  a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.nlink > 0n && b.nlink > 0n;
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
// Bounded proc observation, not a retention policy budget or qualification claim.
const mountInfoLimit = 8 * 1024 * 1024;
const physicalTrees = new WeakMap<object, { readonly key: string; readonly check: () => void }>();

/** Arithmetic validation only. Kernel observations are issued by the retained
 * adapter below; valid caller counters do not become measured host authority. */
export function normalizeDependencyVolumeCounters(value: DependencyVolumeCounters): CapacityResult {
  const numbers = [value.type, value.bsize, value.blocks, value.bfree, value.bavail, value.files, value.ffree];
  if (numbers.some(n => typeof n !== "bigint" || n < 0n || !decimal.test(String(n))) || value.type === 0n || value.bsize === 0n ||
      value.bfree > value.blocks || value.bavail > value.bfree || value.ffree > value.files ||
      !decimal.test(String(value.blocks * value.bsize))) return { status: DependencyVolumeStatus.Unmeasured, reason: DependencyVolumeFailure.InvalidCounters };
  return { status: DependencyVolumeStatus.Measured, capacity: Object.freeze({ filesystemType: String(value.type),
    blockSizeBytes: String(value.bsize), totalBytes: String(value.blocks * value.bsize), freeBytes: String(value.bfree * value.bsize),
    availableBytes: String(value.bavail * value.bsize), totalInodes: String(value.files), freeInodes: String(value.ffree) }) };
}
function bounded(path: string, limit: number): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW), buffer = Buffer.alloc(limit + 1);
  try {
    let count = 0;
    while (count < buffer.length) {
      const read = readSync(fd, buffer, count, buffer.length - count, null); if (!read) break; count += read;
    }
    if (count > limit) fail(DependencyVolumeFailure.Bounds);
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, count));
  } finally { closeSync(fd); }
}
function mountId(fd: number): string {
  const rows = [...bounded(`/proc/self/fdinfo/${fd}`, 65536).matchAll(/^mnt_id:\s+([1-9][0-9]{0,19})$/gm)];
  const id = rows[0]?.[1]; if (rows.length !== 1 || !id) fail(DependencyVolumeFailure.MountChanged); return id;
}
function mountTable(id: string): { readonly sha256: string; readonly rowSha256: string } {
  const text = bounded("/proc/self/mountinfo", mountInfoLimit), ids = new Set<string>(); let selected: string | undefined;
  for (const row of text.trimEnd().split("\n")) {
    const fields = row.split(" "), separator = fields.indexOf("-"), current = fields[0];
    if (!current || !/^[1-9][0-9]{0,19}$/.test(current) || ids.has(current) || separator < 6 || fields.length !== separator + 4 ||
        !/^(?:0|[1-9][0-9]*):(?:0|[1-9][0-9]*)$/.test(fields[2] ?? "") ||
        !fields[3]?.startsWith("/") || !fields[4]?.startsWith("/") || fields.some(field => !field)) fail(DependencyVolumeFailure.MountChanged);
    ids.add(current); if (current === id) selected = row;
  }
  if (!selected) fail(DependencyVolumeFailure.MountChanged);
  return { sha256: digest(text), rowSha256: digest(selected) };
}
function processBirth(): string {
  const text = bounded("/proc/self/stat", 65536), closing = text.lastIndexOf(")");
  const ticks = text.slice(closing + 2).trim().split(/\s+/)[19];
  if (closing < 1 || !ticks || !/^[1-9][0-9]*$/.test(ticks)) fail(DependencyVolumeFailure.NamespaceChanged);
  return `${process.pid}:${ticks}`;
}
function bootId(): string {
  const value = bounded("/proc/sys/kernel/random/boot_id", 128).trim();
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)) fail(DependencyVolumeFailure.NamespaceChanged); return value;
}

/** Factual capability owned by trusted composition. No pathname, grant, permit
 * or caller pin is accepted. The caller authenticates and pins the current
 * canonical workspace separately; this clone observes that retained inode's
 * volume even after a rename. Before/after stability is not continuous exclusion.
 * These facts neither qualify a namespace nor authorize any effect. */
export class RetainedDependencyVolume {
  private closed = false;
  private sequence = 0;
  private readonly samples = new WeakMap<object, number>();
  private treePin: { readonly fd: number; readonly before: BigIntStats } | undefined;
  private constructor(private readonly fd: number, private readonly ns: number, private readonly anchor: BigIntStats,
    private readonly namespace: BigIntStats, private readonly pin: DependencyVolumePin, private readonly birth: string,
    private readonly filesystemType: string, private readonly blockSizeBytes: string) {}

  static retain(parent: FileHandle): { readonly status: DependencyVolumeStatus.Measured; readonly observer: RetainedDependencyVolume } | Unmeasured {
    let fd: number | undefined, ns: number | undefined;
    try {
      if (process.platform !== "linux" || statfsSync("/proc/self/fd", { bigint: true }).type !== 0x9fa0n) fail(DependencyVolumeFailure.Unsupported);
      if (!Number.isSafeInteger(parent.fd) || parent.fd < 0) fail(DependencyVolumeFailure.Unavailable);
      const before = fstatSync(parent.fd, { bigint: true }), originalMount = mountId(parent.fd), birth = processBirth(), boot = bootId();
      // Following this proc magic link duplicates the actual retained directory;
      // no caller path is resolved, and the kernel identities are compared below.
      fd = openSync(`/proc/self/fd/${parent.fd}`, constants.O_RDONLY | constants.O_DIRECTORY);
      ns = openSync("/proc/self/ns/mnt", constants.O_RDONLY);
      const anchor = fstatSync(fd, { bigint: true }), namespace = fstatSync(ns, { bigint: true }), mounted = mountId(fd);
      if (!same(before, anchor) || !same(before, fstatSync(parent.fd, { bigint: true })) || mounted !== originalMount ||
          mountId(parent.fd) !== originalMount) fail(DependencyVolumeFailure.IdentityChanged);
      const mounts = mountTable(mounted), capacity = normalizeDependencyVolumeCounters(statfsSync(`/proc/self/fd/${fd}`, { bigint: true }));
      if (capacity.status === DependencyVolumeStatus.Unmeasured) fail(capacity.reason);
      const volumeId = digest(JSON.stringify([boot, identity(namespace), String(anchor.dev), mounted, mounts.rowSha256,
        capacity.capacity.filesystemType, capacity.capacity.blockSizeBytes]));
      const pin: DependencyVolumePin = Object.freeze({ volumeId, dev: String(anchor.dev), mountId: mounted,
        mountInfoSha256: mounts.sha256, namespace: identity(namespace), bootId: boot });
      const observer = new RetainedDependencyVolume(fd, ns, anchor, namespace, pin, birth,
        capacity.capacity.filesystemType, capacity.capacity.blockSizeBytes);
      observer.check(); return { status: DependencyVolumeStatus.Measured, observer };
    } catch (error) { if (ns !== undefined) closeSync(ns); if (fd !== undefined) closeSync(fd); return unavailable(error); }
  }
  private check(): void {
    if (this.closed) fail(DependencyVolumeFailure.Closed);
    if (!same(this.anchor, fstatSync(this.fd, { bigint: true }))) fail(DependencyVolumeFailure.IdentityChanged);
    const freshNamespace = openSync("/proc/self/ns/mnt", constants.O_RDONLY);
    try {
      const current = fstatSync(freshNamespace, { bigint: true }), retained = fstatSync(this.ns, { bigint: true });
      if (current.dev !== this.namespace.dev || current.ino !== this.namespace.ino || retained.dev !== current.dev || retained.ino !== current.ino ||
          processBirth() !== this.birth || bootId() !== this.pin.bootId) fail(DependencyVolumeFailure.NamespaceChanged);
    } finally { closeSync(freshNamespace); }
    if (mountId(this.fd) !== this.pin.mountId || mountTable(this.pin.mountId).sha256 !== this.pin.mountInfoSha256) fail(DependencyVolumeFailure.MountChanged);
  }
  observe(): DependencyVolumeObservation | Unmeasured {
    try {
      this.check(); const result = normalizeDependencyVolumeCounters(statfsSync(`/proc/self/fd/${this.fd}`, { bigint: true })); this.check();
      if (result.status === DependencyVolumeStatus.Unmeasured) return result;
      if (result.capacity.filesystemType !== this.filesystemType || result.capacity.blockSizeBytes !== this.blockSizeBytes) fail(DependencyVolumeFailure.MountChanged);
      const sample: DependencyVolumeObservation = Object.freeze({ status: DependencyVolumeStatus.Measured, anchor: identity(this.anchor),
        volume: this.pin, capacity: result.capacity });
      this.samples.set(sample, ++this.sequence); return sample;
    } catch (error) { return unavailable(error); }
  }
  /** Actual fixed root identity only, not a manifest/allocation or eviction proof. */
  observePhysicalTree(): DependencyPhysicalTreeObservation | Unmeasured {
    let fd: number | undefined, fresh: number | undefined;
    try {
      this.check(); fd = this.treePin?.fd ?? openSync(`/proc/self/fd/${this.fd}/node_modules`, directoryFlags);
      const before = this.treePin?.before ?? fstatSync(fd, { bigint: true }); fresh = openSync(`/proc/self/fd/${this.fd}/node_modules`, directoryFlags);
      if (!same(before, fstatSync(fresh, { bigint: true })) || !same(before, fstatSync(fd, { bigint: true })) ||
          before.dev !== this.anchor.dev || mountId(fd) !== this.pin.mountId || mountId(fresh) !== this.pin.mountId) fail(DependencyVolumeFailure.IdentityChanged);
      this.check(); const tree: DependencyPhysicalTreeObservation = Object.freeze({ status: DependencyVolumeStatus.Measured,
        identity: identity(before), volume: this.pin });
      // One retained tree FD per observer prevents inode reuse from making a
      // historical root impersonate a current alias. A replacement requires a
      // fresh observer, never an implicit pin refresh.
      this.treePin ??= { fd, before };
      physicalTrees.set(tree, { key: JSON.stringify([tree.identity.dev, tree.identity.ino]), check: () => {
        const observed = this.observePhysicalTree(); if (observed.status === DependencyVolumeStatus.Unmeasured) fail(observed.reason);
      } }); return tree;
    } catch (error) { return unavailable(error); }
    finally { if (fresh !== undefined) closeSync(fresh); if (fd !== undefined && fd !== this.treePin?.fd) closeSync(fd); }
  }
  /** Signed observed capacity change. Concurrent work, reservations, COW and
   * sampling gaps confound attribution; this is never guaranteed own reclaim. */
  delta(before: DependencyVolumeObservation, after: DependencyVolumeObservation):
    { readonly status: DependencyVolumeStatus.Measured; readonly volume: DependencyVolumePin; readonly availableBytesDelta: string;
      readonly freeBytesDelta: string; readonly freeInodesDelta: string } | Unmeasured {
    const first = this.samples.get(before), last = this.samples.get(after);
    if (first === undefined || last === undefined || first >= last) return { status: DependencyVolumeStatus.Unmeasured, reason: DependencyVolumeFailure.ForeignObservation };
    return { status: DependencyVolumeStatus.Measured, volume: this.pin,
      availableBytesDelta: String(BigInt(after.capacity.availableBytes) - BigInt(before.capacity.availableBytes)),
      freeBytesDelta: String(BigInt(after.capacity.freeBytes) - BigInt(before.capacity.freeBytes)),
      freeInodesDelta: String(BigInt(after.capacity.freeInodes) - BigInt(before.capacity.freeInodes)) };
  }
  close(): void {
    if (!this.closed) { this.closed = true;
      try { if (this.treePin) closeSync(this.treePin.fd); } finally { try { closeSync(this.ns); } finally { closeSync(this.fd); } }
    }
  }
}

/** Dedup factual estimates issued from actual retained roots. The caller must
 * supply its authenticated complete-binding revision and fresh allocation.
 * Matching source/output custody alone is not this dependency binding. */
export function deduplicateDependencyPhysicalTrees(input: readonly {
  readonly tree: DependencyPhysicalTreeObservation; readonly bindingSha256: string; readonly allocatedBytes: string;
}[]): { readonly status: DependencyVolumeStatus.Measured; readonly volume: DependencyVolumePin; readonly allocatedBytes: string;
  readonly physicalTreeCount: number; readonly aliasCount: number } | Unmeasured {
  if (!input.length) return { status: DependencyVolumeStatus.Unmeasured, reason: DependencyVolumeFailure.Unavailable };
  const unique = new Map<string, { binding: string; bytes: string }>(); let volume: DependencyVolumePin | undefined, total = 0n;
  for (const item of input) {
    const retained = physicalTrees.get(item.tree);
    if (!retained || typeof item.bindingSha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.bindingSha256) ||
        typeof item.allocatedBytes !== "string" || !decimal.test(item.allocatedBytes))
      return { status: DependencyVolumeStatus.Unmeasured, reason: DependencyVolumeFailure.ForeignObservation };
    try { retained.check(); } catch (error) { return unavailable(error); }
    if (volume && (volume.volumeId !== item.tree.volume.volumeId || volume.mountInfoSha256 !== item.tree.volume.mountInfoSha256))
      return { status: DependencyVolumeStatus.Unmeasured, reason: DependencyVolumeFailure.ConflictingAlias };
    volume = item.tree.volume; const prior = unique.get(retained.key);
    if (prior && (prior.binding !== item.bindingSha256 || prior.bytes !== item.allocatedBytes))
      return { status: DependencyVolumeStatus.Unmeasured, reason: DependencyVolumeFailure.ConflictingAlias };
    if (!prior) { unique.set(retained.key, { binding: item.bindingSha256, bytes: item.allocatedBytes }); total += BigInt(item.allocatedBytes); }
  }
  if (!decimal.test(String(total))) return { status: DependencyVolumeStatus.Unmeasured, reason: DependencyVolumeFailure.Bounds };
  return { status: DependencyVolumeStatus.Measured, volume: volume!, allocatedBytes: String(total), physicalTreeCount: unique.size, aliasCount: input.length - unique.size };
}
