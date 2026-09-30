import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import {
  AgentRuntimeExecutionMode,
  assertProviderTaskSystemPrompt,
  type AgentDriver,
  type AgentCapabilities,
  type ManagedRunResumeHandle,
  type ProviderFailure,
  type ProviderLogicalThreadExecution,
  type ProviderTask,
  type ProviderTaskResult,
  type RedactorPort,
  type RuntimeWarning,
  type SessionArtifact,
  type WorkspaceHandle,
} from "@vioxen/subscription-runtime/core";
import {
  codexJsonAgentCapabilities,
  codexJsonAgentId,
  codexProviderId,
  defaultCodexModel,
} from "./capabilities";
import { classifyCodexFailure } from "./failure-classifier";
import { createCodexTextDeltaRedactor } from "./codex-text-delta-redactor";
import { usageFromError } from "./app-server/domain/app-server-usage-error";
import {
  type CodexExecutionEngine,
  type CodexMaterializedSession,
  type CodexOutputSchemaRequest,
  type CodexReasoningEffort,
  type CodexServiceTier,
  PackagedCodexJsonExecutionEngine,
  codexSandboxModeForControls,
  codexExecutionFailure,
} from "./codex-json-execution-engine";
import {
  CodexEphemeralSessionMaterializer,
  codexJsonHomeConfigToml,
  type CodexSessionMaterializer,
  type CodexSessionPrewarmResult,
  sessionArtifactHash,
} from "./codex-session-materializer";
import { cleanupCodexRuntimeTempRoot } from "./codex-cli-temp-cleanup";
import { createCodexRuntimeTempRoot } from "./codex-runtime-temp";
import {
  CodexApiKeyCredentialMissingError,
  codexApiKeyCredentialIdentity,
  loadCodexApiKeyCredential,
} from "./codex-api-key-credential";
import { resolveAuthorizedHostedMimoCredential } from "./hosted-mimo-credential-source";
import {
  CodexModelBackend,
  codexMimoApiKeyEnvVarDefault,
  codexModelBackendDefaultModel,
} from "./codex-model-backend";
import {
  codexMimoTokenPlanEgressPolicy,
  codexProviderEgressEnv,
} from "./codex-provider-egress-policy";

type CodexJsonAgentDriverBaseOptions = {
  readonly model?: string;
  readonly reasoningEffort?: CodexReasoningEffort;
  readonly serviceTier?: CodexServiceTier;
  readonly warmupPrompt?: string;
  readonly sessionMaterializer?: CodexSessionMaterializer;
  readonly outputSchemas?: Readonly<Record<string, unknown>>;
  /** Defaults to {@link CodexModelBackend.OpenAiChatGpt} — existing behavior is unchanged. */
  readonly modelBackend?: CodexModelBackend;
  /** Env var holding the MiMo Token Plan key. Only read when `modelBackend` is `XiaomiMimoTokenPlan`. */
  readonly mimoApiKeyEnvVarName?: string;
  /**
   * Optional generated CODEX_HOME config for MiMo's no-session path. This is
   * how bounded MCP-only workspace tool profiles reach the MiMo adapter
   * without routing API-key material through the ChatGPT session store.
   */
  readonly mimoConfigToml?: string;
  readonly sourceEnv?: Readonly<Record<string, string | undefined>>;
};

export type CodexJsonAgentDriverOptions = CodexJsonAgentDriverBaseOptions &
  (
    | {
        readonly engine: CodexExecutionEngine;
      }
    | {
        readonly codexBinaryPath: string;
        readonly sourceEnv?: Readonly<Record<string, string | undefined>>;
        readonly timeoutMs?: number;
      }
  );

