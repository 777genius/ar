import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  ProjectAdmissionWorkerRole,
  ProjectDebtReason,
  ProjectOperation,
} from "@vioxen/subscription-runtime/worker-core";
import { codexProjectAdmissionGate } from "../application/project-control/codex-goal-project-admission";
import { gitWorkspaceStatus } from "../codex-goal-status-files";

const execFileAsync = promisify(execFile);

describe("Codex project workspace history admission", () => {
  it.each(["done", "completed"])("admits the captured AR reviewer/reviewer shape with resultStatus %s", async (resultStatus) => {
    await withDuplicateAdmissionFixture(async ({ gate, historical, prepared, request }) => {
      prepared.resultExists = true;
      historical.resultStatus = resultStatus;
      prepared.resultStatus = resultStatus;
      prepared.progressStatus = "completed";
      prepared.tags = historical.tags;
      prepared.lifecycleMarkerTypes = ["review"];
      prepared.recommendedAction = "review_completed";
      await expect(gate.evaluate({
        ...request,
        jobId: "project-unrelated-producer",
        workspacePath: `${request.workspacePath}-unrelated`,
      })).resolves.toMatchObject({ allowed: true, debt: [] });
    });
  });

  it.each(["done", "completed"])("admits setup and start for the captured EF spike/prepared shape with resultStatus %s", async (resultStatus) => {
    await withDuplicateAdmissionFixture(async ({ gate, historical, request }) => {
      historical.resultStatus = resultStatus;
      historical.tags = ["worker-role-producer"];
      historical.lifecycleMarkerTypes = [];
      historical.recommendedAction = "review_completed";
      for (const operation of [ProjectOperation.StartWorker, ProjectOperation.CreateJob]) {
        await expect(gate.evaluate({ ...request, operation })).resolves.toMatchObject({
          allowed: true, debt: [],
        });
      }
    });
  });

  it.each([
    ["live stale done with otherwise clean overview", { workerAlive: true }],
    ["failed result", { resultStatus: "failed" }],
    ["blocked result", { resultStatus: "blocked" }],
    ["partial result", { resultStatus: "partial" }],
    ["canceled result", { resultStatus: "canceled" }],
    ["cancelled result", { resultStatus: "cancelled" }],
    ["aborted result", { resultStatus: "aborted" }],
    ["progress completion without successful result", { resultStatus: undefined }],
    ["live reviewer", { workerAlive: true, activeWriterRisk: "active_worker" }],
    ["live producer", { workerAlive: true, activeWriterRisk: "active_worker", tags: ["worker-role-producer"] }],
    ["missing liveness", { workerAlive: undefined }],
    ["unknown liveness", { workerAlive: "unknown" }],
    ["unreadable overview", { ok: false }],
    ["unreadable workspace status", { workspaceDirty: undefined }],
    ["dirty unconsumed output", { workspaceDirty: true, changedFiles: ["src/held.ts"], activeWriterRisk: "dirty_workspace_without_worker" }],
    ["dirty nonterminal output", { workspaceDirty: true, resultStatus: undefined, lifecycleMarkerTypes: [], recommendedAction: undefined }],
    ["unlaunched empty registration", { resultExists: false, resultStatus: undefined }],
    ["nonterminal empty registration", { resultStatus: "running" }],
    ["unknown result", { resultStatus: "unknown" }],
    ["missing result evidence", { resultExists: undefined }],
    ["absent completed result", { resultExists: false }],
    ["missing writer risk", { activeWriterRisk: undefined }],
    ["unknown writer risk", { activeWriterRisk: "unknown" }],
    ["independent state mismatch", { activeWriterRisk: "state_mismatch" }],
    ["independent workspace conflict", { workspaceConflict: true }],
  ] satisfies readonly (readonly [string, Record<string, unknown>])[])(
    "keeps duplicate participation fail-closed for %s",
    async (_name, overrides) => {
      await withDuplicateAdmissionFixture(async ({ gate, historical, request }) => {
        Object.assign(historical, overrides);
        const decision = await gate.evaluate(request);
        expect(decision.allowed).toBe(false);
        if ("ok" in overrides && overrides.ok === false) {
          expect(decision.debt).toEqual([expect.objectContaining({
            reason: ProjectDebtReason.UnreadableRoot,
            subject: "project-historical",
          })]);
          return;
        }
        expect(decision.debt).toEqual(expect.arrayContaining([
          expect.objectContaining({
            reason: ProjectDebtReason.ActiveWriterConflict,
            subject: "project-prepared",
            evidence: expect.arrayContaining([
              "workspace realpath is shared by multiple job summaries",
            ]),
          }),
        ]));
      });
    },
  );

  it.each(["non-Git directory", "missing workspace"])(
    "retains done duplicates for the actual failed Git projection: %s",
    async (kind) => {
      await withDuplicateAdmissionFixture(async ({ gate, historical, prepared, request }) => {
        await rm(join(request.workspacePath, ".git"), { recursive: true, force: true });
        if (kind === "missing workspace") await rm(request.workspacePath, { recursive: true });
        const status = await gitWorkspaceStatus(request.workspacePath);
        expect(status).toMatchObject({
          exists: kind !== "missing workspace", dirty: false, changedFiles: [],
          warning: expect.any(String),
        });
        // collect status/overview forwards dirty and changedFiles, but drops
        // existence and warnings; ok and terminal health can still be healthy.
        for (const item of [historical, prepared]) Object.assign(item, {
          ok: true, workspaceDirty: status.dirty,
          changedFiles: status.changedFiles, changedFilesCount: status.changedFiles!.length,
        });
        await expect(gate.evaluate(request)).resolves.toMatchObject({
          allowed: false,
          debt: expect.arrayContaining([expect.objectContaining({
            reason: ProjectDebtReason.ActiveWriterConflict, subject: "project-prepared",
          })]),
        });
      });
    },
  );

  it("retains done duplicates when fresh Git inspection contradicts a clean overview", async () => {
    await withDuplicateAdmissionFixture(async ({ gate, request }) => {
      await writeFile(join(request.workspacePath, "unconsumed.txt"), "held output");
      await expect(gate.evaluate(request)).resolves.toMatchObject({
        allowed: false,
        debt: expect.arrayContaining([expect.objectContaining({
          reason: ProjectDebtReason.ActiveWriterConflict, subject: "project-prepared",
        })]),
      });
    });
  });

  it("preserves independent writer risk after a historical duplicate is excluded", async () => {
    await withDuplicateAdmissionFixture(async ({ gate, prepared, request }) => {
      prepared.activeWriterRisk = "state_mismatch";
      const decision = await gate.evaluate(request);
      expect(decision.allowed).toBe(false);
      expect(decision.debt).toEqual([expect.objectContaining({
        reason: ProjectDebtReason.ActiveWriterConflict,
        subject: "project-prepared",
      })]);
      expect(decision.debt[0]!.evidence).not.toContain(
        "workspace realpath is shared by multiple job summaries",
      );
    });
  });

  it("still detects competing prepared jobs through symlink workspace aliases", async () => {
    await withDuplicateAdmissionFixture(async ({ gate, historical, prepared, request }) => {
      const alias = `${request.workspacePath}-alias`;
      await symlink(request.workspacePath, alias, "dir");
      prepared.workspacePath = alias;
      historical.resultExists = false;
      historical.resultStatus = undefined;
      await expect(gate.evaluate({ ...request, workspacePath: alias })).resolves.toMatchObject({
        allowed: false,
        debt: expect.arrayContaining([expect.objectContaining({
          reason: ProjectDebtReason.ActiveWriterConflict,
          evidence: expect.arrayContaining([
            "workspace realpath is shared by multiple job summaries",
          ]),
        })]),
      });
    });
  });

});

