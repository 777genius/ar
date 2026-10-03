import type { RunCommand } from "./codex-goal-cli";
import type { CodexGoalLaunchInput } from "./codex-goal-ops";
import { flag, option, requiredOption, writeJsonOrText, type ParsedFlags, type CodexGoalCliIo } from "./codex-goal-cli-support";
import { HostedGoalLifecycleOperation, type HostedGoalLifecycleRequest } from "./application/codex-goal-foreground-command";
import { startCodexGoalLaunch } from "./application/codex-goal-operation-use-cases";
import { continueStoredJobLifecycle } from "./application/codex-goal-job-lifecycle-use-cases";
import { loadJobLaunch } from "./application/codex-goal-job-launch-loader";
import { isHostedGoalLaunch, routeHostedGoalLaunch } from "./hosted-readonly-goal-launch";

/** Finite lifecycle transport. These options never confer host authority. */
export function parseHostedGoalLifecycleRequest(values: ParsedFlags): HostedGoalLifecycleRequest | undefined {
  const env = {};
  const operation = option(values, env, "--hosted-lifecycle", []);
  if (operation !== undefined && !Object.values(HostedGoalLifecycleOperation).includes(operation as HostedGoalLifecycleOperation)) {
    throw new Error("hosted_lifecycle_operation_invalid");
  }
  const staleAfterValue = option(values, env, "--lifecycle-stale-after-ms", []);
  const staleAfterMs = staleAfterValue === undefined ? undefined : Number(staleAfterValue);
  if (staleAfterMs !== undefined && !Number.isFinite(staleAfterMs)) {
    throw new Error("hosted_lifecycle_stale_after_invalid");
  }
  return operation === undefined ? undefined : {
    operation: operation as HostedGoalLifecycleOperation,
    jobId: requiredOption(values, env, "--lifecycle-job-id", []),
    confirmed: flag(values, "--lifecycle-confirmed"),
    skipDoctor: flag(values, "--lifecycle-skip-doctor"),
    forceStart: flag(values, "--lifecycle-force-start"),
    ...(staleAfterMs === undefined ? {} : { staleAfterMs }),
  };
}

export async function runHostedGoalLifecycleCommand(
  command: RunCommand, launch: CodexGoalLaunchInput, io: CodexGoalCliIo,
): Promise<number> {
  const request = command.lifecycle;
  if (!request) throw new Error("hosted_lifecycle_context_required");
  if (!isHostedGoalLaunch(launch) || !command.registryRootDir || command.dryRun || command.printCommand) {
    throw new Error("hosted_lifecycle_context_required");
  }
  const outerStatus = await routeHostedGoalLaunch(launch, request);
  if (outerStatus !== undefined) return outerStatus;
  // Admission precedes manifest reload and all operation effects. Each use
  // case repeats its checks, including admission of the reloaded identity.
  const result = request.operation === HostedGoalLifecycleOperation.Start
    ? await startCodexGoalLaunch({ launch, registryRootDir: command.registryRootDir,
        jobId: request.jobId, confirmStart: request.confirmed,
        skipDoctor: request.skipDoctor, forceStart: request.forceStart })
    : await continueStoredJobLifecycle({ registryRootDir: command.registryRootDir,
        jobId: request.jobId, confirmContinue: request.confirmed, confirmRecover: request.confirmed,
        skipDoctor: request.skipDoctor, forceStart: request.forceStart,
        ...(request.staleAfterMs === undefined ? {} : { staleAfterMs: request.staleAfterMs }) },
      { mode: request.operation,
        confirmKey: request.operation === HostedGoalLifecycleOperation.Continue ? "confirmContinue" : "confirmRecover" },
      { loadJobLaunch });
  writeJsonOrText(command.format, result, io);
  return result.ok ? 0 : 1;
}

export function buildCodexGoalCliLaunchInput(command: RunCommand, cliCommand: readonly string[]) {
  return {
    ...(command.registryRootDir ? { registryRootDir: command.registryRootDir } : {}),
    ...(command.registryMetadata ? { registryMetadata: command.registryMetadata } : {}),
    config: command.config,
    ...(command.tmuxSession ? { tmuxSession: command.tmuxSession } : {}),
    cwd: command.cwd,
    logPath: command.logPath,
    format: command.format,
    cliCommand,
  } as const;
}
