import { claudeTelemetryFromError, numericClaudeTelemetry } from "../protocol/task-telemetry";
import {
  assertProviderTaskSystemPrompt,
  AgentRuntimeTurnLimitEnforcement,
  type AgentCapabilities,
  type AgentDriver,
  type ProviderFailure,
  type ProviderTask,
  type ProviderTaskEvent,
  type ProviderTaskControls,
  type ProviderTaskResult,
  ProviderLogicalThreadOutcome,
  type ProviderLogicalThreadExecution,
  type RedactorPort,
  type RunnerPort,
  type SessionArtifact,
  type StreamingAgentDriver,
  type WorkspaceHandle,
} from "@vioxen/subscription-runtime/core";
import {
  claudeBgTaskAgentCapabilities,
  claudeBgTaskAgentId,
  claudeProviderId,
} from "../capabilities";
import { classifyClaudeFailure } from "../protocol/failure-classifier";
import {
  prepareClaudeTaskEngineInput,
  type ClaudeTaskAgentDriverOptions,
} from "./build-claude-task-engine-input";
import {
  type ClaudeRuntimeThreadInput,
  type ClaudeTaskEngineInput,
  type ClaudeTaskExecutionEngine,
  type ClaudeTaskExecutionResult,
} from "./engine-contract";
import {
  claudeRuntimeResumeSessionIdMetadataKey,
  claudeRuntimeThreadIdMetadataKey,
} from "./runtime-thread-metadata";
import { failedClaudeTask } from "./task-failure-result";
import {
  redactProviderTaskEvent,
  redactProviderTaskResult,
  redactRuntimeWarning,
} from "./task-output-redaction";

export type {
  ClaudeRuntimeThreadInput,
  ClaudeTaskAgentDriverOptions,
  ClaudeTaskEngineInput,
  ClaudeTaskExecutionEngine,
  ClaudeTaskExecutionResult,
};
export {
  claudeRuntimeResumeSessionIdMetadataKey,
  claudeRuntimeThreadIdMetadataKey,
};

export class ClaudeTaskAgentDriver implements AgentDriver, StreamingAgentDriver {
  readonly agentId = claudeBgTaskAgentId;
  readonly providerId = claudeProviderId;
  readonly capabilities: AgentCapabilities;
  private readonly model: string;

  constructor(private readonly options: ClaudeTaskAgentDriverOptions) {
    this.model = options.model ?? "sonnet";
    const budgetCapabilities = options.engine.capabilities.budgetCapabilities;
    const taskExecutionCapabilities =
      options.engine.capabilities.taskExecutionCapabilities;
    const accessBoundaryMode =
      options.engine.capabilities.accessBoundaryMode ?? "unsupported";
    const turnLimitEnforcement =
      options.engine.capabilities.turnLimitEnforcement ??
      AgentRuntimeTurnLimitEnforcement.Unsupported;
    this.capabilities = !budgetCapabilities &&
        !taskExecutionCapabilities &&
        accessBoundaryMode === "unsupported" &&
        turnLimitEnforcement === AgentRuntimeTurnLimitEnforcement.ProviderNative
      ? claudeBgTaskAgentCapabilities
      : {
          ...claudeBgTaskAgentCapabilities,
          ...(budgetCapabilities ? { budgetCapabilities } : {}),
          ...(taskExecutionCapabilities ? { taskExecutionCapabilities } : {}),
          accessBoundaryMode,
          turnLimitEnforcement,
        };
  }

