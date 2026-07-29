import { randomUUID } from "node:crypto";
import {
  AgentRuntimeThreadOutcome,
  type AgentRuntimeTaskRequestV3,
  type AgentRuntimeTaskResultV3,
} from "@vioxen/subscription-runtime/agent-runtime-task";
import {
  ProviderLogicalThreadOutcome,
  type ProviderLogicalThreadExecution,
  type ProviderTask,
  type ProviderTaskResult,
  type RuntimeWarning,
} from "@vioxen/subscription-runtime/core";
import {
  LogicalThreadCoordinator,
  type ProviderThreadExecutionResult,
} from "../../agent-runtime-task-runner/logical-thread";
import type {
  AgentRuntimeTaskWorker,
  AgentRuntimeTaskWorkerResult,
} from "./ports";
import { workspaceEffectFingerprint } from "./workspace-effect-fingerprint";

export async function runLogicalThreadWorkerExecution(input: {
  readonly coordinator: LogicalThreadCoordinator;
  readonly compatibilityHash: string;
  readonly request: AgentRuntimeTaskRequestV3;
  readonly task: ProviderTask;
  readonly worker: AgentRuntimeTaskWorker;
  readonly warnings: readonly RuntimeWarning[];
  readonly signal: AbortSignal;
  readonly cwd: string;
  readonly markTaskStarted: () => void;
  startWorker(): Promise<void>;
  startupFailure(error: unknown): ProviderTaskResult;
  taskFailure(error: unknown): ProviderTaskResult;
}): Promise<AgentRuntimeTaskResultV3> {
  return await input.coordinator.execute({
    request: input.request,
    compatibilityHash: input.compatibilityHash,
    provider: {
      execute: async (threadInput) => {
        try {
          await input.startWorker();
        } catch (error) {
          return {
            result: input.startupFailure(error),
            taskStarted: false,
          };
        }
        return await runWorkerLogicalThreadTask({
          abortSignal: threadInput.signal,
          request: threadInput.request,
          task: input.task,
          worker: input.worker,
          warnings: input.warnings,
          markTaskStarted: input.markTaskStarted,
          taskFailure: input.taskFailure,
          ...(threadInput.previousCheckpoint === undefined
            ? {}
            : { previousCheckpoint: threadInput.previousCheckpoint }),
        });
      },
    },
    signal: input.signal,
    workspaceEffectFingerprint: async () =>
      await workspaceEffectFingerprint(input.cwd, input.signal),
  });
}

async function runWorkerLogicalThreadTask(input: {
  readonly request: AgentRuntimeTaskRequestV3;
  readonly task: ProviderTask;
  readonly worker: AgentRuntimeTaskWorker;
  readonly abortSignal: AbortSignal;
  readonly warnings: readonly RuntimeWarning[];
  readonly markTaskStarted: () => void;
  readonly previousCheckpoint?: string;
  taskFailure(error: unknown): ProviderTaskResult;
}): Promise<ProviderThreadExecutionResult> {
  let candidateCheckpoint: string | undefined;
  let outcome: AgentRuntimeThreadOutcome | undefined;
  let taskStarted = false;
  const logicalThread: ProviderLogicalThreadExecution = {
    threadId: input.request.thread.id,
    ...(input.previousCheckpoint === undefined
      ? {}
      : { previousCheckpoint: input.previousCheckpoint }),
    onCheckpoint: ({ checkpoint, outcome: providerOutcome }) => {
      if (!checkpoint.trim()) {
        throw new Error("agent_runtime_logical_thread_checkpoint_invalid");
      }
      const nextOutcome = publicThreadOutcome(providerOutcome);
      if (
        candidateCheckpoint !== undefined &&
        (
          candidateCheckpoint !== checkpoint ||
          outcome !== nextOutcome
        )
      ) {
        throw new Error("agent_runtime_logical_thread_checkpoint_ambiguous");
      }
      candidateCheckpoint = checkpoint;
      outcome = nextOutcome;
    },
  };
  try {
    const result = await input.worker.run({
      runId: input.request.runId ?? `agent-runtime-task-${randomUUID()}`,
      prompt: input.task.prompt,
      ...(input.task.systemPrompt === undefined
        ? {}
        : { systemPrompt: input.task.systemPrompt }),
      kind: input.task.kind,
      ...(input.task.outputSchemaName === undefined
        ? {}
        : { outputSchemaName: input.task.outputSchemaName }),
      ...(input.task.controls === undefined
        ? {}
        : { controls: input.task.controls }),
      ...(input.task.execution === undefined
        ? {}
        : { execution: input.task.execution }),
      ...(input.task.metadata === undefined
        ? {}
        : { metadata: input.task.metadata }),
      abortSignal: input.abortSignal,
      logicalThread,
    }, {
      abortSignal: input.abortSignal,
      onProviderTaskStarted: () => {
        taskStarted = true;
        input.markTaskStarted();
      },
    });
    return {
      result: appendProviderWarnings(
        workerResultToProviderTaskResult(result),
        input.warnings,
      ),
      taskStarted,
      ...(candidateCheckpoint === undefined
        ? {}
        : { candidateCheckpoint }),
      ...(outcome === undefined ? {} : { outcome }),
    };
  } catch (error) {
    return {
      result: input.taskFailure(error),
      taskStarted,
    };
  }
}

export function workerResultToProviderTaskResult(
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

function appendProviderWarnings(
  result: ProviderTaskResult,
  warnings: readonly RuntimeWarning[],
): ProviderTaskResult {
  if (warnings.length === 0) return result;
  return {
    ...result,
    warnings: [...warnings, ...result.warnings],
  };
}

function publicThreadOutcome(
  outcome: ProviderLogicalThreadOutcome,
): AgentRuntimeThreadOutcome {
  switch (outcome) {
    case ProviderLogicalThreadOutcome.StartedFresh:
      return AgentRuntimeThreadOutcome.StartedFresh;
    case ProviderLogicalThreadOutcome.Continued:
      return AgentRuntimeThreadOutcome.Continued;
    case ProviderLogicalThreadOutcome.RecoveredFresh:
      return AgentRuntimeThreadOutcome.RecoveredFresh;
  }
}
