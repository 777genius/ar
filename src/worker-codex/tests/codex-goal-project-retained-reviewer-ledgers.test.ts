import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ProjectDebtReason,
  type ProjectAccessScope,
} from "@vioxen/subscription-runtime/worker-core";
import { buildCodexProjectAdmissionSnapshot } from "../application/project-control/codex-goal-project-admission";
import type { CodexGoalJobManifest } from "../codex-goal-jobs";

describe("Codex retained read-only reviewer terminal ledgers", () => {
  it("keeps shared-worktree review markers separate from terminal job ledgers", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-shared-review-admission-"));
    const sharedWorkspace = join(root, "worktrees", "project-producer-v1");
    const documentWorkspace = join(root, "worktrees", "project-document-navigation-h8");
    const ledgerRoot = join(root, "consumed-output");
    const backupRoot = join(root, "backups");
    const producerStatusPath = join(backupRoot, "producer.status.txt");
    const producerPatchPath = join(backupRoot, "producer.patch");
    const reviewerStatusPath = join(backupRoot, "reviewer.status.txt");
    const reviewerPatchPath = join(backupRoot, "reviewer.patch");
    const scope: ProjectAccessScope = {
      projectId: "project",
      worktreeRoots: [join(root, "worktrees")],
      consumedOutputLedgerRoots: [ledgerRoot],
      consumedOutputEvidenceRoots: [backupRoot],
      jobIdPrefixes: ["project-"],
    };

    try {
      await mkdir(sharedWorkspace, { recursive: true });
      await mkdir(documentWorkspace, { recursive: true });
      await mkdir(join(ledgerRoot, "items"), { recursive: true });
      await mkdir(backupRoot, { recursive: true });
      await writeFile(producerStatusPath, " M src/example.ts\n");
      await writeFile(producerPatchPath, "diff --git a/src/example.ts b/src/example.ts\n");
      await writeFile(reviewerStatusPath, "");
      await writeFile(reviewerPatchPath, "");
      await writeFile(
        join(ledgerRoot, "items", "project-producer-v1.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          note: "archived producer output",
          jobId: "project-producer-v1",
          status: "archived",
          closedAt: "2026-07-11T00:00:00.000Z",
          backup: {
            workspace: sharedWorkspace,
            statusPath: producerStatusPath,
            patchPath: producerPatchPath,
          },
        })}\n`,
      );
      await writeFile(
        join(ledgerRoot, "items", "project-reviewer-terminal-v1.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          note: "reviewed no change",
          jobId: "project-reviewer-terminal-v1",
          status: "reviewed_no_change",
          outcome: "reviewed_no_change",
          closedAt: "2026-07-11T00:02:00.000Z",
          backup: {
            workspace: sharedWorkspace,
            statusPath: reviewerStatusPath,
            patchPath: reviewerPatchPath,
          },
        })}\n`,
      );

      const summary = (jobId: string, workspacePath: string) => ({
        jobId,
        tags: ["worker-role-reviewer"],
        taskId: jobId,
        workspacePath,
        promptPath: join(root, `${jobId}.md`),
        accountNames: ["account-a"],
        updatedAt: "2026-07-11T00:03:00.000Z",
        manifestPath: join(root, `${jobId}.json`),
      });
      const snapshot = await buildCodexProjectAdmissionSnapshot({
        registryRootDir: join(root, "registry"),
        scope,
        deps: {
          listJobs: async () => [
            summary("project-producer-v1", sharedWorkspace),
            summary("project-reviewer-terminal-v1", sharedWorkspace),
            summary("project-reviewer-marker-v2", sharedWorkspace),
            summary("project-document-navigation-h8", documentWorkspace),
          ],
          readJob: async ({ jobId }): Promise<CodexGoalJobManifest> => ({
            ...summary(jobId, jobId === "project-document-navigation-h8"
              ? documentWorkspace : sharedWorkspace),
            schemaVersion: 1,
            createdAt: "2026-07-11T00:01:00.000Z",
            jobRootDir: join(root, jobId),
            accounts: ["account-a"],
            editMode: "read-only",
          }),
          buildOverviewItems: async (inputs) => inputs.map(({ jobId }) => ({
            ok: true,
            jobId,
            workspacePath: jobId === "project-document-navigation-h8"
              ? documentWorkspace
              : sharedWorkspace,
            workspaceDirty: true,
            workerAlive: false,
            resultExists: true,
            resultStatus: "completed",
            activeWriterRisk: "dirty_workspace_without_worker",
            recommendedAction: "review_completed",
            tags: ["worker-role-reviewer"],
            lifecycleMarkerTypes: ["review"],
          })),
        },
      });

      expect(snapshot.debt).not.toEqual(expect.arrayContaining([
        expect.objectContaining({
          reason: ProjectDebtReason.IncompleteConsumedOutputRecord,
        }),
      ]));
      expect(snapshot.debt.filter(
        (item) => item.reason === ProjectDebtReason.UnconsumedCompletedJob,
      )).toEqual([
        expect.objectContaining({ subject: documentWorkspace }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
