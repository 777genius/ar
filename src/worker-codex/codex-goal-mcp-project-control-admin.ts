import { lstat, readdir } from "node:fs/promises";
import {
  LocalConsumedOutputLedgerMutationLock,
} from "@vioxen/subscription-runtime/worker-local";
import {
  AccessBoundary,
  ProjectAdmissionWorkerRole,
  ProjectOperation,
  evaluateProjectAdmission,
  type ProjectAccessScope,
} from "@vioxen/subscription-runtime/worker-core";
import {
  codexGoalJobToArgs,
  readCodexGoalJob,
  summarizeCodexGoalJob,
  updateCodexGoalJob,
  type CodexGoalJobManifest,
  type CodexGoalJobManifestPatch,
  type CodexGoalJobSummary,
} from "./codex-goal-jobs";
import {
  collectCodexGoalStatus,
  listCodexGoalAccountStatuses,
  resolveCodexGoalWorkerLiveness,
} from "./codex-goal-ops";
import { goalLaunchInput } from "./codex-goal-mcp-launch-input";
import { codexGoalStatusInputFromLaunch } from "./codex-goal-mcp-status-input";
import {
  assertReviewedWorkerContinuationEnvironmentLocked,
  assertReviewedWorkerOutputStillMatchesLocked,
  localReviewedWorkerOutputDeps,
  resolveReviewedWorkerContinuation,
  reviewedWorkerOutputRoot,
} from "./reviewed-worker-output";
import {
  projectControlWorkspaceLocks,
  withValidatedProjectWorkspaceLock,
} from "./codex-goal-project-workspace-lock";
import { projectControlCanonicalWorkspacePath } from "./application/project-control/codex-goal-project-workspace-scope";
import { rebindProjectPreStartAdmissionManifest } from "./application/project-control/codex-goal-project-pre-start-admission";
import { isAdmittedInputPatchCapacityContinuation } from "./application/project-control/codex-goal-project-admitted-input-patch-continuation";
import {
  parseCodexGoalProjectAccessScope,
} from "./codex-goal-access-plan";
import {
  accountNames,
  booleanValue,
  requiredRawString,
  stringValue,
  tagValues,
} from "./codex-goal-mcp-values";
import type {
  JobUpdateMcpArgs,
  ProjectControlMcpArgs,
} from "./codex-goal-mcp-inputs";
import {
  projectControlAuditPath,
} from "./codex-goal-mcp-project-broker";
import {
  buildCodexProjectAdmissionSnapshot,
  projectAdmissionDetailView,
  projectAdmissionOperation,
  projectAdmissionWorkerRoleArg,
  type CodexProjectAdmissionDeps,
} from "./application/project-control/codex-goal-project-admission";
import {
  assertProjectControlScopeRepairAllowed,
  projectControlAddedAllowedAccountIds,
  projectScopeFieldFingerprint,
} from "./codex-goal-mcp-project-scope";
import {
  projectControlDefaultAccountNames,
} from "./codex-goal-mcp-project-accounts";
import {
  matchesProjectControlPrefix,
  pathInsideAnyProjectRoot,
} from "./codex-goal-mcp-project-utils";
import {
  buildCodexProjectOperationsSnapshot,
} from "./application/project-control/codex-goal-project-operations-snapshot";
import {
  repairLegacyConsumedOutputDebt,
  type LegacyConsumedOutputCandidate,
  type LegacyConsumedOutputProof,
} from "./application/project-control/legacy-consumed-output-repair";

type JsonObject = Readonly<Record<string, unknown>>;

export type ProjectControlRepairWorkspaceMode =
  | "clean_capacity_continuation"
  | "reviewed_dirty_continuation"
  | "admitted_input_patch_continuation";

export function resolveProjectControlRepairWorkspaceMode(input: {
  readonly workspaceDirty: boolean;
  readonly reviewedOutputId?: string;
  readonly admittedInputPatchCapacityContinuation: boolean;
}): ProjectControlRepairWorkspaceMode {
  if (!input.workspaceDirty) {
    return "clean_capacity_continuation";
  }
  if (input.reviewedOutputId !== undefined) {
    return "reviewed_dirty_continuation";
  }
  return input.admittedInputPatchCapacityContinuation
    ? "admitted_input_patch_continuation"
    : "reviewed_dirty_continuation";
}

type LoadedProjectControlController = {
  readonly registryRootDir: string;
  readonly controller: CodexGoalJobManifest;
  readonly scope: ProjectAccessScope;
};

