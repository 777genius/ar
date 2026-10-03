import { sameTools } from "./child-execution-confinement";
import { assertReadonlyAdmittedFactory } from "./hosted-readonly-admission";
import { prepareHostScratchCaches } from "./host-scratch-temp";
import { CODEX_WORKER_DEFAULT_MODEL, CODEX_WORKER_DEFAULT_REASONING_EFFORT } from "./codex-worker-defaults";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  createSubscriptionRuntime,
  DeterministicIdGenerator,
  type ClockPort,
  type ObservabilityPort,
  type RedactorPort,
  type RuntimeDeps,
} from "@vioxen/subscription-runtime/core";
import {
  CodexAppServerExecutionEngine,
  CodexCliAgentDriver,
  CodexCliSessionDriver,
  CodexJsonAgentDriver,
  CodexMimoNoSessionDriver,
  CodexModelBackend,
  CodexWorkerCacheSessionPoolMaterializer,
  PackagedCodexJsonExecutionEngine,
  codexJsonHomeConfigToml,
  codexMimoApiKeyEnvVarDefault,
  codexMimoDefaultModel,
  codexMimoTokenPlanEgressPolicy,
  codexModelBackendDefaultModel,
  codexProviderApiEgressPolicy,
  codexProviderEgressEnv,
  codexProviderEgressPolicy,
  hostedCodexExecutableReadPath,
  hostedCodexPermissionProfilesToml,
  CodexProviderEgressProfileId,
  egressBoundCodexProcessFactory,
  type CodexProviderEgressPolicy,
} from "@vioxen/subscription-runtime/provider-codex";
import { createLocalFileBackendRuntimeAdapters } from "@vioxen/subscription-runtime/store-local-file";
import type { CommandPolicy } from "@vioxen/subscription-runtime/worker-core";
import { NodeProcessRunner } from "../worker-local/node-process-runner";
import {
  BorrowedRunTaskWorkspace,
  StableWorkerWorkspace,
} from "../worker-local/temp-workspace";
import { CommandPolicyRunner } from "./command-policy-runner";
import { codexAppServerCommandApprovalPolicy } from "./file-backend-codex-command-policy";
import { LocalFileManagedRunStore } from "./file-backend-codex-managed-run-store";
import type { FileBackendCodexWorkerOptions } from "./file-backend-codex-worker";
import { buildCodexWorkspaceToolsProfile } from "./workspace-tools/codex-workspace-tools-profile";
import {
  codexSessionHomeCacheKey,
  codexSessionHomePreservedOnDispose,
} from "./codex-session-home-profile";

export type CodexWorkerExecutionEngine =
  | "app-server"
  | "app-server-goal"
  | "packaged-exec"
  | "plain-exec";

export type FileBackendCodexWorkerRuntimeParts = {
  readonly runner: RuntimeDeps["runner"];
  readonly workspace: RuntimeDeps["workspace"];
  readonly clock: ClockPort;
  readonly sessionDriver: CodexCliSessionDriver | CodexMimoNoSessionDriver;
  readonly agentDriver: CodexJsonAgentDriver | CodexCliAgentDriver;
  readonly sessionStore: NonNullable<RuntimeDeps["sessionStore"]>;
  readonly managedRunStore: LocalFileManagedRunStore;
  readonly runtime: ReturnType<typeof createSubscriptionRuntime>;
  readonly ownedWorkspace: StableWorkerWorkspace | null;
  readonly prewarmWorkspace: RuntimeDeps["workspace"];
};

