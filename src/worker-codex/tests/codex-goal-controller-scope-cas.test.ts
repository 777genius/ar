import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AccessBoundary,
  NetworkAccessMode,
  type ProjectAccessScope,
} from "@vioxen/subscription-runtime/worker-core";
import {
  readCodexGoalJob,
  updateCodexGoalJob,
  type CodexGoalJobManifest,
} from "../codex-goal-jobs";
import { projectControlUpdateControllerScopeView } from
  "../codex-goal-mcp-project-control-admin";
import { withCurrentControllerScopeActivity } from
  "../application/project-control/codex-goal-current-controller-activity";

describe("controller scope update CAS", () => {
  it("rejects a stale launch scope before invoking its effect", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "controller-scope-launch-")));
    const expectedScope: ProjectAccessScope = {
      projectId: "social-monitor",
      readRoots: [root], workspaceRoots: [root], worktreeRoots: [root],
      registryRoot: join(root, "registry"), jobIdPrefixes: ["social-monitor-"],
      tmuxSessionPrefixes: ["social-monitor-"], allowedAccountIds: ["account-a"],
      consumedOutputLedgerRoots: [join(root, "ledgers", "v1")],
    };
    let invoked = false;
    await expect(withCurrentControllerScopeActivity({
      controllerJobRootDir: root,
      owner: "stale-launch-test",
      expectedScope,
      loadCurrentScope: async () => ({
        ...expectedScope,
        consumedOutputLedgerRoots: [join(root, "ledgers", "v2")],
      }),
      effect: async () => {
        invoked = true;
      },
    })).rejects.toThrow("project_control_controller_scope_drift");
    expect(invoked).toBe(false);
  });

  it("rejects a queued stale update instead of overwriting a newer manifest", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "controller-scope-cas-")));
    const registryRootDir = join(root, "registry");
    const controllerJobId = "social-monitor-controller-v4";
    const jobRootDir = join(registryRootDir, controllerJobId);
    const oldRoot = join(root, "ledgers", "v1");
    const newRoot = join(root, "ledgers", "v2");
    await Promise.all([
      mkdir(jobRootDir, { recursive: true }),
      mkdir(oldRoot, { recursive: true }),
      mkdir(newRoot, { recursive: true }),
    ]);
    const scope: ProjectAccessScope = {
      projectId: "social-monitor",
      readRoots: [root],
      workspaceRoots: [root],
      worktreeRoots: [root],
      registryRoot: registryRootDir,
      jobIdPrefixes: ["social-monitor-"],
      tmuxSessionPrefixes: ["social-monitor-"],
      allowedAccountIds: ["account-a"],
      consumedOutputLedgerRoots: [oldRoot],
    };
    const manifest: CodexGoalJobManifest = {
      schemaVersion: 1,
      jobId: controllerJobId,
      createdAt: "2026-08-08T00:00:00.000Z",
      updatedAt: "2026-08-08T00:00:00.000Z",
      jobRootDir,
      workspacePath: root,
      promptPath: join(jobRootDir, "prompt.md"),
      taskId: controllerJobId,
      accounts: ["account-a"],
      accessBoundary: AccessBoundary.ProjectScopedControl,
      networkAccess: NetworkAccessMode.Restricted,
      projectAccessScope: scope,
    };
    await writeFile(join(jobRootDir, "job.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    let loadCount = 0;
    const load = async () => {
      const controller = await readCodexGoalJob({ registryRootDir, jobId: controllerJobId });
      loadCount += 1;
      if (loadCount === 1) {
        await updateCodexGoalJob({
          registryRootDir,
          jobId: controllerJobId,
          patch: { description: "newer concurrent update" },
        });
      }
      return { registryRootDir, controller, scope: controller.projectAccessScope! };
    };
    const stale = projectControlUpdateControllerScopeView({
      registryRootDir,
      controllerJobId,
      projectAccessScope: { ...scope, consumedOutputLedgerRoots: [newRoot] },
      confirmUpdate: true,
    }, {
      loadProjectControlController: load,
      admissionDeps: { listJobs: async () => [], buildOverviewItems: async () => [] },
    });
    await expect(stale).rejects.toThrow("project_control_controller_scope_cas_mismatch");
    await expect(readCodexGoalJob({ registryRootDir, jobId: controllerJobId }))
      .resolves.toMatchObject({
        description: "newer concurrent update",
        projectAccessScope: { consumedOutputLedgerRoots: [oldRoot] },
      });
  });
});
