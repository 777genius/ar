import { codexWorkerReportSchemaName, codexWorkerReportSchema, codexWorkerReportSystemPrompt } from "./codex-goal-report-schema";
export { codexWorkerReportSchemaName, codexWorkerReportSchema, codexWorkerReportSystemPrompt } from "./codex-goal-report-schema";
import { admitHostedReadonlyInputs } from "./hosted-readonly-admission";
import { admitHostedTestEgress, hostedTestEgressEvidence } from "./hosted-test-egress-admission";
import {
  CodexModelBackend,
  codexMimoApiKeyEnvVarDefault,
  codexProviderEgressPolicy,
  type CodexProviderEgressPolicy,
} from "@vioxen/subscription-runtime/provider-codex";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { mapManagedGoalLayout, usesManagedJobLayout } from "./managed-goal-admission";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { ObservabilityPort } from "@vioxen/subscription-runtime/core";
import type { ProviderTaskControls } from "@vioxen/subscription-runtime/core";
import {
  ActiveAttemptInterruptMonitor,
  AccessBoundary,
  InMemoryActiveAttemptRegistry,
  type NetworkAccessMode,
  type ProjectAccessScope,
  type SafeExecutionPolicy,
  type SafeExecutionRunResult,
  type TaskEffectMode,
  WorkerControlService,
  type RuntimeRecommendedAction,
  type RuntimeResultEnvelopeInput,
  type RuntimeResultStatus,
  type WorkerReport,
} from "@vioxen/subscription-runtime/worker-core";
import {
  codexRunnerExceptionFailure,
  runtimeActionFromSafeExecutionResult,
  runtimeBlockersFromSafeExecutionResult,
  runtimeEvidenceFromSafeExecutionResult,
  runtimeResultDetails,
  runtimeStatusFromSafeExecutionResult,
  workerReportFromSafeExecutionResult,
} from "./codex-goal-run-result";
import type {
  CodexAppServerProcessFactory,
  CodexReasoningEffort,
  CodexServiceTier,
} from "@vioxen/subscription-runtime/provider-codex";
import { LocalFileWorkerControlInboxStore } from "@vioxen/subscription-runtime/store-local-file";
import { LocalTerminalCheckpointAdmission } from "@vioxen/subscription-runtime/store-local-file";
import {
  FileBackendCodexSafeExecutor,
  type FileBackendCodexSafeExecutorOptions,
} from "./file-backend-codex-safe-executor";
import {
  ensureCodexAgentTempRoot,
  removeCodexAgentTempRoot,
} from "../provider-codex/codex-runtime-temp";
import {
  codexAccountCapacityStore,
  migrateLegacyCodexAccountCapacity,
} from "./application/codex-account-capacity-store";
import type {
  CodexWorkerExecutionEngine,
  FileBackendCodexWorkerResult,
} from "./file-backend-codex-worker";
import {
  assertCodexGoalAccessLaunchAllowed,
  buildCodexGoalAccessLaunchPlan,
  commandPolicyForHostedCodexGoal,
  codexGoalControlsForAccessBoundary,
} from "./codex-goal-access-plan";
import { readLocalGitHeadCommit } from "./codex-goal-git-revision";
import { assertCodexGoalTurnCheckpointHistory, createCodexGoalTurnCheckpoint, codexGoalTurnCheckpointSocketPublisher, type CodexGoalTurnCheckpointPublisher } from "./codex-goal-turn-checkpoint";
import { createCodexGoalResultRecorder } from "./codex-goal-runtime-result-io";
import { writeCodexGoalProgress } from "./codex-goal-progress-io";
import {
  terminalCodexGoalHandoffEvidence,
  terminalCodexGoalHandoffResultDetails,
  tryMaterializeTerminalCodexGoalHandoff,
} from "./codex-goal-terminal-handoff-materialization";
import {
  codexGoalRuntimeEventObservability,
  createCodexGoalRuntimeEventWriter,
} from "./codex-goal-runtime-events";
import {
  changedFilesFromSafeExecutionResult,
  changedFilesFromWorkspace,
  uniqueStrings,
} from "./codex-goal-workspace-changes";
import { resolveCodexGoalObjective } from "./codex-goal-objective";
import type { CodexGoalMimoAccountSlot } from "./codex-goal-mimo-account-slots";
export type {
  CodexGoalRuntimeEvent,
  CodexGoalRuntimeEventLevel,
} from "./codex-goal-runtime-events";

const execFileAsync = promisify(execFile);
const gitMetadataTimeoutMs = 5_000;

export type CodexGoalAccountSlot = {
  readonly name: string;
  readonly authJsonPath?: string;
  readonly envVarName?: string;
};

