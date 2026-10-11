import { callToolJson, describe, tmpdir } from "./codex-goal-mcp-project-admission-test-fixture";
import { access, chmod, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it } from "vitest";
import { AccessBoundary, ProjectOperation, type ProjectAccessScope } from "@vioxen/subscription-runtime/worker-core";
import { createCodexGoalMcpServer } from "../codex-goal-mcp";
import { readCodexGoalJob, type CodexGoalJobManifestInput } from "../codex-goal-jobs";
import { observeProtectedCodexGoalJobBirth } from "../protected-job-birth";
import { researchAuthorityRoot, researchHash } from "../research-launch-files";
import {
  admissionCreationTargetIdentity, admissionCreateJobTargetIdentity, admissionNeedsFreshCreateJobTarget,
} from "../application/project-control/codex-goal-project-admission-target";
import { prospectiveAdmissionResourceBacking } from "../application/project-control/codex-goal-project-admission-paths";
import { host } from "./research-launch-fixture";
import { callToolJson as invokeTool, git, gitInitRepository, gitStdout } from "./codex-goal-mcp-test-support";

async function fixture() {
  const root = join(tmpdir(), "TEST-creation-target");
  const registryRootDir = join(root, "registry");
  const workspacePath = join(root, "workspaces", "child");
  for (const path of [registryRootDir, workspacePath, join(root, "jobs"), join(root, "worktrees")]) {
    await mkdir(path, { recursive: true, mode: 0o700 });
  }
  const scope: ProjectAccessScope = {
    projectId: "TEST-creation", registryRoot: registryRootDir, authRoot: join(tmpdir(), "auth"),
    workspaceRoots: [join(root, "workspaces")], worktreeRoots: [join(root, "worktrees")],
    jobIdPrefixes: ["TEST-"], tmuxSessionPrefixes: ["TEST-"], allowedAccountIds: ["TEST-a"],
  };
  const manifest: CodexGoalJobManifestInput = {
    jobId: "TEST-child", taskId: "TEST-child", workspacePath,
    jobRootDir: join(root, "jobs", "TEST-child"), promptPath: join(root, "jobs", "TEST-child", "prompt.md"),
    accounts: ["TEST-a"], authRootDir: join(tmpdir(), "auth"),
  };
  const input = { registryRootDir, scope, binding: { createManifest: manifest },
    request: { operation: ProjectOperation.CreateJob, jobId: manifest.jobId, workspacePath } };
  return { root, registryRootDir, workspacePath, scope, manifest, input };
}

