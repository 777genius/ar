import { appendNativeWebEvidence, type NativeWebEvidence } from "@vioxen/subscription-runtime/core";
import { ChildLifetimeError, ChildLifetimeFailure } from "@vioxen/subscription-runtime/core";
import { AppServerUsageError, usageFromError, nativeWebFromError } from "../domain/app-server-usage-error";
import type {
  AgentUsage,
  ManagedRunInputRequest,
  ManagedRunResumeHandle,
  ManagedRunStorePort,
  RedactorPort,
} from "@vioxen/subscription-runtime/core";
import {
  ProviderLogicalThreadOutcome,
} from "@vioxen/subscription-runtime/core";
import type {
  CodexReasoningEffort,
  CodexSandboxMode,
  CodexServiceTier,
} from "../../codex-json-execution-engine";
import { controlRequestTimeoutMs } from "../domain/app-server-errors";
import {
  buildGoalResumePrompt,
  goalInputRequest,
  goalMaxTurnsExceededError,
  normalizeRunId,
} from "../domain/app-server-goal-policy";
import {
  type AppServerRunResult,
  type AppServerWarning,
  type CodexThreadGoal,
} from "../domain/app-server-types";
import {
  mergeAgentUsage,
  subtractAgentUsage,
  usageField,
} from "../domain/app-server-usage";
import type { CodexAppServerClient } from "./app-server-client";
import {
  CodexAppServerThreadForkError,
  turnFailureError,
} from "./app-server-client";
import {
  assertManagedRunCanResume,
  managedRunFailureFromError,
} from "./app-server-managed-run-mapper";
import { AppServerTurnCheckpointError, type AppServerCompletedTurnCheckpoint } from "./app-server-turn-checkpoint";
import { completeValidatedNativeGoal, type AppServerGoalTurnOutputValidator } from "./app-server-validated-goal-completion";

export class AppServerGoalRunner {
  constructor(
    private readonly options: {
      readonly client: CodexAppServerClient;
      readonly runStore: ManagedRunStorePort;
      readonly completedTurnCheckpoint?: AppServerCompletedTurnCheckpoint;
    },
  ) {}

  async runGoal(input: {
    readonly redactor: RedactorPort;
    readonly runId?: string;
    readonly prompt: string;
    readonly goalObjective?: string;
    readonly systemPrompt?: string;
    readonly workspacePath: string;
    readonly model: string;
    readonly reasoningEffort: CodexReasoningEffort;
    readonly serviceTier?: CodexServiceTier;
    readonly sandboxMode: CodexSandboxMode;
    readonly outputSchema?: unknown;
    readonly timeoutMs: number;
    readonly abortSignal: AbortSignal;
    readonly maxGoalTurns: number;
    readonly goalContinuePrompt: string;
    readonly validateCompletedOutput?: AppServerGoalTurnOutputValidator;
  }): Promise<AppServerRunResult> {
    const usageLease = this.options.client.acquireExecution();
    try {
      const warnings = this.options.client.drainWarnings();
      const runId = normalizeRunId(input.runId);
      const threadId = await this.options.client.startThread({
        usageLease,
        ...input,
        goalMode: true,
      });
      const activeGoal = await this.options.client.setGoal({
        threadId,
        objective: input.goalObjective ?? input.prompt,
        status: "active",
        timeoutMs: input.timeoutMs,
        abortSignal: input.abortSignal,
      });

      this.options.client.assertExecutionActive(input.abortSignal);
      if ((this.options.client.executionLifetime || this.options.client.childBudget) && (activeGoal.status !== "active" || activeGoal.threadId !== threadId)) throw new Error("codex_app_server_goal_not_active");
      this.options.client.executionLifetime?.markReady(threadId);

      return await this.continueGoal({
        ...input,
        runId,
        threadId,
        firstPrompt: input.prompt,
        warnings,
      });
    } finally {
      usageLease.release();
    }
  }