async function withDuplicateAdmissionFixture(
  run: (fixture: {
    gate: ReturnType<typeof codexProjectAdmissionGate>;
    historical: Record<string, unknown>;
    prepared: Record<string, unknown>;
    request: {
      operation: ProjectOperation;
      workerRole: ProjectAdmissionWorkerRole;
      jobId: string;
      workspacePath: string;
    };
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "subscription-runtime-duplicate-admission-"));
  const workspacePath = join(root, "shared");
  try {
    await mkdir(workspacePath);
    await execFileAsync("git", ["-C", workspacePath, "init", "--quiet"]);
    const historical: Record<string, unknown> = {
      ok: true, jobId: "project-historical", workspacePath,
      workspaceDirty: false, changedFiles: [], changedFilesCount: 0,
      workerAlive: false, activeWriterRisk: "none",
      // Captured actual-incident-overviews.json: result document done and
      // progress completed are distinct fields. Paths and IDs stay synthetic.
      resultExists: true, resultStatus: "done", progressStatus: "completed",
      tags: ["worker-role-reviewer"], lifecycleMarkerTypes: ["review"],
      recommendedAction: "review_completed",
    };
    const prepared: Record<string, unknown> = {
      ok: true, jobId: "project-prepared", workspacePath,
      workspaceDirty: false, changedFiles: [], changedFilesCount: 0,
      workerAlive: false, activeWriterRisk: "none", resultExists: false,
      tags: ["worker-role-producer"], lifecycleMarkerTypes: [],
    };
    const gate = codexProjectAdmissionGate({
      registryRootDir: join(root, "registry"),
      controllerJobId: "project-controller",
      scope: { projectId: "project", jobIdPrefixes: ["project-"] },
      deps: {
        listJobs: async () => [historical, prepared].map((item, index) => ({
          jobId: String(item.jobId), taskId: String(item.jobId),
          workspacePath: String(item.workspacePath), tags: item.tags as string[],
          promptPath: join(root, `${item.jobId}.md`), accountNames: ["synthetic"],
          updatedAt: `2026-09-13T00:0${index}:00.000Z`,
          manifestPath: join(root, `${item.jobId}.json`),
        })),
        buildOverviewItems: async () => [historical, prepared],
      },
    });
    await run({ gate, historical, prepared, request: {
      operation: ProjectOperation.StartWorker,
      workerRole: ProjectAdmissionWorkerRole.Producer,
      jobId: "project-prepared", workspacePath,
    } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
