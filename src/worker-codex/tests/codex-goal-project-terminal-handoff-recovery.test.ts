import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  ProjectAdmissionWorkerRole,
  type ProjectControlBroker,
  type ProjectAccessScope,
} from "@vioxen/subscription-runtime/worker-core";

import { materializeCodexGoalHandoffArtifacts } from "../codex-goal-handoff-artifacts";
import type { CodexGoalJobManifest } from "../codex-goal-jobs";
import {
  terminalHandoffDependencyRecoveryRequested,
  verifyTerminalHandoffRecovery,
} from "../application/project-control/codex-goal-project-terminal-handoff-recovery";
import { localReviewedWorkerOutputDeps } from "../reviewed-worker-output";
import { projectControlStartStoredJobView } from "../codex-goal-mcp-project-control-actions";
import { createCodexProjectControlBroker } from "../codex-goal-mcp-project-broker";
import { recordRejectedUncapturedOutput } from "../codex-goal-mcp-project-control-reviewed-rejection";
import {
  assertCodexGoalProjectJobNotTerminal,
  readCodexGoalConsumedOutputLedgers,
} from "../application/project-control/codex-goal-consumed-output-ledger-io";
import {
  assertProjectControlEvidenceRootsCanonical,
  assertProjectControlScopeRepairAllowed,
} from "../codex-goal-mcp-project-scope";
import { git, gitInitRepository } from "./codex-goal-mcp-test-support";
import {
  assertTerminalRecoveryAdmission as assertTerminalAdmission,
  recoveryActionFixture,
  recoveryFixture,
  verifyActionFixture,
  writeRecoveryReviewMarker as writeReviewMarker,
  writeRejectedUncapturedReview,
  writeTerminalResult,
} from "./codex-goal-project-terminal-handoff-recovery-test-support";
import { localProjectControlEvidenceCustodySupported } from
  "../../worker-local/project-control-evidence-custody-local-adapter";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe.runIf(localProjectControlEvidenceCustodySupported)(
  "terminal worker handoff dependency recovery",
  () => {
  it("requires the complete explicit dependency-recovery intent", () => {
    const request = {
      status: {
        workspaceDirty: true,
        resultExists: true,
        resultStatus: "done",
        recommendedAction: "review_completed",
      },
      forceStart: true,
      dependencyBootstrap: "install",
      confirmDependencyBootstrap: true,
    } as const;
    expect(terminalHandoffDependencyRecoveryRequested(request)).toBe(true);
    for (const invalid of [
      { ...request, status: { ...request.status, workspaceDirty: false } },
      { ...request, reviewedOutputId: "a".repeat(64) },
      { ...request, forceStart: false },
      { ...request, dependencyBootstrap: "preflight" },
      { ...request, confirmDependencyBootstrap: false },
      { ...request, status: { ...request.status, resultExists: false } },
      { ...request, status: { ...request.status, resultStatus: "failed" } },
      {
        ...request,
        status: {
          ...request.status,
          recommendedAction: "inspect_dirty_workspace" as const,
        },
      },
    ]) {
      expect(terminalHandoffDependencyRecoveryRequested(invalid)).toBe(false);
    }
  });

  it.runIf(localProjectControlEvidenceCustodySupported)(
    "writes and reads rejected output after an evidence-root repair",
    async () => {
    const root = await realpath(await mkdtemp(
      join(tmpdir(), "subscription-runtime-repaired-evidence-root-"),
    ));
    roots.push(root);
    const workspacePath = join(root, "workspace");
    const jobRootDir = join(root, "jobs", "project-worker");
    const ledgerRoot = join(root, "custody", "consumed-output-ledger");
    const historicalEvidenceRoot = join(root, "custody-v1", "archives");
    const activeEvidenceRoot = join(root, "custody-v2", "archives");
    await Promise.all([
      workspacePath,
      jobRootDir,
      join(ledgerRoot, "items"),
      historicalEvidenceRoot,
      activeEvidenceRoot,
    ].map((path) => mkdir(path, { recursive: true })));
    await gitInitRepository(workspacePath);
    await writeFile(join(workspacePath, "owned.ts"), "export const value = 1;\n");
    await git(workspacePath, ["add", "owned.ts"]);
    await git(workspacePath, ["commit", "-m", "test: base"]);
    await writeFile(join(workspacePath, "owned.ts"), "export const value = 2;\n");
    const existingScope: ProjectAccessScope = {
      projectId: "project",
      readRoots: [root],
      workspaceRoots: [root],
      consumedOutputLedgerRoots: [ledgerRoot],
      consumedOutputEvidenceRoots: [historicalEvidenceRoot],
    };
    const repairedScope: ProjectAccessScope = {
      ...existingScope,
      consumedOutputEvidenceRoots: [historicalEvidenceRoot, activeEvidenceRoot],
    };
    assertProjectControlScopeRepairAllowed({
      existing: existingScope,
      proposed: repairedScope,
    });
    await assertProjectControlEvidenceRootsCanonical(
      repairedScope.consumedOutputEvidenceRoots ?? [],
      repairedScope,
    );

    const receipt = await recordRejectedUncapturedOutput({
      scope: repairedScope,
      jobId: "project-worker",
      jobRootDir,
      workspacePath,
      closedAt: "2026-07-21T00:00:00.000Z",
      reason: "Rejected after evidence-root repair.",
    });
    const decision = JSON.parse(await readFile(receipt.ledgerPath, "utf8"));
    expect(decision.archivePath.startsWith(`${activeEvidenceRoot}/`)).toBe(true);
    const ledger = await readCodexGoalConsumedOutputLedgers({
      roots: [ledgerRoot],
      evidenceRoots: repairedScope.consumedOutputEvidenceRoots ?? [],
    });
    expect(ledger.byJobId.get("project-worker")).toMatchObject({ valid: true });
    expect(ledger.debt).toEqual([]);
    },
  );

  it("permits only the exact runtime-captured dirty workspace", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "subscription-runtime-terminal-recovery-"),
    );
    roots.push(root);
    const workspacePath = join(root, "workspace");
    const jobRootDir = join(root, "job");
    const jobId = "project-worker";
    await Promise.all([
      mkdir(workspacePath, { recursive: true }),
      mkdir(jobRootDir, { recursive: true }),
    ]);
    await gitInitRepository(workspacePath);
    await writeFile(
      join(workspacePath, "owned.ts"),
      "export const value = 1;\n",
    );
    await git(workspacePath, ["add", "owned.ts"]);
    await git(workspacePath, ["commit", "-m", "test: base"]);
    await writeFile(
      join(workspacePath, "owned.ts"),
      "export const value = 2;\n",
    );

    const handoff = await materializeCodexGoalHandoffArtifacts({
      workerJobId: jobId,
      taskId: jobId,
      workspacePath,
      jobRootDir,
    });
    expect(handoff).not.toBeNull();
    await writeTerminalResult(jobRootDir, jobId, handoff!);
    const producer = {
      jobId,
      taskId: jobId,
      workspacePath,
      jobRootDir,
    } as CodexGoalJobManifest;
    const snapshotter = localReviewedWorkerOutputDeps({
      rootDir: join(root, "reviewed-output"),
    }).snapshotter;

    await expect(
      verifyTerminalHandoffRecovery({
        producer,
        workspacePath,
        snapshotter,
      }),
    ).resolves.toMatchObject({
      patchSha256: handoff!.manifest.artifacts.patch.sha256,
      baseCommit: handoff!.baseCommit,
      changedFiles: ["owned.ts"],
    });

    await writeFile(
      join(workspacePath, "owned.ts"),
      "export const value = 3;\n",
    );
    await expect(
      verifyTerminalHandoffRecovery({
        producer,
        workspacePath,
        snapshotter,
      }),
    ).rejects.toThrow(
      "project_control_terminal_handoff_workspace_changed_after_capture",
    );
  });

  it("pins the pre-bootstrap handoff and rejects reviewed output", async () => {
    const fixture = await recoveryFixture(roots);
    const before = await verifyTerminalHandoffRecovery(fixture.verifyInput);
    await writeFile(
      join(fixture.workspacePath, "owned.ts"),
      "export const value = 3;\n",
    );
    const next = await materializeCodexGoalHandoffArtifacts({
      workerJobId: fixture.jobId,
      taskId: fixture.jobId,
      workspacePath: fixture.workspacePath,
      jobRootDir: fixture.jobRootDir,
    });
    if (!next) throw new Error("expected next handoff");
    await writeTerminalResult(fixture.jobRootDir, fixture.jobId, next);
    await expect(
      verifyTerminalHandoffRecovery({
        ...fixture.verifyInput,
        expected: before,
      }),
    ).rejects.toThrow(
      "project_control_terminal_handoff_changed_during_dependency_bootstrap",
    );

    await writeFile(
      join(fixture.jobRootDir, `${fixture.jobId}.review.json`),
      '{"reviewedAt":"2026-07-14T00:00:00.000Z","decision":"rejected"}\n',
    );
    await expect(
      verifyTerminalHandoffRecovery(fixture.verifyInput),
    ).rejects.toThrow("project_control_terminal_handoff_already_reviewed");
  });

  it("permits same-job start only with the exact rejected uncaptured patch", async () => {
    const fixture = await actionFixture();
    const receipt = await writeRejectedUncapturedReview(fixture);
    const verified = await verifyActionFixture(fixture);
    expect(verified).toMatchObject({
      reviewDisposition: "rejected_uncaptured",
      patchSha256: receipt.decision.attemptId?.replace(
        "uncaptured-rejection-",
        "",
      ),
    });

    let startCalled = false;
    const started = await projectControlStartStoredJobView(
      fixture.startArgs,
      {
        ...fixture.deps(async () => {}),
        codexProjectControlBroker: (input) => ({
          startWorker: async () => {
            startCalled = true;
            const recovery =
              input.rejectedUncapturedTerminalHandoffRecovery;
            expect(
              recovery,
            ).toEqual({ patchSha256: verified.patchSha256 });
            if (!recovery) throw new Error("expected rejected recovery");
            await assertCodexGoalProjectJobNotTerminal({
              roots: input.scope.consumedOutputLedgerRoots ?? [],
              evidenceRoots: input.scope.consumedOutputEvidenceRoots ?? [],
              projectId: input.scope.projectId,
              controllerJobId: input.controller.jobId,
              jobId: fixture.jobId,
              taskId: fixture.jobId,
              workspacePath: fixture.workspacePath,
              rejectedUncapturedContinuationPatchSha256:
                recovery.patchSha256,
            });
            return { status: "started" };
          },
        }) as unknown as ProjectControlBroker,
      },
    );
    expect(started).toMatchObject({ ok: true, jobId: fixture.jobId });
    expect(startCalled).toBe(true);
  });

  it("uses controller custody roots for a legacy producer without project scope", async () => {
    const fixture = await actionFixture({ producerHasProjectScope: false });
    await writeRejectedUncapturedReview(fixture);
    let startCalled = false;

    const started = await projectControlStartStoredJobView(
      fixture.startArgs,
      {
        ...fixture.deps(async () => {}),
        codexProjectControlBroker: (input) => ({
          startWorker: async () => {
            startCalled = true;
            expect(input.scope.consumedOutputLedgerRoots).toEqual([
              fixture.ledgerRoot,
            ]);
            expect(input.scope.consumedOutputEvidenceRoots).toEqual([
              fixture.evidenceRoot,
            ]);
            return { status: "started" };
          },
        }) as unknown as ProjectControlBroker,
      },
    );

    expect(started).toMatchObject({ ok: true, jobId: fixture.jobId });
    expect(startCalled).toBe(true);
  });

  it("falls back to producer custody roots when controller roots are omitted", async () => {
    const fixture = await actionFixture({
      controllerHasEvidenceRoots: false,
      controllerHasLedgerRoots: false,
    });
    await writeRejectedUncapturedReview(fixture);
    let startCalled = false;

    const started = await projectControlStartStoredJobView(
      fixture.startArgs,
      {
        ...fixture.deps(async () => {}),
        codexProjectControlBroker: (input) => ({
          startWorker: async () => {
            startCalled = true;
            const recovery = input.rejectedUncapturedTerminalHandoffRecovery;
            expect(input.scope.consumedOutputLedgerRoots).toEqual([
              fixture.ledgerRoot,
            ]);
            expect(input.scope.consumedOutputEvidenceRoots).toEqual([
              fixture.evidenceRoot,
            ]);
            if (!recovery) throw new Error("expected rejected recovery");
            await assertCodexGoalProjectJobNotTerminal({
              roots: input.scope.consumedOutputLedgerRoots ?? [],
              evidenceRoots: input.scope.consumedOutputEvidenceRoots ?? [],
              projectId: input.scope.projectId,
              controllerJobId: input.controller.jobId,
              jobId: fixture.jobId,
              taskId: fixture.jobId,
              workspacePath: fixture.workspacePath,
              rejectedUncapturedContinuationPatchSha256:
                recovery.patchSha256,
            });
            return { status: "started" };
          },
        }) as unknown as ProjectControlBroker,
      },
    );

    expect(started).toMatchObject({ ok: true, jobId: fixture.jobId });
    expect(startCalled).toBe(true);
  });

  it("rechecks producer ledger roots at final admission when controller roots are omitted", async () => {
    const fixture = await actionFixture({ controllerHasLedgerRoots: false });
    let admissionCalled = false;

    await expect(
      projectControlStartStoredJobView(fixture.startArgs, {
        ...fixture.deps(async () => {}),
        codexProjectControlBroker: (input) => {
          const broker = createCodexProjectControlBroker({
            ...input,
            admissionDeps: {
              listJobs: async () => [],
              buildOverviewItems: async () => [],
            },
          });
          return {
            startWorker: async (
              startInput: Parameters<ProjectControlBroker["startWorker"]>[0],
            ) => {
              admissionCalled = true;
              expect(input.scope.consumedOutputLedgerRoots).toEqual([
                fixture.ledgerRoot,
              ]);
              await recordRejectedUncapturedOutput({
                scope: fixture.scope,
                jobId: fixture.jobId,
                jobRootDir: fixture.jobRootDir,
                workspacePath: fixture.workspacePath,
                closedAt: "2026-07-21T00:00:00.000Z",
                reason: "Concurrent terminal decision before final admission.",
              });
              return await broker.startWorker(startInput);
            },
          } as unknown as ProjectControlBroker;
        },
      }),
    ).rejects.toThrow("project_control_terminal_job_start_denied");
    expect(admissionCalled).toBe(true);
  });

  it("keeps an explicit empty controller ledger root set authoritative", async () => {
    const fixture = await actionFixture({ controllerHasEmptyLedgerRoots: true });
    await writeRejectedUncapturedReview(fixture);
    let brokerCreated = false;

    await expect(
      projectControlStartStoredJobView(fixture.startArgs, {
        ...fixture.deps(async () => {}),
        codexProjectControlBroker: () => {
          brokerCreated = true;
          throw new Error("unexpected broker start");
        },
      }),
    ).rejects.toThrow("project_control_terminal_handoff_already_reviewed");
    expect(brokerCreated).toBe(false);
  });

  it("keeps an explicit empty controller evidence root set authoritative", async () => {
    const fixture = await actionFixture({
      controllerHasEmptyEvidenceRoots: true,
    });
    await writeRejectedUncapturedReview(fixture);
    let brokerCreated = false;

    await expect(
      projectControlStartStoredJobView(fixture.startArgs, {
        ...fixture.deps(async () => {}),
        codexProjectControlBroker: () => {
          brokerCreated = true;
          throw new Error("unexpected broker start");
        },
      }),
    ).rejects.toThrow("project_control_terminal_handoff_already_reviewed");
    expect(brokerCreated).toBe(false);
  });

  it("uses a controller-appended active evidence root over producer history", async () => {
    const fixture = await actionFixture({ controllerAppendsEvidenceRoot: true });
    await writeRejectedUncapturedReview(fixture, fixture.controllerScope);
    let startCalled = false;

    const started = await projectControlStartStoredJobView(
      fixture.startArgs,
      {
        ...fixture.deps(async () => {}),
        codexProjectControlBroker: (input) => ({
          startWorker: async () => {
            startCalled = true;
            expect(input.scope.consumedOutputEvidenceRoots).toEqual([
              fixture.evidenceRoot,
              fixture.activeEvidenceRoot,
            ]);
            return { status: "started" };
          },
        }) as unknown as ProjectControlBroker,
      },
    );

    expect(started).toMatchObject({ ok: true, jobId: fixture.jobId });
    expect(startCalled).toBe(true);
  });

  it("rechecks a controller-appended evidence root at final admission", async () => {
    const fixture = await actionFixture({ controllerAppendsEvidenceRoot: true });
    let admissionCalled = false;

    await expect(
      projectControlStartStoredJobView(fixture.startArgs, {
        ...fixture.deps(async () => {}),
        codexProjectControlBroker: (input) => {
          const broker = createCodexProjectControlBroker({
            ...input,
            admissionDeps: {
              listJobs: async () => [],
              buildOverviewItems: async () => [],
            },
          });
          return {
            startWorker: async (
              startInput: Parameters<ProjectControlBroker["startWorker"]>[0],
            ) => {
              admissionCalled = true;
              expect(input.scope.consumedOutputEvidenceRoots).toEqual([
                fixture.evidenceRoot,
                fixture.activeEvidenceRoot,
              ]);
              await recordRejectedUncapturedOutput({
                scope: fixture.controllerScope,
                jobId: fixture.jobId,
                jobRootDir: fixture.jobRootDir,
                workspacePath: fixture.workspacePath,
                closedAt: "2026-07-21T00:00:00.000Z",
                reason: "Concurrent terminal decision in the active evidence root.",
              });
              return await broker.startWorker(startInput);
            },
          } as unknown as ProjectControlBroker;
        },
      }),
    ).rejects.toThrow("project_control_terminal_job_start_denied");
    expect(admissionCalled).toBe(true);
  });

  it("rejects archive tamper at recovery and terminal admission", async () => {
    const fixture = await actionFixture();
    const receipt = await writeRejectedUncapturedReview(fixture);
    const verified = await verifyActionFixture(fixture);
    await writeFile(
      receipt.decision.backup.patchPath!,
      `${await readFile(receipt.decision.backup.patchPath!, "utf8")}tampered\n`,
    );
    await expect(
      verifyActionFixture(fixture),
    ).rejects.toThrow("project_control_terminal_handoff_already_reviewed");
    await expect(
      assertTerminalAdmission(fixture, verified.patchSha256),
    ).rejects.toThrow(
      "project_control_terminal_job_start_denied:rejected_evidence_mismatch",
    );
  });

  it("rejects an unexpected rejected patch identity at terminal admission", async () => {
    const fixture = await actionFixture();
    await writeRejectedUncapturedReview(fixture);
    await expect(
      assertTerminalAdmission(fixture, "f".repeat(64)),
    ).rejects.toThrow(
      "project_control_terminal_job_start_denied:rejected_evidence_mismatch",
    );
  });

  it.each([
    "malformed",
    "semantic-invalid",
    "invalid-date",
    "unknown-status",
    "missing-status",
    "null-status",
    "empty-status",
    "missing-job-id",
    "wrong-job-id",
    "symlink",
  ])(
    "rejects relevant %s newer ledger evidence",
    async (kind) => {
      const fixture = await actionFixture();
      const receipt = await writeRejectedUncapturedReview(fixture);
      const items = join(fixture.ledgerRoot, "items");
      const path = join(items, `${fixture.jobId}--zz-newer.json`);
      if (kind === "malformed") {
        await writeFile(path, "{not-json\n");
      } else if (kind === "semantic-invalid") {
        await writeFile(path, `${JSON.stringify({
          schemaVersion: 1,
          jobId: fixture.jobId,
          attemptId: "newer-ambiguous",
          status: "rejected",
          note: "Missing backup evidence.",
        })}\n`);
      } else if (kind === "unknown-status") {
        await writeFile(path, `${JSON.stringify({
          jobId: fixture.jobId,
          status: "unknown",
        })}\n`);
      } else if (kind === "invalid-date") {
        const value = JSON.parse(await readFile(receipt.ledgerPath, "utf8"));
        await writeFile(path, `${JSON.stringify({
          ...value,
          attemptId: "newer-invalid-date",
          closedAt: "not-a-date",
        })}\n`);
      } else if (
        kind === "missing-status" ||
        kind === "null-status" ||
        kind === "empty-status"
      ) {
        await writeFile(path, `${JSON.stringify({
          jobId: fixture.jobId,
          ...(kind === "missing-status"
            ? {}
            : { status: kind === "null-status" ? null : "" }),
        })}\n`);
      } else if (kind === "missing-job-id" || kind === "wrong-job-id") {
        await writeFile(path, `${JSON.stringify({
          schemaVersion: 1,
          ...(kind === "wrong-job-id" ? { jobId: "project-other" } : {}),
          status: "rejected",
          closedAt: "2027-01-01T00:00:00.000Z",
        })}\n`);
      } else {
        await symlink("missing-ledger-target", path);
      }
      await expect(
        verifyActionFixture(fixture),
      ).rejects.toThrow("project_control_terminal_handoff_already_reviewed");
    },
  );

  it("rejects rejected ledger evidence when its review marker is missing", async () => {
    const fixture = await actionFixture();
    await recordRejectedUncapturedOutput({
      scope: fixture.scope,
      jobId: fixture.jobId,
      jobRootDir: fixture.jobRootDir,
      workspacePath: fixture.workspacePath,
      closedAt: "2026-07-21T00:00:00.000Z",
      reason: "Marker intentionally absent.",
    });
    let bootstrapCalled = false;
    await expect(
      projectControlStartStoredJobView(
        fixture.startArgs,
        fixture.deps(async () => {
          bootstrapCalled = true;
        }),
      ),
    ).rejects.toThrow("project_control_terminal_handoff_already_reviewed");
    expect(bootstrapCalled).toBe(false);
  });

  it.each([
    "malformed",
    "unknown-status",
    "missing-status",
    "null-status",
    "empty-status",
    "symlink",
  ])(
    "rejects marker-missing target-prefixed %s debt before bootstrap",
    async (kind) => {
      const fixture = await actionFixture();
      const items = join(fixture.ledgerRoot, "items");
      const path = join(items, `${fixture.jobId}--zz.json`);
      await mkdir(items, { recursive: true });
      if (kind === "malformed") {
        await writeFile(path, "{not-json\n");
      } else if (kind === "unknown-status") {
        await writeFile(path, `${JSON.stringify({
          jobId: fixture.jobId,
          status: "unknown",
        })}\n`);
      } else if (
        kind === "missing-status" ||
        kind === "null-status" ||
        kind === "empty-status"
      ) {
        await writeFile(path, `${JSON.stringify({
          jobId: fixture.jobId,
          ...(kind === "missing-status"
            ? {}
            : { status: kind === "null-status" ? null : "" }),
        })}\n`);
      } else {
        await symlink("missing-ledger-target", path);
      }
      let bootstrapCalled = false;
      await expect(
        projectControlStartStoredJobView(
          fixture.startArgs,
          fixture.deps(async () => {
            bootstrapCalled = true;
          }),
        ),
      ).rejects.toThrow("project_control_terminal_handoff_already_reviewed");
      expect(bootstrapCalled).toBe(false);
    },
  );

  it("rejects a configured missing ledger items directory before bootstrap", async () => {
    const fixture = await actionFixture();
    await rm(join(fixture.ledgerRoot, "items"), { recursive: true });
    let bootstrapCalled = false;
    await expect(
      projectControlStartStoredJobView(
        fixture.startArgs,
        fixture.deps(async () => {
          bootstrapCalled = true;
        }),
      ),
    ).rejects.toThrow("project_control_terminal_handoff_already_reviewed");
    expect(bootstrapCalled).toBe(false);
  });

  it.each([0, 2])(
    "rejects rejected recovery with %i consumed-output ledger roots",
    async (rootCount) => {
      const fixture = await actionFixture();
      await writeRejectedUncapturedReview(fixture);
      const roots = rootCount === 0
        ? []
        : [fixture.ledgerRoot, join(fixture.registryRootDir, "other-ledger")];
      await expect(
        verifyActionFixture(fixture, roots),
      ).rejects.toThrow("project_control_terminal_handoff_already_reviewed");
    },
  );

  it.each(["approved", "rejected"])(
    "rejects captured %s review marker despite uncaptured ledger evidence",
    async (decision) => {
      const fixture = await actionFixture();
      await writeRejectedUncapturedReview(fixture);
      await writeReviewMarker(fixture, {
        reviewedOutput: { decision, reviewedOutputId: "a".repeat(64) },
      });
      await expect(
        verifyActionFixture(fixture),
      ).rejects.toThrow("project_control_terminal_handoff_already_reviewed");
    },
  );

  it("holds the project start lock across dependency bootstrap verification", async () => {
    const fixture = await actionFixture();
    await expect(
      projectControlStartStoredJobView(
        fixture.startArgs,
        fixture.deps(async () => {
          await writeFile(
            join(fixture.workspacePath, "owned.ts"),
            "export const value = 3;\n",
          );
          const next = await materializeCodexGoalHandoffArtifacts({
            workerJobId: fixture.jobId,
            taskId: fixture.jobId,
            workspacePath: fixture.workspacePath,
            jobRootDir: fixture.jobRootDir,
          });
          if (!next) throw new Error("expected next handoff");
          await writeTerminalResult(fixture.jobRootDir, fixture.jobId, next);
        }),
      ),
    ).rejects.toThrow(
      "project_control_terminal_handoff_changed_during_dependency_bootstrap",
    );
  });

  it("routes an exact terminal handoff recovery to a scoped alternative account", async () => {
    const fixture = await actionFixture();
    let brokerLaunchAccounts: readonly string[] = [];
    let brokerStartAccounts: readonly string[] = [];
    let brokerWorkerRole:
      Parameters<ProjectControlBroker["startWorker"]>[0]["workerRole"];
    let brokerMaxAccountCycles: number | undefined;
    const started = await projectControlStartStoredJobView(
      {
        ...fixture.startArgs,
        continuationAccounts: ["account-b"],
      },
      {
        ...fixture.deps(async () => {}),
        listAccountStatuses: async () => [{
          name: "account-b",
          authJsonPath: "/auth/account-b/auth.json",
          status: "ready",
          availability: "available",
          schedulerEligible: true,
          recommendedAction: "none",
          warnings: [],
          safeMessage: "ready",
        }],
        codexProjectControlBroker: (input) => {
          brokerLaunchAccounts =
            input.startLaunch?.config.accounts.map((account) => account.name) ??
              [];
          brokerMaxAccountCycles =
            input.startLaunch?.config.maxAccountCycles;
          return {
            startWorker: async (
              request: Parameters<ProjectControlBroker["startWorker"]>[0],
            ) => {
              brokerStartAccounts = request.accounts ?? [];
              brokerWorkerRole = request.workerRole;
              return { status: "started" };
            },
          } as unknown as ProjectControlBroker;
        },
      },
    );

    expect(started).toMatchObject({
      ok: true,
      accountReservation: {
        mode: "shared",
        accountId: "account-b",
      },
    });
    expect(brokerLaunchAccounts).toEqual(["account-b"]);
    expect(brokerStartAccounts).toEqual(["account-b"]);
    expect(brokerWorkerRole).toBe(ProjectAdmissionWorkerRole.Adoption);
    expect(brokerMaxAccountCycles).toBe(1);
  });

  it.each(["approved", "rejected"])(
    "rejects a %s review marker before dependency bootstrap",
    async (decision) => {
      const fixture = await actionFixture();
      await writeFile(
        join(fixture.jobRootDir, `${fixture.jobId}.review.json`),
        `${JSON.stringify({ reviewedAt: new Date().toISOString(), decision })}\n`,
      );
      let bootstrapCalled = false;
      await expect(
        projectControlStartStoredJobView(
          fixture.startArgs,
          fixture.deps(async () => {
            bootstrapCalled = true;
          }),
        ),
      ).rejects.toThrow("project_control_terminal_handoff_already_reviewed");
      expect(bootstrapCalled).toBe(false);
    },
  );
});

async function actionFixture(
  options: Parameters<typeof recoveryActionFixture>[1] = {},
) {
  return await recoveryActionFixture(roots, options);
}
