import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
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
import { assertCodexGoalProjectJobNotTerminal } from "../application/project-control/codex-goal-consumed-output-ledger-io";

describe("Codex project admission snapshot", () => {
  it("admits fresh producers past pruned terminal archives but denies same-job rejected recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-retention-admission-"));
    const ledgerRoot = join(root, "control", "consumed-output-ledger");
    const workspacePath = join(root, "worktrees", "project-rejected-v1");
    const backup = {
      workspace: workspacePath,
      statusPath: join(root, "retained", "status.txt"),
      patchPath: join(root, "retained", "output.patch"),
      numstatPath: join(root, "retained", "numstat.txt"),
    };
    const scope: ProjectAccessScope = {
      projectId: "project",
      consumedOutputLedgerRoots: [ledgerRoot],
      consumedOutputEvidenceRoots: [join(root, "retained")],
      jobIdPrefixes: ["project-"],
    };
    const emptyDeps: CodexProjectAdmissionDeps = {
      listJobs: async () => [],
      buildOverviewItems: async () => [],
    };

    try {
      await mkdir(join(root, "retained"), { recursive: true });
      await mkdir(join(ledgerRoot, "items"), { recursive: true });
      await writeFile(
        join(ledgerRoot, "items", "project-integrated-v1.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          note: "integrated output",
          jobId: "project-integrated-v1",
          status: "integrated",
          closedAt: "2026-07-01T00:00:00.000Z",
          consumedAt: "2026-07-01T00:00:00.000Z",
          commitSha: "abc1234",
          commit: "abc1234",
          integratedCommitSha: "abc1234",
          notes: [{ status: "integrated", text: "integrated output", commit: "abc1234" }],
          backup: { ...backup, workspace: join(root, "worktrees", "project-integrated-v1") },
        })}\n`,
      );
      await writeFile(
        join(ledgerRoot, "items", "project-rejected-v1.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          note: "rejected output",
          jobId: "project-rejected-v1",
          status: "rejected",
          closedAt: "2026-07-01T00:00:00.000Z",
          consumedAt: "2026-07-01T00:00:00.000Z",
          notes: [{ status: "rejected", text: "rejected output" }],
          backup,
        })}\n`,
      );
      const snapshot = await buildCodexProjectAdmissionSnapshot({
        registryRootDir: join(root, "registry"),
        scope,
        deps: emptyDeps,
      });
      expect(snapshot.debt).toEqual([
        expect.objectContaining({
          reason: ProjectDebtReason.RetentionEvidenceMissing,
          severity: "info",
        }),
        expect.objectContaining({
          reason: ProjectDebtReason.RetentionEvidenceMissing,
          severity: "info",
        }),
      ]);
      expect(snapshot.counts).toMatchObject({
        incompleteConsumedOutputRecords: 0,
        retentionEvidenceMissing: 2,
      });
      await expect(codexProjectAdmissionGate({
        registryRootDir: join(root, "registry"),
        controllerJobId: "project-controller",
        scope,
        deps: emptyDeps,
      }).evaluate({
        operation: ProjectOperation.StartWorker,
        jobId: "project-fresh-v1",
        workerRole: ProjectAdmissionWorkerRole.Producer,
      })).resolves.toMatchObject({ allowed: true });

      await expect(assertCodexGoalProjectJobNotTerminal({
        roots: [ledgerRoot],
        evidenceRoots: scope.consumedOutputEvidenceRoots ?? [],
        projectId: "project",
        controllerJobId: "project-controller",
        jobId: "project-rejected-v1",
        taskId: "task-rejected-v1",
        workspacePath,
      })).rejects.toThrow(
        "project_control_terminal_job_start_denied:retention_evidence_missing",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps live dirty workspace debt blocking when terminal archive bytes were pruned", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-retention-dirty-"));
    const ledgerRoot = join(root, "control", "consumed-output-ledger");
    const workspacePath = join(root, "worktrees", "project-rejected-v1");
    const summary = {
      jobId: "project-rejected-v1",
      tags: ["worker-role-producer"],
      taskId: "task-rejected-v1",
      workspacePath,
      promptPath: join(root, "prompt.md"),
      accountNames: ["account-a"],
      updatedAt: "2026-07-01T00:00:00.000Z",
      manifestPath: join(root, "manifest.json"),
    };
    const newerSummary = {
      ...summary,
      jobId: "project-newer-v2",
      taskId: "task-newer-v2",
      workspacePath: join(root, "worktrees", "project-newer-v2"),
      updatedAt: "2026-07-02T00:00:00.000Z",
    };
    const previousLimit = process.env.SUBSCRIPTION_RUNTIME_PROJECT_ADMISSION_MAX_JOB_SUMMARIES;

    try {
      process.env.SUBSCRIPTION_RUNTIME_PROJECT_ADMISSION_MAX_JOB_SUMMARIES = "1";
      await mkdir(join(root, "retained"), { recursive: true });
      await mkdir(join(ledgerRoot, "items"), { recursive: true });
      await writeFile(
        join(ledgerRoot, "items", "project-rejected-v1.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          note: "rejected output",
          jobId: summary.jobId,
          status: "rejected",
          closedAt: "2026-07-01T00:00:00.000Z",
          consumedAt: "2026-07-01T00:00:00.000Z",
          notes: [{ status: "rejected", text: "rejected output" }],
          backup: {
            workspace: workspacePath,
            statusPath: join(root, "retained", "status.txt"),
            patchPath: join(root, "retained", "output.patch"),
          },
        })}\n`,
      );
      const snapshot = await buildCodexProjectAdmissionSnapshot({
        registryRootDir: join(root, "registry"),
        scope: {
          projectId: "project",
          consumedOutputLedgerRoots: [ledgerRoot],
          consumedOutputEvidenceRoots: [join(root, "retained")],
          jobIdPrefixes: ["project-"],
        },
        deps: {
          listJobs: async () => [summary, newerSummary],
          buildOverviewItems: async (inputs) => inputs.map(({ jobId }) =>
            jobId === summary.jobId
              ? {
                  ok: true,
                  jobId: summary.jobId,
                  workspacePath,
                  workspaceDirty: true,
                  workerAlive: true,
                  silentStale: true,
                  workerFreshProgressAlive: false,
                  activeWriterRisk: "stale_live_worker",
                  activeWriterRiskReasons: ["worker is live but stale"],
                }
              : {
                  ok: true,
                  jobId,
                  workspacePath: newerSummary.workspacePath,
                  workspaceDirty: false,
                  workerAlive: false,
                  activeWriterRisk: "none",
                }
          ),
        },
      });

      expect(snapshot.debt).toEqual(expect.arrayContaining([
        expect.objectContaining({
          reason: ProjectDebtReason.RetentionEvidenceMissing,
          severity: "info",
        }),
        expect.objectContaining({
          reason: ProjectDebtReason.ActiveWriterConflict,
          severity: "blocking",
        }),
        expect.objectContaining({
          reason: ProjectDebtReason.StaleDirtyWorker,
          severity: "blocking",
        }),
      ]));
    } finally {
      if (previousLimit === undefined) {
        delete process.env.SUBSCRIPTION_RUNTIME_PROJECT_ADMISSION_MAX_JOB_SUMMARIES;
      } else {
        process.env.SUBSCRIPTION_RUNTIME_PROJECT_ADMISSION_MAX_JOB_SUMMARIES = previousLimit;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps adapter storage errors blocking instead of classifying them as retention", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-retention-io-error-"));
    const ledgerRoot = join(root, "control", "consumed-output-ledger");
    const invalidParent = join(root, "retained-file");
    const scope: ProjectAccessScope = {
      projectId: "project",
      consumedOutputLedgerRoots: [ledgerRoot],
      consumedOutputEvidenceRoots: [root],
      jobIdPrefixes: ["project-"],
    };
    const deps: CodexProjectAdmissionDeps = {
      listJobs: async () => [],
      buildOverviewItems: async () => [],
    };

    try {
      await mkdir(join(ledgerRoot, "items"), { recursive: true });
      await writeFile(invalidParent, "not a directory\n");
      await writeFile(
        join(ledgerRoot, "items", "project-integrated-v1.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          note: "integrated output",
          jobId: "project-integrated-v1",
          status: "integrated",
          closedAt: "2026-07-01T00:00:00.000Z",
          commitSha: "abc1234",
          backup: {
            workspace: join(root, "worktrees", "project-integrated-v1"),
            statusPath: join(invalidParent, "status.txt"),
            patchPath: join(invalidParent, "output.patch"),
          },
        })}\n`,
      );

      const snapshot = await buildCodexProjectAdmissionSnapshot({
        registryRootDir: join(root, "registry"),
        scope,
        deps,
      });
      expect(snapshot.debt).toEqual([
        expect.objectContaining({
          reason: ProjectDebtReason.UnreadableRoot,
          severity: "blocking",
          evidence: expect.arrayContaining([
            expect.stringContaining("terminal consumed-output evidence unreadable"),
          ]),
        }),
      ]);
      expect(snapshot.debt).not.toEqual(expect.arrayContaining([
        expect.objectContaining({
          reason: ProjectDebtReason.RetentionEvidenceMissing,
        }),
      ]));
      await expect(codexProjectAdmissionGate({
        registryRootDir: join(root, "registry"),
        controllerJobId: "project-controller",
        scope,
        deps,
      }).evaluate({
        operation: ProjectOperation.StartWorker,
        workerRole: ProjectAdmissionWorkerRole.Producer,
      })).resolves.toMatchObject({ allowed: false });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks a missing evidence child whose nearest symlink ancestor escapes the evidence root", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-retention-symlink-root-"));
    const outsideRoot = await mkdtemp(
      join(tmpdir(), "subscription-runtime-retention-symlink-outside-"),
    );
    const ledgerRoot = join(root, "control", "consumed-output-ledger");
    const escapedBackupRoot = join(root, "escaped-backup");
    const scope: ProjectAccessScope = {
      projectId: "project",
      consumedOutputLedgerRoots: [ledgerRoot],
      consumedOutputEvidenceRoots: [root],
      jobIdPrefixes: ["project-"],
    };

    try {
      await mkdir(join(ledgerRoot, "items"), { recursive: true });
      await symlink(outsideRoot, escapedBackupRoot);
      await writeFile(
        join(ledgerRoot, "items", "project-integrated-v1.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          note: "integrated output",
          jobId: "project-integrated-v1",
          status: "integrated",
          closedAt: "2026-07-01T00:00:00.000Z",
          commitSha: "abc1234",
          backup: {
            workspace: join(root, "worktrees", "project-integrated-v1"),
            statusPath: join(escapedBackupRoot, "missing-status.txt"),
            patchPath: join(escapedBackupRoot, "missing-output.patch"),
          },
        })}\n`,
      );
      const snapshot = await buildCodexProjectAdmissionSnapshot({
        registryRootDir: join(root, "registry"),
        scope,
        deps: {
          listJobs: async () => [],
          buildOverviewItems: async () => [],
        },
      });

      expect(snapshot.debt).toEqual([
        expect.objectContaining({
          reason: ProjectDebtReason.UnreadableRoot,
          severity: "blocking",
          evidence: expect.arrayContaining([
            expect.stringContaining("consumed_output_evidence_path_outside_root"),
          ]),
        }),
      ]);
      expect(snapshot.debt).not.toEqual(expect.arrayContaining([
        expect.objectContaining({
          reason: ProjectDebtReason.RetentionEvidenceMissing,
        }),
      ]));
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(outsideRoot, { recursive: true, force: true }),
      ]);
    }
  });

  it("blocks a dangling evidence-file symlink whose target escapes the evidence root", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-retention-leaf-root-"));
    const outsideRoot = await mkdtemp(
      join(tmpdir(), "subscription-runtime-retention-leaf-outside-"),
    );
    const ledgerRoot = join(root, "control", "consumed-output-ledger");
    const backupRoot = join(root, "retained-backup");
    const statusPath = join(backupRoot, "status.txt");

    try {
      await mkdir(join(ledgerRoot, "items"), { recursive: true });
      await mkdir(backupRoot, { recursive: true });
      await symlink(join(outsideRoot, "missing-status.txt"), statusPath);
      await writeFile(
        join(ledgerRoot, "items", "project-integrated-v1.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          note: "integrated output",
          jobId: "project-integrated-v1",
          status: "integrated",
          closedAt: "2026-07-01T00:00:00.000Z",
          commitSha: "abc1234",
          backup: {
            workspace: join(root, "worktrees", "project-integrated-v1"),
            statusPath,
            patchPath: join(backupRoot, "missing-output.patch"),
          },
        })}\n`,
      );
      const snapshot = await buildCodexProjectAdmissionSnapshot({
        registryRootDir: join(root, "registry"),
        scope: {
          projectId: "project",
          consumedOutputLedgerRoots: [ledgerRoot],
          consumedOutputEvidenceRoots: [root],
          jobIdPrefixes: ["project-"],
        },
        deps: {
          listJobs: async () => [],
          buildOverviewItems: async () => [],
        },
      });

      expect(snapshot.debt).toEqual([
        expect.objectContaining({
          reason: ProjectDebtReason.UnreadableRoot,
          severity: "blocking",
          evidence: expect.arrayContaining([
            expect.stringContaining("consumed_output_evidence_path_outside_root"),
          ]),
        }),
      ]);
      expect(snapshot.debt).not.toEqual(expect.arrayContaining([
        expect.objectContaining({
          reason: ProjectDebtReason.RetentionEvidenceMissing,
        }),
      ]));
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(outsideRoot, { recursive: true, force: true }),
      ]);
    }
  });

  it("ignores shared-workspace writer conflicts only for stopped terminal-consumed jobs", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-consumed-shared-"));
    const ledgerRoot = join(root, "control", "consumed-output-ledger");
    const workspacePath = join(root, "worktrees", "shared-review");
    const stoppedJobIds = ["project-adoption-drain-v1", "project-adoption-drain-v2"];
    const liveJobId = "project-live-unconsumed-v3";
    const scope: ProjectAccessScope = {
      projectId: "project",
      consumedOutputLedgerRoots: [ledgerRoot],
      consumedOutputEvidenceRoots: [join(root, "retained")],
      jobIdPrefixes: ["project-"],
    };
    const summary = (jobId: string, updatedAt: string) => ({
      jobId,
      tags: ["worker-role-adoption"],
      taskId: jobId,
      workspacePath,
      promptPath: join(root, `${jobId}.md`),
      accountNames: ["account-a"],
      updatedAt,
      manifestPath: join(root, `${jobId}.json`),
    });
    const overview = (jobId: string) => jobId === liveJobId
      ? {
          ok: true,
          jobId,
          workspacePath,
          workspaceDirty: true,
          workerAlive: true,
          activeWriterRisk: "active_worker",
          activeWriterRiskReasons: ["worker process is alive"],
          workspaceConflict: true,
        }
      : {
          ok: true,
          jobId,
          workspacePath,
          workspaceDirty: true,
          workerAlive: false,
          activeWriterRisk: "dirty_workspace_without_worker",
          activeWriterRiskReasons: ["dirty workspace has no live worker"],
          workspaceConflict: true,
        };

    try {
      await mkdir(join(root, "retained"), { recursive: true });
      await mkdir(join(ledgerRoot, "items"), { recursive: true });
      for (const [index, jobId] of stoppedJobIds.entries()) {
        const backupRoot = join(root, "retained", jobId);
        const closedAt = `2026-07-0${index + 1}T00:00:00.000Z`;
        await writeFile(
          join(ledgerRoot, "items", `${jobId}.json`),
          `${JSON.stringify({
            schemaVersion: 1,
            note: "reviewed output consumed",
            jobId,
            status: "rejected",
            closedAt,
            consumedAt: closedAt,
            notes: [{ status: "rejected", text: "reviewed output consumed" }],
            backup: {
              workspace: workspacePath,
              statusPath: join(backupRoot, "missing-status.txt"),
              patchPath: join(backupRoot, "missing-output.patch"),
            },
          })}\n`,
        );
      }
      const stoppedSummaries = stoppedJobIds.map((jobId, index) =>
        summary(jobId, `2026-07-0${index + 1}T00:00:00.000Z`)
      );
      const stoppedDeps: CodexProjectAdmissionDeps = {
        listJobs: async () => stoppedSummaries,
        buildOverviewItems: async (inputs) => inputs.map(({ jobId }) => overview(jobId)),
      };
      const stopped = await buildCodexProjectAdmissionSnapshot({
        registryRootDir: join(root, "registry"),
        scope,
        deps: stoppedDeps,
      });

      expect(stopped.debt).toHaveLength(2);
      expect(stopped.debt).toEqual(expect.arrayContaining([
        expect.objectContaining({
          reason: ProjectDebtReason.RetentionEvidenceMissing,
          severity: "info",
        }),
      ]));
      expect(stopped.debt).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ reason: ProjectDebtReason.ActiveWriterConflict }),
      ]));
      await expect(codexProjectAdmissionGate({
        registryRootDir: join(root, "registry"),
        controllerJobId: "project-controller",
        scope,
        deps: stoppedDeps,
      }).evaluate({
        operation: ProjectOperation.StartWorker,
        jobId: "project-fresh-v4",
        workerRole: ProjectAdmissionWorkerRole.Producer,
      })).resolves.toMatchObject({ allowed: true });

      const withLive = await buildCodexProjectAdmissionSnapshot({
        registryRootDir: join(root, "registry"),
        scope,
        deps: {
          listJobs: async () => [
            ...stoppedSummaries,
            summary(liveJobId, "2026-07-03T00:00:00.000Z"),
          ],
          buildOverviewItems: async (inputs) =>
            inputs.map(({ jobId }) => overview(jobId)),
        },
      });
      expect(withLive.debt).toEqual(expect.arrayContaining([
        expect.objectContaining({
          reason: ProjectDebtReason.ActiveWriterConflict,
          subject: liveJobId,
          severity: "blocking",
        }),
      ]));

      for (const activeWriterRisk of [undefined, null, false, 0, ""]) {
        const malformedStoppedObservation =
          await buildCodexProjectAdmissionSnapshot({
            registryRootDir: join(root, "registry"),
            scope,
            deps: {
              listJobs: async () => stoppedSummaries.slice(0, 1),
              buildOverviewItems: async () => [{
                ok: true,
                jobId: stoppedJobIds[0],
                workspacePath,
                workspaceDirty: true,
                workspaceConflict: false,
                activeWriterRisk,
              }],
            },
          });
        expect(malformedStoppedObservation.debt).toEqual(expect.arrayContaining([
          expect.objectContaining({
            reason: ProjectDebtReason.ActiveWriterConflict,
            subject: stoppedJobIds[0],
            severity: "blocking",
          }),
        ]));
      }

      const mismatchedWorkspaceObservation =
        await buildCodexProjectAdmissionSnapshot({
          registryRootDir: join(root, "registry"),
          scope,
          deps: {
            listJobs: async () => stoppedSummaries.slice(0, 1),
            buildOverviewItems: async () => [{
              ok: true,
              jobId: stoppedJobIds[0],
              workspacePath: join(root, "worktrees", "different-review"),
              workspaceDirty: true,
              workerAlive: false,
              activeWriterRisk: "none",
              workspaceConflict: false,
            }],
          },
        });
      expect(mismatchedWorkspaceObservation.debt).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            reason: ProjectDebtReason.ActiveWriterConflict,
            subject: stoppedJobIds[0],
            severity: "blocking",
          }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("routes absent-registry legacy failed_no_output debt to retention without weakening current registry gates", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-legacy-ledger-admission-"));
    const ledgerRoot = join(root, "consumed-output");
    const backupRoot = join(root, "backups", "project-legacy-worker-v1");
    const statusPath = join(backupRoot, "git-status.txt");
    const patchPath = join(backupRoot, "worker-output.patch");
    const workspacePath = join(root, "missing-worktrees", "project-legacy-worker-v1");
    const previousLimit = process.env.SUBSCRIPTION_RUNTIME_PROJECT_ADMISSION_MAX_JOB_SUMMARIES;
    const scope: ProjectAccessScope = {
      projectId: "project",
      consumedOutputLedgerRoots: [ledgerRoot],
      consumedOutputEvidenceRoots: [join(root, "backups")],
      jobIdPrefixes: ["project-"],
    };
    const summary = (jobId: string, updatedAt: string) => ({
      jobId,
      tags: ["worker-role-producer"],
      taskId: jobId,
      workspacePath: join(root, "worktrees", jobId),
      promptPath: join(root, `${jobId}.md`),
      accountNames: ["account-a"],
      updatedAt,
      manifestPath: join(root, `${jobId}.json`),
    });

    try {
      await mkdir(join(ledgerRoot, "items"), { recursive: true });
      await mkdir(backupRoot, { recursive: true });
      await writeFile(statusPath, "?? docs/legacy-output/\n");
      await writeFile(patchPath, "");
      await writeFile(
        join(ledgerRoot, "items", "project-legacy-worker-v1.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          jobId: "project-legacy-worker-v1",
          status: "failed_no_output",
          closedAt: "2026-07-12T00:00:00.000Z",
          failure: { category: "infrastructure", code: "legacy_failure" },
          output: { authoredChanges: false, workspaceDirty: false },
          note: "Legacy archive lost untracked payload evidence.",
          backup: { workspace: workspacePath, statusPath, patchPath },
        })}\n`,
      );
      const deps = (jobs: readonly ReturnType<typeof summary>[]): CodexProjectAdmissionDeps => ({
        listJobs: async () => jobs,
        buildOverviewItems: async (inputs) => inputs.map(({ jobId }) => ({
          ok: true,
          jobId,
          workspacePath: join(root, "worktrees", jobId),
          workspaceDirty: false,
          workerAlive: false,
        })),
      });

      const absent = await buildCodexProjectAdmissionSnapshot({
        registryRootDir: join(root, "registry"),
        scope,
        deps: deps([]),
      });
      expect(absent.debt).toEqual([
        expect.objectContaining({
          reason: ProjectDebtReason.LegacyOutputQuarantineRequired,
          severity: "info",
          evidence: expect.arrayContaining([
            expect.stringContaining("retention-owned immutable capture/quarantine"),
          ]),
        }),
      ]);
      expect(absent.counts).toMatchObject({
        incompleteConsumedOutputRecords: 0,
        legacyOutputQuarantineRequired: 1,
      });
      await expect(codexProjectAdmissionGate({
        registryRootDir: join(root, "registry"),
        controllerJobId: "project-controller",
        scope,
        deps: deps([]),
      }).evaluate({
        operation: ProjectOperation.StartWorker,
        workerRole: ProjectAdmissionWorkerRole.Producer,
      })).resolves.toMatchObject({ allowed: true });

      process.env.SUBSCRIPTION_RUNTIME_PROJECT_ADMISSION_MAX_JOB_SUMMARIES = "1";
      const current = await buildCodexProjectAdmissionSnapshot({
        registryRootDir: join(root, "registry"),
        scope,
        deps: deps([
          summary("project-legacy-worker-v1", "2026-07-12T00:01:00.000Z"),
          summary("project-newer-worker-v2", "2026-07-12T00:02:00.000Z"),
        ]),
      });
      expect(current.debt).toEqual(expect.arrayContaining([
        expect.objectContaining({
          reason: ProjectDebtReason.IncompleteConsumedOutputRecord,
          severity: "blocking",
        }),
      ]));
      expect(current.counts).toMatchObject({
        incompleteConsumedOutputRecords: 1,
        legacyOutputQuarantineRequired: 0,
      });
    } finally {
      if (previousLimit === undefined) {
        delete process.env.SUBSCRIPTION_RUNTIME_PROJECT_ADMISSION_MAX_JOB_SUMMARIES;
      } else {
        process.env.SUBSCRIPTION_RUNTIME_PROJECT_ADMISSION_MAX_JOB_SUMMARIES = previousLimit;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

});
