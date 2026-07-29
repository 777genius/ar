import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  AgentRuntimeFailureCode,
  AgentRuntimeTaskProtocolError,
  agentRuntimeTaskRequestToProviderTask,
  makeFailedAgentRuntimeTaskResult,
  parseAgentRuntimeTaskRequest,
  providerTaskResultToAgentRuntimeTaskResult,
  type AgentRuntimeTaskRequest,
  type AgentRuntimeTaskRequestV1,
  type AgentRuntimeTaskRequestV2,
  type AgentRuntimeTaskResult,
  type AgentRuntimeTaskResultV1,
  type AgentRuntimeTaskResultV2,
  agentRuntimeTaskProtocolVersionV1,
  agentRuntimeTaskProtocolVersionV2,
} from "@vioxen/subscription-runtime/agent-runtime-task";
import type {
  AgentCapabilities,
  ProviderTask,
  ProviderTaskResult,
  RuntimeWarning,
} from "@vioxen/subscription-runtime/core";
import {
  AgentRuntimeAccessBoundary,
  AgentRuntimeBudgetMetric,
  AgentRuntimeExecutionMode,
  isProviderFailureCode,
} from "@vioxen/subscription-runtime/core";
import {
  ClaudeAgentSdkTaskExecutionEngine,
  claudeAgentSdkTaskAgentCapabilities,
  claudeBgTaskAgentCapabilities,
} from "@vioxen/subscription-runtime/provider-claude";
import {
  pruneCodexChildEnv,
} from "@vioxen/subscription-runtime/provider-codex";
import {
  AuthSourceKind,
  ClaudeAgentRuntimeBackend,
  type AgentRuntimeAuthSource,
  type AgentRuntimeTaskRunner,
  type AgentRuntimeTaskRunnerRunOptions,
  type CreateLocalAgentRuntimeTaskRunnerInput as PublicCreateLocalAgentRuntimeTaskRunnerInput,
} from "../../agent-runtime-task-runner/domain";
import {
  FileBackendClaudeWorker,
} from "../../worker-claude/file-backend-claude-worker";
import {
  FileBackendCodexWorker,
} from "../../worker-codex/file-backend-codex-worker";
import {
  isSubscriptionWorkerError,
} from "@vioxen/subscription-runtime/worker-core";
import {
  pruneClaudeChildEnv,
  resolveRequestCwd,
} from "./domain";
import {
  AgentRuntimeTaskProvider,
} from "./ports";
import type {
  ProviderName,
  AgentRuntimeTaskWorker,
  AgentRuntimeTaskWorkerFactory,
  AgentRuntimeTaskWorkerFactoryInput,
  AgentRuntimeTaskWorkerResult,
} from "./ports";
import {
  validateRunnerControls,
} from "./control-policy";
import {
  errorDetails,
  optionalFailureDetails,
} from "./error-details";
import {
  mapProviderToolPolicy,
} from "./tool-policy";
import {
  codexCapabilitiesForExecutionPlan,
  compileCodexExecutionPlan,
  type CodexExecutionPlan,
} from "./codex-execution-plan";
import {
  CodexCliRuntimeFeatureProbe,
  CodexRuntimeFeature,
  type CodexRuntimeFeatureProbe,
} from "./codex-runtime-feature-probe";
import {
  AgentRuntimeTaskCancelledError,
  AgentRuntimeTaskPreflightDeadline,
  AgentRuntimeTaskTimeoutError,
  disposeWorker,
  makeCancelledAgentRuntimeTaskResult,
  makeTimeoutAgentRuntimeTaskResult,
  makeWorkerDisposeUnconfirmedResult,
  pendingAuthoritiesForRequest,
  resultForProtocol,
  runWorkerTaskWithTimeout,
  throwIfAborted,
} from "./execution-lifecycle";

export { AuthSourceKind, ClaudeAgentRuntimeBackend };
export type {
  AgentRuntimeTaskRunnerRunOptions,
};
export type LocalAgentRuntimeTaskRunnerAuthSource =
  AgentRuntimeAuthSource;

export type CreateLocalAgentRuntimeTaskRunnerInput =
  PublicCreateLocalAgentRuntimeTaskRunnerInput & {
  readonly claudeBackend?: ClaudeAgentRuntimeBackend;
  readonly claudePath?: string;
  readonly claudeRuntimeDistDir?: string;
  readonly codexBinaryPath?: string;
  readonly codexRuntimeFeatureProbe?: CodexRuntimeFeatureProbe;
  readonly workerFactory?: AgentRuntimeTaskWorkerFactory;
};