  async runLogicalThreadGoal(input: {
    readonly redactor: RedactorPort;
    readonly runId?: string;
    readonly prompt: string;
    readonly goalObjective?: string;
    readonly systemPrompt?: string;
    readonly previousCheckpoint?: string;
    readonly workspacePath: string;
    readonly model: string;
    readonly reasoningEffort: CodexReasoningEffort;
    readonly serviceTier?: CodexServiceTier;
    readonly sandboxMode: CodexSandboxMode;
    readonly outputSchema?: unknown;
    readonly timeoutMs: number;
    readonly abortSignal: AbortSignal;
    readonly maxGoalTurns: number;
    readonly goalContinuePrompt: string;
  }): Promise<{
    readonly status: "completed";
    readonly outputText: string;
    readonly nativeWeb?: NativeWebEvidence;
    readonly usage?: AgentUsage;
    readonly warnings: readonly AppServerWarning[];
    readonly providerCheckpoint: string;
    readonly outcome: ProviderLogicalThreadOutcome;
  }> {
    const usageLease = this.options.client.acquireExecution();
    try {
      const warnings = this.options.client.drainWarnings();
      const runId = normalizeRunId(input.runId);
      if ((this.options.client.executionLifetime || this.options.client.childBudget)) throw new Error("child_continuation_denied");
      let outcome = ProviderLogicalThreadOutcome.StartedFresh;
      let threadId: string;
      if (input.previousCheckpoint === undefined) {
        threadId = await this.options.client.startThread({
          usageLease,
          ...input,
          goalMode: true,
        });
      } else {
        try {
          threadId = await this.options.client.forkThread({
            ...input,
            usageLease,
            goalMode: true,
            threadId: input.previousCheckpoint,
            timeoutMs: input.timeoutMs,
            abortSignal: input.abortSignal,
          });
          outcome = ProviderLogicalThreadOutcome.Continued;
        } catch (error) {
          if (input.abortSignal.aborted) throw error;
          if (
            !(error instanceof CodexAppServerThreadForkError) ||
            !error.sourceThreadUnavailable
          ) {
            throw error;
          }
          threadId = await this.options.client.startThread({
            usageLease,
            ...input,
            goalMode: true,
          });
          outcome = ProviderLogicalThreadOutcome.RecoveredFresh;
          warnings.push({
            code: "codex_app_server_thread_recovered_fresh",
            safeMessage:
              "Codex source thread was unavailable; execution started fresh before any turn.",
          });
        }
      }
      await this.options.client.setGoal({
        threadId,
        objective: input.goalObjective ?? input.prompt,
        status: "active",
        timeoutMs: input.timeoutMs,
        abortSignal: input.abortSignal,
      });
      const result = await this.continueGoal({
        ...input,
        runId,
        threadId,
        firstPrompt: input.prompt,
        warnings,
        allowWaitingForInput: false,
      });
      if (result.status === "waiting_for_input") {
        throw new Error("codex_logical_thread_goal_waiting_for_input_invalid");
      }
      return {
        ...result,
        status: "completed",
        providerCheckpoint: threadId,
        outcome,
      };
    } finally {
      usageLease.release();
    }
  }

