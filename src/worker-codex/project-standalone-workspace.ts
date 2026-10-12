import { lstat, mkdir, realpath, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectAccessScope } from "@vioxen/subscription-runtime/worker-core";
import type { CodexGoalJobManifestInput } from "./codex-goal-jobs";
import type { CodexGoalProjectCreateWorktreeInput } from "./application/project-control/codex-goal-project-control-contracts";
import { defaultProjectControlGitPort } from "./application/project-control/adapters/host-command-adapters";

/** Selection is configuration, never admission. The broker still owns the
 * current controller fence and fresh-target identity before any Git effect. */
export function requiresStandaloneProjectWorkspace(input: {
  readonly manifest: CodexGoalJobManifestInput | undefined;
  readonly target: CodexGoalProjectCreateWorktreeInput;
  readonly scope: ProjectAccessScope;
  readonly registryRootDir: string;
}): boolean {
  const m = input.manifest;
  if (!m || !/^TEST-[A-Za-z0-9_.-]{1,123}$/.test(m.jobId)) return false;
  const root = "/var/lib/subscription-runtime-host-policy/dependency-test-jobs/jobs/" + m.jobId;
  return m.jobRootDir === root && m.workspacePath === root + "/workspace" &&
    m.authRootDir === root + "/auth" && m.durableHandoffRootDir === root + "/durable-handoffs" &&
    m.executionEngine === "app-server-goal" && input.target.jobId === m.jobId && input.target.path === m.workspacePath &&
    input.registryRootDir === root + "/state/registry" && input.scope.registryRoot === input.registryRootDir &&
    input.scope.authRoot === m.authRootDir && input.scope.worktreeRoots?.length === 1 && input.scope.worktreeRoots[0] === m.workspacePath;
}

type DirectoryIdentity = { readonly dev: number; readonly ino: number };
// Only directories exclusively created by this process can be rolled back.
// A crash leaves custody preserved; a replaced target is never removed.
const created = new Map<string, DirectoryIdentity>();
const flags = ["--no-replace-objects", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
  "-c", "protocol.allow=never", "-c", "protocol.file.allow=always", "-c", "uploadpack.packObjectsHook="];
async function git(path: string, args: readonly string[]): Promise<string> {
  return (await defaultProjectControlGitPort.run({ args: [...flags, "-C", path, ...args],
    timeoutMs: 120_000, maxBuffer: 1024 * 1024,
    env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent", LANG: "C", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1" } })).stdout;
}
export async function assertStandaloneProjectWorkspace(path: string): Promise<void> {
  const info = await lstat(path), metadata = await lstat(join(path, ".git"));
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path || !metadata.isDirectory() || metadata.isSymbolicLink() ||
      await realpath(join(path, ".git")) !== join(path, ".git") || (await readdir(join(path, ".git"))).some(name => name === "commondir" || name === "shallow"))
    throw new Error("project_control_standalone_workspace_invalid");
  for (const name of ["alternates", "http-alternates"]) {
    try { await lstat(join(path, ".git/objects/info", name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    throw new Error("project_control_standalone_workspace_alternates");
  }
  if ((await git(path, ["remote"])).trim()) throw new Error("project_control_standalone_workspace_remote");
}
export async function fetchStandaloneProjectRevision(path: string, source: string, revision: string): Promise<void> {
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("project_control_standalone_revision_invalid");
  await git(path, ["fetch", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", "--upload-pack=git-upload-pack", "--", source, revision]);
  if ((await git(path, ["rev-parse", "--verify", revision + "^{commit}"])).trim() !== revision)
    throw new Error("project_control_standalone_revision_changed");
}
export async function materializeStandaloneProjectWorkspace(input: {
  readonly path: string; readonly source: string; readonly revision: string;
  readonly branch: string | undefined; readonly existingBranchRevision: string | undefined;
}): Promise<void> {
  await mkdir(input.path, { mode: 0o700 });
  const identity = await lstat(input.path);
  created.set(input.path, { dev: identity.dev, ino: identity.ino });
  try {
    await git(input.path, ["init", "--template="]);
    for (const revision of new Set([input.revision, input.existingBranchRevision].filter((value): value is string => value !== undefined)))
      await fetchStandaloneProjectRevision(input.path, input.source, revision);
    await git(input.path, ["checkout", ...(input.branch ? ["-b", input.branch] : ["--detach"]), input.existingBranchRevision ?? input.revision]);
    await assertStandaloneProjectWorkspace(input.path);
  } catch (error) { await removeCreatedStandaloneProjectWorkspace(input.path); throw error; }
}
export async function removeCreatedStandaloneProjectWorkspace(path: string): Promise<boolean> {
  const expected = created.get(path);
  if (!expected) return false;
  const actual = await lstat(path);
  if (!actual.isDirectory() || actual.isSymbolicLink() || actual.dev !== expected.dev || actual.ino !== expected.ino || await realpath(path) !== path)
    throw new Error("project_control_standalone_rollback_identity_changed");
  await rm(path, { recursive: true });
  created.delete(path);
  return true;
}
