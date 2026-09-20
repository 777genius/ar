import { assertJsonRecordsTerminal } from "./application/project-control/codex-goal-ledger-epoch-record-guard";
import { codexGoalManifestRevision, publishCodexGoalLedgerScopeUnderMaintenance } from "./codex-goal-job-manifest-revision";
import { readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  ProjectDebtReason,
  projectAdmissionDebtFingerprint,
  type ProjectAccessScope,
  type ProjectAdmissionSnapshot,
} from "@vioxen/subscription-runtime/worker-core";
import {
  acquireConsumedOutputLedgerMaintenanceLock,
  LocalConsumedOutputLedgerMutationLock,
  releaseConsumedOutputLedgerMaintenanceLock,
} from "@vioxen/subscription-runtime/worker-local";
import {
  type LocalControllerMaintenanceFence,
  acquireLocalControllerMaintenanceFence,
  releaseLocalControllerMaintenanceFence,
} from "@vioxen/subscription-runtime/store-local-file";
import type { CodexProjectAdmissionDeps } from
  "./application/project-control/codex-goal-project-admission";
import {
  applyConsumedOutputLedgerEpoch,
  assertConsumedOutputLedgerEpochOrphanBindingsUnchanged,
  assertConsumedOutputLedgerEpochPreparedArtifacts,
  buildConsumedOutputLedgerEpochPlan,
  canonicalConsumedOutputLedgerRoot,
  resolvePendingConsumedOutputLedgerEpochPlan,
} from "./application/project-control/codex-goal-consumed-output-ledger-epoch";
import {
  codexGoalJobManifestPath,
  listCodexGoalJobs,
  type CodexGoalJobManifest,
  type CodexGoalJobSummary,
} from "./codex-goal-jobs";
import type { ProjectControlMcpArgs } from "./codex-goal-mcp-inputs";
import { assertProjectControlScopeRepairAllowed } from "./codex-goal-mcp-project-scope";
import { matchesProjectControlPrefix } from "./codex-goal-mcp-project-utils";
import { projectControlWorkspaceLocks } from "./codex-goal-project-workspace-lock";
import { durableConfirmFilePublication } from
  "./project-control-operation-file-store";
import {
  manifestFingerprint,
  sha256Json,
  stableControllerFingerprint,
} from "./codex-goal-mcp-ledger-epoch-controller-identity";
import {
  booleanValue,
  requiredRawString,
  stringValue,
} from "./codex-goal-mcp-values";
import { assertNoLedgerEpochWriterProcesses } from
  "./application/project-control/codex-goal-ledger-epoch-process-guard";
import {
  loadLegacyAttemptQuarantinePlan,
  readActiveLegacyAttemptQuarantine,
  type ActiveLegacyAttemptQuarantine,
} from
  "./application/project-control/codex-goal-legacy-attempt-quarantine";
import {
  buildLiveLegacyAttemptQuarantineEpochAnchor,
  readStableLegacyAttemptQuarantine,
} from "./application/project-control/codex-goal-legacy-attempt-quarantine-anchor";
import { captureLegacyAttemptProcessEvidence } from
  "./application/project-control/codex-goal-legacy-attempt-process-evidence";
import type { LegacyAttemptProcessEvidence } from
  "./application/project-control/codex-goal-legacy-attempt-process-evidence";
import { buildLedgerEpochLegacyAdmissionAnchor } from
  "./application/project-control/codex-goal-ledger-epoch-legacy-admission";