export class CodexJsonAgentDriver implements AgentDriver {
  readonly agentId = codexJsonAgentId;
  readonly providerId = codexProviderId;
  readonly capabilities: AgentCapabilities;
  private readonly engine: CodexExecutionEngine;
  private readonly model: string;
  private readonly reasoningEffort: CodexReasoningEffort;
  private readonly serviceTier: CodexServiceTier | undefined;
  private readonly outputSchemas: Readonly<Record<string, unknown>>;
  private readonly sessionMaterializer: CodexSessionMaterializer;
  readonly modelBackend: CodexModelBackend;
  private readonly mimoApiKeyEnvVarName: string;
  private readonly mimoConfigToml: string | undefined;
  private readonly sourceEnv: Readonly<Record<string, string | undefined>> | undefined;
  private readonly managedRunSessions = new Map<
    string,
    CodexMaterializedSession
  >();

  constructor(private readonly options: CodexJsonAgentDriverOptions) {
    const modelBackend = options.modelBackend ?? CodexModelBackend.OpenAiChatGpt;
    this.engine =
      "engine" in options
        ? options.engine
        : new PackagedCodexJsonExecutionEngine({
            codexBinaryPath: options.codexBinaryPath,
            modelBackend,
            ...(modelBackend === CodexModelBackend.XiaomiMimoTokenPlan
              ? { providerEgressPolicy: codexMimoTokenPlanEgressPolicy() }
              : {}),
            ...(options.sourceEnv ? { sourceEnv: options.sourceEnv } : {}),
            ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
          });
    if (
      modelBackend === CodexModelBackend.XiaomiMimoTokenPlan &&
      this.engine.modelBackend !== CodexModelBackend.XiaomiMimoTokenPlan
    ) {
      throw new Error("codex_json_mimo_engine_incompatible");
    }
    if (
      this.engine.modelBackend !== undefined &&
      this.engine.modelBackend !== modelBackend
    ) {
      throw new Error("codex_json_model_backend_engine_mismatch");
    }
    const engineCapabilities = this.engine.capabilities;
    this.capabilities =
      !engineCapabilities.budgetCapabilities &&
        !engineCapabilities.taskExecutionCapabilities &&
        !engineCapabilities.turnLimitEnforcement
        ? codexJsonAgentCapabilities
        : {
            ...codexJsonAgentCapabilities,
            ...(engineCapabilities.budgetCapabilities
              ? { budgetCapabilities: engineCapabilities.budgetCapabilities }
              : {}),
            ...(engineCapabilities.taskExecutionCapabilities
              ? {
                  taskExecutionCapabilities:
                    engineCapabilities.taskExecutionCapabilities,
                }
              : {}),
            ...(engineCapabilities.turnLimitEnforcement
              ? {
                  turnLimitEnforcement:
                    engineCapabilities.turnLimitEnforcement,
                }
              : {}),
          };
    this.modelBackend = modelBackend;
    this.model =
      options.model ?? codexModelBackendDefaultModel(this.modelBackend, defaultCodexModel);
    this.reasoningEffort = options.reasoningEffort ?? "low";
    this.serviceTier = options.serviceTier;
    this.outputSchemas = options.outputSchemas ?? {};
    this.sessionMaterializer =
      options.sessionMaterializer ?? new CodexEphemeralSessionMaterializer();
    this.mimoApiKeyEnvVarName =
      options.mimoApiKeyEnvVarName ?? codexMimoApiKeyEnvVarDefault;
    this.mimoConfigToml = options.mimoConfigToml;
    this.sourceEnv = options.sourceEnv;
  }