export type CodexGoalMcpProjectControlAdminDeps = {
  readonly loadProjectControlController: (
    args: ProjectControlMcpArgs,
  ) => Promise<LoadedProjectControlController>;
  readonly admissionDeps: CodexProjectAdmissionDeps;
};

export async function projectControlAdmissionSnapshotView(
  args: ProjectControlMcpArgs,
  deps: CodexGoalMcpProjectControlAdminDeps,
): Promise<JsonObject> {
  const controller = await deps.loadProjectControlController(args);
  const snapshot = await buildCodexProjectAdmissionSnapshot({
    registryRootDir: controller.registryRootDir,
    scope: controller.scope,
    deps: deps.admissionDeps,
  });
  const operation = projectAdmissionOperation(args.operation);
  const workerRole = projectAdmissionWorkerRoleArg(args.workerRole);
  const decision = operation
    ? evaluateProjectAdmission({
        request: {
          operation,
          projectId: controller.scope.projectId,
          ...(workerRole ? { workerRole } : {}),
        },
        snapshot,
      })
    : undefined;
  const operationalDecision = decision ?? evaluateProjectAdmission({
    request: {
      operation: ProjectOperation.CreateJob,
      projectId: controller.scope.projectId,
      workerRole: ProjectAdmissionWorkerRole.Producer,
    },
    snapshot,
  });
  const operations = await buildCodexProjectOperationsSnapshot({
    registryRootDir: controller.registryRootDir,
    scope: controller.scope,
    admissionSnapshot: snapshot,
    admissionDecision: operationalDecision,
    deps: deps.admissionDeps,
  });
  const detailView = projectAdmissionDetailView({
    snapshot,
    ...(decision ? { decision } : {}),
    includeDetails: args.includeDetails === true,
    ...(args.maxDebtItems === undefined ? {} : { maxDebtItems: args.maxDebtItems }),
  });
  return {
    ok: true,
    mode: "project_admission_snapshot",
    controllerJobId: controller.controller.jobId,
    registryRootDir: controller.registryRootDir,
    snapshot: detailView.snapshot,
    operations,
    ...(detailView.decision ? { decision: detailView.decision } : {}),
  };
}

export async function projectControlRepairLegacyOutputDebtView(
  args: ProjectControlMcpArgs,
  deps: CodexGoalMcpProjectControlAdminDeps,
): Promise<JsonObject> {
  const controller = await deps.loadProjectControlController(args);
  const ledgerRoots = controller.scope.consumedOutputLedgerRoots ?? [];
  if (ledgerRoots.length === 0) {
    throw new Error("project_control_consumed_output_ledger_roots_required");
  }
  const snapshot = await buildCodexProjectAdmissionSnapshot({
    registryRootDir: controller.registryRootDir,
    scope: controller.scope,
    deps: deps.admissionDeps,
  });
  const summaries = await deps.admissionDeps.listJobs({
    registryRootDir: controller.registryRootDir,
  });
  const summariesByJobId = new Map(summaries.map((summary) => [summary.jobId, summary]));
  const confirm = booleanValue(args.confirmLegacyOutputRepair) === true;
  const executeRepair = async () => {
    const result = await repairLegacyConsumedOutputDebt({
      projectId: controller.scope.projectId,
      registryRootDir: controller.registryRootDir,
      authorizedLedgerRoots: ledgerRoots,
      allowedJobIdPrefixes: controller.scope.jobIdPrefixes ?? [],
      admissionSnapshot: snapshot,
      confirm,
      mutationLocks: new LocalConsumedOutputLedgerMutationLock(),
      prove: async (candidate) => proveLegacyConsumedOutputSafe({
        candidate,
        registryRootDir: controller.registryRootDir,
        projectId: controller.scope.projectId,
        summariesByJobId,
        deps: deps.admissionDeps,
      }),
    });
    const verifiedSnapshot = result.quarantinedCount > 0
      ? await buildCodexProjectAdmissionSnapshot({
          registryRootDir: controller.registryRootDir,
          scope: controller.scope,
          deps: deps.admissionDeps,
        })
      : snapshot;
    return { result, verifiedSnapshot };
  };
  const { result, verifiedSnapshot } = confirm
    ? await withLegacyOutputRepairWorkspaceCustody({
        controller,
        summaries,
        deps: deps.admissionDeps,
        effect: executeRepair,
      })
    : await executeRepair();
  return {
    ...result as unknown as JsonObject,
    controllerJobId: controller.controller.jobId,
    registryRootDir: controller.registryRootDir,
    auditPath: projectControlAuditPath(controller.controller),
    admissionBefore: snapshot.counts ?? {},
    admissionAfter: verifiedSnapshot.counts ?? {},
  };
}

