import { openWorkerProfileApplies, openWorkerToolCacheEnvironmentSet } from "./project-control-worker-mode";
import { researchMimoWorkerLifecycle } from "./research-mimo-worker-result";
import { ownedMimoWorkerStart } from "./research-launch-admission";
import { codexWorkerReportSchemaName, codexWorkerReportSchema, codexWorkerReportSystemPrompt } from "./codex-goal-report-schema";
import { codexProviderHasPublicSources } from "@vioxen/subscription-runtime/provider-codex";
import { AgentRuntimeTool, type ObservabilityPort } from "@vioxen/subscription-runtime/core";
import type { CommandPolicy } from "@vioxen/subscription-runtime/worker-core";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { sameTools } from "./child-execution-confinement";
import { isHostedContainment } from "../provider-codex/app-server/adapters/hosted-host-policy";
import { assertReadonlyAdmittedFactory, assertHostedDependencyToolAdmittedFactory, readHostedDependencyToolFactoryEntry } from "./hosted-readonly-admission";
import { readAdmittedHostedDependencyToolConfig } from "./hosted-dependency-tool-profile";
import { prepareHostScratchCaches } from "./host-scratch-temp";
import type { DependencyToolGuestConfig } from "../core/dependency-environment/dependency-tool-profile";
import { CODEX_WORKER_DEFAULT_MODEL, CODEX_WORKER_DEFAULT_REASONING_EFFORT } from "./codex-worker-defaults";
import { CodexAppServerExecutionEngine, CodexCliAgentDriver, CodexJsonAgentDriver, CodexModelBackend, HostedMimoProfile, prepareHostedMimoCodingEngineAuthority,
  CodexWorkerCacheSessionPoolMaterializer, PackagedCodexJsonExecutionEngine, codexJsonHomeConfigToml,
  codexMimoApiKeyEnvVarDefault, codexMimoDefaultModel, codexMimoTokenPlanEgressPolicy, codexModelBackendDefaultModel,
  codexProviderApiEgressPolicy, codexHostedDefaultEgressPolicy, codexProviderEgressEnv, codexProviderEgressPolicy, hostedCodexExecutableReadClosure, hostedCodexResolverReadPaths,
  hostedCodexPermissionProfilesToml, CodexProviderEgressProfileId, egressBoundCodexProcessFactory,
  createPublicResearchSourceReader, codexChildPath, assertHostedOpenWorkerLayout, renderHostedOpenWorkerProfilesToml, requiresHostedProcessAdmission, type CodexProviderEgressPolicy } from "@vioxen/subscription-runtime/provider-codex";
import type { HostedManagedDependencySessionMaterializer } from "./hosted-managed-dependency-session-materializer";
import { codexAppServerCommandApprovalPolicy } from "./file-backend-codex-command-policy";
import type { LocalFileManagedRunStore } from "./file-backend-codex-managed-run-store";
import type { FileBackendCodexWorkerOptions } from "./file-backend-codex-worker";
import { buildCodexWorkspaceToolsProfile } from "./workspace-tools/codex-workspace-tools-profile";
import { codexSessionHomeCacheKey, codexSessionHomePreservedOnDispose } from "./codex-session-home-profile";

/** Credential and durable-state roots excluded from every open worker grant. */
export function openWorkerFactorySecretRoots(options: FileBackendCodexWorkerOptions): readonly string[] {
  const runtimeHome = options.runtimeHomeRootDir ?? options.stateRootDir;
  return [...(options.openWorker?.secretRoots ?? []), options.stateRootDir, runtimeHome,
    join(runtimeHome, "codex-session-cache")];
}