export type CodexGoalRunConfig = {
  readonly jobId?: string;
  readonly jobRootDir: string;
  readonly stateRootDir?: string;
  readonly runtimeHomeRootDir?: string;
  readonly encryptionKeyPath?: string;
  readonly authRootDir: string;
  readonly workspacePath: string;
  readonly promptPath: string;
  readonly taskId: string;
  readonly accounts: readonly CodexGoalAccountSlot[];
  readonly mimoAccounts?: readonly CodexGoalMimoAccountSlot[];
  readonly outputPath?: string;
  readonly progressPath?: string;
  readonly progressHeartbeatMs?: number;
  readonly executorId?: string;
  readonly codexBinaryPath?: string;
  readonly model?: string;
  readonly reasoningEffort?: CodexReasoningEffort;
  readonly serviceTier?: CodexServiceTier;
  readonly executionEngine?: CodexWorkerExecutionEngine;
  /** Trusted operator Unix socket. Omission leaves all existing jobs unchanged. */
  readonly checkpointPublisherSocketPath?: string;
  /** Persisted safety requirement; a missing operator publisher fails admission. */
  readonly checkpointRequired?: boolean;
  /** Defaults to {@link CodexModelBackend.OpenAiChatGpt} — an existing run config with no modelBackend is unaffected. */
  readonly modelBackend?: CodexModelBackend;
  readonly taskTimeoutMs?: number;
  readonly appServerStartupTimeoutMs?: number;
  readonly staleLockMs?: number;
  readonly maxAccountCycles?: number;
  readonly quotaCooldownMs?: number;
  readonly reconnectCooldownMs?: number;
  readonly maxReconnectRetriesPerAccount?: number;
  readonly editMode?: ProviderTaskControls["editMode"];
  readonly providerSandboxMode?: ProviderTaskControls["providerSandboxMode"];
  readonly accessBoundary?: AccessBoundary;
  readonly projectAccessScope?: ProjectAccessScope;
  readonly allowDangerFullAccess?: boolean;
  readonly networkAccess?: NetworkAccessMode.Disabled | NetworkAccessMode.Restricted;
  readonly goalSummary?: string;
  readonly codexGoalObjective?: string;
  readonly effectMode?: TaskEffectMode;
  readonly safeExecutionPolicy?: SafeExecutionPolicy;
  readonly allowDuplicateAccountIdentities?: boolean;
  readonly requireGitWorkspace?: boolean;
  readonly prewarmOnStart?: boolean;
  readonly workerReportMode?: CodexGoalWorkerReportMode | undefined;
  readonly sourceEnv?: Readonly<Record<string, string | undefined>>;
};

export type CodexGoalWorkerReportMode = "runtime-only" | "structured-output";

export const codexGoalLinkedWorktreeHandoffSystemPrompt = [
  "Linked git worktree sandbox rule:",
  "You are edit/test/handoff-only in this isolated linked worktree.",
  "Do not run git add, git commit, or git push.",
  "Run targeted verification, leave the workspace diff intact, and summarize changed files, tests, blockers, and risks in your final handoff.",
  "The project controller will apply, commit, and push through the Project Integration lifecycle.",
].join(" ");

export type CodexGoalProgressStatus =
  | "starting"
  | "running"
  | "stopped"
  | "maintenance_paused"
  | "completed"
  | "partial"
  | "blocked"
  | "failed"
  | "aborted";

export type CodexGoalProgressSnapshot = {
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly status: CodexGoalProgressStatus;
  readonly updatedAt: string;
  readonly pid: number;
  readonly reason?: string;
  readonly resultStatus?: string;
  readonly attemptCount?: number;
  readonly currentAccount?: string;
};

export type CodexGoalRunDeps = {
  /** Trusted adapter port, never supplied by serialized job configuration. */
  readonly admitProviderEgress?: typeof admitHostedTestEgress;
  readonly createExecutor?: (
    options: FileBackendCodexSafeExecutorOptions,
  ) => CodexGoalExecutor;
  readonly observability?: ObservabilityPort;
  readonly checkpointPublisher?: CodexGoalTurnCheckpointPublisher;
};

export type CodexGoalExecutor = {
  run(
    input: Parameters<FileBackendCodexSafeExecutor["run"]>[0],
  ): Promise<SafeExecutionRunResult<FileBackendCodexWorkerResult>>;
  dispose(): Promise<void>;
};

