import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { JobStorageCapabilityStatus as Status, JobStorageHomeStateRequirement, JobStorageIntentKind,
  JobStorageSettlementStatus, type JobStorageSettlement } from "@vioxen/subscription-runtime/worker-core";
import { SourceHandoffRoot as Root, type SourceHandoffManifest, type SourceHandoffReceipt } from "../source-handoff-contracts";
import { assertSourceHandoffArtifacts, handoffFacetDigest, inventorySourceHandoff, sourceHandoffDirectory } from "../source-handoff-filesystem";
import { captureEncryptedSourceHandoff, restoreEncryptedSourceHandoff } from "../source-handoff-envelope";
import { inspectSourceHandoffDependencies, inspectSourceHandoffGit } from "../source-handoff-git";
import { LocalSourceHandoffReceiptStore } from "../local-source-handoff-receipts";
import { LocalSourceHandoff } from "../local-source-handoff";
const execute = promisify(execFile), key = new Uint8Array(32).fill(71), binding = "NEW TEST offline crypto fixture; no native authority";
const ownerIdentity = { GIT_AUTHOR_NAME: "iliya", GIT_AUTHOR_EMAIL: "iliyazelenkog@gmail.com",
  GIT_COMMITTER_NAME: "iliya", GIT_COMMITTER_EMAIL: "iliyazelenkog@gmail.com" };
async function git(workspace: string, ...args: string[]): Promise<string> {
  if (["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_INDEX_FILE"]
      .some(name => process.env[name] !== undefined)) throw new Error("TEST_git_repository_routing_override_unsupported");
  // All TEST fixture mutations/commits honor normal configured Git hooks.
  return (await execute("git", ["-C", workspace, ...args],
    { env: { ...process.env, ...ownerIdentity }, timeout: 10_000 })).stdout.trim();
}
async function restoredGitRead(workspace: string, ...args: string[]): Promise<string> {
  // Read-only restored state is never an activation/hook authority.
  return (await execute("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", workspace, ...args],
    { env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null" }, timeout: 10_000 })).stdout.trim();
}
async function commit(workspace: string, message: string): Promise<void> {
  // All synthetic TEST Git commits still use the owner's exact identity.
  for (const identity of ["GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"]) {
    expect(await git(workspace, "var", identity)).toMatch(/^iliya <iliyazelenkog@gmail.com> /);
  }
  await git(workspace, "commit", "-m", message);
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "NEW-TEST-source-handoff-"));
  for (const name of ["workspace", "output", "evidence", "encrypted", "restore"]) await mkdir(join(root, name), { mode: 0o700 });
  const roots = { workspace: await sourceHandoffDirectory(join(root, "workspace")),
    output: await sourceHandoffDirectory(join(root, "output")), evidence: await sourceHandoffDirectory(join(root, "evidence")) };
  await git(roots.workspace.path, "init", "--initial-branch=main", "--template=");
  expect(await git(roots.workspace.path, "rev-parse", "--show-toplevel")).toBe(roots.workspace.path);
  expect(await git(roots.workspace.path, "rev-parse", "--absolute-git-dir")).toBe(join(roots.workspace.path, ".git"));
  await writeFile(join(roots.workspace.path, "tracked.txt"), "base\n");
  await writeFile(join(roots.workspace.path, ".gitignore"), "ignored-unique.txt\n");
  await git(roots.workspace.path, "add", "."); await commit(roots.workspace.path, "test: initial source fixture");
  await writeFile(join(roots.output.path, "result.json"), '{"TEST":"complete"}\n');
  await writeFile(join(roots.evidence.path, "proof.txt"), "TEST source evidence\n");
  return { root, roots, destination: await sourceHandoffDirectory(join(root, "encrypted")),
    restoreParent: await sourceHandoffDirectory(join(root, "restore")), cleanup: () => rm(root, { recursive: true, force: true }) };
}
async function manifestFor(f: Awaited<ReturnType<typeof fixture>>): Promise<SourceHandoffManifest> {
  const entries = await inventorySourceHandoff(f.roots, () => undefined);
  await inspectSourceHandoffDependencies(f.roots.workspace.path, entries);
  const requiredArtifacts = { output: ["result.json"], evidence: ["proof.txt"] };
  assertSourceHandoffArtifacts(entries, requiredArtifacts);
  return { schemaVersion: 1, entries, requiredArtifacts, gitFactsSha256: await inspectSourceHandoffGit(f.roots.workspace.path, entries) };
}

