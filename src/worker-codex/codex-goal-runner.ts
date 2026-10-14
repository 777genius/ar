import { resolveCodexGoalRunInput } from "./application/codex-goal-storage-paths";
import { assertHostedOrdinaryGoalExtent } from "./hosted-ordinary-writer-authority";
import { recordRawGoalStateOrigin } from "./application/project-control/codex-goal-controller-state-location";
import { codexRuntimeResultInput, codexExceptionRuntimeResultInput } from "./codex-goal-runtime-result-collection";
import { resolveOpenWorkerLaunch, openWorkerEvidence, codexGoalOpenWorkerSystemPrompt } from "./project-control-worker-mode";
import { progressFromResult, attemptCountFromResult, currentAccountFromResult } from "./codex-goal-progress-projection";
import { isHostedDependencyWorkspace } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { hostedGoalAdmissionIdentity, withHostedGoalIdentity } from "./hosted-readonly-goal-launch";
import { ManagedDependencyGitRunner, isLinkedGitWorktree } from "./managed-dependency-git";
import { DefaultWorkspaceSnapshotter } from "../worker-local/safe-execution/adapters/default-workspace-snapshotter";
import { OwnedMimoSnapshotGitRunner, type MimoSnapshotTiming, ownedMimoWorkspaceSnapshotter, ownedMimoWorkspaceAccess } from "./owned-mimo-snapshot-git";
import { NodeSafeExecutionWorkspaceAccess } from "../worker-local/safe-execution/adapters/node-safe-execution-workspace-access";
import { admitHostedDependencyEntry, assertHostedDependencyExecutionWorkspace } from "./hosted-dependency-admission";
import { readAdmittedHostedDependencyToolConfig, hostedDependencyToolInstruction,
  invalidateHostedDependencyQualifiedToolEntry, type HostedDependencyQualifiedToolEntry } from "./hosted-dependency-tool-profile";