export function createFixedCodexAgentDriver(input: {
  readonly options: FileBackendCodexWorkerOptions;
  readonly workerId: string;
  readonly observability: ObservabilityPort;
  readonly managedRunStore: LocalFileManagedRunStore;
  readonly managedSession?: HostedManagedDependencySessionMaterializer;
}): CodexJsonAgentDriver | CodexCliAgentDriver {
  const { options } = input;
  const ownedMimoStart = options.modelBackend === CodexModelBackend.XiaomiMimoTokenPlan &&
    options.executionEngine === "app-server" ? ownedMimoWorkerStart(options.appServerProcessFactory) : undefined;
  const ownedMimoTurn = !!ownedMimoStart;
  const ownedMimoCoding = ownedMimoStart?.request.hostedProfile === HostedMimoProfile.CodingV1;
  if (ownedMimoTurn && (!options.executionLifetime || options.childBudget ||
      options.cleanThreadPrewarm !== false || options.executionProfile !== undefined || options.openWorker !== undefined ||
      (ownedMimoCoding
        ? options.boundedWorkspaceTools !== undefined || options.maxGoalTurns !== 64 ||
          options.model !== ownedMimoStart.request.model || options.workspacePath !== ownedMimoStart.request.workspacePath ||
          options.codexBinaryPath !== ownedMimoStart.request.codexBinaryPath
        : options.boundedWorkspaceTools?.denyProjectInstructions !== true ||
          JSON.stringify(options.boundedWorkspaceTools.allowedTools) !== JSON.stringify([
            AgentRuntimeTool.ReadFile, AgentRuntimeTool.EditFile, AgentRuntimeTool.WriteFile, AgentRuntimeTool.SearchFiles])) ||
      JSON.stringify(options.outputSchemas) !== JSON.stringify({ [codexWorkerReportSchemaName]: codexWorkerReportSchema }))) {
    throw new Error("codex_bounded_factory_profile_conflict");
  }
  if (options.executionLifetime && ((!ownedMimoTurn && options.executionEngine !== "app-server-goal") ||
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
  if (modelBackend === CodexModelBackend.XiaomiMimoTokenPlan && executionEngine !== "app-server-goal" && !ownedMimoTurn) {
    throw new Error("codex_mimo_backend_requires_app_server_goal_engine");
  }
  const requestedSourceEnv = options.sourceEnv ?? process.env;
  const hostedGlobalScanGuard = isHostedContainment(requestedSourceEnv);
  const sourceEnv = hostedGlobalScanGuard ? {
    ...requestedSourceEnv, SUBSCRIPTION_RUNTIME_SANDBOX_KIND: "hosted-codex-job",
  } : requestedSourceEnv;
  const projectReadBoundary = hostedGlobalScanGuard || options.enforceProjectReadBoundary === true;
  const resolverReadPaths = hostedCodexResolverReadPaths(sourceEnv, projectReadBoundary);
  assertHostedDependencyToolAdmittedFactory(options.appServerProcessFactory, options.workspacePath);
  const dependencyToolConfig = readAdmittedHostedDependencyToolConfig(options.workspacePath,
    readHostedDependencyToolFactoryEntry(options.appServerProcessFactory, options.workspacePath));
  if (dependencyToolConfig && (!hostedGlobalScanGuard || executionEngine !== "app-server-goal" || options.boundedWorkspaceTools)) {
    throw new Error("hosted_dependency_tool_engine_unsupported");
  }
  if (options.openWorker) {
    const profile = openWorkerProfileApplies({ platform: process.platform,
      rootBaseline: process.getuid?.() === 0 && !requiresHostedProcessAdmission(sourceEnv), contained: hostedGlobalScanGuard,
      modelBackend, executionEngine, boundedWorkspaceTools: !!options.boundedWorkspaceTools,
      dependencyTools: !!dependencyToolConfig, projectReadBoundary });
    if (!profile.applies || hostedGlobalScanGuard) {
      throw new Error(`hosted_open_worker_factory_conflict:${profile.applies ? "contained" : profile.reason}`);
    }
  }
  const executableReadPath = projectReadBoundary
    ? hostedCodexExecutableReadClosure({ codexBinaryPath: options.codexBinaryPath, sourceEnv })?.paths
    : undefined;
  // MiMo's egress domain is fixed by modelBackend, not by the host-trusted
  // `providerEgressPolicy` input (`assertWorkerOptions` rejects the two
  // being combined). Every other backend keeps today's exact behavior.
  const providerEgressPolicy = modelBackend === CodexModelBackend.XiaomiMimoTokenPlan
    ? ownedMimoCoding
      ? codexProviderEgressPolicy(CodexProviderEgressProfileId.ManagedPublicInternetV1)
      : codexMimoTokenPlanEgressPolicy()
    : codexProviderEgressPolicy(
        (options.providerEgressPolicy ?? (hostedGlobalScanGuard
          ? codexHostedDefaultEgressPolicy() : codexProviderApiEgressPolicy())).profileId,
      );
  if (modelBackend !== CodexModelBackend.XiaomiMimoTokenPlan &&
      providerEgressPolicy.profileId !== CodexProviderEgressProfileId.ProviderApi &&
      providerEgressPolicy.profileId !== CodexProviderEgressProfileId.FullInternetV1 &&
      (process.platform !== "linux" || !hostedGlobalScanGuard ||
       executionEngine !== "app-server-goal" || options.boundedWorkspaceTools)) {
    throw new Error("hosted_test_egress_engine_unsupported");
  }
  if (providerEgressPolicy.profileId === CodexProviderEgressProfileId.FullInternetV1 &&
      (process.platform !== "linux" || !projectReadBoundary ||
       (executionEngine !== "app-server" && executionEngine !== "app-server-goal"))) {
    throw new Error("hosted_permission_profiles_engine_unsupported");
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
  const openLayout = options.openWorker ? assertHostedOpenWorkerLayout({
    workspacePath: options.workspacePath!, ...options.openWorker, pathEnv: codexChildPath(appServerEnv),
    secretRoots: openWorkerFactorySecretRoots(options) }) : undefined;
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
        modelBackend, mimoApiKeyEnvVarName, sourceEnv.SUBSCRIPTION_RUNTIME_MIMO_KEY_FILE, dependencyToolConfig, resolverReadPaths)
    : undefined;
  const mimoConfigToml = workspaceToolsProfile?.configToml ??
    (hostedGlobalScanGuard
      ? hostedGlobalScanConfigToml(providerEgressPolicy, executableReadPath, modelBackend, mimoApiKeyEnvVarName, dependencyToolConfig, resolverReadPaths)
      : projectConfigToml);
  const mimoWorkerLifecycle = modelBackend === CodexModelBackend.XiaomiMimoTokenPlan
    ? researchMimoWorkerLifecycle(options.appServerProcessFactory) : undefined;
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
  const appServerProcessFactory = egressBoundCodexProcessFactory(
    providerEgressPolicy, options.appServerProcessFactory,
    projectReadBoundary ? { namedPermissions: true } : undefined,
  );
  const hostedCodingAuthority = ownedMimoCoding ? prepareHostedMimoCodingEngineAuthority({
    processFactory: appServerProcessFactory, executionLifetime: options.executionLifetime!,
    workspacePath: options.workspacePath!, model: options.model!, codexBinaryPath: options.codexBinaryPath!,
  }) : undefined;
  return new CodexJsonAgentDriver({
    ...(options.assertProviderAdmission ? { assertProviderAdmission: options.assertProviderAdmission } : {}),
    ...(options.executionLifetime ? { executionLifetime: options.executionLifetime } : {}),
    engine: executionEngine === "packaged-exec"
      ? packagedExec
      : new CodexAppServerExecutionEngine({
          ...(options.childBudget ? { childBudget: options.childBudget } : {}),
          ...(options.executionLifetime ? { executionLifetime: options.executionLifetime } : {}),
          codexBinaryPath: options.codexBinaryPath,
          modelBackend,
          sourceEnv: appServerEnv,
          providerEgressPolicy,
          ...(!ownedMimoCoding && codexProviderHasPublicSources(providerEgressPolicy)
            ? { publicSourceReader: options.publicSourceReader ?? createPublicResearchSourceReader(providerEgressPolicy) } : {}),
          ...(projectReadBoundary ? { hostedPermissionProfiles: true } : {}),
          ...(options.taskTimeoutMs ? { timeoutMs: options.taskTimeoutMs } : {}),
          ...(options.appServerStartupTimeoutMs
            ? { startupTimeoutMs: options.appServerStartupTimeoutMs }
            : {}),
          processFactory: appServerProcessFactory,
          ...(hostedCodingAuthority ? { hostedCodingAuthority } : {}),
          ...(options.rateLimitsSnapshotHandler
            ? {
                rateLimitsSnapshotHandler:
                  options.rateLimitsSnapshotHandler,
              }
            : {}),
          ...(options.rolloutBudget
            ? { rolloutBudget: options.rolloutBudget }
            : {}),
          ...(hostedGlobalScanGuard && !workspaceToolsProfile && !ownedMimoCoding
            ? { bypassHookTrust: true }
            : {}),
          ...(ownedMimoCoding
            ? { executionProfile: { kind: "custom" as const, developerInstructions: codexWorkerReportSystemPrompt,
                  disableTools: false, historyMode: "none" as const }, nativeToolSurface: HostedMimoProfile.CodingV1 }
            : workspaceToolsProfile
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
            ownedMimoCoding ||
            projectReadBoundary ||
            workspaceToolsProfile ||
            options.rolloutBudget
            ? {}
            : { fallback: packagedExec }
          ),
        }),
    sessionMaterializer: input.managedSession ?? new CodexWorkerCacheSessionPoolMaterializer({
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
      ...(options.openWorker
        ? { configToml: codexJsonHomeConfigToml({ providerEgressPolicy, namedPermissions: true, modelBackend, mimoApiKeyEnvVarName,
            shellEnvironmentSet: { HOME: join(options.openWorker.toolRoot, "home"), TMPDIR: join(options.openWorker.toolRoot, "tmp"),
              TMP: join(options.openWorker.toolRoot, "tmp"), TEMP: join(options.openWorker.toolRoot, "tmp"),
              ...openWorkerToolCacheEnvironmentSet(options.openWorker.toolRoot),
              ...(options.openWorker.commitAllowed
                ? { GIT_DIR: join(options.openWorker.toolRoot, "git"), GIT_WORK_TREE: options.workspacePath! }
                : {}) } }) + "\n" +
            renderHostedOpenWorkerProfilesToml({ strictProfilesToml: hostedCodexPermissionProfilesToml(
              providerEgressPolicy, executableReadPath, undefined, dependencyToolConfig, resolverReadPaths),
              workspacePath: options.workspacePath!, ...options.openWorker, denyDirectories: openLayout!.denyDirectories }) }
        : workspaceToolsProfile
        ? { configToml: workspaceToolsProfile.configToml }
        : projectReadBoundary
        ? {
            configToml: hostedGlobalScanGuard
              ? hostedGlobalScanConfigToml(providerEgressPolicy, executableReadPath, undefined, undefined, dependencyToolConfig, resolverReadPaths)
              : projectReadBoundaryConfigToml(providerEgressPolicy, executableReadPath,
                  modelBackend, mimoApiKeyEnvVarName, undefined, dependencyToolConfig, resolverReadPaths),
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
    ...(mimoWorkerLifecycle ? { mimoHomeLifecycle: mimoWorkerLifecycle.home } : {}),
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
  executableReadPath?: readonly string[],
  modelBackend: CodexModelBackend = CodexModelBackend.OpenAiChatGpt,
  mimoApiKeyEnvVarName = codexMimoApiKeyEnvVarDefault,
  privateKeyFilePath?: string,
  dependencyTools?: DependencyToolGuestConfig,
  resolverReadPaths: readonly string[] = [],
): string {
  return codexJsonHomeConfigToml({ providerEgressPolicy, namedPermissions: true,
    modelBackend, mimoApiKeyEnvVarName }) +
    "\n" + hostedCodexPermissionProfilesToml(providerEgressPolicy, executableReadPath, privateKeyFilePath, dependencyTools, resolverReadPaths);
}

function hostedGlobalScanConfigToml(
  providerEgressPolicy: CodexProviderEgressPolicy,
  executableReadPath?: readonly string[],
  modelBackend: CodexModelBackend = CodexModelBackend.OpenAiChatGpt,
  mimoApiKeyEnvVarName = codexMimoApiKeyEnvVarDefault,
  dependencyTools?: DependencyToolGuestConfig,
  resolverReadPaths: readonly string[] = [],
): string {
  const hookPath = fileURLToPath(
    new URL("./hosted-global-scan-pre-tool-hook.js", import.meta.url),
  );
  const command = `${shellQuote(process.execPath)} ${shellQuote(hookPath)}`;
  return [
    codexJsonHomeConfigToml({ hooksEnabled: true, providerEgressPolicy, namedPermissions: true,
      modelBackend, mimoApiKeyEnvVarName }),
    hostedCodexPermissionProfilesToml(providerEgressPolicy, executableReadPath, undefined, dependencyTools, resolverReadPaths),
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