import {
  assertPreparedEpochV2Sidecar,
  upgradePreparedEpochV1,
} from "./application/project-control/codex-goal-consumed-output-ledger-epoch-target";
import {
  assertSocialProposedAdmissionSourceOrphanSeal,
  assertSocialProposedAdmissionDebtCustody,
  buildSocialProposedAdmissionAnchor,
  createOrVerifySocialProposedAdmissionAnchor,
  normalizeAnchoredProposedAdmission,
  readSocialProposedAdmissionAnchor,
  SOCIAL_PROPOSED_ADMISSION_PLAN_SHA256,
  verifySocialPreparedV1SourceOrphanSeal,
  verifySocialProposedAdmissionAnchorEvidence,
  type LedgerEpochProposedAdmissionAnchor,
} from "./application/project-control/codex-goal-ledger-epoch-proposed-admission";
import {
  assertLedgerEpochDebtCustodyUnchanged,
  resolveLedgerEpochDebtCustody,
  type LedgerEpochDebtCustodyBinding,
} from "./application/project-control/codex-goal-consumed-output-ledger-epoch-switch";
import {
  assertCanonicalLedgerRootsAllowed,
  buildRawLedgerEpochAdmissionSnapshot as buildAdmissionSnapshot,
  ledgerEpochAdmissionSummary as admissionSummary,
  type LedgerEpochAdmissionSnapshotBuilder,
} from "./application/project-control/codex-goal-ledger-epoch-handler-admission";
import {
  assertControllerLedgerRootState,
  assertPreparedStateForActiveRoot,
} from "./application/project-control/codex-goal-ledger-epoch-scope-guards";
import {
  ledgerEpochCustodyPaths as custodyPathsFor,
  ledgerEpochDirectoryIdentity as directoryIdentity,
} from "./application/project-control/codex-goal-ledger-epoch-handler-custody";
type JsonObject = Readonly<Record<string, unknown>>;
type LoadedController = {
  readonly registryRootDir: string;
  readonly controller: CodexGoalJobManifest;
  readonly scope: ProjectAccessScope;
};
export type ProjectControlLedgerEpochDeps = {
  readonly loadProjectControlController:
    (args: ProjectControlMcpArgs) => Promise<LoadedController>;
  readonly admissionDeps: CodexProjectAdmissionDeps;
  readonly buildAdmissionSnapshot?: LedgerEpochAdmissionSnapshotBuilder;
  readonly assertNoLegacyWriterProcesses?: () => Promise<void>;
  readonly captureProcessEvidence?: (
    custodyPaths: readonly string[],
  ) => Promise<LegacyAttemptProcessEvidence>;
  /** Deterministic crash boundary used only by restart certification. */
  readonly preparedV1UpgradeCrashAfter?: () => string | undefined;
  readonly preparedV1UpgradeCrashBoundary?: (boundary: string) => void;
};
export async function projectControlLedgerEpochMigrationView(
  args: ProjectControlMcpArgs,
  deps: ProjectControlLedgerEpochDeps,
): Promise<JsonObject> {
  const loaded = await deps.loadProjectControlController(args);
  const oldRoot = await canonicalConsumedOutputLedgerRoot(
    requiredRawString(args.oldLedgerRoot, "oldLedgerRoot"),
    true,
  );
  const newRoot = await canonicalConsumedOutputLedgerRoot(
    requiredRawString(args.newLedgerRoot, "newLedgerRoot"),
    false,
  );
  const cutoff = requiredRawString(args.ledgerEpochCutoff, "ledgerEpochCutoff");
  const proposedScope: ProjectAccessScope = {
    ...loaded.scope,
    consumedOutputLedgerRoots: [newRoot],
  };
  assertProjectControlScopeRepairAllowed({
    existing: loaded.scope,
    proposed: proposedScope,
  });
  await assertCanonicalLedgerRootsAllowed(loaded.scope, oldRoot, newRoot);
  await assertControllerLedgerRootState(loaded.scope, oldRoot, newRoot);
  let capturedLockedControllerJobId: string | undefined;
  const buildPlan = async (
    transactionVersion: 1 | 2 = 2,
    preboundOrphanWorkspaceBindings?: Awaited<ReturnType<
      typeof buildConsumedOutputLedgerEpochPlan
    >>["orphanWorkspaceBindings"],
  ) => {
    const current = await deps.loadProjectControlController(args);
    if (capturedLockedControllerJobId !== undefined &&
      current.controller.jobId !== capturedLockedControllerJobId) {
      throw new Error("ledger_epoch_controller_job_id_mismatch");
    }
    const controllerJobId =
      capturedLockedControllerJobId ?? current.controller.jobId;
    await assertControllerLedgerRootState(current.scope, oldRoot, newRoot);
    const summaries = await listCodexGoalJobs({
      registryRootDir: current.registryRootDir,
    });
    const currentJobIds = new Set(
      summaries
        .filter((summary) => matchesProjectControlPrefix(
          summary.jobId,
          current.scope.jobIdPrefixes ?? [],
        ))
        .map((summary) => summary.jobId),
    );
    const admission = await buildAdmissionSnapshot({
      registryRootDir: current.registryRootDir,
      scope: current.scope,
      controllerJobId,
      admissionDeps: deps.admissionDeps,
      snapshotBuilder: deps.buildAdmissionSnapshot,
    });
    const legacyAttemptQuarantine =
      await buildLiveLegacyAttemptQuarantineEpochAnchor(
        current.controller.jobRootDir,
      );
    const debtCustody = await resolveLedgerEpochDebtCustody(admission, summaries);
    const custodyPaths = custodyPathsFor(debtCustody, oldRoot, newRoot);
    const processEvidence = await captureEpochProcessEvidence(
      deps,
      custodyPaths,
    );
    const legacyAdmission = buildLedgerEpochLegacyAdmissionAnchor({
      snapshot: admission,
      cutoff,
      processEvidence,
    });
    return await buildConsumedOutputLedgerEpochPlan({
      transactionVersion,
      controllerJobId: current.controller.jobId,
      projectId: current.scope.projectId,
      oldRoot,
      newRoot,
      cutoff,
      currentJobIds,
      evidenceRoots: [
        ...(current.scope.readRoots ?? []),
        ...(current.scope.workspaceRoots ?? []),
        ...(current.scope.worktreeRoots ?? []),
        ...(current.scope.observedWorkspaceRoots ?? []),
        oldRoot,
      ],
      deniedRoots: current.scope.deniedRoots ?? [],
      orphanWorkspacePaths: admission.debt
        .filter((item) => item.reason === ProjectDebtReason.OrphanLegacyWorkspace)
        .map((item) => item.subject),
      ...(preboundOrphanWorkspaceBindings
        ? { preboundOrphanWorkspaceBindings }
        : {}),
      controllerManifestSha256: manifestFingerprint(current.controller),
      controllerStableScopeSha256: stableControllerFingerprint(current.controller),
      ...(legacyAttemptQuarantine ? { legacyAttemptQuarantine } : {}),
      ...(transactionVersion === 2 && legacyAdmission ? { legacyAdmission } : {}),
    });
  };
  const persistedPlan = await resolvePendingConsumedOutputLedgerEpochPlan(
    newRoot,
    true,
    true,
  );
  await assertPreparedStateForActiveRoot(loaded.scope, newRoot, persistedPlan !== undefined);
  if (persistedPlan) {
    assertPersistedPlanOwned({
      plan: persistedPlan,
      controller: loaded.controller,
      scope: loaded.scope,
      oldRoot,
      newRoot,
      cutoff,
    });
    if (persistedPlan.transactionVersion === 2) {
      await assertConsumedOutputLedgerEpochPreparedArtifacts(persistedPlan);
    }
  }
  const plan = persistedPlan ?? await buildPlan();
  if (booleanValue(args.confirmLedgerEpochMigration) !== true) {
    let proposedAdmissionAnchorSha256: string | undefined;
    if (plan.planSha256 === SOCIAL_PROPOSED_ADMISSION_PLAN_SHA256) {
      const existing = await readSocialProposedAdmissionAnchor(plan);
      if (existing) {
        await verifySocialProposedAdmissionAnchorEvidence(existing);
        proposedAdmissionAnchorSha256 = existing.anchorSha256;
      } else {
        const summaries = await listCodexGoalJobs({
          registryRootDir: loaded.registryRootDir,
        });
        const proposedAdmission = await buildAdmissionSnapshot({
          registryRootDir: loaded.registryRootDir,
          scope: proposedScope,
          controllerJobId: loaded.controller.jobId,
          admissionDeps: deps.admissionDeps,
          snapshotBuilder: deps.buildAdmissionSnapshot,
          allowPendingEpochOrphanQuarantine: true,
        });
        const sourceOrphanSeal = await verifySocialPreparedV1SourceOrphanSeal(plan);
        const anchor = await buildSocialProposedAdmissionAnchor({
          plan,
          snapshot: proposedAdmission,
          controllerJobRootDir: loaded.controller.jobRootDir,
          debtCustody: await resolveLedgerEpochDebtCustody(proposedAdmission, summaries),
          sourceOrphanSeal,
        });
        proposedAdmissionAnchorSha256 = anchor?.anchorSha256;
      }
    }
    return {
      ok: false,
      reason: "confirm_ledger_epoch_migration_required",
      mode: "project_control_consumed_output_ledger_epoch",
      controllerJobId: loaded.controller.jobId,
      projectId: loaded.scope.projectId,
      oldRoot,
      newRoot,
      cutoff: plan.cutoff,
      oldRootHash: plan.oldRootHash,
      oldRootFileCount: plan.oldRootFileCount,
      migratedCount: plan.migratedCount,
      quarantinedCount: plan.quarantinedCount,
      inheritedQuarantinedCount: plan.inheritedQuarantinedCount,
      totalQuarantinedCount:
        plan.inheritedQuarantinedCount + plan.quarantinedCount,
      planSha256: plan.planSha256,
      ...(proposedAdmissionAnchorSha256
        ? { proposedAdmissionAnchorSha256 }
        : {}),
      legacyAttemptQuarantine: plan.legacyAttemptQuarantine,
      legacyAdmission: plan.legacyAdmission,
      upgradeRequired: plan.transactionVersion !== 2,
    };
  }
  const expectedPlanSha256 = stringValue(args.expectedLedgerEpochPlanSha256);
  if (!expectedPlanSha256) {
    throw new Error("ledger_epoch_expected_plan_sha256_required");
  }
  const expectedProposedAdmissionAnchorSha256 = stringValue(
    args.expectedLedgerEpochProposedAdmissionAnchorSha256,
  );
  if (plan.planSha256 === SOCIAL_PROPOSED_ADMISSION_PLAN_SHA256 &&
    !/^[a-f0-9]{64}$/.test(expectedProposedAdmissionAnchorSha256 ?? "")) {
    throw new Error("ledger_epoch_proposed_admission_expected_anchor_sha256_required");
  }
  const locks = projectControlWorkspaceLocks(loaded.registryRootDir);
  const lock = await locks.acquire({
    workspacePath: controllerScopeLockIdentity(
      loaded.registryRootDir,
      loaded.controller.jobId,
    ),
    owner: `ledger-epoch:${loaded.controller.jobId}:${plan.planSha256}`,
  });
  const mutationLocks = new LocalConsumedOutputLedgerMutationLock();
  let result;
  let mutationLease;
  let maintenanceLease;
  let controllerFence: LocalControllerMaintenanceFence | undefined;
  let operationError: unknown;
  const debtLocks: Array<Awaited<ReturnType<typeof locks.acquire>>> = [];
  try {
    const locked = await deps.loadProjectControlController(args);
    const lockedControllerJobId = locked.controller.jobId;
    capturedLockedControllerJobId = lockedControllerJobId;
    if (lockedControllerJobId !== plan.controllerJobId) {
      throw new Error("ledger_epoch_controller_job_id_mismatch");
    }
    await durableConfirmFilePublication(controllerScopeLockIdentity(
      locked.registryRootDir,
      locked.controller.jobId,
    ));
    await assertControllerLedgerRootState(locked.scope, oldRoot, newRoot);
    const lockedProposedScope: ProjectAccessScope = {
      ...locked.scope,
      consumedOutputLedgerRoots: [newRoot],
    };
    assertProjectControlScopeRepairAllowed({
      existing: locked.scope,
      proposed: lockedProposedScope,
    });
    const lockedPersistedPlan = await resolvePendingConsumedOutputLedgerEpochPlan(
      newRoot,
      true,
      true,
    );
    await assertPreparedStateForActiveRoot(
      locked.scope,
      newRoot,
      lockedPersistedPlan !== undefined,
    );
    if (persistedPlan && lockedPersistedPlan?.planSha256 !== persistedPlan.planSha256) {
      throw new Error("ledger_epoch_persisted_plan_drift");
    }
    if (lockedPersistedPlan) {
      assertPersistedPlanOwned({
        plan: lockedPersistedPlan,
        controller: locked.controller,
        scope: locked.scope,
        oldRoot,
        newRoot,
        cutoff,
      });
      if (lockedPersistedPlan.transactionVersion === 2) {
        await assertConsumedOutputLedgerEpochPreparedArtifacts(lockedPersistedPlan);
      }
    }
    const lockedManifestFingerprint = manifestFingerprint(locked.controller);
    controllerFence = await acquireLocalControllerMaintenanceFence({
      controllerJobRootDir: locked.controller.jobRootDir,
      owner: `ledger-epoch:${locked.controller.jobId}:${plan.planSha256}`,
    });
    const fencedManifestPath = codexGoalJobManifestPath({
      registryRootDir: locked.registryRootDir, jobId: locked.controller.jobId,
    });
    const fencedManifestSha256 = await codexGoalManifestRevision(fencedManifestPath);
    const lockedActiveRoot = await canonicalConsumedOutputLedgerRoot(
      (locked.scope.consumedOutputLedgerRoots ?? [])[0]!,
      true,
    );
    const lockedQuarantine = lockedActiveRoot === newRoot &&
        lockedPersistedPlan?.legacyAttemptQuarantine
      ? await readStableLegacyAttemptQuarantine(
          locked.controller.jobRootDir,
          lockedPersistedPlan.legacyAttemptQuarantine,
        )
      : await readActiveLegacyAttemptQuarantine(locked.controller.jobRootDir);
    await assertControllerQuiescent(
      locked.controller.jobRootDir,
      lockedQuarantine,
    );
    const assertNoLegacyWriterProcesses = async () => {
      await (deps.assertNoLegacyWriterProcesses
        ? deps.assertNoLegacyWriterProcesses()
        : assertNoLedgerEpochWriterProcesses({
          registryRootDir: locked.registryRootDir,
          controllerJobId: locked.controller.jobId,
          ledgerRoot: oldRoot,
          selfPid: process.pid,
        }));
    };
    await assertNoLegacyWriterProcesses();
    const lockedAdmission = await buildAdmissionSnapshot({
      registryRootDir: locked.registryRootDir,
      scope: { ...locked.scope, consumedOutputLedgerRoots: [oldRoot] },
      controllerJobId: lockedControllerJobId,
      admissionDeps: deps.admissionDeps,
      snapshotBuilder: deps.buildAdmissionSnapshot,
    });
    const lockedSummaries = await listCodexGoalJobs({
      registryRootDir: locked.registryRootDir,
    });
    const lockedProposedAdmission = plan.planSha256 ===
        SOCIAL_PROPOSED_ADMISSION_PLAN_SHA256
      ? await buildAdmissionSnapshot({
          registryRootDir: locked.registryRootDir,
          scope: lockedProposedScope,
          controllerJobId: lockedControllerJobId,
          admissionDeps: deps.admissionDeps,
          snapshotBuilder: deps.buildAdmissionSnapshot,
          allowPendingEpochOrphanQuarantine: true,
        })
      : undefined;
    const debtCustody = await resolveLedgerEpochDebtCustody(
      lockedProposedAdmission ?? lockedAdmission,
      lockedSummaries,
    );
    const controllerCustodyPaths = await Promise.all([
      locked.controller.jobRootDir,
      locked.controller.workspacePath,
    ].map(async (path) => await realpath(path)));
    const custodyPaths = custodyPathsFor(
      debtCustody,
      oldRoot,
      newRoot,
      controllerCustodyPaths,
    );
    const preliminaryProcessEvidence = await captureEpochProcessEvidence(
      deps,
      custodyPaths,
    );
    assertEpochProcessEvidenceClear(preliminaryProcessEvidence, custodyPaths);
    for (const path of custodyPaths) {
      debtLocks.push(await locks.acquire({
        workspacePath: path,
        owner: `ledger-epoch-debt:${locked.controller.jobId}:${plan.planSha256}`,
      }));
    }
    maintenanceLease = await acquireConsumedOutputLedgerMaintenanceLock({
      ledgerRoot: oldRoot,
      owner: `ledger-epoch:${locked.controller.jobId}:${plan.planSha256}`,
    });
    mutationLease = await mutationLocks.acquire({
      ledgerRoots: lockedPersistedPlan ? [oldRoot, newRoot] : [oldRoot],
      owner: `ledger-epoch:${locked.controller.jobId}:${plan.planSha256}`,
    });
    const lockedRootIdentities = await Promise.all([
      directoryIdentity(oldRoot),
      directoryIdentity(newRoot, true),
    ]);
    const currentOperationWillPublishNewRoot =
      "present" in lockedRootIdentities[1]! &&
      lockedRootIdentities[1].present === false;
    const rebuildLockedFacts = async () => {
      const currentController = await deps.loadProjectControlController(args);
      if (currentController.controller.jobId !== lockedControllerJobId) {
        throw new Error("ledger_epoch_controller_job_id_mismatch");
      }
      if (manifestFingerprint(currentController.controller) !== lockedManifestFingerprint) {
        throw new Error("ledger_epoch_controller_manifest_cas_mismatch");
      }
      await assertControllerLedgerRootState(
        currentController.scope,
        oldRoot,
        lockedActiveRoot,
      );
      const currentAdmission = await buildAdmissionSnapshot({
        registryRootDir: currentController.registryRootDir,
        scope: { ...currentController.scope, consumedOutputLedgerRoots: [oldRoot] },
        controllerJobId: lockedControllerJobId,
        admissionDeps: deps.admissionDeps,
        snapshotBuilder: deps.buildAdmissionSnapshot,
      });
      if (projectAdmissionDebtFingerprint(currentAdmission.debt) !==
          projectAdmissionDebtFingerprint(lockedAdmission.debt)) {
        throw new Error("ledger_epoch_admission_debt_drift");
      }
      const currentProposedAdmission = lockedProposedAdmission
        ? await buildAdmissionSnapshot({
            registryRootDir: currentController.registryRootDir,
            scope: lockedProposedScope,
            controllerJobId: lockedControllerJobId,
            admissionDeps: deps.admissionDeps,
            snapshotBuilder: deps.buildAdmissionSnapshot,
            allowPendingEpochOrphanQuarantine: true,
          })
        : undefined;
      if (lockedProposedAdmission && projectAdmissionDebtFingerprint(
        currentProposedAdmission?.debt ?? [],
      ) !== projectAdmissionDebtFingerprint(lockedProposedAdmission.debt)) {
        throw new Error("ledger_epoch_proposed_admission_debt_drift");
      }
      await assertNoLegacyWriterProcesses();
      const currentEvidence = await captureEpochProcessEvidence(deps, custodyPaths);
      assertEpochProcessEvidenceClear(currentEvidence, custodyPaths);
      const reboundController = await deps.loadProjectControlController(args);
      if (reboundController.controller.jobId !== lockedControllerJobId) {
        throw new Error("ledger_epoch_controller_job_id_mismatch");
      }
      if (manifestFingerprint(reboundController.controller) !== lockedManifestFingerprint) {
        throw new Error("ledger_epoch_controller_manifest_cas_mismatch");
      }
      const reboundSummaries = await listCodexGoalJobs({
        registryRootDir: reboundController.registryRootDir,
      });
      await assertLedgerEpochDebtCustodyUnchanged(debtCustody, reboundSummaries);
      const reboundRootIdentities = await Promise.all([
        directoryIdentity(oldRoot),
        directoryIdentity(newRoot, true),
      ]);
      const newRootWasMissing = "present" in lockedRootIdentities[1]! &&
        lockedRootIdentities[1].present === false;
      const newRootNowPresent = !("present" in reboundRootIdentities[1]!);
      if (JSON.stringify(reboundRootIdentities[0]) !==
          JSON.stringify(lockedRootIdentities[0]) ||
        (!newRootWasMissing && JSON.stringify(reboundRootIdentities[1]) !==
          JSON.stringify(lockedRootIdentities[1]))) {
        throw new Error("ledger_epoch_target_root_identity_drift");
      }
      if (newRootWasMissing && newRootNowPresent) {
        await assertConsumedOutputLedgerEpochPreparedArtifacts(plan);
      }
      return {
        admission: currentAdmission,
        ...(currentProposedAdmission ? { proposedAdmission: currentProposedAdmission } : {}),
        evidence: currentEvidence,
      };
    };
    let authoritative = await rebuildLockedFacts();
    let processEvidence = authoritative.evidence;
    let upgradedLegacyAdmission = buildLedgerEpochLegacyAdmissionAnchor({
      snapshot: authoritative.admission,
      cutoff,
      processEvidence,
    });
    let proposedAdmissionAnchor: LedgerEpochProposedAdmissionAnchor | undefined;
    let lockedCurrentPlan: Awaited<ReturnType<
      typeof buildConsumedOutputLedgerEpochPlan
    >> | undefined;
    const rebuildCurrentPlanOnce = async () => {
      if (!lockedCurrentPlan) {
        lockedCurrentPlan = await buildCurrentPlanFor(plan, buildPlan);
        if (lockedCurrentPlan.planSha256 !== plan.planSha256) {
          throw new Error("ledger_epoch_plan_drift");
        }
      }
      return lockedCurrentPlan;
    };
    if (plan.transactionVersion !== 2) {
      if (lockedActiveRoot === oldRoot) await rebuildCurrentPlanOnce();
      await assertConsumedOutputLedgerEpochPreparedArtifacts(plan);
      await assertConsumedOutputLedgerEpochOrphanBindingsUnchanged(plan);
      authoritative = await rebuildLockedFacts();
      processEvidence = authoritative.evidence;
      upgradedLegacyAdmission = buildLedgerEpochLegacyAdmissionAnchor({
        snapshot: authoritative.admission,
        cutoff,
        processEvidence,
      });
      if (plan.planSha256 === SOCIAL_PROPOSED_ADMISSION_PLAN_SHA256) {
        // The v2 provenance sidecar predates this exception and is immutable.
        // Validate it intrinsically, then publish the independent anchor while
        // all controller, debt, maintenance and ledger mutation locks are held.
        const sourceOrphanSeal = await verifySocialPreparedV1SourceOrphanSeal(plan);
        if (lockedActiveRoot === oldRoot) {
          const rebuilt = await buildSocialProposedAdmissionAnchor({
            plan,
            snapshot: authoritative.proposedAdmission!,
            controllerJobRootDir: locked.controller.jobRootDir,
            debtCustody,
            sourceOrphanSeal,
          });
          if (rebuilt?.anchorSha256 !== expectedProposedAdmissionAnchorSha256) {
            throw new Error("ledger_epoch_proposed_admission_expected_anchor_hash_mismatch");
          }
        }
        await createOrVerifySocialProposedAdmissionAnchor({
          plan,
          snapshot: authoritative.proposedAdmission!,
          controllerJobRootDir: locked.controller.jobRootDir,
          debtCustody,
          sourceOrphanSeal,
          expectedAnchorSha256: expectedProposedAdmissionAnchorSha256!,
        });
        proposedAdmissionAnchor = await readSocialProposedAdmissionAnchor(
          plan,
          expectedProposedAdmissionAnchorSha256!,
        );
        if (!proposedAdmissionAnchor) {
          throw new Error("ledger_epoch_proposed_admission_anchor_missing");
        }
        assertSocialProposedAdmissionSourceOrphanSeal(proposedAdmissionAnchor,
          sourceOrphanSeal);
        await verifySocialProposedAdmissionAnchorEvidence(proposedAdmissionAnchor);
        normalizeAnchoredProposedAdmission({
          anchor: proposedAdmissionAnchor,
          snapshot: authoritative.proposedAdmission!,
        });
      } else {
        const crashAfter = deps.preparedV1UpgradeCrashAfter?.();
        await upgradePreparedEpochV1({
          plan,
          ...(upgradedLegacyAdmission
            ? { legacyAdmission: upgradedLegacyAdmission }
            : {}),
          debtCustody,
          processEvidence,
          expectedPlanSha256,
          ...(crashAfter === undefined ? {} : { crashAfter }),
          ...(deps.preparedV1UpgradeCrashBoundary ? {
            crashBoundary: deps.preparedV1UpgradeCrashBoundary,
          } : {}),
        });
        await assertPreparedEpochV2Sidecar(
          plan,
          processEvidence,
          upgradedLegacyAdmission,
          debtCustody,
        );
      }
    } else if (plan.legacyAdmission && JSON.stringify(plan.legacyAdmission) !==
        JSON.stringify(upgradedLegacyAdmission)) {
      throw new Error("ledger_epoch_legacy_admission_drift");
    }
    const admissionBefore = await admissionSummary({
      registryRootDir: loaded.registryRootDir,
      scope: { ...locked.scope, consumedOutputLedgerRoots: [oldRoot] },
      controllerJobId: lockedControllerJobId,
      deps: deps.admissionDeps,
      snapshotBuilder: deps.buildAdmissionSnapshot,
    });
    const revalidateProposedSnapshot = proposedAdmissionAnchor
      ? async (snapshot: ProjectAdmissionSnapshot) => {
          const currentSummaries = await listCodexGoalJobs({
            registryRootDir: locked.registryRootDir,
          });
          const currentCustody = await resolveLedgerEpochDebtCustody(
            snapshot,
            currentSummaries,
          );
          assertSocialProposedAdmissionDebtCustody(
            proposedAdmissionAnchor,
            currentCustody,
          );
          const sourceSeal = await verifySocialPreparedV1SourceOrphanSeal(plan);
          assertSocialProposedAdmissionSourceOrphanSeal(
            proposedAdmissionAnchor,
            sourceSeal,
          );
          await verifySocialProposedAdmissionAnchorEvidence(proposedAdmissionAnchor);
        }
      : undefined;
    result = await applyConsumedOutputLedgerEpoch({
      plan,
      ...(plan.transactionVersion === 2
        ? {}
        : upgradedLegacyAdmission
        ? { upgradedLegacyAdmission }
        : {}),
      expectedPlanSha256,
      ...(proposedAdmissionAnchor
        ? {
          expectedProposedAdmissionAnchorSha256:
            expectedProposedAdmissionAnchorSha256!,
        }
        : {}),
      buildCurrentPlan: async () => {
        const current = await rebuildCurrentPlanOnce();
        if (plan.transactionVersion !== 2) {
          if (plan.planSha256 === SOCIAL_PROPOSED_ADMISSION_PLAN_SHA256) {
            await verifySocialPreparedV1SourceOrphanSeal(plan);
          } else {
            await assertPreparedEpochV2Sidecar(
              plan,
              processEvidence,
              upgradedLegacyAdmission,
              debtCustody,
            );
          }
        }
        return current;
      },
      admissionBefore,
      validateProposedAdmission: async () => await admissionSummary({
        registryRootDir: locked.registryRootDir,
        scope: lockedProposedScope,
        controllerJobId: lockedControllerJobId,
        deps: deps.admissionDeps,
        snapshotBuilder: deps.buildAdmissionSnapshot,
        rejectBlocking: true,
        allowPendingEpochOrphanQuarantine: true,
        ...(proposedAdmissionAnchor ? { proposedAdmissionAnchor } : {}),
        ...(revalidateProposedSnapshot
          ? { revalidateBeforeNormalization: revalidateProposedSnapshot }
          : {}),
      }),
      admissionForNewRoot: async () => await admissionSummary({
        registryRootDir: locked.registryRootDir,
        scope: lockedProposedScope,
        controllerJobId: lockedControllerJobId,
        deps: deps.admissionDeps,
        snapshotBuilder: deps.buildAdmissionSnapshot,
        rejectBlocking: true,
        allowPendingEpochOrphanQuarantine: true,
        ...(proposedAdmissionAnchor ? { proposedAdmissionAnchor } : {}),
        ...(revalidateProposedSnapshot
          ? { revalidateBeforeNormalization: revalidateProposedSnapshot }
          : {}),
      }),
      readActiveRoot: async () => {
        const current = await deps.loadProjectControlController(args);
        if (current.controller.jobId !== lockedControllerJobId) {
          throw new Error("ledger_epoch_controller_job_id_mismatch");
        }
        if (manifestFingerprint(current.controller) !== lockedManifestFingerprint) {
          throw new Error("ledger_epoch_controller_manifest_cas_mismatch");
        }
        if (stableControllerFingerprint(current.controller) !==
          plan.controllerStableScopeSha256) {
          throw new Error("ledger_epoch_controller_stable_scope_drift");
        }
        const roots = current.scope.consumedOutputLedgerRoots ?? [];
        if (roots.length !== 1) throw new Error("ledger_epoch_controller_scope_drift");
        return await canonicalConsumedOutputLedgerRoot(roots[0]!, true);
      },
      revalidateBeforeMutation: async () => {
        await rebuildLockedFacts();
        if (proposedAdmissionAnchor) {
          const sourceOrphanSeal = await verifySocialPreparedV1SourceOrphanSeal(plan);
          assertSocialProposedAdmissionSourceOrphanSeal(proposedAdmissionAnchor,
            sourceOrphanSeal);
          await verifySocialProposedAdmissionAnchorEvidence(proposedAdmissionAnchor);
        }
        await admissionSummary({
          registryRootDir: locked.registryRootDir,
          scope: lockedProposedScope,
          controllerJobId: lockedControllerJobId,
          deps: deps.admissionDeps,
          snapshotBuilder: deps.buildAdmissionSnapshot,
          rejectBlocking: true,
          allowPendingEpochOrphanQuarantine: true,
          ...(currentOperationWillPublishNewRoot
            ? { unpublishedLedgerRoot: newRoot }
            : {}),
          ...(proposedAdmissionAnchor ? { proposedAdmissionAnchor } : {}),
          ...(revalidateProposedSnapshot
            ? { revalidateBeforeNormalization: revalidateProposedSnapshot }
            : {}),
        });
      },
      switchScope: async () => {
        const current = await deps.loadProjectControlController(args);
        if (current.controller.jobId !== lockedControllerJobId) {
          throw new Error("ledger_epoch_controller_job_id_mismatch");
        }
        if (manifestFingerprint(current.controller) !== lockedManifestFingerprint) {
          throw new Error("ledger_epoch_controller_manifest_cas_mismatch");
        }
        await assertControllerLedgerRootState(current.scope, oldRoot, oldRoot);
        if (!controllerFence) throw new Error("controller_maintenance_fence_missing");
        await publishCodexGoalLedgerScopeUnderMaintenance({
          registryRootDir: locked.registryRootDir,
          manifestPath: fencedManifestPath,
          expectedManifestSha256: fencedManifestSha256,
          controllerJobId: lockedControllerJobId,
          fence: controllerFence,
          consumedOutputLedgerRoot: newRoot,
        });
      },
      revalidatePostSwitchBindings: async () => {
        const current = await deps.loadProjectControlController(args);
        if (
          stableControllerFingerprint(current.controller) !==
            plan.controllerStableScopeSha256
        ) {
          throw new Error("ledger_epoch_controller_stable_scope_drift");
        }
        const summaries = await listCodexGoalJobs({
          registryRootDir: current.registryRootDir,
        });
        if (proposedAdmissionAnchor) {
          const snapshot = await buildAdmissionSnapshot({
            registryRootDir: current.registryRootDir,
            scope: lockedProposedScope,
            controllerJobId: lockedControllerJobId,
            admissionDeps: deps.admissionDeps,
            snapshotBuilder: deps.buildAdmissionSnapshot,
            allowPendingEpochOrphanQuarantine: true,
          });
          normalizeAnchoredProposedAdmission({
            anchor: proposedAdmissionAnchor,
            snapshot,
          });
          const currentCustody = await resolveLedgerEpochDebtCustody(snapshot, summaries);
          assertSocialProposedAdmissionDebtCustody(
            proposedAdmissionAnchor,
            currentCustody,
          );
          const sourceOrphanSeal = await verifySocialPreparedV1SourceOrphanSeal(plan);
          assertSocialProposedAdmissionSourceOrphanSeal(
            proposedAdmissionAnchor,
            sourceOrphanSeal,
          );
          await verifySocialProposedAdmissionAnchorEvidence(proposedAdmissionAnchor);
        } else {
          await assertLedgerEpochDebtCustodyUnchanged(debtCustody);
        }
        const ids = summaries
          .filter((summary) => matchesProjectControlPrefix(
            summary.jobId,
            current.scope.jobIdPrefixes ?? [],
          ))
          .map((summary) => summary.jobId)
          .sort();
        if (
          ids.length !== plan.registryJobCount ||
          sha256Json(ids) !== plan.registryJobIdsSha256
        ) {
          throw new Error("ledger_epoch_registry_snapshot_drift");
        }
      },
    });
  } catch (error) {
    operationError = error;
  }
  const releaseFailures: unknown[] = [];
  const release = async (action: () => Promise<void>) => {
    try {
      await action();
    } catch (error) {
      releaseFailures.push(error);
    }
  };
  if (mutationLease) await release(async () =>
    await mutationLocks.release(mutationLease));
  if (maintenanceLease) await release(async () =>
    await releaseConsumedOutputLedgerMaintenanceLock(maintenanceLease));
  if (controllerFence) await release(async () =>
    await releaseLocalControllerMaintenanceFence(controllerFence));
  for (const debtLock of [...debtLocks].reverse()) {
    await release(async () => await locks.release(debtLock));
  }
  await release(async () => await locks.release(lock));
  if (operationError) throw operationError;
  if (releaseFailures.length > 0) {
    throw new Error("ledger_epoch_lock_release_failed", {
      cause: releaseFailures[0],
    });
  }
  if (!result) throw new Error("ledger_epoch_apply_result_missing");
  return {
    ok: true,
    mode: "project_control_consumed_output_ledger_epoch",
    idempotentReplay: result.idempotentReplay,
    receipt: result.receipt as unknown as JsonObject,
    ...(result.receipt.proposedAdmissionAnchorSha256
      ? { proposedAdmissionAnchorSha256:
          result.receipt.proposedAdmissionAnchorSha256 }
      : {}),
  };
}
async function buildCurrentPlanFor(
  persisted: Awaited<ReturnType<typeof buildConsumedOutputLedgerEpochPlan>>,
  build: (
    transactionVersion?: 1 | 2,
    preboundOrphanWorkspaceBindings?: Awaited<ReturnType<
      typeof buildConsumedOutputLedgerEpochPlan
    >>["orphanWorkspaceBindings"],
  ) => Promise<Awaited<ReturnType<typeof buildConsumedOutputLedgerEpochPlan>>>,
) {
  return await build(
    persisted.transactionVersion === 2 ? 2 : 1,
    persisted.orphanWorkspaceBindings,
  );
}

