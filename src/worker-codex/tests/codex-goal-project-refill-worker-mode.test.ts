import { setupResearchFixture, cleanupResearchFixture } from "./research-launch-fixture";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AccessBoundary, WorkerMode } from "@vioxen/subscription-runtime/worker-core";
import { createCodexGoalMcpServer } from "../codex-goal-mcp";
import * as boundedOperation from "../codex-goal-mcp-project-control-bounded-operation";
import * as projectScope from "../codex-goal-mcp-project-scope";
import * as toolRoots from "../worker-tool-root";
import { callToolJson, git } from "./codex-goal-mcp-test-support";
import { createFixture, createScope } from "./codex-goal-project-refill-fixture";

beforeEach(() => {
  setupResearchFixture();
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
});
afterEach(() => {
  cleanupResearchFixture();
  vi.unstubAllEnvs();
});

// Binding tests drive the MCP refill caller; separate worktree and lifecycle suites explain its boundaries.
describe.skipIf(process.platform !== "linux")("binding: public refill worker mode and tool-root lifecycle", () => {
  it.each([undefined, WorkerMode.Open])("bounded refill preview agrees with sync manifest for scope mode %s", async workerMode => {
    const f = await createPublicRefillFixture(workerMode);
    try {
      // The real preview producer and path validation run. Only runner dispatch is
      // stubbed; this binds manifest planning, not bounded runner completion.
      const validateManifest = vi.spyOn(projectScope, "assertProjectControlCreateManifestPaths");
      const dispatch = vi.spyOn(boundedOperation, "createBoundedProjectControlOperationView")
        .mockResolvedValue({ ok: true, executionMode: "bounded" });
      const preview = await callToolJson(f.client, "codex_goal_project_refill_worker", {
        ...f.args, executionMode: "bounded",
      });
      expect(preview).toMatchObject({ ok: true, executionMode: "bounded" });
      expect(dispatch).toHaveBeenCalledOnce();
      expect(validateManifest).toHaveBeenCalledOnce();
      const previewManifest = validateManifest.mock.calls[0]![0].manifest;
      await expect(access(join(f.registryRootDir, "mode-child", "job.json")))
        .rejects.toMatchObject({ code: "ENOENT" });

      const result = await callToolJson(f.client, "codex_goal_project_refill_worker", {
        ...f.args, executionMode: "sync",
      });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
      const syncManifest = JSON.parse(await readFile(join(f.registryRootDir, "mode-child", "job.json"), "utf8"));
      expect(previewManifest.workerMode).toBe(syncManifest.workerMode);
      if (workerMode === undefined) {
        expect(previewManifest).not.toHaveProperty("workerMode");
        expect(syncManifest).not.toHaveProperty("workerMode");
      } else {
        expect(previewManifest.workerMode).toBe(WorkerMode.Open);
        expect(syncManifest.workerMode).toBe(WorkerMode.Open);
      }
    } finally {
      await f.close();
    }
  });

  it.each([undefined, WorkerMode.Open])("scope mode %s binds child manifest and preparation", async workerMode => {
    const f = await createPublicRefillFixture(workerMode);
    try {
      const result = await callToolJson(f.client, "codex_goal_project_refill_worker", f.args);
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
      const manifest = JSON.parse(await readFile(join(f.registryRootDir, "mode-child", "job.json"), "utf8"));
      if (workerMode === undefined) {
        expect(manifest).not.toHaveProperty("workerMode");
        expect(result).not.toHaveProperty("workerToolRoot");
        await expect(access(toolRoots.workerToolRootPath(f.workspacePath))).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        expect(manifest.workerMode).toBe(WorkerMode.Open);
        expect(result.workerToolRoot).toEqual({ status: toolRoots.WorkerToolRootStatus.Prepared });
        expect(JSON.parse(await readFile(join(toolRoots.workerToolRootPath(f.workspacePath), "owner.json"), "utf8")))
          .toEqual({ jobId: "mode-child" });
      }
    } finally {
      await f.close();
    }
  });

  it.each([false, true])("rollback retains original refill error when tool-root removal fails=%s", async removalFails => {
    const f = await createPublicRefillFixture(WorkerMode.Open);
    try {
      await mkdir(join(f.root, "worker-jobs", "mode-child"), { recursive: true });
      await writeFile(f.promptPath, "existing different prompt\n");
      // Only the filesystem cleanup fault is injected; preparation and the refill caller remain real.
      if (removalFails) vi.spyOn(toolRoots, "removeWorkerToolRoot").mockRejectedValue(new Error("cleanup denied"));
      const result = await callToolJson(f.client, "codex_goal_project_refill_worker", f.args);
      expect(result).toEqual({
        ok: false,
        error: `project_control_existing_prompt_mismatch; rollback=worktree,${removalFails ? "tool-root-remove-failed" : "tool-root"}`,
      });
      await expect(access(f.workspacePath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(f.promptPath, "utf8")).toBe("existing different prompt\n");
      if (removalFails) await expect(access(toolRoots.workerToolRootPath(f.workspacePath))).resolves.toBeUndefined();
      else await expect(access(toolRoots.workerToolRootPath(f.workspacePath))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await f.close();
    }
  });
});

async function createPublicRefillFixture(workerMode?: WorkerMode) {
  const f = await createFixture();
  const authRootDir = join(f.root, "auth");
  const registryRootDir = join(f.root, "worker-jobs", "registry");
  const controllerJobRoot = join(f.root, "worker-jobs", "mode-controller");
  const workspacePath = join(f.root, "worktrees", "mode-child");
  const promptPath = join(f.root, "worker-jobs", "mode-child", "prompt.md");
  const server = createCodexGoalMcpServer();
  const client = new Client({ name: "refill-mode-binding", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const close = async () => {
    await client.close();
    await server.close();
    await rm(f.root, { recursive: true, force: true });
  };
  try {
    await mkdir(authRootDir, { recursive: true, mode: 0o700 });
    const remotePath = join(f.root, "origin.git");
    await git(f.root, ["init", "--bare", remotePath]);
    await git(f.sourceWorkspacePath, ["remote", "add", "origin", remotePath]);
    await git(f.sourceWorkspacePath, ["push", "origin", "HEAD:main"]);
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const created = await callToolJson(client, "codex_goal_create_job", {
      registryRootDir, jobId: "mode-controller", jobRootDir: controllerJobRoot,
      workspacePath: f.sourceWorkspacePath, promptPath: join(controllerJobRoot, "prompt.md"),
      taskId: "mode-controller", accounts: ["account-a"], authRootDir,
      accessBoundary: AccessBoundary.ProjectScopedControl,
      projectAccessScope: {
        ...createScope(f), registryRoot: registryRootDir, jobIdPrefixes: ["mode-"],
        tmuxSessionPrefixes: ["mode-"], allowedBranches: ["main", "test/mode-*"],
        allowedAccountIds: ["account-a"], allowedGitRemotes: ["origin"],
        ...(workerMode ? { workerMode } : {}),
      },
    });
    expect(created, JSON.stringify(created)).toMatchObject({ ok: true });
    return {
      root: f.root, registryRootDir, workspacePath, promptPath, client, close,
      args: {
        registryRootDir, controllerJobId: "mode-controller", jobId: "mode-child",
        sourceWorkspacePath: f.sourceWorkspacePath, baseBranch: "main",
        expectedSourceCommit: f.phaseStartSha, newBranch: "test/mode-child",
        workspacePath, promptPath, promptBody: "Run a focused test.\n", taskId: "mode-child",
        accounts: ["account-a"], authRootDir, startWorker: false, confirmRefill: true,
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
