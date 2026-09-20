import { CodexGoalLaunchState } from "../codex-goal-ops";
import { HostedGoalLifecycleOperation } from "./codex-goal-foreground-command";
import { isHostedGoalLaunch, routeHostedGoalLaunch } from "../hosted-readonly-goal-launch";
import { join } from "node:path";
import {
  buildCodexGoalNoTmuxCommand,
  buildCodexGoalTmuxCommand,
  collectCodexGoalStatus,
  doctorCodexGoal,
  prepareCodexGoalLaunchPaths,
  startCodexGoalTmux,
  tailCodexGoalLog,
  type CodexGoalLaunchInput,
  type CodexGoalStatus,
} from "../codex-goal-ops";
import {
  upsertCodexGoalLaunchManifest,
} from "../codex-goal-launch-manifest";
import {
  isSafeStartAction,
} from "./codex-goal-start-policy";
import {
  codexGoalLaunchSummary as launchSummary,
} from "./codex-goal-launch-summary";
import {
  codexGoalStatusInputFromLaunch as statusInput,
} from "./codex-goal-status-input";
import {
  resolvePath,
} from "./codex-goal-input-values";
import { redactLogTail } from "./codex-goal-log-view";
import {
  projectControlGenericScopeDenial,
  projectControlGenericToolDenial,
} from "../project-control-scope-guard";

type JsonObject = Readonly<Record<string, unknown>>;

export function dryRunCodexGoalLaunch(input: {
  readonly launch: CodexGoalLaunchInput;
}): JsonObject {
  const noTmuxCommand = buildCodexGoalNoTmuxCommand(input.launch);
  const tmuxCommand = input.launch.tmuxSession
    ? buildCodexGoalTmuxCommand(input.launch)
    : undefined;
  return {
    ok: true,
    taskId: input.launch.config.taskId,
    noTmuxCommand,
    ...(tmuxCommand ? { tmuxCommand: tmuxCommand.preview } : {}),
    summary: launchSummary(input.launch),
  };
}

export async function startCodexGoalLaunch(input: {
  readonly launch: CodexGoalLaunchInput;
  readonly registryRootDir: string;
  readonly jobId: string;
  readonly confirmStart: boolean;
  readonly skipDoctor: boolean;
  readonly forceStart: boolean;
}): Promise<JsonObject> {
  const projectControlDenial = projectControlGenericToolDenial({
    accessBoundary: input.launch.config.accessBoundary,
    projectAccessScope: input.launch.config.projectAccessScope,
  }) ?? await projectControlGenericScopeDenial({
    registryRootDir: input.registryRootDir,
    jobId: input.jobId,
    workspacePath: input.launch.config.workspacePath,
    requiredTool: "codex_goal_project_start",
  });
  if (projectControlDenial) return projectControlDenial;

  if (!input.launch.tmuxSession && !isHostedGoalLaunch(input.launch)) {
    return {
      ok: false,
      reason: "tmux_session_required",
      noTmuxCommand: buildCodexGoalNoTmuxCommand(input.launch),
    };
  }

  const { tmuxSession: _tmuxSession, ...foregroundStatus } = statusInput(input.launch);
  const statusBefore = await collectCodexGoalStatus(isHostedGoalLaunch(input.launch) ? foregroundStatus : statusInput(input.launch));
  if (statusBefore.tmuxAlive) {
    return {
      ok: false,
      reason: "worker_already_running",
      status: statusBefore,
    };
  }

  if (!isSafeStartAction(statusBefore.recommendedAction) && !input.forceStart) {
    return {
      ok: false,
      reason: "status_requires_review",
      status: statusBefore,
      requiredOverride: "forceStart",
    };
  }

  if (!input.confirmStart) {
    return {
      ok: false,
      reason: "confirm_start_required",
      tmuxCommand: input.launch.tmuxSession ? buildCodexGoalTmuxCommand(input.launch).preview : undefined,
      summary: launchSummary(input.launch),
    };
  }

  const outerStatus = await routeHostedGoalLaunch({ ...input.launch, registryRootDir: input.registryRootDir }, {
    operation: HostedGoalLifecycleOperation.Start, jobId: input.jobId,
    confirmed: input.confirmStart, skipDoctor: input.skipDoctor, forceStart: input.forceStart,
  });
  if (outerStatus !== undefined) return { ok: outerStatus === 0, launchState: outerStatus === 0 ? CodexGoalLaunchState.Completed : CodexGoalLaunchState.Failed, exitCode: outerStatus };
  await prepareCodexGoalLaunchPaths(input.launch);
  const manifest = await upsertCodexGoalLaunchManifest({
    registryRootDir: input.registryRootDir,
    launch: input.launch,
  });
  if (!input.skipDoctor) {
    const doctor = await doctorCodexGoal({
      config: input.launch.config,
      ...(isHostedGoalLaunch(input.launch) ? {} : { tmuxSession: input.launch.tmuxSession }),
    });
    if (!doctor.ok) {
      return {
        ok: false,
        reason: "doctor_failed",
        doctor,
      };
    }
  }

  const command = await startCodexGoalTmux(input.launch);
  return {
    ok: command.launchState !== CodexGoalLaunchState.Failed,
    registryRootDir: input.registryRootDir,
    jobId: manifest.jobId,
    taskId: input.launch.config.taskId,
    tmuxSession: input.launch.tmuxSession,
    tmuxCommand: command.preview,
    launchState: command.launchState ?? CodexGoalLaunchState.Scheduled,
    manifest,
    summary: launchSummary(input.launch),
  };
}

