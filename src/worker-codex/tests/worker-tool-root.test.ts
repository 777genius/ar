import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectControlBroker } from "@vioxen/subscription-runtime/worker-core";
import {
  prepareWorkerToolRoot, workerToolRootPath, WorkerToolRootStatus,
  WorkerToolRootSkipReason, type WorkerToolRootInput,
} from "../worker-tool-root";
import { captureGitWorkspacePatch } from "../codex-goal-runtime-result-io";
import { createOrReuseProjectWorktree, rollbackProjectRefillPartial } from "../application/project-control/codex-goal-project-refill";
import {
  defaultProjectControlGitPort, type ProjectControlGitPort,
  type ProjectControlGitRunInput,
} from "../application/project-control/adapters/host-command-adapters";

const exec = promisify(execFile);
const identity = { name: "iliya", email: "iliyazelenkog@gmail.com" };
const roots: string[] = [];
beforeEach(() => {
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function git(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return (await exec("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], { env })).stdout.trim();
}
async function fixture(): Promise<WorkerToolRootInput & { root: string; localBase: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "worker-tool-root-test-")));
  roots.push(root);
  const sourceRepositoryPath = join(root, "source");
  const workspacePath = join(root, "workspace");
  await git(["init", "--quiet", "--initial-branch=main", sourceRepositoryPath]);
  for (const [key, value] of [["user.name", identity.name], ["user.email", identity.email]]) {
    await git(["-C", sourceRepositoryPath, "config", key!, value!]);
  }
  await writeFile(join(sourceRepositoryPath, "tracked.txt"), "local base\n");
  await git(["-C", sourceRepositoryPath, "add", "."]);
  await git(["-C", sourceRepositoryPath, "commit", "--quiet", "-m", "test: local base"]);
  const localBase = await git(["-C", sourceRepositoryPath, "rev-parse", "HEAD"]);
  await writeFile(join(sourceRepositoryPath, "tracked.txt"), "remote base\n");
  await git(["-C", sourceRepositoryPath, "commit", "--quiet", "-am", "test: remote base"]);
  const base = await git(["-C", sourceRepositoryPath, "rev-parse", "HEAD"]);
  await git(["-C", sourceRepositoryPath, "update-ref", "refs/remotes/origin/main", base]);
  await git(["-C", sourceRepositoryPath, "reset", "--hard", localBase]);
  await git(["-C", sourceRepositoryPath, "worktree", "add", "--quiet", "--detach", workspacePath, "origin/main"]);
  await git(["-C", sourceRepositoryPath, "remote", "add", "origin", "https://example.com/canonical.git"]);
  return { root, sourceRepositoryPath, workspacePath, localBase, base, jobId: "test-worker", commitAllowed: true };
}
const prepared = { status: WorkerToolRootStatus.Prepared };

describe("worker tool root isolation", () => {
  it("binding: fetches an unadvertised base reachable only from detached worktree HEAD", async () => {
    const f = await fixture();
    await git(["-C", f.workspacePath, "commit", "--quiet", "--allow-empty", "-m", "test: detached base"]);
    const detachedBase = await git(["-C", f.workspacePath, "rev-parse", "HEAD"]);
    await expect(git(["-C", f.workspacePath, "symbolic-ref", "--quiet", "HEAD"])).rejects.toThrow();
    expect(await git(["-C", f.sourceRepositoryPath, "for-each-ref", "--contains", detachedBase, "--format=%(refname)"])).toBe("");
    expect(await prepareWorkerToolRoot({ ...f, base: detachedBase })).toEqual(prepared);
    const gitDir = `--git-dir=${join(workerToolRootPath(f.workspacePath), "git")}`;
    expect(await git([gitDir, "rev-parse", "HEAD"])).toBe(detachedBase);
    expect(await git([gitDir, "rev-parse", "origin/main"])).toBe(f.base);
  });
  it("pins remote base and isolates worker commits and filters from trusted Git", async () => {
    const f = await fixture();
    expect(f.base).not.toBe(f.localBase);
    expect(await prepareWorkerToolRoot(f)).toEqual(prepared);
    const toolRoot = workerToolRootPath(f.workspacePath);
    const workerEnv = { ...process.env, GIT_DIR: join(toolRoot, "git"), GIT_WORK_TREE: f.workspacePath };
    expect(await git(["rev-parse", "HEAD"], workerEnv)).toBe(f.base);
    expect(await git(["rev-parse", "origin/main"], workerEnv)).toBe(f.base);
    expect(await git(["config", "remote.origin.fetch"], workerEnv)).toBe("+refs/heads/*:refs/remotes/origin/*");
    expect(await git(["config", "remote.origin.url"], workerEnv)).toBe("https://example.com/canonical.git");
    expect(await git(["config", "user.name"], workerEnv)).toBe(identity.name);
    expect(await git(["config", "user.email"], workerEnv)).toBe(identity.email);
    expect(JSON.parse(await readFile(join(toolRoot, "owner.json"), "utf8"))).toEqual({ jobId: f.jobId });
    expect((await lstat(join(toolRoot, "owner.json"))).mode & 0o777).toBe(0o600);
    for (const path of [toolRoot, join(toolRoot, "home"), join(toolRoot, "tmp"), join(toolRoot, "git")]) {
      expect((await lstat(path)).mode & 0o777).toBe(0o700);
    }
    await writeFile(join(f.workspacePath, "tracked.txt"), "worker committed change\n");
    await git(["add", "tracked.txt"], workerEnv);
    await git(["commit", "--quiet", "-m", "test: worker commit"], workerEnv);
    expect(await git(["rev-parse", "HEAD"], workerEnv)).not.toBe(f.base);
    expect(await git(["-C", f.workspacePath, "rev-parse", "HEAD"])).toBe(f.base);

    const sentinel = join(f.root, "filter-executed");
    await git(["config", "filter.x.clean", `touch '${sentinel}'; cat`], workerEnv);
    await git(["config", "filter.x.smudge", "cat"], workerEnv);
    await writeFile(join(f.workspacePath, ".gitattributes"), "* filter=x\n");
    await utimes(join(f.workspacePath, "tracked.txt"), new Date(1), new Date(1));
    expect(await captureGitWorkspacePatch({ workspacePath: f.workspacePath })).toContain("+worker committed change");
    expect(await git(["-C", f.workspacePath, "status", "--porcelain"])).toContain("tracked.txt");
    await expect(lstat(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
    // Control proves the planted filter is executable when the worker config is selected.
    await git(["status", "--porcelain"], workerEnv);
    expect((await lstat(sentinel)).isFile()).toBe(true);
  });

  it.each(["https://user:password@example.com/repo.git", "ssh://example.com/repo.git", "/missing/local/repo"])(
    "omits unusable one-hop remote %s", async remote => {
      const f = await fixture();
      const canonical = join(f.root, "canonical");
      await git(["init", "--quiet", canonical]);
      await git(["-C", canonical, "remote", "add", "origin", remote]);
      await git(["-C", f.sourceRepositoryPath, "remote", "set-url", "origin", canonical]);
      expect(await prepareWorkerToolRoot(f)).toEqual(prepared);
      expect(await git([`--git-dir=${join(workerToolRootPath(f.workspacePath), "git")}`, "remote"])).toBe("");
    },
  );

  it("resolves one local file URL hop and prefers controller identity", async () => {
    const f = await fixture();
    const canonical = join(f.root, "canonical");
    await git(["init", "--quiet", canonical]);
    await git(["-C", canonical, "remote", "add", "origin", "https://example.com/upstream.git"]);
    await git(["-C", f.sourceRepositoryPath, "remote", "set-url", "origin", `file://${canonical}`]);
    expect(await prepareWorkerToolRoot({ ...f, commitIdentity: { name: "Controller", email: "controller@example.com" } })).toEqual(prepared);
    const gitDir = `--git-dir=${join(workerToolRootPath(f.workspacePath), "git")}`;
    expect(await git([gitDir, "config", "remote.origin.url"])).toBe("https://example.com/upstream.git");
    expect(await git([gitDir, "config", "user.name"])).toBe("Controller");
  });

  it("leaves an existing root untouched and skips gitlinks before creating a root", async () => {
    const f = await fixture();
    const root = workerToolRootPath(f.workspacePath);
    await mkdir(root);
    await writeFile(join(root, "keep"), "existing");
    expect(await prepareWorkerToolRoot(f)).toMatchObject({ reason: WorkerToolRootSkipReason.ToolRootExists });
    expect(await readFile(join(root, "keep"), "utf8")).toBe("existing");
    await rm(root, { recursive: true });
    await git(["-C", f.workspacePath, "update-index", "--add", "--cacheinfo", `160000,${f.base},submodule`]);
    expect(await prepareWorkerToolRoot(f)).toMatchObject({ reason: WorkerToolRootSkipReason.Gitlinks });
    await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates read-only home/tmp ownership without invoking Git", async () => {
    const f = await fixture();
    const run = vi.fn().mockRejectedValue(new Error("must not run"));
    const port = { run, runBuffered: run } as ProjectControlGitPort;
    expect(await prepareWorkerToolRoot({ ...f, commitAllowed: false }, port)).toEqual(prepared);
    expect(run).not.toHaveBeenCalled();
    await expect(lstat(join(workerToolRootPath(f.workspacePath), "git"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses bounded scan/fetch limits and removes only its new root after failure", async () => {
    const f = await fixture();
    const calls: ProjectControlGitRunInput[] = [];
    const port: ProjectControlGitPort = {
      ...defaultProjectControlGitPort,
      runBuffered: input => defaultProjectControlGitPort.runBuffered(input),
      run: async input => {
        calls.push(input);
        if (input.args.includes("fetch")) throw new Error("fetch timed out");
        return defaultProjectControlGitPort.run(input);
      },
    };
    expect(await prepareWorkerToolRoot(f, port)).toMatchObject({ reason: WorkerToolRootSkipReason.PrepareFailed, detail: "fetch timed out" });
    expect(calls.find(call => call.args.includes("ls-files"))).toMatchObject({ timeoutMs: 120_000, maxBuffer: 64 * 1024 * 1024 });
    expect(calls.find(call => call.args.includes("fetch"))).toMatchObject({ timeoutMs: 300_000, maxBuffer: 1024 * 1024 });
    expect(calls.every(call => call.args.includes("core.hooksPath=/dev/null") && call.args.includes("core.fsmonitor=false"))).toBe(true);
    await expect(lstat(workerToolRootPath(f.workspacePath))).rejects.toMatchObject({ code: "ENOENT" });
    port.run = async input => {
      if (input.args.includes("cat-file")) throw new Error("missing");
      return defaultProjectControlGitPort.run(input);
    };
    expect(await prepareWorkerToolRoot(f, port)).toMatchObject({ detail: "worker_tool_root_base_missing" });
    await expect(lstat(workerToolRootPath(f.workspacePath))).rejects.toMatchObject({ code: "ENOENT" });
    port.run = async () => { throw new Error("x".repeat(400)); };
    expect((await prepareWorkerToolRoot(f, port)).detail).toHaveLength(300);
  });
});

// Direct boundary tests explain lifecycle behavior; public refill caller binding is tested separately.
describe("explanatory: direct refill tool root lifecycle", () => {
  it("prepares only newly created validated worktrees and reports reuse", async () => {
    const f = await fixture();
    const broker = { createWorktree: async () => ({ status: "applied", resourceId: f.workspacePath }) } as unknown as ProjectControlBroker;
    const input = {
      broker,
      scope: { projectId: "test", workspaceRoots: [f.sourceRepositoryPath], worktreeRoots: [f.root] },
      createWorktreeInput: { sourceWorkspacePath: f.sourceRepositoryPath, expectedSourceRealPath: f.sourceRepositoryPath, path: f.workspacePath, expectedRevision: f.base, baseBranch: "origin/main" },
      workerToolRoot: { jobId: f.jobId, commitAllowed: true },
    };
    expect((await createOrReuseProjectWorktree(input)).workerToolRoot).toEqual(prepared);
    expect((await createOrReuseProjectWorktree({ ...input, createWorktreeInput: { ...input.createWorktreeInput, expectedRealPath: f.workspacePath } })).workerToolRoot)
      .toEqual({ status: WorkerToolRootStatus.Skipped, reason: WorkerToolRootSkipReason.WorktreeReused });
  });

  it.each([[true, true, true], [true, false, false], [false, true, false]] as const)(
    "rollback created=%s prepared=%s removes=%s", async (worktreeCreated, toolRootPrepared, removes) => {
      const f = await fixture();
      expect(await prepareWorkerToolRoot(f)).toEqual(prepared);
      const rollback = await rollbackProjectRefillPartial({ expectedSourceRealPath: f.sourceRepositoryPath, workspacePath: f.workspacePath,
        promptPath: join(f.root, "registry", f.jobId, "prompt.txt"), registryRootDir: join(f.root, "registry"), jobId: f.jobId,
        worktreeCreated, toolRootPrepared, promptWritten: false });
      expect(rollback.includes("tool-root")).toBe(removes);
      if (removes) await expect(lstat(workerToolRootPath(f.workspacePath))).rejects.toMatchObject({ code: "ENOENT" });
      else expect((await lstat(workerToolRootPath(f.workspacePath))).isDirectory()).toBe(true);
    },
  );
});
