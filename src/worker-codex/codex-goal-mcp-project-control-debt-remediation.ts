import { collectCodexGoalStatus, resolveCodexGoalWorkerLiveness } from
  "./codex-goal-ops";
import {
  codexGoalJobManifestPath,
  codexGoalJobToArgs,
  readCodexGoalJob,
} from "./codex-goal-jobs";
import { goalLaunchInput } from "./codex-goal-mcp-launch-input";
import { codexGoalStatusInputFromLaunch } from "./codex-goal-mcp-status-input";
import type { ProjectControlMcpArgs } from "./codex-goal-mcp-inputs";
import type { CodexGoalMcpProjectControlAdminDeps } from
  "./codex-goal-mcp-project-control-admin";
import { requiredRawString } from "./codex-goal-mcp-values";
import {
  buildLegacyJobSummaryRetirementPlan,
  legacyJobSummaryRetirementPlanSha256,
  publishLegacyJobSummaryRetirement,
} from "./application/project-control/codex-goal-legacy-job-summary-retirement";
import {
  buildFrozenOutputImportPlan,
  frozenOutputImportPlanSha256,
  publishFrozenOutputImport,
} from "./application/project-control/codex-goal-frozen-output-import";
import { controllerScopeLockIdentity } from
  "./codex-goal-mcp-project-control-ledger-epoch";
import { projectControlWorkspaceLocks } from
  "./codex-goal-project-workspace-lock";
type JsonObject = Readonly<Record<string, unknown>>;

export async function projectControlImportFrozenOutputView(
  args: ProjectControlMcpArgs,
  deps: CodexGoalMcpProjectControlAdminDeps,
): Promise<JsonObject> {
  const evidenceCustody = requiredEvidenceCustody(deps);
  const controller = await deps.loadProjectControlController(args);
  const plan = await loadFrozenOutputPlan(args, controller, evidenceCustody);
  const planSha256 = frozenOutputImportPlanSha256(plan);
  if (args.confirmFrozenOutputImport !== true) {
    return {
      ok: false,
      reason: "confirm_frozen_output_import_required",
      mode: "project_control_import_frozen_output",
      plan,
      planSha256,
    };
  }
  const expectedPlanSha256 = requiredRawString(
    args.expectedFrozenOutputImportPlanSha256,
    "expectedFrozenOutputImportPlanSha256",
  );
  const locks = projectControlWorkspaceLocks(controller.registryRootDir);
  const lease = await locks.acquire({
    workspacePath: controllerScopeLockIdentity(
      controller.registryRootDir,
      controller.controller.jobId,
    ),
    owner: `frozen-output-import:${planSha256}`,
  });
  try {
    const lockedController = await deps.loadProjectControlController(args);
    assertProjectControlDebtControllerCas(controller, lockedController);
    const locked = await loadFrozenOutputPlan(args, lockedController, evidenceCustody);
    if (frozenOutputImportPlanSha256(locked) !== planSha256) {
      throw new Error("frozen_output_import_plan_drift");
    }
    return {
      ok: true,
      mode: "project_control_import_frozen_output",
      ...await publishFrozenOutputImport({
        custody: evidenceCustody,
        scope: lockedController.scope,
        plan: locked,
        expectedPlanSha256,
        rebuildCurrentPlan: async () => await loadFrozenOutputPlan(
          args, lockedController, evidenceCustody,
        ),
      }),
    };
  } finally {
    await locks.release(lease);
  }
}

