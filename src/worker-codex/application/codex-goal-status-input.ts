import type {
  CodexGoalLaunchInput,
  CodexGoalStatusInput,
} from "../codex-goal-ops";
import { isHostedGoalLaunch } from "../hosted-readonly-goal-launch";

export function codexGoalStatusInputFromLaunch(
  launch: CodexGoalLaunchInput,
): CodexGoalStatusInput {
  return {
    jobRootDir: launch.config.jobRootDir,
    taskId: launch.config.taskId,
    ...(launch.config.outputPath ? { resultPath: launch.config.outputPath } : {}),
    workspacePath: launch.config.workspacePath,
    ...(launch.tmuxSession && !isHostedGoalLaunch(launch) ? { tmuxSession: launch.tmuxSession } : {}),
    logPath: launch.logPath,
    ...(launch.config.runtimeEventsPath ? { runtimeEventsPath: launch.config.runtimeEventsPath } : {}),
    ...(launch.config.progressPath ? { progressPath: launch.config.progressPath } : {}),
    ...(launch.config.accessBoundary === undefined
      ? {}
      : { accessBoundary: launch.config.accessBoundary }),
  };
}