export async function inspectCodexGoalStatus(input: {
  readonly cwd: string | undefined;
  readonly jobRootDir: string | undefined;
  readonly taskId: string | undefined;
  readonly workspacePath: string | undefined;
  readonly tmuxSession: string | undefined;
  readonly logPath: string | undefined;
  readonly progressPath: string | undefined;
}): Promise<CodexGoalStatus> {
  const cwd = resolvePath(process.cwd(), input.cwd ?? process.cwd());
  return collectCodexGoalStatus({
    ...(input.jobRootDir
      ? { jobRootDir: resolvePath(cwd, input.jobRootDir) }
      : {}),
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.workspacePath
      ? { workspacePath: resolvePath(cwd, input.workspacePath) }
      : {}),
    ...(input.tmuxSession ? { tmuxSession: input.tmuxSession } : {}),
    ...(input.logPath ? { logPath: resolvePath(cwd, input.logPath) } : {}),
    ...(input.progressPath
      ? { progressPath: resolvePath(cwd, input.progressPath) }
      : {}),
  });
}

export async function inspectCodexGoalDoctor(input: {
  readonly launch: CodexGoalLaunchInput;
}): Promise<JsonObject> {
  return doctorCodexGoal({
    config: input.launch.config,
    ...(input.launch.tmuxSession ? { tmuxSession: input.launch.tmuxSession } : {}),
  });
}

export async function tailCodexGoalRunLog(input: {
  readonly cwd: string | undefined;
  readonly jobRootDir: string | undefined;
  readonly taskId: string | undefined;
  readonly logPath: string | undefined;
  readonly lines: number | undefined;
}): Promise<JsonObject> {
  const cwd = resolvePath(process.cwd(), input.cwd ?? process.cwd());
  const logPath = input.logPath ??
    (input.jobRootDir && input.taskId
      ? join(resolvePath(cwd, input.jobRootDir), `${input.taskId}.log`)
      : undefined);
  if (!logPath) throw new Error("logPath or jobRootDir with taskId is required");

  const resolvedLogPath = resolvePath(cwd, logPath);
  const text = redactLogTail(
    await tailCodexGoalLog(resolvedLogPath, input.lines ?? 100),
  );
  return { ok: true, logPath: resolvedLogPath, text };
}
