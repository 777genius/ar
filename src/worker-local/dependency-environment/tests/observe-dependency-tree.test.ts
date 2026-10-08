import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { fstatSync, readdirSync, readlinkSync } from "node:fs";
import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, readlink, realpath, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { DependencyManifestEntryKind as Kind, DependencyTreeObservationFailure as Failure,
  DependencyTreeObservationStatus as Status, DependencyTreeAllocationBasis as AllocationBasis,
  type DependencyCapturedTreeObservation } from "../../../worker-core/dependency-environment/domain/dependency-tree-manifest";
import { observeDependencyDirectoryRoot, observeDependencyTree, captureDependencySourceExposure, captureDependencyPhysicalTreeExposure,
  assertDependencySourceExposureCurrent, closeDependencySourceExposure, type DependencySourceExposure } from "../observe-dependency-tree";
import { observeDependencyPinnedFile } from "../observe-dependency-pinned-file";

const run = promisify(execFile);
const limits = { maxEntries: 64, maxTotalBytes: 4096, maxManifestBytes: 16384, maxDurationMs: 10000 };
async function fixture() {
  const path = await realpath(await mkdtemp(join(tmpdir(), "dependency-inventory-TEST-")));
  const tree = join(path, "node_modules");
  await mkdir(tree, { mode: 0o755 });
  await mkdir(join(tree, "pkg"), { mode: 0o755 });
  await writeFile(join(tree, "pkg", "index.js"), "abc", { mode: 0o644 });
  return { path, tree, file: join(tree, "pkg", "index.js"),
    observe: () => observeDependencyTree({ workspacePath: path, treeName: "node_modules", limits }),
    cleanup: () => rm(path, { recursive: true, force: true }) };
}
function complete(value: DependencyCapturedTreeObservation) {
  expect(value.status).toBe(Status.Complete);
  if (value.status !== Status.Complete) throw new Error(`TEST incomplete:${value.reason}`);
  return value;
}
async function allocatedByDu(path: string): Promise<bigint> {
  // Independent installed OS utility oracle; neither follows symlinks nor uses
  // the observer's entries, arithmetic helper or canonical bytes as expectation.
  const { stdout } = await run("du", ["--block-size=1", "--summarize", "--no-dereference", "--", path],
    { timeout: 5000, maxBuffer: 65536 });
  const decimal = /^(\d+)\s/.exec(stdout)?.[1];
  if (!decimal) throw new Error("TEST du did not report allocated bytes");
  return BigInt(decimal);
}