import type { DependencyToolGuestConfig } from "../core/dependency-environment/dependency-tool-profile";
import { codexProviderHasPublicSources } from "@vioxen/subscription-runtime/provider-codex";
import { researchProviderAdmissionGuard, assertOwnedMimoWorkerConfig, ownedMimoWorkerStart } from "./research-launch-admission";
import { researchMimoWorkerLifecycle } from "./research-mimo-worker-result";
import { snapshotCodexGoalStorageConfig, withCodexGoalStorage, withCodexGoalCheckpointWriter, type CodexGoalNewStorage } from "./job-storage/codex-goal-storage-admission";
import { assertCodexSessionHomeProfile, CodexSessionHomeProfileKind, type CodexSessionHomeProfile } from "./codex-session-home-profile";
import { JobStorageCapabilityUnavailableError, JobStorageUnavailableCapability, type JobStorageWriteLease } from "@vioxen/subscription-runtime/worker-core";
import type { CodexGoalExecutor, CodexGoalExecutorOptionsInput, CodexGoalRunDeps } from "./job-storage/codex-goal-runner-contracts";
export type { CodexGoalExecutor, CodexGoalRunDeps } from "./job-storage/codex-goal-runner-contracts";
import { assertVerifiedHostedChildConfig } from "./hosted-child-slot-files";
import { AgentRuntimeTool, ChildExecutionBudget, type ChildLifetime } from "@vioxen/subscription-runtime/core";
import { assertChildGoalConfig } from "./child-execution-confinement";
import { codexWorkerReportSchemaName, codexWorkerReportSchema, codexWorkerReportSystemPrompt } from "./codex-goal-report-schema";
export { codexWorkerReportSchemaName, codexWorkerReportSchema, codexWorkerReportSystemPrompt } from "./codex-goal-report-schema";
import { admitHostedReadonlyInputs } from "./hosted-readonly-admission";
import { assertHostedMimoGoalConfinement } from "./hosted-mimo-goal-confinement";
import { admitHostedTestEgress, hostedTestEgressEvidence } from "./hosted-test-egress-admission";
import { codexGoalNativeEgressConfig } from "./codex-goal-native-egress";
import {
  CodexModelBackend,
  HostedMimoProfile,
  AppServerExecutionLifetime,
  codexMimoApiKeyEnvVarDefault,
  codexMimoTokenPlanEgressPolicy,
  codexProviderEgressPolicy,
  CodexProviderEgressProfileId,
  createPublicResearchSourceReader,
  type CodexProviderEgressPolicy,
} from "@vioxen/subscription-runtime/provider-codex";
import { randomUUID } from "node:crypto";
import { types as nodeUtilTypes } from "node:util";
import { requiresCurrentHostedDependencyRootPurpose } from "./hosted-dependency-root-purpose";
import { mkdir, readFile } from "node:fs/promises";
import { mapManagedGoalLayout, usesManagedJobLayout } from "./managed-goal-admission";
import { dirname, join } from "node:path";
import type { ObservabilityPort } from "@vioxen/subscription-runtime/core";
import type { ProviderTaskControls } from "@vioxen/subscription-runtime/core";
import {
  ActiveAttemptInterruptMonitor,
  AccessBoundary,
  InMemoryActiveAttemptRegistry,
  type NetworkAccessMode, type WorkerMode,
  type ProjectAccessScope,
  type SafeExecutionPolicy,
  type SafeExecutionRunResult,
  type TaskEffectMode,
  WorkerControlService,
  type RuntimeRecommendedAction,
} from "@vioxen/subscription-runtime/worker-core";
import { codexRunnerExceptionFailure } from "./codex-goal-run-result";
import type {
  CodexAppServerProcessFactory,
  CodexReasoningEffort,
  CodexServiceTier,
} from "@vioxen/subscription-runtime/provider-codex";
import { LocalFileWorkerControlInboxStore } from "@vioxen/subscription-runtime/store-local-file";
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
  codexGoalHostedExecutionBoundary,
} from "./codex-goal-access-plan";
import { createCodexGoalTurnCheckpoint, codexGoalTurnCheckpointSocketPublisher, type CodexGoalTurnCheckpointPublisher } from "./codex-goal-turn-checkpoint";
import { createCodexGoalResultRecorder } from "./codex-goal-runtime-result-io";
import { writeCodexGoalProgress } from "./codex-goal-progress-io";
import {
  codexGoalRuntimeEventObservability,
  createCodexGoalRuntimeEventWriter,
} from "./codex-goal-runtime-events";
import { resolveCodexGoalObjective } from "./codex-goal-objective";
import { readOrCreateCodexGoalEncryptionKey } from "./codex-goal-encryption-key";
export { readOrCreateCodexGoalEncryptionKey } from "./codex-goal-encryption-key";
import { resolveCodexGoalMimoEnvVarName, type CodexGoalMimoAccountSlot } from "./codex-goal-mimo-account-slots";
export type {
  CodexGoalRuntimeEvent,
  CodexGoalRuntimeEventLevel,
} from "./codex-goal-runtime-events";


export type CodexGoalAccountSlot = {
  readonly name: string;
  readonly authJsonPath?: string;
  readonly envVarName?: string;
};