  async runTask(input: {
    readonly session: SessionArtifact | null;
    readonly task: ProviderTask;
    readonly workspace: WorkspaceHandle;
    readonly runner: Parameters<AgentDriver["runTask"]>[0]["runner"];
    readonly redactor: RedactorPort;
    readonly abortSignal: AbortSignal;
    readonly onTaskStarted?: () => Promise<void> | void;
    readonly onTextDelta?: (text: string) => void;
    readonly logicalThread?: ProviderLogicalThreadExecution;
  }): Promise<ProviderTaskResult> {
    assertProviderTaskSystemPrompt(input.task.systemPrompt, "task.systemPrompt");

    const startedAt = Date.now();
    if (this.modelBackend === CodexModelBackend.OpenAiChatGpt && !input.session) {
      return {
        status: "failed",
        failure: {
          code: "provider_session_invalid",
          retryable: false,
          reconnectRequired: true,
          safeMessage: "Codex requires a session artifact.",
        },
        telemetry: {
          durationMs: Date.now() - startedAt,
          finishReason: "provider_error",
        },
        warnings: [],
      };
    }

    let materialized: CodexMaterializedSession | null = null;
    const outputAbortController = new AbortController();
    const outputAbortSignal = AbortSignal.any([
      input.abortSignal,
      outputAbortController.signal,
    ]);
    let textDeltaRedactor: ReturnType<typeof createCodexTextDeltaRedactor> | undefined;
    try {
      if (this.modelBackend === CodexModelBackend.XiaomiMimoTokenPlan) {
        try {
          materialized = await this.materializeMimoSession({
            redactor: input.redactor,
          });
        } catch (error) {
          if (error instanceof CodexApiKeyCredentialMissingError) {
            return {
              status: "failed",
              failure: {
                code: "provider_session_invalid",
                retryable: false,
                reconnectRequired: true,
                safeMessage: `Codex MiMo backend requires ${error.envVarName} to be set.`,
              },
              telemetry: {
                durationMs: Date.now() - startedAt,
                finishReason: "provider_error",
              },
              warnings: [],
            };
          }
          throw error;
        }
      } else {
        materialized = await this.sessionMaterializer.materialize({
          session: input.session!,
          redactor: input.redactor,
        });
      }
      textDeltaRedactor = input.onTextDelta === undefined
        ? undefined
        : createCodexTextDeltaRedactor({
            redactor: input.redactor,
            onTextDelta: input.onTextDelta,
            abortController: outputAbortController,
          });
      const activeTextDeltaRedactor = textDeltaRedactor;
      const outputSchemaName =
        input.task.controls?.outputSchemaName ?? input.task.outputSchemaName;
      const goalObjective = readTaskGoalObjective(input.task);
      const runId = readTaskManagedRunId(input.task);
      const engineInput = {
        ...(runId ? { runId } : {}),
        prompt: input.task.prompt,
        ...(goalObjective ? { goalObjective } : {}),
        ...(input.task.systemPrompt !== undefined
          ? { systemPrompt: input.task.systemPrompt }
          : {}),
        outputSchema: this.outputSchemaRequest(outputSchemaName),
        session: materialized,
        workspacePath: input.workspace.path,
        runner: input.runner,
        redactor: input.redactor,
        model: input.task.controls?.model ?? this.model,
        reasoningEffort: this.reasoningEffort,
        ...(this.serviceTier === undefined
          ? {}
          : { serviceTier: this.serviceTier }),
        sandboxMode: codexSandboxModeForControls(input.task.controls),
        abortSignal: outputAbortSignal,
        ...(activeTextDeltaRedactor === undefined
          ? {}
          : {
              onTextDelta: (text: string) => {
                activeTextDeltaRedactor.push(text);
              },
            }),
      };
      await input.onTaskStarted?.();
      const logicalThreadResult =
        input.logicalThread === undefined
          ? undefined
          : await this.runLogicalThread({
              engineInput,
              logicalThread: input.logicalThread,
            });
      const result =
        logicalThreadResult === undefined
          ? await this.engine.run(engineInput)
          : logicalThreadResult;
      textDeltaRedactor?.flush();
      if (result.status === "waiting_for_input") {
        this.managedRunSessions.set(result.runId, materialized);
        materialized = null;
        return {
          status: "waiting_for_input",
          runId: result.runId,
          outputText: result.outputText,
          ...(result.structuredOutput === undefined
            ? {}
            : { structuredOutput: result.structuredOutput }),
          request: result.request,
          resumeHandle: result.resumeHandle,
          telemetry: {
            durationMs: Date.now() - startedAt,
            finishReason: "waiting_for_input",
            ...(result.usage === undefined ? {} : { usage: result.usage }),
          },
          warnings: result.warnings,
        };
      }
      const snapshot = input.session
        ? await snapshotSessionUpdate({
            materialized,
            previousSession: input.session,
            redactor: input.redactor,
          })
        : { warnings: [] as const };

      return {
        status: "completed",
        outputText: result.outputText,
        structuredOutput: result.structuredOutput,
        ...(snapshot.sessionUpdate
          ? { sessionUpdate: snapshot.sessionUpdate }
          : {}),
        telemetry: {
          durationMs: Date.now() - startedAt,
          finishReason: "completed",
          ...(result.usage === undefined ? {} : { usage: result.usage }),
        },
        warnings: [...result.warnings, ...snapshot.warnings],
      };
    } catch (error) {
      textDeltaRedactor?.discard();
      const outputFailure =
        !input.abortSignal.aborted && outputAbortController.signal.aborted
          ? outputAbortController.signal.reason
          : error;
      const failure = codexExecutionFailure(outputFailure, input.redactor);
      return {
        ...failure,
        telemetry: {
          durationMs: Date.now() - startedAt,
          finishReason: finishReasonForFailure(failure.failure.code),
          ...(usageFromError(error)
            ? { usage: usageFromError(error)! }
            : {}),
        },
      };
    } finally {
      await materialized?.release();
    }
  }