describe("scoped creation targets", () => {
  it.each([false, true])("registers a fresh job with actual physical target facts (future workspace=%s)", async future => {
    const f = await fixture();
    if (future) await rm(f.workspacePath, { recursive: true });
    const controllerWorkspace = join(f.root, "workspaces", "controller");
    await mkdir(controllerWorkspace, { mode: 0o700 });
    for (const workspace of [controllerWorkspace, ...(future ? [] : [f.workspacePath])]) {
      await gitInitRepository(workspace);
      await writeFile(join(workspace, "README.md"), "TEST base\n");
      await git(workspace, ["add", "README.md"]);
      await git(workspace, ["commit", "-m", "test: creation target base"]);
    }
    const server = createCodexGoalMcpServer();
    const client = new Client({ name: "TEST-creation-target", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const controllerRoot = join(f.root, "jobs", "TEST-controller");
      await expect(callToolJson(client, "codex_goal_create_job", {
        registryRootDir: f.registryRootDir, jobId: "TEST-controller", taskId: "TEST-controller",
        workspacePath: controllerWorkspace, jobRootDir: controllerRoot, promptPath: join(controllerRoot, "prompt.md"),
        authRootDir: f.scope.authRoot,
        accounts: ["TEST-a"], accessBoundary: AccessBoundary.ProjectScopedControl, projectAccessScope: f.scope,
      })).resolves.toMatchObject({ ok: true });
      const physical = await Promise.all([f.workspacePath, f.manifest.jobRootDir].map(prospectiveAdmissionResourceBacking));
      expect(physical.every(roots => Boolean(roots?.length))).toBe(true);
      const created = await callToolJson(client, "codex_goal_project_create_job", {
        registryRootDir: f.registryRootDir, controllerJobId: "TEST-controller", ...f.manifest,
        workerRole: "producer", confirmCreate: true,
      });
      expect(created).toMatchObject({ ok: true, result: { admission: {
        scope: "target", target: { canonicalPath: f.workspacePath, physicalWritableRoots: physical.flat() },
        backlog: { count: 0 },
      } } });
      const stored = await readCodexGoalJob({ registryRootDir: f.registryRootDir, jobId: f.manifest.jobId });
      expect(stored.projectPreStartAdmission).toBeUndefined();
      expect(await observeProtectedCodexGoalJobBirth(stored)).toEqual({ status: future ? "unknown" : "released" });
      // Registration neither creates the future workspace nor grants release
      // merely because its current directory has not been created yet.
      if (future) await expect(access(f.workspacePath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await client.close(); await server.close(); }
  });

  it("keeps an existing prompt-only legacy root on its original admission route", async () => {
    const f = await fixture();
    expect(await admissionNeedsFreshCreateJobTarget(f.input.binding)).toBe(true);
    await mkdir(f.manifest.jobRootDir, { mode: 0o700 });
    await writeFile(f.manifest.promptPath, "TEST existing prompt\n");
    expect(await admissionNeedsFreshCreateJobTarget(f.input.binding)).toBe(false);
    expect(await admissionCreateJobTargetIdentity(f.input)).toBeUndefined();
  });

  it.each([false, true])("keeps legacy enforcement and refuses fallback for malformed modern birth=%s", async modern => {
    const f = await fixture(), controllerWorkspace = join(f.root, "workspaces", "controller");
    await mkdir(controllerWorkspace, { mode: 0o700 });
    for (const workspace of [controllerWorkspace, f.workspacePath]) {
      await gitInitRepository(workspace);
      await writeFile(join(workspace, "README.md"), "TEST base\n");
      await git(workspace, ["add", "README.md"]);
      await git(workspace, ["commit", "-m", "test: controller route provenance"]);
    }
    const controllerRoot = join(f.root, "jobs", "TEST-controller");
    if (!modern) await mkdir(controllerRoot, { mode: 0o700 });
    const server = createCodexGoalMcpServer(), client = new Client({ name: "TEST-owner-route", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      await expect((modern ? callToolJson : invokeTool)(client, "codex_goal_create_job", {
        registryRootDir: f.registryRootDir, jobId: "TEST-controller", taskId: "TEST-controller",
        workspacePath: controllerWorkspace, jobRootDir: controllerRoot, promptPath: join(controllerRoot, "prompt.md"),
        authRootDir: f.scope.authRoot, accounts: ["TEST-a"],
        accessBoundary: AccessBoundary.ProjectScopedControl, projectAccessScope: f.scope,
      })).resolves.toMatchObject({ ok: true });
      if (modern) await writeFile(join(researchAuthorityRoot, "job-births", researchHash(controllerRoot) + ".json"), "{");
      const controller = await readCodexGoalJob({ registryRootDir: f.registryRootDir, jobId: "TEST-controller" });
      expect(await observeProtectedCodexGoalJobBirth(controller)).toEqual({ status: "unknown" });
      const result = await callToolJson(client, "codex_goal_project_create_job", {
        registryRootDir: f.registryRootDir, controllerJobId: controller.jobId, ...f.manifest,
        workerRole: "producer", confirmCreate: true,
      });
      if (modern) {
        expect(result).toMatchObject({ ok: false, admission: { allowed: false, resource: f.workspacePath,
          examples: expect.arrayContaining([{ reason: "active_writer_conflict" }]) } });
        await expect(access(f.manifest.jobRootDir)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(access(join(f.registryRootDir, f.manifest.jobId))).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        expect(result).toMatchObject({ ok: true, result: { status: "applied" } });
        expect((result.result as Record<string, unknown>).admission).toBeUndefined();
        expect((await readCodexGoalJob({ registryRootDir: f.registryRootDir, jobId: f.manifest.jobId })).jobId).toBe(f.manifest.jobId);
      }
    } finally { await client.close(); await server.close(); }
  });

  it("requires initial host identity and current custody even for an absent root", async () => {
    const f = await fixture();
    expect(await admissionCreateJobTargetIdentity(f.input)).toBe(f.workspacePath);
    host.namespaceRoot = true;
    expect(await admissionNeedsFreshCreateJobTarget(f.input.binding)).toBe(true);
    expect(await admissionCreateJobTargetIdentity(f.input)).toBeUndefined();
    host.namespaceRoot = false;
    host.foreign.add(f.workspacePath);
    expect(await admissionCreateJobTargetIdentity(f.input)).toBeUndefined();
    host.foreign.delete(f.workspacePath);
    await chmod(join(f.root, "jobs"), 0o777);
    expect(await admissionCreateJobTargetIdentity(f.input)).toBeUndefined();
    await expect(access(f.manifest.jobRootDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects required pre-start policy, request mismatch and registry collision", async () => {
    const f = await fixture();
    expect(await admissionCreateJobTargetIdentity({ ...f.input,
      scope: { ...f.scope, preStartAdmission: { required: true, mode: "serial-builtin" } },
    })).toBeUndefined();
    expect(await admissionCreateJobTargetIdentity({ ...f.input,
      request: { ...f.input.request, jobId: "TEST-other" },
    })).toBeUndefined();
    await mkdir(join(f.registryRootDir, f.manifest.jobId), { mode: 0o700 });
    expect(await admissionCreateJobTargetIdentity(f.input)).toBeUndefined();
    await expect(access(f.manifest.jobRootDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a future job-root alias even when its workspace is canonical", async () => {
    const f = await fixture();
    const alias = join(f.root, "alias-jobs");
    await symlink(join(f.root, "jobs"), alias);
    expect(await admissionCreateJobTargetIdentity({ ...f.input, binding: { createManifest: {
      ...f.manifest, jobRootDir: join(alias, f.manifest.jobId), promptPath: join(alias, f.manifest.jobId, "prompt.md"),
    } } })).toBeUndefined();
  });

  it("rejects an aliased or out-of-scope future workspace and unsafe ancestor custody", async () => {
    const f = await fixture(), alias = join(f.root, "workspace-alias");
    await symlink(join(f.root, "workspaces"), alias);
    for (const workspacePath of [join(alias, "future"), join(f.root, "unscoped-future")]) {
      expect(await admissionCreateJobTargetIdentity({ ...f.input,
        request: { ...f.input.request, workspacePath },
        binding: { createManifest: { ...f.manifest, workspacePath } },
      })).toBeUndefined();
    }
    await rm(f.workspacePath, { recursive: true });
    expect(await admissionCreateJobTargetIdentity(f.input)).toBe(f.workspacePath);
    await chmod(join(f.root, "workspaces"), 0o777);
    expect(await admissionCreateJobTargetIdentity(f.input)).toBeUndefined();
    await expect(access(f.workspacePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(f.manifest.jobRootDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([false, true])("qualifies a pinned worktree without granting mismatched child ownership (existing=%s)", async existing => {
    const f = await fixture();
    await gitInitRepository(f.workspacePath);
    await writeFile(join(f.workspacePath, "README.md"), "TEST pinned base\n");
    await git(f.workspacePath, ["add", "README.md"]);
    await git(f.workspacePath, ["commit", "-m", "test: standalone worktree target"]);
    const path = join(f.root, "worktrees", "TEST-standalone");
    if (existing) await git(f.workspacePath, ["worktree", "add", "-b", "fix/TEST-existing", path, "HEAD"]);
    const target = { sourceWorkspacePath: f.workspacePath, expectedSourceRealPath: f.workspacePath,
      path, expectedRevision: (await gitStdout(f.workspacePath, ["rev-parse", "HEAD"])).trim(), sourceRevisionPinned: true,
      ...(existing ? { expectedRealPath: path, newBranch: "fix/TEST-existing", workerRole: "adoption" as const } : {}) };
    const request = { operation: ProjectOperation.CreateWorktree, workspacePath: path };
    const input = { registryRootDir: f.registryRootDir, scope: f.scope, binding: { createWorktree: target }, request };
    expect(await admissionCreationTargetIdentity(input)).toBe(path);
    expect(await admissionCreationTargetIdentity({ ...input, request: { ...request, ownedPaths: ["src/"] } })).toBeUndefined();
    const child = { ...target, jobId: "TEST-child", ownedPaths: ["src/"] };
    expect(await admissionCreationTargetIdentity({ ...input, binding: { createWorktree: child },
      request: { ...request, jobId: child.jobId, ownedPaths: ["other/"] } })).toBeUndefined();
    expect(await admissionCreationTargetIdentity({ ...input, binding: { createWorktree: child },
      request: { ...request, jobId: child.jobId, ownedPaths: ["src/"] } })).toBe(path);
    if (existing) {
      await writeFile(join(path, "README.md"), "TEST adopted changes\n");
      expect(await admissionCreationTargetIdentity(input)).toBe(path);
      for (const changed of [
        { ...target, expectedRealPath: undefined }, { ...target, expectedRealPath: f.workspacePath },
        { ...target, expectedSourceRealPath: path }, { ...target, newBranch: "fix/TEST-other" },
        { ...target, expectedRevision: "0".repeat(40) },
      ]) expect(await admissionCreationTargetIdentity({ ...input, binding: { createWorktree: changed } })).toBeUndefined();
      await expect(access(path)).resolves.toBeUndefined();
    } else await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