async function withLegacyOutputRepairWorkspaceCustody<T>(input: {
  readonly controller: LoadedProjectControlController;
  readonly summaries: readonly CodexGoalJobSummary[];
  readonly deps: CodexProjectAdmissionDeps;
  readonly effect: () => Promise<T>;
}): Promise<T> {
  const workspacePaths = new Set<string>();
  for (const summary of input.summaries) {
    if (!matchesProjectControlPrefix(
      summary.jobId,
      input.controller.scope.jobIdPrefixes ?? [],
    )) continue;
    const manifest = input.deps.readJob
      ? await input.deps.readJob({
          registryRootDir: input.controller.registryRootDir,
          jobId: summary.jobId,
        })
      : await readCodexGoalJob({
          registryRootDir: input.controller.registryRootDir,
          jobId: summary.jobId,
    });
    if (manifest.projectAccessScope?.projectId === input.controller.scope.projectId) {
      workspacePaths.add(await projectControlCanonicalWorkspacePath(
        manifest.workspacePath,
        input.controller.scope,
      ));
    }
  }
  const orderedWorkspacePaths = [...workspacePaths].sort();
  const locks = projectControlWorkspaceLocks(input.controller.registryRootDir);
  const acquireNext = async (index: number): Promise<T> => {
    const workspacePath = orderedWorkspacePaths[index];
    if (workspacePath === undefined) return await input.effect();
    return await withValidatedProjectWorkspaceLock({
      locks,
      scope: input.controller.scope,
      requestedWorkspacePath: workspacePath,
      owner: `legacy-output-repair:${input.controller.controller.jobId}`,
      effect: async () => await acquireNext(index + 1),
    });
  };
  return await acquireNext(0);
}

async function proveLegacyConsumedOutputSafe(input: {
  readonly candidate: LegacyConsumedOutputCandidate;
  readonly registryRootDir: string;
  readonly projectId: string;
  readonly summariesByJobId: ReadonlyMap<string, {
    readonly jobId: string;
    readonly manifestPath: string;
  }>;
  readonly deps: CodexProjectAdmissionDeps;
}): Promise<LegacyConsumedOutputProof> {
  const reasons: string[] = [];
  const summary = input.summariesByJobId.get(input.candidate.jobId);
  if (summary) {
    const overview = await input.deps.buildOverviewItems([{
      registryRootDir: input.registryRootDir,
      jobId: input.candidate.jobId,
      staleAfterMs: 10 * 60_000,
      tailLines: 0,
    }]);
    const item = overview[0];
    if (!item || item.workerAlive !== false) {
      reasons.push("managed worker/process liveness is not proven stopped");
    }
    try {
      const manifest = input.deps.readJob
        ? await input.deps.readJob({
            registryRootDir: input.registryRootDir,
            jobId: input.candidate.jobId,
          })
        : await readCodexGoalJob({
            registryRootDir: input.registryRootDir,
            jobId: input.candidate.jobId,
          });
      if (manifest.projectAccessScope?.projectId !== input.projectId) {
        reasons.push("current job manifest belongs to a different project");
      }
      const artifacts = await readdir(manifest.jobRootDir, { withFileTypes: true });
      if (artifacts.some((entry) =>
        entry.isFile() &&
        (/\.handoff\.(?:manifest\.json|patch)$/.test(entry.name) ||
          /\.(?:patch|diff)$/i.test(entry.name) ||
          /reviewed.*output/i.test(entry.name))
      )) {
        reasons.push("terminal handoff or reviewed output still awaits consumption");
      }
    } catch {
      reasons.push("current job manifest proof is unavailable");
    }
  }
  if (!input.candidate.workspace) {
    reasons.push("legacy record workspace identity is unavailable");
  } else {
    try {
      await lstat(input.candidate.workspace);
      reasons.push("failed legacy decision workspace still exists");
    } catch (error) {
      if (nodeErrorCode(error) !== "ENOENT") {
        reasons.push("failed legacy decision workspace absence is unprovable");
      }
    }
  }
  if (reasons.length > 0) return { eligible: false, reasons };
  return {
    eligible: true,
    evidence: [
      "admission validator classified the record as incomplete",
      summary
        ? "current registry worker is proven stopped"
        : "legacy job is absent from the current registry",
      "failed legacy workspace and pending handoff artifacts are absent",
    ],
  };
}