export type CodexGoalRunConfig = {
  readonly childLifetime?: ChildLifetime;
  readonly maxGoalTurns?: number;
  readonly jobId?: string;
  readonly storageRootDir?: string;
  readonly jobRootDir: string;
  readonly durableHandoffRootDir?: string;
  readonly stateRootDir?: string;
  readonly runtimeHomeRootDir?: string;
  /** Explicit NEW-storage opt-in. Omission retains legacy placement/lifecycle. */
  readonly storage?: CodexGoalNewStorage;
  readonly sessionHomeProfile?: CodexSessionHomeProfile;
  readonly encryptionKeyPath?: string;
  readonly authRootDir: string;
  readonly workspacePath: string;
  readonly promptPath: string;
  readonly taskId: string;
  readonly accounts: readonly CodexGoalAccountSlot[];
  readonly mimoAccounts?: readonly CodexGoalMimoAccountSlot[];
  readonly outputPath?: string;
  readonly progressPath?: string;
  readonly runtimeEventsPath?: string;
  readonly agentTempRootDir?: string;
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
  readonly networkAccess?: NetworkAccessMode;
  readonly workerMode?: WorkerMode;
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

export type CodexGoalRunInput = CodexGoalRunConfig | (Omit<CodexGoalRunConfig, "jobRootDir" | "workspacePath" | "storageRootDir"> & {
  readonly storageRootDir: string;
  readonly jobRootDir?: string;
  readonly workspacePath?: string;
});

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

export async function runCodexGoal(
  input: CodexGoalRunInput,
  deps: CodexGoalRunDeps = {},
): Promise<SafeExecutionRunResult<FileBackendCodexWorkerResult>> {
  let config = resolveCodexGoalRunInput(input);
  if (requiresCurrentHostedDependencyRootPurpose()) {
    // Before layout/config IO or any optional adapter callback. The actual
    // protected route uses only fixed composition, including inherited ports.
    if (!deps || typeof deps !== "object" || nodeUtilTypes.isProxy(deps) ||
        ![Object.prototype,null].includes(Object.getPrototypeOf(deps)) || Reflect.ownKeys(deps).length !== 0) {
      throw new Error("hosted_dependency_fixed_goal_composition_required");
    }
    deps = Object.freeze(Object.create(null)) as CodexGoalRunDeps;
  }
  // Reference purpose is a separate closed CLI entry, never a fabricated task.
  assertHostedDependencyExecutionWorkspace(undefined);
  config = withHostedGoalIdentity(config);
  if (config.storage) config = snapshotCodexGoalStorageConfig(config);
  assertCodexGoalRunConfig(config);
  return withCodexGoalStorage(config, deps.storageAdmission,
    lease => runCodexGoalWithStorage(config, deps, lease));
}

async function runCodexGoalWithStorage(config: CodexGoalRunConfig, deps: CodexGoalRunDeps,
  storageLease?: JobStorageWriteLease): Promise<SafeExecutionRunResult<FileBackendCodexWorkerResult>> {
  storageLease?.assertCurrent();
  assertHostedMimoGoalConfinement(config);
  assertCodexGoalAccessLaunchAllowed(config);
  assertHostedOrdinaryGoalExtent(config);
  const admission = await admitHostedDependencyEntry(config), toolEntry = admission?.toolEntry;
  try {
  storageLease?.assertCurrent();
  const dependencyToolConfig = readAdmittedHostedDependencyToolConfig(config.workspacePath, toolEntry);
  const isMimo = config.modelBackend === CodexModelBackend.XiaomiMimoTokenPlan;
  const admittedEgress = await (deps.admitProviderEgress ?? admitHostedTestEgress)({
    ...hostedGoalAdmissionIdentity(config),
    ...codexGoalNativeEgressConfig(config),
    ...(isMimo ? { modelBackend: config.modelBackend } : {}),
  });
  storageLease?.assertCurrent();
  const providerEgressPolicy = isMimo
    ? codexMimoTokenPlanEgressPolicy()
    : codexProviderEgressPolicy(admittedEgress.profileId);
  if (admittedEgress.profileId !== providerEgressPolicy.profileId) {
    throw new Error("codex_goal_provider_egress_admission_mismatch");
  }
  storageLease?.assertCurrent();
  assertHostedOrdinaryGoalExtent(config);
  recordRawGoalStateOrigin(config.jobRootDir);
  const appServerProcessFactory = admitHostedReadonlyInputs({
    ...hostedGoalAdmissionIdentity(config),
    providerEgressPolicy,
    ...(isMimo ? { modelBackend: config.modelBackend } : {}),
  }, toolEntry);
  return await withCodexGoalCheckpointWriter(config, deps, storageLease,
    baseCommit => runCodexGoalAdmitted(config, deps, providerEgressPolicy,
      appServerProcessFactory, baseCommit, dependencyToolConfig, toolEntry, storageLease));
  } finally { invalidateHostedDependencyQualifiedToolEntry(toolEntry); }
}

async function runCodexGoalAdmitted(
  config: CodexGoalRunConfig,
  deps: CodexGoalRunDeps,
  providerEgressPolicy: CodexProviderEgressPolicy,
  appServerProcessFactory: CodexAppServerProcessFactory | undefined,
  baseCommit: string | undefined,
  dependencyToolConfig: DependencyToolGuestConfig | undefined,
  toolEntry: HostedDependencyQualifiedToolEntry | undefined,
  storageLease?: JobStorageWriteLease,
): Promise<SafeExecutionRunResult<FileBackendCodexWorkerResult>> {
  assertHostedOrdinaryGoalExtent(config);
  const ownedMimoLifecycle = researchMimoWorkerLifecycle(appServerProcessFactory);
  const prompt = await readFile(config.promptPath, "utf8");
  storageLease?.assertCurrent();
  const progressPath = codexGoalProgressPath(config);
  const runtimeEventsPath = codexGoalRuntimeEventsPath(config);
  const outputPath = codexGoalOutputPath(config);
  const executionGeneration = storageLease?.receipt.attemptId ?? randomUUID();
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
  const ownedSnapshotTimings: MimoSnapshotTiming[] = [];
  const workerMode = await resolveOpenWorkerLaunch({ config, dependencyToolConfig });
  await runtimeEvents.write("runner_starting", {
    jobId: config.jobId ?? config.taskId,
    executionGeneration,
    executionEngine: config.executionEngine ?? "app-server-goal",
    accountCount: config.accounts.length,
    ...(baseCommit ? { baseCommit } : {}),
    ...hostedTestEgressEvidence(config, providerEgressPolicy),
    ...openWorkerEvidence(workerMode),
  });
  const linkedWorktreeHandoff = await codexGoalLinkedWorktreeHandoffPreflight({
    config,
    prompt,
  });
  storageLease?.assertCurrent();
  if (linkedWorktreeHandoff.enabled && !workerMode.launch) {
    await runtimeEvents.write("linked_worktree_handoff_guardrail", {
      accessBoundary: config.accessBoundary ?? "",
      workspaceKind: "linked_git_worktree",
    });
  }
  if (linkedWorktreeHandoff.commitRequested && !workerMode.launch) {
    await runtimeEvents.write("linked_worktree_commit_preflight_warning", {
      level: "warning",
      accessBoundary: config.accessBoundary ?? "",
      workspaceKind: "linked_git_worktree",
      guidance: "edit_test_handoff_only",
    });
  }
  storageLease?.assertCurrent();
  await progressHeartbeat.write({ status: "starting" });
  storageLease?.assertCurrent();
  assertHostedOrdinaryGoalExtent(config);
  const encryptionKey = await readOrCreateCodexGoalEncryptionKey(
    config.encryptionKeyPath ?? join(config.jobRootDir, "encryption-key.hex"),
  );
  const stateRootDir = config.stateRootDir ?? join(config.jobRootDir, "state");
  storageLease?.assertCurrent();
  assertHostedOrdinaryGoalExtent(config, [stateRootDir]);
  await mkdir(stateRootDir, { recursive: true, mode: 0o700 });
  storageLease?.assertCurrent();
  assertHostedOrdinaryGoalExtent(config);
  const agentTempRoot = await ensureCodexAgentTempRoot({
    sourceEnv: config.sourceEnv,
    sandboxTraverse: config.modelBackend === CodexModelBackend.XiaomiMimoTokenPlan &&
      config.projectAccessScope !== undefined,
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
    storageLease?.assertCurrent();
    executor = (
      deps.createExecutor ??
      ((options) => new FileBackendCodexSafeExecutor(options))
    )(buildCodexGoalExecutorOptions({
      config, ...(workerMode.launch ? { openWorker: workerMode.launch } : {}),
      ...(baseCommit ? { initialBaseCommit: baseCommit } : {}),
      ...(deps.checkpointPublisher ? { checkpointPublisher: deps.checkpointPublisher } : {}),
      providerEgressPolicy,
      ...(appServerProcessFactory ? { appServerProcessFactory } : {}),
      stateRootDir,
      executionGeneration,
      ...(storageLease ? { assertStorageAdmission: () => storageLease.assertCurrent() } : {}),
      encryptionKey,
      observability,
      observeOwnedMimoSnapshotTiming: timing => { if (ownedSnapshotTimings.length < 2) ownedSnapshotTimings.push(timing); },
      controlInbox,
      activeAttemptRegistry,
    }));
  } catch (error) {
    await removeCodexAgentTempRoot(agentTempRoot);
    throw error;
  }

  try {
    if (!config.childLifetime) interruptMonitor.start({
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
        ...(workerMode.launch ? { openWorkerInstruction: codexGoalOpenWorkerSystemPrompt(workerMode.launch.commitAllowed) } : {}),
        ...(dependencyToolConfig ? { dependencyToolInstruction: hostedDependencyToolInstruction(dependencyToolConfig, toolEntry) } : {}),
      }),
      metadata: {
        goal: config.goalSummary ?? config.taskId,
        codexGoalObjective: resolveCodexGoalObjective(config),
      },
    });
    const resultInput = await codexRuntimeResultInput({
      config,
      ...(deps.assertTerminalHandoffPublicationAuthorized ? { publicationAuthority: { assertPublicationAuthorized: deps.assertTerminalHandoffPublicationAuthorized,
        ...(deps.withTerminalHandoffPublicationAuthority ? { withPublicationAuthority: deps.withTerminalHandoffPublicationAuthority } : {}) } } : {}),
      result,
      executionGeneration,
      ...(ownedMimoLifecycle ? { deferHandoff: true } : {}),
      ...(baseCommit === undefined ? {} : { baseCommit }),
    });
    if (ownedMimoLifecycle) { ownedMimoLifecycle.stage(resultInput); return result; }
    await resultRecorder.record(resultInput);
    await progressHeartbeat.write(progressFromResult(result));
    await runtimeEvents.write("executor_finished", {
      status: result.status,
      attemptCount: attemptCountFromResult(result),
      currentAccount: currentAccountFromResult(result) ?? "",
    });
    return result;
  } catch (error) {
    const failure = codexRunnerExceptionFailure(error);
    const resultInput = await codexExceptionRuntimeResultInput({
      config,
      ...(deps.assertTerminalHandoffPublicationAuthorized ? { publicationAuthority: { assertPublicationAuthorized: deps.assertTerminalHandoffPublicationAuthorized,
        ...(deps.withTerminalHandoffPublicationAuthority ? { withPublicationAuthority: deps.withTerminalHandoffPublicationAuthority } : {}) } } : {}),
      error,
      executionGeneration,
      ...(ownedMimoLifecycle ? { deferHandoff: true } : {}),
      ...(baseCommit === undefined ? {} : { baseCommit }),
    });
    if (ownedMimoLifecycle) { ownedMimoLifecycle.stage(resultInput); throw error; }
    await resultRecorder.record(resultInput);
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
      ...Object.fromEntries(ownedSnapshotTimings.flatMap(timing => {
        const prefix = "mimo_" + timing.scope + "_";
        return [[prefix + "outcome", timing.outcome], [prefix + "elapsedMs", timing.elapsedMs],
          [prefix + "admissionCount", timing.admissionCount], [prefix + "admissionElapsedMs", timing.admissionElapsedMs],
          [prefix + "successfulGitCount", timing.successfulGitCount], [prefix + "successfulGitElapsedMs", timing.successfulGitElapsedMs]];
      })),
    });
  }
}

