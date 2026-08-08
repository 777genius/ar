import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  IntegrationAttemptStatus,
  ReviewDecisionStatus,
  openIntegrationAttempt,
  type IntegrationAttempt,
} from "@vioxen/subscription-runtime/worker-core";
import { LocalIntegrationAttemptStore } from
  "@vioxen/subscription-runtime/store-local-file";
import {
  applyStaleIntegrationReconciliation as applyStaleIntegrationReconciliationRaw,
  previewStaleIntegrationReconciliationPlan,
} from "../application/project-control/codex-goal-stale-integration-reconciliation";
import {
  applyLegacyAttemptQuarantine,
  previewLegacyAttemptQuarantinePlan,
  readActiveLegacyAttemptQuarantine,
} from "../application/project-control/codex-goal-legacy-attempt-quarantine";
import { codexGoalJobManifestPath } from "../codex-goal-jobs";
import {
  buildLiveLegacyAttemptQuarantineEpochAnchor,
  readStableLegacyAttemptQuarantine,
} from
  "../application/project-control/codex-goal-legacy-attempt-quarantine-anchor";
import {
  LocalReviewedWorkerOutputStore,
  reviewedWorkerOutputFormat,
  reviewedWorkerOutputIdentityPayload,
  reviewedWorkerOutputRoot,
} from "../reviewed-worker-output";
import {
  commitCandidate,
  failedCheckRun,
  historicalAttemptAtStatus,
  passedCheckRun,
} from "./codex-goal-stale-integration-reconciliation-test-support";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

type ApplyInput = Parameters<typeof applyStaleIntegrationReconciliationRaw>[0];

async function applyStaleIntegrationReconciliation(
  input: Omit<ApplyInput, "runAfterControllerScopeRevalidation"> &
    Partial<Pick<ApplyInput, "runAfterControllerScopeRevalidation">>,
) {
  return await applyStaleIntegrationReconciliationRaw({
    runAfterControllerScopeRevalidation: async (effect) => await effect(),
    ...input,
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) =>
    await rm(root, { recursive: true, force: true })
  ));
});