  async resumeGoal(input: {
    readonly redactor: RedactorPort;
    readonly runId: string;
    readonly requestId: string;
    readonly answer: string;
    readonly resumeHandle: ManagedRunResumeHandle;
    readonly workspacePath: string;
    readonly model: string;
    readonly reasoningEffort: CodexReasoningEffort;
    readonly serviceTier?: CodexServiceTier;
    readonly sandboxMode: CodexSandboxMode;
    readonly outputSchema?: unknown;
    readonly timeoutMs: number;
    readonly abortSignal: AbortSignal;
    readonly maxGoalTurns: number;
    readonly goalContinuePrompt: string;
    readonly skipResumeValidation?: boolean;
  }): Promise<AppServerRunResult> {
    if ((this.options.client.executionLifetime || this.options.client.childBudget)) throw new Error("child_continuation_denied");
    const usageLease = this.options.client.acquireExecution();
    try {
      const threadId = input.resumeHandle.threadId;
      if (threadId) usageLease.retain(threadId);
      if (!threadId) throw new Error("codex_managed_run_thread_missing");
      if (!input.skipResumeValidation) {
        await assertManagedRunCanResume({
          runStore: this.options.runStore,
          runId: input.runId,
          requestId: input.requestId,
          resumeHandle: input.resumeHandle,
          workspacePath: input.workspacePath,
        });
      }
      this.options.client.assertExecutionActive(input.abortSignal);
      const waitingRecord = await this.options.runStore.get({ runId: input.runId });
      await this.options.runStore.resume({
        runId: input.runId,
        requestId: input.requestId,
        answer: this.redactForStore(input.redactor, input.answer),
        now: new Date(),
      });

      // The claim I/O is a real async window: an abort landing there never
      // reached the provider, so compensate the claim back to waiting instead
      // of consuming the answer. A failed compensation falls through to the
      // wire's abort fence and the best-effort fail below.
      if (input.abortSignal.aborted && waitingRecord?.request) {
        await this.options.runStore.saveWaitingInput({
          runId: input.runId,
          request: waitingRecord.request,
          resumeHandle: input.resumeHandle,
          ...(waitingRecord.recoveryPacket === undefined ? {} : { recoveryPacket: waitingRecord.recoveryPacket }),
          ...(waitingRecord.taskId === undefined ? {} : { taskId: waitingRecord.taskId }),
          ...(waitingRecord.assignedWorkerId === undefined ? {} : { assignedWorkerId: waitingRecord.assignedWorkerId }),
          ...(waitingRecord.providerInstanceId === undefined ? {} : { providerInstanceId: waitingRecord.providerInstanceId }),
          ...(waitingRecord.workspacePath === undefined ? {} : { workspacePath: waitingRecord.workspacePath }),
          ...(waitingRecord.outputText === undefined ? {} : { outputText: waitingRecord.outputText }),
          now: new Date(),
        }).then(
          () => this.options.client.assertExecutionActive(input.abortSignal),
          () => undefined,
        );
      }

      try {
        await this.options.client.resumePublicResearchThread({ ...input, threadId });
        return await this.continueGoal({
          ...input,
          threadId,
          firstPrompt: buildGoalResumePrompt(input),
          resumed: true,
          warnings: this.options.client.drainWarnings(),
        });
      } catch (error) {
        const failure = managedRunFailureFromError(error);
        await this.options.runStore.fail({
          runId: input.runId,
          failure: {
            ...failure,
            safeMessage: this.redactForStore(input.redactor, failure.safeMessage),
            ...(failure.details === undefined ? {} : {
              details: Object.fromEntries(Object.entries(failure.details).map(
                ([key, value]) => [key, this.redactForStore(input.redactor, value)],
              )),
            }),
          },
          now: new Date(),
        }).catch(() => undefined);
        throw error;
      }
    } finally {
      usageLease.release();
    }
  }