// Regression boundary: full synthetic TEST filesystem behavior. No install,
// runtime, project launch, actual credentials, or real user tree is exercised.
describe.skipIf(process.platform !== "linux")("dependency full-tree inventory", () => {
  it("deduplicates identical contents despite different inodes and timestamps", async () => {
    const a = await fixture(); const b = await fixture();
    try {
      await utimes(b.file, new Date(1000), new Date(1000));
      const left = complete(await a.observe()); const right = complete(await b.observe());
      expect(left.digest).toBe(right.digest);
      expect(left.canonicalBytes).toEqual(right.canonicalBytes);
      expect(left.tree).not.toEqual(right.tree);
      expect(left.entries.map((entry) => entry.kind)).toEqual([Kind.Directory, Kind.Directory, Kind.File]);
      expect(left.identities).toHaveLength(3);
      expect(createHash("sha256").update(left.canonicalBytes).digest("hex")).toBe(left.digest);
      expect(complete(await observeDependencyDirectoryRoot({ parentPath: a.path, name: "node_modules", limits })).digest).toBe(left.digest);
    } finally { await a.cleanup(); await b.cleanup(); }
  });

  // Red if logical length is presented as allocated bytes, or physical block
  // changes leak into content identity and prevent independent-install dedup.
  it("measures a real sparse inode separately from content and observes content-stable fallocate", async () => {
    const f = await fixture();
    const sparse = join(f.tree, "sparse.bin"), length = 1024 * 1024;
    const observe = () => observeDependencyTree({ workspacePath: f.path, treeName: "node_modules",
      limits: { ...limits, maxTotalBytes: 2 * length } });
    try {
      const handle = await open(sparse, "w", 0o644);
      try { await handle.truncate(length); } finally { await handle.close(); }
      const started = performance.now();
      const hole = complete(await observe());
      const elapsed = Math.ceil(performance.now() - started);
      expect(hole.measurement.allocationBasis).toBe(AllocationBasis.RetainedInodeBlocks512);
      expect(BigInt(hole.measurement.allocationByKind[Kind.File].allocatedBytesEstimate)).toBeLessThan(BigInt(hole.totalBytes));
      expect(BigInt(hole.measurement.observedScanDurationMs)).toBeGreaterThan(0n);
      expect(BigInt(hole.measurement.observedScanDurationMs)).toBeLessThanOrEqual(BigInt(elapsed));
      expect(BigInt(hole.measurement.allocatedBytesEstimate)).toBe(await allocatedByDu(f.tree));
      await run("fallocate", ["--length", String(length), "--", sparse], { timeout: 5000 });
      const reserved = complete(await observe());
      expect(reserved.canonicalBytes).toEqual(hole.canonicalBytes);
      expect(reserved.digest).toBe(hole.digest);
      expect(reserved.totalBytes).toBe(hole.totalBytes);
      expect(BigInt(reserved.measurement.allocationByKind[Kind.File].allocatedBytesEstimate))
        .toBeGreaterThan(BigInt(hole.measurement.allocationByKind[Kind.File].allocatedBytesEstimate));
      expect(BigInt(reserved.measurement.allocatedBytesEstimate)).toBe(await allocatedByDu(f.tree));
    } finally { await f.cleanup(); }
  });

  // Red if target root/directories/link inodes are omitted, if link targets are
  // double-counted, or if opening ancestor anchors adds their allocation/counts.
  it("matches independent target du with directories and symlink inode counted without following it", async () => {
    const f = await fixture();
    const alias = join(f.tree, "internal"), outside = join(f.path, "outside.bin");
    try {
      await writeFile(outside, Buffer.alloc(1024 * 1024, 23));
      await symlink(`pkg/${"./".repeat(40)}index.js`, alias);
      const observed = complete(await f.observe());
      const total = await allocatedByDu(f.tree), file = await allocatedByDu(f.file), link = await allocatedByDu(alias);
      const categories = observed.measurement.allocationByKind;
      expect(BigInt(observed.measurement.allocatedBytesEstimate)).toBe(total);
      expect(BigInt(categories[Kind.File].allocatedBytesEstimate)).toBe(file);
      expect(BigInt(categories[Kind.Symlink].allocatedBytesEstimate)).toBe(link);
      expect(BigInt(categories[Kind.Directory].allocatedBytesEstimate)).toBe(total - file - link);
      expect(categories[Kind.Directory].inodeCount).toBe("2");
      expect(categories[Kind.File].inodeCount).toBe("1");
      expect(categories[Kind.Symlink].inodeCount).toBe("1");
      expect(await allocatedByDu(outside)).toBeGreaterThan(total);
      expect(await readFile(alias, "utf8")).toBe("abc");
    } finally { await f.cleanup(); }
  });

  it.each(["delete", "add", "same-size-old-mtime", "mode"])("detects %s from actual contents", async (change) => {
    const f = await fixture();
    try {
      const before = complete(await f.observe());
      if (change === "delete") await rm(join(f.tree, "pkg"), { recursive: true });
      if (change === "add") { await mkdir(join(f.tree, ".authored")); await writeFile(join(f.tree, ".authored", "code"), "xyz"); }
      if (change === "same-size-old-mtime") {
        const old = await lstat(f.file); await writeFile(f.file, "xyz"); await utimes(f.file, old.atime, old.mtime);
      }
      if (change === "mode") await chmod(f.file, 0o755);
      expect(complete(await f.observe()).digest).not.toBe(before.digest);
    } finally { await f.cleanup(); }
  });

  it("keeps distinct invalid UTF-8 filenames losslessly and sorts original bytes", async () => {
    const f = await fixture();
    try {
      await writeFile(Buffer.concat([Buffer.from(`${f.tree}/`), Buffer.from([255])]), "last");
      await writeFile(Buffer.concat([Buffer.from(`${f.tree}/`), Buffer.from([254])]), "first");
      const result = complete(await f.observe());
      expect(result.entries.slice(-2).map((entry) => entry.path)).toEqual([["/g=="], ["/w=="]]);
      expect(result.entries.slice(-2).map((entry) => entry.kind)).toEqual([Kind.File, Kind.File]);
    } finally { await f.cleanup(); }
  });

  it("captures raw internal symlink text and rejects indirect escape without reading outside", async () => {
    const f = await fixture();
    try {
      await symlink("pkg/index.js", join(f.tree, "internal"));
      const entry = complete(await f.observe()).entries.find((item) => item.kind === Kind.Symlink);
      expect(entry).toMatchObject({ kind: Kind.Symlink, target: Buffer.from("pkg/index.js").toString("base64") });
      await writeFile(join(f.path, "sentinel"), "outside original");
      await symlink("../sentinel", join(f.tree, "escape"));
      await symlink("escape", join(f.tree, "indirect"));
      expect(await f.observe()).toEqual({ status: Status.Incomplete, reason: Failure.ExternalSymlink });
      expect(await readFile(join(f.path, "sentinel"), "utf8")).toBe("outside original");
    } finally { await f.cleanup(); }
  });

  it("rejects an external hardlink and a FIFO without touching either", async () => {
    const f = await fixture();
    try {
      await link(f.file, join(f.path, "external-link"));
      expect(await f.observe()).toEqual({ status: Status.Incomplete, reason: Failure.Hardlink });
      await rm(join(f.path, "external-link"));
      await run("mkfifo", [join(f.tree, "fifo")], { timeout: 1000 });
      expect(await f.observe()).toEqual({ status: Status.Incomplete, reason: Failure.SpecialFile });
      expect((await lstat(join(f.tree, "fifo"))).isFIFO()).toBe(true);
      expect(await readFile(f.file, "utf8")).toBe("abc");
    } finally { await f.cleanup(); }
  });

  it("rejects an external deep link even when a safe raw root name has colliding joined base64", async () => {
    const f = await fixture();
    const joinedBase64 = "YWJj/ZGVm/Z2hp/amts/bW5v";
    const rawName = Buffer.from(joinedBase64, "base64");
    const rawPath = Buffer.concat([Buffer.from(`${f.tree}/`), rawName]);
    const directory = join(f.tree, "abc", "def", "ghi", "jkl");
    const externalTarget = "../../../../../sentinel";
    try {
      expect(rawName.toString("base64")).toBe(joinedBase64);
      await mkdir(directory, { recursive: true });
      await writeFile(join(f.path, "sentinel"), "independent outside bytes");
      await symlink(externalTarget, join(directory, "mno"));
      await symlink("pkg/index.js", rawPath);
      expect(await f.observe()).toEqual({ status: Status.Incomplete, reason: Failure.ExternalSymlink });
      expect(await readFile(join(f.path, "sentinel"), "utf8")).toBe("independent outside bytes");
      expect(await readFile(f.file, "utf8")).toBe("abc");
      expect(await readlink(join(directory, "mno"))).toBe(externalTarget);
      expect(await readlink(rawPath)).toBe("pkg/index.js");
    } finally { await f.cleanup(); }
  });

  it.each([{ maxEntries: 2 }, { maxTotalBytes: 2 }, { maxManifestBytes: 32 }])("returns incomplete rather than truncated proof for %j", async (bound) => {
    const f = await fixture();
    try {
      expect(await observeDependencyTree({ workspacePath: f.path, treeName: "node_modules", limits: { ...limits, ...bound } }))
        .toEqual({ status: Status.Incomplete, reason: Failure.Bounds });
      expect(await readFile(f.file, "utf8")).toBe("abc");
    } finally { await f.cleanup(); }
  });

  it("rejects supplied identity drift and a symlinked ancestor", async () => {
    const f = await fixture();
    try {
      const old = complete(await f.observe());
      await rename(f.tree, join(f.path, "old")); await mkdir(f.tree);
      expect(await observeDependencyTree({ workspacePath: f.path, treeName: "node_modules", expectedTree: old.tree, limits }))
        .toEqual({ status: Status.Incomplete, reason: Failure.IdentityChanged });
      await symlink(f.path, join(f.path, "alias"));
      expect(await observeDependencyTree({ workspacePath: join(f.path, "alias"), treeName: "node_modules", limits }))
        .toEqual({ status: Status.Incomplete, reason: Failure.UnsafeNamespace });
    } finally { await f.cleanup(); }
  });

  it("pins exact file bytes and refuses an alias or exceeded file bound", async () => {
    const f = await fixture();
    try {
      expect(await observeDependencyPinnedFile({ path: f.file, maxBytes: 4, maxDurationMs: 10000 }))
        .toMatchObject({ status: Status.Complete, sha256: createHash("sha256").update("abc").digest("hex"), size: "3" });
      expect(await observeDependencyPinnedFile({ path: f.file, maxBytes: 2, maxDurationMs: 10000 }))
        .toEqual({ status: Status.Incomplete, reason: Failure.Bounds });
      await symlink("pkg/index.js", join(f.tree, "alias"));
      expect(await observeDependencyPinnedFile({ path: join(f.tree, "alias"), maxBytes: 4, maxDurationMs: 10000 }))
        .toEqual({ status: Status.Incomplete, reason: Failure.SpecialFile });
    } finally { await f.cleanup(); }
  });

  // This is actual kernel evidence only when the CI launcher explicitly placed
  // this test in separate user+mount namespaces. A fake mount callback is not used.
  it.skipIf(process.env.SUBSCRIPTION_RUNTIME_TEST_MOUNT_NAMESPACE !== "1")("vetoes same-device directory and file bind mounts", async () => {
    expect((await readFile("/proc/self/uid_map", "utf8")).trim()).not.toMatch(/^0\s+0\s+4294967295$/);
    await run("mount", ["--make-rprivate", "/"], { timeout: 5000 });
    const f = await fixture();
    const mounted = join(f.tree, "bind");
    try {
      await mkdir(mounted); await run("mount", ["--bind", join(f.tree, "pkg"), mounted]);
      expect((await lstat(mounted)).dev).toBe((await lstat(join(f.tree, "pkg"))).dev);
      expect(await f.observe()).toEqual({ status: Status.Incomplete, reason: Failure.MountCrossing });
      await run("umount", [mounted]); await rm(mounted, { recursive: true });
      await writeFile(mounted, "old"); await run("mount", ["--bind", f.file, mounted]);
      expect((await lstat(mounted)).dev).toBe((await lstat(f.file)).dev);
      expect(await f.observe()).toEqual({ status: Status.Incomplete, reason: Failure.MountCrossing });
    } finally { await run("umount", [mounted]).catch(() => undefined); await f.cleanup(); }
  });
});