export function createFileBackendCodexWorkerRuntime(input: {
  readonly options: FileBackendCodexWorkerOptions;
  readonly workerId: string;
  readonly observability: ObservabilityPort;
  readonly redactor: RedactorPort;
  readonly clock: ClockPort;
}): FileBackendCodexWorkerRuntimeParts {
  const { options } = input;
  const runners = createWorkerRunners({
    options,
    workerId: input.workerId,
    observability: input.observability,
  });
  const runner = runners.taskRunner;
  const workspaces = createWorkerWorkspaces({
    options,
    workerId: input.workerId,
  });
  const { sessionStore, leaseStore } = createLocalFileBackendRuntimeAdapters({
    providerId: "codex",
    rootDir: join(options.stateRootDir, "sessions"),
    encryptionKey: options.encryptionKey,
    metadata: { adapter: "file-backend-codex-worker" },
  });
  const managedRunStore = new LocalFileManagedRunStore(
    join(options.stateRootDir, "managed-runs"),
    input.redactor,
  );
  const modelBackend = options.modelBackend ?? CodexModelBackend.OpenAiChatGpt;
  // MiMo is a static API-key credential with no ChatGPT auth.json/OAuth
  // session at all: it uses a no-session driver so the runtime kernel takes
  // the `no-session` execution plan (never reads/writes sessionStore/lease,
  // never refreshes). The ChatGPT path below is completely untouched.
  const sessionDriver: CodexCliSessionDriver | CodexMimoNoSessionDriver =
    modelBackend === CodexModelBackend.XiaomiMimoTokenPlan
      ? new CodexMimoNoSessionDriver()
      : new CodexCliSessionDriver({
          codexBinaryPath: options.codexBinaryPath,
          model: options.model ?? CODEX_WORKER_DEFAULT_MODEL,
          ...(options.sourceEnv ? { sourceEnv: options.sourceEnv } : {}),
          refreshMode: "lazy-refresh",
          ...(runners.refreshBootstrapRunner
            ? { refreshBootstrapRunner: runners.refreshBootstrapRunner }
            : {}),
        });
  const agentDriver = createCodexAgentDriver({
    options,
    workerId: input.workerId,
    observability: input.observability,
    managedRunStore,
  });
  const runtime = createSubscriptionRuntime({
    policy: {
      custodyMode: "local-only",
      requireNoBackendPlaintext: false,
      requireWritebackBeforeTask: true,
      requireCompareAndSwap: true,
      allowInteractiveSetupInRuntime: false,
      allowedProviderIds: [sessionDriver.providerId],
      allowedAgentIds: [agentDriver.agentId],
      allowedStoreIds: [sessionStore.storeId],
      allowedRunnerIds: [runner.runnerId],
      requestedTaskMode: "structured-prompt",
      refreshPolicy: {
        minFreshMs: options.refreshFreshnessMs ?? 15 * 60 * 1000,
        refreshBeforeExpiryMs: options.refreshBeforeExpiryMs ?? 5 * 60 * 1000,
        maxSessionAgeMs: options.maxSessionAgeMs ?? 24 * 60 * 60 * 1000,
      },
    },
    sessionDriver,
    agentDriver,
    sessionStore,
    leaseStore,
    runner,
    workspace: workspaces.workspace,
    redactor: input.redactor,
    observability: input.observability,
    clock: input.clock,
    idGenerator: new DeterministicIdGenerator(),
  });
  return {
    runner,
    workspace: workspaces.workspace,
    clock: input.clock,
    sessionDriver,
    agentDriver,
    sessionStore,
    managedRunStore,
    runtime,
    ownedWorkspace: workspaces.ownedWorkspace,
    prewarmWorkspace: workspaces.prewarmWorkspace,
  };
}

function createWorkerRunners(input: {
  readonly options: FileBackendCodexWorkerOptions;
  readonly workerId: string;
  readonly observability: ObservabilityPort;
}): {
  readonly taskRunner: RuntimeDeps["runner"];
  readonly refreshBootstrapRunner?: RuntimeDeps["runner"];
} {
  const baseRunner = input.options.runner ?? new NodeProcessRunner();
  const taskRunner = input.options.commandPolicy?.validateCommands
    ? new CommandPolicyRunner(baseRunner, input.options.commandPolicy, {
        observability: input.observability,
        providerId: "codex",
        metadata: {
          workerId: input.workerId,
          providerInstanceId: input.options.providerInstanceId,
        },
      })
    : baseRunner;
  const refreshBootstrapRunner =
    input.options.commandPolicy?.validateCommands &&
    input.options.codexBinaryPath === "codex"
      ? baseRunner
      : undefined;
  return {
    taskRunner,
    ...(refreshBootstrapRunner ? { refreshBootstrapRunner } : {}),
  };
}

function createWorkerWorkspaces(input: {
  readonly options: FileBackendCodexWorkerOptions;
  readonly workerId: string;
}): {
  readonly ownedWorkspace: StableWorkerWorkspace | null;
  readonly workspace: RuntimeDeps["workspace"];
  readonly prewarmWorkspace: RuntimeDeps["workspace"];
} {
  const defaultWorkspacePath = join(
    input.options.runtimeHomeRootDir ?? input.options.stateRootDir,
    "workspaces",
    hashText(input.workerId),
  );
  const ownedWorkspace = input.options.workspace
    ? null
    : new StableWorkerWorkspace(defaultWorkspacePath, {
        allowedRootDir: input.options.runtimeHomeRootDir ?? input.options.stateRootDir,
      });
  const workspace =
    input.options.workspace ??
    (input.options.workspacePath
      ? new BorrowedRunTaskWorkspace(input.options.workspacePath, ownedWorkspace!)
      : ownedWorkspace!);
  return {
    ownedWorkspace,
    workspace,
    prewarmWorkspace: input.options.workspace ?? ownedWorkspace!,
  };
}