  /**
   * MiMo is a static API-key credential, not a ChatGPT OAuth session: this
   * bypasses `sessionMaterializer` entirely so a MiMo run never reads or
   * writes `auth.json` and never touches the session store/refresh path.
   * The credential is read fresh from the env var on every call — it is
   * never cached, snapshotted, or persisted (`snapshotSession` is omitted,
   * so this session is never eligible for a `sessionUpdate`).
   */
  private async materializeMimoSession(input: {
    readonly redactor: RedactorPort;
  }): Promise<CodexMaterializedSession> {
    const hosted = (this.sourceEnv ?? process.env).SUBSCRIPTION_RUNTIME_SANDBOX_KIND === "hosted-codex-job";
    const credential = hosted ? undefined : loadCodexApiKeyCredential({
          backend: CodexModelBackend.XiaomiMimoTokenPlan,
          envVarName: this.mimoApiKeyEnvVarName,
          ...(this.sourceEnv === undefined ? {} : { sourceEnv: this.sourceEnv }),
          redactor: input.redactor,
        });
    const egressPolicy = codexMimoTokenPlanEgressPolicy();
    const tempRoot = await createCodexRuntimeTempRoot({
      prefix: "subscription-runtime-codex-mimo-",
      ...(this.sourceEnv === undefined ? {} : { sourceEnv: this.sourceEnv }),
    });
    const home = join(tempRoot, "home");
    const codexHome = join(tempRoot, "codex-home");
    await mkdir(home, { recursive: true, mode: 0o700 });
    await mkdir(codexHome, { recursive: true, mode: 0o700 });
    await writeFile(
      join(codexHome, "config.toml"),
      this.mimoConfigToml ??
        codexJsonHomeConfigToml({
          modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
          mimoApiKeyEnvVarName: this.mimoApiKeyEnvVarName,
          providerEgressPolicy: egressPolicy,
        }),
      { mode: 0o600 },
    );
    const env: Record<string, string> = {
      HOME: home,
      CODEX_HOME: codexHome,
      ...codexProviderEgressEnv(egressPolicy),
      ...(credential ? { [credential.envVarName]: credential.apiKey } : {}),
    };
    if (hosted) {
      // AppServerClient spreads session.env for each new child. The accessor
      // resolves and redacts the current key at that boundary, including a
      // restart within this one materialized session.
      Object.defineProperty(env, this.mimoApiKeyEnvVarName, {
        enumerable: true,
        get: () => resolveAuthorizedHostedMimoCredential(input.redactor),
      });
    }
    return {
      home,
      codexHome,
      sessionHash: credential ? codexApiKeyCredentialIdentity(credential) : "mimo:shared-source",
      env,
      // No snapshotSession: MiMo never refreshes and never updates its
      // credential from a completed run.
      release: once(async () => {
        try {
          await cleanupCodexRuntimeTempRoot({ tempRoot, tempCodexHome: codexHome });
        } catch {
          // Best-effort: the temp root is process-local and will not be
          // reused, so a cleanup failure here must not fail the task.
        }
      }),
    };
  }