// Separate lifetime regression boundary: the ORIGINAL real byte walk survives
// joined close as a private relation. Every path below is a NEW TEST fixture.
describe.skipIf(process.platform !== "linux")("private source exposure after scan close", () => {
  async function source(f: Awaited<ReturnType<typeof fixture>>) {
    const s = await lstat(f.tree, { bigint: true });
    return { parentPath: f.path, name: "node_modules", expectedTree: { dev: String(s.dev), ino: String(s.ino) } };
  }
  async function exposure(f: Awaited<ReturnType<typeof fixture>>) {
    const value = await captureDependencySourceExposure({ roots: [await source(f)], limits });
    expect(value.status).toBe(Status.Complete);
    if (value.status !== Status.Complete) throw new Error(`TEST incomplete:${value.reason}`);
    return value.exposure;
  }

  // Fixture-specific actual kernel oracle, not the shared process FD count.
  // Namespace/outer-ancestor-only leaks still need an isolated native FD table.
  function fixtureDescriptors(path: string) {
    const names = readdirSync("/proc/self/fd");
    if (names.length > 4096) throw new Error("TEST FD inventory exceeds bounded profile");
    const found: { fd: number; dev: bigint; ino: bigint }[] = [];
    for (const name of names) {
      if (!/^(?:0|[1-9][0-9]*)$/.test(name)) throw new Error("TEST invalid proc FD name");
      const fd = Number(name);
      try {
        const target = readlinkSync(`/proc/self/fd/${name}`);
        if (target !== path && !target.startsWith(path + "/")) continue;
        const info = fstatSync(fd, { bigint: true });
        found.push({ fd, dev: info.dev, ino: info.ino });
      } catch (error) {
        // The inventory's own directory FD has closed; unrelated Vitest workers
        // may also close a descriptor. All other proc access failures are red.
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "EBADF") throw error;
      }
    }
    return found;
  }

  // Red if capture or synchronous current/refusal retains a target directory
  // anchor, directory stream, or transient O_PATH leaf inside this TEST tree.
  it("closes real fixture descriptors after capture and current success/refusal", async () => {
    const f = await fixture(); let handle: DependencySourceExposure | undefined;
    try {
      expect(fixtureDescriptors(f.path)).toEqual([]);
      const directory = await open(f.tree, "r");
      try {
        const file = await open(f.file, "r");
        try {
          const actual = fixtureDescriptors(f.path), expected = await lstat(f.file, { bigint: true });
          expect(actual.some(row => row.fd === directory.fd)).toBe(true);
          expect(actual.some(row => row.fd === file.fd && row.dev === expected.dev && row.ino === expected.ino)).toBe(true);
        } finally { await file.close(); }
      } finally { await directory.close(); }
      handle = await exposure(f); expect(fixtureDescriptors(f.path)).toEqual([]);
      assertDependencySourceExposureCurrent(handle); expect(fixtureDescriptors(f.path)).toEqual([]);
      await chmod(f.file, 0o755);
      expect(() => assertDependencySourceExposureCurrent(handle!)).toThrow();
      expect(fixtureDescriptors(f.path)).toEqual([]);
      expect(await captureDependencySourceExposure({ roots: [await source(f)], limits: { ...limits, maxEntries: 1 } }))
        .toEqual({ status: Status.Incomplete, reason: Failure.Bounds });
      expect(fixtureDescriptors(f.path)).toEqual([]); expect(await readFile(f.file, "utf8")).toBe("abc");
    } finally { if (handle) closeDependencySourceExposure(handle); await f.cleanup(); }
  });

  // Red if a caller Complete DTO/copied brand can mint authority, or if source
  // ancestry freezes unrelated output membership/ctime after joined close.
  it("recognizes only its own handle and permits unrelated ancestor outputs", async () => {
    const f = await fixture(); let handle: DependencySourceExposure | undefined;
    try {
      const dto = complete(await f.observe()); handle = await exposure(f);
      expect(() => assertDependencySourceExposureCurrent(dto as unknown as DependencySourceExposure)).toThrow();
      expect(() => assertDependencySourceExposureCurrent({ ...handle! })).toThrow();
      await mkdir(join(f.path, "output")); await writeFile(join(f.path, "output", "failed-result"), "preserved TEST output");
      expect(() => assertDependencySourceExposureCurrent(handle!)).not.toThrow();
      expect(await readFile(f.file, "utf8")).toBe("abc");
      closeDependencySourceExposure(handle);
      expect(() => assertDependencySourceExposureCurrent(handle!)).toThrow();
    } finally { if (handle) closeDependencySourceExposure(handle); await f.cleanup(); }
  });

  // Red if post-close currentness uses root dev/ino, old mtime, new snapshots,
  // logical link resolution or generic content digest instead of original pins.
  it.each(["same-size-old-mtime", "membership", "root", "link-text", "hardlink", "mode", "raw-name"])("rejects real post-close %s substitution", async change => {
    const f = await fixture(), raw = Buffer.concat([Buffer.from(f.tree + "/"), Buffer.from([255])]);
    let handle: DependencySourceExposure | undefined;
    try {
      await utimes(f.file, new Date(1000), new Date(1000));
      await symlink("pkg/index.js", join(f.tree, "internal")); await writeFile(raw, "raw TEST bytes");
      const before = await lstat(f.file, { bigint: true }); handle = await exposure(f);
      if (change === "same-size-old-mtime") {
        await writeFile(f.file, "xyz"); await utimes(f.file, new Date(1000), new Date(1000));
        const current = await lstat(f.file, { bigint: true }); expect(current.ino).toBe(before.ino);
        expect(current.size).toBe(before.size); expect(current.mtimeNs).toBe(before.mtimeNs); expect(current.ctimeNs).not.toBe(before.ctimeNs);
      }
      if (change === "membership") await writeFile(join(f.tree, ".authored-source"), "preserve this addition");
      if (change === "root") {
        await rename(f.tree, join(f.path, "retained-original-source")); await mkdir(f.tree);
        await mkdir(join(f.tree, "pkg")); await writeFile(f.file, "abc");
      }
      if (change === "link-text") { await rm(join(f.tree, "internal")); await symlink("pkg/./index.js", join(f.tree, "internal")); }
      if (change === "hardlink") await link(f.file, join(f.path, "external-alias"));
      if (change === "mode") await chmod(f.file, 0o755);
      if (change === "raw-name") await rename(raw, Buffer.concat([Buffer.from(f.tree + "/"), Buffer.from([254])]));
      expect(() => assertDependencySourceExposureCurrent(handle!)).toThrow();
      expect(() => assertDependencySourceExposureCurrent(handle!)).toThrow(); // Failure cannot recapture/revive this entry.
      expect(await readFile(f.file, "utf8")).toBe(change === "same-size-old-mtime" ? "xyz" : "abc");
      if (change === "root") expect(await readFile(join(f.path, "retained-original-source/pkg/index.js"), "utf8")).toBe("abc");
      if (change === "hardlink") expect(await readFile(join(f.path, "external-alias"), "utf8")).toBe("abc");
    } finally { if (handle) closeDependencySourceExposure(handle); await f.cleanup(); }
  });

  // Independent oracle: two actual roots each contain three entries/three
  // bytes. Bounds belong to the whole operation, never reset for each package.
  it.each([{ maxEntries: 5 }, { maxTotalBytes: 5 }])("enforces aggregate multi-root bounds %j", async bound => {
    const a = await fixture(), b = await fixture();
    try {
      expect(await captureDependencySourceExposure({ roots: [await source(a), await source(b)], limits: { ...limits, ...bound } }))
        .toEqual({ status: Status.Incomplete, reason: Failure.Bounds });
      expect(await readFile(a.file, "utf8")).toBe("abc"); expect(await readFile(b.file, "utf8")).toBe("abc");
    } finally { await a.cleanup(); await b.cleanup(); }
  });

  it("refuses an escaping source link without touching its independent outside sentinel", async () => {
    const f = await fixture();
    try {
      await writeFile(join(f.path, "outside"), "outside TEST original"); await symlink("../outside", join(f.tree, "escape"));
      expect(await captureDependencySourceExposure({ roots: [await source(f)], limits }))
        .toEqual({ status: Status.Incomplete, reason: Failure.ExternalSymlink });
      expect(await readFile(join(f.path, "outside"), "utf8")).toBe("outside TEST original");
    } finally { await f.cleanup(); }
  });

  // Requires the existing explicit disposable owned user+mount namespace
  // launcher. Own uid_map is accessible; no foreign PID1 namespace is read.
  it.skipIf(process.env.SUBSCRIPTION_RUNTIME_TEST_MOUNT_NAMESPACE !== "1")("rejects post-close same-inode file bind mount", async () => {
    expect((await readFile("/proc/self/uid_map", "utf8")).trim()).not.toMatch(/^0\s+0\s+4294967295$/);
    await run("mount", ["--make-rprivate", "/"], { timeout: 5000 });
    const f = await fixture(); let handle: DependencySourceExposure | undefined, mounted = false;
    try {
      handle = await exposure(f); const before = await lstat(f.file, { bigint: true });
      await run("mount", ["--bind", f.file, f.file], { timeout: 5000 }); mounted = true;
      expect((await lstat(f.file, { bigint: true })).ino).toBe(before.ino);
      expect(() => assertDependencySourceExposureCurrent(handle!)).toThrow(Failure.MountCrossing);
      expect(await readFile(f.file, "utf8")).toBe("abc");
    } finally { if (mounted) await run("umount", [f.file], { timeout: 5000 });
      if (handle) closeDependencySourceExposure(handle); await f.cleanup(); }
  });
});

