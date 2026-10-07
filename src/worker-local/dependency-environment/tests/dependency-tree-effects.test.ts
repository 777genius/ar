import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { DependencyReceiptState, type DependencyReceipt, type DependencyWorkspaceIdentity } from "../../../worker-core/dependency-environment/domain/dependency-receipt";
import { DependencyTreeObservationStatus as Status } from "../../../worker-core/dependency-environment/domain/dependency-tree-manifest";
import { observeDependencyTree } from "../observe-dependency-tree";
import { openCommittedDependencyTrashRemoval, openDependencyTreeRename, readDependencyTreeEffectReferenceAnchors, type DependencyTreeEffectInput } from "../dependency-tree-effects";

const durabilityFailure = vi.hoisted(() => ({ nextSync: false }));
vi.mock("node:fs", async importOriginal => {
  const real = await importOriginal<typeof import("node:fs")>();
  return { ...real, fsyncSync(fd: number): void {
    if (durabilityFailure.nextSync) { durabilityFailure.nextSync = false; throw new Error("TEST-step-fsync-uncertain"); }
    real.fsyncSync(fd);
  } };
});

const run = promisify(execFile);
const limits = { maxEntries: 128, maxTotalBytes: 65536, maxManifestBytes: 65536, maxDurationMs: 30000 };
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function id(path: string): Promise<DependencyWorkspaceIdentity> {
  const s = await lstat(path, { bigint: true }); return { canonicalPath: path, dev: String(s.dev), ino: String(s.ino) };
}
async function fixture(raw = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "TEST-dependency-effects-")));
  const workspacePath = join(root, "workspace"), trashPath = join(root, "trash"), records = join(root, "records");
  await mkdir(workspacePath); await mkdir(trashPath, { mode: 0o700 }); await mkdir(records, { mode: 0o700 });
  const tree = join(workspacePath, "node_modules"), pkg = join(tree, "pkg"); await mkdir(tree); await mkdir(pkg);
  await writeFile(join(pkg, "a.js"), "original-a"); await writeFile(join(pkg, "b.js"), "original-b");
  await mkdir(join(workspacePath, ".git")); await writeFile(join(workspacePath, ".git/config"), "TEST-source-git");
  if (raw) for (const name of [Buffer.from([255, 128]), Buffer.from([254, 128])])
    await writeFile(Buffer.concat([Buffer.from(pkg + "/"), name]), name);
  const observed = await observeDependencyTree({ workspacePath, treeName: "node_modules", limits });
  if (observed.status !== Status.Complete) throw new Error(`TEST fixture:${observed.reason}`);
  const workspace = await id(workspacePath), destinationParent = await id(trashPath), operationId = randomUUID();
  const input: DependencyTreeEffectInput = { workspace, trash: { operationId, originalTree: observed.tree, destinationParent,
    destinationName: `dependency-${operationId}` }, manifestCanonicalBytes: observed.canonicalBytes, manifestDigest: observed.digest, limits };
  const target = join(trashPath, input.trash.destinationName);
  async function stage() { const op = await openDependencyTreeRename(input); try { await op.rename(); } finally { await op.close(); } }
  async function commit() {
    const installKey = "a".repeat(64), proof = { generation: "TEST-generation", workspace, coverageRevision: "TEST-coverage",
      installKey, tree: input.trash.originalTree, manifestDigest: input.manifestDigest, operationId, trash: input.trash, commitEvidenceId: operationId };
    const receipt: DependencyReceipt = { version: 1, revision: 2, generation: proof.generation, workspace,
      coverageRevision: proof.coverageRevision, state: DependencyReceiptState.Absent, operationId, installKey, evictionCommit: proof };
    const bytes = Buffer.from(JSON.stringify(receipt) + "\n"), path = join(records, operationId + ".json");
    await writeFile(path, bytes, { mode: 0o600, flag: "wx" }); return { path, identity: await id(path), sha256: hash(bytes) };
  }
  return { root, workspacePath, tree, pkg, trashPath, target, input, stage, commit,
    cleanup: () => rm(root, { recursive: true, force: true }) };
}