  private async runLogicalThread(input: {
    readonly engineInput: Parameters<CodexExecutionEngine["run"]>[0];
    readonly logicalThread: ProviderLogicalThreadExecution;
  }) {
    if (!this.engine.runLogicalThread) {
      throw new Error("codex_logical_thread_unsupported");
    }
    if (input.logicalThread.previousCheckpoint !== undefined) {
      input.engineInput.redactor.registerSecret(
        input.logicalThread.previousCheckpoint,
        "codex-provider-checkpoint",
      );
    }
    const result = await this.engine.runLogicalThread({
      ...input.engineInput,
      ...(input.logicalThread.previousCheckpoint === undefined
        ? {}
        : { previousCheckpoint: input.logicalThread.previousCheckpoint }),
    });
    await input.logicalThread.onCheckpoint({
      checkpoint: result.providerCheckpoint,
      outcome: result.outcome,
    });
    return result;
  }

  async resumeManagedRun(input: {
    readonly session: SessionArtifact | null;
    readonly runId: string;
    readonly requestId: string;
    readonly answer: string;
    readonly resumeHandle: ManagedRunResumeHandle;
    readonly task?: Pick<ProviderTask, "controls" | "outputSchemaName">;
    readonly workspace: WorkspaceHandle;
    readonly runner: Parameters<AgentDriver["runTask"]>[0]["runner"];
    readonly redactor: RedactorPort;
    readonly abortSignal: AbortSignal;
  }): Promise<ProviderTaskResult> {
    if (!this.engine.resume) {
      return {
        status: "failed",
        failure: {
          code: "task_mode_unsupported",
          retryable: false,
          reconnectRequired: false,
          safeMessage:
            "Codex execution engine does not support managed run resume.",
        },
        warnings: [],
      };
    }

    const startedAt = Date.now();
    let materialized = this.managedRunSessions.get(input.runId) ?? null;
    let ownsMaterialized = false;
    if (!materialized) {
      materialized = this.modelBackend === CodexModelBackend.XiaomiMimoTokenPlan
        ? await this.materializeMimoSession({ redactor: input.redactor })
        : await this.materializeChatGptSession({
            session: input.session,
            redactor: input.redactor,
          });
      ownsMaterialized = true;
    }

    try {
      const outputSchemaName =
        input.task?.controls?.outputSchemaName ?? input.task?.outputSchemaName;
      const result = await this.engine.resume({
        runId: input.runId,
        requestId: input.requestId,
        answer: input.answer,
        resumeHandle: input.resumeHandle,
        session: materialized,
        workspacePath: input.workspace.path,
        runner: input.runner,
        redactor: input.redactor,
        model: input.task?.controls?.model ?? this.model,
        reasoningEffort: this.reasoningEffort,
        ...(this.serviceTier === undefined
          ? {}
          : { serviceTier: this.serviceTier }),
        sandboxMode: codexSandboxModeForControls(input.task?.controls),
        outputSchema: this.outputSchemaRequest(outputSchemaName),
        abortSignal: input.abortSignal,
      });
      if (result.status === "waiting_for_input") {
        if (result.runId !== input.runId) {
          this.managedRunSessions.delete(input.runId);
        }
        this.managedRunSessions.set(result.runId, materialized);
        ownsMaterialized = false;
        return {
          status: "waiting_for_input",
          runId: result.runId,
          outputText: result.outputText,
          ...(result.structuredOutput === undefined
            ? {}
            : { structuredOutput: result.structuredOutput }),
          request: result.request,
          resumeHandle: result.resumeHandle,
          telemetry: {
            durationMs: Date.now() - startedAt,
            finishReason: "waiting_for_input",
            ...(result.usage === undefined ? {} : { usage: result.usage }),
          },
          warnings: result.warnings,
        };
      }

      this.managedRunSessions.delete(input.runId);
      ownsMaterialized = true;
      const snapshot = input.session
        ? await snapshotSessionUpdate({
            materialized,
            previousSession: input.session,
            redactor: input.redactor,
          })
        : { warnings: [] as const };
      return {
        status: "completed",
        outputText: result.outputText,
        structuredOutput: result.structuredOutput,
        ...(snapshot.sessionUpdate
          ? { sessionUpdate: snapshot.sessionUpdate }
          : {}),
        telemetry: {
          durationMs: Date.now() - startedAt,
          finishReason: "completed",
          ...(result.usage === undefined ? {} : { usage: result.usage }),
        },
        warnings: [...result.warnings, ...snapshot.warnings],
      };
    } catch (error) {
      this.managedRunSessions.delete(input.runId);
      ownsMaterialized = true;
      const failure = codexExecutionFailure(error, input.redactor);
      return {
        ...failure,
        telemetry: {
          durationMs: Date.now() - startedAt,
          finishReason: finishReasonForFailure(failure.failure.code),
          ...(usageFromError(error)
            ? { usage: usageFromError(error)! }
            : {}),
        },
      };
    } finally {
      if (ownsMaterialized) {
        await materialized.release();
      }
    }
  }

