import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { DependencyReceiptState, type DependencyReceipt, type DependencyWorkspaceIdentity } from "../../../worker-core/dependency-environment/domain/dependency-receipt";
import { DependencyTreeObservationStatus as Status } from "../../../worker-core/dependency-environment/domain/dependency-tree-manifest";
import { observeDependencyTree } from "../observe-dependency-tree";
import { openCommittedDependencyTrashRemoval, openDependencyTreeRename, type DependencyTreeEffectInput } from "../dependency-tree-effects";

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
