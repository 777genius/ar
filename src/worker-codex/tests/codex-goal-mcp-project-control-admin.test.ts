import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AccessBoundary, NetworkAccessMode } from "@vioxen/subscription-runtime/worker-core";
import {
  projectControlRepairLegacyOutputDebtView,
  resolveProjectControlRepairWorkspaceMode,
} from "../codex-goal-mcp-project-control-admin";
import type { CodexGoalJobManifest, CodexGoalJobSummary } from "../codex-goal-jobs";

describe("project-control manifest repair workspace mode", () => {
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
    const jobId = "project-worker-v16";
    const statusPath = join(backupRoot, "status.txt");
    const patchPath = join(backupRoot, "patch.diff");
    const ledgerPath = join(ledgerRoot, "items", `${jobId}.json`);
    try {
      await Promise.all([
        mkdir(registryRootDir, { recursive: true }),
        mkdir(join(ledgerRoot, "items"), { recursive: true }),
        mkdir(backupRoot, { recursive: true }),
        mkdir(jobRootDir, { recursive: true }),
      ]);
      await writeFile(statusPath, "?? old-output.txt\n");
      await writeFile(patchPath, "");
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
        },
      }));
      const scope = {
        projectId: "project",
        consumedOutputLedgerRoots: [ledgerRoot],
        jobIdPrefixes: ["project-"],
      };
      const manifest: CodexGoalJobManifest = {
        schemaVersion: 1,
        jobId,
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
        jobRootDir,
        workspacePath: join(root, "unrelated-current-manifest-workspace"),
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
      const preview = await projectControlRepairLegacyOutputDebtView({}, deps);
      expect(preview).toMatchObject({
        mode: "preview",
        eligibleCount: 1,
        quarantinedCount: 0,
      });
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