export async function runCodexGoal(
  config: CodexGoalRunConfig,
  deps: CodexGoalRunDeps = {},
): Promise<SafeExecutionRunResult<FileBackendCodexWorkerResult>> {
  config = mapManagedGoalLayout({ config }).config;
  assertCodexGoalRunConfig(config);
  assertCodexGoalAccessLaunchAllowed(config);
  const admittedEgress = await (deps.admitProviderEgress ?? admitHostedTestEgress)({
    jobId: config.jobId ?? config.taskId,
    jobRootDir: config.jobRootDir,
    workspacePath: config.workspacePath,
    ...(config.executionEngine ? { executionEngine: config.executionEngine } : {}),
    sourceEnv: config.sourceEnv ?? process.env,
  });
  const providerEgressPolicy = codexProviderEgressPolicy(admittedEgress.profileId);
  const baseCommit = await readLocalGitHeadCommit(config.workspacePath);
  const checkpointRootExists = await lstat(join(config.jobRootDir, "turn-checkpoints"))
    .then(() => true, (error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
      throw error;
    });
  if ((config.checkpointRequired || checkpointRootExists) &&
    !config.checkpointPublisherSocketPath && !deps.checkpointPublisher) {
    throw new Error("checkpoint_publisher_required");
  }
  if (config.checkpointPublisherSocketPath || deps.checkpointPublisher) {
    if (!baseCommit) throw new Error("checkpoint_initial_base_required");
    await assertCodexGoalTurnCheckpointHistory({ jobId: config.jobId ?? config.taskId,
      taskId: config.taskId, jobRootDir: config.jobRootDir, initialBaseCommit: baseCommit });
  }
  const appServerProcessFactory = admitHostedReadonlyInputs({
    jobId: config.jobId ?? config.taskId,
    jobRootDir: config.jobRootDir,
    workspacePath: config.workspacePath,
    providerEgressPolicy,
    ...(config.executionEngine ? { executionEngine: config.executionEngine } : {}),
    sourceEnv: config.sourceEnv ?? process.env,
  });
  return new LocalTerminalCheckpointAdmission(config.jobRootDir).withWriter(
    () => runCodexGoalAdmitted(config, deps, providerEgressPolicy, appServerProcessFactory, baseCommit),
  );
}

async function runCodexGoalAdmitted(
  config: CodexGoalRunConfig,
  deps: CodexGoalRunDeps,
  providerEgressPolicy: CodexProviderEgressPolicy,
  appServerProcessFactory: CodexAppServerProcessFactory | undefined,
  baseCommit: string | undefined,
): Promise<SafeExecutionRunResult<FileBackendCodexWorkerResult>> {
  const prompt = await readFile(config.promptPath, "utf8");
  const progressPath = codexGoalProgressPath(config);
  const runtimeEventsPath = codexGoalRuntimeEventsPath(config);
  const outputPath = codexGoalOutputPath(config);
  const executionGeneration = randomUUID();
  const resultRecorder = createCodexGoalResultRecorder({ outputPath,
    terminalCheckpointJobRootDir: config.jobRootDir });
  const progressHeartbeat = createCodexGoalProgressHeartbeat({
    progressPath,
    taskId: config.taskId,
    intervalMs: config.progressHeartbeatMs ?? 60_000,
  });
  const runtimeEvents = createCodexGoalRuntimeEventWriter({
    eventPath: runtimeEventsPath,
    taskId: config.taskId,
    terminalCheckpointJobRootDir: config.jobRootDir,
  });
  const observability =
    deps.observability ?? codexGoalRuntimeEventObservability(runtimeEvents);
  await runtimeEvents.write("runner_starting", {
    jobId: config.jobId ?? config.taskId,
    executionGeneration,
    executionEngine: config.executionEngine ?? "app-server-goal",
    accountCount: config.accounts.length,
    ...hostedTestEgressEvidence(config, providerEgressPolicy),
  });
  const linkedWorktreeHandoff = await codexGoalLinkedWorktreeHandoffPreflight({
    config,
    prompt,
  });
  if (linkedWorktreeHandoff.enabled) {
    await runtimeEvents.write("linked_worktree_handoff_guardrail", {
      accessBoundary: config.accessBoundary ?? "",
      workspaceKind: "linked_git_worktree",
    });
  }
  if (linkedWorktreeHandoff.commitRequested) {
    await runtimeEvents.write("linked_worktree_commit_preflight_warning", {
      level: "warning",
      accessBoundary: config.accessBoundary ?? "",
      workspaceKind: "linked_git_worktree",
      guidance: "edit_test_handoff_only",
    });
  }
  await progressHeartbeat.write({ status: "starting" });
  const encryptionKey = await readOrCreateCodexGoalEncryptionKey(
    config.encryptionKeyPath ?? join(config.jobRootDir, "encryption-key.hex"),
  );
  const stateRootDir = config.stateRootDir ?? join(config.jobRootDir, "state");
  await mkdir(stateRootDir, { recursive: true, mode: 0o700 });
  const agentTempRoot = await ensureCodexAgentTempRoot({
    sourceEnv: config.sourceEnv,
  });

  const controlInbox = new WorkerControlService({
    store: new LocalFileWorkerControlInboxStore({ rootDir: stateRootDir }),
  });
  const activeAttemptRegistry = new InMemoryActiveAttemptRegistry();
  const interruptMonitor = new ActiveAttemptInterruptMonitor({
    control: controlInbox,
    activeAttemptRegistry,
  });

  let executor: CodexGoalExecutor;
  try {
    executor = (
      deps.createExecutor ??
      ((options) => new FileBackendCodexSafeExecutor(options))
    )(buildCodexGoalExecutorOptions({
      config,
      ...(baseCommit ? { initialBaseCommit: baseCommit } : {}),
      ...(deps.checkpointPublisher ? { checkpointPublisher: deps.checkpointPublisher } : {}),
      providerEgressPolicy,
      ...(appServerProcessFactory ? { appServerProcessFactory } : {}),
      stateRootDir,
      executionGeneration,
      encryptionKey,
      observability,
      controlInbox,
      activeAttemptRegistry,
    }));
  } catch (error) {
    await removeCodexAgentTempRoot(agentTempRoot);
    throw error;
  }

  try {
    interruptMonitor.start({
      jobId: config.jobId ?? config.taskId,
      taskId: config.taskId,
      workspaceId: config.workspacePath,
    });
    progressHeartbeat.start();
    await runtimeEvents.write("executor_started", {
      jobId: config.jobId ?? config.taskId,
      executionEngine: config.executionEngine ?? "app-server-goal",
    });
    const controls = codexGoalControlsForAccessBoundary(config);
    const result = await executor.run({
      ...(config.jobId === undefined ? {} : { jobId: config.jobId }),
      taskId: config.taskId,
      prompt,
      originalPrompt: prompt,
      ...(config.staleLockMs === undefined
        ? {}
        : { staleLockMs: config.staleLockMs }),
      ...(config.maxAccountCycles === undefined
        ? {}
        : { maxAccountCycles: config.maxAccountCycles }),
      ...(config.effectMode === undefined ? {} : { effectMode: config.effectMode }),
      ...(config.safeExecutionPolicy === undefined
        ? {}
        : { safeExecutionPolicy: config.safeExecutionPolicy }),
      ...(config.workerReportMode === "structured-output"
        ? {
            outputSchemaName: codexWorkerReportSchemaName,
          }
        : {}),
      controls: {
        ...controls,
      },
      systemPrompt: codexGoalRunSystemPrompt(config, {
        linkedWorktreeHandoff: linkedWorktreeHandoff.enabled,
      }),
      metadata: {
        goal: config.goalSummary ?? config.taskId,
        codexGoalObjective: resolveCodexGoalObjective(config),
      },
    });
    await resultRecorder.record(await codexRuntimeResultInput({
      config,
      result,
      executionGeneration,
      ...(baseCommit === undefined ? {} : { baseCommit }),
    }));
    await progressHeartbeat.write(progressFromResult(result));
    await runtimeEvents.write("executor_finished", {
      status: result.status,
      attemptCount: attemptCountFromResult(result),
      currentAccount: currentAccountFromResult(result) ?? "",
    });
    return result;
  } catch (error) {
    const failure = codexRunnerExceptionFailure(error);
    await resultRecorder.record(await codexExceptionRuntimeResultInput({
      config,
      error,
      executionGeneration,
      ...(baseCommit === undefined ? {} : { baseCommit }),
    }));
    await progressHeartbeat.write({
      status: "failed",
      reason: failure.reason,
    });
    await runtimeEvents.write("runner_exception", {
      level: "error",
      reason: failure.reason,
      safeMessage: failure.safeMessage,
    });
    throw error;
  } finally {
    await progressHeartbeat.stop();
    await interruptMonitor.stop();
    try {
      await executor.dispose();
    } finally {
      const cleanupWarning = await removeCodexAgentTempRoot(agentTempRoot);
      if (cleanupWarning) {
        try {
          await runtimeEvents.write("agent_temp_cleanup_warning", {
            level: "warning",
            reason: cleanupWarning,
          });
        } catch {
          // Cleanup observability must never mask the executor result.
        }
      }
    }
    await runtimeEvents.write("runner_disposed", {
      jobId: config.jobId ?? config.taskId,
      executionGeneration,
    });
  }
}