// Red if physical capture requires logical qualification, weakens generic
// observation, resets either baseline, or leaves a closed handle usable.
describe.skipIf(process.platform !== "linux")("raw local comparison baselines", () => {
  it("retains hardlink and entry bounds on the fixed physical entry", async () => {
    const f = await fixture();
    try {
      const workspace = await lstat(f.path, { bigint: true }), tree = await lstat(f.tree, { bigint: true });
      const input = { workspace: { canonicalPath: f.path, dev: String(workspace.dev), ino: String(workspace.ino) },
        expectedTree: { dev: String(tree.dev), ino: String(tree.ino) }, limits };
      expect(await captureDependencyPhysicalTreeExposure({ ...input, limits: { ...limits, maxEntries: 1 } }))
        .toEqual({ status: Status.Incomplete, reason: Failure.Bounds });
      await link(f.file, join(f.path, "outside-hardlink"));
      expect(await captureDependencyPhysicalTreeExposure(input)).toEqual({ status: Status.Incomplete, reason: Failure.Hardlink });
      expect(await readFile(f.file, "utf8")).toBe("abc");
    } finally { await f.cleanup(); }
  });
  it("pins each separate tree across closed scans without following external links", async () => {
    const candidate = await fixture(), reference = await fixture();
    const handles: DependencySourceExposure[] = [];
    try {
      for (const f of [candidate, reference]) {
        await writeFile(join(f.path, "outside"), "TEST outside source");
        await symlink("../outside", join(f.tree, "local"));
        const root = await lstat(f.path, { bigint: true }), tree = await lstat(f.tree, { bigint: true });
        const value = await captureDependencyPhysicalTreeExposure({ workspace: { canonicalPath: f.path, dev: String(root.dev), ino: String(root.ino) },
          expectedTree: { dev: String(tree.dev), ino: String(tree.ino) }, limits });
        expect(value.status).toBe(Status.Complete);
        if (value.status !== Status.Complete) throw new Error(`TEST physical incomplete:${value.reason}`);
        handles.push(value.exposure);
        expect(Object.keys(value)).toEqual(["status", "exposure"]);
        expect(await f.observe()).toEqual({ status: Status.Incomplete, reason: Failure.ExternalSymlink });
        expect(await captureDependencySourceExposure({ roots: [{ parentPath: f.path, name: "node_modules",
          expectedTree: { dev: String(tree.dev), ino: String(tree.ino) } }], limits }))
          .toEqual({ status: Status.Incomplete, reason: Failure.ExternalSymlink });
      }
      expect(() => assertDependencySourceExposureCurrent(handles[0]!)).not.toThrow();
      expect(() => assertDependencySourceExposureCurrent(handles[1]!)).not.toThrow();
      await writeFile(reference.file, "xyz");
      expect(() => assertDependencySourceExposureCurrent(handles[1]!)).toThrow();
      expect(() => assertDependencySourceExposureCurrent(handles[0]!)).not.toThrow();
      await rm(join(candidate.tree, "local")); await symlink("../other", join(candidate.tree, "local"));
      expect(() => assertDependencySourceExposureCurrent(handles[0]!)).toThrow();
      expect(await readFile(join(reference.path, "outside"), "utf8")).toBe("TEST outside source");
      expect(await readFile(join(candidate.path, "outside"), "utf8")).toBe("TEST outside source");
    } finally {
      for (const handle of handles) { closeDependencySourceExposure(handle); expect(() => assertDependencySourceExposureCurrent(handle)).toThrow(); }
      await candidate.cleanup(); await reference.cleanup();
    }
  });
});