export function createLocalAgentRuntimeTaskRunner(
  input: CreateLocalAgentRuntimeTaskRunnerInput,
): AgentRuntimeTaskRunner {
  return new LocalAgentRuntimeTaskRunner(input);
}

export function createDefaultAgentRuntimeTaskWorker(
  input: AgentRuntimeTaskWorkerFactoryInput,
): AgentRuntimeTaskWorker {
  if (input.provider === AgentRuntimeTaskProvider.Claude) {
    const backend = input.claudeBackend ?? ClaudeAgentRuntimeBackend.AgentSdk;
    const runtimeModules = backend === ClaudeAgentRuntimeBackend.Background
      ? claudeRuntimeModuleLoaders(input.claudeRuntimeDistDir)
      : {};
    return new FileBackendClaudeWorker({
      providerInstanceId: input.providerInstanceId,
      stateRootDir: input.stateRootDir,
      encryptionKey: input.encryptionKey,
      baseEnv: input.env,
      workspacePath: input.cwd,
      ...(input.model ? { model: input.model } : {}),
      ...(input.timeoutMs ? { taskTimeoutMs: input.timeoutMs } : {}),
      ...(input.claudePath ? { claudePath: input.claudePath } : {}),
      ...(backend === ClaudeAgentRuntimeBackend.AgentSdk
        ? {
            engine: new ClaudeAgentSdkTaskExecutionEngine({
              baseEnv: input.env,
              ...(input.claudePath ? { binaryPath: input.claudePath } : {}),
            }),
          }
        : {}),
      ...runtimeModules,
    });
  }
  return new FileBackendCodexWorker({
    providerInstanceId: input.providerInstanceId,
    stateRootDir: input.stateRootDir,
    encryptionKey: input.encryptionKey,
    codexBinaryPath: input.codexBinaryPath ?? "codex",
    executionEngine: input.codexExecutionPlan
      ? input.codexExecutionPlan.execution.mode === AgentRuntimeExecutionMode.Goal
        ? "app-server-goal"
        : "app-server"
      : "packaged-exec",
    sourceEnv: input.env,
    workspacePath: input.cwd,
    ...(input.model ? { model: input.model } : {}),
    ...(input.timeoutMs ? { taskTimeoutMs: input.timeoutMs } : {}),
    ...(input.codexExecutionPlan?.workspaceToolPolicy
      ? {
          boundedWorkspaceTools: {
            allowedTools:
              input.codexExecutionPlan.workspaceToolPolicy.allowedTools,
          },
          cleanThreadPrewarm: false,
          warmupPrompt: false,
        }
      : {}),
    ...(input.codexExecutionPlan?.rolloutBudget
      ? { rolloutBudget: input.codexExecutionPlan.rolloutBudget }
      : {}),
    ...(input.codexExecutionPlan?.execution.maxGoalTurns === undefined
      ? {}
      : { maxGoalTurns: input.codexExecutionPlan.execution.maxGoalTurns }),
  });
}

class LocalAgentRuntimeTaskRunner implements AgentRuntimeTaskRunner {
  private disposed = false;
  private readonly activeRuns = new Set<ActiveRun>();
  private readonly codexRuntimeFeatureProbe: CodexRuntimeFeatureProbe;

  constructor(
    private readonly input: CreateLocalAgentRuntimeTaskRunnerInput,
  ) {
    this.codexRuntimeFeatureProbe =
      input.codexRuntimeFeatureProbe ?? new CodexCliRuntimeFeatureProbe();
  }

  run(
    request: AgentRuntimeTaskRequestV1,
    options?: AgentRuntimeTaskRunnerRunOptions,
  ): Promise<AgentRuntimeTaskResultV1>;
  run(
    request: AgentRuntimeTaskRequestV2,
    options?: AgentRuntimeTaskRunnerRunOptions,
  ): Promise<AgentRuntimeTaskResultV2>;
  run(
    request: AgentRuntimeTaskRequest,
    options?: AgentRuntimeTaskRunnerRunOptions,
  ): Promise<AgentRuntimeTaskResult>;
  async run(
    request: AgentRuntimeTaskRequest,
    options: AgentRuntimeTaskRunnerRunOptions = {},
  ): Promise<AgentRuntimeTaskResult> {
    const protocolVersion = protocolVersionForRequest(request);
    let taskStarted = false;
    const result = await this.runInternal(
      request,
      options,
      () => {
        taskStarted = true;
      },
    );
    return resultForProtocol(
      result,
      protocolVersion,
      taskStarted,
      pendingAuthoritiesForRequest(request, this.input.provider),
    );
  }