export function buildCodexGoalExecutorOptions(input: {
  readonly config: CodexGoalRunConfig;
  readonly initialBaseCommit?: string;
  readonly checkpointPublisher?: CodexGoalTurnCheckpointPublisher;
  readonly providerEgressPolicy?: CodexProviderEgressPolicy;
  readonly appServerProcessFactory?: CodexAppServerProcessFactory;
  readonly stateRootDir: string;
  readonly executionGeneration?: string;
  readonly encryptionKey: Uint8Array;
  readonly observability?: ObservabilityPort;
  readonly controlInbox?: WorkerControlService;
  readonly activeAttemptRegistry?: InMemoryActiveAttemptRegistry;
}): FileBackendCodexSafeExecutorOptions {
  const { config } = input;
  const checkpointPublisher = input.checkpointPublisher ?? (config.checkpointPublisherSocketPath
    ? codexGoalTurnCheckpointSocketPublisher(config.checkpointPublisherSocketPath) : undefined);
  if (config.checkpointRequired && !checkpointPublisher) throw new Error("checkpoint_publisher_required");
  if (checkpointPublisher && (!input.initialBaseCommit || (config.executionEngine ?? "app-server-goal") !== "app-server-goal")) {
    throw new Error("checkpoint_requires_git_app_server_goal");
  }
  const completedTurnCheckpoint = checkpointPublisher && input.initialBaseCommit
    ? createCodexGoalTurnCheckpoint({ jobId: config.jobId ?? config.taskId,
        taskId: config.taskId, jobRootDir: config.jobRootDir, workspacePath: config.workspacePath,
        initialBaseCommit: input.initialBaseCommit, publisher: checkpointPublisher }) : undefined;
  const modelBackend = config.modelBackend ?? CodexModelBackend.OpenAiChatGpt;
  const isMimo = modelBackend === CodexModelBackend.XiaomiMimoTokenPlan;
  const mimoAccountsByName = new Map(
    (config.mimoAccounts ?? []).map((account) => [account.name, account]),
  );
  const accessLaunchPlan = buildCodexGoalAccessLaunchPlan(config);
  const commandPolicy = commandPolicyForHostedCodexGoal({
    accessLaunchPlan,
    sourceEnv: config.sourceEnv,
  });
  return {
    ...(config.executorId ? { executorId: config.executorId } : {}),
    authRootDir: config.authRootDir,
    ...(input.observability ? { observability: input.observability } : {}),
    ...(input.controlInbox ? { controlInbox: input.controlInbox } : {}),
    ...(input.activeAttemptRegistry
      ? { activeAttemptRegistry: input.activeAttemptRegistry }
      : {}),
    stateRootDir: input.stateRootDir,
    terminalCheckpointJobRootDir: config.jobRootDir,
    ...(completedTurnCheckpoint ? { completedTurnCheckpoint } : {}),
    ...(input.executionGeneration === undefined ? {} : { executionGeneration: input.executionGeneration }),
    ...(config.runtimeHomeRootDir === undefined ? {} : { runtimeHomeRootDir: config.runtimeHomeRootDir }),
    accountCapacityStore: isMimo
      ? codexAccountCapacityStore(config.authRootDir, {
          ...(input.observability ? { observability: input.observability } : {}),
        })
      : migrateLegacyCodexAccountCapacity({
          authRootDir: config.authRootDir,
          stateRootDir: input.stateRootDir,
          accountIds: config.accounts.map((account) => account.name),
          authJsonPaths: Object.fromEntries(
            config.accounts.map((account) => [
              account.name,
              account.authJsonPath ??
                join(config.authRootDir, account.name, "auth.json"),
            ]),
          ),
          ...(input.observability ? { observability: input.observability } : {}),
        }),
    workspacePath: config.workspacePath,
    maxAccountCycles: config.maxAccountCycles ?? 5,
    allowDuplicateAccountIdentities:
      config.allowDuplicateAccountIdentities ?? false,
    requireGitWorkspace: config.requireGitWorkspace ?? true,
    prewarmOnStart: config.prewarmOnStart ?? false,
    ...(config.workerReportMode === "structured-output"
      ? {
          outputSchemas: {
            [codexWorkerReportSchemaName]: codexWorkerReportSchema,
          },
        }
      : {}),
    ...(config.effectMode === undefined ? {} : { effectMode: config.effectMode }),
    ...(config.safeExecutionPolicy === undefined
      ? {}
      : { safeExecutionPolicy: config.safeExecutionPolicy }),
    accounts: config.accounts.map((account) => ({
      ...(isMimo
        ? {}
        : {
            codexAuthJsonPath:
              account.authJsonPath ??
              join(config.authRootDir, account.name, "auth.json"),
          }),
      worker: {
        providerInstanceId: `${config.taskId}-${account.name}`,
        stateRootDir: input.stateRootDir,
        codexBinaryPath: config.codexBinaryPath ?? "codex",
        encryptionKey: input.encryptionKey,
        executionEngine: config.executionEngine ?? "app-server-goal",
        // Uniform for every account in this map, from the single
        // config.modelBackend value — never per-account. This keeps
        // assertUniformCodexModelBackend's invariant (safe-executor.ts)
        // trivially satisfied: a job launch can never mix backends across
        // its own account pool.
        modelBackend,
        ...(isMimo
          ? {
              mimoApiKeyEnvVarName:
                account.envVarName ??
                mimoAccountsByName.get(account.name)?.envVarName ??
                codexMimoApiKeyEnvVarDefault,
            }
          : {}),
        ...(input.providerEgressPolicy ? { providerEgressPolicy: input.providerEgressPolicy } : {}),
        ...(input.appServerProcessFactory ? { appServerProcessFactory: input.appServerProcessFactory } : {}),
        capacityAccountId: account.name,
        taskTimeoutMs: config.taskTimeoutMs ?? 72 * 60 * 60 * 1000,
        ...(config.appServerStartupTimeoutMs === undefined
          ? {}
          : { appServerStartupTimeoutMs: config.appServerStartupTimeoutMs }),
        sourceEnv: config.sourceEnv ?? process.env,
        ...(commandPolicy === undefined ? {} : { commandPolicy }),
        ...(config.model ? { model: config.model } : {}),
        ...(config.reasoningEffort
          ? { reasoningEffort: config.reasoningEffort }
          : {}),
        ...(config.serviceTier ? { serviceTier: config.serviceTier } : {}),
        capacityPolicy: {
          quotaCooldownMs: config.quotaCooldownMs ?? 15 * 60 * 1000,
          reconnectCooldownMs: config.reconnectCooldownMs ?? 15 * 60 * 1000,
          maxReconnectRetriesPerAccount:
            config.maxReconnectRetriesPerAccount ?? 4,
        },
      },
    })),
    safeExecutionPolicy: {
      retryOnCapacity: true,
      retryOnAccountUnavailable: true,
      retryOnReconnectRequired: true,
      retryUnknownCleanWorkspace: false,
      retryUnknownChangedWorkspace: false,
      continuationMode: "packet_first",
      ...(config.safeExecutionPolicy ?? {}),
    },
  };
}