async function loadFrozenOutputPlan(
  args: ProjectControlMcpArgs,
  controller: Awaited<ReturnType<CodexGoalMcpProjectControlAdminDeps["loadProjectControlController"]>>,
  evidenceCustody: NonNullable<CodexGoalMcpProjectControlAdminDeps["evidenceCustody"]>,
) {
  const retainedRegistrationJobId = requiredRawString(
    args.retainedRegistrationJobId,
    "retainedRegistrationJobId",
  );
  const supersededArgs = args.supersededLegacySummaries;
  if (!Array.isArray(supersededArgs) || supersededArgs.length === 0) {
    throw new Error("supersededLegacySummaries_required");
  }
  const superseded = supersededArgs.map((candidate, index) => {
    const jobId = requiredRawString(candidate.jobId, `supersededLegacySummaries.${index}.jobId`);
    return {
      jobId,
      manifestPath: requiredRawString(
        candidate.manifestPath,
        `supersededLegacySummaries.${index}.manifestPath`,
      ),
      expectedManifestSha256: requiredRawString(
        candidate.manifestSha256,
        `supersededLegacySummaries.${index}.manifestSha256`,
      ),
    };
  });
  if (!Array.isArray(args.changedPaths)) throw new Error("changedPaths_required");
  if (!Number.isSafeInteger(args.frozenOutputSourceLength) ||
    (args.frozenOutputSourceLength ?? -1) < 0) {
    throw new Error("frozenOutputSourceLength_invalid");
  }
  return await buildFrozenOutputImportPlan({
    custody: evidenceCustody,
    scope: controller.scope,
    registryRootDir: controller.registryRootDir,
    controllerJobId: controller.controller.jobId,
    jobIdPrefixes: controller.scope.jobIdPrefixes ?? [],
    sourcePath: requiredRawString(args.frozenOutputSourcePath, "frozenOutputSourcePath"),
    expectedSourceSha256: requiredRawString(args.frozenOutputSourceSha256, "frozenOutputSourceSha256"),
    expectedSourceLength: args.frozenOutputSourceLength!,
    sourceManifestPath: requiredRawString(args.frozenOutputSourceManifestPath, "frozenOutputSourceManifestPath"),
    expectedSourceManifestSha256: requiredRawString(args.frozenOutputSourceManifestSha256, "frozenOutputSourceManifestSha256"),
    destinationEvidenceRoot: requiredRawString(args.destinationEvidenceRoot, "destinationEvidenceRoot"),
    destinationLedgerRoot: requiredRawString(args.destinationLedgerRoot, "destinationLedgerRoot"),
    changedPaths: args.changedPaths,
    baseCommit: requiredRawString(args.baseCommit, "baseCommit"),
    headCommit: requiredRawString(args.headCommit, "headCommit"),
    patchSha256: requiredRawString(args.patchSha256, "patchSha256"),
    retainedRegistrationJobId,
    retainedManifestPath: codexGoalJobManifestPath({
      registryRootDir: controller.registryRootDir,
      jobId: retainedRegistrationJobId,
    }),
    expectedRetainedManifestSha256: requiredRawString(
      args.expectedRetainedRegistrationManifestSha256,
      "expectedRetainedRegistrationManifestSha256",
    ),
    expectedRetainedOutputSha256: requiredRawString(
      args.expectedRetainedOutputSha256,
      "expectedRetainedOutputSha256",
    ),
    observeRuntime: manifestRuntimeState,
    superseded,
  });
}

async function manifestRuntimeState(manifest: Awaited<ReturnType<typeof readCodexGoalJob>>) {
  const launch = await goalLaunchInput(codexGoalJobToArgs(manifest));
  const status = await collectCodexGoalStatus(codexGoalStatusInputFromLaunch(launch));
  const resultPath = status.resultPath;
  return {
    workspaceDirty: status.workspaceDirty === true,
    resultExists: status.resultExists === true,
    ...(resultPath === undefined ? {} : { resultPath }),
    workerAlive: resolveCodexGoalWorkerLiveness({
      status,
      progressStale: false,
    }).alive,
  };
}

export async function projectControlRetireLegacyJobSummaryView(
  args: ProjectControlMcpArgs,
  deps: CodexGoalMcpProjectControlAdminDeps,
): Promise<JsonObject> {
  const evidenceCustody = requiredEvidenceCustody(deps);
  const controller = await deps.loadProjectControlController(args);
  const jobId = requiredRawString(args.jobId, "jobId");
  const retainedRegistrationJobId = requiredRawString(
    args.retainedRegistrationJobId,
    "retainedRegistrationJobId",
  );
  const plan = await loadAndProvePlan({
    custody: evidenceCustody,
    args,
    registryRootDir: controller.registryRootDir,
    projectId: controller.scope.projectId,
    controllerJobId: controller.controller.jobId,
    jobIdPrefixes: controller.scope.jobIdPrefixes ?? [],
    jobId,
    retainedRegistrationJobId,
  });
  const planSha256 = legacyJobSummaryRetirementPlanSha256(plan);
  if (args.confirmRetirement !== true) {
    return {
      ok: false,
      reason: "confirm_retirement_required",
      mode: "project_control_retire_legacy_job_summary",
      plan,
      planSha256,
    };
  }
  const expectedPlanSha256 = requiredRawString(
    args.expectedRetirementPlanSha256,
    "expectedRetirementPlanSha256",
  );
  const locks = projectControlWorkspaceLocks(controller.registryRootDir);
  const lease = await locks.acquire({
    workspacePath: controllerScopeLockIdentity(
      controller.registryRootDir,
      controller.controller.jobId,
    ),
    owner: `legacy-job-summary-retirement:${jobId}`,
  });
  try {
    const lockedController = await deps.loadProjectControlController(args);
    assertProjectControlDebtControllerCas(controller, lockedController);
    const lockedPlan = await loadAndProvePlan({
      args,
      registryRootDir: lockedController.registryRootDir,
      projectId: lockedController.scope.projectId,
      controllerJobId: lockedController.controller.jobId,
      jobIdPrefixes: lockedController.scope.jobIdPrefixes ?? [],
      custody: evidenceCustody,
      jobId,
      retainedRegistrationJobId,
    });
    if (legacyJobSummaryRetirementPlanSha256(lockedPlan) !== planSha256) {
      throw new Error("legacy_job_summary_retirement_plan_drift");
    }
    const result = await publishLegacyJobSummaryRetirement({
      custody: evidenceCustody,
      registryRootDir: controller.registryRootDir,
      plan: lockedPlan,
      expectedPlanSha256,
      rebuildCurrentPlan: async () => await loadAndProvePlan({
        args,
        registryRootDir: lockedController.registryRootDir,
        projectId: lockedController.scope.projectId,
        controllerJobId: lockedController.controller.jobId,
        jobIdPrefixes: lockedController.scope.jobIdPrefixes ?? [],
        custody: evidenceCustody,
        jobId,
        retainedRegistrationJobId,
      }),
    });
    return {
      ok: true,
      mode: "project_control_retire_legacy_job_summary",
      ...result,
    };
  } finally {
    await locks.release(lease);
  }
}

