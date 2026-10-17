import { AppServerSessionCleanupError, AppServerSessionCleanupPhase } from "./app-server/application/app-server-session-cleanup-error";
import { AppServerExecutionLifetime, bindAppServerSessionLifetime } from "./app-server/application/app-server-child-lifetime";
export { AppServerExecutionLifetime, AppServerExecutionReadiness, type AppServerExecutionBinding, type AppServerExecutionReadyEvent } from "./app-server/application/app-server-child-lifetime";
import { parseAppServerOutputWithUsage } from "./app-server/application/app-server-structured-output";
import { isAppServerAdmissionError } from "./app-server/application/app-server-admission";
import { assertHostedAppServerEngineOptions } from "./codex-app-server-hosted-admission";
import { AppServerReturnedEvidence } from "./app-server/application/app-server-returned-evidence";
import type {
  ManagedRunResumeHandle,
  ManagedRunStorePort,
  RedactorPort,
  RunnerPort,
} from "@vioxen/subscription-runtime/core";
import type { ResolvedCodexExecutionProfile } from "./codex-execution-profile";
import { resolveCodexExecutionProfile } from "./codex-execution-profile";
import type {
  CodexExecutionEngine,
  CodexExecutionInput,
  CodexLogicalThreadExecutionResult,
  CodexExecutionPrewarmResult,
  CodexExecutionResult,
  CodexMaterializedSession,
  CodexReasoningEffort,
  CodexSandboxMode,
  CodexServiceTier,
} from "./codex-json-execution-engine";
import { prepareCodexOutputSchemaPlan } from "./codex-json-execution-engine";
import type { CodexStructuredOutputSchemaPlan } from "./codex-structured-output-schema";
import { InMemoryManagedRunStore } from "./codex-app-server-managed-run-store";
import type {
  CodexAppServerChildProcess,
  CodexAppServerProcessFactory,
} from "./app-server/application/app-server-process-port";
import {
  signalCodexAppServerChildGroup,
  spawnCodexAppServerProcess,
} from "./app-server/adapters/node-app-server-process";
import type {
  CodexAppServerCommandApprovalDecision,
  CodexAppServerCommandApprovalInput,
  CodexAppServerCommandApprovalPolicy,
  CodexAppServerNativeToolSurface,
} from "./app-server/domain/app-server-types";
import { codexAppServerRolloutBudgetConfig, type CodexAppServerRolloutBudget } from "./app-server/domain/app-server-rollout-budget";
import {
  defaultGoalContinuePrompt,
  defaultMaxGoalTurns,
  defaultMaxOutputBytes,
  defaultTimeoutMs,
  type AppServerRunResult,
  type AppServerWarning,
} from "./app-server/domain/app-server-types";
import {
  appServerOutputSchemaNotNativeWarning,
  assertOutputWithinBounds,
  assertPositiveInteger,
  isAbortLikeError,
  isCodexAppServerBudgetExceededError,
} from "./app-server/domain/app-server-errors";
import {
  appServerFallbackIsSafe,
  redactFallbackAppServerResult,
} from "./app-server/application/app-server-fallback-policy";
import { redactCompletedAppServerResult } from "./app-server/application/app-server-result-redactor";
import { redactBoundedAppServerWarnings } from "./app-server/application/app-server-warning-collector";
import {
  assertManagedRunCanResume,
  isManagedRunResumeValidationError,
} from "./app-server/application/app-server-managed-run-mapper";
import {
  AppServerSlotPool,
  AppServerSlotAcquireAbortedError,
} from "./app-server/application/app-server-slot-pool";
import { runCodexAppServerLogicalThreadWithSlot } from "./app-server/application/app-server-logical-thread-slot-lifecycle";
import { isCodexModelUnavailableError } from "./app-server/domain/model-catalog";
import {
  isCodexAppServerRateLimitsRejectedError,
  type CodexAppServerRateLimitsSnapshotHandler,
} from "./app-server/application/app-server-rate-limits-monitor";
import { appServerEngineCapabilities, appServerWireOutputSchema, resolveAppServerEngineLifetime, type CodexAppServerExecutionEngineOptions } from "./codex-app-server-execution-engine-options";
import { CodexModelBackend } from "./codex-model-backend";
import { codexProviderEgressPolicy } from "./codex-provider-egress-policy";
export type {
  CodexAppServerChildProcess,
  CodexAppServerProcessFactory,
};
export type {
  CodexAppServerCommandApprovalDecision,
  CodexAppServerCommandApprovalInput,
  CodexAppServerCommandApprovalPolicy,
  CodexAppServerNativeToolSurface,
  CodexAppServerRolloutBudget,
  CodexAppServerRateLimitsSnapshotHandler,
};
export type { CodexAppServerExecutionEngineOptions };
export type { AppServerCompletedTurnCheckpoint } from "./app-server/application/app-server-turn-checkpoint";
export class CodexAppServerExecutionEngine implements CodexExecutionEngine {
  readonly kind: "app-server-pool" | "app-server-goal";
  readonly capabilities: CodexExecutionEngine["capabilities"];
  readonly modelBackend: CodexModelBackend;

