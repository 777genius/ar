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
  const controller = await deps.loadProjectControlController(args);
  const plan = await loadFrozenOutputPlan(args, controller);
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
    const locked = await loadFrozenOutputPlan(args, controller);
    if (frozenOutputImportPlanSha256(locked) !== planSha256) {
      throw new Error("frozen_output_import_plan_drift");
    }
    return {
      ok: true,
      mode: "project_control_import_frozen_output",
      ...await publishFrozenOutputImport({
        plan: locked,
        expectedPlanSha256,
      }),
    };
  } finally {
    await locks.release(lease);
  }
}

async function loadFrozenOutputPlan(
  args: ProjectControlMcpArgs,
  controller: Awaited<ReturnType<CodexGoalMcpProjectControlAdminDeps["loadProjectControlController"]>>,
) {
  const retainedRegistrationJobId = requiredRawString(
    args.retainedRegistrationJobId,
    "retainedRegistrationJobId",
  );
  const retainedManifest = await readCodexGoalJob({
    registryRootDir: controller.registryRootDir,
    jobId: retainedRegistrationJobId,
  });
  const supersededArgs = args.supersededLegacySummaries;
  if (!Array.isArray(supersededArgs) || supersededArgs.length === 0) {
    throw new Error("supersededLegacySummaries_required");
  }
  const superseded = await Promise.all(supersededArgs.map(async (candidate, index) => {
    const jobId = requiredRawString(candidate.jobId, `supersededLegacySummaries.${index}.jobId`);
    const manifest = await readCodexGoalJob({
      registryRootDir: controller.registryRootDir,
      jobId,
    });
    const state = await manifestRuntimeState(manifest);
    return {
      manifest,
      manifestPath: requiredRawString(
        candidate.manifestPath,
        `supersededLegacySummaries.${index}.manifestPath`,
      ),
      expectedManifestSha256: requiredRawString(
        candidate.manifestSha256,
        `supersededLegacySummaries.${index}.manifestSha256`,
      ),
      workspaceDirty: state.workspaceDirty,
      workerAlive: state.workerAlive,
    };
  }));
  if (!Array.isArray(args.changedPaths)) throw new Error("changedPaths_required");
  if (!Number.isSafeInteger(args.frozenOutputSourceLength) ||
    (args.frozenOutputSourceLength ?? -1) < 0) {
    throw new Error("frozenOutputSourceLength_invalid");
  }
  return await buildFrozenOutputImportPlan({
    scope: controller.scope,
    controllerJobId: controller.controller.jobId,
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
    retainedManifest,
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
    superseded,
  });
}

async function manifestRuntimeState(manifest: Awaited<ReturnType<typeof readCodexGoalJob>>) {
  const launch = await goalLaunchInput(codexGoalJobToArgs(manifest));
  const status = await collectCodexGoalStatus(codexGoalStatusInputFromLaunch(launch));
  return {
    workspaceDirty: status.workspaceDirty === true,
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
  const controller = await deps.loadProjectControlController(args);
  const jobId = requiredRawString(args.jobId, "jobId");
  const retainedRegistrationJobId = requiredRawString(
    args.retainedRegistrationJobId,
    "retainedRegistrationJobId",
  );
  const plan = await loadAndProvePlan({
    args,
    registryRootDir: controller.registryRootDir,
    projectId: controller.scope.projectId,
    controllerJobId: controller.controller.jobId,
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
    const lockedPlan = await loadAndProvePlan({
      args,
      registryRootDir: controller.registryRootDir,
      projectId: controller.scope.projectId,
      controllerJobId: controller.controller.jobId,
      jobId,
      retainedRegistrationJobId,
    });
    if (legacyJobSummaryRetirementPlanSha256(lockedPlan) !== planSha256) {
      throw new Error("legacy_job_summary_retirement_plan_drift");
    }
    const result = await publishLegacyJobSummaryRetirement({
      registryRootDir: controller.registryRootDir,
      plan: lockedPlan,
      expectedPlanSha256,
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
  readonly args: ProjectControlMcpArgs;
  readonly registryRootDir: string;
  readonly projectId: string;
  readonly controllerJobId: string;
  readonly jobId: string;
  readonly retainedRegistrationJobId: string;
}) {
  const [manifest, retainedManifest] = await Promise.all([
    readCodexGoalJob({
      registryRootDir: input.registryRootDir,
      jobId: input.jobId,
    }),
    readCodexGoalJob({
      registryRootDir: input.registryRootDir,
      jobId: input.retainedRegistrationJobId,
    }),
  ]);
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
    // Missing workspace data is expected, but liveness must still be
    // independently disproven by the absence of any configured tmux session.
    if (manifest.tmuxSession) throw error;
  }
  return await buildLegacyJobSummaryRetirementPlan({
    registryRootDir: input.registryRootDir,
    projectId: input.projectId,
    controllerJobId: input.controllerJobId,
    manifest,
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
    retainedManifest,
    retainedManifestPath: codexGoalJobManifestPath({
      registryRootDir: input.registryRootDir,
      jobId: input.retainedRegistrationJobId,
    }),
    expectedRetainedManifestSha256: requiredRawString(
      input.args.expectedRetainedRegistrationManifestSha256,
      "expectedRetainedRegistrationManifestSha256",
    ),
    workerAlive,
  });
}
