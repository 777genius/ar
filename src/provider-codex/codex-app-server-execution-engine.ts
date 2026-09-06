import { isAppServerAdmissionError } from "./app-server/application/app-server-admission";
import { AppServerUsageError } from "./app-server/domain/app-server-usage-error";
import type {
  ManagedRunResumeHandle,
  ManagedRunStorePort,
  RedactorPort,
  RunnerPort,
} from "@vioxen/subscription-runtime/core";
import {
  AgentRuntimeBudgetEnforcement,
  AgentRuntimeBudgetMetric,
  AgentRuntimeExecutionMode,
  AgentRuntimeTurnLimitEnforcement,
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
import type {
  CodexAppServerRolloutBudget,
} from "./app-server/domain/app-server-rollout-budget";
import { codexAppServerRolloutBudgetConfig } from "./app-server/domain/app-server-rollout-budget";
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
import { parseCodexAppServerStructuredOutput } from "./app-server/application/app-server-structured-output";
import { isCodexModelUnavailableError } from "./app-server/domain/model-catalog";
import {
  isCodexAppServerRateLimitsRejectedError,
  type CodexAppServerRateLimitsSnapshotHandler,
} from "./app-server/application/app-server-rate-limits-monitor";
import type { CodexAppServerExecutionEngineOptions } from "./codex-app-server-execution-engine-options";

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
export class CodexAppServerExecutionEngine implements CodexExecutionEngine {
  readonly kind: "app-server-pool" | "app-server-goal";
  readonly capabilities: CodexExecutionEngine["capabilities"];

  private readonly executionProfile: ResolvedCodexExecutionProfile;
  private readonly runStore: ManagedRunStorePort;
  private readonly slotPool: AppServerSlotPool;

  constructor(private readonly options: CodexAppServerExecutionEngineOptions) {
    if (!options.codexBinaryPath.trim()) {
      throw new Error("codex_app_server_binary_required");
    }
    assertPositiveInteger(options.timeoutMs, "codex_app_server_timeout_invalid");
    assertPositiveInteger(
      options.startupTimeoutMs,
      "codex_app_server_startup_timeout_invalid",
    );
    codexAppServerRolloutBudgetConfig(options.rolloutBudget);
    this.capabilities = {
      supportsStructuredOutput: true,
      supportsJsonEvents: true,
      supportsThreadResume: false,
      requiresSchemaFile: false,
      taskExecutionCapabilities: [
        { mode: AgentRuntimeExecutionMode.SingleRun },
        ...(options.goalMode
          ? [{
              mode: AgentRuntimeExecutionMode.Goal,
              maxCompletionConditionChars: 4_000,
            } as const]
          : []),
      ],
      ...(options.goalMode
        ? {
            turnLimitEnforcement:
              AgentRuntimeTurnLimitEnforcement.ProviderNative,
          }
        : {}),
      ...(options.rolloutBudget
        ? {
            budgetCapabilities: [
              {
                metric: AgentRuntimeBudgetMetric.WeightedTokens,
                enforcement: AgentRuntimeBudgetEnforcement.ProviderNative,
              },
            ],
          }
        : {}),
    };
    this.kind = options.goalMode ? "app-server-goal" : "app-server-pool";
    this.executionProfile = resolveCodexExecutionProfile(
      options.executionProfile,
    );
    this.runStore = options.runStore ?? new InMemoryManagedRunStore();
    this.slotPool = new AppServerSlotPool({
      codexBinaryPath: options.codexBinaryPath,
      ...(options.sourceEnv === undefined ? {} : { sourceEnv: options.sourceEnv }),
      processFactory: options.processFactory ?? spawnCodexAppServerProcess,
      signalChildProcess: signalCodexAppServerChildGroup,
      runStore: this.runStore,
      executionProfile: this.executionProfile,
      ...(options.commandApprovalPolicy === undefined
        ? {}
        : { commandApprovalPolicy: options.commandApprovalPolicy }),
      ...(options.nativeToolSurface === undefined
        ? {}
        : { nativeToolSurface: options.nativeToolSurface }),
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
    });
  }

  async run(input: CodexExecutionInput): Promise<CodexExecutionResult> {
    const schemaPlan = input.outputSchemaPlan ?? prepareCodexOutputSchemaPlan(input.outputSchema);
    try {
      const result = await this.runViaAppServer(input, schemaPlan);
      if (result.status === "waiting_for_input") return result;
      return await this.parseStructuredOutput(result, input, schemaPlan);
    } catch (error) {
      if (error instanceof AppServerSlotAcquireAbortedError || isAppServerAdmissionError(error)) throw error;
      await this.slotPool.disposeSessionSlot(input.session);
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
        await this.parseStructuredOutput(result, parseInput, schemaPlan),
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
    const schemaPlan = prepareCodexOutputSchemaPlan(input.outputSchema);
    try {
      const result = await this.resumeViaAppServer(input, schemaPlan);
      if (result.status === "waiting_for_input") return result;
      return await this.parseStructuredOutput(result, input, schemaPlan);
    } catch (error) {
      if (error instanceof AppServerSlotAcquireAbortedError || isAppServerAdmissionError(error)) throw error;
      if (!isManagedRunResumeValidationError(error)) {
        await this.slotPool.disposeSessionSlot(input.session);
      }
      throw error;
    }
  }

  async dispose(): Promise<void> {
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
      await this.slotPool.disposeSessionSlot(input.session);
      throw error;
    }
  }

  private async runViaAppServer(input: {
    readonly runId?: string;
    readonly prompt: string;
    readonly goalObjective?: string;
    readonly systemPrompt?: string;
    readonly session: CodexMaterializedSession;
    readonly workspacePath: string;
    readonly redactor: RedactorPort;
    readonly model: string;
    readonly reasoningEffort: CodexReasoningEffort;
    readonly serviceTier?: CodexServiceTier;
    readonly sandboxMode?: CodexSandboxMode;
    readonly outputSchema?: unknown;
    readonly abortSignal: AbortSignal;
    readonly onTextDelta?: (text: string) => void;
  }, schemaPlan: CodexStructuredOutputSchemaPlan | undefined): Promise<CodexExecutionResult> {
    const slot = await this.slotPool.ensureSlot(input);
    const outputSchema = schemaPlan?.codexSchema;
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
          maxGoalTurns: this.options.maxGoalTurns ?? defaultMaxGoalTurns,
          goalContinuePrompt:
            this.options.goalContinuePrompt ?? defaultGoalContinuePrompt,
        })
      : await slot.turnRunner.runCleanTurn(common);
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
    const slot = await this.slotPool.ensureSlot(input);
    const outputSchema = schemaPlan?.codexSchema;
    const schemaWarnings = input.outputSchema && outputSchema === undefined
      ? [appServerOutputSchemaNotNativeWarning()]
      : [];
    const result = await slot.goalRunner.resumeGoal({
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
    return redactCompletedAppServerResult({
      result,
      schemaWarnings,
      redactor: input.redactor,
      maxOutputBytes: this.maxOutputBytes(),
    });
  }

  private async parseStructuredOutput(
    result: CodexExecutionResult,
    input: {
      readonly runId?: string;
      readonly outputSchema?: unknown;
    },
    schemaPlan: CodexStructuredOutputSchemaPlan | undefined,
  ): Promise<CodexExecutionResult> {
    try {
      return await parseCodexAppServerStructuredOutput({
        result,
        requested: Boolean(input.outputSchema),
        ...(schemaPlan === undefined ? {} : { schemaPlan }),
        goalMode: this.options.goalMode,
        ...(input.runId === undefined ? {} : { runId: input.runId }),
        runStore: this.runStore,
      });
    } catch (error) {
      throw new AppServerUsageError(error, result.usage, true);
    }
  }

  private maxOutputBytes(): number {
    return this.options.maxOutputBytes ?? defaultMaxOutputBytes;
  }
}