export async function projectControlUpdateControllerScopeView(
  args: ProjectControlMcpArgs,
  deps: CodexGoalMcpProjectControlAdminDeps,
): Promise<JsonObject> {
  const controller = await deps.loadProjectControlController(args);
  const proposedScope = parseCodexGoalProjectAccessScope(
    args.projectAccessScope,
    "projectAccessScope",
  );
  if (!proposedScope) {
    throw new Error("project_control_project_access_scope_required");
  }
  assertProjectControlScopeRepairAllowed({
    existing: controller.scope,
    proposed: proposedScope,
  });
  await assertProjectControlAddedAccountsUsable({
    existing: controller.scope,
    proposed: proposedScope,
    ...(controller.scope.authRoot ?? controller.controller.authRootDir
      ? { authRootDir: controller.scope.authRoot ?? controller.controller.authRootDir }
      : {}),
  });

  if (booleanValue(args.confirmUpdate) !== true) {
    return {
      ok: false,
      reason: "confirm_update_required",
      mode: "project_control_update_controller_scope",
      controllerJobId: controller.controller.jobId,
      registryRootDir: controller.registryRootDir,
      auditPath: projectControlAuditPath(controller.controller),
      currentConsumedOutputLedgerRoots:
        controller.scope.consumedOutputLedgerRoots ?? [],
      proposedConsumedOutputLedgerRoots:
        proposedScope.consumedOutputLedgerRoots ?? [],
    };
  }

  const manifest = await updateCodexGoalJob({
    registryRootDir: controller.registryRootDir,
    jobId: controller.controller.jobId,
    patch: { projectAccessScope: proposedScope },
  });
  return {
    ok: true,
    mode: "project_control_update_controller_scope",
    controllerJobId: controller.controller.jobId,
    registryRootDir: controller.registryRootDir,
    auditPath: projectControlAuditPath(controller.controller),
    manifest,
    summary: summarizeCodexGoalJob(manifest, controller.registryRootDir),
  };
}

async function assertProjectControlAddedAccountsUsable(input: {
  readonly existing: ProjectAccessScope;
  readonly proposed: ProjectAccessScope;
  readonly authRootDir?: string;
}): Promise<void> {
  const addedAccountIds = projectControlAddedAllowedAccountIds({
    existing: input.existing.allowedAccountIds,
    proposed: input.proposed.allowedAccountIds,
  });
  if (addedAccountIds.length === 0) return;
  if (!input.authRootDir) {
    throw new Error("project_control_scope_allowedAccountIds_auth_root_required");
  }
  if (addedAccountIds.some((accountId) => !/^[a-z0-9][a-z0-9._-]*$/.test(accountId))) {
    throw new Error("project_control_scope_allowedAccountIds_account_id_invalid");
  }
  const statuses = await listCodexGoalAccountStatuses({
    authRootDir: input.authRootDir,
    accounts: addedAccountIds,
  });
  if (
    statuses.length !== addedAccountIds.length ||
    statuses.some((status) => status.status !== "ready")
  ) {
    throw new Error("project_control_scope_allowedAccountIds_account_unavailable");
  }
}