async function captureEpochProcessEvidence(
  deps: ProjectControlLedgerEpochDeps,
  custodyPaths: readonly string[],
): Promise<LegacyAttemptProcessEvidence> {
  const paths = [...new Set(custodyPaths.map((path) => resolve(path)))].sort();
  return deps.captureProcessEvidence
    ? await deps.captureProcessEvidence(paths)
    : await captureLegacyAttemptProcessEvidence({ custodyPaths: paths });
}

function assertEpochProcessEvidenceClear(
  evidence: LegacyAttemptProcessEvidence,
  custodyPaths: readonly string[],
): void {
  if (JSON.stringify(evidence.custodyPaths) !== JSON.stringify(custodyPaths) ||
    evidence.blockers.length !== 0) {
    throw new Error("ledger_epoch_process_inventory_drift");
  }
}

function assertPersistedPlanOwned(input: {
  readonly plan: Awaited<ReturnType<typeof buildConsumedOutputLedgerEpochPlan>>;
  readonly controller: CodexGoalJobManifest;
  readonly scope: ProjectAccessScope;
  readonly oldRoot: string;
  readonly newRoot: string;
  readonly cutoff: string;
}): void {
  if (
    input.plan.controllerJobId !== input.controller.jobId ||
    input.plan.projectId !== input.scope.projectId ||
    resolve(input.plan.oldRoot) !== input.oldRoot ||
    resolve(input.plan.newRoot) !== input.newRoot ||
    input.plan.cutoff !== new Date(Date.parse(input.cutoff)).toISOString() ||
    input.plan.controllerStableScopeSha256 !==
      stableControllerFingerprint(input.controller)
  ) {
    throw new Error("ledger_epoch_persisted_plan_ownership_mismatch");
  }
}

