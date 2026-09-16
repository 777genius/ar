import type { CodexGoalLaunchInput } from "./codex-goal-ops";
import { buildCodexGoalForegroundArgv, type HostedGoalLifecycleRequest } from "./application/codex-goal-foreground-command";
import { admitHostedControllerLaunch } from "./hosted-readonly-controller-admission";
import { HostedReadonlySupervisorHost } from "./hosted-readonly-supervisor-host";
import { HostedReadonlyRuntimeRole } from "./hosted-readonly-host-kernel";
import { runHostedReadonlyForeground, runHostedRuntimeForeground } from "./hosted-readonly-foreground";
import { HostedActivationPhase } from "@vioxen/subscription-runtime/worker-core";
import { requiresHostedProcessAdmission } from "@vioxen/subscription-runtime/provider-codex";
import { HostedInstallationActivationStore, isHostedOrdinaryRuntime, readHostedInstallationActivation } from "./hosted-installation-activation";

export function isHostedGoalLaunch(input: CodexGoalLaunchInput): boolean {
  return requiresHostedProcessAdmission(input.config.sourceEnv ?? process.env);
}

/** Call after pure launch/scope checks, before writes. Undefined means the
 * caller is admitted locally; a number is the outer foreground wait outcome. */
export async function routeHostedGoalLaunch(input: CodexGoalLaunchInput, lifecycle?: HostedGoalLifecycleRequest): Promise<number | undefined> {
  if (isHostedOrdinaryRuntime()) {
    await admitHostedControllerLaunch(input);
    return undefined;
  }
  if (isHostedGoalLaunch(input)) {
    if (readHostedInstallationActivation().activation.phase === HostedActivationPhase.Ordinary) {
      const [command, ...args] = buildCodexGoalForegroundArgv(input, lifecycle);
      if (!command) throw new Error("hosted_custody_runtime_command_required");
      return runHostedRuntimeForeground(command, args, input.cwd, input.config.sourceEnv ?? process.env);
    }
    const host = new HostedReadonlySupervisorHost();
    if (host.runtimeRole() === HostedReadonlyRuntimeRole.Supervisor) {
      const identity = host.readEpoch().identity, config = input.config;
      if (identity.jobId !== (config.jobId ?? config.taskId) || identity.jobRootDir !== config.jobRootDir ||
          identity.workspacePath !== config.workspacePath) throw new Error("hosted_custody_runtime_identity_mismatch");
      const [command, ...args] = buildCodexGoalForegroundArgv(input, lifecycle);
      if (!command) throw new Error("hosted_custody_runtime_command_required");
      return await runHostedReadonlyForeground(command, args, input.cwd, input.config.sourceEnv ?? process.env);
    }
  }
  await admitHostedControllerLaunch(input);
  return undefined;
}

export function stopHostedGoalLaunch(input: CodexGoalLaunchInput): void {
  if (!isHostedGoalLaunch(input)) throw new Error("hosted_custody_stop_route_required");
  const identity = { jobId: input.config.jobId ?? input.config.taskId,
    jobRootDir: input.config.jobRootDir, workspacePath: input.config.workspacePath };
  if (new HostedInstallationActivationStore().stopOrdinaryRuntime(identity)) return;
  new HostedReadonlySupervisorHost().stopRuntime(identity);
}
