import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  ProjectAdmissionWorkerRole,
  ProjectDebtReason,
  ProjectOperation,
  type ProjectAdmissionSnapshot,
} from "@vioxen/subscription-runtime/worker-core";
import {
  codexProjectAdmissionGate,
  type CodexProjectAdmissionDeps,
} from "../application/project-control/codex-goal-project-admission";

const execFileAsync = promisify(execFile);
const CUSTODY_DRIFT = "ledger_epoch_proposed_admission_custody_drift";

describe("admitted input patch normalization ordering", () => {
  it("filters only the exact self orphan before normalization and custody", async () => {
    const root = await mkdtemp(join(tmpdir(), "admitted-patch-normalization-"));
    const worktreeRoot = join(root, "worktrees");
    const targetPath = join(worktreeRoot, "social-target");
    const unrelatedPath = join(worktreeRoot, "social-unrelated");
    const summaries = [] as const;
    let listJobsCalls = 0;
    try {
      await createDirtyGitWorkspace(targetPath);
      const deps: CodexProjectAdmissionDeps = {
        listJobs: async () => {
          listJobsCalls += 1;
          return summaries;
        },
        buildOverviewItems: async () => [],
        normalizeActiveProposedAdmission: async (_scope, snapshot, received) => {
          expect(received).toBe(summaries);
          assertNoOrphanDebt(snapshot);
          return snapshot;
        },
      };
      const gate = (jobId: string, workspacePath: string) =>
        codexProjectAdmissionGate({
          registryRootDir: join(root, "registry"),
          controllerJobId: "project-controller",
          scope: {
            projectId: "social-monitor",
            jobIdPrefixes: ["social-"],
            worktreeRoots: [worktreeRoot],
          },
          deps,
          admittedInputPatchTarget: {
            jobId: "social-target",
            workspacePath: targetPath,
          },
        }).evaluate({
          operation: ProjectOperation.CreateJob,
          jobId,
          workerRole: ProjectAdmissionWorkerRole.Producer,
          workspacePath,
        });

      await expect(gate("social-target", targetPath)).resolves.toMatchObject({
        allowed: true,
        debt: [],
      });
      expect(listJobsCalls).toBe(1);

      await expect(gate("social-wrong-job", targetPath)).rejects.toThrow(CUSTODY_DRIFT);
      await expect(gate("social-target", unrelatedPath)).rejects.toThrow(CUSTODY_DRIFT);

      await createDirtyGitWorkspace(unrelatedPath);
      await expect(gate("social-target", targetPath)).rejects.toThrow(CUSTODY_DRIFT);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps non-admitted normalization ahead of generic admission", async () => {
    const root = await mkdtemp(join(tmpdir(), "ordinary-normalization-order-"));
    const worktreeRoot = join(root, "worktrees");
    const workspacePath = join(worktreeRoot, "social-ordinary");
    let normalized = false;
    try {
      await createDirtyGitWorkspace(workspacePath);
      const gate = codexProjectAdmissionGate({
        registryRootDir: join(root, "registry"),
        controllerJobId: "project-controller",
        scope: {
          projectId: "social-monitor",
          jobIdPrefixes: ["social-"],
          worktreeRoots: [worktreeRoot],
        },
        deps: {
          listJobs: async () => [],
          buildOverviewItems: async () => [],
          normalizeActiveProposedAdmission: async (_scope, snapshot) => {
            normalized = true;
            assertNoOrphanDebt(snapshot);
            return snapshot;
          },
        },
      });

      await expect(gate.evaluate({
        operation: ProjectOperation.CreateJob,
        jobId: "social-ordinary",
        workerRole: ProjectAdmissionWorkerRole.Producer,
        workspacePath,
      })).rejects.toThrow(CUSTODY_DRIFT);
      expect(normalized).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function createDirtyGitWorkspace(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await execFileAsync("git", ["init", "--quiet"], { cwd: path });
  await writeFile(join(path, "reviewed.patch"), "reviewed input\n");
}

function assertNoOrphanDebt(snapshot: ProjectAdmissionSnapshot): void {
  if (snapshot.debt.some((item) =>
    item.reason === ProjectDebtReason.OrphanLegacyWorkspace
  )) throw new Error(CUSTODY_DRIFT);
}
