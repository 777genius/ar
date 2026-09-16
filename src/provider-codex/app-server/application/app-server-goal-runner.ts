import { AppServerUsageError, usageFromError } from "../domain/app-server-usage-error";
import type {
  AgentUsage,
  ManagedRunInputRequest,
  ManagedRunResumeHandle,
  ManagedRunStorePort,
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

export class AppServerGoalRunner {
  constructor(
    private readonly options: {
      readonly client: CodexAppServerClient;
      readonly runStore: ManagedRunStorePort;
    },
  ) {}

  async runGoal(input: {
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
      await this.options.client.setGoal({
        threadId,
        objective: input.goalObjective ?? input.prompt,
        status: "active",
        timeoutMs: input.timeoutMs,
        abortSignal: input.abortSignal,
      });

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
    readonly usage?: AgentUsage;
    readonly warnings: readonly AppServerWarning[];
    readonly providerCheckpoint: string;
    readonly outcome: ProviderLogicalThreadOutcome;
  }> {
    const usageLease = this.options.client.acquireExecution();
    try {
      const warnings = this.options.client.drainWarnings();
      const runId = normalizeRunId(input.runId);
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
            usageLease,
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
      await this.options.runStore.resume({
        runId: input.runId,
        requestId: input.requestId,
        answer: input.answer,
        now: new Date(),
      });

      try {
        return await this.continueGoal({
          ...input,
          threadId,
          firstPrompt: buildGoalResumePrompt(input),
          resumed: true,
          warnings: this.options.client.drainWarnings(),
        });
      } catch (error) {
        await this.options.runStore.fail({
          runId: input.runId,
          failure: managedRunFailureFromError(error),
          now: new Date(),
        });
        throw error;
      }
    } finally {
      usageLease.release();
    }
  }

  private async continueGoal(input: {
    readonly runId: string;
    readonly threadId: string;
    readonly firstPrompt: string;
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
            throw turnFailureError(error, {
              phase: "turn_start_rejected",
              turnNumber,
              elapsedMs: Date.now() - startedAt,
            });
          });
        executionMayHaveStarted = true;
        turnUsage = mergeAgentUsage(turnUsage, turn.usage);
        detailedSinceGoal = mergeAgentUsage(detailedSinceGoal, turn.usage);
        missingUsageSinceGoal ||= turn.usage === undefined;
        untrustedUsageSinceGoal ||= turn.usagePoisoned;
        if (turn.error) throw turn.error;
        outputText = turn.outputText;

        const goal = await this.options.client.getGoal({
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
        if (goal.status === "complete") {
          input.warnings.push(...this.options.client.drainWarnings());
          await this.options.runStore.complete({
            runId: input.runId,
            outputText,
            now: new Date(),
          });
          return {
            status: "completed",
            outputText,
            ...usageField(turnUsage),
            warnings: input.warnings,
          };
        }
        if (goal.status === "blocked" || goal.status === "paused") {
          if (input.allowWaitingForInput === false) {
            throw new Error(
              "codex_logical_thread_goal_waiting_for_input_invalid",
            );
          }
          return await this.waitForGoalInput({
            runId: input.runId,
            threadId: input.threadId,
            goal,
            outputText,
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
      throw new AppServerUsageError(error, turnUsage, executionMayHaveStarted);
    }
    throw new AppServerUsageError(
      goalMaxTurnsExceededError({
        maxGoalTurns: input.maxGoalTurns,
        outputText,
        ...usageField(turnUsage),
      }),
      turnUsage,
      executionMayHaveStarted,
    );
  }

  private async waitForGoalInput(input: {
    readonly runId: string;
    readonly threadId: string;
    readonly goal: CodexThreadGoal;
    readonly outputText: string;
    readonly workspacePath: string;
    readonly usage?: AgentUsage;
    readonly warnings: readonly AppServerWarning[];
  }): Promise<{
    readonly status: "waiting_for_input";
    readonly runId: string;
    readonly outputText: string;
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
      request,
      resumeHandle,
      ...(input.outputText.trim() ? { outputText: input.outputText } : {}),
      now: new Date(),
    });
    return {
      status: "waiting_for_input",
      runId: input.runId,
      outputText: input.outputText.trim() ? input.outputText : request.question,
      request,
      resumeHandle,
      ...usageField(input.usage),
      warnings: input.warnings,
    };
  }
}
