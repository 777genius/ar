import {
  createCodexGoalJob,
  updateCodexGoalJob,
  type CodexGoalJobManifest,
  type CodexGoalJobManifestInput,
  type CodexGoalJobManifestPatch,
} from "./codex-goal-jobs";
import type { CodexGoalLaunchInput } from "./codex-goal-ops";
import type { ProjectControlEvidenceCustodyPort } from
  "@vioxen/subscription-runtime/worker-core";

export type CodexGoalLaunchManifestMetadata = {
  readonly description?: string;
  readonly tags?: readonly string[];
};

export async function upsertCodexGoalLaunchManifest(input: {
  readonly registryRootDir: string;
  readonly launch: CodexGoalLaunchInput;
  readonly metadata?: CodexGoalLaunchManifestMetadata;
  readonly evidenceCustody?: ProjectControlEvidenceCustodyPort;
}): Promise<CodexGoalJobManifest> {
  const manifestInput = codexGoalLaunchManifestInputFromLaunch(
    input.launch,
    input.metadata,
  );
  try {
    return await createCodexGoalJob({
      registryRootDir: input.registryRootDir,
      manifest: manifestInput,
      ...(input.evidenceCustody
        ? { evidenceCustody: input.evidenceCustody }
        : {}),
    });
  } catch (error) {
    if (!isFileAlreadyExistsError(error)) throw error;
    return await updateCodexGoalJob({
      registryRootDir: input.registryRootDir,
      jobId: manifestInput.jobId,
      patch: codexGoalLaunchManifestPatch(manifestInput),
      ...(input.evidenceCustody
        ? { evidenceCustody: input.evidenceCustody }
        : {}),
    });
  }
}

export function codexGoalLaunchManifestInputFromLaunch(
  launch: CodexGoalLaunchInput,
  metadata: CodexGoalLaunchManifestMetadata = {},
): CodexGoalJobManifestInput {
  const jobId = launch.config.jobId ?? launch.config.taskId;
  return {
    jobId,
    ...(metadata.description ? { description: metadata.description } : {}),
    ...(metadata.tags?.length ? { tags: metadata.tags } : {}),
    jobRootDir: launch.config.jobRootDir,
    authRootDir: launch.config.authRootDir,
    ...(launch.config.stateRootDir ? { stateRootDir: launch.config.stateRootDir } : {}),
    workspacePath: launch.config.workspacePath,
    promptPath: launch.config.promptPath,
    ...(launch.config.codexGoalObjective
      ? { codexGoalObjective: launch.config.codexGoalObjective }
      : {}),
    taskId: launch.config.taskId,
    accounts: launch.config.accounts.map((account) => account.name),
    ...(launch.config.outputPath ? { outputPath: launch.config.outputPath } : {}),
    ...(launch.config.progressPath ? { progressPath: launch.config.progressPath } : {}),
    ...(launch.config.progressHeartbeatMs
      ? { progressHeartbeatMs: launch.config.progressHeartbeatMs }
      : {}),
    ...(launch.config.codexBinaryPath
      ? { codexBinaryPath: launch.config.codexBinaryPath }
      : {}),
    ...(launch.config.model ? { model: launch.config.model } : {}),
    ...(launch.config.reasoningEffort
      ? { reasoningEffort: launch.config.reasoningEffort }
      : {}),
    ...(launch.config.serviceTier ? { serviceTier: launch.config.serviceTier } : {}),
    ...(launch.config.executionEngine
      ? { executionEngine: launch.config.executionEngine }
      : {}),
    ...(launch.config.taskTimeoutMs ? { taskTimeoutMs: launch.config.taskTimeoutMs } : {}),
    ...(launch.config.appServerStartupTimeoutMs
      ? { appServerStartupTimeoutMs: launch.config.appServerStartupTimeoutMs }
      : {}),
    ...(launch.config.staleLockMs ? { staleLockMs: launch.config.staleLockMs } : {}),
    ...(launch.config.maxAccountCycles
      ? { maxAccountCycles: launch.config.maxAccountCycles }
      : {}),
    ...(launch.config.editMode ? { editMode: launch.config.editMode } : {}),
    ...(launch.config.providerSandboxMode
      ? { providerSandboxMode: launch.config.providerSandboxMode }
      : {}),
    ...(launch.config.accessBoundary
      ? { accessBoundary: launch.config.accessBoundary }
      : {}),
    ...(launch.config.projectAccessScope
      ? { projectAccessScope: launch.config.projectAccessScope }
      : {}),
    ...(launch.config.allowDangerFullAccess === undefined
      ? {}
      : { allowDangerFullAccess: launch.config.allowDangerFullAccess }),
    ...(launch.config.networkAccess ? { networkAccess: launch.config.networkAccess } : {}),
    ...(launch.config.allowDuplicateAccountIdentities
      ? { allowDuplicateAccountIdentities: launch.config.allowDuplicateAccountIdentities }
      : {}),
    ...(launch.config.requireGitWorkspace === undefined
      ? {}
      : { requireGitWorkspace: launch.config.requireGitWorkspace }),
    ...(launch.config.prewarmOnStart
      ? { prewarmOnStart: launch.config.prewarmOnStart }
      : {}),
    ...(launch.config.workerReportMode
      ? { workerReportMode: launch.config.workerReportMode }
      : {}),
    ...(launch.tmuxSession ? { tmuxSession: launch.tmuxSession } : {}),
    cwd: launch.cwd,
    logPath: launch.logPath,
    ...(launch.format ? { outputFormat: launch.format } : {}),
  };
}

export function codexGoalLaunchManifestPatch(
  manifest: CodexGoalJobManifestInput,
): CodexGoalJobManifestPatch {
  const { jobId: _jobId, createdAt: _createdAt, ...patch } = manifest;
  return patch;
}

function isFileAlreadyExistsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "EEXIST"
  );
}