function createCodexAgentDriver(input: {
  readonly options: FileBackendCodexWorkerOptions;
  readonly workerId: string;
  readonly observability: ObservabilityPort;
  readonly managedRunStore: LocalFileManagedRunStore;
}): CodexJsonAgentDriver | CodexCliAgentDriver {
  const { options } = input;
  if (options.executionLifetime && (options.executionEngine !== "app-server-goal" ||
      options.cleanThreadPrewarm !== false || options.maxGoalTurns !== options.executionLifetime.maxGoalTurns)) {
    throw new Error("codex_bounded_factory_profile_conflict");
  }
  options.executionLifetime?.assertActive();
  if (options.childBudget) {
    const bound = options.childBudget.lifetime;
    if (options.executionEngine !== "app-server-goal" || options.capacityAccountId !== bound.accountId ||
        options.modelBackend !== CodexModelBackend.XiaomiMimoTokenPlan || options.model !== codexMimoDefaultModel ||
        options.mimoApiKeyEnvVarName !== codexMimoApiKeyEnvVarDefault ||
        options.maxGoalTurns !== bound.maxGoalTurns || options.cleanThreadPrewarm !== false ||
        options.executionProfile !== undefined || options.boundedWorkspaceTools?.denyProjectInstructions !== true ||
        !sameTools(options.boundedWorkspaceTools?.allowedTools, bound)) throw new Error("child_factory_confinement_conflict");
    options.childBudget.remainingMs();
  }
  const executionEngine = options.executionEngine ?? "app-server";
  const modelBackend = options.modelBackend ?? CodexModelBackend.OpenAiChatGpt;
  const mimoApiKeyEnvVarName = options.mimoApiKeyEnvVarName ?? codexMimoApiKeyEnvVarDefault;
  if (modelBackend === CodexModelBackend.XiaomiMimoTokenPlan && executionEngine !== "app-server-goal") {
    // SR-AP-2 fail-closed: MiMo only ever runs through the app-server goal
    // path. `assertWorkerOptions` already rejects this combination before a
    // worker is constructed; this is defense in depth for direct callers.
    throw new Error("codex_mimo_backend_requires_app_server_goal_engine");
  }
  const sourceEnv = options.sourceEnv ?? process.env;
  const hostedGlobalScanGuard =
    sourceEnv.SUBSCRIPTION_RUNTIME_SANDBOX_KIND === "hosted-codex-job";
  const projectReadBoundary = hostedGlobalScanGuard || options.enforceProjectReadBoundary === true;
  const executableReadPath = projectReadBoundary
    ? hostedCodexExecutableReadPath({ codexBinaryPath: options.codexBinaryPath, sourceEnv })
    : undefined;
  // MiMo's egress domain is fixed by modelBackend, not by the host-trusted
  // `providerEgressPolicy` input (`assertWorkerOptions` rejects the two
  // being combined). Every other backend keeps today's exact behavior.
  const providerEgressPolicy = modelBackend === CodexModelBackend.XiaomiMimoTokenPlan
    ? codexMimoTokenPlanEgressPolicy()
    : codexProviderEgressPolicy(
        (options.providerEgressPolicy ?? codexProviderApiEgressPolicy()).profileId,
      );
  if (modelBackend !== CodexModelBackend.XiaomiMimoTokenPlan &&
      providerEgressPolicy.profileId !== CodexProviderEgressProfileId.ProviderApi &&
      (process.platform !== "linux" || !hostedGlobalScanGuard ||
       executionEngine !== "app-server-goal" || options.boundedWorkspaceTools)) {
    throw new Error("hosted_test_egress_engine_unsupported");
  }
  if (providerEgressPolicy.profileId === CodexProviderEgressProfileId.TestManagedQualification) {
    assertReadonlyAdmittedFactory(options.appServerProcessFactory, options.workspacePath);
  }
  if (projectReadBoundary && executionEngine !== "app-server" &&
      executionEngine !== "app-server-goal") {
    throw new Error("hosted_permission_profiles_engine_unsupported");
  }
  const appServerEnv = {
    ...sourceEnv, ...codexProviderEgressEnv(providerEgressPolicy),
  };
  const workspaceToolsProfile = options.boundedWorkspaceTools && options.workspacePath
    ? buildCodexWorkspaceToolsProfile({
        workspaceRoot: options.workspacePath,
        allowedTools: options.boundedWorkspaceTools.allowedTools,
        modelBackend,
        mimoApiKeyEnvVarName,
        ...(options.childBudget ? { childLifetime: options.childBudget.lifetime } : {}),
        ...(options.boundedWorkspaceTools.denyProjectInstructions
          ? { denyProjectInstructions: true }
          : {}),
        ...(projectReadBoundary ? { hostedEgressPolicy: providerEgressPolicy } : {}),
      })
    : undefined;
  const projectConfigToml = projectReadBoundary && !hostedGlobalScanGuard
    ? projectReadBoundaryConfigToml(providerEgressPolicy, executableReadPath,
        modelBackend, mimoApiKeyEnvVarName, sourceEnv.SUBSCRIPTION_RUNTIME_MIMO_KEY_FILE)
    : undefined;
  const mimoConfigToml = workspaceToolsProfile?.configToml ??
    (hostedGlobalScanGuard
      ? hostedGlobalScanConfigToml(providerEgressPolicy, executableReadPath, modelBackend, mimoApiKeyEnvVarName)
      : projectConfigToml);
  if (executionEngine === "plain-exec") {
    return new CodexCliAgentDriver({
      codexBinaryPath: options.codexBinaryPath,
      model: options.model ?? codexModelBackendDefaultModel(modelBackend, CODEX_WORKER_DEFAULT_MODEL),
      reasoningEffort: options.reasoningEffort ?? CODEX_WORKER_DEFAULT_REASONING_EFFORT,
      modelBackend,
      mimoApiKeyEnvVarName,
      ...(options.sourceEnv ? { sourceEnv: options.sourceEnv } : {}),
      ...(options.taskTimeoutMs ? { timeoutMs: options.taskTimeoutMs } : {}),
    });
  }

  const packagedExec = new PackagedCodexJsonExecutionEngine({
    codexBinaryPath: options.codexBinaryPath,
    modelBackend,
    providerEgressPolicy,
    ...(options.sourceEnv ? { sourceEnv: options.sourceEnv } : {}),
    ...(options.taskTimeoutMs ? { timeoutMs: options.taskTimeoutMs } : {}),
  });
  return new CodexJsonAgentDriver({
    ...(options.executionLifetime ? { executionLifetime: options.executionLifetime } : {}),
    engine: executionEngine === "packaged-exec"
      ? packagedExec
      : new CodexAppServerExecutionEngine({
          ...(options.childBudget ? { childBudget: options.childBudget } : {}),
          ...(options.executionLifetime ? { executionLifetime: options.executionLifetime } : {}),
          codexBinaryPath: options.codexBinaryPath,
          modelBackend,
          sourceEnv: appServerEnv,
          ...(projectReadBoundary ? { hostedPermissionProfiles: true } : {}),
          ...(options.taskTimeoutMs ? { timeoutMs: options.taskTimeoutMs } : {}),
          ...(options.appServerStartupTimeoutMs
            ? { startupTimeoutMs: options.appServerStartupTimeoutMs }
            : {}),
          processFactory: egressBoundCodexProcessFactory(
            providerEgressPolicy, options.appServerProcessFactory,
            projectReadBoundary ? { namedPermissions: true } : undefined,
          ),
          ...(options.rateLimitsSnapshotHandler
            ? {
                rateLimitsSnapshotHandler:
                  options.rateLimitsSnapshotHandler,
              }
            : {}),
          ...(options.rolloutBudget
            ? { rolloutBudget: options.rolloutBudget }
            : {}),
          ...(hostedGlobalScanGuard && !workspaceToolsProfile
            ? { bypassHookTrust: true }
            : {}),
          ...(workspaceToolsProfile
            ? {
                executionProfile: {
                  kind: "custom" as const,
                  developerInstructions:
                    workspaceToolsProfile.developerInstructions,
                  disableTools: false,
                  historyMode: "none" as const,
                },
                nativeToolSurface: "disabled" as const,
              }
            : modelBackend === CodexModelBackend.XiaomiMimoTokenPlan && hostedGlobalScanGuard
            ? { nativeToolSurface: "disabled" as const }
            : options.executionProfile
            ? { executionProfile: options.executionProfile }
            : {}),
          ...(options.commandPolicy?.validateCommands
            ? {
                commandApprovalPolicy: codexAppServerCommandApprovalPolicy(
                  options.commandPolicy as CommandPolicy,
                  input.observability,
                  {
                    workerId: input.workerId,
                    providerInstanceId: options.providerInstanceId,
                  },
                ),
              }
            : {}),
          cleanThreadPrewarm: workspaceToolsProfile
            ? false
            : options.cleanThreadPrewarm ?? true,
          goalMode: executionEngine === "app-server-goal",
          ...(options.completedTurnCheckpoint ? { completedTurnCheckpoint: options.completedTurnCheckpoint } : {}),
          ...(options.maxGoalTurns === undefined
            ? {}
            : { maxGoalTurns: options.maxGoalTurns }),
          runStore: input.managedRunStore,
          ...(
            executionEngine === "app-server-goal" ||
            projectReadBoundary ||
            workspaceToolsProfile ||
            options.rolloutBudget
            ? {}
            : { fallback: packagedExec }
          ),
        }),
    sessionMaterializer: new CodexWorkerCacheSessionPoolMaterializer({
      cacheKey: codexSessionHomeCacheKey({
        profile: options.sessionHomeProfile,
        providerInstanceId: options.providerInstanceId,
        workerId: input.workerId,
      }),
      providerEgressPolicy,
      slots: options.sessionCacheSlots ?? 1,
      rootDir: join(options.runtimeHomeRootDir ?? options.stateRootDir, "codex-session-cache"),
      preserveOnDispose: codexSessionHomePreservedOnDispose(
        options.sessionHomeProfile,
      ),
      ...(codexSessionHomePreservedOnDispose(options.sessionHomeProfile)
        ? { prepareHome: (codexHome: string) => prepareHostScratchCaches(codexHome, sourceEnv) }
        : {}),
      scrubAuthOnDispose: true,
      ...(workspaceToolsProfile
        ? { configToml: workspaceToolsProfile.configToml }
        : projectReadBoundary
        ? {
            configToml: hostedGlobalScanGuard
              ? hostedGlobalScanConfigToml(providerEgressPolicy, executableReadPath)
              : projectReadBoundaryConfigToml(providerEgressPolicy, executableReadPath,
                  modelBackend, mimoApiKeyEnvVarName),
          }
        : {}),
    }),
    model: options.model ?? codexModelBackendDefaultModel(modelBackend, CODEX_WORKER_DEFAULT_MODEL),
    reasoningEffort: options.reasoningEffort ?? CODEX_WORKER_DEFAULT_REASONING_EFFORT,
    modelBackend,
    mimoApiKeyEnvVarName,
    ...(modelBackend === CodexModelBackend.XiaomiMimoTokenPlan && mimoConfigToml !== undefined
      ? { mimoConfigToml }
      : {}),
    sourceEnv,
    ...(options.serviceTier === undefined
      ? {}
      : { serviceTier: options.serviceTier }),
    ...(options.outputSchemas === undefined
      ? {}
      : { outputSchemas: options.outputSchemas }),
    ...(!workspaceToolsProfile && typeof options.warmupPrompt === "string"
      ? { warmupPrompt: options.warmupPrompt }
      : {}),
  });
}