  hasManagedRunSession(runId: string): boolean {
    return this.managedRunSessions.has(runId);
  }

  classifyRunFailure(error: unknown): ProviderFailure {
    return classifyCodexFailure(error);
  }

  async prewarmSession(input: {
    readonly session: SessionArtifact | null;
    readonly redactor: RedactorPort;
    readonly workspacePath?: string;
    readonly runner?: Parameters<AgentDriver["runTask"]>[0]["runner"];
    readonly abortSignal?: AbortSignal;
  }): Promise<CodexSessionPrewarmResult> {
    let mimoMaterialized: CodexMaterializedSession | null = null;
    let sessionPrewarm: CodexSessionPrewarmResult;
    if (this.modelBackend === CodexModelBackend.XiaomiMimoTokenPlan) {
      mimoMaterialized = await this.materializeMimoSession({
        redactor: input.redactor,
      });
      sessionPrewarm = {
        mode: "ephemeral",
        home: mimoMaterialized.home,
        codexHome: mimoMaterialized.codexHome,
        sessionHash: mimoMaterialized.sessionHash ?? "mimo",
        reusable: false,
        warmedAt: new Date(),
      };
    } else {
      sessionPrewarm = this.sessionMaterializer.prewarm
        ? await this.sessionMaterializer.prewarm({
            session: input.session!,
            redactor: input.redactor,
          })
        : await this.prewarmMaterializerFallback({
            session: input.session!,
            redactor: input.redactor,
          });
    }

    if (
      !sessionPrewarm.reusable ||
      !this.engine.prewarm ||
      !input.workspacePath ||
      !input.runner
    ) {
      return sessionPrewarm;
    }

    const materialized = mimoMaterialized ?? await this.materializeChatGptSession({
      session: input.session,
      redactor: input.redactor,
    });
    try {
      const enginePrewarm = await this.engine.prewarm({
        session: materialized,
        workspacePath: input.workspacePath,
        runner: input.runner,
        redactor: input.redactor,
        model: this.model,
        reasoningEffort: this.reasoningEffort,
        ...(this.serviceTier === undefined
          ? {}
          : { serviceTier: this.serviceTier }),
        ...(this.options.warmupPrompt
          ? { warmupPrompt: this.options.warmupPrompt }
          : {}),
        abortSignal: input.abortSignal ?? new AbortController().signal,
      });
      return {
        ...sessionPrewarm,
        engine: {
          kind: enginePrewarm.kind,
          reusable: enginePrewarm.reusable,
        },
        warmedAt: enginePrewarm.warmedAt,
        warnings: enginePrewarm.warnings,
      };
    } finally {
      await materialized.release();
    }
  }

