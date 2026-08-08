import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectAccessScope } from
  "@vioxen/subscription-runtime/worker-core";
import {
  applyLegacyAttemptQuarantine,
  previewLegacyAttemptQuarantinePlan,
  revalidateLegacyAttemptQuarantinePlanForPublication,
} from "../application/project-control/codex-goal-legacy-attempt-quarantine";
import { buildLiveLegacyAttemptQuarantineEpochAnchor } from
  "../application/project-control/codex-goal-legacy-attempt-quarantine-anchor";
import { previewStaleIntegrationReconciliationPlan } from
  "../application/project-control/codex-goal-stale-integration-reconciliation";
import {
  projectControlLegacyAttemptQuarantineView,
  type LegacyAttemptQuarantineDeps,
} from "../codex-goal-mcp-project-control-legacy-attempt-quarantine";
import type { LoadedProjectControlController } from
  "../codex-goal-mcp-project-control-admin";
import {
  cleanupReconciliationFixtures,
  reconciliationFixture,
} from "./codex-goal-stale-integration-reconciliation-test-support";

const cutoff = "2026-08-08T00:02:00.000Z";
const observedAt = "2026-08-10T00:02:00.000Z";

afterEach(async () => await cleanupReconciliationFixtures());

describe("legacy attempt quarantine handler", () => {
  it("rejects critical binding drift inside the publication fence", async () => {
    const fixture = await reconciliationFixture({
      incorporated: false,
      incidentEnvelope: true,
    });
    const source = await previewStaleIntegrationReconciliationPlan(fixture.scope);
    await expect(previewLegacyAttemptQuarantinePlan({
      ...fixture.scope,
      sourceStaleIntegrationPlanSha256: source.planSha256,
      cutoff,
      now: () => new Date(observedAt),
      captureProcessEvidence: evidence,
      runBeforePlanPublication: async (plan, publish) => {
        await writeFile(fixture.eventsPath, "{}\n");
        await revalidateLegacyAttemptQuarantinePlanForPublication({
          plan,
          epochPlanSha256s: [],
          captureProcessEvidence: evidence,
        });
        return await publish();
      },
    })).rejects.toThrow("legacy_attempt_quarantine_binding_drift");
    await expect(access(join(fixture.controllerJobRootDir, "project-integration",
      "legacy-attempt-quarantine", "plans"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("blocks epoch planning after a claim crash and resumes the exact plan", async () => {
    const fixture = await reconciliationFixture({
      incorporated: false,
      incidentEnvelope: true,
    });
    const source = await previewStaleIntegrationReconciliationPlan(fixture.scope);
    const input = {
      ...fixture.scope,
      sourceStaleIntegrationPlanSha256: source.planSha256,
      cutoff,
      now: () => new Date(observedAt),
      captureProcessEvidence: evidence,
    };
    await expect(previewLegacyAttemptQuarantinePlan({
      ...input,
      crashAfterPlanPublication: true,
    })).rejects.toThrow("legacy_attempt_quarantine_simulated_plan_crash");
    await expect(buildLiveLegacyAttemptQuarantineEpochAnchor(
      fixture.controllerJobRootDir,
    )).rejects.toThrow("legacy_attempt_quarantine_pending_claim_blocks_epoch");
    const recovered = await previewLegacyAttemptQuarantinePlan({
      ...input,
      now: () => new Date("2026-08-12T00:02:00.000Z"),
      captureProcessEvidence: async (custodyPaths) => ({
        ...(await evidence(custodyPaths)),
        observedAt: "2026-08-12T00:01:00.000Z",
        inventorySha256: "c".repeat(64),
      }),
    });
    expect(recovered.entries).toHaveLength(17);
    expect(recovered.policyObservedAt).toBe(observedAt);
    expect(recovered.processEvidence.observedAt).toBe(observedAt);
    await expect(buildLiveLegacyAttemptQuarantineEpochAnchor(
      fixture.controllerJobRootDir,
    )).rejects.toThrow("legacy_attempt_quarantine_pending_claim_blocks_epoch");
  });

  it("replays preview and confirm through the real handler after epoch drift", async () => {
    const fixture = await reconciliationFixture({
      incorporated: false,
      incidentEnvelope: true,
    });
    const source = await previewStaleIntegrationReconciliationPlan(fixture.scope);
    const plan = await previewLegacyAttemptQuarantinePlan({
      ...fixture.scope,
      sourceStaleIntegrationPlanSha256: source.planSha256,
      cutoff,
      now: () => new Date(observedAt),
      captureProcessEvidence: evidence,
    });
    await applyLegacyAttemptQuarantine({
      controllerJobRootDir: fixture.controllerJobRootDir,
      expectedPlanSha256: plan.planSha256,
      captureProcessEvidence: evidence,
      runAfterControllerScopeRevalidation: async (_persisted, effect) => await effect(),
    });
    const anchor = await buildLiveLegacyAttemptQuarantineEpochAnchor(
      fixture.controllerJobRootDir,
    );
    const loaded = await advancedController(fixture);
    const deps = {
      loadProjectControlController: async () => loaded,
      admissionDeps: {},
      captureProcessEvidence: async (input: {
        readonly custodyPaths: readonly string[];
      }) => await evidence(input.custodyPaths),
      resolveEpochAnchoredQuarantine: async () => ({
        attemptIds: new Set(plan.entries.map((entry) => entry.attemptId)),
        debt: plan.entries.map((entry) => ({
          attemptId: entry.attemptId,
          status: entry.status,
          disposition: entry.disposition,
          ...(entry.refusalReason ? { refusalReason: entry.refusalReason } : {}),
          planSha256: plan.planSha256,
        })),
      }),
    } as unknown as LegacyAttemptQuarantineDeps;
    const args = {
      sourceStaleIntegrationPlanSha256: source.planSha256,
      legacyAttemptQuarantineCutoff: cutoff,
    };
    const confirmArgs = {
      ...args,
      confirmLegacyAttemptQuarantine: true,
      expectedLegacyAttemptQuarantinePlanSha256: plan.planSha256,
    };
    const {
      resolveEpochAnchoredQuarantine: _anchored,
      ...preEpochDeps
    } = deps;
    for (const drifted of [
      loaded,
      { ...loaded, registryRootDir: join(fixture.root, "other-registry") },
      { ...loaded, scope: {
        ...loaded.scope,
        workspaceRoots: (loaded.scope.workspaceRoots ?? []).slice(1),
      } },
    ]) {
      await expect(projectControlLegacyAttemptQuarantineView(confirmArgs, {
        ...preEpochDeps,
        loadProjectControlController: async () => drifted,
      })).rejects.toThrow("legacy_attempt_quarantine_controller_scope_drift");
    }
    await expect(projectControlLegacyAttemptQuarantineView(args, deps))
      .resolves.toMatchObject({ planSha256: plan.planSha256 });
    await expect(projectControlLegacyAttemptQuarantineView(confirmArgs, deps))
      .resolves.toMatchObject({ idempotentReplay: true });
    await expect(projectControlLegacyAttemptQuarantineView({
      ...args,
      legacyAttemptQuarantineCutoff: "2026-08-07T00:02:00.000Z",
    }, deps)).rejects.toThrow("legacy_attempt_quarantine_single_use_conflict");
  });
});

async function evidence(custodyPaths: readonly string[]) {
  return {
    schemaVersion: 1 as const,
    observedAt,
    inspectedPidCount: 0,
    inventorySha256: "a".repeat(64),
    custodyPaths,
    blockers: [],
  };
}

async function advancedController(
  fixture: Awaited<ReturnType<typeof reconciliationFixture>>,
): Promise<LoadedProjectControlController> {
  const ledgerRoot = join(fixture.root, "ledger-v3");
  await mkdir(ledgerRoot, { recursive: true });
  const scope: ProjectAccessScope = {
    projectId: fixture.scope.projectId,
    workspaceRoots: fixture.scope.targetWorkspaceRoots,
    deniedRoots: [],
    allowedGitRemotes: fixture.scope.allowedGitRemotes,
    allowedBranches: fixture.scope.allowedBranches,
    consumedOutputLedgerRoots: [ledgerRoot],
  };
  return {
    registryRootDir: fixture.scope.registryRootDir,
    scope,
    controller: {
      schemaVersion: 1,
      jobId: fixture.scope.controllerJobId,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:00.000Z",
      jobRootDir: fixture.controllerJobRootDir,
      workspacePath: fixture.root,
      promptPath: join(fixture.root, "prompt.md"),
      taskId: "controller-task",
      accounts: ["account-test"],
      projectAccessScope: scope,
    },
  };
}
