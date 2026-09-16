import { codexGoalProgressPath } from "./codex-goal-runner";
import {
  buildCodexGoalStopTmuxCommand,
  collectCodexGoalStatus,
  listCodexGoalAccountStatuses,
  type CodexGoalLaunchInput,
} from "./codex-goal-ops";
import { projectControlAuditPath } from "./codex-goal-mcp-project-broker";
import { projectControlRealPathOutsideWorkspaceScope } from
  "./codex-goal-mcp-project-scope";
import {
  writeCodexGoalStopEvent,
  writeCodexGoalStoppedProgress,
} from "./codex-goal-mcp-lifecycle-markers";
import { buildCodexGoalBrief } from "./codex-goal-mcp-brief";
import { codexGoalStateRootDir } from "./application/codex-goal-worker-control";
import { codexGoalStatusInputFromLaunch as statusInput } from
  "./codex-goal-mcp-status-input";
import { requiredRawString } from "./codex-goal-mcp-values";
import type { ProjectControlMcpArgs } from "./codex-goal-mcp-inputs";
import { releaseCodexProjectAccount } from
  "./application/project-control/codex-goal-project-account-reservation";
import { decideCodexGoalProjectStop } from
  "./application/project-control/codex-goal-project-stop-policy";
import {
  projectControlWorkspaceLocks,
  withValidatedProjectWorkspaceLock,
} from "./codex-goal-project-workspace-lock";
import type { CodexGoalMcpProjectControlActionsDeps } from
  "./codex-goal-mcp-project-control-actions";

type JsonObject = Readonly<Record<string, unknown>>;

export async function projectControlStopStoredJobView(
  args: ProjectControlMcpArgs,
  deps: CodexGoalMcpProjectControlActionsDeps,
): Promise<JsonObject> {
  const controller = await deps.loadProjectControlController(args);
  const loaded = await deps.loadJobLaunch({
    registryRootDir: controller.registryRootDir,
    jobId: requiredRawString(args.jobId, "jobId"),
  });
  const status = await collectCodexGoalStatus(statusInput(loaded.launch));
  const accounts = await listCodexGoalAccountStatuses({
    authRootDir: loaded.launch.config.authRootDir,
    accounts: loaded.launch.config.accounts.map((account) => account.name),
    stateRootDir: codexGoalStateRootDir(loaded.launch),
  });
  const brief = await buildCodexGoalBrief({
    jobId: loaded.manifest.jobId,
    launch: loaded.launch,
    status,
    accounts,
    staleAfterMs: 10 * 60_000,
    tailLines: 20,
  });
  const stopCommandPreview = loaded.launch.tmuxSession
    ? buildCodexGoalStopTmuxCommand(loaded.launch.tmuxSession).preview
    : status.progressPid === undefined
      ? "no direct process pid"
      : `kill -TERM ${status.progressPid}`;
  const stopPolicy = decideCodexGoalProjectStop(brief.workerHealth);
  if (!stopPolicy.allowed) {
    return {
      ok: false,
      reason: stopPolicy.reason,
      controllerJobId: controller.controller.jobId,
      jobId: loaded.manifest.jobId,
      ...(loaded.launch.tmuxSession
        ? { tmuxSession: loaded.launch.tmuxSession }
        : {}),
      requiredState: stopPolicy.requiredState,
      stopCommand: stopCommandPreview,
      status,
      brief,
      safeMessage: stopPolicy.safeMessage,
    };
  }
  if (!args.confirmStop) {
    return {
      ok: false,
      reason: "confirm_stop_required",
      controllerJobId: controller.controller.jobId,
      jobId: loaded.manifest.jobId,
      ...(loaded.launch.tmuxSession
        ? { tmuxSession: loaded.launch.tmuxSession }
        : {}),
      stopCommand: stopCommandPreview,
      auditPath: projectControlAuditPath(controller.controller),
      status,
      brief,
    };
  }

  return await withValidatedProjectWorkspaceLock({
    locks: projectControlWorkspaceLocks(controller.registryRootDir),
    scope: controller.scope,
    requestedWorkspacePath: loaded.manifest.workspacePath,
    owner: `project-stop:${controller.controller.jobId}:${loaded.manifest.jobId}`,
    effect: async (workspace) => {
      const lockedLaunch: CodexGoalLaunchInput = {
        ...loaded.launch,
        config: {
          ...loaded.launch.config,
          workspacePath: workspace.canonicalWorkspacePath,
        },
      };
      const broker = deps.codexProjectControlBroker({
        registryRootDir: controller.registryRootDir,
        controller: controller.controller,
        scope: controller.scope,
        stopLaunch: lockedLaunch,
      });
      const realWorkspacePath = await projectControlRealPathOutsideWorkspaceScope(
        loaded.launch.config.workspacePath,
        controller.scope,
      );
      const result = await broker.stopWorker({
        jobId: loaded.manifest.jobId,
        registryRoot: controller.registryRootDir,
        workspacePath: loaded.launch.config.workspacePath,
        ...(realWorkspacePath ? { realWorkspacePath } : {}),
        ...(loaded.launch.tmuxSession
          ? { tmuxSession: loaded.launch.tmuxSession }
          : {}),
      });
      await writeCodexGoalStoppedProgress({
        progressPath: loaded.launch.config.progressPath ?? codexGoalProgressPath({
          jobRootDir: loaded.launch.config.jobRootDir,
          taskId: loaded.launch.config.taskId,
        }),
        taskId: loaded.launch.config.taskId,
        status: "stopped",
      });
      const statusAfter = await collectCodexGoalStatus(statusInput(lockedLaunch));
      const stopEventPath = await writeCodexGoalStopEvent({
        jobId: loaded.manifest.jobId,
        taskId: loaded.launch.config.taskId,
        jobRootDir: loaded.launch.config.jobRootDir,
        ...(loaded.launch.tmuxSession
          ? { tmuxSession: loaded.launch.tmuxSession }
          : {}),
        stopCommand: String(result.resourceId ?? stopCommandPreview),
        forceStop: Boolean(args.forceStop),
        statusBefore: status,
        statusAfter,
        brief,
      });
      const accountReservationReleased = await releaseCodexProjectAccount({
        manifest: loaded.manifest,
        launch: lockedLaunch,
        reason: "worker_stopped",
      });
      return {
        ok: true,
        mode: "project_control_stop",
        controllerJobId: controller.controller.jobId,
        registryRootDir: controller.registryRootDir,
        auditPath: projectControlAuditPath(controller.controller),
        jobId: loaded.manifest.jobId,
        taskId: loaded.launch.config.taskId,
        ...(loaded.launch.tmuxSession
          ? { tmuxSession: loaded.launch.tmuxSession }
          : {}),
        stopEventPath,
        accountReservationReleased,
        statusBefore: status,
        statusAfter,
        result: result as unknown as JsonObject,
      };
    },
  });
}
