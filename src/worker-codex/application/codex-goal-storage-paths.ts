import { resolvePath } from "./codex-goal-input-values";
import { join } from "node:path";
import { deriveRuntimeJobLayout, deriveRuntimeStorageRoots } from "@vioxen/subscription-runtime/core";
import type { CodexGoalRunConfig, CodexGoalRunInput } from "../codex-goal-runner";
import { mapManagedGoalLayout } from "../managed-goal-admission";
import { MANAGED_JOB_ID_ENV, MANAGED_JOB_ROOT_ENV, MANAGED_MARKER_ENV } from "../managed-job-layout";

type GoalPaths = Pick<CodexGoalRunConfig, "storageRootDir" | "jobId" | "jobRootDir" | "workspacePath" | "taskId" | "stateRootDir" | "runtimeHomeRootDir" | "encryptionKeyPath" | "durableHandoffRootDir" | "outputPath" | "progressPath" | "runtimeEventsPath" | "agentTempRootDir" | "sourceEnv">;
export type CodexGoalPathInput = Omit<GoalPaths, "jobRootDir" | "workspacePath"> & {
  readonly jobRootDir?: string;
  readonly workspacePath?: string;
  readonly logPath?: string;
};

/** Placement only. The managed admission owner still checks caller overrides. */
export function resolveCodexGoalPaths(raw: CodexGoalPathInput): GoalPaths & { readonly logPath?: string } {
  const input = Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== undefined)) as CodexGoalPathInput;
  const roots = input.storageRootDir === undefined ? undefined : deriveRuntimeStorageRoots(input.storageRootDir);
  const env = input.sourceEnv ?? process.env;
  const managed = env[MANAGED_MARKER_ENV] !== undefined;
  if (managed && (env[MANAGED_MARKER_ENV] !== "1" || !env[MANAGED_JOB_ROOT_ENV] || !env[MANAGED_JOB_ID_ENV])) {
    throw new Error("Managed host requires root-owned launcher");
  }
  if (managed) {
    const layout = deriveRuntimeJobLayout(env[MANAGED_JOB_ROOT_ENV]!, env[MANAGED_JOB_ID_ENV]!);
    // Preserve the caller's overrides for the fixed-layout owner to reject.
    const mapped = mapManagedGoalLayout({ config: { ...input,
      jobRootDir: input.jobRootDir ?? layout.jobRoot,
      workspacePath: input.workspacePath ?? layout.workspace,
      sourceEnv: env,
    }, ...(input.logPath === undefined ? {} : { logPath: input.logPath }) });
    return { ...mapped.config, logPath: mapped.logPath,
      durableHandoffRootDir: input.durableHandoffRootDir ?? join(layout.jobRoot, "durable-handoffs") };
  }
  const rootSelected = input.jobRootDir === undefined && roots !== undefined;
  const jobRootDir = input.jobRootDir ?? (roots && join(roots.jobsRootDir, input.jobId ?? input.taskId));
  if (jobRootDir === undefined) throw new Error("jobRootDir is required");
  const layout = rootSelected ? deriveRuntimeJobLayout(jobRootDir, input.jobId ?? input.taskId) : undefined;
  if (layout && (typeof input.taskId !== "string" || input.taskId !== input.taskId.trim() || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(input.taskId))) throw new Error("Invalid runtime taskId");
  const workspacePath = input.workspacePath ?? layout?.workspace;
  if (workspacePath === undefined) throw new Error("workspacePath is required");
  if (!layout) return { ...input, jobRootDir, workspacePath,
    ...(input.agentTempRootDir === undefined ? {} : { sourceEnv: {
      ...env, SUBSCRIPTION_RUNTIME_JOB_ROOT: jobRootDir, SUBSCRIPTION_RUNTIME_TMPDIR: join(jobRootDir, "tmp"),
      TMPDIR: input.agentTempRootDir, TMP: input.agentTempRootDir, TEMP: input.agentTempRootDir,
    } }),
  };
  return {
    ...input, jobRootDir, workspacePath,
    stateRootDir: input.stateRootDir ?? layout.state,
    runtimeHomeRootDir: input.runtimeHomeRootDir ?? layout.home,
    encryptionKeyPath: input.encryptionKeyPath ?? join(layout.state, "encryption-key.hex"),
    durableHandoffRootDir: input.durableHandoffRootDir ?? join(layout.jobRoot, "durable-handoffs"),
    outputPath: input.outputPath ?? join(layout.output, `${input.taskId}.latest-result.json`),
    progressPath: input.progressPath ?? join(layout.output, `${input.taskId}.progress.json`),
    runtimeEventsPath: input.runtimeEventsPath ?? join(layout.output, `${input.taskId}.events.jsonl`),
    logPath: input.logPath ?? join(layout.logs, `${input.taskId}.log`),
    agentTempRootDir: input.agentTempRootDir ?? join(layout.tmp, "agent"),
    sourceEnv: { ...env,
      SUBSCRIPTION_RUNTIME_JOB_ROOT: layout.jobRoot,
      SUBSCRIPTION_RUNTIME_TMPDIR: layout.tmp,
      TMPDIR: input.agentTempRootDir ?? join(layout.tmp, "agent"),
      TMP: input.agentTempRootDir ?? join(layout.tmp, "agent"),
      TEMP: input.agentTempRootDir ?? join(layout.tmp, "agent"),
    },
  };
}

export function resolveCodexGoalRunInput(input: CodexGoalRunInput): CodexGoalRunConfig {
  const { logPath: _log, ...paths } = resolveCodexGoalPaths(input);
  return { ...input, ...paths };
}

/** CLI/MCP normalize relative and tilde paths; an empty explicit root is invalid. */
export function resolveCodexGoalStorageRoot(value: unknown, cwd: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) throw new Error("Invalid runtime storageRootDir");
  return deriveRuntimeStorageRoots(resolvePath(cwd, value)).rootDir;
}
