import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ProjectAdmissionWorkerRole,
  ProjectDebtReason,
  ProjectOperation,
  type ProjectAccessScope,
} from "@vioxen/subscription-runtime/worker-core";
import {
  buildCodexProjectAdmissionSnapshot,
  codexProjectAdmissionGate,
  type CodexProjectAdmissionDeps,
} from "../application/project-control/codex-goal-project-admission";
import type { CodexGoalJobManifest } from "../codex-goal-jobs";

describe("Codex retained read-only reviewer admission", () => {
  it.each([
    "retained review", "retained dirty risk", "retained no marker", "retained completed result", "live", "unknown risk", "state mismatch",
    "explicit conflict", "allow edits", "invalid retention", "missing result",
    "missing liveness", "mixed role", "missing result status",
    "summary mixed role", "overview mixed role", "manifest job mismatch",
    "manifest workspace mismatch", "summary workspace mismatch", "missing manifest", "failed result",
  ].flatMap((scenario) => [
    { scenario, dirtyRisk: false, laterRetention: false },
    { scenario, dirtyRisk: true, laterRetention: false },
    { scenario, dirtyRisk: false, laterRetention: true },
    { scenario, dirtyRisk: true, laterRetention: true },
  ]))("handles shared retained read-only reviewers: $scenario, dirty risk=$dirtyRisk, later retention=$laterRetention", async ({ scenario, dirtyRisk, laterRetention }) => {
    // Regression: duplicate realpaths must not turn two completed read-only
    // reviews of already retained producer output into active writers.
    // Every rejection also uses the legacy dirty-risk exit: clearing that
    // conflict after the strict retained-review check fails admits a writer.
    const root = await mkdtemp(join(tmpdir(), "pr209-TEST-retained-review-"));
    const workspacePath = join(root, "worktrees", "project-producer");
    const ledgerRoot = join(root, "consumed-output");
    const backupRoot = join(root, "backups");
    const statusPath = join(backupRoot, "producer.status.txt");
    const patchPath = join(backupRoot, "producer.patch");
    const ledgerPath = join(ledgerRoot, "items", "project-producer.json");
    const scope: ProjectAccessScope = {
      projectId: "project",
      worktreeRoots: [join(root, "worktrees")],
      consumedOutputLedgerRoots: [ledgerRoot],
      consumedOutputEvidenceRoots: [backupRoot],
      jobIdPrefixes: ["project-"],
    };
    try {
      await mkdir(workspacePath, { recursive: true });
      await mkdir(join(ledgerRoot, "items"), { recursive: true });
      await mkdir(backupRoot, { recursive: true });
      await writeFile(statusPath, " M src/example.ts\n");
      await writeFile(patchPath, scenario === "invalid retention"
        ? ""
        : "diff --git a/src/example.ts b/src/example.ts\n");
      const ledgerBody = `${JSON.stringify({
        schemaVersion: 1, note: "retained rejected producer output",
        jobId: "project-producer", status: "rejected",
        closedAt: laterRetention ? "2026-07-11T00:05:00.000Z" : "2026-07-11T00:00:00.000Z",
        backup: { workspace: workspacePath, statusPath, patchPath },
      })}\n`;
      await writeFile(ledgerPath, ledgerBody);
      const summary = (jobId: string) => ({
        jobId, tags: jobId === "project-producer"
          ? ["worker-role-producer"]
          : scenario === "summary mixed role"
          ? ["worker-role-reviewer", "worker-role-producer"]
          : ["worker-role-reviewer"],
        taskId: jobId, workspacePath: scenario === "summary workspace mismatch" && jobId !== "project-producer"
          ? join(root, "worktrees", "other") : workspacePath, promptPath: join(root, `${jobId}.md`),
        accountNames: ["account-a"], updatedAt: laterRetention && jobId === "project-producer"
          ? "2026-07-11T00:04:00.000Z" : "2026-07-11T00:03:00.000Z",
        manifestPath: join(root, `${jobId}.json`),
      });
      const deps: CodexProjectAdmissionDeps = {
        listJobs: async () => [
          summary("project-producer"), summary("project-reviewer-a"),
          summary("project-reviewer-b"),
        ],
        readJob: async ({ jobId }): Promise<CodexGoalJobManifest> => {
          if (scenario === "missing manifest") throw new Error("synthetic missing manifest");
          return {
            ...summary(jobId), schemaVersion: 1,
            jobId: scenario === "manifest job mismatch" ? "project-other" : jobId,
            workspacePath: scenario === "manifest workspace mismatch"
              ? join(root, "worktrees", "other") : workspacePath,
            createdAt: "2026-07-11T00:01:00.000Z",
            jobRootDir: join(root, jobId), accounts: ["account-a"],
            editMode: scenario === "allow edits" ? "allow-edits" : "read-only",
            tags: scenario === "mixed role"
              ? ["worker-role-reviewer", "worker-role-producer"]
              : ["worker-role-reviewer"],
          };
        },
        buildOverviewItems: async (inputs) => inputs.map(({ jobId }) => ({
          ok: true, jobId, workspacePath, workspaceDirty: true,
          workerAlive: scenario === "live" ? true
            : scenario === "missing liveness" ? undefined : false,
          resultExists: scenario !== "missing result",
          resultStatus: scenario === "missing result" || scenario === "missing result status"
            ? undefined : scenario === "failed result" ? "failed"
            : scenario === "retained completed result" ? "completed" : "done",
          recommendedAction: "review_completed",
          tags: scenario === "overview mixed role"
            ? ["worker-role-reviewer", "worker-role-producer"]
            : ["worker-role-reviewer"],
          lifecycleMarkerTypes: scenario === "retained no marker" ? [] : ["review"],
          activeWriterRisk: scenario === "live" ? "active_worker"
            : scenario === "unknown risk" ? "unknown"
            : scenario === "state mismatch" ? "state_mismatch"
            : dirtyRisk || scenario === "retained dirty risk" ? "dirty_workspace_without_worker"
            : "none",
          workspaceConflict: scenario === "explicit conflict",
          changedFiles: ["src/example.ts"],
        })),
      };
      const admissionInput = {
        registryRootDir: join(root, "registry"), controllerJobId: "project-controller", scope, deps,
      };
      const gate = codexProjectAdmissionGate(admissionInput);
      const decision = await gate.evaluate({
        operation: ProjectOperation.CreateJob, jobId: "project-next",
        workerRole: ProjectAdmissionWorkerRole.Producer,
        ownedPaths: ["src/next/"],
        workspacePath: join(root, "worktrees", "project-next"),
      });
      const retainedReview = scenario.startsWith("retained ");
      expect(decision.allowed).toBe(retainedReview);
      if (retainedReview) {
        expect(decision.debt.filter((item) =>
          item.reason === ProjectDebtReason.ActiveWriterConflict ||
          item.reason === ProjectDebtReason.UnconsumedCompletedJob
        )).toEqual([]);
        const snapshot = await buildCodexProjectAdmissionSnapshot(admissionInput);
        expect(snapshot.debt).toEqual(expect.arrayContaining([
          expect.objectContaining({
            reason: ProjectDebtReason.ConsumedDirtyWorkspace, subject: workspacePath,
          }),
        ]));
      } else {
        expect(decision.debt).toEqual(expect.arrayContaining([
          expect.objectContaining({
            reason: ProjectDebtReason.ActiveWriterConflict, severity: "blocking",
            subject: "project-reviewer-a",
          }),
        ]));
      }
      expect(await readFile(ledgerPath, "utf8")).toBe(ledgerBody);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
