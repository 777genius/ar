import type { CodexJsonAgentDriverOptions } from "./codex-json-agent-driver-options";
export type { CodexJsonAgentDriverOptions } from "./codex-json-agent-driver-options";
import { HostedMimoProfile } from "./hosted-mimo-profile";
import { HostedMimoCodingProxyOwner, allocateHostedMimoAdmissionHome } from "./hosted-mimo-coding-proxy-material";
import { readTaskGoalObjective, readTaskManagedRunId } from "./codex-task-metadata";
import { snapshotSessionUpdate } from "./codex-session-update-snapshot";
import { SessionExecutionUseDisposition } from "@vioxen/subscription-runtime/core";
import { codexDriverFailure } from "./codex-driver-failure";
import type { HostedMimoCapacityRecoveryProof } from "./hosted-mimo-response-proof";
export type { HostedMimoCapacityRecoveryBinder, HostedMimoCurrentCredentialBinding } from "./hosted-mimo-coding-proxy-material";
export type { HostedMimoCapacityRecoveryProof } from "./hosted-mimo-response-proof";
import { AppServerReturnedEvidence } from "./app-server/application/app-server-returned-evidence";
import { isManagedRunResumeValidationError } from "./app-server/application/app-server-managed-run-mapper";
import { CodexAppServerExecutionEngine, type AppServerExecutionLifetime } from "./codex-app-server-execution-engine";
import { readHostedMimoWorkerOrigin, assertHostedMimoWorkerHomeRetained, assertHostedMimoCodingWorkerHomeRetained, readHostedMimoWorkerProfileOrigin } from "./hosted-mimo-worker-origin";
import { join } from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import {
  assertProviderTaskSystemPrompt,
  type AgentDriver,
  type AgentCapabilities,
  type ManagedRunResumeHandle,
  type ProviderFailure,
  type ProviderLogicalThreadExecution,
  type ProviderTask,
  type ProviderTaskResult,
  type RedactorPort,
  type SessionArtifact,
  type SessionExecutionUse,
  type WorkspaceHandle,
} from "@vioxen/subscription-runtime/core";
import {
  codexJsonAgentCapabilities,
  codexJsonAgentId,
  codexProviderId,
  defaultCodexModel,
} from "./capabilities";
import { classifyCodexFailure, codexFinishReasonForFailure } from "./failure-classifier";
import { createCodexTextDeltaRedactor } from "./codex-text-delta-redactor";
import {
  type CodexExecutionEngine,
  type CodexMaterializedSession,
  type CodexOutputSchemaRequest,
  type CodexReasoningEffort,
  type CodexServiceTier,
  PackagedCodexJsonExecutionEngine,
  codexSandboxModeForControls,
} from "./codex-json-execution-engine";
import {
  CodexEphemeralSessionMaterializer,
  codexJsonHomeConfigToml,
  type CodexSessionMaterializer,
  type CodexSessionPrewarmResult,
  sessionArtifactHash,
} from "./codex-session-materializer";
import { cleanupCodexRuntimeTempRoot } from "./codex-cli-temp-cleanup";
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

export class CodexJsonAgentDriver implements AgentDriver {
  readonly agentId = codexJsonAgentId;
  readonly providerId = codexProviderId;
  readonly capabilities: AgentCapabilities;
  readonly #executionLifetime: AppServerExecutionLifetime | undefined;
  readonly #retainedSessions = new Set<CodexMaterializedSession>();
  readonly #unusedSessions = new Set<CodexMaterializedSession>();
  readonly #pendingReleases = new Map<CodexMaterializedSession, Promise<void>>();
  readonly #materializations = new Set<Promise<CodexMaterializedSession>>();
  readonly #activeRuns = new Set<Promise<ProviderTaskResult>>();
  readonly #codingProxyOwner = new HostedMimoCodingProxyOwner();
  readonly #activeManagedResumes = new Set<string>();
  readonly #managedRunFinalizations = new Map<string,{readonly session:CodexMaterializedSession;result?:Extract<ProviderTaskResult,{status:"failed"}>;pending?:Promise<Extract<ProviderTaskResult,{status:"failed"}>>;completion?:Promise<void>}>();
  readonly #terminalSessions = new Map<SessionExecutionUse,{readonly session:CodexMaterializedSession;readonly previous:SessionArtifact;readonly redactor:RedactorPort;readonly original:Exclude<ProviderTaskResult,{status:"waiting_for_input"}>;result?:Exclude<ProviderTaskResult,{status:"waiting_for_input"}>;pending?:Promise<Exclude<ProviderTaskResult,{status:"waiting_for_input"}>>;released?:true}>();
  #disposed = false;
  #sessionExecutionOutcome: {readonly use:SessionExecutionUse;readonly needsWriteback:boolean}|undefined;
  #resourcesDisposed = false;
  #disposing: Promise<void> | undefined;
  readonly #engine: CodexExecutionEngine;
  readonly #model: string;
  readonly #reasoningEffort: CodexReasoningEffort;
  readonly #serviceTier: CodexServiceTier | undefined;
  readonly #outputSchemas: Readonly<Record<string, unknown>>;
  readonly #sessionMaterializer: CodexSessionMaterializer;
  readonly #modelBackend: CodexModelBackend;
  readonly #mimoApiKeyEnvVarName: string;
  readonly #mimoConfigToml: string | undefined;
  readonly #sourceEnv: Readonly<Record<string, string | undefined>> | undefined;
  readonly #managedRunSessions = new Map<
    string,
    CodexMaterializedSession
  >();