function projectReadBoundaryConfigToml(
  providerEgressPolicy: CodexProviderEgressPolicy,
  executableReadPath?: string,
  modelBackend: CodexModelBackend = CodexModelBackend.OpenAiChatGpt,
  mimoApiKeyEnvVarName = codexMimoApiKeyEnvVarDefault,
  privateKeyFilePath?: string,
): string {
  return codexJsonHomeConfigToml({ providerEgressPolicy, namedPermissions: true,
    modelBackend, mimoApiKeyEnvVarName }) +
    "\n" + hostedCodexPermissionProfilesToml(providerEgressPolicy, executableReadPath, privateKeyFilePath);
}

function hostedGlobalScanConfigToml(
  providerEgressPolicy: CodexProviderEgressPolicy,
  executableReadPath?: string,
  modelBackend: CodexModelBackend = CodexModelBackend.OpenAiChatGpt,
  mimoApiKeyEnvVarName = codexMimoApiKeyEnvVarDefault,
): string {
  const hookPath = fileURLToPath(
    new URL("./hosted-global-scan-pre-tool-hook.js", import.meta.url),
  );
  const command = `${shellQuote(process.execPath)} ${shellQuote(hookPath)}`;
  return [
    codexJsonHomeConfigToml({ hooksEnabled: true, providerEgressPolicy, namedPermissions: true,
      modelBackend, mimoApiKeyEnvVarName }),
    hostedCodexPermissionProfilesToml(providerEgressPolicy, executableReadPath),
    "[hooks]",
    "[[hooks.PreToolUse]]",
    'matcher = "Bash|exec"',
    "[[hooks.PreToolUse.hooks]]",
    'type = "command"',
    `command = ${JSON.stringify(command)}`,
    "timeout = 5",
    'statusMessage = "Checking command scope"',
    "",
  ].join("\n");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
