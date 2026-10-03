import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  ProjectAdmissionWorkerRole,
  ProjectOperation,
  type ProjectAccessScope,
} from "@vioxen/subscription-runtime/worker-core";
import {
  buildCodexProjectAdmissionSnapshot,
  codexProjectAdmissionGate,
  type CodexProjectAdmissionDeps,
} from "../application/project-control/codex-goal-project-admission";

const execFileAsync = promisify(execFile);

describe("Codex project clean duplicate admission", () => {
  it("admits clean duplicate summaries only after each stopped job has no-output evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-clean-duplicate-admission-"));
    const workspacePath = join(root, "worktrees", "project-shared");
    const ledgerRoot = join(root, "consumed-output");
    const backupRoot = join(root, "backups");
    const jobIds = ["project-shared-1", "project-shared-2"] as const;
    const scope: ProjectAccessScope = {
      projectId: "project",
      worktreeRoots: [join(root, "worktrees")],
      consumedOutputLedgerRoots: [ledgerRoot],
      consumedOutputEvidenceRoots: [backupRoot],
      jobIdPrefixes: ["project-"],
    };
    let liveJobId: string | undefined;
    let dirtyJobId: string | undefined;
    let risk = "none";

    try {
      await mkdir(workspacePath, { recursive: true });
      await mkdir(join(ledgerRoot, "items"), { recursive: true });
      await mkdir(backupRoot, { recursive: true });
      const deps: CodexProjectAdmissionDeps = {
        listJobs: async () => jobIds.map((jobId) => ({
          jobId,
          tags: ["worker-role-producer"],
          taskId: jobId,
          workspacePath,
          promptPath: join(root, `${jobId}.md`),
          accountNames: ["account-a"],
          updatedAt: "2026-09-29T00:00:00.000Z",
          manifestPath: join(root, `${jobId}.json`),
        })),
        buildOverviewItems: async (inputs) => inputs.map(({ jobId }) => ({
          ok: true,
          jobId,
          workspacePath,
          workspaceDirty: dirtyJobId === jobId,
          workerAlive: liveJobId === jobId,
          activeWriterRisk: liveJobId === jobId ? "active_worker" : risk,
          activeWriterRiskReasons: [],
          tags: ["worker-role-producer"],
        })),
      };
      const snapshot = async () => await buildCodexProjectAdmissionSnapshot({
        registryRootDir: join(root, "registry"), scope, deps,
      });
      const conflictCount = async () => (await snapshot()).counts?.activeWriterConflicts ?? -1;
      const writeNoOutputRecord = async (jobId: string) => {
        const statusPath = join(backupRoot, `${jobId}.status.txt`);
        const patchPath = join(backupRoot, `${jobId}.patch`);
        await writeFile(statusPath, "");
        await writeFile(patchPath, "");
        await writeFile(join(ledgerRoot, "items", `${jobId}.json`), `${JSON.stringify({
          schemaVersion: 1,
          note: "stopped before producing output",
          jobId,
          status: "failed_no_output",
          closedAt: "2026-09-29T00:01:00.000Z",
          failure: { category: "infrastructure", code: "pre_start_failure" },
          output: { authoredChanges: false, workspaceDirty: false },
          backup: { workspace: workspacePath, statusPath, patchPath },
        })}\n`);
      };

      expect(await conflictCount()).toBe(2);
      await execFileAsync("git", ["init", "--quiet", workspacePath]);
      await writeNoOutputRecord(jobIds[0]);
      expect(await conflictCount()).toBe(1);
      await writeNoOutputRecord(jobIds[1]);
      expect(await conflictCount()).toBe(0);
      await expect(codexProjectAdmissionGate({
        registryRootDir: join(root, "registry"),
        controllerJobId: "project-controller",
        scope,
        deps,
      }).evaluate({
        operation: ProjectOperation.CreateJob,
        workerRole: ProjectAdmissionWorkerRole.Producer,
      })).resolves.toMatchObject({ allowed: true });

      liveJobId = jobIds[1];
      expect(await conflictCount()).toBeGreaterThan(0);
      liveJobId = undefined;
      dirtyJobId = jobIds[1];
      expect(await conflictCount()).toBeGreaterThan(0);
      dirtyJobId = undefined;
      risk = "state_mismatch";
      expect(await conflictCount()).toBeGreaterThan(0);
      risk = "none";
      const untrackedPath = join(workspacePath, "unexpected-output.txt");
      await writeFile(untrackedPath, "unexpected output\n");
      expect(await conflictCount()).toBe(2);
      await rm(untrackedPath);
      await rm(join(workspacePath, ".git"), { recursive: true, force: true });
      expect(await conflictCount()).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