export async function readOrCreateCodexGoalEncryptionKey(
  keyPath: string,
): Promise<Uint8Array> {
  if (existsSync(keyPath)) {
    const value = (await readFile(keyPath, "utf8")).trim();
    if (!/^[a-fA-F0-9]{64}$/.test(value)) {
      throw new Error("codex_goal_encryption_key_invalid");
    }
    return Buffer.from(value, "hex");
  }
  await mkdir(dirname(keyPath), { recursive: true, mode: 0o700 });
  const key = randomBytes(32);
  await writeFile(keyPath, `${key.toString("hex")}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return key;
}

export function codexGoalProgressPath(config: Pick<CodexGoalRunConfig, "jobRootDir" | "taskId" | "progressPath">): string {
  return config.progressPath ?? join(config.jobRootDir, `${config.taskId}.progress.json`);
}

export function codexGoalOutputPath(
  config: Pick<CodexGoalRunConfig, "jobRootDir" | "taskId" | "outputPath">,
): string {
  return config.outputPath ?? join(config.jobRootDir, `${config.taskId}.latest-result.json`);
}

export function codexGoalRuntimeEventsPath(
  config: Pick<CodexGoalRunConfig, "jobRootDir" | "taskId" | "outputPath">,
): string {
  return join(usesManagedJobLayout(config as CodexGoalRunConfig) && config.outputPath
    ? dirname(config.outputPath) : config.jobRootDir, `${config.taskId}.events.jsonl`);
}

export function codexGoalAccountSlots(
  accounts: readonly string[],
  mimoAccounts: readonly CodexGoalMimoAccountSlot[] = [],
): readonly CodexGoalAccountSlot[] {
  const mimoByName = new Map(
    mimoAccounts.map((account) => [account.name, account]),
  );
  return accounts
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => {
      const mimoAccount = mimoByName.get(name);
      return {
        name,
        ...(mimoAccount?.envVarName === undefined
          ? {}
          : { envVarName: mimoAccount.envVarName }),
      };
    });
}

function assertCodexGoalRunConfig(config: CodexGoalRunConfig): void {
  if (!config.jobRootDir.trim()) throw new Error("codex_goal_job_root_required");
  if (!config.authRootDir.trim()) throw new Error("codex_goal_auth_root_required");
  if (!config.workspacePath.trim()) throw new Error("codex_goal_workspace_required");
  if (!config.promptPath.trim()) throw new Error("codex_goal_prompt_required");
  if (!config.taskId.trim()) throw new Error("codex_goal_task_id_required");
  if (config.accounts.length === 0) throw new Error("codex_goal_accounts_required");
  assertPositiveInteger(config.taskTimeoutMs, "codex_goal_task_timeout_invalid");
  assertPositiveInteger(
    config.appServerStartupTimeoutMs,
    "codex_goal_app_server_startup_timeout_invalid",
  );
  assertPositiveInteger(config.staleLockMs, "codex_goal_stale_lock_invalid");
  assertPositiveInteger(config.maxAccountCycles, "codex_goal_account_cycles_invalid");
  assertPositiveInteger(config.quotaCooldownMs, "codex_goal_quota_cooldown_invalid");
  assertPositiveInteger(
    config.reconnectCooldownMs,
    "codex_goal_reconnect_cooldown_invalid",
  );
  assertPositiveInteger(
    config.maxReconnectRetriesPerAccount,
    "codex_goal_reconnect_retries_invalid",
  );
  assertPositiveInteger(
    config.progressHeartbeatMs,
    "codex_goal_progress_heartbeat_invalid",
  );
}

function assertPositiveInteger(value: number | undefined, code: string): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value <= 0) throw new Error(code);
}

function codexGoalWorkerSystemPrompt(taskId: string): string {
  return [
    "Codex goal runtime artifact rule:",
    "If the task asks you to write a report, evidence file, or other artifact to a path outside the current workspace and the sandbox denies that write, write the artifact under /tmp instead.",
    `Use a task-specific directory such as /tmp/${taskId}-artifacts, include the exact fallback path in your final output, and do not mark the goal blocked solely because the external copy could not be performed.`,
    "Keep source worktrees clean unless the task explicitly requires code or docs changes.",
  ].join(" ");
}

function codexGoalRunSystemPrompt(
  config: Pick<CodexGoalRunConfig, "taskId" | "workerReportMode">,
  options: { readonly linkedWorktreeHandoff?: boolean } = {},
): string {
  const prompts = [codexGoalWorkerSystemPrompt(config.taskId)];
  if (options.linkedWorktreeHandoff === true) {
    prompts.push(codexGoalLinkedWorktreeHandoffSystemPrompt);
  }
  if (config.workerReportMode === "structured-output") {
    prompts.push(codexWorkerReportSystemPrompt);
  }
  return prompts.join("\n\n");
}

async function codexGoalLinkedWorktreeHandoffPreflight(input: {
  readonly config: Pick<CodexGoalRunConfig, "accessBoundary" | "workspacePath">;
  readonly prompt: string;
}): Promise<{ readonly enabled: boolean; readonly commitRequested: boolean }> {
  if (input.config.accessBoundary !== AccessBoundary.IsolatedWorkspaceWrite) {
    return { enabled: false, commitRequested: false };
  }
  const linkedWorktree = await isLinkedGitWorktree(input.config.workspacePath);
  if (!linkedWorktree) return { enabled: false, commitRequested: false };
  return {
    enabled: true,
    commitRequested: promptRequestsWorkerGitCommit(input.prompt),
  };
}

async function isLinkedGitWorktree(workspacePath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", [
      "-C",
      workspacePath,
      "rev-parse",
      "--path-format=absolute",
      "--git-dir",
      "--git-common-dir",
    ], { timeout: gitMetadataTimeoutMs });
    const [gitDir, gitCommonDir] = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return Boolean(gitDir && gitCommonDir && gitDir !== gitCommonDir);
  } catch {
    return false;
  }
}

function promptRequestsWorkerGitCommit(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  if (/\bdo not\s+(?:run\s+)?git\s+(?:add|commit|push)\b/.test(normalized)) {
    return false;
  }
  if (/\bdo not\s+(?:commit|push)\b/.test(normalized)) return false;
  if (/\bwithout\s+(?:committing|pushing)\b/.test(normalized)) return false;
  if (/\bgit\s+(?:add|commit|push)\b/.test(normalized)) return true;
  if (/\b(?:create|make|produce)\s+(?:a\s+)?commit\b/.test(normalized)) {
    return true;
  }
  if (/\b(?:commit|push)\s+(?:the\s+)?(?:changes|diff|work)\b/.test(normalized)) {
    return true;
  }
  return /(?:закоммит|закаммит|закамить|закомить|закоммить|запуш)/u.test(
    normalized,
  );
}

function createCodexGoalProgressHeartbeat(input: {
  readonly progressPath: string;
  readonly taskId: string;
  readonly intervalMs: number;
}) {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let writes = Promise.resolve();
  const write = (patch: Omit<
    CodexGoalProgressSnapshot,
    "schemaVersion" | "taskId" | "updatedAt" | "pid"
  >) => {
    writes = writes.then(async () => {
      if (stopped && patch.status === "running") return;
      await writeCodexGoalProgress(input.progressPath, {
        schemaVersion: 1,
        taskId: input.taskId,
        updatedAt: new Date().toISOString(),
        pid: process.pid,
        ...patch,
      });
    });
    return writes;
  };
  return {
    async write(patch: Omit<
      CodexGoalProgressSnapshot,
      "schemaVersion" | "taskId" | "updatedAt" | "pid"
    >): Promise<void> {
      await write(patch);
    },
    start(): void {
      void write({ status: "running" });
      timer = setInterval(() => {
        void write({ status: "running" });
      }, input.intervalMs);
      timer.unref();
    },
    async stop(): Promise<void> {
      stopped = true;
      if (timer) clearInterval(timer);
      await writes;
    },
  };
}

function progressFromResult(
  result: SafeExecutionRunResult<FileBackendCodexWorkerResult>,
): Omit<CodexGoalProgressSnapshot, "schemaVersion" | "taskId" | "updatedAt" | "pid"> {
  const attempts = attemptsFromResult(result);
  const lastAttempt = attempts.at(-1);
  return {
    status: progressStatusFromResult(result.status),
    resultStatus: result.status,
    ...("reason" in result && typeof result.reason === "string"
      ? { reason: result.reason }
      : {}),
    attemptCount: attempts.length,
    ...(lastAttempt && "accountId" in lastAttempt && typeof lastAttempt.accountId === "string"
      ? { currentAccount: lastAttempt.accountId }
      : {}),
  };
}

function attemptsFromResult(
  result: SafeExecutionRunResult<FileBackendCodexWorkerResult>,
) {
  const attempts = "attempts" in result && Array.isArray(result.attempts)
    ? result.attempts
    : [];
  return attempts;
}

function attemptCountFromResult(
  result: SafeExecutionRunResult<FileBackendCodexWorkerResult>,
): number {
  return attemptsFromResult(result).length;
}

function currentAccountFromResult(
  result: SafeExecutionRunResult<FileBackendCodexWorkerResult>,
): string | undefined {
  const lastAttempt = attemptsFromResult(result).at(-1);
  return lastAttempt && "accountId" in lastAttempt &&
    typeof lastAttempt.accountId === "string"
    ? lastAttempt.accountId
    : undefined;
}

function progressStatusFromResult(status: string): CodexGoalProgressStatus {
  if (status === "completed") return "completed";
  if (status === "waiting_capacity") return "blocked";
  if (status === "partial") return "partial";
  if (status === "failed") return "failed";
  if (status === "aborted") return "aborted";
  return "failed";
}

async function codexRuntimeResultInput(input: {
  readonly config: CodexGoalRunConfig;
  readonly result: SafeExecutionRunResult<FileBackendCodexWorkerResult>;
  readonly executionGeneration: string;
  readonly baseCommit?: string;
}): Promise<RuntimeResultEnvelopeInput> {
  const reportedChangedFiles = changedFilesFromSafeExecutionResult(input.result);
  const workspace = await changedFilesFromWorkspace(input.config.workspacePath);
  const changedFiles = uniqueStrings([
    ...reportedChangedFiles,
    ...workspace.changedFiles,
  ]);
  const workerReport = workerReportFromSafeExecutionResult(input.result);
  const reason = "reason" in input.result ? input.result.reason : undefined;
  const status = runtimeStatusFromSafeExecutionResult({
    resultStatus: input.result.status,
    changedFilesCount: changedFiles.length,
  });
  const handoff = changedFiles.length === 0
    ? null
    : await tryMaterializeTerminalCodexGoalHandoff({
        ...input.config,
        ...(input.baseCommit === undefined
          ? {}
          : { expectedBaseCommit: input.baseCommit }),
      });
  const artifacts = handoff?.artifacts ?? [];
  const exactChangedFiles = handoff?.changedPaths ?? changedFiles;
  const details = runtimeResultDetails({
    ...("failureDetails" in input.result && input.result.failureDetails
      ? { failureDetails: input.result.failureDetails }
      : {}),
    ...(input.baseCommit === undefined ? {} : { baseCommit: input.baseCommit }),
    handoffDetails: terminalCodexGoalHandoffResultDetails(handoff),
  });
  return {
    status,
    provider: "codex",
    runId: input.config.jobId ?? input.config.taskId,
    taskId: input.config.taskId,
    reason,
    changedFiles: exactChangedFiles,
    evidence: [
      ...runtimeEvidenceFromSafeExecutionResult(input.result),
      ...(workspace.warning ? [workspace.warning] : []),
      ...artifacts.map((artifact) => `patch_preserved:${artifact.path ?? ""}`),
      ...terminalCodexGoalHandoffEvidence(handoff),
      ...(changedFiles.length > 0 && artifacts.length === 0
        ? ["patch_preserve_unavailable"]
        : []),
    ],
    blockers: runtimeBlockersFromSafeExecutionResult(input.result),
    nextAction: runtimeActionFromSafeExecutionResult({
      status,
      resultStatus: input.result.status,
      reason,
      changedFilesCount: changedFiles.length,
    }),
    ...(workerReport === undefined ? {} : { workerReport }),
    ...(artifacts.length === 0 ? {} : { artifacts }),
    details: { ...(details ?? {}), executionGeneration: input.executionGeneration,
      attemptNumber: String(input.result.attempts.at(-1)?.attemptNumber ?? 0) },
  };
}

async function codexExceptionRuntimeResultInput(input: {
  readonly config: CodexGoalRunConfig;
  readonly error: unknown;
  readonly executionGeneration: string;
  readonly baseCommit?: string;
}): Promise<RuntimeResultEnvelopeInput> {
  const failure = codexRunnerExceptionFailure(input.error);
  const workspace = await changedFilesFromWorkspace(input.config.workspacePath);
  const changedFiles = workspace.changedFiles;
  const handoff = changedFiles.length === 0
    ? null
    : await tryMaterializeTerminalCodexGoalHandoff({
        ...input.config,
        ...(input.baseCommit === undefined
          ? {}
          : { expectedBaseCommit: input.baseCommit }),
      });
  const artifacts = handoff?.artifacts ?? [];
  const exactChangedFiles = handoff?.changedPaths ?? changedFiles;
  const details = runtimeResultDetails({
    failureDetails: {
      errorName: input.error instanceof Error ? input.error.name : "unknown",
      ...(failure.errorCode === undefined
        ? {}
        : { errorCode: failure.errorCode }),
    },
    ...(input.baseCommit === undefined ? {} : { baseCommit: input.baseCommit }),
    handoffDetails: terminalCodexGoalHandoffResultDetails(handoff),
  });
  return {
    status: changedFiles.length > 0 ? "partial" : "failed",
    provider: "codex",
    runId: input.config.jobId ?? input.config.taskId,
    taskId: input.config.taskId,
    reason: failure.reason,
    changedFiles: exactChangedFiles,
    evidence: [
      failure.evidence,
      ...(workspace.warning ? [workspace.warning] : []),
      ...artifacts.map((artifact) => `patch_preserved:${artifact.path ?? ""}`),
      ...terminalCodexGoalHandoffEvidence(handoff),
      ...(changedFiles.length > 0 && artifacts.length === 0
        ? ["patch_preserve_unavailable"]
        : []),
    ],
    blockers: [failure.reason],
    nextAction: changedFiles.length > 0 ? "preserve_patch" : "recover",
    ...(artifacts.length === 0 ? {} : { artifacts }),
    details: { ...(details ?? {}), executionGeneration: input.executionGeneration },
  };
}
