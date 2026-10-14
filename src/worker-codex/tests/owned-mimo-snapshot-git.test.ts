import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaultSafeExecutionErrorClassifier } from "../../worker-core/safe-execution/domain/safe-execution-policy";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OwnedMimoSnapshotGitRunner, MimoSnapshotGitFailure, ownedMimoWorkspaceSnapshotter, ownedMimoWorkspaceAccess } from "../owned-mimo-snapshot-git";

const boundary = vi.hoisted(() => ({ failure: undefined as unknown, options: undefined as Record<string, unknown> | undefined }));
vi.mock("node:child_process", async original => {
  const actual = await original<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  const real = promisify(actual.execFile);
  const wrapper = (...args: unknown[]) => Reflect.apply(actual.execFile, actual, args);
  Object.defineProperty(wrapper, promisify.custom, { value: (...args: Parameters<typeof real>) => {
    if (boundary.failure !== undefined) { boundary.options = args[2] as Record<string, unknown>; return Promise.reject(boundary.failure); }
    return Reflect.apply(real, undefined, args);
  } });
  return { ...actual, execFile: wrapper };
});
const git = promisify(execFile);
let root: string, workspace: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "TEST-mimo-snapshot-git-")));
  workspace = join(root, "workspaces", "TEST-owned");
  boundary.failure = undefined; boundary.options = undefined;
});
afterEach(async () => { boundary.failure = undefined; vi.unstubAllEnvs(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
async function command(cwd: string, args: string[]) {
  return git("/usr/bin/git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args], {
    cwd, env: { PATH: "/usr/bin:/bin", HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  });
}
async function repository(path: string) {
  await mkdir(path, { recursive: true }); await command(path, ["init", "--quiet"]);
  await writeFile(join(path, "owned.txt"), "TEST initial\n"); await command(path, ["add", "owned.txt"]);
  const identity = ["-c", "user.name=iliya", "-c", "user.email=iliyazelenkog@gmail.com"];
  for (const name of ["GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"]) {
    if (!(await command(path, [...identity, "var", name])).stdout.startsWith("iliya <iliyazelenkog@gmail.com> ")) throw Error("TEST owner identity invalid");
  }
  await command(path, [...identity, "commit", "--quiet", "-m", "test: fixture"]);
}
async function linked() {
  const source = join(root, "source"); await repository(source); await mkdir(join(root, "workspaces"));
  await command(source, ["worktree", "add", "--quiet", "--detach", workspace, "HEAD"]);
  const own = (await command(workspace, ["rev-parse", "--absolute-git-dir"])).stdout.trim();
  return { source, own };
}
it("captures the actual linked TEST worktree read-only despite ambient Git redirection and hooks", async () => {
  const { source, own } = await linked(), foreign = join(root, "foreign"), marker = join(root, "TEST-hook-ran"), hook = join(root, "TEST-fsmonitor");
  await repository(foreign); await writeFile(join(foreign, "foreign-only.txt"), "TEST foreign\n");
  await writeFile(hook, `#!/bin/sh\nprintf unsafe > '${marker.replaceAll("'", "'\\''")}'\n`); await chmod(hook, 0o700);
  await command(source, ["config", "core.fsmonitor", hook]);
  await writeFile(join(workspace, "owned.txt"), "TEST owned change\n");
  const before = await Promise.all(["HEAD", "index", "commondir", "gitdir"].map(async n => ({ n, bytes: await readFile(join(own, n)), info: await stat(join(own, n)) })));
  vi.stubEnv("GIT_DIR", join(foreign, ".git")); vi.stubEnv("GIT_WORK_TREE", foreign); vi.stubEnv("GIT_INDEX_FILE", join(foreign, ".git/index"));
  vi.stubEnv("GIT_CONFIG_COUNT", "1"); vi.stubEnv("GIT_CONFIG_KEY_0", "core.fsmonitor"); vi.stubEnv("GIT_CONFIG_VALUE_0", hook);
  vi.stubEnv("TEST_SECRET_PAYLOAD", "TEST-never-child-env");
  const guard = vi.fn(), runner = new OwnedMimoSnapshotGitRunner(workspace, guard);
  const snapshotter = ownedMimoWorkspaceSnapshotter(runner);
  expect(await snapshotter.capture({ workspacePath: workspace, includeDiff: true })).toMatchObject({ mode: "git", dirty: true, changedFiles: ["owned.txt"] });
  await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  for (const old of before) {
    expect(await readFile(join(own, old.n))).toEqual(old.bytes);
    const info = await stat(join(own, old.n)); expect([info.ino, info.ctimeMs, info.mtimeMs]).toEqual([old.info.ino, old.info.ctimeMs, old.info.mtimeMs]);
  }
  expect(guard.mock.calls.length).toBeGreaterThan(1);
  await expect(runner.run({ command: "/usr/bin/git", args: ["status", "--porcelain", "--untracked-files=all"], cwd: foreign })).rejects.toThrow("owned_mimo_snapshot_git_invalid");
  await expect(runner.run({ command: "/usr/bin/git", args: ["read-tree", "HEAD"], cwd: workspace })).rejects.toThrow("owned_mimo_snapshot_git_invalid");
});
it("redacts a real child Git failure to finite facts without stderr, paths or a raw cause", async () => {
  await mkdir(workspace, { recursive: true }); await writeFile(join(workspace, ".git"), `gitdir: ${root}/TEST-SECRET-PATH\n`);
  const runner = new OwnedMimoSnapshotGitRunner(workspace, () => {});
  const error = await runner.run({ command: "/usr/bin/git", args: ["status", "--porcelain", "--untracked-files=all"], cwd: workspace }).catch(e => e);
  expect(error).toBeInstanceOf(MimoSnapshotGitFailure);
  expect(defaultSafeExecutionErrorClassifier(error).reason).toBe("unknown_error");
  expect(error.facts).toMatchObject({ exitCode: 128, budgetMs: 30000, timedOut: false, stderrCategory: "not_repository" });
  expect(error.message).not.toContain(root); expect(JSON.stringify(error)).not.toContain("TEST-SECRET");
  expect(error).not.toHaveProperty("stderr"); expect(error).not.toHaveProperty("stdout"); expect(error).not.toHaveProperty("cause");
  const fresh = new OwnedMimoSnapshotGitRunner(workspace, () => {}), snapshotter = ownedMimoWorkspaceSnapshotter(fresh);
  await expect(snapshotter.capture({ workspacePath: workspace })).rejects.toBeInstanceOf(MimoSnapshotGitFailure);
  await expect(snapshotter.capture({ workspacePath: workspace })).rejects.toBeInstanceOf(MimoSnapshotGitFailure);
});
it("preserves actual subprocess abort and rejects success after ownership is revoked", async () => {
  await linked(); const controller = new AbortController(); controller.abort();
  const runner = new OwnedMimoSnapshotGitRunner(workspace, () => {});
  const error = await runner.run({ command: "/usr/bin/git", args: ["rev-parse", "--verify", "HEAD"], cwd: workspace, abortSignal: controller.signal }).catch(e => e);
  expect(error).toMatchObject({ name: "AbortError", code: "ABORT_ERR", facts: { aborted: true, timedOut: false, budgetMs: 30000 } });
  expect(defaultSafeExecutionErrorClassifier(error).reason).toBe("user_abort");
  await expect(ownedMimoWorkspaceSnapshotter(new OwnedMimoSnapshotGitRunner(workspace, () => {}))
    .capture({ workspacePath: workspace, abortSignal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  await expect(ownedMimoWorkspaceAccess(new OwnedMimoSnapshotGitRunner(workspace, () => {}))
    .assertGitWorkspace({ workspacePath: workspace, abortSignal: controller.signal })).rejects.toMatchObject({ name: "AbortError", code: "ABORT_ERR" });
  let checks = 0;
  const revoked = new OwnedMimoSnapshotGitRunner(workspace, () => { if (++checks === 2) throw Error("TEST owner revoked"); });
  await expect(revoked.run({ command: "/usr/bin/git", args: ["rev-parse", "--verify", "HEAD"], cwd: workspace })).rejects.toThrow("TEST owner revoked");
});
it("uses a finite 30s child budget, classifies timeout and never inherits ambient secret/config fields", async () => {
  vi.stubEnv("TEST_SECRET_PAYLOAD", "TEST-never-child-env"); vi.stubEnv("GIT_CONFIG_COUNT", "99");
  boundary.failure = Object.assign(Error("TEST raw secret"), { code: null, killed: true, signal: "SIGTERM", stderr: "fatal: Permission denied TEST-secret\n", stdout: "TEST-secret" });
  vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(31000);
  const runner = new OwnedMimoSnapshotGitRunner(workspace, () => {});
  const error = await runner.run({ command: "/usr/bin/git", args: ["status", "--porcelain", "--untracked-files=all"], cwd: workspace }).catch(e => e);
  expect(defaultSafeExecutionErrorClassifier(error).reason).toBe("task_timeout");
  expect(error.facts).toEqual({ exitCode: null, signal: "SIGTERM", killed: true, aborted: false, timedOut: true, elapsedMs: 31000, budgetMs: 30000, stderrCategory: "permission" });
  expect(JSON.stringify(error)).not.toContain("TEST-secret"); expect(error.message).not.toContain("TEST raw");
  expect(boundary.options?.timeout).toBe(30000);
  const childEnv = boundary.options?.env as Record<string, unknown>;
  expect([childEnv.GIT_CONFIG_COUNT, childEnv.GIT_CONFIG_NOSYSTEM, childEnv.GIT_NO_LAZY_FETCH, childEnv.GIT_OPTIONAL_LOCKS]).toEqual(["0", "1", "1", "0"]);
  expect(Object.hasOwn(childEnv, "TEST_SECRET_PAYLOAD")).toBe(false); expect(Object.hasOwn(childEnv, "GIT_DIR")).toBe(false);
});