  private async prewarmMaterializerFallback(input: {
    readonly session: SessionArtifact;
    readonly redactor: RedactorPort;
  }): Promise<CodexSessionPrewarmResult> {
    const materialized = await this.sessionMaterializer.materialize(input);
    try {
      return {
        mode: this.sessionMaterializer.mode,
        home: materialized.home,
        codexHome: materialized.codexHome,
        sessionHash: sessionArtifactHash(input.session),
        reusable: false,
        warmedAt: new Date(),
      };
    } finally {
      await materialized.release();
    }
  }

  private async materializeChatGptSession(input: {
    readonly session: SessionArtifact | null;
    readonly redactor: RedactorPort;
  }): Promise<CodexMaterializedSession> {
    if (!input.session) {
      throw new Error("codex_json_agent_driver_missing_session_invariant");
    }
    return this.sessionMaterializer.materialize({
      session: input.session,
      redactor: input.redactor,
    });
  }

  async dispose(): Promise<void> {
    const managedSessions = [...this.managedRunSessions.values()];
    this.managedRunSessions.clear();
    const results = await Promise.allSettled([
      ...managedSessions.map((session) =>
        Promise.resolve().then(() => session.release()),
      ),
      Promise.resolve().then(() => this.engine.dispose?.()),
      Promise.resolve().then(() => this.sessionMaterializer.dispose?.()),
    ]);
    const errors = results
      .filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      )
      .map((result) => result.reason);
    if (errors.length > 0) {
      const error = new AggregateError(
        errors,
        "codex_json_agent_dispose_failed",
      ) as AggregateError & { code: string };
      error.code = "codex_json_agent_dispose_failed";
      throw error;
    }
  }

  private outputSchemaRequest(
    outputSchemaName: string | undefined,
  ): CodexOutputSchemaRequest | undefined {
    if (!outputSchemaName) return undefined;
    const schema = this.outputSchemas[outputSchemaName];
    return {
      name: outputSchemaName,
      ...(schema === undefined ? {} : { schema }),
    };
  }
}

function once<T>(fn: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => {
    pending ??= fn();
    return pending;
  };
}

async function snapshotSessionUpdate(input: {
  readonly materialized: Awaited<
    ReturnType<CodexSessionMaterializer["materialize"]>
  >;
  readonly previousSession: SessionArtifact;
  readonly redactor: RedactorPort;
}): Promise<{
  readonly sessionUpdate?: SessionArtifact;
  readonly warnings: readonly RuntimeWarning[];
}> {
  if (!input.materialized.snapshotSession) {
    return { warnings: [] };
  }

  try {
    const snapshot = await input.materialized.snapshotSession();
    if (!snapshot) {
      return { warnings: [] };
    }
    input.redactor.registerSecret(snapshot.bytes, "codex-session-snapshot");
    if (
      sessionArtifactHash(snapshot) === sessionArtifactHash(input.previousSession)
    ) {
      return { warnings: [] };
    }
    return { sessionUpdate: snapshot, warnings: [] };
  } catch {
    return {
      warnings: [
        {
          code: "codex_session_snapshot_failed",
          safeMessage:
            "Codex session snapshot could not be captured after task execution.",
        },
      ],
    };
  }
}

function readTaskGoalObjective(task: ProviderTask): string | null {
  if (task.execution?.mode === AgentRuntimeExecutionMode.Goal) {
    return task.execution.completionCondition;
  }
  const value = task.metadata?.codexGoalObjective;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function readTaskManagedRunId(task: ProviderTask): string | null {
  const value = task.metadata?.codexManagedRunId ?? task.metadata?.runId;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function finishReasonForFailure(
  code: ProviderFailure["code"],
):
  | "completed"
  | "waiting_for_input"
  | "max_turns"
  | "cancelled"
  | "timeout"
  | "budget_exceeded"
  | "provider_error" {
  if (code === "task_cancelled") return "cancelled";
  if (code === "task_timeout") return "timeout";
  if (code === "goal_slice_exhausted") return "max_turns";
  if (code === "budget_exceeded") return "budget_exceeded";
  return "provider_error";
}