  private async runInternal(
    request: AgentRuntimeTaskRequest,
    options: AgentRuntimeTaskRunnerRunOptions,
    markTaskStarted: () => void,
  ): Promise<AgentRuntimeTaskResult> {
    const strictCleanupLifecycle =
      request.protocolVersion === agentRuntimeTaskProtocolVersionV2;
    if (this.disposed) {
      return makeFailedAgentRuntimeTaskResult({
        code: AgentRuntimeFailureCode.BackendUnavailable,
        safeMessage: "Agent runtime task runner has already been disposed.",
      });
    }
    const activeRun = createActiveRun();
    this.activeRuns.add(activeRun);
    const signal = options.signal
      ? AbortSignal.any([options.signal, activeRun.abortController.signal])
      : activeRun.abortController.signal;
    try {
      if (signal.aborted) {
        return makeCancelledAgentRuntimeTaskResult();
      }

      let parsedRequest: AgentRuntimeTaskRequest;
      try {
        parsedRequest = parseAgentRuntimeTaskRequest(request);
      } catch (error) {
        return makeFailedAgentRuntimeTaskResult({
          code: AgentRuntimeFailureCode.TaskRequestInvalid,
          safeMessage:
            error instanceof Error ? error.message : "Invalid agent runtime task request.",
          ...optionalFailureDetails(errorDetails(error)),
        });
      }
      const taskRequest = parsedRequest;
      const timeoutMs = taskRequest.timeoutMs ?? this.input.timeoutMs;
      const preflightDeadline = new AgentRuntimeTaskPreflightDeadline(
        timeoutMs,
        signal,
      );
      try {
        const task = mapProviderToolPolicy(
          this.input.provider,
          agentRuntimeTaskRequestToProviderTask(taskRequest),
        );
        const goalValidation = validateGoalRequest(
          task,
          timeoutMs,
          this.input.provider,
        );
        if (goalValidation) return goalValidation;
        const compiledCodexExecutionPlan =
          this.input.provider === AgentRuntimeTaskProvider.Codex
            ? compileCodexExecutionPlan(task)
            : undefined;
        let resolvedCodexPlan: {
          readonly plan?: CodexExecutionPlan;
          readonly result?: AgentRuntimeTaskResult;
        };
        try {
          resolvedCodexPlan = await preflightDeadline.race(
            this.resolveCodexExecutionPlan(
              compiledCodexExecutionPlan,
              preflightDeadline.signal,
            ),
          );
        } catch (error) {
          if (error instanceof AgentRuntimeTaskTimeoutError) {
            return makeTimeoutAgentRuntimeTaskResult(error.timeoutMs);
          }
          if (error instanceof AgentRuntimeTaskCancelledError) {
            return makeCancelledAgentRuntimeTaskResult();
          }
          throw error;
        }
        if (resolvedCodexPlan.result) return resolvedCodexPlan.result;
        const codexExecutionPlan = resolvedCodexPlan.plan;
        const controls = validateRunnerControls({
          capabilities: capabilitiesForProvider(
            this.input.provider,
            this.input.claudeBackend,
            codexExecutionPlan,
          ),
          provider: this.input.provider,
          task,
        });
        if (controls.result) return controls.result;

        let authSource: LocalAgentRuntimeTaskRunnerAuthSource | undefined;
        try {
          authSource = authSourceForProvider({
            provider: this.input.provider,
            authSource: this.input.authSource,
          });
        } catch (error) {
          return makeFailedAgentRuntimeTaskResult({
            code: AgentRuntimeFailureCode.TaskRequestInvalid,
            safeMessage: error instanceof Error
              ? error.message
              : "Invalid agent runtime auth source.",
          });
        }

        let cwd: string;
        try {
          cwd = await preflightDeadline.race(
            resolveRequestCwd(
              this.input.workspaceRoot,
              taskRequest.cwd ?? ".",
            ),
          );
        } catch (error) {
          if (error instanceof AgentRuntimeTaskTimeoutError) {
            return makeTimeoutAgentRuntimeTaskResult(error.timeoutMs);
          }
          if (error instanceof AgentRuntimeTaskCancelledError) {
            return makeCancelledAgentRuntimeTaskResult();
          }
          return makeFailedAgentRuntimeTaskResult({
            code: AgentRuntimeFailureCode.TaskRequestInvalid,
            safeMessage: error instanceof Error
              ? error.message
              : "Invalid agent runtime task cwd.",
          });
        }
        const remainingTimeoutMs = preflightDeadline.remainingTimeoutMs();
        if (
          remainingTimeoutMs === 0 &&
          timeoutMs !== undefined
        ) {
          return makeTimeoutAgentRuntimeTaskResult(timeoutMs);
        }
        preflightDeadline.dispose();

        let worker: AgentRuntimeTaskWorker;
        try {
          worker = this.createWorker({
            cwd,
            request: taskRequest,
            ...(codexExecutionPlan === undefined
              ? {}
              : { codexExecutionPlan }),
            ...(remainingTimeoutMs === undefined
              ? {}
              : { timeoutMs: remainingTimeoutMs }),
          });
        } catch (error) {
          return makeWorkerStartupFailureResult(
            this.input.provider,
            error,
            controls.warnings,
          );
        }
        let result: AgentRuntimeTaskResult;
        try {
          result = await runWorkerTaskWithTimeout({
            ...(remainingTimeoutMs === undefined
              ? {}
              : {
                  timeoutMs: remainingTimeoutMs,
                  reportedTimeoutMs: timeoutMs,
                }),
            signal,
            ...(strictCleanupLifecycle
              ? { settlementTimeoutMs: this.input.cleanupTimeoutMs ?? 5_000 }
              : {}),
            run: async (abortSignal) => {
              await worker.start();
              throwIfAborted(abortSignal);
              await seedWorker({
                authSource,
                provider: this.input.provider,
                worker,
              });
              throwIfAborted(abortSignal);
              return await runWorkerTask({
                abortSignal,
                request: taskRequest,
                task,
                provider: this.input.provider,
                worker,
                warnings: controls.warnings,
                markTaskStarted,
              });
            },
          });
        } catch (error) {
          result = makeWorkerStartupFailureResult(
            this.input.provider,
            error,
            controls.warnings,
          );
        }
        const cleanupError = await disposeWorker({
          worker,
          timeoutMs: this.input.cleanupTimeoutMs ?? 5_000,
          ...(this.input.onDisposeError
            ? { onDisposeError: this.input.onDisposeError }
            : {}),
        });
        return cleanupError === undefined || !strictCleanupLifecycle
          ? result
          : makeWorkerDisposeUnconfirmedResult();
      } finally {
        preflightDeadline.dispose();
      }
    } finally {
      this.activeRuns.delete(activeRun);
      activeRun.resolveDone();
    }
  }