export async function projectControlRepairJobManifestView(
  args: ProjectControlMcpArgs & JobUpdateMcpArgs,
  deps: CodexGoalMcpProjectControlAdminDeps,
): Promise<JsonObject> {
  const controller = await deps.loadProjectControlController(args);
  const jobId = requiredRawString(args.jobId, "jobId");
  if (jobId === controller.controller.jobId) {
    return {
      ok: false,
      error: "project_control_controller_manifest_repair_unsupported",
      requiredTool: "codex_goal_project_update_controller_scope",
      safeMessage:
        "Controller manifests use codex_goal_project_update_controller_scope for scoped repairs.",
    };
  }

  const existing = await readCodexGoalJob({
    registryRootDir: controller.registryRootDir,
    jobId,
  });
  assertProjectControlRepairJobOwned({
    controllerScope: controller.scope,
    job: existing,
  });

  const patch: Record<string, unknown> = {};
  let serviceTierWorkspaceDirty: boolean | undefined;
  if (args.accounts !== undefined) {
    const requestedAccounts = accountNames(args.accounts);
    if (requestedAccounts.length === 0) {
      throw new Error("project_control_repair_accounts_required");
    }
    assertProjectControlRepairAccountsAllowed({
      accounts: requestedAccounts,
      allowedAccountIds: controller.scope.allowedAccountIds ?? [],
    });
    patch.accounts = requestedAccounts;
  } else {
    const repairedAccounts = await projectControlDefaultAccountNames({
      ...(existing.authRootDir ? { authRootDir: existing.authRootDir } : {}),
      requestedAccounts: existing.accounts,
      allowedAccountIds: controller.scope.allowedAccountIds ?? [],
    });
    if (projectScopeFieldFingerprint(existing.accounts) !==
      projectScopeFieldFingerprint(repairedAccounts)) {
      patch.accounts = repairedAccounts;
    }
  }
  const repairedAccounts = Array.isArray(patch.accounts)
    ? patch.accounts.map(String)
    : undefined;
  if (
    existing.projectAccessScope &&
    repairedAccounts?.some(
      (account) =>
        !(existing.projectAccessScope?.allowedAccountIds ?? []).includes(account),
    )
  ) {
    patch.projectAccessScope = {
      ...existing.projectAccessScope,
      allowedAccountIds: controller.scope.allowedAccountIds ?? repairedAccounts,
    };
  }
  if (args.serviceTier !== undefined) {
    const requestedServiceTier = stringValue(args.serviceTier);
    if (
      requestedServiceTier !== "default" &&
      requestedServiceTier !== "fast"
    ) {
      throw new Error("project_control_repair_service_tier_invalid");
    }
    const launch = await goalLaunchInput(codexGoalJobToArgs(existing));
    const status = await collectCodexGoalStatus(
      codexGoalStatusInputFromLaunch(launch),
    );
    const progressStale =
      status.progressHeartbeatAgeMs !== undefined &&
      status.progressHeartbeatAgeMs > 10 * 60_000;
    if (resolveCodexGoalWorkerLiveness({ status, progressStale }).alive) {
      throw new Error("project_control_repair_live_worker_profile_denied");
    }
    serviceTierWorkspaceDirty = status.workspaceDirty === true;
    if (
      serviceTierWorkspaceDirty &&
      stringValue(args.reviewedOutputId) === undefined
    ) {
      throw new Error("project_control_repair_reviewed_output_required");
    }
    if (requestedServiceTier !== existing.serviceTier) {
      patch.serviceTier = requestedServiceTier;
    }
  }
  if (args.description !== undefined) {
    patch.description = stringValue(args.description) ?? "";
  }
  if (args.tags !== undefined) {
    patch.tags = tagValues(args.tags);
  }

  const rebindPreStartAdmission =
    existing.projectPreStartAdmission !== undefined &&
    (Object.keys(patch).length > 0 || args.serviceTier !== undefined);
  if (Object.keys(patch).length === 0 && !rebindPreStartAdmission) {
    return {
      ok: true,
      mode: "brokered_project_manifest_repair",
      reason: "no_repair_needed",
      controllerJobId: controller.controller.jobId,
      registryRootDir: controller.registryRootDir,
      manifest: existing,
      summary: summarizeCodexGoalJob(existing, controller.registryRootDir),
    };
  }

  if (booleanValue(args.confirmRepair) !== true) {
    return {
      ok: false,
      reason: "confirm_repair_required",
      mode: "brokered_project_manifest_repair",
      controllerJobId: controller.controller.jobId,
      registryRootDir: controller.registryRootDir,
      jobId: existing.jobId,
      auditPath: projectControlAuditPath(controller.controller),
      proposedPatch: patch as unknown as JsonObject,
      ...(rebindPreStartAdmission ? { rebindPreStartAdmission: true } : {}),
    };
  }

  const manifest = Object.keys(patch).length === 0
    ? existing
    : await updateCodexGoalJob({
        registryRootDir: controller.registryRootDir,
        jobId: existing.jobId,
        patch: patch as CodexGoalJobManifestPatch,
      });
  const preStartAdmissionRebind = rebindPreStartAdmission
    ? await rebindRepairedProjectJobManifest({
        controller,
        manifest,
        reviewedOutputId: stringValue(args.reviewedOutputId),
      })
    : undefined;
  return {
    ok: true,
    mode: "brokered_project_manifest_repair",
    controllerJobId: controller.controller.jobId,
    registryRootDir: controller.registryRootDir,
    auditPath: projectControlAuditPath(controller.controller),
    manifest,
    ...(preStartAdmissionRebind ? { preStartAdmissionRebind } : {}),
    summary: summarizeCodexGoalJob(manifest, controller.registryRootDir),
  };
}

