import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AccessBoundary, NetworkAccessMode } from "@vioxen/subscription-runtime/worker-core";
import {
  assertStaleReconciliationPlanOwned,
  projectControlRepairLegacyOutputDebtView,
  resolveProjectControlRepairWorkspaceMode,
  staleReconciliationControllerScopeEpoch,
} from "../codex-goal-mcp-project-control-admin";
import type {
  StaleIntegrationReconciliationPlan,
} from "../application/project-control/codex-goal-stale-integration-reconciliation";
import { projectControlWorkspaceLocks } from "../codex-goal-project-workspace-lock";
import type { CodexGoalJobManifest, CodexGoalJobSummary } from "../codex-goal-jobs";

describe("project-control manifest repair workspace mode", () => {
  it("rebinds a persisted stale-reconciliation plan to the exact controller epoch", () => {
    const registryRootDir = "/tmp/stale-scope/registry";
    const workspacePath = "/tmp/stale-scope/workspace";
    const jobRootDir = "/tmp/stale-scope/controller";
    const scope = {
      projectId: "social-monitor",
      workspaceRoots: [workspacePath],
      worktreeRoots: [],
      deniedRoots: ["/tmp/stale-scope/denied"],
      allowedGitRemotes: ["origin"],
      allowedBranches: ["main"],
    };
    const controller: CodexGoalJobManifest = {
      schemaVersion: 1,
      jobId: "social-monitor-controller-v4",
      createdAt: "2026-08-08T00:00:00.000Z",
      updatedAt: "2026-08-08T00:00:01.000Z",
      jobRootDir,
      workspacePath,
      promptPath: `${jobRootDir}/prompt.md`,
      taskId: "social-monitor-controller-v4",
      accounts: ["account-d"],
      projectAccessScope: scope,
      accessBoundary: AccessBoundary.ProjectScopedControl,
    };
    const plan: StaleIntegrationReconciliationPlan = {
      schemaVersion: 1,
      controllerJobId: controller.jobId,
      projectId: scope.projectId,
      registryRootDir,
      controllerJobRootDir: jobRootDir,
      controllerManifestSha256: createHash("sha256")
        .update(JSON.stringify(controller)).digest("hex"),
      controllerScopeEpochSha256: staleReconciliationControllerScopeEpoch({
        registryRootDir,
        controller,
        scope,
      }),
      gitBinaryPath: "/usr/bin/git",
      targetWorkspaceRoots: [workspacePath],
      deniedRoots: [...scope.deniedRoots],
      allowedGitRemotes: [...scope.allowedGitRemotes],
      allowedBranches: [...scope.allowedBranches],
      entries: [],
      planSha256: "b".repeat(64),
    };
    const loaded = { registryRootDir, controller, scope };
    expect(() => assertStaleReconciliationPlanOwned({ plan, loaded }))
      .not.toThrow();
    expect(() => assertStaleReconciliationPlanOwned({
      plan,
      loaded: {
        ...loaded,
        controller: { ...controller, updatedAt: "2026-08-08T00:00:02.000Z" },
      },
    })).toThrow("stale_integration_reconciliation_controller_scope_drift");
    expect(() => assertStaleReconciliationPlanOwned({
      plan,
      loaded: { ...loaded, scope: { ...scope, allowedGitRemotes: ["upstream"] } },
    })).toThrow("stale_integration_reconciliation_controller_scope_drift");
  });

  it("prefers an exact reviewed snapshot over stale admitted-patch quota classification", () => {
    expect(
      resolveProjectControlRepairWorkspaceMode({
        workspaceDirty: true,
        reviewedOutputId: "a".repeat(64),
        admittedInputPatchCapacityContinuation: true,
      }),
    ).toBe("reviewed_dirty_continuation");
  });

  it("preserves admitted-input and clean continuation modes without a reviewed snapshot", () => {
    expect(
      resolveProjectControlRepairWorkspaceMode({
        workspaceDirty: true,
        admittedInputPatchCapacityContinuation: true,
      }),
    ).toBe("admitted_input_patch_continuation");
    expect(
      resolveProjectControlRepairWorkspaceMode({
        workspaceDirty: false,
        admittedInputPatchCapacityContinuation: false,
      }),
    ).toBe("clean_capacity_continuation");
  });

  it("bulk repairs historical records that still have current registry manifests", async () => {
    const root = await mkdtemp(join(tmpdir(), "current-registry-legacy-repair-"));
    const registryRootDir = join(root, "registry");
    const ledgerRoot = join(root, "ledger");
    const backupRoot = join(root, "backup");
    const jobRootDir = join(root, "job");
    const currentWorkspace = join(root, "current-workspace");
    const jobId = "project-worker-v16";
    const statusPath = join(backupRoot, "status.txt");
    const patchPath = join(backupRoot, "patch.diff");
    const numstatPath = join(backupRoot, "patch.numstat");
    const untrackedArchivePath = join(backupRoot, "untracked.tar");
    const ledgerPath = join(ledgerRoot, "items", `${jobId}.json`);
    try {
      await Promise.all([
        mkdir(registryRootDir, { recursive: true }),
        mkdir(join(ledgerRoot, "items"), { recursive: true }),
        mkdir(backupRoot, { recursive: true }),
        mkdir(jobRootDir, { recursive: true }),
        mkdir(currentWorkspace, { recursive: true }),
      ]);
      await writeFile(statusPath, "?? old-output.txt\n");
      await writeFile(patchPath, "");
      await writeFile(numstatPath, "");
      await writeFile(untrackedArchivePath, "");
      await writeFile(ledgerPath, JSON.stringify({
        schemaVersion: 1,
        jobId,
        status: "failed_no_output",
        closedAt: "2025-01-01T00:00:00.000Z",
        failure: { category: "infrastructure", code: "legacy" },
        output: { authoredChanges: false, workspaceDirty: false },
        note: "historical pre-retention record",
        backup: {
          workspace: join(root, "removed-workspace"),
          statusPath,
          patchPath,
          numstatPath,
          untrackedArchivePath,
        },
      }));
      const scope = {
        projectId: "project",
        consumedOutputLedgerRoots: [ledgerRoot],
        jobIdPrefixes: ["project-"],
        workspaceRoots: [root],
      };
      const manifest: CodexGoalJobManifest = {
        schemaVersion: 1,
        jobId,
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
        jobRootDir,
        workspacePath: currentWorkspace,
        promptPath: join(jobRootDir, "prompt.md"),
        taskId: jobId,
        accounts: ["account-a"],
        accessBoundary: AccessBoundary.IsolatedWorkspaceWrite,
        projectAccessScope: scope,
      };
      const controller: CodexGoalJobManifest = {
        ...manifest,
        jobId: "project-controller",
        taskId: "project-controller",
        accessBoundary: AccessBoundary.ProjectScopedControl,
        networkAccess: NetworkAccessMode.Restricted,
      };
      const summary: CodexGoalJobSummary = {
        jobId,
        tags: [],
        taskId: jobId,
        workspacePath: manifest.workspacePath,
        promptPath: manifest.promptPath,
        accountNames: manifest.accounts,
        updatedAt: manifest.updatedAt,
        manifestPath: join(registryRootDir, jobId, "job.json"),
      };
      const deps = {
        loadProjectControlController: async () => ({
          registryRootDir,
          controller,
          scope,
        }),
        admissionDeps: {
          listJobs: async () => [summary],
          buildOverviewItems: async () => [{
            ok: true,
            jobId,
            workspacePath: manifest.workspacePath,
            workspaceDirty: false,
            workerAlive: false,
          }],
          readJob: async () => manifest,
        },
      };
      const crossProject = await projectControlRepairLegacyOutputDebtView({}, {
        ...deps,
        admissionDeps: {
          ...deps.admissionDeps,
          readJob: async () => ({
            ...manifest,
            projectAccessScope: {
              ...scope,
              projectId: "project-overlapping-prefix-but-different-owner",
            },
          }),
        },
      });
      expect(crossProject).toMatchObject({
        eligibleCount: 0,
        refusedCount: 1,
      });
      const preview = await projectControlRepairLegacyOutputDebtView({}, deps);
      expect(preview).toMatchObject({
        mode: "preview",
        eligibleCount: 1,
        quarantinedCount: 0,
      });
      const workspaceLocks = projectControlWorkspaceLocks(registryRootDir);
      const competingLease = await workspaceLocks.acquire({
        workspacePath: await realpath(currentWorkspace),
        owner: "concurrent-evidence-writer",
      });
      try {
        await expect(projectControlRepairLegacyOutputDebtView({
          confirmLegacyOutputRepair: true,
        }, deps)).rejects.toMatchObject({ code: "safe_execution_workspace_locked" });
        await expect(access(ledgerPath)).resolves.toBeUndefined();
      } finally {
        await workspaceLocks.release(competingLease);
      }
      const confirmed = await projectControlRepairLegacyOutputDebtView({
        confirmLegacyOutputRepair: true,
      }, deps);
      expect(confirmed).toMatchObject({
        mode: "confirmed",
        eligibleCount: 1,
        quarantinedCount: 1,
        admissionAfter: { incompleteConsumedOutputRecords: 0 },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
