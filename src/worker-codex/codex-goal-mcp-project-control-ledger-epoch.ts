import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import {
  ProjectDebtReason,
  summarizeProjectAdmissionDebt,
  type ProjectAccessScope,
  type ProjectAdmissionSnapshot,
} from "@vioxen/subscription-runtime/worker-core";
import {
  acquireConsumedOutputLedgerMaintenanceLock,
  LocalConsumedOutputLedgerMutationLock,
  releaseConsumedOutputLedgerMaintenanceLock,
} from "@vioxen/subscription-runtime/worker-local";
import {
  acquireLocalControllerMaintenanceFence,
  releaseLocalControllerMaintenanceFence,
} from "@vioxen/subscription-runtime/store-local-file";
import {
  buildCodexProjectAdmissionSnapshot,
  type CodexProjectAdmissionDeps,
} from "./application/project-control/codex-goal-project-admission";
import {
  applyConsumedOutputLedgerEpoch,
  assertConsumedOutputLedgerEpochOrphanBindingsUnchanged,
  assertConsumedOutputLedgerEpochPreparedArtifacts,
  buildConsumedOutputLedgerEpochPlan,
  canonicalConsumedOutputLedgerRoot,
  resolvePendingConsumedOutputLedgerEpochPlan,
  type ConsumedOutputLedgerEpochAdmissionSummary,
} from "./application/project-control/codex-goal-consumed-output-ledger-epoch";
import {
  codexGoalJobManifestPath,
  listCodexGoalJobs,
  updateCodexGoalJob,
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
  assertLedgerEpochDebtCustodyUnchanged,
  resolveLedgerEpochDebtCustody,
  type LedgerEpochDebtCustodyBinding,
} from "./application/project-control/codex-goal-consumed-output-ledger-epoch-switch";

type JsonObject = Readonly<Record<string, unknown>>;

type LoadedController = {
  readonly registryRootDir: string;
  readonly controller: CodexGoalJobManifest;
  readonly scope: ProjectAccessScope;
};