async function rebindRepairedProjectJobManifest(input: {
  readonly controller: LoadedProjectControlController;
  readonly manifest: CodexGoalJobManifest;
  readonly reviewedOutputId: string | undefined;
}): Promise<JsonObject> {
  const locks = projectControlWorkspaceLocks(input.controller.registryRootDir);
  return await withValidatedProjectWorkspaceLock({
    locks,
    scope: input.controller.scope,
    requestedWorkspacePath: input.manifest.workspacePath,
    owner: `project-manifest-repair:${input.controller.controller.jobId}:${input.manifest.jobId}`,
    effect: async (workspace) => {
      const launch = await goalLaunchInput(codexGoalJobToArgs(input.manifest));
      const status = await collectCodexGoalStatus(
        codexGoalStatusInputFromLaunch(launch),
      );
      const progressStale =
        status.progressHeartbeatAgeMs !== undefined &&
        status.progressHeartbeatAgeMs > 10 * 60_000;
      if (resolveCodexGoalWorkerLiveness({ status, progressStale }).alive) {
        throw new Error("project_control_repair_live_worker_profile_denied");
      }
      const workspaceDirty = status.workspaceDirty === true;
      const workspaceMode = resolveProjectControlRepairWorkspaceMode({
        workspaceDirty,
        ...(input.reviewedOutputId !== undefined
          ? { reviewedOutputId: input.reviewedOutputId }
          : {}),
        admittedInputPatchCapacityContinuation:
          workspaceDirty && isAdmittedInputPatchCapacityContinuation(status),
      });
      if (workspaceMode === "reviewed_dirty_continuation") {
        const reviewedOutputId = input.reviewedOutputId;
        if (!reviewedOutputId) {
          throw new Error("project_control_repair_reviewed_output_required");
        }
        const reviewedOutputDeps = localReviewedWorkerOutputDeps({
          rootDir: reviewedWorkerOutputRoot(input.controller.registryRootDir),
          locks,
        });
        const snapshot = await resolveReviewedWorkerContinuation({
          store: reviewedOutputDeps.store,
          projectId: input.controller.scope.projectId,
          controllerJobId: input.controller.controller.jobId,
          workerJobId: input.manifest.jobId,
          taskId: launch.config.taskId,
          workspacePath: workspace.canonicalWorkspacePath,
          reviewedOutputId,
        });
        await assertReviewedWorkerOutputStillMatchesLocked(
          reviewedOutputDeps,
          snapshot,
          workspace.lease,
        );
        await assertReviewedWorkerContinuationEnvironmentLocked(
          reviewedOutputDeps,
          workspace.lease,
        );
      }
      return await rebindProjectPreStartAdmissionManifest({
        manifest: input.manifest,
        scope: input.controller.scope,
        workspaceMode,
      });
    },
  });
}

function assertProjectControlRepairJobOwned(input: {
  readonly controllerScope: ProjectAccessScope;
  readonly job: CodexGoalJobManifest;
}): void {
  if (input.job.accessBoundary === AccessBoundary.ProjectScopedControl) {
    throw new Error("project_control_repair_child_job_required");
  }
  if (input.job.projectAccessScope?.projectId !== input.controllerScope.projectId) {
    throw new Error("project_control_repair_project_scope_mismatch");
  }
  const jobMatches = matchesProjectControlPrefix(
    input.job.jobId,
    input.controllerScope.jobIdPrefixes ?? [],
  );
  const workspaceMatches = pathInsideAnyProjectRoot(
    input.job.workspacePath,
    [
      ...(input.controllerScope.workspaceRoots ?? []),
      ...(input.controllerScope.worktreeRoots ?? []),
      ...(input.controllerScope.isolatedWorkspaceRoot
        ? [input.controllerScope.isolatedWorkspaceRoot]
        : []),
    ],
  );
  if (!jobMatches && !workspaceMatches) {
    throw new Error("project_control_repair_job_scope_mismatch");
  }
}

function assertProjectControlRepairAccountsAllowed(input: {
  readonly accounts: readonly string[];
  readonly allowedAccountIds: readonly string[];
}): void {
  const allowed = new Set(input.allowedAccountIds);
  if (allowed.size === 0) return;
  const denied = input.accounts.filter((account) => !allowed.has(account));
  if (denied.length > 0) {
    throw new Error("project_control_repair_account_outside_scope");
  }
}

function nodeErrorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}
