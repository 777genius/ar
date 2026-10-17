import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, readdir, lstat, realpath, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccessBoundary, NetworkAccessMode, ProjectAdmissionWorkerRole } from "@vioxen/subscription-runtime/worker-core";
import { createCodexGoalJob, type CodexGoalJobManifestInput } from "../codex-goal-jobs";
import { tryReadOnlyProjectRefillContinuation } from "../application/project-control/codex-goal-project-refill-readonly";
import { projectControlRefillWorkerView } from "../codex-goal-mcp-project-control-jobs";
import { projectControlChildManifestInput } from "../application/project-control/codex-goal-project-child-manifest";
import { projectControlChildScope } from "../codex-goal-mcp-project-scope";
import * as accounts from "../codex-goal-mcp-project-accounts";

const exec = promisify(execFile), roots: string[] = [];
beforeEach(() => {
  // Keep observation under the same fixture config as repository setup. Runner
  // filters (for example Git LFS) must not preempt the repository-local guards.
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
});
afterEach(async () => {
  try { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); }
  finally { vi.unstubAllEnvs(); }
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "TEST-read-only-refill-"))); roots.push(root);
  const job = join(root, "state/TEST-read-only-child"), workspace = join(job, "workspace"), registry = join(root, "state/registry"), controllerRoot = join(root, "state/TEST-controller");
  for (const path of [workspace, registry, controllerRoot, join(root, "auth")]) await mkdir(path, { recursive: true, mode: 0o700 });
  const git = async (...args: string[]) => (await exec("git", ["-C", workspace, ...args], { env: { ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" } })).stdout.trim();
  await git("init", "--template=", "--initial-branch=test/read-only");
  await writeFile(join(workspace, "README.md"), "read-only continuation\n"); await git("add", "README.md"); await git("commit", "-m", "test: fixture");
  const revision = await git("rev-parse", "HEAD"), jobId = "TEST-read-only-child", promptBody = "Same immutable prompt.\n";
  const scope = { projectId: "TEST-read-only", workspaceRoots: [workspace], worktreeRoots: [workspace], registryRoot: registry,
    authRoot: join(root, "auth"), allowedBranches: ["test/read-only", revision], allowedGitRemotes: ["origin"],
    jobIdPrefixes: ["TEST-"], tmuxSessionPrefixes: ["TEST-"], allowedAccountIds: ["account-a"] };
  const manifest: CodexGoalJobManifestInput = { jobId, taskId: jobId, jobRootDir: job, workspacePath: workspace,
    promptPath: join(job, "prompt.md"), authRootDir: scope.authRoot, accounts: ["account-a"],
    accessBoundary: AccessBoundary.IsolatedWorkspaceWrite, networkAccess: NetworkAccessMode.Unrestricted,
    allowDangerFullAccess: false, projectAccessScope: scope, executionEngine: "app-server-goal",
    durableHandoffRootDir: join(job, "durable-handoffs"), prewarmOnStart: false };
  await writeFile(manifest.promptPath, promptBody); const existing = await createCodexGoalJob({ registryRootDir: registry, manifest });
  const controller = { registryRootDir: registry, scope, controller: { ...existing, jobId: "TEST-controller", jobRootDir: controllerRoot } };
  const input: Parameters<typeof tryReadOnlyProjectRefillContinuation>[0] = { args: { startWorker: false, prewarmOnStart: false, sourceRef: revision,
    confirmRefill: true, baseBranch: "test/read-only", newBranch: "test/read-only" },
    controller, deps: { loadProjectControlController: async () => controller,
      codexProjectControlBroker: () => { throw new Error("A read-only continuation must not construct a mutation broker"); } },
    manifest, promptBody, workerRole: ProjectAdmissionWorkerRole.Producer,
    sourceWorkspacePath: workspace, sealedSource: false };
  return { root, job, workspace, registry, git, input };
}
async function bytesTree(root: string): Promise<Readonly<Record<string, string>>> {
  const result: Record<string, string> = {};
  async function visit(path: string) { for (const name of await readdir(path)) {
    const child = join(path, name), stat = await lstat(child);
    if (stat.isDirectory()) await visit(child); else if (stat.isFile()) result[child.slice(root.length)] = (await readFile(child)).toString("base64");
  } }
  await visit(root); return result;
}

describe("same-request no-start read-only refill continuation", () => {
  it("retains manifest, prompt, repository/index bytes and inode while producing no new diagnostic or claim", async () => {
    const f = await fixture(), before = await bytesTree(f.job), identity = await lstat(f.workspace, { bigint: true });
    const manifestPath = join(f.registry, f.input.manifest.jobId, "job.json"), manifestBefore = await readFile(manifestPath);
    const result = await tryReadOnlyProjectRefillContinuation(f.input);
    expect(result).toMatchObject({ ok: true, readOnlyContinuation: true, worktree: { status: "noop" }, createJob: { status: "noop" } });
    expect(result).not.toHaveProperty("admission"); expect(result).not.toHaveProperty("start");
    expect(await bytesTree(f.job)).toEqual(before);
    expect(await readFile(manifestPath)).toEqual(manifestBefore);
    const after = await lstat(f.workspace, { bigint: true }); expect([after.dev, after.ino]).toEqual([identity.dev, identity.ino]);
  });
  it("returns through the public refill boundary before account refresh or mutation broker construction", async () => {
    const f = await fixture(), m = f.input.manifest;
    const request: Parameters<typeof projectControlRefillWorkerView>[0] = { ...f.input.args, jobId: m.jobId, taskId: m.taskId, registryRootDir: f.registry,
      jobRootDir: m.jobRootDir, workspacePath: m.workspacePath, promptPath: m.promptPath,
      sourceWorkspacePath: f.workspace, cwd: f.workspace, promptBody: f.input.promptBody,
      authRootDir: m.authRootDir!, accounts: m.accounts, executionEngine: "app-server-goal",
      durableHandoffRootDir: m.durableHandoffRootDir! };
    const requested = projectControlChildManifestInput({ args: request, scope: f.input.controller.scope, registryRootDir: f.registry });
    await createCodexGoalJob({ registryRootDir: f.registry, overwrite: true, manifest: { ...requested,
      tags: ["project-control-refill", "worker-role-producer"], accessBoundary: AccessBoundary.IsolatedWorkspaceWrite,
      networkAccess: NetworkAccessMode.Unrestricted, allowDangerFullAccess: false,
      projectAccessScope: projectControlChildScope(f.input.controller.scope, f.workspace) } });
    const before = await bytesTree(f.job);
    const refresh = vi.spyOn(accounts, "projectControlRefillAccountNames").mockImplementation(async () => {
      throw new Error("Read-only reuse must not claim a quota refresh");
    });
    try {
      expect(await projectControlRefillWorkerView(request, f.input.deps)).toMatchObject({ ok: true, readOnlyContinuation: true });
      expect(refresh).not.toHaveBeenCalled(); expect(await bytesTree(f.job)).toEqual(before);
    } finally { refresh.mockRestore(); }
  });
  it.each([
    ["start", { startWorker: true }], ["prewarm", { prewarmOnStart: true }], ["overwrite", { overwrite: true }],
    ["install", { dependencyBootstrap: "install" }], ["install confirmation", { confirmDependencyBootstrap: true }],
    ["moving source", { sourceRef: "test/read-only" }], ["merge", { mergeBinding: { sourceRemote: "origin", sourceBranch: "main" } }],
    ["producer output", { producerJobId: "TEST-producer" }], ["reviewed output", { reviewedOutputId: "reviewed" }],
  ])("keeps %s on the original mutation/admission path", async (_name, args) => {
    const f = await fixture(); expect(await tryReadOnlyProjectRefillContinuation({ ...f.input, args: { ...f.input.args, ...args } })).toBeUndefined();
  });
  it("does not turn missing registration into read-only admission", async () => {
    const f = await fixture(); await rm(join(f.registry, f.input.manifest.jobId), { recursive: true });
    expect(await tryReadOnlyProjectRefillContinuation(f.input)).toBeUndefined();
  });
  it("rejects changed job execution contract", async () => {
    const f = await fixture(); await expect(tryReadOnlyProjectRefillContinuation({ ...f.input,
      manifest: { ...f.input.manifest, executionEngine: "app-server-goal", taskId: "different-task" } })).rejects.toThrow("project_control_existing_job_mismatch");
  });
  it("rejects changed prompt", async () => {
    const f = await fixture(); await expect(tryReadOnlyProjectRefillContinuation({ ...f.input, promptBody: "Changed prompt." })).rejects.toThrow("project_control_prompt_mismatch");
  });
  it("retains the original dirty workspace rejection", async () => {
    const f = await fixture(); await writeFile(join(f.workspace, "untracked.txt"), "uncommitted\n");
    await expect(tryReadOnlyProjectRefillContinuation(f.input)).rejects.toThrow("project_control_existing_worktree_dirty");
  });
  it("does not execute configured Git monitoring or content filters", async () => {
    const f = await fixture(), marker = join(f.root, "executed"), monitor = join(f.root, "monitor");
    await writeFile(monitor, `#!/bin/sh\nprintf executed > '${marker}'\n`, { mode: 0o700 });
    await f.git("config", "core.fsmonitor", monitor);
    expect(await tryReadOnlyProjectRefillContinuation(f.input)).toMatchObject({ ok: true });
    await expect(lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    await f.git("config", "filter.test.clean", monitor);
    await expect(tryReadOnlyProjectRefillContinuation(f.input)).rejects.toThrow("project_control_existing_worktree_invalid");
    await expect(lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("retains branch and revision guards", async () => {
    const f = await fixture(); await gitBranchMismatch(f);
    await f.git("checkout", "test/read-only"); await writeFile(join(f.workspace, "README.md"), "new revision\n");
    await f.git("add", "README.md"); await f.git("commit", "-m", "test: newer revision");
    await expect(tryReadOnlyProjectRefillContinuation(f.input)).rejects.toThrow("project_control_existing_worktree_revision_mismatch");
  });
  it("fails if the controller scope changed before the existing locks", async () => {
    const f = await fixture(); const changed = { ...f.input.controller, scope: { ...f.input.controller.scope, projectId: "changed" } };
    await expect(tryReadOnlyProjectRefillContinuation({ ...f.input, deps: { ...f.input.deps,
      loadProjectControlController: async () => changed } })).rejects.toThrow("project_control_controller_scope_drift");
  });
});
async function gitBranchMismatch(f: Awaited<ReturnType<typeof fixture>>) {
  await f.git("checkout", "-b", "test/changed");
  await expect(tryReadOnlyProjectRefillContinuation(f.input)).rejects.toThrow("project_control_existing_worktree_branch_mismatch");
}