export function buildCodexGoalExecutorOptions(input: CodexGoalExecutorOptionsInput): FileBackendCodexSafeExecutorOptions {
  const config = withHostedGoalIdentity(input.config);
  assertHostedOrdinaryGoalExtent(config);
  assertCodexSessionHomeProfile(config.sessionHomeProfile);
  if (config.sessionHomeProfile?.kind === CodexSessionHomeProfileKind.OneShot) {
    throw new JobStorageCapabilityUnavailableError(JobStorageUnavailableCapability.OneShotDisposal);
  }
  const dependencyGit = isHostedDependencyWorkspace(config.workspacePath) ? new ManagedDependencyGitRunner() : undefined;
  const runtimeHomeRootDir = dependencyGit ? join(config.jobRootDir, "home") : config.runtimeHomeRootDir;
  const researchAdmission = researchProviderAdmissionGuard(input.appServerProcessFactory);
  const assertProviderAdmission = input.assertStorageAdmission || researchAdmission
    ? () => { input.assertStorageAdmission?.(); researchAdmission?.(); } : undefined;
  assertProviderAdmission?.();
  const publicSourceReader = input.providerEgressPolicy && codexProviderHasPublicSources(input.providerEgressPolicy)
    ? createPublicResearchSourceReader(input.providerEgressPolicy) : undefined;
  assertVerifiedHostedChildConfig(config);
  assertChildGoalConfig(config);
  const childBudget = config.childLifetime ? new ChildExecutionBudget(config.childLifetime) : undefined;
  const ownedMimoWorker = config.modelBackend === CodexModelBackend.XiaomiMimoTokenPlan && !!researchAdmission;
  const ownedMimoCoding = ownedMimoWorker &&
    ownedMimoWorkerStart(input.appServerProcessFactory)?.request.hostedProfile === HostedMimoProfile.CodingV1;
  if (ownedMimoWorker) assertOwnedMimoWorkerConfig(input.appServerProcessFactory, config);
  // Signed dependency workspaces retain their independent purpose-qualified route.
  const ownedSnapshotGit = ownedMimoWorker && !dependencyGit
    ? new OwnedMimoSnapshotGitRunner(config.workspacePath, () => { assertProviderAdmission?.(); },
        input.observeOwnedMimoSnapshotTiming) : undefined;
  const snapshotGit = dependencyGit ?? ownedSnapshotGit;
  const executionLifetime = input.executionLifetime ?? (ownedMimoWorker ? new AppServerExecutionLifetime({
    deadlineEpochMs: Date.now() + config.taskTimeoutMs!, maxGoalTurns: config.maxGoalTurns!,
    binding: { allocationId: config.jobId ?? config.taskId, incarnationId: randomUUID() },
  }) : childBudget ? new AppServerExecutionLifetime({ childBudget }) : undefined);
  if (input.executionLifetime && childBudget && input.executionLifetime.childBudget !== childBudget) throw new Error("codex_goal_lifetime_budget_conflict");
  executionLifetime?.assertActive();
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
    ...(snapshotGit ? {
      snapshotter: ownedSnapshotGit ? ownedMimoWorkspaceSnapshotter(ownedSnapshotGit)
        : new DefaultWorkspaceSnapshotter({ commandRunner: snapshotGit, gitBinaryPath: "/usr/bin/git" }),
      workspaceAccess: ownedSnapshotGit ? ownedMimoWorkspaceAccess(ownedSnapshotGit)
        : new NodeSafeExecutionWorkspaceAccess({ commandRunner: snapshotGit, gitBinaryPath: "/usr/bin/git" }),
    } : {}),
    ...(assertProviderAdmission ? { assertProviderAdmission } : {}),
    ...(config.executorId ? { executorId: config.executorId } : {}),
    ...(childBudget ? { childBudget } : {}),
    ...(executionLifetime ? { executionLifetime } : {}),
    authRootDir: config.authRootDir,
    ...(input.observability ? { observability: input.observability } : {}),
    ...(!childBudget && !ownedMimoWorker && input.controlInbox ? { controlInbox: input.controlInbox } : {}),
    ...(input.activeAttemptRegistry
      ? { activeAttemptRegistry: input.activeAttemptRegistry }
      : {}),
    stateRootDir: input.stateRootDir,
    terminalCheckpointJobRootDir: config.jobRootDir,
    ...(completedTurnCheckpoint ? { completedTurnCheckpoint } : {}),
    ...(input.executionGeneration === undefined ? {} : { executionGeneration: input.executionGeneration }),
    ...(runtimeHomeRootDir === undefined ? {} : { runtimeHomeRootDir }),
    ...(config.sessionHomeProfile === undefined ? {} : { sessionHomeProfile: config.sessionHomeProfile }),
    accountCapacityStore: isMimo
      ? codexAccountCapacityStore(config.authRootDir, {
          modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
          ...(input.observability ? { observability: input.observability } : {}),
        })
      : migrateLegacyCodexAccountCapacity({
          ...(assertProviderAdmission ? { assertProviderAdmission } : {}),
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
        ...(assertProviderAdmission ? { assertProviderAdmission } : {}),
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
                resolveCodexGoalMimoEnvVarName(account, mimoAccountsByName),
            }
          : {}),
        ...(!isMimo && input.providerEgressPolicy ? { providerEgressPolicy: input.providerEgressPolicy } : {}),
        ...(input.appServerProcessFactory ? { appServerProcessFactory: input.appServerProcessFactory } : {}),
        ...(publicSourceReader ? { publicSourceReader } : {}),
        capacityAccountId: account.name,
        ...(executionLifetime ? { executionLifetime, cleanThreadPrewarm: false } : {}),
        ...(ownedMimoWorker && !ownedMimoCoding ? { boundedWorkspaceTools: { denyProjectInstructions: true,
          allowedTools: [AgentRuntimeTool.ReadFile, AgentRuntimeTool.EditFile, AgentRuntimeTool.WriteFile, AgentRuntimeTool.SearchFiles] } } : {}),
        ...(childBudget ? { childBudget, cleanThreadPrewarm: false,
          refreshConflictRetryMaxMs: 0,
          boundedWorkspaceTools: { allowedTools: childBudget.lifetime.allowedTools, denyProjectInstructions: true } } : {}),
        ...(config.maxGoalTurns === undefined ? {} : { maxGoalTurns: config.maxGoalTurns }),
        taskTimeoutMs: config.taskTimeoutMs ?? 72 * 60 * 60 * 1000,
        ...(config.appServerStartupTimeoutMs === undefined
          ? {}
          : { appServerStartupTimeoutMs: config.appServerStartupTimeoutMs }),
        ...codexGoalHostedExecutionBoundary({ ...config, commandPolicy }),
        ...(input.openWorker ? { openWorker: input.openWorker } : {}),
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

export function codexGoalProgressPath(config: Pick<CodexGoalRunConfig, "jobRootDir" | "taskId" | "progressPath">): string {
  return config.progressPath ?? join(config.jobRootDir, `${config.taskId}.progress.json`);
}

export function codexGoalOutputPath(
  config: Pick<CodexGoalRunConfig, "jobRootDir" | "taskId" | "outputPath">,
): string {
  return config.outputPath ?? join(config.jobRootDir, `${config.taskId}.latest-result.json`);
}

export function codexGoalRuntimeEventsPath(
  config: Pick<CodexGoalRunConfig, "jobRootDir" | "taskId" | "outputPath" | "runtimeEventsPath">,
): string {
  return config.runtimeEventsPath ?? join(usesManagedJobLayout(config as CodexGoalRunConfig) && config.outputPath
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
  if (config.maxReconnectRetriesPerAccount !== undefined &&
      (!Number.isInteger(config.maxReconnectRetriesPerAccount) || config.maxReconnectRetriesPerAccount < 0)) {
    throw new Error("codex_goal_reconnect_retries_invalid");
  }
  assertPositiveInteger(
    config.progressHeartbeatMs,
    "codex_goal_progress_heartbeat_invalid",
  );
}

function assertPositiveInteger(value: number | undefined, code: string): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value <= 0) throw new Error(code);
}