  private async resolveCodexExecutionPlan(
    plan: CodexExecutionPlan | undefined,
    signal: AbortSignal,
  ): Promise<{
    readonly plan?: CodexExecutionPlan;
    readonly result?: AgentRuntimeTaskResult;
  }> {
    if (!plan) return {};
    if (plan.execution.mode === AgentRuntimeExecutionMode.Goal) {
      const goalSupported = await this.probeCodexFeature(
        CodexRuntimeFeature.Goals,
        signal,
      );
      if (goalSupported.result) return { result: goalSupported.result };
      if (!goalSupported.supported) {
        return {
          result: makeFailedAgentRuntimeTaskResult({
            code: AgentRuntimeFailureCode.TaskModeUnsupported,
            safeMessage: "Codex runtime does not advertise Goal support.",
          }),
        };
      }
    }
    if (!plan.rolloutBudget) return { plan };
    const budgetSupported = await this.probeCodexFeature(
      CodexRuntimeFeature.RolloutBudget,
      signal,
    );
    if (budgetSupported.result) return { result: budgetSupported.result };
    if (budgetSupported.supported) return { plan };
    return plan.workspaceToolPolicy
      ? {
          plan: {
            execution: plan.execution,
            workspaceToolPolicy: plan.workspaceToolPolicy,
          },
        }
      : { plan: { execution: plan.execution } };
  }

