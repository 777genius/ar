import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  DependencyBootstrapRecoveryReason as Reason,
  DependencyBootstrapWorkspaceRecoveryError as RecoveryError,
  withDependencyBootstrapWorkspaceTransaction as transaction,
} from "../dependency-bootstrap-workspace-transaction";

const execFileAsync = promisify(execFile);
type Manifest = {
  version: number;
  retention: string;
  operationId: string;
  workspace: { canonicalPath: string };
  index: { path: string; existed: boolean; digest: string; backupPath: string };
  entries: Array<{ path: string; kind: string; mode: number; digest?: string; linkTarget?: string; backupPath?: string }>;
};

// All filesystem and Git actions use fresh synthetic TEST directories. The
// per-test TMPDIR isolates recovery artifacts without a production test hook.
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dependency-recovery-TEST-")));
  const workspace = join(root, "workspace");
  const recoveryTemp = join(root, "legacy-temp");
  await mkdir(recoveryTemp);
  await mkdir(join(workspace, "src"), { recursive: true });
  await writeFile(join(workspace, "src", "file.txt"), "staged independently\n");
  await writeFile(join(workspace, ".gitignore"), "node_modules/\n");
  await git(workspace, ["init", "--quiet"]);
  await git(workspace, ["add", "src/file.txt", ".gitignore"]);
  const dirty = Buffer.from("original dirty bytes \x00 independently\n");
  const untracked = Buffer.from("original operator notes independently\n");
  await writeFile(join(workspace, "src", "file.txt"), dirty);
  await chmod(join(workspace, "src", "file.txt"), 0o640);
  await writeFile(join(workspace, "notes.txt"), untracked);
  await chmod(join(workspace, "notes.txt"), 0o644);
  const index = await readFile(join(workspace, ".git", "index"));
  const previousTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = recoveryTemp;
  return {
    root, workspace, recoveryTemp, dirty, untracked, index,
    async cleanup() {
      if (previousTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmpdir;
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function git(cwd: string, args: readonly string[]) {
  return execFileAsync("git", [...args], { cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
}

async function capturedRecovery(action: () => Promise<unknown>): Promise<RecoveryError> {
  try { await action(); } catch (error) {
    expect(error).toBeInstanceOf(RecoveryError);
    return error as RecoveryError;
  }
  throw new Error("expected retained recovery");
}

async function preserved(error: RecoveryError, sample: Awaited<ReturnType<typeof fixture>>) {
  const recoveryRoot = dirname(error.recovery.manifestPath);
  const manifest = JSON.parse(await readFile(error.recovery.manifestPath, "utf8")) as Manifest;
  expect(manifest).toMatchObject({ version: 1, retention: "legacy_best_effort", operationId: error.recovery.operationId, workspace: { canonicalPath: sample.workspace } });
  expect(dirname(recoveryRoot)).toBe(sample.recoveryTemp);
  expect((await lstat(recoveryRoot)).mode & 0o777).toBe(0o700);
  for (const [path, original, mode] of [["src/file.txt", sample.dirty, 0o640], ["notes.txt", sample.untracked, 0o644]] as const) {
    const entry = manifest.entries.find((candidate) => candidate.path === path);
    expect(entry).toMatchObject({ kind: "file", mode, digest: createHash("sha256").update(original).digest("hex") });
    expect(entry?.backupPath).toBeDefined();
    expect(await readFile(join(recoveryRoot, entry!.backupPath!))).toEqual(original);
  }
  expect(manifest.index).toMatchObject({ path: join(sample.workspace, ".git", "index"), existed: true, digest: createHash("sha256").update(sample.index).digest("hex") });
  expect(await readFile(join(recoveryRoot, manifest.index.backupPath))).toEqual(sample.index);
  return manifest;
}

describe("legacy dependency workspace recovery", () => {
  it.skipIf(process.platform !== "linux")("refuses non-UTF8 filenames before action and cleans its partial backup", async () => {
    const sample = await fixture();
    let actionRan = false;
    try {
      const rawPath = Buffer.concat([Buffer.from(`${sample.workspace}/invalid-`), Buffer.from([0xff])]);
      await writeFile(rawPath, "invalid-name sentinel");
      await expect(transaction({ workspacePath: sample.workspace, action: async () => { actionRan = true; } })).rejects.toThrow("filename_encoding_unsupported");
      expect(actionRan).toBe(false);
      expect(await readFile(rawPath, "utf8")).toBe("invalid-name sentinel");
      expect(await readdir(sample.recoveryTemp)).toEqual([]);
    } finally { await sample.cleanup(); }
  });

  it("runs ordinary unchanged success and removes its legacy backup", async () => {
    const sample = await fixture();
    try {
      expect(await transaction({ workspacePath: sample.workspace, action: async () => 42 })).toBe(42);
      expect(await readdir(sample.recoveryTemp)).toEqual([]);
      expect(await readFile(join(sample.workspace, "src", "file.txt"))).toEqual(sample.dirty);
      expect(await readFile(join(sample.workspace, ".git", "index"))).toEqual(sample.index);
    } finally { await sample.cleanup(); }
  });

  // Red regression: restoring the full shared index erases another package's
  // staging even though both status and tracked entries are scoped to package a.
  it.each([false, true])("holds nested recovery without source/index writes on outside staging (source changed=%s)", async (changeSource) => {
    const sample = await fixture();
    const packageA = join(sample.workspace, "packages", "a");
    const packageB = join(sample.workspace, "packages", "b");
    const sourceA = join(packageA, "file.txt");
    const sourceB = join(packageB, "file.txt");
    try {
      await mkdir(packageA, { recursive: true });
      await mkdir(packageB, { recursive: true });
      await writeFile(sourceA, "package a staged baseline");
      await writeFile(sourceB, "package b staged baseline");
      await git(sample.workspace, ["add", "packages"]);
      const baselineIndex = await readFile(join(sample.workspace, ".git", "index"));
      const originalA = Buffer.from("package a independent dirty original");
      await writeFile(sourceA, originalA);
      let indexAfterAction: Buffer | undefined;
      const error = await capturedRecovery(() => transaction({ workspacePath: packageA, action: async () => {
        if (changeSource) await writeFile(sourceA, "package a changed during action");
        await writeFile(sourceB, "package b independently staged during action");
        await git(sample.workspace, ["add", "packages/b/file.txt"]);
        indexAfterAction = await readFile(join(sample.workspace, ".git", "index"));
      } }));
      expect(error.reason).toBe(Reason.ScopedIndexChanged);
      expect(await readFile(sourceA)).toEqual(changeSource ? Buffer.from("package a changed during action") : originalA);
      expect(await readFile(join(sample.workspace, ".git", "index"))).toEqual(indexAfterAction);
      expect((await git(sample.workspace, ["show", ":packages/b/file.txt"])).stdout).toBe("package b independently staged during action");
      expect((await git(sample.workspace, ["show", ":packages/a/file.txt"])).stdout).toBe("package a staged baseline");
      const manifest = JSON.parse(await readFile(error.recovery.manifestPath, "utf8")) as Manifest;
      expect(manifest.workspace.canonicalPath).toBe(packageA);
      const originalEntry = manifest.entries.find((entry) => entry.path === "packages/a/file.txt");
      expect(originalEntry?.digest).toBe(createHash("sha256").update(originalA).digest("hex"));
      expect(await readFile(join(dirname(error.recovery.manifestPath), originalEntry!.backupPath!))).toEqual(originalA);
      expect(await readFile(join(dirname(error.recovery.manifestPath), manifest.index.backupPath))).toEqual(baselineIndex);
    } finally { await sample.cleanup(); }
  });

  // Red regression: unconditional finally deletes originals despite action failure.
  it("retains originals after an unchanged action fails without exposing its output", async () => {
    const sample = await fixture();
    try {
      const error = await capturedRecovery(() => transaction({ workspacePath: sample.workspace, action: async () => { throw new Error("secret provider output must not escape"); } }));
      expect(error.reason).toBe(Reason.ActionFailed);
      expect(error.message).not.toContain("secret provider output");
      await preserved(error, sample);
    } finally { await sample.cleanup(); }
  });

  it.skipIf(process.platform !== "linux")("best-effort restores bytes, modes, symlink text and exact index but retains originals on failure", async () => {
    const sample = await fixture();
    try {
      await symlink("src/file.txt", join(sample.workspace, "original-link"));
      const error = await capturedRecovery(() => transaction({ workspacePath: sample.workspace, action: async () => {
        await writeFile(join(sample.workspace, "src", "file.txt"), "installer mutation");
        await chmod(join(sample.workspace, "src", "file.txt"), 0o600);
        await writeFile(join(sample.workspace, "notes.txt"), "changed notes");
        await writeFile(join(sample.workspace, "extra.txt"), "extra");
        await git(sample.workspace, ["add", "src/file.txt"]);
        throw new Error("installer failure");
      } }));
      expect(error.reason).toBe(Reason.ActionFailed);
      expect(await readFile(join(sample.workspace, "src", "file.txt"))).toEqual(sample.dirty);
      expect((await lstat(join(sample.workspace, "src", "file.txt"))).mode & 0o777).toBe(0o640);
      expect(await readFile(join(sample.workspace, "notes.txt"))).toEqual(sample.untracked);
      expect(await readlink(join(sample.workspace, "original-link"))).toBe("src/file.txt");
      expect(await readFile(join(sample.workspace, ".git", "index"))).toEqual(sample.index);
      await expect(access(join(sample.workspace, "extra.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      const manifest = await preserved(error, sample);
      expect(manifest.entries.find((entry) => entry.path === "original-link")).toMatchObject({ kind: "symlink", linkTarget: "src/file.txt" });
    } finally { await sample.cleanup(); }
  });

  it.skipIf(process.platform !== "linux")("retains original copies after real filesystem rollback verification fails", async () => {
    const sample = await fixture();
    try {
      const error = await capturedRecovery(() => transaction({ workspacePath: sample.workspace, action: async () => {
        await writeFile(join(sample.workspace, ".gitignore"), "node_modules/\ninstaller-output.tmp\n");
        await writeFile(join(sample.workspace, "installer-output.tmp"), "unknown installer data survives");
        await writeFile(join(sample.workspace, "src", "file.txt"), "changed dirty source");
        await writeFile(join(sample.workspace, "notes.txt"), "changed operator notes");
        throw new Error("installer failure");
      } }));
      expect(error.reason).toBe(Reason.RestoreFailed);
      // Restoration happened; restoring ignore rules reveals an extra file that
      // was not observed before writes, so verification must fail and preserve.
      expect(await readFile(join(sample.workspace, "src", "file.txt"))).toEqual(sample.dirty);
      expect(await readFile(join(sample.workspace, "notes.txt"))).toEqual(sample.untracked);
      expect(await readFile(join(sample.workspace, "installer-output.tmp"), "utf8")).toBe("unknown installer data survives");
      await preserved(error, sample);
    } finally { await sample.cleanup(); }
  });

  it.skipIf(process.platform !== "linux")("retains recovery after a changed-success action restores source", async () => {
    const sample = await fixture();
    try {
      const error = await capturedRecovery(() => transaction({ workspacePath: sample.workspace, action: async () => { await writeFile(join(sample.workspace, "notes.txt"), "changed notes"); } }));
      expect(error.reason).toBe(Reason.MutationDetected);
      expect(await readFile(join(sample.workspace, "notes.txt"))).toEqual(sample.untracked);
      await preserved(error, sample);
    } finally { await sample.cleanup(); }
  });

  // Red regression: recursive rollback follows a substituted source namespace.
  it.each(["ancestor", "leaf", "index"] as const)("preserves an external sentinel on %s symlink drift", async (target) => {
    const sample = await fixture();
    const external = join(sample.root, "external");
    const sentinel = join(external, target === "index" ? "index" : "file.txt");
    try {
      await mkdir(external);
      const original = target === "index" ? sample.index : Buffer.from("external independent sentinel");
      await writeFile(sentinel, original);
      await chmod(sentinel, 0o600);
      const error = await capturedRecovery(() => transaction({ workspacePath: sample.workspace, action: async () => {
        if (target === "ancestor") {
          await rename(join(sample.workspace, "src"), join(sample.workspace, "original-src"));
          await symlink(external, join(sample.workspace, "src"));
        } else {
          const path = target === "index" ? join(sample.workspace, ".git", "index") : join(sample.workspace, "src", "file.txt");
          await rm(path);
          await symlink(sentinel, path);
        }
      } }));
      expect(error.reason).toBe(target === "ancestor" ? Reason.AncestorChanged : target === "leaf" && process.platform === "linux" ? Reason.LeafChanged : target === "leaf" ? Reason.Unsupported : Reason.InspectionFailed);
      expect(await readFile(sentinel)).toEqual(original);
      expect((await lstat(sentinel)).mode & 0o777).toBe(0o600);
      await preserved(error, sample);
    } finally { await sample.cleanup(); }
  });

  it.each(["workspace", "index-parent"] as const)("retains originals on %s identity drift before source writes", async (target) => {
    const sample = await fixture();
    try {
      const error = await capturedRecovery(() => transaction({ workspacePath: sample.workspace, action: async () => {
        const originalPath = target === "workspace" ? sample.workspace : join(sample.workspace, ".git");
        await rename(originalPath, join(sample.root, `original-${target}`));
        await mkdir(originalPath);
        await writeFile(join(originalPath, "sentinel.txt"), "replacement namespace sentinel");
      } }));
      expect(error.reason).toBe(Reason.AncestorChanged);
      const path = target === "workspace" ? sample.workspace : join(sample.workspace, ".git");
      expect(await readFile(join(path, "sentinel.txt"), "utf8")).toBe("replacement namespace sentinel");
      await preserved(error, sample);
    } finally { await sample.cleanup(); }
  });
});