function codexGoalWorkerSystemPrompt(taskId: string, tempRoot = "/tmp"): string {
  return [
    "Codex goal runtime artifact rule:",
    `If the task asks you to write a report, evidence file, or other artifact to a path outside the current workspace and the sandbox denies that write, write the artifact under ${tempRoot} instead.`,
    `Use a task-specific directory such as ${tempRoot}/${taskId}-artifacts, include the exact fallback path in your final output, and do not mark the goal blocked solely because the external copy could not be performed.`,
    "Keep source worktrees clean unless the task explicitly requires code or docs changes.",
  ].join(" ");
}

function codexGoalRunSystemPrompt(
  config: Pick<CodexGoalRunConfig, "taskId" | "workerReportMode" | "agentTempRootDir">,
  options: { readonly linkedWorktreeHandoff?: boolean; readonly dependencyToolInstruction?: string; readonly openWorkerInstruction?: string } = {},
): string {
  const prompts = [codexGoalWorkerSystemPrompt(config.taskId, options.openWorkerInstruction ? "$TMPDIR" : config.agentTempRootDir ?? "/tmp")];
  if (options.dependencyToolInstruction) prompts.push(options.dependencyToolInstruction);
  if (options.openWorkerInstruction) prompts.push(options.openWorkerInstruction);
  else if (options.linkedWorktreeHandoff === true) {
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
