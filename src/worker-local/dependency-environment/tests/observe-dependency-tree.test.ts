import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { DependencyManifestEntryKind as Kind, DependencyTreeObservationFailure as Failure,
  DependencyTreeObservationStatus as Status, type DependencyCapturedTreeObservation } from "../../../worker-core/dependency-environment/domain/dependency-tree-manifest";
import { observeDependencyDirectoryRoot, observeDependencyTree } from "../observe-dependency-tree";
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
    expect(await readlink("/proc/self/ns/mnt")).not.toBe(await readlink("/proc/1/ns/mnt"));
    expect(await readlink("/proc/self/ns/user")).not.toBe(await readlink("/proc/1/ns/user"));
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