  private async continueGoal(input: {
    readonly redactor: RedactorPort;
    readonly runId: string;
    readonly threadId: string;
    readonly firstPrompt: string;
    readonly goalObjective?: string;
    readonly validateCompletedOutput?: AppServerGoalTurnOutputValidator;
    readonly workspacePath: string;
    readonly model: string;
    readonly reasoningEffort: CodexReasoningEffort;
    readonly serviceTier?: CodexServiceTier;
    readonly sandboxMode: CodexSandboxMode;
    readonly outputSchema?: unknown;
    readonly timeoutMs: number;
    readonly abortSignal: AbortSignal;
    readonly maxGoalTurns: number;
    readonly goalContinuePrompt: string;
    readonly warnings: AppServerWarning[];
    readonly allowWaitingForInput?: boolean;
    readonly resumed?: boolean;
  }): Promise<AppServerRunResult> {
    let outputText = "";
    let nativeWeb: NativeWebEvidence = { turns: [], truncated: false };
    let turnUsage: AgentUsage | undefined;
    let executionMayHaveStarted = false;
    let goalBaseline = input.resumed ? (await this.options.client.getGoal({
      threadId: input.threadId,
      timeoutMs: controlRequestTimeoutMs(input.timeoutMs),
      abortSignal: input.abortSignal,
    }))?.usage : { totalTokens: 0 };
    let detailedSinceGoal: AgentUsage | undefined;
    let missingUsageSinceGoal = false;
    // A turn whose exact usage was untrusted is NOT a turn that reported
    // nothing: backfilling it from the goal's cumulative counter would restore
    // by the back door exactly the number the turn refused to stand behind.
    let untrustedUsageSinceGoal = false;
    try {
      for (
        let turnNumber = 1;
        turnNumber <= input.maxGoalTurns;
        turnNumber += 1
      ) {
        this.options.client.assertExecutionActive(input.abortSignal);
        const startedAt = Date.now();
        const turn = await this.options.client
          .startTurn({
            ...input,
            goalMode: true,
            turnNumber,
            prompt:
              turnNumber === 1 ? input.firstPrompt : input.goalContinuePrompt,
          })
          .catch((error: unknown) => {
            turnUsage = mergeAgentUsage(turnUsage, usageFromError(error));
            nativeWeb = appendNativeWebEvidence(nativeWeb, nativeWebFromError(error));
            throw turnFailureError(error, {
              phase: "turn_start_rejected",
              turnNumber,
              elapsedMs: Date.now() - startedAt,
            });
          });
        executionMayHaveStarted = true;
        nativeWeb = appendNativeWebEvidence(nativeWeb, turn.nativeWeb);
        turnUsage = mergeAgentUsage(turnUsage, turn.usage);
        detailedSinceGoal = mergeAgentUsage(detailedSinceGoal, turn.usage);
        missingUsageSinceGoal ||= turn.usage === undefined;
        untrustedUsageSinceGoal ||= turn.usagePoisoned;
        if (turn.error) throw turn.error;
        outputText = turn.outputText;

        this.options.client.assertExecutionActive(input.abortSignal);
        if (this.options.completedTurnCheckpoint) {
          try {
            await this.options.completedTurnCheckpoint({
              runId: input.runId,
              workspacePath: input.workspacePath,
              turnNumber,
            });
          } catch (error) {
            throw new AppServerTurnCheckpointError(error);
          }
        }

        let goal = await this.options.client.getGoal({
          threadId: input.threadId,
          timeoutMs: controlRequestTimeoutMs(input.timeoutMs),
          abortSignal: input.abortSignal,
        });
        if (!goal) {
          throw new Error("codex_app_server_goal_missing");
        }
        const reportedTotal = goal.usage?.totalTokens;
        if (
          reportedTotal !== undefined &&
          reportedTotal >= (goalBaseline?.totalTokens ?? 0)
        ) {
          if (goalBaseline && missingUsageSinceGoal && !untrustedUsageSinceGoal) {
            const windowUsage = subtractAgentUsage(goal.usage, goalBaseline);
            turnUsage = mergeAgentUsage(
              turnUsage,
              subtractAgentUsage(windowUsage, detailedSinceGoal),
            );
          }
          goalBaseline = goal.usage;
          detailedSinceGoal = undefined;
          missingUsageSinceGoal = false;
          untrustedUsageSinceGoal = false;
        }
        // Ordinary goals linearize at the delivered terminal GoalAPI response.
        if (input.validateCompletedOutput !== undefined) {
          goal = await completeValidatedNativeGoal({
            client: this.options.client, goal, threadId: input.threadId,
            objective: input.goalObjective ?? input.firstPrompt,
            runId: input.runId, turnNumber, outputText,
            timeoutMs: controlRequestTimeoutMs(input.timeoutMs), abortSignal: input.abortSignal,
            validate: input.validateCompletedOutput,
          });
        }
        // Bounded goals must also pass their original continuation fence.
        const bounded = this.options.client.executionLifetime || this.options.client.childBudget;
        if (bounded || goal.status !== "complete") this.options.client.assertExecutionActive(input.abortSignal);
        if (goal.status === "complete") {
          input.warnings.push(...this.options.client.drainWarnings());
          await this.options.runStore.complete({
            runId: input.runId,
            outputText: this.redactForStore(input.redactor, outputText),
            now: new Date(),
          });
          if (bounded) this.options.client.assertExecutionActive(input.abortSignal);
          return {
            status: "completed",
            outputText,
            nativeWeb,
            ...usageField(turnUsage),
            warnings: input.warnings,
          };
        }
        if (goal.status === "blocked" || goal.status === "paused") {
          if (input.allowWaitingForInput === false || (this.options.client.executionLifetime || this.options.client.childBudget)) {
            throw new Error(
              "codex_logical_thread_goal_waiting_for_input_invalid",
            );
          }
          return await this.waitForGoalInput({
            redactor: input.redactor,
            runId: input.runId,
            threadId: input.threadId,
            goal,
            outputText,
            nativeWeb,
            workspacePath: input.workspacePath,
            ...usageField(turnUsage),
            warnings: input.warnings,
          });
        }
        if (goal.status !== "active") {
          throw new Error(`codex_app_server_goal_${goal.status}`);
        }
        if (!outputText.trim()) {
          throw new Error("codex_app_server_goal_turn_output_missing");
        }
      }

    } catch (error) {
      throw new AppServerUsageError(error, turnUsage, executionMayHaveStarted, nativeWeb);
    }
    if (this.options.client.childBudget) {
      const error = new ChildLifetimeError(ChildLifetimeFailure.Turns);
      this.options.client.requestChildCleanup(error);
      this.options.client.childBudget.exhaust();
    }
    throw new AppServerUsageError(
      goalMaxTurnsExceededError({
        maxGoalTurns: input.maxGoalTurns,
        outputText,
        ...usageField(turnUsage),
      }),
      turnUsage,
      executionMayHaveStarted,
      nativeWeb,
    );
  }