describe("stale integration reconciliation", () => {
  it("binds automatically reconcilable entries without claiming lifecycle mutation", async () => {
    const fixture = await reconciliationFixture({
      incorporated: false,
      incidentEnvelope: true,
    });
    const sourcePlan = await previewStaleIntegrationReconciliationPlan(fixture.scope);
    expect(sourcePlan.entries.filter((entry) => entry.eligible)).toHaveLength(2);
    const plan = await previewLegacyAttemptQuarantinePlan({
      ...fixture.scope,
      sourceStaleIntegrationPlanSha256: sourcePlan.planSha256,
      cutoff: "2026-08-08T00:02:00.000Z",
      now: () => new Date("2026-08-10T00:02:00.000Z"),
      captureProcessEvidence: async (custodyPaths) => ({
        schemaVersion: 1,
        observedAt: "2026-08-08T00:01:00.000Z",
        inspectedPidCount: 0,
        inventorySha256: "b".repeat(64),
        custodyPaths,
        blockers: [],
      }),
    });
    expect(plan.entries.find((entry) => entry.reconciliation.eligible)).toMatchObject({
      disposition: "reconciliation_evidence_bound",
    });
    expect(plan.entries.find((entry) => entry.reconciliation.eligible))
      .not.toHaveProperty("refusalReason");
  });

  it("immutably quarantines an exact refused source plan without terminalizing attempts", async () => {
    const fixture = await reconciliationFixture({
      incorporated: false,
      incidentEnvelope: true,
    });
    await writeFile(join(fixture.targetPath, "legacy-dirty.txt"), "legacy\n");
    await writeFile(fixture.eventsPath, "{}\n");
    const sourcePlan = await previewStaleIntegrationReconciliationPlan(fixture.scope);
    expect(sourcePlan.entries.find((entry) =>
      entry.attemptId === fixture.attemptId
    )).toMatchObject({
      eligible: false,
      refusalReason: "target_workspace_dirty",
    });
    const before = await readFile(fixture.attemptPath);
    const captureProcessEvidence = async (custodyPaths: readonly string[]) => ({
      schemaVersion: 1 as const,
      observedAt: "2026-08-08T00:01:00.000Z",
      inspectedPidCount: 3,
      inventorySha256: "c".repeat(64),
      custodyPaths,
      blockers: [],
    });
    const plan = await previewLegacyAttemptQuarantinePlan({
      ...fixture.scope,
      sourceStaleIntegrationPlanSha256: sourcePlan.planSha256,
      cutoff: "2026-08-08T00:02:00.000Z",
      now: () => new Date("2026-08-10T00:02:00.000Z"),
      captureProcessEvidence,
    });
    expect(plan.entries.find((entry) => entry.attemptId === fixture.attemptId))
      .toMatchObject({
      disposition: "unresolved_evidence_quarantine",
      rejectOutcomeNotClaimed: true,
      attemptSha256: createHash("sha256").update(before).digest("hex"),
      targetGit: {
        state: "observed",
        remoteName: "origin",
      },
      workerLifecycle: {
        state: "terminal_result",
        terminalResultClaimed: true,
        resultStatus: "done",
      },
      });
    const receipt = await applyLegacyAttemptQuarantine({
      controllerJobRootDir: fixture.controllerJobRootDir,
      expectedPlanSha256: plan.planSha256,
      captureProcessEvidence,
      runAfterControllerScopeRevalidation: async (_persisted, effect) => await effect(),
    });
    expect(receipt).toMatchObject({
      status: "active_quarantine",
      sourceMutation: false,
      lifecycleTerminalized: false,
      rollbackClaimed: false,
      ledgerConsumptionClaimed: false,
      rejectOutcomeNotClaimed: true,
      terminalForLedgerEpochOnly: true,
      idempotentReplay: false,
    });
    expect(await readFile(fixture.attemptPath)).toEqual(before);
    expect((await fixture.store.get(fixture.attemptId))?.status).toBe(
      IntegrationAttemptStatus.Opened,
    );
    const active = await readActiveLegacyAttemptQuarantine(
      fixture.controllerJobRootDir,
    );
    expect([...active.attemptIds].sort()).toEqual([...fixture.attemptIds].sort());
    expect(active.debt.find((entry) =>
      entry.attemptId === fixture.attemptId
    )).toMatchObject({
      disposition: "unresolved_evidence_quarantine",
      refusalReason: "target_workspace_dirty",
    });
    await expect(applyLegacyAttemptQuarantine({
      controllerJobRootDir: fixture.controllerJobRootDir,
      expectedPlanSha256: plan.planSha256,
      captureProcessEvidence,
      runAfterControllerScopeRevalidation: async (_persisted, effect) => await effect(),
    })).resolves.toMatchObject({ idempotentReplay: true });
    await writeFile(join(fixture.targetPath, "legacy-dirty-2.txt"), "changed\n");
    await expect(readActiveLegacyAttemptQuarantine(
      fixture.controllerJobRootDir,
    )).rejects.toThrow("legacy_attempt_quarantine_binding_drift");
  });

  it("invalidates quarantine when original attempt bytes drift", async () => {
    const fixture = await reconciliationFixture({
      incorporated: false,
      incidentEnvelope: true,
    });
    await writeFile(join(fixture.targetPath, "legacy-dirty.txt"), "legacy\n");
    const sourcePlan = await previewStaleIntegrationReconciliationPlan(fixture.scope);
    const captureProcessEvidence = async (custodyPaths: readonly string[]) => ({
      schemaVersion: 1 as const,
      observedAt: "2026-08-08T00:01:00.000Z",
      inspectedPidCount: 1,
      inventorySha256: "d".repeat(64),
      custodyPaths,
      blockers: [],
    });
    const plan = await previewLegacyAttemptQuarantinePlan({
      ...fixture.scope,
      sourceStaleIntegrationPlanSha256: sourcePlan.planSha256,
      cutoff: "2026-08-08T00:02:00.000Z",
      now: () => new Date("2026-08-10T00:02:00.000Z"),
      captureProcessEvidence,
    });
    await applyLegacyAttemptQuarantine({
      controllerJobRootDir: fixture.controllerJobRootDir,
      expectedPlanSha256: plan.planSha256,
      captureProcessEvidence,
      runAfterControllerScopeRevalidation: async (_persisted, effect) => await effect(),
    });
    const attempt = JSON.parse(await readFile(fixture.attemptPath, "utf8"));
    await writeFile(fixture.attemptPath, `${JSON.stringify({
      ...attempt,
      externallyChanged: true,
    }, null, 2)}\n`);
    await expect(readActiveLegacyAttemptQuarantine(
      fixture.controllerJobRootDir,
    )).rejects.toThrow("legacy_attempt_quarantine_source_plan_drift");
  });

  it("rejects attempts updated after the stable cutoff", async () => {
    const fixture = await reconciliationFixture({
      incorporated: false,
      incidentEnvelope: true,
    });
    const sourcePlan = await previewStaleIntegrationReconciliationPlan(fixture.scope);
    await expect(previewLegacyAttemptQuarantinePlan({
      ...fixture.scope,
      sourceStaleIntegrationPlanSha256: sourcePlan.planSha256,
      cutoff: "2026-08-07T00:00:00.000Z",
      now: () => new Date("2026-08-10T00:00:00.000Z"),
      captureProcessEvidence: async (custodyPaths) => ({
        schemaVersion: 1,
        observedAt: "2026-08-10T00:00:00.000Z",
        inspectedPidCount: 0,
        inventorySha256: "e".repeat(64),
        custodyPaths,
        blockers: [],
      }),
    })).rejects.toThrow("legacy_attempt_quarantine_attempt_newer_than_cutoff");
  });

  it("keeps epoch-anchored custody stable after controller and registry advance", async () => {
    const fixture = await reconciliationFixture({
      incorporated: false,
      incidentEnvelope: true,
    });
    await writeFile(join(fixture.targetPath, "legacy-dirty.txt"), "legacy\n");
    const sourcePlan = await previewStaleIntegrationReconciliationPlan(fixture.scope);
    const captureProcessEvidence = async (custodyPaths: readonly string[]) => ({
      schemaVersion: 1 as const,
      observedAt: "2026-08-10T00:00:00.000Z",
      inspectedPidCount: 0,
      inventorySha256: "f".repeat(64),
      custodyPaths,
      blockers: [],
    });
    const plan = await previewLegacyAttemptQuarantinePlan({
      ...fixture.scope,
      sourceStaleIntegrationPlanSha256: sourcePlan.planSha256,
      cutoff: "2026-08-08T00:02:00.000Z",
      now: () => new Date("2026-08-10T00:02:00.000Z"),
      captureProcessEvidence,
    });
    await applyLegacyAttemptQuarantine({
      controllerJobRootDir: fixture.controllerJobRootDir,
      expectedPlanSha256: plan.planSha256,
      captureProcessEvidence,
      runAfterControllerScopeRevalidation: async (_persisted, effect) => await effect(),
    });
    const anchor = await buildLiveLegacyAttemptQuarantineEpochAnchor(
      fixture.controllerJobRootDir,
    );
    expect(anchor).toMatchObject({ attemptCount: 17 });
    await writeFile(fixture.controllerManifestPath, "{\"advanced\":true}\n");
    const newJob = codexGoalJobManifestPath({
      registryRootDir: fixture.scope.registryRootDir,
      jobId: "social-monitor-new-v4",
    });
    await mkdir(join(newJob, ".."), { recursive: true });
    await writeFile(newJob, "{\"new\":true}\n");
    await expect(readActiveLegacyAttemptQuarantine(
      fixture.controllerJobRootDir,
    )).rejects.toThrow();
    await expect(readStableLegacyAttemptQuarantine(
      fixture.controllerJobRootDir,
      anchor!,
    )).resolves.toMatchObject({
      debt: expect.arrayContaining([
        expect.objectContaining({ attemptId: fixture.attemptId }),
      ]),
    });
    await expect(previewLegacyAttemptQuarantinePlan({
      ...fixture.scope,
      sourceStaleIntegrationPlanSha256: sourcePlan.planSha256,
      cutoff: "2026-08-08T00:02:00.000Z",
      now: () => new Date("2026-08-10T00:02:00.000Z"),
      captureProcessEvidence,
      epochQuarantinePlanSha256s: [anchor!.planSha256],
    })).resolves.toMatchObject({ planSha256: plan.planSha256 });
    await expect(applyLegacyAttemptQuarantine({
      controllerJobRootDir: fixture.controllerJobRootDir,
      expectedPlanSha256: plan.planSha256,
      captureProcessEvidence,
      resolveEpochQuarantinePlanSha256s: async () => [anchor!.planSha256],
      runAfterControllerScopeRevalidation: async (_persisted, effect) => await effect(),
    })).resolves.toMatchObject({ idempotentReplay: true });
    await expect(previewLegacyAttemptQuarantinePlan({
      ...fixture.scope,
      sourceStaleIntegrationPlanSha256: sourcePlan.planSha256,
      cutoff: "2026-08-07T00:02:00.000Z",
      now: () => new Date("2026-08-10T00:02:00.000Z"),
      captureProcessEvidence,
      epochQuarantinePlanSha256s: [anchor!.planSha256],
    })).rejects.toThrow("legacy_attempt_quarantine_single_use_conflict");
  });

  it("resumes after crash and detects process, event, and preservation conflicts", async () => {
    const fixture = await reconciliationFixture({
      incorporated: false,
      incidentEnvelope: true,
    });
    await writeFile(join(fixture.targetPath, "legacy-dirty.txt"), "legacy\n");
    await writeFile(fixture.eventsPath, "{}\n");
    const sourcePlan = await previewStaleIntegrationReconciliationPlan(fixture.scope);
    const evidence = async (custodyPaths: readonly string[]) => ({
      schemaVersion: 1 as const,
      observedAt: "2026-08-10T00:00:00.000Z",
      inspectedPidCount: 1,
      inventorySha256: "9".repeat(64),
      custodyPaths,
      blockers: [],
    });
    await expect(previewLegacyAttemptQuarantinePlan({
      ...fixture.scope,
      sourceStaleIntegrationPlanSha256: sourcePlan.planSha256,
      cutoff: "2026-08-08T00:02:00.000Z",
      now: () => new Date("2026-08-10T00:02:00.000Z"),
      captureProcessEvidence: async (custodyPaths) => ({
        ...(await evidence(custodyPaths)),
        blockers: [{
          pid: 42,
          startTime: "1",
          argvSha256: "8".repeat(64),
          cwd: fixture.targetPath,
        }],
      }),
    })).rejects.toThrow("legacy_attempt_quarantine_processes_active");
    const plan = await previewLegacyAttemptQuarantinePlan({
      ...fixture.scope,
      sourceStaleIntegrationPlanSha256: sourcePlan.planSha256,
      cutoff: "2026-08-08T00:02:00.000Z",
      now: () => new Date("2026-08-10T00:02:00.000Z"),
      captureProcessEvidence: evidence,
    });
    const apply = (crashAfterCompletedCount?: number) =>
      applyLegacyAttemptQuarantine({
        controllerJobRootDir: fixture.controllerJobRootDir,
        expectedPlanSha256: plan.planSha256,
        captureProcessEvidence: evidence,
        runAfterControllerScopeRevalidation: async (_persisted, effect) => await effect(),
        ...(crashAfterCompletedCount ? { crashAfterCompletedCount } : {}),
      });
    await expect(apply(1)).rejects.toThrow(
      "legacy_attempt_quarantine_simulated_crash",
    );
    const receipt = await apply();
    expect(receipt.idempotentReplay).toBe(false);
    const eventsBefore = await readFile(fixture.eventsPath);
    await writeFile(fixture.eventsPath, Buffer.concat([eventsBefore, Buffer.from("{}\n")]));
    await expect(readActiveLegacyAttemptQuarantine(
      fixture.controllerJobRootDir,
    )).rejects.toThrow("legacy_attempt_quarantine_binding_drift");
    await writeFile(fixture.eventsPath, eventsBefore);
    await writeFile(receipt.entries[0]!.preservationPath, "{}\n");
    await expect(readActiveLegacyAttemptQuarantine(
      fixture.controllerJobRootDir,
    )).rejects.toThrow("legacy_attempt_quarantine_preservation_drift");
  });

  it.each([
    [false, "patch_absent"],
    [true, "patch_incorporated"],
  ] as const)("proves and rejects a stale attempt (incorporated=%s)", async (
    incorporated,
    proof,
  ) => {
    const fixture = await reconciliationFixture({ incorporated });
    const plan = await previewStaleIntegrationReconciliationPlan(fixture.scope);
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]).toMatchObject({ eligible: true, proof });

    const receipt = await applyStaleIntegrationReconciliation({
      expectedPlanSha256: plan.planSha256,
      controllerJobRootDir: fixture.controllerJobRootDir,
    });
    expect(receipt).toMatchObject({
      status: "completed",
      reconciled: [fixture.attemptId],
    });
    expect((await fixture.store.get(fixture.attemptId))?.status).toBe(
      IntegrationAttemptStatus.Rejected,
    );
  });

  it("fails closed when target workspace is dirty", async () => {
    const fixture = await reconciliationFixture({ incorporated: false });
    await writeFile(join(fixture.targetPath, "untracked.txt"), "dirty\n");
    const plan = await previewStaleIntegrationReconciliationPlan(fixture.scope);
    expect(plan.entries[0]).toMatchObject({
      eligible: false,
      refusalReason: "target_workspace_dirty",
    });
    await expect(applyStaleIntegrationReconciliation({
      expectedPlanSha256: plan.planSha256,
      controllerJobRootDir: fixture.controllerJobRootDir,
    })).rejects.toThrow("stale_integration_reconciliation_refused_entries_present");
    expect((await fixture.store.get(fixture.attemptId))?.status).toBe(
      IntegrationAttemptStatus.Opened,
    );
  });

  it("fails closed when the signed live remote head drifts after preview", async () => {
    const fixture = await reconciliationFixture({ incorporated: false });
    const plan = await previewStaleIntegrationReconciliationPlan(fixture.scope);
    await writeFile(join(fixture.seedPath, "remote-drift.txt"), "drift\n");
    await git(fixture.seedPath, ["add", "remote-drift.txt"]);
    await git(fixture.seedPath, ["commit", "-m", "chore: remote drift"]);
    await git(fixture.seedPath, ["push", "origin", "main"]);
    await expect(applyStaleIntegrationReconciliation({
      expectedPlanSha256: plan.planSha256,
      controllerJobRootDir: fixture.controllerJobRootDir,
    })).rejects.toThrow("stale_integration_reconciliation_entry_drift");
  });

  it("fails the attempt hash and status CAS when state changes after preview", async () => {
    const fixture = await reconciliationFixture({ incorporated: false });
    const plan = await previewStaleIntegrationReconciliationPlan(fixture.scope);
    const attemptPath = plan.entries[0]!.attemptPath;
    const attempt = JSON.parse(await readFile(attemptPath, "utf8"));
    await writeFile(attemptPath, `${JSON.stringify({
      ...attempt,
      externallyObserved: true,
    }, null, 2)}\n`);
    await expect(applyStaleIntegrationReconciliation({
      expectedPlanSha256: plan.planSha256,
      controllerJobRootDir: fixture.controllerJobRootDir,
    })).rejects.toThrow("stale_integration_reconciliation_attempt_cas_mismatch");
  });

  it.each([
    ["targetRemote", "-origin", "project_control_targetRemote_invalid"],
    ["targetBranch", "-main", "project_control_targetBranch_invalid"],
  ] as const)("rejects unsafe %s before invoking Git", async (
    field,
    value,
    error,
  ) => {
    const fixture = await reconciliationFixture({ incorporated: false });
    const attemptPath = fixture.attemptPath;
    const attempt = JSON.parse(await readFile(attemptPath, "utf8"));
    await writeFile(attemptPath, `${JSON.stringify({
      ...attempt,
      [field]: value,
      targetWorkspacePath: join(fixture.root, "not-a-repository"),
    }, null, 2)}\n`);
    await expect(previewStaleIntegrationReconciliationPlan(fixture.scope))
      .rejects.toThrow(error);
  });

  it("binds exact patch custody metadata and refuses denied evidence", async () => {
    const fixture = await reconciliationFixture({ incorporated: false });
    const plan = await previewStaleIntegrationReconciliationPlan(fixture.scope);
    expect(plan.entries[0]?.patchEvidence).toMatchObject({
      declaredPath: fixture.patchPath,
      canonicalPath: await realpath(fixture.patchPath),
      size: expect.any(Number),
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const denied = await reconciliationFixture({ incorporated: false });
    const deniedPlan = await previewStaleIntegrationReconciliationPlan({
      ...denied.scope,
      deniedRoots: [denied.reviewedRoot],
    });
    expect(deniedPlan.entries[0]).toMatchObject({
      eligible: false,
      refusalReason: expect.stringContaining("patch_outside_custody"),
    });

    const escaped = await reconciliationFixture({ incorporated: false });
    const escapedPatch = join(escaped.root, "outside.patch");
    await writeFile(escapedPatch, await readFile(escaped.patchPath));
    const escapedAttempt = JSON.parse(await readFile(escaped.attemptPath, "utf8"));
    await writeFile(escaped.attemptPath, `${JSON.stringify({
      ...escapedAttempt,
      workerOutput: { ...escapedAttempt.workerOutput, patchPath: escapedPatch },
    }, null, 2)}\n`);
    const escapedPlan = await previewStaleIntegrationReconciliationPlan(
      escaped.scope,
    );
    expect(escapedPlan.entries[0]).toMatchObject({
      eligible: false,
      refusalReason: expect.stringContaining("patch_outside_reviewed_store"),
    });
  });

  it("requires reviewed-output project, controller, and worker ownership", async () => {
    const fixture = await reconciliationFixture({ incorporated: false });
    const attempt = JSON.parse(await readFile(fixture.attemptPath, "utf8"));
    await writeFile(fixture.attemptPath, `${JSON.stringify({
      ...attempt,
      workerJobId: "foreign-worker-v1",
      workerOutput: {
        ...attempt.workerOutput,
        workerJobId: "foreign-worker-v1",
      },
    }, null, 2)}\n`);
    const plan = await previewStaleIntegrationReconciliationPlan(fixture.scope);
    expect(plan.entries[0]).toMatchObject({
      eligible: false,
      refusalReason: expect.stringContaining("reviewed_output_scope_mismatch"),
    });
  });

  it.each([
    ["base commit", (attempt: IntegrationAttempt) => ({
      ...attempt,
      workerOutput: { ...attempt.workerOutput, baseCommit: "f".repeat(40) },
    })],
    ["canonical merge absence", (attempt: IntegrationAttempt) => ({
      ...attempt,
      merge: {
        sourceRemote: "origin",
        sourceBranch: "reviewed-feature",
        sourceCommit: "f".repeat(40),
        expectedTargetCommit: attempt.workerOutput.baseCommit!,
      },
    })],
  ] as const)("refuses reviewed-output %s mismatch before proof", async (
    _label,
    mutate,
  ) => {
    const fixture = await reconciliationFixture({ incorporated: false });
    const attempt = (await fixture.store.get(fixture.attemptId))!;
    await fixture.store.update(mutate(attempt));
    const plan = await previewStaleIntegrationReconciliationPlan(fixture.scope);
    expect(plan.entries[0]).toMatchObject({
      eligible: false,
      refusalReason: expect.stringContaining("reviewed_output_scope_mismatch"),
    });
  });

  it.each([
    IntegrationAttemptStatus.Opened,
    IntegrationAttemptStatus.Applied,
    IntegrationAttemptStatus.ChecksRunning,
    IntegrationAttemptStatus.ChecksFailed,
    IntegrationAttemptStatus.ChecksPassed,
    IntegrationAttemptStatus.CommitCreated,
  ])("accepts a domain-valid historical %s attempt", async (status) => {
    const fixture = await reconciliationFixture({ incorporated: false });
    const opened = (await fixture.store.get(fixture.attemptId))!;
    await fixture.store.update(historicalAttemptAtStatus(opened, status));
    const plan = await previewStaleIntegrationReconciliationPlan(fixture.scope);
    expect(plan.entries[0]).toMatchObject({ eligible: true, status });
  });

  it.each([
    ["opened with commit", (attempt: IntegrationAttempt) => ({
      ...attempt,
      commitCandidate: commitCandidate(),
    })],
    ["checks passed with failed rollup", (attempt: IntegrationAttempt) => ({
      ...historicalAttemptAtStatus(
        attempt,
        IntegrationAttemptStatus.ChecksPassed,
      ),
      checkRuns: [failedCheckRun()],
    })],
    ["commit status without candidate", (attempt: IntegrationAttempt) => {
      const committed = historicalAttemptAtStatus(
        attempt,
        IntegrationAttemptStatus.CommitCreated,
      );
      const { commitCandidate: _removed, ...inconsistent } = committed;
      return inconsistent as IntegrationAttempt;
    }],
  ] as const)("rejects domain-inconsistent %s attempt", async (
    _label,
    mutate,
  ) => {
    const fixture = await reconciliationFixture({ incorporated: false });
    const attempt = (await fixture.store.get(fixture.attemptId))!;
    await fixture.store.update(mutate(attempt));
    await expect(previewStaleIntegrationReconciliationPlan(fixture.scope))
      .rejects.toThrow("stale_integration_reconciliation_attempt_structure_invalid");
  });

  it("refuses symlink patch evidence and detects bound-byte drift", async () => {
    const symlinked = await reconciliationFixture({ incorporated: false });
    const realPatch = join(symlinked.root, "real.patch");
    await rename(symlinked.patchPath, realPatch);
    await symlink(realPatch, symlinked.patchPath);
    const symlinkPlan = await previewStaleIntegrationReconciliationPlan(
      symlinked.scope,
    );
    expect(symlinkPlan.entries[0]).toMatchObject({
      eligible: false,
      refusalReason: expect.stringContaining("artifact_unsafe"),
    });

    const drifted = await reconciliationFixture({ incorporated: false });
    const plan = await previewStaleIntegrationReconciliationPlan(drifted.scope);
    await writeFile(drifted.patchPath, "drift\n");
    await expect(applyStaleIntegrationReconciliation({
      expectedPlanSha256: plan.planSha256,
      controllerJobRootDir: drifted.controllerJobRootDir,
    })).rejects.toThrow("stale_integration_reconciliation_entry_drift");
  });

  it("rejects duplicate persisted bindings before progress or mutation", async () => {
    const fixture = await reconciliationFixture({ incorporated: false });
    const plan = await previewStaleIntegrationReconciliationPlan(fixture.scope);
    const { planSha256: _ignored, ...unsigned } = plan;
    const duplicateUnsigned = { ...unsigned, entries: [
      ...unsigned.entries,
      unsigned.entries[0]!,
    ] };
    const duplicateSha = createHash("sha256")
      .update(JSON.stringify(duplicateUnsigned)).digest("hex");
    const artifactRoot = join(
      fixture.controllerJobRootDir,
      "project-integration",
      "stale-attempt-reconciliation",
    );
    await writeFile(join(artifactRoot, `${duplicateSha}.plan.json`), JSON.stringify({
      ...duplicateUnsigned,
      planSha256: duplicateSha,
    }));
    await expect(applyStaleIntegrationReconciliation({
      expectedPlanSha256: duplicateSha,
      controllerJobRootDir: fixture.controllerJobRootDir,
    })).rejects.toThrow("stale_integration_reconciliation_attempt_binding_duplicate");
    await expect(access(join(artifactRoot, `${duplicateSha}.progress.json`)))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect((await fixture.store.get(fixture.attemptId))?.status).toBe(
      IntegrationAttemptStatus.Opened,
    );
  });

  it("rejects a noncanonical attempt directory before proof execution", async () => {
    const fixture = await reconciliationFixture({ incorporated: false });
    await rename(
      join(fixture.attemptPath, ".."),
      join(fixture.controllerJobRootDir, "project-integration", "integration-attempts", "bad"),
    );
    await expect(previewStaleIntegrationReconciliationPlan(fixture.scope))
      .rejects.toThrow("stale_integration_reconciliation_attempt_binding_noncanonical");
  });

  it("resumes after a crash partway through 17 exact updates and replays receipt", async () => {
    const fixture = await reconciliationFixture({
      incorporated: false,
      attemptCount: 17,
    });
    const plan = await previewStaleIntegrationReconciliationPlan(fixture.scope);
    await expect(applyStaleIntegrationReconciliation({
      expectedPlanSha256: plan.planSha256,
      controllerJobRootDir: fixture.controllerJobRootDir,
      crashAfterCompletedCount: 8,
    })).rejects.toThrow("stale_integration_reconciliation_simulated_crash");
    const partial = await Promise.all(fixture.attemptIds.map(async (attemptId) =>
      (await fixture.store.get(attemptId))?.status
    ));
    expect(partial.filter((status) =>
      status === IntegrationAttemptStatus.Rejected
    )).toHaveLength(8);

    const resumed = await applyStaleIntegrationReconciliation({
      expectedPlanSha256: plan.planSha256,
      controllerJobRootDir: fixture.controllerJobRootDir,
    });
    expect(resumed).toMatchObject({
      idempotentReplay: false,
      reconciled: [...fixture.attemptIds].sort(),
    });
    const replay = await applyStaleIntegrationReconciliation({
      expectedPlanSha256: plan.planSha256,
      controllerJobRootDir: fixture.controllerJobRootDir,
    });
    expect(replay).toEqual({ ...resumed, idempotentReplay: true });
  });

  it("resumes from a durable pending exact post-image", async () => {
    const fixture = await reconciliationFixture({ incorporated: false });
    const plan = await previewStaleIntegrationReconciliationPlan(fixture.scope);
    await expect(applyStaleIntegrationReconciliation({
      expectedPlanSha256: plan.planSha256,
      controllerJobRootDir: fixture.controllerJobRootDir,
      crashAfterPreparedCount: 1,
    })).rejects.toThrow("stale_integration_reconciliation_simulated_prepare_crash");
    expect((await fixture.store.get(fixture.attemptId))?.status).toBe(
      IntegrationAttemptStatus.Opened,
    );
    const receipt = await applyStaleIntegrationReconciliation({
      expectedPlanSha256: plan.planSha256,
      controllerJobRootDir: fixture.controllerJobRootDir,
    });
    expect(receipt.reconciled).toEqual([fixture.attemptId]);
  });

  it("rejects exact post-image drift after a completed crash", async () => {
    const fixture = await reconciliationFixture({ incorporated: false });
    const plan = await previewStaleIntegrationReconciliationPlan(fixture.scope);
    await expect(applyStaleIntegrationReconciliation({
      expectedPlanSha256: plan.planSha256,
      controllerJobRootDir: fixture.controllerJobRootDir,
      crashAfterCompletedCount: 1,
    })).rejects.toThrow("stale_integration_reconciliation_simulated_crash");
    const rejected = JSON.parse(await readFile(fixture.attemptPath, "utf8"));
    await writeFile(fixture.attemptPath, `${JSON.stringify({
      ...rejected,
      updatedAt: "2026-08-08T00:00:09.000Z",
    }, null, 2)}\n`);
    await expect(applyStaleIntegrationReconciliation({
      expectedPlanSha256: plan.planSha256,
      controllerJobRootDir: fixture.controllerJobRootDir,
    })).rejects.toThrow("stale_integration_reconciliation_progress_attempt_drift");
  });

  it.each([
    ["invalid status", { status: "invented_status" }],
    ["partial shape", { reviewDecision: { decision: "approved" } }],
  ])("rejects %s before proof or mutation", async (_label, patch) => {
    const fixture = await reconciliationFixture({ incorporated: false });
    const attempt = JSON.parse(await readFile(fixture.attemptPath, "utf8"));
    await writeFile(fixture.attemptPath, `${JSON.stringify({
      ...attempt,
      ...patch,
    }, null, 2)}\n`);
    await expect(previewStaleIntegrationReconciliationPlan(fixture.scope))
      .rejects.toThrow("stale_integration_reconciliation_attempt_structure_invalid");
  });

  it("runs scope revalidation only after the maintenance fence is present", async () => {
    const fixture = await reconciliationFixture({ incorporated: false });
    const plan = await previewStaleIntegrationReconciliationPlan(fixture.scope);
    let observedFence = false;
    await applyStaleIntegrationReconciliation({
      expectedPlanSha256: plan.planSha256,
      controllerJobRootDir: fixture.controllerJobRootDir,
      runAfterControllerScopeRevalidation: async (effect) => {
        await access(join(
          fixture.controllerJobRootDir,
          ".controller-maintenance-fence.json",
        ));
        observedFence = true;
        return await effect();
      },
    });
    expect(observedFence).toBe(true);
  });
});