async function loadAndProvePlan(input: {
  readonly custody: NonNullable<CodexGoalMcpProjectControlAdminDeps["evidenceCustody"]>;
  readonly args: ProjectControlMcpArgs;
  readonly registryRootDir: string;
  readonly projectId: string;
  readonly controllerJobId: string;
  readonly jobIdPrefixes: readonly string[];
  readonly jobId: string;
  readonly retainedRegistrationJobId: string;
}) {
  return await buildLegacyJobSummaryRetirementPlan({
    custody: input.custody,
    registryRootDir: input.registryRootDir,
    projectId: input.projectId,
    jobIdPrefixes: input.jobIdPrefixes,
    controllerJobId: input.controllerJobId,
    manifestPath: codexGoalJobManifestPath({
      registryRootDir: input.registryRootDir,
      jobId: input.jobId,
    }),
    expectedManifestPath: requiredRawString(
      input.args.expectedJobManifestPath,
      "expectedJobManifestPath",
    ),
    expectedManifestSha256: requiredRawString(
      input.args.expectedJobManifestSha256,
      "expectedJobManifestSha256",
    ),
    expectedWorkspacePath: requiredRawString(
      input.args.expectedWorkspacePath,
      "expectedWorkspacePath",
    ),
    retainedManifestPath: codexGoalJobManifestPath({
      registryRootDir: input.registryRootDir,
      jobId: input.retainedRegistrationJobId,
    }),
    expectedRetainedManifestSha256: requiredRawString(
      input.args.expectedRetainedRegistrationManifestSha256,
      "expectedRetainedRegistrationManifestSha256",
    ),
    observeRuntime: async (manifest) => {
      let workerAlive = false;
      try {
        const launch = await goalLaunchInput(codexGoalJobToArgs(manifest));
        const status = await collectCodexGoalStatus(
          codexGoalStatusInputFromLaunch(launch),
        );
        workerAlive = resolveCodexGoalWorkerLiveness({
          status,
          progressStale: false,
        }).alive;
      } catch (error) {
        if (manifest.tmuxSession) throw error;
      }
      return { workerAlive };
    },
  });
}

export function assertProjectControlDebtControllerCas(
  before: Awaited<ReturnType<CodexGoalMcpProjectControlAdminDeps["loadProjectControlController"]>>,
  locked: Awaited<ReturnType<CodexGoalMcpProjectControlAdminDeps["loadProjectControlController"]>>,
): void {
  if (before.registryRootDir !== locked.registryRootDir ||
    before.controller.jobId !== locked.controller.jobId ||
    JSON.stringify(before.controller) !== JSON.stringify(locked.controller)) {
    throw new Error("project_control_controller_scope_cas_mismatch");
  }
}

function requiredEvidenceCustody(deps: CodexGoalMcpProjectControlAdminDeps) {
  const custody = deps.evidenceCustody ?? deps.admissionDeps.evidenceCustody;
  if (!custody) throw new Error("project_control_evidence_custody_required");
  return custody;
}