export type ProjectControlLedgerEpochDeps = {
  readonly loadProjectControlController: (
    args: ProjectControlMcpArgs,
  ) => Promise<LoadedController>;
  readonly admissionDeps: CodexProjectAdmissionDeps;
  readonly buildAdmissionSnapshot?: (input: {
    readonly registryRootDir: string;
    readonly scope: ProjectAccessScope;
    readonly allowPendingEpochOrphanQuarantine?: boolean;
  }) => Promise<ProjectAdmissionSnapshot>;
  readonly assertNoLegacyWriterProcesses?: () => Promise<void>;
  readonly captureProcessEvidence?: (
    custodyPaths: readonly string[],
  ) => Promise<LegacyAttemptProcessEvidence>;
  /** Deterministic crash boundary used only by restart certification. */
  readonly preparedV1UpgradeCrashAfter?: () => string | undefined;
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
  const buildPlan = async (
    transactionVersion: 1 | 2 = 2,
    preboundOrphanWorkspaceBindings?: Awaited<ReturnType<
      typeof buildConsumedOutputLedgerEpochPlan
    >>["orphanWorkspaceBindings"],
  ) => {
    const current = await deps.loadProjectControlController(args);
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
      legacyAttemptQuarantine: plan.legacyAttemptQuarantine,
      legacyAdmission: plan.legacyAdmission,
      upgradeRequired: plan.transactionVersion !== 2,
    };
  }
  const expectedPlanSha256 = stringValue(args.expectedLedgerEpochPlanSha256);
  if (!expectedPlanSha256) {
    throw new Error("ledger_epoch_expected_plan_sha256_required");
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
  let controllerFence;
  let operationError: unknown;
  const debtLocks: Array<Awaited<ReturnType<typeof locks.acquire>>> = [];
  try {
    const locked = await deps.loadProjectControlController(args);
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
    await (deps.assertNoLegacyWriterProcesses
      ? deps.assertNoLegacyWriterProcesses()
      : assertNoLedgerEpochWriterProcesses({
          registryRootDir: locked.registryRootDir,
          controllerJobId: locked.controller.jobId,
          ledgerRoot: oldRoot,
          selfPid: process.pid,
        }));
    const lockedAdmission = await buildAdmissionSnapshot({
      registryRootDir: locked.registryRootDir,
      scope: { ...locked.scope, consumedOutputLedgerRoots: [oldRoot] },
      admissionDeps: deps.admissionDeps,
      snapshotBuilder: deps.buildAdmissionSnapshot,
    });
    const lockedSummaries = await listCodexGoalJobs({
      registryRootDir: locked.registryRootDir,
    });
    const debtCustody = await resolveLedgerEpochDebtCustody(
      lockedAdmission,
      lockedSummaries,
    );
    const debtPaths = custodyPathsFor(debtCustody, oldRoot, newRoot);
    const preliminaryProcessEvidence = await captureEpochProcessEvidence(
      deps,
      debtPaths,
    );
    for (const path of debtPaths) {
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
    const rebuildLockedFacts = async () => {
      const currentController = await deps.loadProjectControlController(args);
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
        admissionDeps: deps.admissionDeps,
        snapshotBuilder: deps.buildAdmissionSnapshot,
      });
      if (JSON.stringify(currentAdmission.debt) !== JSON.stringify(lockedAdmission.debt)) {
        throw new Error("ledger_epoch_admission_debt_drift");
      }
      const currentEvidence = await captureEpochProcessEvidence(deps, debtPaths);
      if (currentEvidence.inventorySha256 !== preliminaryProcessEvidence.inventorySha256 ||
        currentEvidence.inspectedPidCount !== preliminaryProcessEvidence.inspectedPidCount ||
        JSON.stringify(currentEvidence.custodyPaths) !==
          JSON.stringify(preliminaryProcessEvidence.custodyPaths) ||
        JSON.stringify(currentEvidence.blockers) !==
          JSON.stringify(preliminaryProcessEvidence.blockers)) {
        throw new Error("ledger_epoch_process_inventory_drift");
      }
      const reboundController = await deps.loadProjectControlController(args);
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
      return { admission: currentAdmission, evidence: currentEvidence };
    };
    let authoritative = await rebuildLockedFacts();
    let processEvidence = authoritative.evidence;
    let upgradedLegacyAdmission = buildLedgerEpochLegacyAdmissionAnchor({
      snapshot: authoritative.admission,
      cutoff,
      processEvidence,
    });
    if (plan.transactionVersion !== 2 && !upgradedLegacyAdmission) {
      throw new Error("ledger_epoch_legacy_admission_required");
    }
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
      if (!upgradedLegacyAdmission) {
        throw new Error("ledger_epoch_legacy_admission_required");
      }
      const crashAfter = deps.preparedV1UpgradeCrashAfter?.();
      await upgradePreparedEpochV1({
        plan,
        legacyAdmission: upgradedLegacyAdmission!,
        debtCustody,
        processEvidence,
        expectedPlanSha256,
        ...(crashAfter === undefined ? {} : { crashAfter }),
      });
      await assertPreparedEpochV2Sidecar(
        plan,
        processEvidence,
        upgradedLegacyAdmission!,
        debtCustody,
      );
    } else if (plan.legacyAdmission && JSON.stringify(plan.legacyAdmission) !==
        JSON.stringify(upgradedLegacyAdmission)) {
      throw new Error("ledger_epoch_legacy_admission_drift");
    }
    const boundLegacyAdmission = plan.legacyAdmission ?? upgradedLegacyAdmission;
    const admissionBefore = await admissionSummary({
      registryRootDir: loaded.registryRootDir,
      scope: { ...locked.scope, consumedOutputLedgerRoots: [oldRoot] },
      deps: deps.admissionDeps,
      snapshotBuilder: deps.buildAdmissionSnapshot,
    });
    result = await applyConsumedOutputLedgerEpoch({
      plan,
      ...(plan.transactionVersion === 2
        ? {}
        : { upgradedLegacyAdmission: upgradedLegacyAdmission! }),
      expectedPlanSha256,
      buildCurrentPlan: async () => {
        const current = await rebuildCurrentPlanOnce();
        if (plan.transactionVersion !== 2) {
          await assertPreparedEpochV2Sidecar(
            plan,
            processEvidence,
            upgradedLegacyAdmission!,
            debtCustody,
          );
        }
        return current;
      },
      admissionBefore,
      validateProposedAdmission: async () => await admissionSummary({
        registryRootDir: locked.registryRootDir,
        scope: lockedProposedScope,
        deps: deps.admissionDeps,
        snapshotBuilder: deps.buildAdmissionSnapshot,
        rejectBlocking: true,
        allowPendingEpochOrphanQuarantine: true,
      }),
      admissionForNewRoot: async () => await admissionSummary({
        registryRootDir: locked.registryRootDir,
        scope: lockedProposedScope,
        deps: deps.admissionDeps,
        snapshotBuilder: deps.buildAdmissionSnapshot,
        rejectBlocking: true,
        allowPendingEpochOrphanQuarantine: true,
      }),
      readActiveRoot: async () => {
        const current = await deps.loadProjectControlController(args);
        const roots = current.scope.consumedOutputLedgerRoots ?? [];
        if (roots.length !== 1) throw new Error("ledger_epoch_controller_scope_drift");
        return await canonicalConsumedOutputLedgerRoot(roots[0]!, true);
      },
      revalidateBeforeMutation: async () => {
        await rebuildLockedFacts();
      },
      switchScope: async () => {
        const current = await deps.loadProjectControlController(args);
        if (manifestFingerprint(current.controller) !== lockedManifestFingerprint) {
          throw new Error("ledger_epoch_controller_manifest_cas_mismatch");
        }
        await assertControllerLedgerRootState(current.scope, oldRoot, oldRoot);
        await updateCodexGoalJob({
          registryRootDir: locked.registryRootDir,
          jobId: locked.controller.jobId,
          patch: { projectAccessScope: lockedProposedScope },
        });
      },
      revalidatePostSwitchBindings: async () => {
        await assertLedgerEpochDebtCustodyUnchanged(debtCustody);
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
        if (boundLegacyAdmission) {
          const currentEvidence = await captureEpochProcessEvidence(
            deps,
            boundLegacyAdmission.processCustodyPaths,
          );
          if (currentEvidence.inventorySha256 !==
              boundLegacyAdmission.processInventorySha256 ||
            currentEvidence.inspectedPidCount !==
              boundLegacyAdmission.inspectedPidCount) {
            throw new Error("ledger_epoch_process_inventory_drift");
          }
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

function custodyPathsFor(
  bindings: readonly LedgerEpochDebtCustodyBinding[],
  oldRoot: string,
  newRoot: string,
): readonly string[] {
  return [...new Set([
    oldRoot,
    newRoot,
    ...bindings.map((binding) => binding.canonicalPath),
  ].map((path) => resolve(path)))].sort();
}

async function directoryIdentity(path: string, allowMissing = false) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (allowMissing && isNodeError(error, "ENOENT")) {
      return { canonicalPath: resolve(path), present: false as const };
    }
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("ledger_epoch_target_root_identity_drift");
  }
  return {
    canonicalPath: await realpath(path),
    device: metadata.dev,
    inode: metadata.ino,
  };
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

function manifestFingerprint(manifest: CodexGoalJobManifest): string {
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

function stableControllerFingerprint(manifest: CodexGoalJobManifest): string {
  const scope = manifest.projectAccessScope
    ? { ...manifest.projectAccessScope, consumedOutputLedgerRoots: undefined }
    : undefined;
  return sha256Json({ ...manifest, updatedAt: undefined, projectAccessScope: scope });
}

function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function admissionSummary(input: {
  readonly registryRootDir: string;
  readonly scope: ProjectAccessScope;
  readonly deps: CodexProjectAdmissionDeps;
  readonly snapshotBuilder: ProjectControlLedgerEpochDeps["buildAdmissionSnapshot"];
  readonly rejectBlocking?: boolean;
  readonly allowPendingEpochOrphanQuarantine?: boolean;
}): Promise<ConsumedOutputLedgerEpochAdmissionSummary> {
  const snapshot = await buildAdmissionSnapshot({
    registryRootDir: input.registryRootDir,
    scope: input.scope,
    admissionDeps: input.deps,
    snapshotBuilder: input.snapshotBuilder,
    ...(input.allowPendingEpochOrphanQuarantine === undefined
      ? {}
      : {
          allowPendingEpochOrphanQuarantine:
            input.allowPendingEpochOrphanQuarantine,
        }),
  });
  if (input.rejectBlocking && snapshot.debt.some((item) => item.severity === "blocking")) {
    throw new Error("ledger_epoch_proposed_admission_blocked");
  }
  return {
    debtCount: snapshot.debt.length,
    counts: snapshot.counts ?? summarizeProjectAdmissionDebt(snapshot.debt).counts,
  };
}

async function buildAdmissionSnapshot(input: {
  readonly registryRootDir: string;
  readonly scope: ProjectAccessScope;
  readonly admissionDeps: CodexProjectAdmissionDeps;
  readonly snapshotBuilder: ProjectControlLedgerEpochDeps["buildAdmissionSnapshot"];
  readonly allowPendingEpochOrphanQuarantine?: boolean;
}): Promise<ProjectAdmissionSnapshot> {
  if (input.snapshotBuilder) {
    return await input.snapshotBuilder({
      registryRootDir: input.registryRootDir,
      scope: input.scope,
      ...(input.allowPendingEpochOrphanQuarantine === undefined
        ? {}
        : {
            allowPendingEpochOrphanQuarantine:
              input.allowPendingEpochOrphanQuarantine,
          }),
    });
  }
  return await buildCodexProjectAdmissionSnapshot({
    registryRootDir: input.registryRootDir,
    scope: input.scope,
    deps: input.admissionDeps,
    ...(input.allowPendingEpochOrphanQuarantine === undefined
      ? {}
      : {
          allowPendingEpochOrphanQuarantine:
            input.allowPendingEpochOrphanQuarantine,
        }),
  });
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

async function assertJsonRecordsTerminal(
  root: string,
  fileName: string,
  terminal: ReadonlySet<string>,
  errorCode: string,
  quarantinedIds: ReadonlySet<string> = new Set(),
): Promise<void> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(errorCode);
    const value: unknown = JSON.parse(
      await readFile(join(root, entry.name, fileName), "utf8"),
    );
    if (!isRecord(value) || typeof value.status !== "string" ||
      (!terminal.has(value.status) &&
        (typeof value.attemptId !== "string" || !quarantinedIds.has(value.attemptId)))) {
      throw new Error(errorCode);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

async function assertCanonicalLedgerRootsAllowed(
  scope: ProjectAccessScope,
  oldRoot: string,
  newRoot: string,
): Promise<void> {
  const allowed = await Promise.all([
    ...(scope.readRoots ?? []),
    ...(scope.workspaceRoots ?? []),
    ...(scope.worktreeRoots ?? []),
    ...(scope.observedWorkspaceRoots ?? []),
  ].map(async (root) => await canonicalConsumedOutputLedgerRoot(root, true)));
  const denied = await Promise.all((scope.deniedRoots ?? []).map(
    async (root) => await canonicalConsumedOutputLedgerRoot(root, false),
  ));
  if (
    !allowed.some((root) => pathInside(oldRoot, root)) ||
    !allowed.some((root) => pathInside(newRoot, root)) ||
    denied.some((root) =>
      pathInside(oldRoot, root) || pathInside(newRoot, root) ||
      pathInside(root, oldRoot) || pathInside(root, newRoot)
    )
  ) {
    throw new Error("ledger_epoch_root_outside_canonical_scope");
  }
}

function pathInside(path: string, root: string): boolean {
  const child = relative(root, path);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`));
}

async function assertControllerLedgerRootState(
  scope: ProjectAccessScope,
  oldRoot: string,
  newRoot: string,
): Promise<void> {
  const roots = await Promise.all((scope.consumedOutputLedgerRoots ?? []).map(
    async (root) => await canonicalConsumedOutputLedgerRoot(root, true),
  ));
  if (roots.length !== 1 || (roots[0] !== oldRoot && roots[0] !== newRoot)) {
    throw new Error("ledger_epoch_controller_scope_drift");
  }
}

async function assertPreparedStateForActiveRoot(
  scope: ProjectAccessScope,
  newRoot: string,
  hasPersistedPlan: boolean,
): Promise<void> {
  const configured = scope.consumedOutputLedgerRoots ?? [];
  if (configured.length !== 1) throw new Error("ledger_epoch_controller_scope_drift");
  const active = await canonicalConsumedOutputLedgerRoot(configured[0]!, true);
  if (active === newRoot && !hasPersistedPlan) {
    throw new Error("ledger_epoch_prepared_state_required");
  }
}