async function reconciliationFixture(input: {
  readonly incorporated: boolean;
  readonly attemptCount?: number;
  readonly incidentEnvelope?: boolean;
}) {
  const root = await mkdtemp(join(tmpdir(), "stale-integration-reconciliation-"));
  roots.push(root);
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  const worker = join(root, "worker");
  const targetPath = join(root, "target");
  const controllerJobRootDir = join(root, "controller");
  const registryRootDir = join(root, "registry");
  const controllerManifestPath = codexGoalJobManifestPath({
    registryRootDir,
    jobId: "social-monitor-controller-v4",
  });
  await mkdir(join(controllerManifestPath, ".."), { recursive: true });
  const controllerManifestBytes = Buffer.from("{\"fixture\":true}\n");
  await writeFile(controllerManifestPath, controllerManifestBytes);
  const workerManifestPath = codexGoalJobManifestPath({
    registryRootDir,
    jobId: "social-monitor-worker-v1",
  });
  const workerJobRoot = join(root, "worker-job");
  const workerResultPath = join(workerJobRoot, "worker-task.latest-result.json");
  await mkdir(join(workerManifestPath, ".."), { recursive: true });
  await mkdir(workerJobRoot, { recursive: true });
  await writeFile(workerResultPath, `${JSON.stringify({ status: "done" })}\n`);
  await writeFile(workerManifestPath, `${JSON.stringify({
    schemaVersion: 1,
    jobId: "social-monitor-worker-v1",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T01:00:00.000Z",
    jobRootDir: workerJobRoot,
    workspacePath: worker,
    promptPath: join(workerJobRoot, "prompt.md"),
    taskId: "worker-task",
    accounts: ["account-test"],
    outputPath: workerResultPath,
  }, null, 2)}\n`);
  await git(root, ["init", "--bare", remote]);
  await mkdir(seed, { recursive: true });
  await git(seed, ["init", "-b", "main"]);
  await git(seed, ["config", "user.name", "Test"]);
  await git(seed, ["config", "user.email", "test@example.com"]);
  await writeFile(join(seed, "value.txt"), "before\n");
  await git(seed, ["add", "value.txt"]);
  await git(seed, ["commit", "-m", "chore: seed"]);
  await git(seed, ["remote", "add", "origin", remote]);
  await git(seed, ["push", "-u", "origin", "main"]);
  await git(root, ["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);
  await git(root, ["clone", remote, worker]);
  await writeFile(join(worker, "value.txt"), "after\n");
  const patchPath = join(worker, "worker.patch");
  const patchBytes = Buffer.from(await gitOutput(worker, ["diff", "--binary"]));
  await writeFile(patchPath, patchBytes);
  if (input.incorporated) {
    await git(seed, ["apply", patchPath]);
    await git(seed, ["add", "value.txt"]);
    await git(seed, ["commit", "-m", "fix: incorporate worker patch"]);
    await git(seed, ["push", "origin", "main"]);
  }
  await git(root, ["clone", remote, targetPath]);
  const reviewDecision = {
    reviewedBy: "social-monitor-reviewer-v1",
    decision: ReviewDecisionStatus.Approved,
    reason: "test fixture",
    approvedFiles: ["value.txt"],
    requiredChecks: [],
  } as const;
  const baseCommit = (await gitOutput(worker, ["rev-parse", "HEAD"])).trim();
  const reviewedRoot = reviewedWorkerOutputRoot(registryRootDir);
  const reviewedStore = new LocalReviewedWorkerOutputStore({
    rootDir: reviewedRoot,
  });
  const reviewedIdentity = {
    format: reviewedWorkerOutputFormat as typeof reviewedWorkerOutputFormat,
    formatRevision: 1 as const,
    projectId: "social-monitor",
    controllerJobId: "social-monitor-controller-v4",
    workerJobId: "social-monitor-worker-v1",
    taskId: "social-monitor-task-v1",
    sourceWorkspacePath: worker,
    baseCommit,
    patchSha256: createHash("sha256").update(patchBytes).digest("hex"),
    changedFiles: ["value.txt"],
    reviewDecision,
  } as const;
  const reviewedOutputId = createHash("sha256")
    .update(reviewedWorkerOutputIdentityPayload(reviewedIdentity)).digest("hex");
  const reviewedSnapshot = await reviewedStore.create({
    snapshot: {
      ...reviewedIdentity,
      reviewedOutputId,
      patchByteLength: patchBytes.length,
      capturedAt: "2026-08-08T00:00:00.000Z",
    },
    patch: patchBytes.toString("utf8"),
  });
  const reviewMarkerContent = `${JSON.stringify({ reviewedOutputId })}\n`;
  await reviewedStore.commitReviewAttestation({
    attestation: {
      format: "reviewed-worker-output-review-attestation",
      formatRevision: 1,
      reviewedOutputId,
      reviewMarkerPath: join(root, "review-marker.json"),
      reviewMarkerSha256: createHash("sha256")
        .update(reviewMarkerContent).digest("hex"),
      committedAt: "2026-08-08T00:00:00.000Z",
    },
    reviewMarkerContent,
  });
  const incidentEnvelope = input.incidentEnvelope === true;
  const attemptCount = incidentEnvelope ? 17 : input.attemptCount ?? 1;
  const attemptIds = Array.from({ length: attemptCount }, (_, index) =>
    `stale-attempt-${index + 1}`
  );
  const targetPaths = [targetPath];
  if (incidentEnvelope) {
    for (let index = 1; index < attemptCount; index += 1) {
      const path = join(root, `target-${index + 1}`);
      await git(root, ["clone", remote, path]);
      targetPaths.push(path);
    }
    for (let index = 0; index < 3; index += 1) {
      await writeFile(join(targetPaths[index]!, "legacy-dirty.txt"), "legacy\n");
    }
    for (let index = 3; index < 10; index += 1) {
      const path = targetPaths[index]!;
      const partialRemote = join(root, `partial-remote-${index + 1}.git`);
      await git(root, ["init", "--bare", partialRemote]);
      await git(path, ["config", "user.name", "Test"]);
      await git(path, ["config", "user.email", "test@example.com"]);
      await writeFile(join(path, "value.txt"), "ambiguous\n");
      await git(path, ["add", "value.txt"]);
      await git(path, ["commit", "-m", "test: ambiguous target state"]);
      await git(path, ["remote", "set-url", "origin", partialRemote]);
      await git(path, ["push", "-u", "origin", "main"]);
    }
  }
  const outsidePatchPath = join(root, "outside-reviewed-store.patch");
  if (incidentEnvelope) await writeFile(outsidePatchPath, patchBytes);
  const store = new LocalIntegrationAttemptStore({
    rootDir: join(controllerJobRootDir, "project-integration"),
  });
  for (const [index, attemptId] of attemptIds.entries()) {
    const outside = incidentEnvelope && index >= 10 && index < 15;
    await store.create(openIntegrationAttempt({
    attemptId,
    projectId: "social-monitor",
    controllerJobId: "social-monitor-controller-v4",
    sourceWorkspacePath: worker,
    targetWorkspacePath: targetPaths[index] ?? targetPath,
    targetBranch: "main",
    targetRemote: "origin",
    workerOutput: {
      workerJobId: "social-monitor-worker-v1",
      workspacePath: worker,
      patchPath: outside ? outsidePatchPath : reviewedSnapshot.patchPath,
      patchSha256: createHash("sha256").update(patchBytes).digest("hex"),
      baseCommit,
      changedFiles: ["value.txt"],
    },
    reviewDecision,
    now: "2026-08-08T00:00:00.000Z",
    }));
  }
  return {
    root,
    attemptId: attemptIds[0]!,
    attemptIds,
    controllerJobRootDir,
    controllerManifestPath,
    workerPath: worker,
    patchPath: reviewedSnapshot.patchPath,
    reviewedRoot,
    attemptPath: join(
      controllerJobRootDir,
      "project-integration",
      "integration-attempts",
      createHash("sha256").update(attemptIds[0]!).digest("hex"),
      "attempt.json",
    ),
    eventsPath: join(
      controllerJobRootDir,
      "project-integration",
      "integration-attempts",
      createHash("sha256").update(attemptIds[0]!).digest("hex"),
      "events.jsonl",
    ),
    seedPath: seed,
    targetPath,
    store,
    scope: {
      controllerJobId: "social-monitor-controller-v4",
      projectId: "social-monitor",
      registryRootDir,
      controllerJobRootDir,
      controllerManifestSha256: createHash("sha256")
        .update(controllerManifestBytes).digest("hex"),
      controllerScopeEpochSha256: "b".repeat(64),
      targetWorkspaceRoots: [...targetPaths, worker],
      allowedGitRemotes: ["origin"],
      allowedBranches: ["main"],
    },
  };
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function gitOutput(cwd: string, args: readonly string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd })).stdout;
}