// These tests verify real synthetic TEST filesystem effects, never a runtime or
// real user project. Protected fixture commits model only the adapter contract;
// actual admission, grant exclusion and kernel mount coverage require hosted TEST.
describe.skipIf(process.platform !== "linux")("anchored dependency effects", () => {
  it("only a live exact operation can exempt its actual retained directory descriptors", async () => {
    // Copying a receipt or retaining it after close must not hide an unrelated
    // supervisor reference from the final retiring-tree veto.
    const f = await fixture(), operation = await openDependencyTreeRename(f.input), unrelated = await open(join(f.pkg, "a.js"), "r");
    const expected = { workspace: f.input.workspace, trashPath: f.target, operationId: f.input.trash.operationId };
    try {
      const descriptors = readDependencyTreeEffectReferenceAnchors(operation.referenceSession, expected);
      expect(descriptors.some(item => item.dev === f.input.trash.originalTree.dev && item.ino === f.input.trash.originalTree.ino)).toBe(true);
      expect(descriptors.some(item => item.fd === unrelated.fd)).toBe(false);
      for (const descriptor of descriptors) {
        const retained = await stat(`/proc/self/fd/${descriptor.fd}`, { bigint: true });
        expect(retained.isDirectory()).toBe(true);
        expect([String(retained.dev), String(retained.ino)]).toEqual([descriptor.dev, descriptor.ino]);
        expect(descriptor.flags).toMatch(/^[0-7]+$/);
      }
      expect(() => readDependencyTreeEffectReferenceAnchors({ ...operation.referenceSession }, expected)).toThrow("closed");
      expect(() => readDependencyTreeEffectReferenceAnchors(operation.referenceSession, { ...expected, operationId: randomUUID() })).toThrow();
      expect(await readFile(join(f.pkg, "a.js"), "utf8")).toBe("original-a");
      await operation.close();
      expect(() => readDependencyTreeEffectReferenceAnchors(operation.referenceSession, expected)).toThrow("closed");
      expect(await readFile(join(f.pkg, "a.js"), "utf8")).toBe("original-a");
    } finally { await unrelated.close(); await operation.close(); await f.cleanup(); }
  });
  it("renames the exact tree while preserving source Git and inode", async () => {
    const f = await fixture();
    try {
      await f.stage(); expect(await id(f.target)).toMatchObject(f.input.trash.originalTree);
      await expect(lstat(f.tree)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(f.workspacePath, ".git/config"), "utf8")).toBe("TEST-source-git");
      expect(await readFile(join(f.target, "pkg/a.js"), "utf8")).toBe("original-a");
    } finally { await f.cleanup(); }
  });
  // Regression: POSIX rename can replace an existing empty destination directory.
  it("preserves even an empty conflicting destination", async () => {
    const f = await fixture();
    try {
      await mkdir(f.target); const before = await id(f.target);
      await expect(openDependencyTreeRename(f.input)).rejects.toThrow("conflict");
      expect(await id(f.target)).toEqual(before); expect(await readFile(join(f.pkg, "a.js"), "utf8")).toBe("original-a");
    } finally { await f.cleanup(); }
  });
  it.each(["content", "mode", "addition"])("rejects %s after descriptor preparation", async change => {
    const f = await fixture(), op = await openDependencyTreeRename(f.input);
    try {
      if (change === "content") await writeFile(join(f.pkg, "a.js"), "changed--a");
      if (change === "mode") await chmod(join(f.pkg, "a.js"), 0o600);
      if (change === "addition") await writeFile(join(f.pkg, ".authored"), "TEST-added");
      await expect(op.rename()).rejects.toThrow(); expect((await lstat(f.tree)).isDirectory()).toBe(true);
      await expect(lstat(f.target)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await op.close(); await f.cleanup(); }
  });
  it("blocks a swapped ancestor before publication and preserves the external sentinel", async () => {
    const f = await fixture(), op = await openDependencyTreeRename(f.input), external = join(f.root, "TEST-external");
    try {
      await mkdir(external); await mkdir(join(external, "node_modules")); await writeFile(join(external, "node_modules/sentinel"), "TEST-external");
      await rename(f.workspacePath, f.workspacePath + ".original"); await symlink(external, f.workspacePath);
      await expect(op.rename()).rejects.toThrow();
      expect(await readFile(join(external, "node_modules/sentinel"), "utf8")).toBe("TEST-external");
      expect(await readFile(join(f.workspacePath + ".original", "node_modules/pkg/a.js"), "utf8")).toBe("original-a");
    } finally { await op.close(); await f.cleanup(); }
  });
  it("rejects a same-content root replacement with another inode", async () => {
    const f = await fixture(), op = await openDependencyTreeRename(f.input);
    try {
      await rename(f.tree, f.tree + ".original"); await mkdir(f.tree); await mkdir(join(f.tree, "pkg"));
      await writeFile(join(f.tree, "pkg/a.js"), "original-a"); await writeFile(join(f.tree, "pkg/b.js"), "original-b");
      await expect(op.rename()).rejects.toThrow(); expect(await readFile(join(f.tree, "pkg/a.js"), "utf8")).toBe("original-a");
    } finally { await op.close(); await f.cleanup(); }
  });
  it("retries a bounded partial removal only from the committed matching remainder", async () => {
    const f = await fixture();
    try {
      await f.stage(); const commit = await f.commit(), bytes = await readFile(commit.path);
      const partial = await openCommittedDependencyTrashRemoval({ ...f.input, commit, maxRemovals: 1 });
      try { await expect(partial.remove()).rejects.toThrow("bounds"); } finally { await partial.close(); }
      expect((await lstat(f.target)).isDirectory()).toBe(true); expect(await readFile(commit.path)).toEqual(bytes);
      const retry = await openCommittedDependencyTrashRemoval({ ...f.input, commit, maxRemovals: 128 });
      try { expect((await retry.remove()).removedEntries).toBeGreaterThan(0); } finally { await retry.close(); }
      await expect(lstat(f.target)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(f.workspacePath, ".git/config"), "utf8")).toBe("TEST-source-git");
    } finally { await f.cleanup(); }
  });
  it("submits exactly one synchronous removal, closes its handles, then resumes the verified remainder", async () => {
    // A bulk/async submission would cross the caller's next fence boundary.
    // A retained closed session must never permit another effect after a crash.
    const f = await fixture();
    try {
      await f.stage(); const commit = await f.commit(), commitBytes = await readFile(commit.path);
      const operation = await openCommittedDependencyTrashRemoval({ ...f.input, commit, maxRemovals: 128 });
      const steps = await operation.prepareSynchronousRemoval();
      const expected = { workspace: f.input.workspace, trashPath: f.target, operationId: f.input.trash.operationId };
      expect(readDependencyTreeEffectReferenceAnchors(steps.referenceSession, expected).length).toBeGreaterThan(0);
      expect(steps.progress()).toEqual({ operationId: f.input.trash.operationId, removedEntries: 0, remainingEntries: 4 });
      const progress = steps.removeNext();
      expect(steps.progress()).toEqual(progress);
      expect(progress).toEqual({ operationId: f.input.trash.operationId, removedEntries: 1, remainingEntries: 3 });
      await expect(lstat(join(f.target, "pkg/b.js"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(f.target, "pkg/a.js"), "utf8")).toBe("original-a");
      expect(await operation.close()).toEqual({ closeFailures: 0 });
      expect(() => steps.removeNext()).toThrow("closed");
      expect(() => readDependencyTreeEffectReferenceAnchors(steps.referenceSession, expected)).toThrow("closed");
      expect(await readFile(join(f.target, "pkg/a.js"), "utf8")).toBe("original-a");
      const retry = await openCommittedDependencyTrashRemoval({ ...f.input, commit, maxRemovals: 128 });
      try { expect((await retry.remove()).removedEntries).toBe(3); } finally { await retry.close(); }
      await expect(lstat(f.target)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(commit.path)).toEqual(commitBytes);
      expect(await readFile(join(f.workspacePath, ".git/config"), "utf8")).toBe("TEST-source-git");
    } finally { await f.cleanup(); }
  });
  it("holds the same session after a post-unlink durability failure until close and verified reopen", async () => {
    // Regression: incrementing progress before fsync must not permit the next
    // effect after an uncertain step. All physical reads/unlinks remain real.
    const f = await fixture();
    try {
      await f.stage(); const commit = await f.commit(), operation = await openCommittedDependencyTrashRemoval({ ...f.input, commit, maxRemovals: 128 });
      try {
        const steps = await operation.prepareSynchronousRemoval(); durabilityFailure.nextSync = true;
        expect(() => steps.removeNext()).toThrow("TEST-step-fsync-uncertain");
        await expect(lstat(join(f.target, "pkg/b.js"))).rejects.toMatchObject({ code: "ENOENT" });
        expect(() => steps.removeNext()).toThrow("closed");
        expect(() => steps.progress()).toThrow("closed");
        expect(await readFile(join(f.target, "pkg/a.js"), "utf8")).toBe("original-a");
      } finally { durabilityFailure.nextSync = false; await operation.close(); }
      const retry = await openCommittedDependencyTrashRemoval({ ...f.input, commit, maxRemovals: 128 });
      try { expect((await retry.remove()).removedEntries).toBe(3); } finally { await retry.close(); }
      await expect(lstat(f.target)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(f.workspacePath, ".git/config"), "utf8")).toBe("TEST-source-git");
    } finally { durabilityFailure.nextSync = false; await f.cleanup(); }
  });
  it("requires a fresh opener after failed preparation even when the remaining content is repaired", async () => {
    const f = await fixture();
    try {
      await f.stage(); const commit = await f.commit(), operation = await openCommittedDependencyTrashRemoval({ ...f.input, commit, maxRemovals: 128 });
      try {
        await writeFile(join(f.target, "pkg/b.js"), "modified-b");
        await expect(operation.prepareSynchronousRemoval()).rejects.toThrow();
        await writeFile(join(f.target, "pkg/b.js"), "original-b");
        await expect(operation.prepareSynchronousRemoval()).rejects.toThrow("closed");
        expect(await readFile(join(f.target, "pkg/a.js"), "utf8")).toBe("original-a");
      } finally { await operation.close(); }
      const retry = await openCommittedDependencyTrashRemoval({ ...f.input, commit, maxRemovals: 128 });
      try { expect((await retry.remove()).removedEntries).toBe(4); } finally { await retry.close(); }
    } finally { await f.cleanup(); }
  });
  it.each(["identity", "content", "hardlink"])("rejects next leaf %s after preparation before any synchronous effect", async change => {
    const f = await fixture();
    try {
      await f.stage(); const commit = await f.commit(), operation = await openCommittedDependencyTrashRemoval({ ...f.input, commit, maxRemovals: 128 });
      try {
        const steps = await operation.prepareSynchronousRemoval(), next = join(f.target, "pkg/b.js");
        if (change === "identity") { await rename(next, join(f.root, "TEST-retained-original")); await writeFile(next, "original-b"); }
        if (change === "content") await writeFile(next, "modified-b");
        if (change === "hardlink") await link(next, join(f.root, "TEST-external-hardlink"));
        expect(() => steps.removeNext()).toThrow();
        expect(await readFile(join(f.target, "pkg/a.js"), "utf8")).toBe("original-a");
        expect(await readFile(next, "utf8")).toBe(change === "content" ? "modified-b" : "original-b");
        if (change === "identity") { await rm(next); await rename(join(f.root, "TEST-retained-original"), next); }
        if (change === "content") await writeFile(next, "original-b");
        if (change === "hardlink") await rm(join(f.root, "TEST-external-hardlink"));
        expect(() => steps.removeNext()).toThrow("closed"); // Repair never revives a held session.
        expect(await readFile(next, "utf8")).toBe("original-b");
      } finally { await operation.close(); }
    } finally { await f.cleanup(); }
  });
  it.each(["addition", "mode", "content", "external-link", "hardlink"])("preserves unexplained committed trash %s", async change => {
    const f = await fixture();
    try {
      await f.stage(); const commit = await f.commit(), file = join(f.target, "pkg/a.js"), sentinel = join(f.root, "TEST-sentinel");
      await writeFile(sentinel, "TEST-external");
      if (change === "addition") await writeFile(join(f.target, "pkg/.authored"), "new");
      if (change === "mode") await chmod(file, 0o600);
      if (change === "content") await writeFile(file, "modified");
      if (change === "external-link") { await rm(file); await symlink(sentinel, file); }
      if (change === "hardlink") await link(file, join(f.root, "TEST-external-hardlink"));
      await expect(openCommittedDependencyTrashRemoval({ ...f.input, commit, maxRemovals: 128 })).rejects.toThrow();
      expect((await lstat(f.target)).isDirectory()).toBe(true); expect(await readFile(sentinel, "utf8")).toBe("TEST-external");
      expect(await readFile(join(f.target, "pkg/b.js"), "utf8")).toBe("original-b");
    } finally { await f.cleanup(); }
  });
  it("rechecks changed content immediately before removal", async () => {
    const f = await fixture();
    try {
      await f.stage(); const commit = await f.commit(), op = await openCommittedDependencyTrashRemoval({ ...f.input, commit, maxRemovals: 128 });
      try {
        await writeFile(join(f.target, "pkg/a.js"), "modified"); await expect(op.remove()).rejects.toThrow();
        expect(await readFile(join(f.target, "pkg/b.js"), "utf8")).toBe("original-b");
      } finally { await op.close(); }
    } finally { await f.cleanup(); }
  });
  it.each(["ancestor", "root"])("preserves a swapped trash %s and external sentinel before removal", async change => {
    const f = await fixture();
    try {
      await f.stage(); const commit = await f.commit(), op = await openCommittedDependencyTrashRemoval({ ...f.input, commit, maxRemovals: 128 });
      const external = join(f.root, "TEST-external"), selected = change === "ancestor" ? f.trashPath : f.target;
      try {
        await mkdir(external); await writeFile(join(external, "sentinel"), "TEST-external");
        await rename(selected, selected + ".original"); await symlink(external, selected);
        await expect(op.remove()).rejects.toThrow();
        expect(await readFile(join(external, "sentinel"), "utf8")).toBe("TEST-external");
        const original = change === "ancestor" ? join(selected + ".original", f.input.trash.destinationName) : selected + ".original";
        expect(await readFile(join(original, "pkg/a.js"), "utf8")).toBe("original-a");
      } finally { await op.close(); }
    } finally { await f.cleanup(); }
  });
  it("rejects an insufficient inventory bound before publication", async () => {
    const f = await fixture();
    try {
      await expect(openDependencyTreeRename({ ...f.input, limits: { ...limits, maxEntries: 1 } })).rejects.toThrow();
      expect(await readFile(join(f.pkg, "a.js"), "utf8")).toBe("original-a");
      await expect(lstat(f.target)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await f.cleanup(); }
  });
  it("keeps raw non-UTF8 names distinct through inventory, rename and removal", async () => {
    const f = await fixture(true);
    try {
      await f.stage(); const commit = await f.commit(), op = await openCommittedDependencyTrashRemoval({ ...f.input, commit, maxRemovals: 128 });
      try { expect((await op.remove()).removedEntries).toBe(6); } finally { await op.close(); }
      await expect(lstat(f.target)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await f.cleanup(); }
  });
  it("requires exact immutable commit bytes before any deletion", async () => {
    const f = await fixture();
    try {
      await f.stage(); const commit = await f.commit(); await writeFile(commit.path, "{}\n");
      await expect(openCommittedDependencyTrashRemoval({ ...f.input, commit, maxRemovals: 128 })).rejects.toThrow("invalid_commit");
      expect(await readFile(join(f.target, "pkg/a.js"), "utf8")).toBe("original-a");
    } finally { await f.cleanup(); }
  });
});

it.skipIf(process.platform !== "linux" || process.geteuid?.() !== 0 || process.env.SR_TEST_NATIVE_DEPENDENCY_MOUNTS !== "1")(
  "native TEST same-device bind mount veto preserves the exact original tree", async () => {
    const f = await fixture(); let mounted = false;
    try {
      await run("/usr/bin/mount", ["--bind", f.tree, f.tree]); mounted = true;
      await expect(openDependencyTreeRename(f.input)).rejects.toThrow();
      expect(await readFile(join(f.pkg, "a.js"), "utf8")).toBe("original-a");
    } finally { if (mounted) await run("/usr/bin/umount", [f.tree]); await f.cleanup(); }
  });
