import { join } from "node:path";
import { access } from "node:fs/promises";
import type { CodexGoalRunConfig } from "./codex-goal-runner";
import { deriveManagedJobLayout, MANAGED_JOB_ROOT_ENV, MANAGED_JOB_ID_ENV, MANAGED_MARKER_ENV } from "./managed-job-layout";

export const managedGoalActivationPath = "/opt/subscription-runtime/managed-launcher/managed-host";
export interface ManagedGoalAdmissionDeps {
  readonly platform?: NodeJS.Platform;
  readonly isManagedHost?: () => Promise<boolean>;
}
export interface ManagedGoalAdmission {
  readonly config: CodexGoalRunConfig;
  readonly logPath?: string;
  readonly registryRootDir?: string;
}
export function isAdmittedManagedGoal(config: CodexGoalRunConfig): boolean {
  return config.sourceEnv?.[MANAGED_MARKER_ENV] === "1";
}

/** A single read-only host admission, before registry, launch, or runner writes. */
export async function admitManagedGoal(
  input: ManagedGoalAdmission, deps: ManagedGoalAdmissionDeps = {},
): Promise<ManagedGoalAdmission> {
  if ((deps.platform ?? process.platform) !== "linux") return input;
  const config = input.config;
  const env = config.sourceEnv ?? process.env;
  const managed = await (deps.isManagedHost ?? (async () => {
    try { await access(managedGoalActivationPath); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }))();
  if (!managed && env[MANAGED_MARKER_ENV] === undefined) return input;
  if (env[MANAGED_MARKER_ENV] !== "1" || !env[MANAGED_JOB_ROOT_ENV] || !env[MANAGED_JOB_ID_ENV]) throw new Error('Managed host requires root-owned launcher');
  const layout = deriveManagedJobLayout(env[MANAGED_JOB_ROOT_ENV]!, env[MANAGED_JOB_ID_ENV]!);
  if (layout.jobId !== (config.jobId ?? config.taskId)) throw new Error('Managed job identity mismatch');
  // taskId becomes a filename, so it has the same closed identifier contract.
  if (config.taskId !== config.taskId.trim() || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(config.taskId)) {
    throw new Error("Invalid managed taskId");
  }
  const fixed = {
    jobRootDir: layout.jobRoot, workspacePath: layout.workspace,
    stateRootDir: layout.state, encryptionKeyPath: join(layout.state, "encryption-key.hex"),
    runtimeHomeRootDir: layout.home,
    outputPath: join(layout.output, `${config.taskId}.latest-result.json`),
    progressPath: join(layout.output, `${config.taskId}.progress.json`),
  };
  for (const [key, expected] of Object.entries(fixed)) {
    const actual = config[key as keyof typeof fixed];
    if (actual !== undefined && actual !== expected) throw new Error(`Managed writable override rejected: ${key}`);
  }
  const logPath = join(layout.logs, `${config.taskId}.log`);
  const registryRootDir = join(layout.state, "registry");
  for (const [key, expected] of Object.entries({ logPath, registryRootDir })) {
    const actual = input[key as "logPath" | "registryRootDir"];
    if (actual !== undefined && actual !== expected) throw new Error(`Managed writable override rejected: ${key}`);
  }
  const agentTmp = join(layout.tmp, "agent");
  const fixedEnv = {
    SUBSCRIPTION_RUNTIME_JOB_ID: layout.jobId, SUBSCRIPTION_RUNTIME_JOB_ROOT: layout.jobRoot,
    SUBSCRIPTION_RUNTIME_TMPDIR: layout.tmp, HOME: layout.home,
    TMPDIR: agentTmp, TMP: agentTmp, TEMP: agentTmp,
  };
  // HOME and conventional temp variables are inherited host defaults, not config paths.
  for (const key of ["SUBSCRIPTION_RUNTIME_JOB_ID", "SUBSCRIPTION_RUNTIME_JOB_ROOT", "SUBSCRIPTION_RUNTIME_TMPDIR"] as const) {
    if (env[key] !== undefined && env[key] !== fixedEnv[key]) throw new Error(`Managed writable override rejected: ${key}`);
  }
  const result = Object.freeze({ config: Object.freeze({ ...config, ...fixed,
    sourceEnv: Object.freeze({ ...env, ...fixedEnv }) }), logPath, registryRootDir });
  return result;
}
