import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProjectAccessScope } from "@vioxen/subscription-runtime/worker-core";
import { OpenWorkerLayoutErrorCode } from "@vioxen/subscription-runtime/provider-codex";
import { execGitStdout } from "./application/project-control/codex-goal-project-git";
import { defaultProjectControlGitPort, type ProjectControlGitPort } from "./application/project-control/adapters/host-command-adapters";
import { nodeErrorCode } from "./application/project-control/codex-goal-project-utils";

export enum WorkerToolRootStatus { Prepared = "prepared", Skipped = "skipped" }
export enum WorkerToolRootSkipReason {
  WorktreeReused = "worktree_reused",
  Gitlinks = "gitlinks",
  ToolRootExists = "tool_root_exists",
  PrepareFailed = "prepare_failed",
}
export enum WorkerToolRootBinding { Absent = "absent", Foreign = "foreign", Owned = "owned" }
export type WorkerToolRootOutcome = {
  readonly status: WorkerToolRootStatus;
  readonly reason?: WorkerToolRootSkipReason;
  readonly detail?: string;
};
export type WorkerToolRootInput = {
  readonly jobId: string;
  readonly workspacePath: string;
  readonly sourceRepositoryPath: string;
  readonly base: string;
  readonly commitAllowed: boolean;
  readonly commitIdentity?: ProjectAccessScope["commitIdentity"];
};
export const workerToolRootPath = (workspacePath: string): string => `${workspacePath}.tool`;
const gitOverrides = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];

export async function prepareWorkerToolRoot(
  input: WorkerToolRootInput,
  git: ProjectControlGitPort = defaultProjectControlGitPort,
): Promise<WorkerToolRootOutcome> {
  const root = workerToolRootPath(input.workspacePath);
  let created = false;
  const run = (args: readonly string[]) => execGitStdout([...gitOverrides, ...args], git);
  const config = async (repository: string, key: string) => {
    try { return (await run(["-C", repository, "config", "--local", "--get", key])).trim(); }
    catch { return ""; }
  };
  try {
    if (input.commitAllowed) {
      const { stdout } = await git.run({
        args: [...gitOverrides, "-C", input.workspacePath, "ls-files", "--format=%(objectmode)"],
        timeoutMs: 120_000, maxBuffer: 64 * 1024 * 1024,
      });
      if (stdout.split(/\r?\n/).includes("160000")) {
        return { status: WorkerToolRootStatus.Skipped, reason: WorkerToolRootSkipReason.Gitlinks };
      }
    }
    try { await mkdir(root, { mode: 0o700 }); created = true; }
    catch (error) {
      if (nodeErrorCode(error) === "EEXIST") {
        return { status: WorkerToolRootStatus.Skipped, reason: WorkerToolRootSkipReason.ToolRootExists };
      }
      throw error;
    }
    await mkdir(join(root, "home"), { mode: 0o700 });
    await mkdir(join(root, "tmp"), { mode: 0o700 });
    if (input.commitAllowed) {
      const gitDir = `--git-dir=${join(root, "git")}`;
      await mkdir(join(root, "git"), { mode: 0o700 });
      await run(["init", "--quiet", "--bare", join(root, "git")]);
      await git.run({
        args: [...gitOverrides, "-c", "protocol.version=2", gitDir, "fetch", "--quiet", "--no-tags",
          "--no-write-fetch-head", "--no-recurse-submodules", "--", input.sourceRepositoryPath,
          `+${input.base}:refs/heads/work`, "+refs/remotes/origin/*:refs/remotes/origin/*"],
        timeoutMs: 300_000, maxBuffer: 1024 * 1024,
      });
      try { await run([gitDir, "cat-file", "-e", `${input.base}^{commit}`]); }
      catch { throw new Error("worker_tool_root_base_missing"); }
      for (const [key, value] of [["core.bare", "false"], ["core.worktree", input.workspacePath], ["commit.gpgsign", "false"]]) {
        await run([gitDir, "config", key!, value!]);
      }
      for (const [key, field] of [["user.name", "name"], ["user.email", "email"]] as const) {
        const value = input.commitIdentity?.[field] ?? await config(input.sourceRepositoryPath, key);
        if (value) await run([gitDir, "config", key, value]);
      }
      try {
        let remote = await config(input.sourceRepositoryPath, "remote.origin.url");
        if (isAbsolute(remote) || remote.startsWith("file:")) {
          remote = await config(remote.startsWith("file:") ? fileURLToPath(remote) : remote, "remote.origin.url");
        }
        const url = new URL(remote);
        if (url.protocol === "https:" && !url.username && !url.password) {
          await run([gitDir, "remote", "add", "origin", remote]);
        }
      } catch { /* An unusable canonical remote does not prevent local commits. */ }
      await run([gitDir, "symbolic-ref", "HEAD", "refs/heads/work"]);
      await run([gitDir, `--work-tree=${input.workspacePath}`, "read-tree", "refs/heads/work"]);
    }
    await writeFile(join(root, "owner.json.tmp"), JSON.stringify({ jobId: input.jobId }), { mode: 0o600 });
    await rename(join(root, "owner.json.tmp"), join(root, "owner.json"));
    return { status: WorkerToolRootStatus.Prepared };
  } catch (error) {
    if (created) await removeWorkerToolRoot(input.workspacePath).catch(() => undefined);
    return { status: WorkerToolRootStatus.Skipped, reason: WorkerToolRootSkipReason.PrepareFailed,
      detail: (error instanceof Error ? error.message : String(error)).slice(0, 300) };
  }
}

export async function removeWorkerToolRoot(workspacePath: string): Promise<void> {
  await rm(workerToolRootPath(workspacePath), { recursive: true, force: true });
}

export async function inspectWorkerToolRoot(input: { readonly workspacePath: string; readonly jobId: string }): Promise<WorkerToolRootBinding> {
  const root = workerToolRootPath(input.workspacePath);
  let entry;
  try { entry = await lstat(root); }
  catch (error) { if (nodeErrorCode(error) === "ENOENT") return WorkerToolRootBinding.Absent; throw error; }
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error(`hosted_open_worker_layout_invalid:${OpenWorkerLayoutErrorCode.ToolRootNotDirectory}`);
  }
  try {
    if (!(await lstat(join(root, "owner.json"))).isFile()) return WorkerToolRootBinding.Foreign;
    return JSON.parse(await readFile(join(root, "owner.json"), "utf8")).jobId === input.jobId
      ? WorkerToolRootBinding.Owned : WorkerToolRootBinding.Foreign;
  } catch { return WorkerToolRootBinding.Foreign; }
}