  readonly #options: CodexJsonAgentDriverOptions;
  constructor(options: CodexJsonAgentDriverOptions) {
    this.#options = Object.freeze({ ...options });
    const modelBackend = options.modelBackend ?? CodexModelBackend.OpenAiChatGpt;
    this.#engine =
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
    this.#executionLifetime = options.executionLifetime ??
      (this.#engine instanceof CodexAppServerExecutionEngine ? this.#engine.executionLifetime : undefined);
    if (options.executionLifetime && (!(this.#engine instanceof CodexAppServerExecutionEngine) ||
        this.#engine.executionLifetime !== options.executionLifetime)) throw new Error("codex_driver_lifetime_engine_conflict");
    if (
      modelBackend === CodexModelBackend.XiaomiMimoTokenPlan &&
      this.#engine.modelBackend !== CodexModelBackend.XiaomiMimoTokenPlan
    ) {
      throw new Error("codex_json_mimo_engine_incompatible");
    }
    if (
      this.#engine.modelBackend !== undefined &&
      this.#engine.modelBackend !== modelBackend
    ) {
      throw new Error("codex_json_model_backend_engine_mismatch");
    }
    const engineCapabilities = this.#engine.capabilities;
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
    this.#modelBackend = modelBackend;
    this.#model =
      options.model ?? codexModelBackendDefaultModel(this.#modelBackend, defaultCodexModel);
    this.#reasoningEffort = options.reasoningEffort ?? "low";
    this.#serviceTier = options.serviceTier;
    this.#outputSchemas = options.outputSchemas ?? {};
    this.#sessionMaterializer =
      options.sessionMaterializer ?? new CodexEphemeralSessionMaterializer();
    this.#mimoApiKeyEnvVarName =
      options.mimoApiKeyEnvVarName ?? codexMimoApiKeyEnvVarDefault;
    this.#mimoConfigToml = options.mimoConfigToml;
    this.#sourceEnv = options.sourceEnv;
  }

  /** Readonly provider identity for the existing managed-run recovery contract. */
  get modelBackend(): CodexModelBackend { return this.#modelBackend; }

  capacityRecoveryProof(): HostedMimoCapacityRecoveryProof | undefined {
    return this.#codingProxyOwner.capacityRecoveryProof();
  }

  async runTask(input: Parameters<AgentDriver["runTask"]>[0]): Promise<ProviderTaskResult> {
    const pending = this.#runTaskInvocation(input);
    this.#activeRuns.add(pending);
    try { return await pending; } finally { this.#activeRuns.delete(pending); }
  }

  async #runTaskInvocation(input: {
    readonly sessionExecutionUse?: SessionExecutionUse;
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
    this.#options.assertProviderAdmission?.();
    assertProviderTaskSystemPrompt(input.task.systemPrompt, "task.systemPrompt");

    const startedAt = Date.now();
    if (this.#modelBackend === CodexModelBackend.OpenAiChatGpt && !input.session) {
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
    const priorMimoFailure = this.#codingProxyOwner.latestFailure;
    let engineEntered = false;
    const returned = new AppServerReturnedEvidence();
    const outputAbortController = new AbortController();
    const outputAbortSignal = AbortSignal.any([
      input.abortSignal,
      outputAbortController.signal,
      ...(this.#executionLifetime ? [this.#executionLifetime.signal] : []),
    ]);
    let textDeltaRedactor: ReturnType<typeof createCodexTextDeltaRedactor> | undefined;
    try {
      if (this.#disposed) throw new Error("codex_driver_disposed");
      if (input.sessionExecutionUse && input.task.controls?.model !== undefined && input.task.controls.model !== this.#model) throw new Error("codex_managed_model_mismatch");
      this.#executionLifetime?.enterMaterialization(outputAbortSignal);
      if (input.logicalThread && this.#executionLifetime) throw new Error("child_continuation_denied");
      if (this.#modelBackend === CodexModelBackend.XiaomiMimoTokenPlan) {
        try {
          materialized = await this.#awaitMaterialization(this.#materializeMimoSession({
            redactor: input.redactor,
          }), outputAbortSignal);
        } catch (error) {
          if (error instanceof CodexApiKeyCredentialMissingError) {
            return {
              status: "failed",
              failure: {
                // A missing env key is a local configuration gap, not a dead
                // provider session: provider_session_invalid would disable the
                // shared account capacity record for every later run.
                code: "provider_runtime_unavailable",
                retryable: false,
                reconnectRequired: false,
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
        this.#options.assertProviderAdmission?.();
        materialized = await this.#awaitMaterialization(this.#sessionMaterializer.materialize({
          session: input.session!,
          redactor: input.redactor,
          ...(input.sessionExecutionUse ? { sessionExecutionUse: input.sessionExecutionUse } : {}),
        }), outputAbortSignal);
      }
      this.#executionLifetime?.assertActive(outputAbortSignal);
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
        outputSchema: this.#outputSchemaRequest(outputSchemaName),
        session: materialized,
        workspacePath: input.workspace.path,
        runner: input.runner,
        redactor: input.redactor,
        model: input.task.controls?.model ?? this.#model,
        reasoningEffort: this.#reasoningEffort,
        ...(this.#serviceTier === undefined
          ? {}
          : { serviceTier: this.#serviceTier }),
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
      this.#executionLifetime?.assertActive(outputAbortSignal);
      const started = Promise.resolve(input.onTaskStarted?.());
      if (this.#executionLifetime) await this.#executionLifetime.wait(started, outputAbortSignal); else await started;
      this.#executionLifetime?.assertActive(outputAbortSignal);
      engineEntered = true;
      const logicalThreadResult =
        input.logicalThread === undefined
          ? undefined
          : await this.#runLogicalThread({
              engineInput,
              logicalThread: input.logicalThread,
              returned,
            });
      const result =
        logicalThreadResult === undefined
          ? await this.#engine.run(engineInput)
          : logicalThreadResult;
      returned.capture(result);
      this.#executionLifetime?.assertActive(outputAbortSignal);
      textDeltaRedactor?.flush();
      if (result.status === "waiting_for_input") {
        this.#managedRunSessions.set(result.runId, materialized);
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
            ...(result.nativeWeb === undefined ? {} : { nativeWeb: result.nativeWeb }),
          },
          warnings: result.warnings,
        };
      }
      return await this.#finishTaskSession(materialized,input.session,input.redactor,{
        status:"completed",outputText:result.outputText,structuredOutput:result.structuredOutput,
        telemetry:{durationMs:Date.now()-startedAt,finishReason:"completed",...(result.usage === undefined ? {} : {usage:result.usage}),...(result.nativeWeb === undefined ? {} : {nativeWeb:result.nativeWeb})},warnings:result.warnings,
      },outputAbortSignal);
    } catch (error) {
      error = returned.retain(error);
      textDeltaRedactor?.discard();
      const outputFailure =
        !input.abortSignal.aborted && outputAbortController.signal.aborted
          ? outputAbortController.signal.reason
          : error;
      const failure = codexDriverFailure({ error: outputFailure, evidenceError: error, redactor: input.redactor, startedAt,
        proxyFailure: this.#codingProxyOwner.latestFailure, priorProxyFailure: priorMimoFailure });
      const result = { ...failure, failure: this.#codingProxyOwner.annotateFailure(failure.failure) };
      return materialized?.sessionExecutionUse ? await this.#finishTaskSession(materialized,input.session,input.redactor,result) : result;
    } finally {
      if (materialized) {
        if (materialized.sessionExecutionUse) {
          if (!this.#terminalSessions.has(materialized.sessionExecutionUse) && this.#sessionExecutionOutcome?.use === materialized.sessionExecutionUse) await materialized.release();
        }
        else if (this.#executionLifetime) {
          if (engineEntered) this.#retainedSessions.add(materialized);
          else void this.#releaseUnusedSession(materialized).catch(() => undefined);
        } else await materialized.release();
      }
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
  async #materializeMimoSession(input: {
    readonly redactor: RedactorPort;
  }): Promise<CodexMaterializedSession> {
    this.#executionLifetime?.assertActive();
    const hosted = (this.#sourceEnv ?? process.env).SUBSCRIPTION_RUNTIME_SANDBOX_KIND === "hosted-codex-job";
    if (this.#options.bindMimoCapacityRecoveryCredential && !hosted) throw new Error("hosted_mimo_capacity_recovery_origin_required");
    const credential = hosted ? undefined : loadCodexApiKeyCredential({
          backend: CodexModelBackend.XiaomiMimoTokenPlan,
          envVarName: this.#mimoApiKeyEnvVarName,
          ...(this.#sourceEnv === undefined ? {} : { sourceEnv: this.#sourceEnv }),
          redactor: input.redactor,
        });
    const egressPolicy = codexMimoTokenPlanEgressPolicy();
    const profileOrigin = hosted ? readHostedMimoWorkerProfileOrigin() : null;
    if (this.#options.bindMimoCapacityRecoveryCredential && profileOrigin?.profile !== HostedMimoProfile.CodingV1) {
      throw new Error("hosted_mimo_capacity_recovery_origin_required");
    }
    if (profileOrigin?.profile === HostedMimoProfile.CodingV1 && !this.#executionLifetime) throw new Error("hosted_mimo_coding_lifetime_required");
    const codingMaterial = profileOrigin?.profile === HostedMimoProfile.CodingV1 && this.#executionLifetime
      ? await this.#codingProxyOwner.acquire({ model: this.#model, origin: profileOrigin.origin, envKeyName: this.#mimoApiKeyEnvVarName, lifetime: this.#executionLifetime, redactor: input.redactor,
        ...(this.#options.bindMimoCapacityRecoveryCredential ? { bindCapacityRecoveryCredential: this.#options.bindMimoCapacityRecoveryCredential } : {}),
      }) : null;
    const workerOrigin = profileOrigin?.origin ?? null;
    const tempRoot = await allocateHostedMimoAdmissionHome(workerOrigin, codingMaterial, this.#sourceEnv);
    const home = join(tempRoot, "home");
    const codexHome = join(tempRoot, "codex-home");
    const localSession: CodexMaterializedSession = {
      home, codexHome, env: {},
      release: once(async () => {
        await codingMaterial?.close();
        if (workerOrigin && this.#options.mimoHomeLifecycle) {
          await this.#options.mimoHomeLifecycle.retainHome(codexHome);
          if (codingMaterial) assertHostedMimoCodingWorkerHomeRetained(codingMaterial.origin, codexHome);
          else assertHostedMimoWorkerHomeRetained(codexHome);
          return; // The outside owner reconciles service namespaces and retained storage.
        }
        if (this.#executionLifetime) {
          // Bounded custody ends only after removal succeeds. The ordinary
          // helper may tolerate cleanup failures after scrubbing credentials.
          await rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
        } else {
          try { await cleanupCodexRuntimeTempRoot({ tempRoot, tempCodexHome: codexHome }); }
          catch { /* Ordinary MiMo cleanup remains best-effort. */ }
        }
      }),
    };
    // Until transferred, this continuation owns its unused temporary root.
    try {
      this.#executionLifetime?.assertActive();
      await mkdir(home, { recursive: true, mode: 0o700 });
      this.#executionLifetime?.assertActive();
      await mkdir(codexHome, { recursive: true, mode: 0o700 });
      this.#executionLifetime?.assertActive();
      if (workerOrigin) await this.#options.mimoHomeLifecycle?.prepareHome(codexHome);
      this.#executionLifetime?.assertActive();
      if (!codingMaterial) await writeFile(
        join(codexHome, "config.toml"),
        this.#mimoConfigToml ??
          codexJsonHomeConfigToml({
            modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
            mimoApiKeyEnvVarName: this.#mimoApiKeyEnvVarName,
            providerEgressPolicy: egressPolicy,
          }),
        { mode: 0o600 },
      );
      this.#executionLifetime?.assertActive();
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
        Object.defineProperty(env, this.#mimoApiKeyEnvVarName, {
          enumerable: true,
          get: () => {
            this.#executionLifetime?.assertActive();
            this.#options.assertProviderAdmission?.();
            if (codingMaterial) {
              codingMaterial.assertCurrent();
              return codingMaterial.capability;
            }
            const credential = resolveAuthorizedHostedMimoCredential(input.redactor);
            this.#executionLifetime?.assertActive();
            return credential;
          },
        });
      }
      return {
        ...localSession,
        sessionHash: codingMaterial ? `mimo:coding-start:${codingMaterial.origin.digest}` : credential ? codexApiKeyCredentialIdentity(credential) : "mimo:shared-source",
        env,
        // No snapshotSession: MiMo never refreshes and never updates its
        // credential from a completed run.
      };
    } catch (error) {
      if (this.#executionLifetime) await this.#releaseUnusedSession(localSession);
      else await cleanupCodexRuntimeTempRoot({ tempRoot, tempCodexHome: codexHome });
      throw error;
    }
  }

  async #runLogicalThread(input: {
    readonly engineInput: Parameters<CodexExecutionEngine["run"]>[0];
    readonly logicalThread: ProviderLogicalThreadExecution;
    readonly returned: AppServerReturnedEvidence;
  }) {
    if (!this.#engine.runLogicalThread) {
      throw new Error("codex_logical_thread_unsupported");
    }
    if (input.logicalThread.previousCheckpoint !== undefined) {
      input.engineInput.redactor.registerSecret(
        input.logicalThread.previousCheckpoint,
        "codex-provider-checkpoint",
      );
    }
    const result = await this.#engine.runLogicalThread({
      ...input.engineInput,
      ...(input.logicalThread.previousCheckpoint === undefined
        ? {}
        : { previousCheckpoint: input.logicalThread.previousCheckpoint }),
    });
    input.returned.capture(result);
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
    if (this.#disposed || this.#activeManagedResumes.has(input.runId) || this.#managedRunFinalizations.has(input.runId)) throw new Error("codex_managed_run_finalization_pending");
    this.#activeManagedResumes.add(input.runId);
    try { return await this.#resumeManagedRunInvocation(input); }
    finally { this.#activeManagedResumes.delete(input.runId); }
  }

  async #resumeManagedRunInvocation(input:Parameters<CodexJsonAgentDriver["resumeManagedRun"]>[0]):Promise<ProviderTaskResult> {
    this.#options.assertProviderAdmission?.();
    if (this.#executionLifetime) throw new Error("child_continuation_denied");
    if (!this.#engine.resume) {
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
    let materialized = this.#managedRunSessions.get(input.runId) ?? null;
    let ownsMaterialized = false;
    if (!materialized) {
      materialized = this.#modelBackend === CodexModelBackend.XiaomiMimoTokenPlan
        ? await this.#materializeMimoSession({ redactor: input.redactor })
        : await this.#materializeChatGptSession({
            session: input.session,
            redactor: input.redactor,
          });
      ownsMaterialized = true;
    }

    try {
      if (materialized.sessionExecutionUse && input.task?.controls?.model !== undefined && input.task.controls.model !== this.#model) throw new Error("codex_managed_model_mismatch");
      const outputSchemaName =
        input.task?.controls?.outputSchemaName ?? input.task?.outputSchemaName;
      const result = await this.#engine.resume({
        runId: input.runId,
        requestId: input.requestId,
        answer: input.answer,
        resumeHandle: input.resumeHandle,
        session: materialized,
        workspacePath: input.workspace.path,
        runner: input.runner,
        redactor: input.redactor,
        model: input.task?.controls?.model ?? this.#model,
        reasoningEffort: this.#reasoningEffort,
        ...(this.#serviceTier === undefined
          ? {}
          : { serviceTier: this.#serviceTier }),
        sandboxMode: codexSandboxModeForControls(input.task?.controls),
        outputSchema: this.#outputSchemaRequest(outputSchemaName),
        abortSignal: input.abortSignal,
      });
      if (result.status === "waiting_for_input") {
        if (result.runId !== input.runId) {
          this.#managedRunSessions.delete(input.runId);
        }
        this.#managedRunSessions.set(result.runId, materialized);
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
            ...(result.nativeWeb === undefined ? {} : { nativeWeb: result.nativeWeb }),
          },
          warnings: result.warnings,
        };
      }

      ownsMaterialized = true;
      const terminal = this.#finishTaskSession(materialized,input.session,input.redactor,{
        status:"completed",outputText:result.outputText,structuredOutput:result.structuredOutput,
        telemetry:{durationMs:Date.now()-startedAt,finishReason:"completed",...(result.usage === undefined ? {} : {usage:result.usage}),...(result.nativeWeb === undefined ? {} : {nativeWeb:result.nativeWeb})},warnings:result.warnings,
      });
      this.#managedRunSessions.delete(input.runId); return await terminal;
    } catch (error) {
      const result = codexDriverFailure({ error, evidenceError: error, redactor: input.redactor, startedAt });
      // A resume validation error means the run was never claimed: a retained
      // session still belongs to the run's next legitimate resume and must
      // survive the stale retry. The caller sees a failed result while
      // hasManagedRunSession(runId) stays true: nothing here is terminal.
      if (isManagedRunResumeValidationError(error) && this.#managedRunSessions.get(input.runId) === materialized) {
        return result;
      }
      ownsMaterialized = true;
      const terminal = materialized.sessionExecutionUse ? this.#finishTaskSession(materialized,input.session,input.redactor,result) : Promise.resolve(result);
      this.#managedRunSessions.delete(input.runId); return await terminal;
    } finally {
      if (ownsMaterialized) {
        if (!materialized.sessionExecutionUse) await materialized.release();
      }
    }
  }

  async #finishTaskSession(session:CodexMaterializedSession,previous:SessionArtifact|null,redactor:RedactorPort,result:Exclude<ProviderTaskResult,{status:"waiting_for_input"}>,abortSignal?:AbortSignal):Promise<Exclude<ProviderTaskResult,{status:"waiting_for_input"}>> {
    const use = session.sessionExecutionUse;
    if (!use) {
      const pending:Promise<Awaited<ReturnType<typeof snapshotSessionUpdate>>> = previous ? snapshotSessionUpdate({materialized:session,previousSession:previous,redactor,...(this.#executionLifetime ? {executionLifetime:this.#executionLifetime} : {})}) : Promise.resolve({captured:false,warnings:[]});
      const snapshot = this.#executionLifetime ? await this.#executionLifetime.wait(pending,abortSignal) : await pending;
      this.#executionLifetime?.assertActive(abortSignal);
      return {...result,...("sessionUpdate" in snapshot && snapshot.sessionUpdate ? {sessionUpdate:snapshot.sessionUpdate} : {}),warnings:[...result.warnings,...snapshot.warnings]};
    }
    if (!previous || this.#terminalSessions.has(use)) throw new Error("codex_terminal_session_changed");
    const original = Object.freeze({...result,...(result.status === "failed" ? {failure:Object.freeze({...result.failure,...(result.failure.details ? {details:Object.freeze({...result.failure.details})} : {})})} : {}),warnings:Object.freeze(result.warnings.map(warning => Object.freeze({...warning})))});
    this.#terminalSessions.set(use,{session,previous,redactor,original});
    try { return await this.finalizeTaskSession(use); }
    catch { return {...original,warnings:[...original.warnings,{code:"codex_session_finalization_pending",safeMessage:"Original task session finalization remains pending."}]}; }
  }

  async finalizeTaskSession(use:SessionExecutionUse):Promise<Exclude<ProviderTaskResult,{status:"waiting_for_input"}>> {
    const held = this.#terminalSessions.get(use);
    if (!held || held.session.sessionExecutionUse !== use) throw new Error("codex_terminal_session_missing");
    if (held.pending) return await held.pending;
    const pending = (async () => {
      if (!held.result) {
        const snapshot = await snapshotSessionUpdate({materialized:held.session,previousSession:held.previous,redactor:held.redactor});
        if (!snapshot.captured) throw new Error("codex_session_finalization_unresolved");
        held.result = Object.freeze({...held.original,...(snapshot.sessionUpdate ? {sessionUpdate:snapshot.sessionUpdate} : {}),warnings:[...held.original.warnings,...snapshot.warnings]});
        this.#sessionExecutionOutcome = {use,needsWriteback:!!snapshot.sessionUpdate};
      }
      if (!held.released) { await held.session.release(); held.released = true; }
      if (this.#terminalSessions.get(use) !== held) throw new Error("codex_terminal_session_changed");
      return held.result;
    })();
    held.pending = pending;
    try { return await pending; } finally { if (held.pending === pending) delete held.pending; }
  }

  async retireTaskSession(use:SessionExecutionUse):Promise<void> {
    const held = this.#terminalSessions.get(use);
    if (!held?.result || !held.released || held.pending) throw new Error("codex_session_finalization_pending");
    if (await use.complete() !== SessionExecutionUseDisposition.Discharged) throw new Error("codex_session_finalization_pending");
    if (this.#terminalSessions.get(use) !== held) throw new Error("codex_terminal_session_changed");
    this.#terminalSessions.delete(use);
  }

  retainedManagedRunIds():readonly string[] {
    if (this.#activeRuns.size || this.#activeManagedResumes.size) throw new Error("codex_driver_execution_pending");
    return [...new Set([...this.#managedRunSessions].filter(([,session]) => session.sessionExecutionUse).map(([runId]) => runId).concat([...this.#managedRunFinalizations.keys()]))];
  }

  /** Ends only an original private retained entry; never enters the execution engine. */
  async cancelManagedRun(input:{readonly runId:string;readonly session:SessionArtifact|null;readonly redactor:RedactorPort}):Promise<Extract<ProviderTaskResult,{status:"failed"}>> {
    const {runId,session,redactor} = input;
    if (this.#activeManagedResumes.has(runId) || this.#activeRuns.size) throw new Error("codex_driver_execution_pending");
    let held = this.#managedRunFinalizations.get(runId);
    if (!held) {
      const materialized = this.#managedRunSessions.get(runId);
      if (!materialized?.sessionExecutionUse) throw new Error("codex_managed_run_session_missing");
      held = {session:materialized}; this.#managedRunFinalizations.set(runId,held); this.#managedRunSessions.delete(runId);
    }
    if (held.result) return held.result;
    if (held.pending) return await held.pending;
    const original = held;
    const pending = (async () => {
      const materialized = original.session;
      if (materialized.sessionExecutionUse && (!session || materialized.sessionHash !== sessionArtifactHash(session))) throw new Error("codex_managed_run_session_mismatch");
      const snapshot = session ? await snapshotSessionUpdate({materialized,previousSession:session,redactor}) : {captured:false,warnings:[]};
      if (materialized.sessionExecutionUse && !snapshot.captured) throw new Error("codex_session_finalization_unresolved");
      if (materialized.sessionExecutionUse) this.#sessionExecutionOutcome = {use:materialized.sessionExecutionUse,needsWriteback:!!snapshot.sessionUpdate};
      await materialized.release();
      if (this.#managedRunFinalizations.get(runId) !== original) throw new Error("codex_managed_run_finalization_changed");
      const result:Extract<ProviderTaskResult,{status:"failed"}> = {status:"failed",failure:{code:"task_cancelled",retryable:false,reconnectRequired:false,safeMessage:"Managed Codex run was cancelled."},
        ...("sessionUpdate" in snapshot && snapshot.sessionUpdate ? {sessionUpdate:snapshot.sessionUpdate} : {}),warnings:snapshot.warnings};
      original.result = result; return result;
    })();
    original.pending = pending;
    try { return await pending; } finally { if (original.pending === pending) delete original.pending; }
  }

  async completeManagedRunCancellation(runId:string):Promise<void> {
    const held = this.#managedRunFinalizations.get(runId);
    if (!held?.result || held.pending) throw new Error("codex_managed_run_finalization_pending");
    if (held.completion) return await held.completion;
    const pending = (async () => { await held.session.sessionExecutionUse?.complete();
      if (this.#managedRunFinalizations.get(runId) !== held) throw new Error("codex_managed_run_finalization_changed");
      this.#managedRunFinalizations.delete(runId); })();
    held.completion = pending;
    try { await pending; } finally { if (held.completion === pending) delete held.completion; }
  }

  sessionExecutionNeedsWriteback(use:SessionExecutionUse):boolean|undefined {
    return this.#sessionExecutionOutcome?.use === use ? this.#sessionExecutionOutcome.needsWriteback : undefined;
  }
  retainedSessionExecutionUse(runId: string): SessionExecutionUse | undefined {
    return this.#managedRunSessions.get(runId)?.sessionExecutionUse;
  }
  retainsSessionExecutionUse(use: SessionExecutionUse): boolean {
    return [...this.#managedRunSessions.values()].some(session => session.sessionExecutionUse === use);
  }

  hasManagedRunSession(runId: string): boolean {
    return this.#managedRunSessions.has(runId);
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
    this.#options.assertProviderAdmission?.();
    if (this.#executionLifetime) throw new Error("child_prewarm_denied");
    let mimoMaterialized: CodexMaterializedSession | null = null;
    let sessionPrewarm: CodexSessionPrewarmResult;
    if (this.#modelBackend === CodexModelBackend.XiaomiMimoTokenPlan) {
      mimoMaterialized = await this.#materializeMimoSession({
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
      sessionPrewarm = this.#sessionMaterializer.prewarm
        ? await this.#sessionMaterializer.prewarm({
            session: input.session!,
            redactor: input.redactor,
          })
        : await this.#prewarmMaterializerFallback({
            session: input.session!,
            redactor: input.redactor,
          });
    }

    if (
      !sessionPrewarm.reusable ||
      !this.#engine.prewarm ||
      !input.workspacePath ||
      !input.runner
    ) {
      return sessionPrewarm;
    }

    const materialized = mimoMaterialized ?? await this.#materializeChatGptSession({
      session: input.session,
      redactor: input.redactor,
    });
    try {
      const enginePrewarm = await this.#engine.prewarm({
        session: materialized,
        workspacePath: input.workspacePath,
        runner: input.runner,
        redactor: input.redactor,
        model: this.#model,
        reasoningEffort: this.#reasoningEffort,
        ...(this.#serviceTier === undefined
          ? {}
          : { serviceTier: this.#serviceTier }),
        ...(this.#options.warmupPrompt
          ? { warmupPrompt: this.#options.warmupPrompt }
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

  async #prewarmMaterializerFallback(input: {
    readonly session: SessionArtifact;
    readonly redactor: RedactorPort;
  }): Promise<CodexSessionPrewarmResult> {
    this.#options.assertProviderAdmission?.();
    const materialized = await this.#sessionMaterializer.materialize(input);
    try {
      return {
        mode: this.#sessionMaterializer.mode,
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

  async #materializeChatGptSession(input: {
    readonly session: SessionArtifact | null;
    readonly redactor: RedactorPort;
  }): Promise<CodexMaterializedSession> {
    this.#options.assertProviderAdmission?.();
    if (!input.session) {
      throw new Error("codex_json_agent_driver_missing_session_invariant");
    }
    return this.#sessionMaterializer.materialize({
      session: input.session,
      redactor: input.redactor,
    });
  }

  async #awaitMaterialization(pending: Promise<CodexMaterializedSession>, signal: AbortSignal): Promise<CodexMaterializedSession> {
    if (!this.#executionLifetime) return await pending;
    this.#materializations.add(pending);
    let resolved: CodexMaterializedSession | undefined;
    const observed = pending.then(async session => {
      resolved = session;
      if (signal.aborted || this.#executionLifetime!.signal.aborted || this.#disposed) {
        try { await this.#releaseUnusedSession(session); } catch { /* retain for disposal */ }
      }
      return session;
    });
    void observed.finally(() => this.#materializations.delete(pending)).catch(() => undefined);
    try { return await this.#executionLifetime.wait(observed, signal); }
    catch (error) {
      if (resolved) void this.#releaseUnusedSession(resolved).catch(() => undefined);
      throw error;
    }
  }

  #releaseUnusedSession(session: CodexMaterializedSession): Promise<void> {
    const existing = this.#pendingReleases.get(session);
    if (existing) return existing;
    this.#retainedSessions.add(session);
    this.#unusedSessions.add(session);
    const pending = Promise.resolve().then(() => session.release()).then(() => {
      this.#retainedSessions.delete(session);
      this.#unusedSessions.delete(session);
    });
    this.#pendingReleases.set(session, pending);
    void pending.finally(() => this.#pendingReleases.delete(session)).catch(() => undefined);
    return pending;
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#codingProxyOwner.revoke();
    this.#executionLifetime?.close();
    if (this.#executionLifetime && this.#resourcesDisposed) return;
    if (this.#disposing) return await this.#disposing;
    const pending = this.#disposeResources();
    this.#disposing = pending;
    try { await pending; } finally { if (this.#disposing === pending) this.#disposing = undefined; }
  }

  async #disposeResources(): Promise<void> {
    if (this.#terminalSessions.size || this.#managedRunFinalizations.size || [...this.#managedRunSessions.values(),...this.#retainedSessions].some(session => session.sessionExecutionUse)) throw new Error("codex_driver_owned_finalization_pending");
    if (!this.#executionLifetime) return await this.#disposeOrdinary();
    // The engine owns startup flights and failed process cleanup. Never erase
    // their configuration/home before its disposal succeeds.
    await this.#codingProxyOwner.close();
    await this.#engine.dispose?.();
    if (this.#materializations.size || this.#pendingReleases.size || (this.#executionLifetime && this.#activeRuns.size)) throw new Error("codex_driver_materialization_pending");
    if (!(this.#modelBackend === CodexModelBackend.XiaomiMimoTokenPlan && this.#options.mimoHomeLifecycle && (this.#codingProxyOwner.retained || readHostedMimoWorkerOrigin())) &&
        this.#executionLifetime && (!this.#executionLifetime.childBudget ||
        (this.#sourceEnv ?? process.env).SUBSCRIPTION_RUNTIME_SANDBOX_KIND === "hosted-codex-job") &&
        ([...this.#retainedSessions].some(session => !this.#unusedSessions.has(session)) || this.#managedRunSessions.size)) {
      // This slice has no accepted controller cleanup binding. Local transport
      // disposal supplies no scoped proof, so these resources stay owned.
      throw new Error("codex_driver_hosted_cleanup_unresolved");
    }
    for (const session of new Set([...this.#retainedSessions, ...this.#managedRunSessions.values()])) {
      await session.release();
      this.#retainedSessions.delete(session);
      this.#unusedSessions.delete(session);
      for (const [key, value] of this.#managedRunSessions) if (value === session) this.#managedRunSessions.delete(key);

    }
    await this.#sessionMaterializer.dispose?.();
    this.#resourcesDisposed = true;
  }

  async #disposeOrdinary(): Promise<void> {
    const managedSessions = [...this.#managedRunSessions.values()];
    this.#managedRunSessions.clear();
    const results = await Promise.allSettled([
      ...managedSessions.map((session) =>
        Promise.resolve().then(() => session.release()),
      ),
      Promise.resolve().then(() => this.#engine.dispose?.()),
      Promise.resolve().then(() => this.#sessionMaterializer.dispose?.()),
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

  #outputSchemaRequest(
    outputSchemaName: string | undefined,
  ): CodexOutputSchemaRequest | undefined {
    if (!outputSchemaName) return undefined;
    const schema = this.#outputSchemas[outputSchemaName];
    return {
      name: outputSchemaName,
      ...(schema === undefined ? {} : { schema }),
    };
  }
}

Object.freeze(CodexJsonAgentDriver);
Object.freeze(CodexJsonAgentDriver.prototype);

function once<T>(fn: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => {
    pending ??= fn().catch(error => { pending = undefined; throw error; });
    return pending;
  };
}