  readonly executionLifetime: AppServerExecutionLifetime | undefined;
  private readonly executionProfile: ResolvedCodexExecutionProfile;
  private readonly runStore: ManagedRunStorePort;
  private readonly slotPool: AppServerSlotPool;
  constructor(private readonly options: CodexAppServerExecutionEngineOptions) {
    const captured = { ...options };
    this.options = { ...captured, ...(captured.providerEgressPolicy ? {
      providerEgressPolicy: codexProviderEgressPolicy(captured.providerEgressPolicy.profileId),
    } : {}) };
    options = this.options;
    this.executionLifetime = resolveAppServerEngineLifetime(options);
    this.modelBackend = options.modelBackend ?? CodexModelBackend.OpenAiChatGpt;
    if (!options.codexBinaryPath.trim()) {
      throw new Error("codex_app_server_binary_required");
    }
    assertHostedAppServerEngineOptions(options);
    assertPositiveInteger(options.timeoutMs, "codex_app_server_timeout_invalid");
    assertPositiveInteger(
      options.startupTimeoutMs,
      "codex_app_server_startup_timeout_invalid",
    );
    codexAppServerRolloutBudgetConfig(options.rolloutBudget);
    this.capabilities = appServerEngineCapabilities(options);
    if (options.childBudget && (!options.goalMode || options.nativeToolSurface !== "disabled" ||
        options.cleanThreadPrewarm !== false || options.fallback !== undefined || options.hostedControllerTools !== undefined ||
        options.maxGoalTurns !== options.childBudget.lifetime.maxGoalTurns)) throw new Error("child_engine_confinement_conflict");
    this.kind = options.goalMode ? "app-server-goal" : "app-server-pool";
    this.executionProfile = resolveCodexExecutionProfile(
      options.executionProfile,
    );
    this.runStore = options.runStore ?? new InMemoryManagedRunStore();
    this.slotPool = new AppServerSlotPool({
      ...(options.childBudget ? { childBudget: options.childBudget } : {}),
      codexBinaryPath: options.codexBinaryPath,
      ...(options.sourceEnv === undefined ? {} : { sourceEnv: options.sourceEnv }),
      ...(this.options.providerEgressPolicy ? { providerEgressPolicy: this.options.providerEgressPolicy } : {}),
      ...(options.publicSourceReader ? { publicSourceReader: options.publicSourceReader } : {}),
      ...(options.hostedPermissionProfiles === undefined ? {} : { hostedPermissionProfiles: options.hostedPermissionProfiles }),
      processFactory: options.processFactory ?? spawnCodexAppServerProcess,
      signalChildProcess: signalCodexAppServerChildGroup,
      runStore: this.runStore,
      ...(options.completedTurnCheckpoint ? { completedTurnCheckpoint: options.completedTurnCheckpoint } : {}),
      executionProfile: this.executionProfile,
      ...(options.commandApprovalPolicy === undefined
        ? {}
        : { commandApprovalPolicy: options.commandApprovalPolicy }),
      ...(options.hostedCodingAuthority === undefined ? {} : { hostedCodingAuthority: options.hostedCodingAuthority }),
      ...(options.nativeToolSurface === undefined
        ? {}
        : { nativeToolSurface: options.nativeToolSurface }),
      ...(options.nativeGoalControls === undefined ? {} : { nativeGoalControls: options.nativeGoalControls }),
      ...(options.hostedControllerTools ? { hostedControllerTools: options.hostedControllerTools } : {}),
      ...(options.rolloutBudget === undefined
        ? {}
        : { rolloutBudget: options.rolloutBudget }),
      ...(options.bypassHookTrust === undefined ? {} : { bypassHookTrust: options.bypassHookTrust }),
      ...(options.rateLimitsSnapshotHandler === undefined
        ? {}
        : {
            rateLimitsSnapshotHandler: options.rateLimitsSnapshotHandler,
          }),
      cleanThreadPrewarm: options.cleanThreadPrewarm ?? true,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.startupTimeoutMs === undefined
        ? {}
        : { startupTimeoutMs: options.startupTimeoutMs }),
      ...(options.reconnectGraceMs === undefined
        ? {}
        : { reconnectGraceMs: options.reconnectGraceMs }),
      maxOutputBytes: this.maxOutputBytes(),
      ...(options.modelBackend === undefined
        ? {}
        : { modelBackend: options.modelBackend }),
    });
  }
  async run(input: CodexExecutionInput): Promise<CodexExecutionResult> {
    this.options.childBudget?.beginInvocation();
    const returned = new AppServerReturnedEvidence();
    const pending = this.runInvocation(input, returned);
    try { return this.executionLifetime ? await this.executionLifetime.wait(pending, input.abortSignal) : await pending; }
    catch (error) { throw returned.retain(error); }
  }

  private async runInvocation(input: CodexExecutionInput, returned: AppServerReturnedEvidence): Promise<CodexExecutionResult> {
    this.executionLifetime?.beginInvocation(input.abortSignal);
    const lifetime = this.executionLifetime;
    if (lifetime) input = { ...input, session: bindAppServerSessionLifetime(input.session, lifetime),
      abortSignal: AbortSignal.any([input.abortSignal, lifetime.signal]) };
    const schemaPlan = input.outputSchemaPlan ?? prepareCodexOutputSchemaPlan(input.outputSchema);
    try {
      const result = await this.runViaAppServer(input, schemaPlan, returned);
      returned.capture(result);
      this.executionLifetime?.assertActive(input.abortSignal);
      if (result.status === "waiting_for_input") return result;
      const parsed = await parseAppServerOutputWithUsage({ result, requested: Boolean(input.outputSchema), ...(schemaPlan ? { schemaPlan } : {}), goalMode: this.options.goalMode, ...(input.runId ? { runId: input.runId } : {}), runStore: this.runStore });
      this.executionLifetime?.assertActive(input.abortSignal);
      this.options.childBudget?.remainingMs();
      return parsed;
    } catch (error) {
      error = returned.retain(error);
      if (error instanceof AppServerSlotAcquireAbortedError || isAppServerAdmissionError(error)) throw error;
      this.executionLifetime?.close(error);
      await this.disposeFailedSession(input.session, error, AppServerSessionCleanupPhase.Run);
      if (input.abortSignal.aborted || isAbortLikeError(error)) throw error;
      if (isCodexAppServerBudgetExceededError(error)) throw error;
      if (isCodexAppServerRateLimitsRejectedError(error)) throw error;
      if (isCodexModelUnavailableError(error)) throw error;
      if (
        !this.options.fallback ||
        !appServerFallbackIsSafe(error)
      ) {
        throw error;
      }
      const fallbackResult = await this.options.fallback.run({
        ...input,
        ...(schemaPlan === undefined ? {} : { outputSchemaPlan: schemaPlan }),
      });
      return redactFallbackAppServerResult({
        error,
        result: fallbackResult,
        redactor: input.redactor,
      });
    }
  }
  async runLogicalThread(
    input: CodexExecutionInput & {
      readonly previousCheckpoint?: string;
    },
  ): Promise<CodexLogicalThreadExecutionResult> {
    if (this.executionLifetime) throw new Error("child_continuation_denied");
    return await runCodexAppServerLogicalThreadWithSlot(input, {
      goalMode: this.options.goalMode ?? false,
      timeoutMs: this.options.timeoutMs ?? defaultTimeoutMs,
      maxGoalTurns: this.options.maxGoalTurns ?? defaultMaxGoalTurns,
      goalContinuePrompt:
        this.options.goalContinuePrompt ?? defaultGoalContinuePrompt,
      ensureSlot: (slotInput) => this.slotPool.ensureSlot(slotInput),
      disposeSessionSlot: (session) => this.slotPool.disposeSessionSlot(session),
      redact: (result, schemaWarnings) =>
        redactCompletedAppServerResult({
          result,
          schemaWarnings,
          redactor: input.redactor,
          maxOutputBytes: this.maxOutputBytes(),
        }),
      parse: async (result, parseInput, schemaPlan) =>
        await parseAppServerOutputWithUsage({ result, requested: Boolean(parseInput.outputSchema), ...(schemaPlan ? { schemaPlan } : {}), goalMode: this.options.goalMode, ...(parseInput.runId ? { runId: parseInput.runId } : {}), runStore: this.runStore }),
    });
  }
  async resume(input: {
    readonly runId: string;
    readonly requestId: string;
    readonly answer: string;
    readonly resumeHandle: ManagedRunResumeHandle;
    readonly session: CodexMaterializedSession;
    readonly workspacePath: string;
    readonly runner: RunnerPort;
    readonly redactor: RedactorPort;
    readonly model: string;
    readonly reasoningEffort: CodexReasoningEffort;
    readonly serviceTier?: CodexServiceTier;
    readonly sandboxMode?: CodexSandboxMode;
    readonly outputSchema?: unknown;
    readonly abortSignal: AbortSignal;
  }): Promise<CodexExecutionResult> {
    if (this.executionLifetime) throw new Error("child_continuation_denied");
    const schemaPlan = prepareCodexOutputSchemaPlan(input.outputSchema);
    try {
      const result = await this.resumeViaAppServer(input, schemaPlan);
      if (result.status === "waiting_for_input") return result;
      return await parseAppServerOutputWithUsage({ result, requested: Boolean(input.outputSchema), ...(schemaPlan ? { schemaPlan } : {}), goalMode: this.options.goalMode, ...(input.runId ? { runId: input.runId } : {}), runStore: this.runStore });
    } catch (error) {
      if (error instanceof AppServerSlotAcquireAbortedError || isAppServerAdmissionError(error)) throw error;
      if (!isManagedRunResumeValidationError(error)) {
        await this.disposeFailedSession(input.session, error, AppServerSessionCleanupPhase.Resume);
      }
      throw error;
    }
  }

  async dispose(): Promise<void> {
    this.executionLifetime?.close();
    await this.slotPool.dispose();
    await this.options.fallback?.dispose?.();
  }
  async prewarm(input: {
    readonly session: CodexMaterializedSession;
    readonly workspacePath: string;
    readonly runner: RunnerPort;
    readonly redactor: RedactorPort;
    readonly model: string;
    readonly reasoningEffort: CodexReasoningEffort;
    readonly serviceTier?: CodexServiceTier;
    readonly warmupPrompt?: string;
    readonly abortSignal: AbortSignal;
  }): Promise<CodexExecutionPrewarmResult> {
    if (this.executionLifetime) throw new Error("child_prewarm_denied");
    try {
      const slot = await this.slotPool.ensureSlot(input);
      const warmupPrompt = input.warmupPrompt?.trim();
      const warnings: AppServerWarning[] = [];
      if (warmupPrompt) {
        const result = await slot.turnRunner.runCleanTurn({
          prompt: warmupPrompt,
          workspacePath: input.workspacePath,
          model: input.model,
          reasoningEffort: input.reasoningEffort,
          ...(input.serviceTier === undefined
            ? {}
            : { serviceTier: input.serviceTier }),
          sandboxMode: "read-only",
          timeoutMs: this.options.timeoutMs ?? defaultTimeoutMs,
          abortSignal: input.abortSignal,
          prepareNext: false,
        });
        const outputText = input.redactor.redact(result.outputText);
        input.redactor.assertNoKnownSecret(
          outputText,
          "codex-app-server-prewarm-output",
        );
        assertOutputWithinBounds(outputText, this.maxOutputBytes());
        warnings.push(...result.warnings);
      }

      warnings.push(
        ...(await slot.turnRunner.prewarmCleanThread({
          workspacePath: input.workspacePath,
          model: input.model,
          reasoningEffort: input.reasoningEffort,
          ...(input.serviceTier === undefined
            ? {}
            : { serviceTier: input.serviceTier }),
          timeoutMs: this.options.timeoutMs ?? defaultTimeoutMs,
          abortSignal: input.abortSignal,
        })),
      );
      return {
        kind: this.kind,
        reusable: true,
        warmedAt: new Date(),
        warnings: redactBoundedAppServerWarnings({
          warnings,
          redactor: input.redactor,
          context: "codex-app-server-prewarm-warning",
        }),
      };
    } catch (error) {
      if (error instanceof AppServerSlotAcquireAbortedError || isAppServerAdmissionError(error)) throw error;
      await this.disposeFailedSession(input.session, error, AppServerSessionCleanupPhase.Prewarm);
      throw error;
    }
  }

  private async disposeFailedSession(session: CodexMaterializedSession, error: unknown, phase: AppServerSessionCleanupPhase): Promise<void> {
    try { await this.slotPool.disposeSessionSlot(session); }
    catch (cleanupError) { throw new AppServerSessionCleanupError(error, cleanupError, phase); }
  }
  private async runViaAppServer(input: CodexExecutionInput,
    schemaPlan: CodexStructuredOutputSchemaPlan | undefined, returned: AppServerReturnedEvidence): Promise<CodexExecutionResult> {
    this.options.childBudget?.remainingMs();
    const slot = await this.slotPool.ensureSlot(input);
    this.executionLifetime?.assertActive(input.abortSignal);
    const outputSchema = appServerWireOutputSchema(this.options, schemaPlan?.codexSchema);
    const schemaWarnings = input.outputSchema && outputSchema === undefined
      ? [appServerOutputSchemaNotNativeWarning()]
      : [];
    const common = {
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
      prompt: input.prompt,
      ...(input.goalObjective !== undefined
        ? { goalObjective: input.goalObjective }
        : {}),
      ...(input.systemPrompt !== undefined
        ? { systemPrompt: input.systemPrompt }
        : {}),
      workspacePath: input.workspacePath,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      ...(input.serviceTier === undefined
        ? {}
        : { serviceTier: input.serviceTier }),
      sandboxMode: input.sandboxMode ?? "read-only",
      ...(outputSchema === undefined ? {} : { outputSchema }),
      timeoutMs: this.options.timeoutMs ?? defaultTimeoutMs,
      abortSignal: input.abortSignal,
      ...(input.onTextDelta === undefined
        ? {}
        : { onTextDelta: input.onTextDelta }),
    };
    const result = this.options.goalMode
      ? await slot.goalRunner.runGoal({
          ...common,
          redactor: input.redactor,
          maxGoalTurns: this.options.maxGoalTurns ?? defaultMaxGoalTurns,
          goalContinuePrompt:
            this.options.goalContinuePrompt ?? defaultGoalContinuePrompt,
        })
      : await slot.turnRunner.runCleanTurn(common);
    returned.capture(result);
    this.executionLifetime?.assertActive(input.abortSignal);
    return redactCompletedAppServerResult({
      result,
      schemaWarnings,
      redactor: input.redactor,
      maxOutputBytes: this.maxOutputBytes(),
    });
  }

  private async resumeViaAppServer(input: {
    readonly runId: string;
    readonly requestId: string;
    readonly answer: string;
    readonly resumeHandle: ManagedRunResumeHandle;
    readonly session: CodexMaterializedSession;
    readonly workspacePath: string;
    readonly redactor: RedactorPort;
    readonly model: string;
    readonly reasoningEffort: CodexReasoningEffort;
    readonly serviceTier?: CodexServiceTier;
    readonly sandboxMode?: CodexSandboxMode;
    readonly outputSchema?: unknown;
    readonly abortSignal: AbortSignal;
  }, schemaPlan: CodexStructuredOutputSchemaPlan | undefined): Promise<CodexExecutionResult> {
    if (!this.options.goalMode) {
      throw new Error("codex_app_server_resume_requires_goal_mode");
    }
    await assertManagedRunCanResume({
      runStore: this.runStore,
      runId: input.runId,
      requestId: input.requestId,
      resumeHandle: input.resumeHandle,
      workspacePath: input.workspacePath,
    });
    this.options.childBudget?.remainingMs();
    const slot = await this.slotPool.ensureSlot(input);
    this.executionLifetime?.assertActive(input.abortSignal);
    const outputSchema = schemaPlan?.codexSchema;
    const schemaWarnings = input.outputSchema && outputSchema === undefined
      ? [appServerOutputSchemaNotNativeWarning()]
      : [];
    const result = await slot.goalRunner.resumeGoal({
      redactor: input.redactor,
      runId: input.runId,
      requestId: input.requestId,
      answer: input.answer,
      resumeHandle: input.resumeHandle,
      workspacePath: input.workspacePath,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      ...(input.serviceTier === undefined
        ? {}
        : { serviceTier: input.serviceTier }),
      sandboxMode: input.sandboxMode ?? "read-only",
      ...(outputSchema === undefined ? {} : { outputSchema }),
      timeoutMs: this.options.timeoutMs ?? defaultTimeoutMs,
      abortSignal: input.abortSignal,
      maxGoalTurns: this.options.maxGoalTurns ?? defaultMaxGoalTurns,
      goalContinuePrompt:
        this.options.goalContinuePrompt ?? defaultGoalContinuePrompt,
      skipResumeValidation: true,
    });
    this.executionLifetime?.assertActive(input.abortSignal);
    return redactCompletedAppServerResult({
      result,
      schemaWarnings,
      redactor: input.redactor,
      maxOutputBytes: this.maxOutputBytes(),
    });
  }

  private maxOutputBytes(): number {
    return this.options.maxOutputBytes ?? defaultMaxOutputBytes;
  }
}
