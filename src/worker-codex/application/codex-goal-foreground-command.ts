import type { CodexGoalLaunchInput } from "../codex-goal-ops";
import { assertCodexGoalAccessLaunchAllowed } from "../codex-goal-access-plan";

export enum HostedGoalLifecycleOperation {
  Start = "start",
  Continue = "continue",
  Recover = "recover",
}

/** Operation context, never admission authority. The inner use case rechecks it. */
export type HostedGoalLifecycleRequest = {
  readonly operation: HostedGoalLifecycleOperation;
  readonly jobId: string;
  readonly confirmed: boolean;
  readonly skipDoctor: boolean;
  readonly forceStart: boolean;
  readonly staleAfterMs?: number;
};

export function buildCodexGoalForegroundArgv(
  input: CodexGoalLaunchInput,
  lifecycle?: HostedGoalLifecycleRequest,
): string[] {
  const config = input.config;
  assertCodexGoalAccessLaunchAllowed(config);
  const args = [
    ...input.cliCommand,
    "run",
    "--no-tmux",
    "--job-root",
    config.jobRootDir,
    "--auth-root",
    config.authRootDir,
    "--workspace",
    config.workspacePath,
    "--prompt",
    config.promptPath,
    "--task-id",
    config.taskId,
    "--accounts",
    config.accounts.map((account) => account.name).join(","),
    "--format",
    input.format ?? "text",
  ];
  pushOptional(args, "--registry-root", input.registryRootDir);
  pushOptional(args, "--description", input.registryMetadata?.description);
  pushOptional(args, "--tags", input.registryMetadata?.tags?.join(","));
  pushOptional(args, "--state-root", config.stateRootDir);
  pushOptional(args, "--job-id", config.jobId);
  pushOptional(args, "--codex-goal-objective", config.codexGoalObjective);
  pushOptional(args, "--output", config.outputPath);
  pushOptional(args, "--progress", config.progressPath);
  pushOptional(args, "--codex-binary", config.codexBinaryPath);
  pushOptional(args, "--model", config.model);
  pushOptional(args, "--effort", config.reasoningEffort);
  pushOptional(args, "--service-tier", config.serviceTier);
  pushOptional(args, "--execution-engine", config.executionEngine);
  pushOptionalNumber(args, "--timeout-ms", config.taskTimeoutMs);
  pushOptionalNumber(
    args,
    "--app-server-startup-timeout-ms",
    config.appServerStartupTimeoutMs,
  );
  pushOptionalNumber(args, "--progress-heartbeat-ms", config.progressHeartbeatMs);
  pushOptionalNumber(args, "--stale-lock-ms", config.staleLockMs);
  pushOptionalNumber(args, "--max-account-cycles", config.maxAccountCycles);
  pushOptional(args, "--edit-mode", config.editMode);
  pushOptional(args, "--provider-sandbox-mode", config.providerSandboxMode);
  pushOptional(args, "--access-boundary", config.accessBoundary);
  if (config.projectAccessScope) {
    args.push(
      "--project-access-scope-json",
      JSON.stringify(config.projectAccessScope),
    );
  }
  if (config.allowDangerFullAccess) args.push("--allow-danger-full-access");
  pushOptional(args, "--network-access", config.networkAccess);
  if (config.allowDuplicateAccountIdentities) args.push("--allow-duplicate-accounts");
  if (config.requireGitWorkspace === false) args.push("--no-require-git-workspace");
  if (config.prewarmOnStart) args.push("--prewarm");
  if (lifecycle) {
    args.push("--hosted-lifecycle", lifecycle.operation, "--lifecycle-job-id", lifecycle.jobId);
    if (lifecycle.confirmed) args.push("--lifecycle-confirmed");
    if (lifecycle.skipDoctor) args.push("--lifecycle-skip-doctor");
    if (lifecycle.forceStart) args.push("--lifecycle-force-start");
    pushOptionalNumber(args, "--lifecycle-stale-after-ms", lifecycle.staleAfterMs);
    pushOptional(args, "--tmux-session", input.tmuxSession);
    pushOptional(args, "--log", input.logPath);
  }
  return args;
}

function pushOptional(
  args: string[],
  flagName: string,
  value: string | undefined,
): void {
  if (value === undefined) return;
  args.push(flagName, value);
}

function pushOptionalNumber(
  args: string[],
  flagName: string,
  value: number | undefined,
): void {
  if (value === undefined) return;
  args.push(flagName, String(value));
}