describe("encrypted standalone source handoff filesystem capability (not native qualification)", () => {
  it("restores staged/worktree, ignored, stash, extra refs, reflog-only and dangling objects after original source disappears", async () => {
    const f = await fixture(), workspace = f.roots.workspace.path;
    try {
      const base = await git(workspace, "rev-parse", "HEAD");
      await writeFile(join(workspace, "tracked.txt"), "stash-only bytes\n");
      await git(workspace, "stash", "push", "-m", "TEST stash");
      const stash = await git(workspace, "rev-parse", "refs/stash");
      await git(workspace, "update-ref", "refs/TEST/extra", base);
      await writeFile(join(workspace, "reflog-only.txt"), "reflog-only bytes\n");
      await git(workspace, "add", "."); await commit(workspace, "test: reflog-only fixture");
      const reflogOnly = await git(workspace, "rev-parse", "HEAD");
      await git(workspace, "reset", "--hard", base);
      await writeFile(join(workspace, "dangling.txt"), "unreachable object bytes\n");
      const dangling = await git(workspace, "hash-object", "-w", "dangling.txt");
      await rm(join(workspace, "dangling.txt"));
      await writeFile(join(workspace, "tracked.txt"), "staged bytes\n"); await git(workspace, "add", "tracked.txt");
      await writeFile(join(workspace, "tracked.txt"), "unstaged bytes\n");
      await writeFile(join(workspace, "ignored-unique.txt"), "TEST_UNIQUE_IGNORED_RECOVERY_BYTES\n");
      const executed = join(f.root, "untrusted-hook-executed");
      await mkdir(join(workspace, ".git", "hooks"), { recursive: true });
      await writeFile(join(workspace, ".git", "hooks", "pre-commit"), `#!/bin/sh\ntouch '${executed}'\n`);
      await chmod(join(workspace, ".git", "hooks", "pre-commit"), 0o700);
      await git(workspace, "config", "core.fsmonitor", `touch '${executed}'`);
      const manifest = await manifestFor(f);
      const captured = await captureEncryptedSourceHandoff({ ...f, handoffId: "TEST-full", manifest, key, binding, assertCurrent: () => undefined });
      const ciphertext = await readFile(join(f.destination.path, "TEST-full.source.aead"));
      expect(ciphertext.includes(Buffer.from("TEST_UNIQUE_IGNORED_RECOVERY_BYTES"))).toBe(false);
      // Original .git/common/object store/worktree and artifacts are unavailable.
      for (const root of Object.values(f.roots)) await rm(root.path, { recursive: true });
      const restored = await restoreEncryptedSourceHandoff({ ...f, ...captured, handoffId: "TEST-full", key, binding, assertCurrent: () => undefined });
      const restoredWorkspace = join(restored.restorePath, Root.Workspace);
      expect(await restoredGitRead(restoredWorkspace, "show", ":tracked.txt")).toBe("staged bytes");
      expect(await readFile(join(restoredWorkspace, "tracked.txt"), "utf8")).toBe("unstaged bytes\n");
      expect(await readFile(join(restoredWorkspace, "ignored-unique.txt"), "utf8")).toBe("TEST_UNIQUE_IGNORED_RECOVERY_BYTES\n");
      expect(await restoredGitRead(restoredWorkspace, "rev-parse", "refs/stash")).toBe(stash);
      expect(await restoredGitRead(restoredWorkspace, "show", "refs/stash:tracked.txt")).toBe("stash-only bytes");
      expect(await restoredGitRead(restoredWorkspace, "rev-parse", "refs/TEST/extra")).toBe(base);
      expect(await restoredGitRead(restoredWorkspace, "cat-file", "-t", reflogOnly)).toBe("commit");
      expect(await restoredGitRead(restoredWorkspace, "reflog", "show", "--all", "--format=%H")).toContain(reflogOnly);
      expect(await restoredGitRead(restoredWorkspace, "cat-file", "-p", dangling)).toBe("unreachable object bytes");
      expect(await readFile(join(restored.restorePath, "output", "result.json"), "utf8")).toBe('{"TEST":"complete"}\n');
      expect(await readFile(join(restored.restorePath, "evidence", "proof.txt"), "utf8")).toBe("TEST source evidence\n");
      const restoredRoots = { workspace: await sourceHandoffDirectory(restoredWorkspace),
        output: await sourceHandoffDirectory(join(restored.restorePath, "output")), evidence: await sourceHandoffDirectory(join(restored.restorePath, "evidence")) };
      const independent = await inventorySourceHandoff(restoredRoots, () => undefined);
      expect(independent).toEqual(manifest.entries);
      expect(await inspectSourceHandoffGit(restoredWorkspace, independent)).toBe(manifest.gitFactsSha256);
      expect(handoffFacetDigest(independent, Root.Output)).toBe(handoffFacetDigest(manifest.entries, Root.Output));
      expect(await readdir(f.root)).not.toContain("untrusted-hook-executed");
    } finally { await f.cleanup(); }
  });
  it("rejects altered ciphertext or wrong identity binding before any plaintext restore directory", async () => {
    const f = await fixture();
    try {
      const manifest = await manifestFor(f), captured = await captureEncryptedSourceHandoff({ ...f, manifest, handoffId: "TEST-tampered", key, binding, assertCurrent: () => undefined });
      await expect(restoreEncryptedSourceHandoff({ ...f, ...captured, handoffId: "TEST-tampered", key, binding: "different generation", assertCurrent: () => undefined }))
        .rejects.toThrow("source-handoff-authentication-failed");
      expect(await readdir(f.restoreParent.path)).toEqual([]);
      const path = join(f.destination.path, "TEST-tampered.source.aead"), bytes = await readFile(path);
      bytes[Math.floor(bytes.length / 2)]! ^= 1; await writeFile(path, bytes);
      await expect(restoreEncryptedSourceHandoff({ ...f, ...captured, handoffId: "TEST-tampered", key, binding, assertCurrent: () => undefined }))
        .rejects.toThrow();
      expect(await readdir(f.restoreParent.path)).toEqual([]);
    } finally { await f.cleanup(); }
  });
  it.each(["git-lock", "alternates", "missing-dependency", "missing-result", "LFS"])("protects unsupported %s source closure", async kind => {
    const f = await fixture();
    try {
      if (kind === "git-lock") await writeFile(join(f.roots.workspace.path, ".git", "index.lock"), "TEST lock");
      if (kind === "alternates") await writeFile(join(f.roots.workspace.path, ".git", "objects", "info", "alternates"), "/TEST/external-object-store");
      if (kind === "missing-result") await rm(join(f.roots.output.path, "result.json"));
      if (kind === "missing-dependency") await writeFile(join(f.roots.workspace.path, "package.json"), '{"dependencies":{"missing":"1.0.0"}}');
      if (kind === "LFS") { await writeFile(join(f.roots.workspace.path, ".gitattributes"), "tracked.txt filter=lfs\n"); await git(f.roots.workspace.path, "add", ".gitattributes"); }
      await expect(manifestFor(f)).rejects.toThrow("source-handoff-unsupported");
      expect(await readdir(f.destination.path)).toEqual([]);
    } finally { await f.cleanup(); }
  });
  it.each(["extra-ref", "reflog-only", "dangling-blob", "legacy-dangling-blob", "ignored-file"])("rejects LFS pointer with missing payload in %s despite absent current attributes", async kind => {
    const f = await fixture(), workspace = f.roots.workspace.path;
    try {
      const pointer = `version https://${kind === "legacy-dangling-blob" ? "hawser" : "git-lfs"}.github.com/spec/v1\noid sha256:${"b".repeat(64)}\nsize 4096\n`;
      const base = await git(workspace, "rev-parse", "HEAD");
      const path = join(workspace, kind === "ignored-file" ? "ignored-unique.txt" : "old-lfs.bin");
      await writeFile(path, pointer);
      if (["extra-ref", "reflog-only"].includes(kind)) {
        await git(workspace, "add", "old-lfs.bin"); await commit(workspace, "test: protected LFS pointer history");
        if (kind === "extra-ref") await git(workspace, "update-ref", "refs/TEST/lfs-history", await git(workspace, "rev-parse", "HEAD"));
        await git(workspace, "reset", "--hard", base);
      } else if (["dangling-blob", "legacy-dangling-blob"].includes(kind)) { await git(workspace, "hash-object", "-w", "old-lfs.bin"); await rm(path); }
      await expect(manifestFor(f)).rejects.toThrow("source-handoff-unsupported");
      expect(await readdir(f.destination.path)).toEqual([]);
    } finally { await f.cleanup(); }
  });
  it.each(["extra-ref", "reflog-only", "dangling-tree"])("rejects historical submodule gitlink in %s without current index/metadata", async kind => {
    const f = await fixture(), workspace = f.roots.workspace.path;
    try {
      const base = await git(workspace, "rev-parse", "HEAD");
      await git(workspace, "update-index", "--add", "--cacheinfo", `160000,${base},external-submodule`);
      if (kind === "dangling-tree") await git(workspace, "write-tree");
      else {
        await commit(workspace, "test: protected submodule history");
        if (kind === "extra-ref") await git(workspace, "update-ref", "refs/TEST/submodule-history", await git(workspace, "rev-parse", "HEAD"));
      }
      await git(workspace, "reset", "--hard", base);
      expect(await git(workspace, "ls-files", "--stage")).not.toContain("160000");
      await expect(manifestFor(f)).rejects.toThrow("source-handoff-unsupported");
      expect(await readdir(f.destination.path)).toEqual([]);
    } finally { await f.cleanup(); }
  });
  it.each([
    ["pubspec.yaml", "dependencies:\n  flutter:\n    sdk: flutter\n"],
    ["pom.xml", "<project><dependencies><dependency>external</dependency></dependencies></project>"],
    ["build.gradle.kts", "dependencies { implementation(\"TEST:external:1.0\") }"],
    ["Gemfile", "gem 'external'\n"],
    ["setup.py", "from setuptools import setup\nsetup(install_requires=['external'])\n"],
    ["setup.cfg", "[options]\ninstall_requires = external\n"],
    ["Pipfile", "[packages]\nexternal = '*'\n"],
  ])("rejects unsupported declared dependency ecosystem %s", async (name, bytes) => {
    const f = await fixture();
    try {
      await writeFile(join(f.roots.workspace.path, name), bytes);
      await expect(manifestFor(f)).rejects.toThrow("source-handoff-unsupported");
      expect(await readdir(f.destination.path)).toEqual([]);
    } finally { await f.cleanup(); }
  });
  it("publishes the validated immutable receipt identity when caller changes it during filesystem await", async () => {
    const f = await fixture();
    try {
      const store = new LocalSourceHandoffReceiptStore(f.destination);
      const receipt: SourceHandoffReceipt = { schemaVersion: 1, handoffId: "TEST-original", jobId: "TEST-job", generationId: "generation-1",
        receiptSha256: "a".repeat(64), settlementRevision: 1, keyId: "TEST-key", independentDestinationId: "TEST-destination", nativeFenceSha256: "b".repeat(64),
        sourcePhysicalSha256: "c".repeat(64), destinationPhysicalSha256: "d".repeat(64), envelopeSha256: "e".repeat(64), envelopeBytes: 100,
        sourceManifestSha256: "f".repeat(64), outputManifestSha256: "1".repeat(64), evidenceManifestSha256: "2".repeat(64) };
      const expected = { ...receipt }, publishing = store.publish(receipt);
      Object.assign(receipt, { handoffId: "TEST-mutated", keyId: "TEST-unadmitted-key" });
      await publishing;
      expect(await store.read("TEST-original")).toEqual(expected);
      expect(await store.read("TEST-mutated")).toBeUndefined();
      expect(await readdir(f.destination.path)).toEqual(["TEST-original.receipt"]);
    } finally { await f.cleanup(); }
  });
  it("does not capture or restore on missing/unknown native quiescence authority", async () => {
    const current: JobStorageSettlement = { jobId: "NEW-TEST-source", generationId: "generation-1", receiptSha256: "a".repeat(64),
      revision: 1, status: JobStorageSettlementStatus.Resumable, intent: { kind: JobStorageIntentKind.NoResume,
        homeStateRequirement: JobStorageHomeStateRequirement.NoneRequired } };
    let keyReads = 0, publications = 0;
    const dependencies = { keyId: "TEST-key", keys: { async withKey<T>(): Promise<T> { keyReads++; throw new Error("unexpected_key_read"); } },
      receipts: { read: async () => undefined, publish: async () => { publications++; } } };
    expect(await new LocalSourceHandoff(dependencies).capture(current, "TEST-no-native")).toEqual({ status: Status.Unsupported });
    const unknown = new LocalSourceHandoff({ ...dependencies, native: {
      withQuiescedCapture: async () => ({ status: Status.Unknown }), withOfflineReadback: async () => ({ status: Status.Unknown }) } });
    expect(await unknown.capture(current, "TEST-unknown-native")).toEqual({ status: Status.Unknown });
    expect(await unknown.verify(current, "TEST-unknown-native")).toEqual({ status: Status.Unknown });
    expect(keyReads).toBe(0); expect(publications).toBe(0);
  });
});