  private async probeCodexFeature(
    feature: CodexRuntimeFeature,
    signal: AbortSignal,
  ): Promise<{
    readonly supported?: boolean;
    readonly result?: AgentRuntimeTaskResult;
  }> {
    try {
      const supported = await this.codexRuntimeFeatureProbe.supports({
        binaryPath: this.input.codexBinaryPath ?? "codex",
        feature,
        env: pruneCodexChildEnv(this.input.env),
        signal,
      });
      return { supported };
    } catch (error) {
      if (signal.aborted) {
        return { result: makeCancelledAgentRuntimeTaskResult() };
      }
      return {
        result: makeFailedAgentRuntimeTaskResult({
          code: AgentRuntimeFailureCode.ProviderRuntimeUnavailable,
          safeMessage:
            "Codex runtime capability probing failed before task execution.",
          ...optionalFailureDetails(errorDetails(error)),
        }),
      };
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const activeRuns = [...this.activeRuns];
    for (const activeRun of activeRuns) activeRun.abortController.abort();
    await Promise.all(activeRuns.map((activeRun) => activeRun.done));
  }

  private createWorker(input: {
    readonly cwd: string;
    readonly request: AgentRuntimeTaskRequest;
    readonly codexExecutionPlan?: CodexExecutionPlan;
    readonly timeoutMs?: number;
  }): AgentRuntimeTaskWorker {
    const providerInstanceId =
      this.input.providerInstanceId ??
      input.request.providerInstanceId ??
      `${this.input.provider}:default`;
    const workerFactory =
      this.input.workerFactory ?? createDefaultAgentRuntimeTaskWorker;
    const env = this.input.provider === AgentRuntimeTaskProvider.Claude
      ? pruneClaudeChildEnv(this.input.env)
      : this.input.env;
    return workerFactory({
      provider: this.input.provider,
      stateRootDir: this.input.stateRootDir,
      providerInstanceId,
      encryptionKey: this.input.encryptionKey,
      cwd: input.cwd,
      env,
      ...(this.input.model ? { model: this.input.model } : {}),
      ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
      ...(this.input.claudePath ? { claudePath: this.input.claudePath } : {}),
      ...(this.input.claudeBackend
        ? { claudeBackend: this.input.claudeBackend }
        : {}),
      ...(this.input.claudeRuntimeDistDir
        ? { claudeRuntimeDistDir: this.input.claudeRuntimeDistDir }
        : {}),
      ...(this.input.codexBinaryPath
        ? { codexBinaryPath: this.input.codexBinaryPath }
        : {}),
      ...(input.codexExecutionPlan
        ? { codexExecutionPlan: input.codexExecutionPlan }
        : {}),
    });
  }
}

function protocolVersionForRequest(request: AgentRuntimeTaskRequest) {
  const protocolVersion = (request as { readonly protocolVersion?: unknown })
    .protocolVersion;
  if (protocolVersion === agentRuntimeTaskProtocolVersionV1) {
    return agentRuntimeTaskProtocolVersionV1;
  }
  if (protocolVersion === agentRuntimeTaskProtocolVersionV2) {
    return agentRuntimeTaskProtocolVersionV2;
  }
  throw new AgentRuntimeTaskProtocolError(
    "agent_runtime_task_protocol_version_invalid",
    "Agent runtime task protocol version must be 1 or 2.",
  );
}

type ActiveRun = {
  readonly abortController: AbortController;
  readonly done: Promise<void>;
  readonly resolveDone: () => void;
};

function createActiveRun(): ActiveRun {
  let resolveDone = (): void => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  return {
    abortController: new AbortController(),
    done,
    resolveDone,
  };
}

function claudeRuntimeModuleLoaders(
  distDir: string | undefined,
): Pick<
  ConstructorParameters<typeof FileBackendClaudeWorker>[0],
  "runtimeModuleLoader" | "providerModuleLoader"
> {
  if (!distDir) return {};
  const resolvedDistDir = resolve(distDir);
  const runtimePath = join(resolvedDistDir, "index.js");
  const providerPath = join(
    resolvedDistDir,
    "infrastructure",
    "claude-bg",
    "provider",
    "index.js",
  );
  if (!existsSync(runtimePath) || !existsSync(providerPath)) {
    throw new ProviderRuntimeUnavailableError(
      AgentRuntimeTaskProvider.Claude,
      "claude-runtime",
      "CLAUDE_RUNTIME_DIST_DIR must contain index.js and infrastructure/claude-bg/provider/index.js.",
    );
  }
  return {
    runtimeModuleLoader: async () => import(pathToFileURL(runtimePath).href),
    providerModuleLoader: async () => import(pathToFileURL(providerPath).href),
  };
}

function authSourceForProvider(input: {
  readonly provider: ProviderName;
  readonly authSource: LocalAgentRuntimeTaskRunnerAuthSource | undefined;
}): LocalAgentRuntimeTaskRunnerAuthSource | undefined {
  if (input.authSource === undefined) return undefined;
  assertAuthSourceMatchesProvider(input.provider, input.authSource);
  return input.authSource;
}

function assertAuthSourceMatchesProvider(
  provider: ProviderName,
  authSource: LocalAgentRuntimeTaskRunnerAuthSource,
): void {
  if (authSource.kind === AuthSourceKind.PreseededSession) {
    return;
  }
  if (
    provider === AgentRuntimeTaskProvider.Claude &&
    authSource.kind === AuthSourceKind.ClaudeOAuthToken
  ) {
    return;
  }
  if (
    provider === AgentRuntimeTaskProvider.Codex &&
    authSource.kind === AuthSourceKind.CodexAuthJsonFile
  ) {
    return;
  }
  throw new Error(`${authSource.kind} auth source cannot be used with ${provider}`);
}

async function seedWorker(input: {
  readonly provider: ProviderName;
  readonly authSource: LocalAgentRuntimeTaskRunnerAuthSource | undefined;
  readonly worker: AgentRuntimeTaskWorker;
}): Promise<void> {
  if (
    input.authSource === undefined ||
    input.authSource.kind === AuthSourceKind.PreseededSession
  ) {
    return;
  }
  if (input.provider === AgentRuntimeTaskProvider.Claude) {
    if (
      input.authSource.kind !==
      AuthSourceKind.ClaudeOAuthToken
    ) {
      throw new Error("Claude agent runtime requires a claude-oauth-token auth source");
    }
    if (!input.worker.seedClaudeOAuth) {
      throw new Error("selected worker does not support Claude OAuth seeding");
    }
    await input.worker.seedClaudeOAuth({ oauthToken: input.authSource.oauthToken });
    return;
  }

  if (
    input.authSource.kind !==
    AuthSourceKind.CodexAuthJsonFile
  ) {
    throw new Error("Codex agent runtime requires a codex-auth-json-file auth source");
  }
  if (!input.worker.seedCodexAuthJsonFile) {
    throw new Error("selected worker does not support Codex auth seeding");
  }
  await input.worker.seedCodexAuthJsonFile(input.authSource.path);
}

async function runWorkerTask(input: {
  readonly request: AgentRuntimeTaskRequest;
  readonly task: ProviderTask;
  readonly provider: ProviderName;
  readonly worker: AgentRuntimeTaskWorker;
  readonly abortSignal: AbortSignal;
  readonly warnings: readonly RuntimeWarning[];
  readonly markTaskStarted: () => void;
}): Promise<AgentRuntimeTaskResult> {
  try {
    input.markTaskStarted();
    const result = await input.worker.run({
      runId: input.request.runId ?? `agent-runtime-task-${randomUUID()}`,
      prompt: input.task.prompt,
      ...(input.task.systemPrompt !== undefined
        ? { systemPrompt: input.task.systemPrompt }
        : {}),
      kind: input.task.kind,
      ...(input.task.outputSchemaName
        ? { outputSchemaName: input.task.outputSchemaName }
        : {}),
      ...(input.task.controls ? { controls: input.task.controls } : {}),
      ...(input.task.execution ? { execution: input.task.execution } : {}),
      ...(input.task.metadata ? { metadata: input.task.metadata } : {}),
      abortSignal: input.abortSignal,
    });
    return appendWarnings(
      providerTaskResultToAgentRuntimeTaskResult(toProviderTaskResult(result)),
      input.warnings,
    );
  } catch (error) {
    const providerFailure = providerFailureResult(error, input.warnings);
    if (providerFailure) return providerFailure;
    const unavailable = providerRuntimeUnavailableResult(
      input.provider,
      error,
      input.warnings,
    );
    if (unavailable) return unavailable;
    return makeFailedAgentRuntimeTaskResult({
      code: AgentRuntimeFailureCode.UnknownRuntimeFailure,
      safeMessage: isSubscriptionWorkerError(error)
        ? error.message
        : "Agent runtime worker task failed.",
      ...optionalFailureDetails(errorDetails(error)),
      warnings: input.warnings,
    });
  }
}

class ProviderRuntimeUnavailableError extends Error {
  constructor(
    readonly provider: ProviderName,
    readonly missing: string,
    message: string,
  ) {
    super(message);
    this.name = "ProviderRuntimeUnavailableError";
  }
}

function makeWorkerStartupFailureResult(
  provider: ProviderName,
  error: unknown,
  warnings: readonly RuntimeWarning[],
): AgentRuntimeTaskResult {
  return providerFailureResult(error, warnings) ??
    providerRuntimeUnavailableResult(provider, error, warnings) ??
    makeFailedAgentRuntimeTaskResult({
      code: AgentRuntimeFailureCode.UnknownRuntimeFailure,
      safeMessage: isSubscriptionWorkerError(error)
        ? error.message
        : "Agent runtime worker startup failed.",
      ...optionalFailureDetails(errorDetails(error)),
      warnings,
    });
}

function providerFailureResult(
  error: unknown,
  warnings: readonly RuntimeWarning[],
): AgentRuntimeTaskResult | undefined {
  if (!isSubscriptionWorkerError(error)) return undefined;
  const code = error.details["code"];
  if (!isProviderFailureCode(code)) return undefined;
  return makeFailedAgentRuntimeTaskResult({
    code,
    safeMessage: error.message,
    retryable: error.details["retryable"] === "true",
    reconnectRequired: error.details["reconnectRequired"] === "true",
    ...(error.details["causeCategory"] === undefined
      ? {}
      : { causeCategory: error.details["causeCategory"] }),
    ...optionalFailureDetails(errorDetails(error)),
    warnings,
  });
}

function providerRuntimeUnavailableResult(
  provider: ProviderName,
  error: unknown,
  warnings: readonly RuntimeWarning[],
): AgentRuntimeTaskResult | undefined {
  const unavailable = classifyProviderRuntimeUnavailable(provider, error);
  if (!unavailable) return undefined;
  return makeFailedAgentRuntimeTaskResult({
    code: AgentRuntimeFailureCode.ProviderRuntimeUnavailable,
    safeMessage: unavailable.safeMessage,
    details: {
      provider,
      missing: unavailable.missing,
    },
    warnings,
  });
}

function classifyProviderRuntimeUnavailable(
  provider: ProviderName,
  error: unknown,
): { readonly missing: string; readonly safeMessage: string } | undefined {
  if (error instanceof ProviderRuntimeUnavailableError) {
    return {
      missing: error.missing,
      safeMessage: `${provider} runtime is unavailable.`,
    };
  }
  const message = errorMessage(error);
  if (
    provider === AgentRuntimeTaskProvider.Claude &&
    message.includes("@anthropic-ai/claude-agent-sdk") &&
    (message.includes("Cannot find package") ||
      message.includes("Cannot find module") ||
      message.includes("ERR_MODULE_NOT_FOUND"))
  ) {
    return {
      missing: "claude-agent-sdk",
      safeMessage: "Claude Agent SDK is unavailable.",
    };
  }
  if (
    provider === AgentRuntimeTaskProvider.Claude &&
    (message.includes("CLAUDE_RUNTIME_DIST_DIR") ||
      message.includes("Cannot find package 'claude-runtime'") ||
      message.includes('Cannot find package "claude-runtime"') ||
      message.includes("Cannot find module 'claude-runtime'") ||
      message.includes('Cannot find module "claude-runtime"') ||
      (message.includes("ERR_MODULE_NOT_FOUND") && message.includes("claude-runtime")))
  ) {
    return {
      missing: "claude-runtime",
      safeMessage: "Claude runtime is unavailable.",
    };
  }
  if (
    provider === AgentRuntimeTaskProvider.Codex &&
    message.includes("ENOENT") &&
    message.toLowerCase().includes("codex")
  ) {
    return { missing: "codex", safeMessage: "Codex runtime is unavailable." };
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function capabilitiesForProvider(
  provider: ProviderName,
  claudeBackend: ClaudeAgentRuntimeBackend | undefined,
  codexExecutionPlan: CodexExecutionPlan | undefined,
): AgentCapabilities {
  if (provider === AgentRuntimeTaskProvider.Codex) {
    return codexCapabilitiesForExecutionPlan(codexExecutionPlan);
  }
  return (claudeBackend ?? ClaudeAgentRuntimeBackend.AgentSdk) ===
    ClaudeAgentRuntimeBackend.AgentSdk
    ? claudeAgentSdkTaskAgentCapabilities
    : claudeBgTaskAgentCapabilities;
}

function validateGoalRequest(
  task: ProviderTask,
  timeoutMs: number | undefined,
  provider: ProviderName,
): AgentRuntimeTaskResult | undefined {
  if (task.execution?.mode !== AgentRuntimeExecutionMode.Goal) return undefined;
  if (timeoutMs === undefined) {
    return makeFailedAgentRuntimeTaskResult({
      code: AgentRuntimeFailureCode.TaskRequestInvalid,
      safeMessage: "Goal execution requires an explicit wall-clock timeout.",
    });
  }
  if (task.controls?.maxTurns === undefined) {
    return makeFailedAgentRuntimeTaskResult({
      code: AgentRuntimeFailureCode.TaskRequestInvalid,
      safeMessage: "Goal execution requires an explicit provider turn limit.",
    });
  }
  if (task.controls?.accessBoundary === undefined) {
    return makeFailedAgentRuntimeTaskResult({
      code: AgentRuntimeFailureCode.TaskRequestInvalid,
      safeMessage: "Goal execution requires an explicit access boundary.",
    });
  }
  if (
    task.controls.accessBoundary === AgentRuntimeAccessBoundary.DangerFullAccess
  ) {
    return makeFailedAgentRuntimeTaskResult({
      code: AgentRuntimeFailureCode.TaskRequestInvalid,
      safeMessage: "Goal execution does not support danger-full-access.",
    });
  }
  if (!task.controls.allowedTools || task.controls.allowedTools.length === 0) {
    return makeFailedAgentRuntimeTaskResult({
      code: AgentRuntimeFailureCode.TaskRequestInvalid,
      safeMessage: "Goal execution requires an explicit non-empty tool allowlist.",
    });
  }
  const requiredBudgetMetric = requiredGoalBudgetMetric(provider);
  if (task.controls.budget?.metric !== requiredBudgetMetric) {
    return makeFailedAgentRuntimeTaskResult({
      code: AgentRuntimeFailureCode.TaskRequestInvalid,
      safeMessage: provider === AgentRuntimeTaskProvider.Codex
        ? "Codex Goal execution requires an explicit weighted-token budget."
        : "Claude Goal execution requires an explicit USD budget.",
    });
  }
  return undefined;
}

function requiredGoalBudgetMetric(
  provider: ProviderName,
): AgentRuntimeBudgetMetric {
  switch (provider) {
    case AgentRuntimeTaskProvider.Claude:
      return AgentRuntimeBudgetMetric.Usd;
    case AgentRuntimeTaskProvider.Codex:
      return AgentRuntimeBudgetMetric.WeightedTokens;
  }
}

function appendWarnings(
  result: AgentRuntimeTaskResult,
  warnings: readonly RuntimeWarning[],
): AgentRuntimeTaskResult {
  if (warnings.length === 0) return result;
  return {
    ...result,
    warnings: [...warnings, ...result.warnings],
  };
}

function toProviderTaskResult(
  result: AgentRuntimeTaskWorkerResult,
): ProviderTaskResult {
  if (result.status === "waiting_for_input") {
    if (!result.runId || !result.request || !result.resumeHandle) {
      throw new Error("agent_runtime_task_waiting_result_invalid");
    }
    return {
      status: "waiting_for_input",
      runId: result.runId,
      outputText: result.outputText,
      ...(result.structuredOutput === undefined
        ? {}
        : { structuredOutput: result.structuredOutput }),
      request: result.request,
      resumeHandle: result.resumeHandle,
      ...(result.telemetry ? { telemetry: result.telemetry } : {}),
      warnings: result.warnings,
    };
  }
  return {
    status: "completed",
    outputText: result.outputText,
    ...(result.structuredOutput === undefined
      ? {}
      : { structuredOutput: result.structuredOutput }),
    ...(result.telemetry ? { telemetry: result.telemetry } : {}),
    warnings: result.warnings,
  };
}