  private async waitForGoalInput(input: {
    readonly redactor: RedactorPort;
    readonly runId: string;
    readonly threadId: string;
    readonly goal: CodexThreadGoal;
    readonly outputText: string;
    readonly nativeWeb?: NativeWebEvidence;
    readonly workspacePath: string;
    readonly usage?: AgentUsage;
    readonly warnings: readonly AppServerWarning[];
  }): Promise<{
    readonly status: "waiting_for_input";
    readonly runId: string;
    readonly outputText: string;
    readonly nativeWeb?: NativeWebEvidence;
    readonly request: ManagedRunInputRequest;
    readonly resumeHandle: ManagedRunResumeHandle;
    readonly usage?: AgentUsage;
    readonly warnings: readonly AppServerWarning[];
  }> {
    const request = goalInputRequest({
      runId: input.runId,
      goal: input.goal,
      outputText: input.outputText,
    });
    const resumeHandle: ManagedRunResumeHandle = {
      runId: input.runId,
      providerId: "codex",
      agentId: "codex-json",
      workspacePath: input.workspacePath,
      threadId: input.threadId,
      providerState: {
        goalObjective: input.goal.objective,
        goalStatus: input.goal.status,
      },
    };
    await this.options.runStore.saveWaitingInput({
      runId: input.runId,
      request: {
        ...request,
        question: this.redactForStore(input.redactor, request.question),
        ...(request.contextSummary === undefined ? {} : {
          contextSummary: this.redactForStore(input.redactor, request.contextSummary),
        }),
        ...(request.suggestedAnswers === undefined ? {} : {
          suggestedAnswers: request.suggestedAnswers.map((answer) =>
            this.redactForStore(input.redactor, answer)),
        }),
      },
      resumeHandle: {
        ...resumeHandle,
        ...(resumeHandle.providerState === undefined ? {} : {
          providerState: Object.fromEntries(Object.entries(resumeHandle.providerState).map(
            ([key, value]) => [key, this.redactForStore(input.redactor, value)],
          )),
        }),
      },
      ...(input.outputText.trim() ? {
        outputText: this.redactForStore(input.redactor, input.outputText),
      } : {}),
      now: new Date(),
    });
    return {
      status: "waiting_for_input",
      runId: input.runId,
      ...(input.nativeWeb === undefined ? {} : { nativeWeb: input.nativeWeb }),
      outputText: input.outputText.trim() ? input.outputText : request.question,
      request,
      resumeHandle,
      ...usageField(input.usage),
      warnings: input.warnings,
    };
  }

  private redactForStore(redactor: RedactorPort, value: string): string {
    const redacted = redactor.redact(value);
    redactor.assertNoKnownSecret(redacted, "codex_managed_run_store");
    return redacted;
  }
}
