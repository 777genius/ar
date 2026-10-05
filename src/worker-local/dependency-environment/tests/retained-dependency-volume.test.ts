import { constants, statfsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, readlink, rename, rm, symlink, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { DependencyVolumeFailure as Failure, DependencyVolumeStatus as Status, RetainedDependencyVolume,
  deduplicateDependencyPhysicalTrees, normalizeDependencyVolumeCounters,
  type DependencyPhysicalTreeObservation, type DependencyVolumeObservation } from "../retained-dependency-volume";

// NEW owned TEST filesystems only. These tests never launch a user project,
// runtime/provider, installer or fake a protected host grant/coverage receipt.
const run = promisify(execFile), flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const binding = "a".repeat(64);
function retain(handle: FileHandle): RetainedDependencyVolume {
  const result = RetainedDependencyVolume.retain(handle);
  if (result.status === Status.Unmeasured) throw new Error(`TEST retention failed: ${result.reason}`);
  return result.observer;
}
function sample(observer: RetainedDependencyVolume): DependencyVolumeObservation {
  const result = observer.observe();
  if (result.status === Status.Unmeasured) throw new Error(`TEST sampling failed: ${result.reason}`);
  return result;
}
function tree(observer: RetainedDependencyVolume): DependencyPhysicalTreeObservation {
  const result = observer.observePhysicalTree();
  if (result.status === Status.Unmeasured) throw new Error(`TEST tree failed: ${result.reason}`);
  return result;
}
async function fixture() {
  const top = await mkdtemp(join(tmpdir(), "dependency-volume-TEST-")), root = join(top, "workspace");
  await mkdir(join(root, "node_modules"), { recursive: true }); const handle = await open(root, flags);
  return { top, root, handle, cleanup: async () => { await handle.close().catch(() => undefined); await rm(top, { recursive: true, force: true }); } };
}

describe("dependency volume arithmetic facts (not host authority)", () => {
  // Number conversion loses one block and one inode on these independent inputs.
  it("keeps block and inode counters above Number precision exact", () => {
    expect(normalizeDependencyVolumeCounters({ type: 61267n, bsize: 4096n, blocks: 9007199254740993n,
      bfree: 9007199254740991n, bavail: 9007199254740989n, files: 9007199254740997n, ffree: 9007199254740995n }))
      .toEqual({ status: Status.Measured, capacity: { filesystemType: "61267", blockSizeBytes: "4096",
        totalBytes: "36893488147419107328", freeBytes: "36893488147419099136", availableBytes: "36893488147419090944",
        totalInodes: "9007199254740997", freeInodes: "9007199254740995" } });
  });
  it("accepts reported zero capacity but refuses incoherent, negative, imprecise or overflowing counters", () => {
    const zero = { type: 61267n, bsize: 4096n, blocks: 0n, bfree: 0n, bavail: 0n, files: 0n, ffree: 0n };
    expect(normalizeDependencyVolumeCounters(zero)).toMatchObject({ status: Status.Measured,
      capacity: { availableBytes: "0", totalBytes: "0", totalInodes: "0", freeInodes: "0" } });
    for (const invalid of [{ ...zero, bsize: 0n }, { ...zero, type: 0n }, { ...zero, bavail: -1n },
      { ...zero, bfree: 1n }, { ...zero, blocks: 2n, bfree: 1n, bavail: 2n }, { ...zero, ffree: 1n },
      { ...zero, blocks: 0 as unknown as bigint }, { ...zero, files: undefined as unknown as bigint },
      { ...zero, bsize: 2n, blocks: BigInt("9".repeat(128)) }]) {
      expect(normalizeDependencyVolumeCounters(invalid)).toEqual({ status: Status.Unmeasured, reason: Failure.InvalidCounters });
    }
  });
});

describe.skipIf(process.platform !== "linux")("actual retained volume observation on NEW Linux TEST roots", () => {
  // A path-based re-open would follow the replacement directory; a borrowed FD
  // would fail after the source handle closes. The observer must do neither.
  it("retains the original inode after input close and canonical-name replacement", async () => {
    const f = await fixture(); let observer: RetainedDependencyVolume | undefined;
    try {
      const original = await f.handle.stat({ bigint: true }); observer = retain(f.handle);
      const raw = statfsSync(`/proc/self/fd/${f.handle.fd}`, { bigint: true }), first = sample(observer);
      expect(first.anchor).toEqual({ dev: String(original.dev), ino: String(original.ino) });
      // Available/free counters can change due unrelated IO between samples.
      // Compare stable volume attributes, never assume our fixture freezes it.
      expect(first.capacity.filesystemType).toBe(String(raw.type));
      expect(first.capacity.blockSizeBytes).toBe(String(raw.bsize));
      expect(first.capacity.totalBytes).toBe(String(raw.blocks * raw.bsize));
      expect(first.capacity.totalInodes).toBe(String(raw.files));
      expect(BigInt(first.capacity.availableBytes)).toBeLessThanOrEqual(BigInt(first.capacity.freeBytes));
      expect(BigInt(first.capacity.freeBytes)).toBeLessThanOrEqual(BigInt(first.capacity.totalBytes));
      await f.handle.close(); await rename(f.root, join(f.top, "original")); await mkdir(f.root);
      expect((await lstat(f.root, { bigint: true })).ino).not.toBe(original.ino);
      const after = sample(observer); expect(after.anchor).toEqual(first.anchor); expect(after.volume).toEqual(first.volume);
      expect(tree(observer).identity.dev).toBe(first.anchor.dev);
      observer.close(); expect(observer.observe()).toEqual({ status: Status.Unmeasured, reason: Failure.Closed });
      expect(RetainedDependencyVolume.retain(f.handle)).toEqual({ status: Status.Unmeasured, reason: Failure.Unavailable });
    } finally { observer?.close(); await f.cleanup(); }
  });
  // A serialized/cross-observer sample cannot be reassigned to this target.
  it("computes signed observed deltas only from ordered samples of the same retained observer", async () => {
    const f = await fixture(); const observer = retain(f.handle), other = retain(f.handle);
    try {
      const before = sample(observer); await writeFile(join(f.root, "TEST-data"), Buffer.alloc(8192, 1)); const after = sample(observer);
      expect(observer.delta(before, after)).toEqual({ status: Status.Measured, volume: before.volume,
        availableBytesDelta: String(BigInt(after.capacity.availableBytes) - BigInt(before.capacity.availableBytes)),
        freeBytesDelta: String(BigInt(after.capacity.freeBytes) - BigInt(before.capacity.freeBytes)),
        freeInodesDelta: String(BigInt(after.capacity.freeInodes) - BigInt(before.capacity.freeInodes)) });
      for (const pair of [[after, before], [before, before], [{ ...before }, after], [sample(other), after]] as const)
        expect(observer.delta(pair[0], pair[1])).toEqual({ status: Status.Unmeasured, reason: Failure.ForeignObservation });
      const delta = observer.delta(before, after);
      if (delta.status === Status.Measured) expect(delta.availableBytesDelta).toMatch(/^(?:0|-?[1-9][0-9]*)$/);
    } finally { observer.close(); other.close(); await f.cleanup(); }
  });
  // Same inode aliases must not double-count; content-equal distinct roots are
  // still distinct. Supplied estimates test arithmetic, not allocation authority.
  it("deduplicates actual pinned aliases, keeps distinct inodes, and blocks conflicting or copied observations", async () => {
    const f = await fixture(), g = await fixture(); const first = retain(f.handle), alias = retain(f.handle), second = retain(g.handle);
    try {
      const a = tree(first), b = tree(alias), c = tree(second);
      expect(a.identity).toEqual(b.identity); expect(c.identity).not.toEqual(a.identity);
      const facts = [{ tree: a, bindingSha256: binding, allocatedBytes: "0" }, { tree: b, bindingSha256: binding, allocatedBytes: "0" }];
      expect(deduplicateDependencyPhysicalTrees(facts)).toMatchObject({ status: Status.Measured, allocatedBytes: "0", physicalTreeCount: 1, aliasCount: 1 });
      expect(deduplicateDependencyPhysicalTrees([...facts, { tree: c, bindingSha256: binding, allocatedBytes: "4096" }]))
        .toMatchObject({ status: Status.Measured, allocatedBytes: "4096", physicalTreeCount: 2, aliasCount: 1 });
      for (const changed of [{ ...facts[1]!, allocatedBytes: "512" }, { ...facts[1]!, bindingSha256: "b".repeat(64) }])
        expect(deduplicateDependencyPhysicalTrees([facts[0]!, changed])).toEqual({ status: Status.Unmeasured, reason: Failure.ConflictingAlias });
      expect(deduplicateDependencyPhysicalTrees([{ ...facts[0]!, tree: { ...a } }]))
        .toEqual({ status: Status.Unmeasured, reason: Failure.ForeignObservation });
      expect(deduplicateDependencyPhysicalTrees([{ ...facts[0]!, allocatedBytes: "00" }]))
        .toEqual({ status: Status.Unmeasured, reason: Failure.ForeignObservation });
      expect(deduplicateDependencyPhysicalTrees([{ ...facts[0]!, allocatedBytes: 512 as unknown as string }]))
        .toEqual({ status: Status.Unmeasured, reason: Failure.ForeignObservation });
      expect(deduplicateDependencyPhysicalTrees([])).toEqual({ status: Status.Unmeasured, reason: Failure.Unavailable });
    } finally { first.close(); alias.close(); second.close(); await f.cleanup(); await g.cleanup(); }
  });
  it("keeps missing or symlinked trees unmeasured instead of inventing zero allocation", async () => {
    const f = await fixture(); const observer = retain(f.handle);
    try {
      await rm(join(f.root, "node_modules"), { recursive: true });
      expect(observer.observePhysicalTree()).toEqual({ status: Status.Unmeasured, reason: Failure.Unavailable });
      const outside = join(f.top, "outside"); await mkdir(outside); await symlink(outside, join(f.root, "node_modules"));
      expect(observer.observePhysicalTree()).toEqual({ status: Status.Unmeasured, reason: Failure.Unavailable });
      expect(observer.observe().status).toBe(Status.Measured); // volume and candidate completeness are distinct facts
    } finally { observer.close(); await f.cleanup(); }
  });
  // Closing a root FD immediately after sampling permits later inode reuse;
  // blindly refreshing the same pin also hides a dependency generation change.
  it("keeps the physical root pinned and rejects replacement or post-close alias estimates", async () => {
    const f = await fixture(); const observer = retain(f.handle);
    try {
      const original = tree(observer), fact = { tree: original, bindingSha256: binding, allocatedBytes: "512" };
      await rename(join(f.root, "node_modules"), join(f.root, "previous")); await mkdir(join(f.root, "node_modules"));
      expect(observer.observePhysicalTree()).toEqual({ status: Status.Unmeasured, reason: Failure.IdentityChanged });
      expect(deduplicateDependencyPhysicalTrees([fact])).toEqual({ status: Status.Unmeasured, reason: Failure.IdentityChanged });
      observer.close(); expect(deduplicateDependencyPhysicalTrees([fact])).toEqual({ status: Status.Unmeasured, reason: Failure.Closed });
    } finally { observer.close(); await f.cleanup(); }
  });

  async function requireOwnedNamespace(): Promise<void> {
    // The explicitly owned launcher uses --user --map-root-user --mount.
    // Foreign PID1 links are inaccessible inside that user namespace. Observe
    // only our actual single-ID maps and private propagation before real mounts.
    expect(await readlink("/proc/self/ns/mnt")).toMatch(/^mnt:\[[0-9]+\]$/);
    expect(await readlink("/proc/self/ns/user")).toMatch(/^user:\[[0-9]+\]$/);
    expect(process.geteuid?.()).toBe(0); expect(process.getegid?.()).toBe(0);
    for (const name of ["uid_map", "gid_map"])
      expect(await readFile(`/proc/self/${name}`, "utf8")).toMatch(/^\s*0\s+[0-9]+\s+1\s*$/);
    const mounts = await readFile("/proc/self/mountinfo", "utf8"); expect(mounts.length).toBeGreaterThan(0);
    expect(mounts).not.toMatch(/ (?:shared|master):[0-9]+(?: |$)/m);
  }
  // Optional only under the existing explicitly owned disposable namespace CI
  // launcher. No fake mount callback or manufactured host authority is used.
  it.skipIf(process.env.SUBSCRIPTION_RUNTIME_TEST_MOUNT_NAMESPACE !== "1")("blocks real mount drift and same-device bind alias reassignment", async () => {
    await requireOwnedNamespace(); const f = await fixture(), g = await fixture();
    let original: RetainedDependencyVolume | undefined, alias: RetainedDependencyVolume | undefined, aliasHandle: FileHandle | undefined, mounted = false;
    const before = retain(f.handle);
    try {
      sample(before); await run("mount", ["--bind", f.root, g.root]); mounted = true;
      expect(before.observe()).toEqual({ status: Status.Unmeasured, reason: Failure.MountChanged });
      original = retain(f.handle); aliasHandle = await open(g.root, flags); alias = retain(aliasHandle);
      const a = tree(original), b = tree(alias); expect(a.identity).toEqual(b.identity); expect(a.volume.mountId).not.toBe(b.volume.mountId);
      expect(deduplicateDependencyPhysicalTrees([{ tree: a, bindingSha256: binding, allocatedBytes: "512" },
        { tree: b, bindingSha256: binding, allocatedBytes: "512" }])).toEqual({ status: Status.Unmeasured, reason: Failure.ConflictingAlias });
    } finally {
      before.close(); original?.close(); alias?.close(); await aliasHandle?.close();
      if (mounted) await run("umount", [g.root]); await f.cleanup(); await g.cleanup();
    }
  });
  it.skipIf(process.env.SUBSCRIPTION_RUNTIME_TEST_MOUNT_NAMESPACE !== "1")("never sums a distinct target filesystem into the original volume", async () => {
    await requireOwnedNamespace(); const f = await fixture(), g = await fixture();
    let first: RetainedDependencyVolume | undefined, second: RetainedDependencyVolume | undefined, mountedHandle: FileHandle | undefined, mounted = false;
    try {
      await run("mount", ["-t", "tmpfs", "-o", "size=4m,nodev,nosuid", "tmpfs", g.root]); mounted = true;
      await mkdir(join(g.root, "node_modules")); mountedHandle = await open(g.root, flags);
      first = retain(f.handle); second = retain(mountedHandle); const a = tree(first), b = tree(second);
      expect(a.identity.dev).not.toBe(b.identity.dev); expect(sample(second).capacity.totalBytes).toBe("4194304");
      expect(deduplicateDependencyPhysicalTrees([{ tree: a, bindingSha256: binding, allocatedBytes: "4096" },
        { tree: b, bindingSha256: binding, allocatedBytes: "4096" }])).toEqual({ status: Status.Unmeasured, reason: Failure.ConflictingAlias });
    } finally {
      first?.close(); second?.close(); await mountedHandle?.close();
      if (mounted) await run("umount", [g.root]); await f.cleanup(); await g.cleanup();
    }
  });
});