export function controllerScopeLockIdentity(
  registryRootDir: string,
  controllerJobId: string,
): string {
  return codexGoalJobManifestPath({ registryRootDir, jobId: controllerJobId });
}

async function assertControllerQuiescent(
  jobRootDir: string,
  quarantine: ActiveLegacyAttemptQuarantine,
): Promise<void> {
  await assertJsonRecordsTerminal(
    join(jobRootDir, "project-control-operations"),
    "operation.json",
    new Set(["completed", "failed"]),
    "ledger_epoch_project_control_operation_in_flight",
  );
  if (quarantine.debt.length > 0) {
    const plans = await Promise.all([...new Set(quarantine.debt.map((item) =>
      item.planSha256
    ))].map(async (planSha256) => await loadLegacyAttemptQuarantinePlan({
      controllerJobRootDir: jobRootDir,
      expectedPlanSha256: planSha256,
    })));
    const custodyPaths = [...new Set(plans.flatMap((plan) =>
      plan.entries.flatMap((entry) => [
        entry.sourceWorkspace.declaredPath,
        entry.targetWorkspace.declaredPath,
        entry.workerLifecycle.workerJobRootDir,
      ])
    ))].sort();
    const evidence = await captureLegacyAttemptProcessEvidence({ custodyPaths });
    if (evidence.blockers.length > 0) {
      throw new Error("ledger_epoch_quarantined_attempt_process_active");
    }
  }
  await assertJsonRecordsTerminal(
    join(jobRootDir, "project-integration", "integration-attempts"),
    "attempt.json",
    new Set(["pushed", "rejected"]),
    "ledger_epoch_integration_attempt_in_flight",
    quarantine.attemptIds,
  );
}


function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}