  async runTask(input: {
    readonly session: SessionArtifact | null;
    readonly task: ProviderTask;
    readonly workspace: WorkspaceHandle;
    readonly runner: RunnerPort;
    readonly redactor: RedactorPort;
    readonly abortSignal: AbortSignal;
    readonly onTaskStarted?: () => Promise<void> | void;
    readonly logicalThread?: ProviderLogicalThreadExecution;
  }): Promise<ProviderTaskResult> {
    assertProviderTaskSystemPrompt(input.task.systemPrompt, "task.systemPrompt");

    const startedAt = Date.now();
    if (!input.session) {
      return failedClaudeTask(missingClaudeSessionFailure(), startedAt);
    }

    let knownTelemetry: ProviderTaskResult["telemetry"];
    try {
      const prepared = prepareClaudeTaskEngineInput(
        this.options,
        this.model,
        { ...input, session: input.session },
      );
      await input.onTaskStarted?.();
      const result = await this.options.engine.run(prepared.engineInput);
      knownTelemetry = numericClaudeTelemetry(result.telemetry);
      if (input.logicalThread !== undefined) {
        const checkpoint = result.telemetry?.providerSessionId;
        if (!checkpoint) {
          throw new Error("claude_logical_thread_checkpoint_missing");
        }
        await input.logicalThread.onCheckpoint({
          checkpoint,
          outcome:
            input.logicalThread.previousCheckpoint === undefined
              ? ProviderLogicalThreadOutcome.StartedFresh
              : ProviderLogicalThreadOutcome.Continued,
        });
      }
      const telemetry = input.logicalThread === undefined
        ? result.telemetry
        : withoutProviderSessionId(result.telemetry);
      return redactProviderTaskResult({
        status: "completed",
        outputText: result.outputText,
        ...(result.structuredOutput === undefined
          ? {}
          : { structuredOutput: result.structuredOutput }),
        telemetry: {
          durationMs: Date.now() - startedAt,
          finishReason: "completed",
          ...telemetry,
        },
        warnings: [...prepared.warnings, ...result.warnings],
      }, input.redactor);
    } catch (error) {
      const failure = classifyClaudeFailure(error, {
        redactor: input.redactor,
      });
      input.redactor.assertNoKnownSecret(
        JSON.stringify(failure),
        "claude task failure",
      );
      return failedClaudeTask(
        failure,
        startedAt,
        claudeTelemetryFromError(error) ?? knownTelemetry,
      );
    }
  }

  async *streamTask(input: {
    readonly session: SessionArtifact | null;
    readonly task: ProviderTask;
    readonly workspace: WorkspaceHandle;
    readonly runner: RunnerPort;
    readonly redactor: RedactorPort;
    readonly abortSignal: AbortSignal;
  }): AsyncIterable<ProviderTaskEvent> {
    assertProviderTaskSystemPrompt(input.task.systemPrompt, "task.systemPrompt");

    const startedAt = Date.now();
    if (!input.session) {
      yield {
        type: "completed",
        occurredAt: new Date(),
        result: failedClaudeTask(missingClaudeSessionFailure(), startedAt),
      };
      return;
    }

    if (!this.options.engine.stream) {
      yield {
        type: "started",
        occurredAt: new Date(),
      };
      const result = await this.runTask(input);
      yield {
        type: "completed",
        occurredAt: new Date(),
        result,
        ...(result.telemetry === undefined ? {} : { telemetry: result.telemetry }),
      };
      return;
    }

    let knownTelemetry: ProviderTaskResult["telemetry"];
    try {
      const prepared = prepareClaudeTaskEngineInput(
        this.options,
        this.model,
        { ...input, session: input.session },
      );
      for (const warning of prepared.warnings) {
        yield {
          type: "warning",
          occurredAt: new Date(),
          warning: redactRuntimeWarning(warning, input.redactor),
        };
      }
      for await (const event of this.options.engine.stream(prepared.engineInput)) {
        const observedTelemetry = event.type === "completed"
          ? event.result.telemetry ?? event.telemetry : event.telemetry;
        if (observedTelemetry !== undefined) knownTelemetry = numericClaudeTelemetry(observedTelemetry);
        yield redactProviderTaskEvent(event, input.redactor);
      }
    } catch (error) {
      const result = redactProviderTaskResult(
        failedClaudeTask(
          classifyClaudeFailure(error, { redactor: input.redactor }),
          startedAt,
          claudeTelemetryFromError(error) ?? knownTelemetry,
        ),
        input.redactor,
      );
      yield {
        type: "completed",
        occurredAt: new Date(),
        result,
        ...(result.telemetry === undefined ? {} : { telemetry: result.telemetry }),
      };
    }
  }

  classifyRunFailure(error: unknown): ProviderFailure {
    return classifyClaudeFailure(error);
  }

  async dispose(): Promise<void> {
    await this.options.engine.dispose?.();
  }
}

function withoutProviderSessionId(
  telemetry: ProviderTaskResult["telemetry"],
): ProviderTaskResult["telemetry"] {
  if (telemetry?.providerSessionId === undefined) return telemetry;
  const { providerSessionId: _providerSessionId, ...rest } = telemetry;
  return rest;
}

function missingClaudeSessionFailure(): ProviderFailure {
  return {
    code: "provider_session_invalid",
    retryable: false,
    reconnectRequired: true,
    safeMessage: "Claude requires a session artifact.",
    causeCategory: "provider_session_invalid",
  };
}
