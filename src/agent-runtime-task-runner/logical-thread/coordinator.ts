import { createHash } from "node:crypto";
import {
  AgentRuntimeFailureCode,
  AgentRuntimeTaskResultStatus,
  type ProviderTaskResult,
} from "@vioxen/subscription-runtime/core";
import {
  AgentRuntimeFailureLifecycleState,
  agentRuntimeTaskProtocolVersionV3,
  makeFailedAgentRuntimeTaskResult,
  providerTaskResultToAgentRuntimeTaskResult,
  type AgentRuntimeTaskRequestV3,
  type AgentRuntimeTaskResultV3,
  type AgentRuntimeFailureLifecycle,
} from "@vioxen/subscription-runtime/agent-runtime-task";
import {
  LogicalThreadBusyError,
  LogicalThreadExecutionStatus,
  type LogicalThreadActiveExecution,
  type LogicalThreadCompletedExecution,
  type LogicalThreadState,
} from "./domain";
import type {
  LogicalThreadStore,
  ProviderThreadPort,
} from "./ports";

export class LogicalThreadCoordinator {
  constructor(
    private readonly store: LogicalThreadStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(input: {
    readonly request: AgentRuntimeTaskRequestV3;
    readonly compatibilityHash: string;
    readonly provider: ProviderThreadPort;
    readonly signal: AbortSignal;
    readonly workspaceEffectFingerprint: () => Promise<string>;
  }): Promise<AgentRuntimeTaskResultV3> {
    const { executionId } = input.request;
    const threadId = input.request.thread.id;
    const requestHash = logicalThreadRequestHash(input.request);
    let preparation: LogicalThreadPreparation;
    try {
      preparation = await this.store.withExclusive({
        threadId,
        action: async (transaction) => {
          const current = transaction.readState();
          const compatibilityFailure = validateCompatibility(
            current,
            input.compatibilityHash,
          );
          if (compatibilityFailure) {
            return terminalPreparation(compatibilityFailure);
          }

          if (current?.lastCompletedExecution) {
            await transaction.writeExecution(current.lastCompletedExecution);
          }

          const recorded = await transaction.readExecution(executionId);
          if (recorded) {
            if (recorded.requestHash !== requestHash) {
              return terminalPreparation(requestConflictResult());
            }
            if (recorded.status === LogicalThreadExecutionStatus.Completed) {
              if (
                recorded.result.status !== AgentRuntimeTaskResultStatus.Completed
              ) {
                return terminalPreparation(recorded.result);
              }
              const currentFingerprint =
                await input.workspaceEffectFingerprint().catch(() => null);
              if (currentFingerprint === null) {
                return terminalPreparation(
                  replayWorkspaceEffectUnavailableResult(),
                );
              }
              return terminalPreparation(
                currentFingerprint === recorded.workspaceEffectFingerprint
                  ? recorded.result
                  : staleWorkspaceResult(),
              );
            }
            return terminalPreparation(indeterminateExecutionResult());
          }
          if (current?.activeExecution) {
            if (current.activeExecution.executionId === executionId) {
              return terminalPreparation(
                current.activeExecution.requestHash === requestHash
                  ? indeterminateExecutionResult()
                  : requestConflictResult(),
              );
            }
            return terminalPreparation(threadBusyResult());
          }

          const startedAt = this.now().toISOString();
          const activeExecution: LogicalThreadActiveExecution = {
            status: LogicalThreadExecutionStatus.Active,
            executionId,
            requestHash,
            startedAt,
          };
          const claimed: LogicalThreadState = {
            threadId,
            generation: current?.generation ?? 0,
            compatibilityHash: input.compatibilityHash,
            ...(current?.providerCheckpoint === undefined
              ? {}
              : { providerCheckpoint: current.providerCheckpoint }),
            activeExecution,
            ...(current?.lastCompletedExecution === undefined
              ? {}
              : { lastCompletedExecution: current.lastCompletedExecution }),
            updatedAt: startedAt,
          };
          await transaction.writeState(claimed);
          await transaction.writeExecution(activeExecution);
          return claimedPreparation(current?.providerCheckpoint);
        },
      });
    } catch (error) {
      return error instanceof LogicalThreadBusyError
        ? threadBusyResult()
        : logicalThreadStateUnavailableResult();
    }
    if (preparation.kind === LogicalThreadPreparationKind.Terminal) {
      return preparation.result;
    }

    let providerResult;
    try {
      providerResult = await input.provider.execute({
        request: input.request,
        ...(preparation.previousCheckpoint === undefined
          ? {}
          : { previousCheckpoint: preparation.previousCheckpoint }),
        signal: input.signal,
      });
    } catch {
      providerResult = {
        result: {
          status: "failed" as const,
          failure: {
            code: AgentRuntimeFailureCode.UnknownRuntimeFailure,
            retryable: true,
            reconnectRequired: false,
            safeMessage: "Provider logical-thread execution failed.",
          },
          warnings: [],
        },
        taskStarted: true,
      };
    }

    const promotable =
      !input.signal.aborted &&
      providerResult.result.status === "completed" &&
      providerResult.candidateCheckpoint !== undefined &&
      providerResult.outcome !== undefined;
    let workspaceEffectFingerprint: string | undefined;
    if (promotable) {
      workspaceEffectFingerprint =
        await input.workspaceEffectFingerprint().catch(() => undefined);
    }
    const timeoutMs = logicalThreadTimeoutMs(input.signal.reason);
    const result = input.signal.aborted
      ? timeoutMs === undefined
        ? cancelledResult(providerResult.taskStarted, providerResult.result)
        : timedOutResult(
            providerResult.taskStarted,
            providerResult.result,
            timeoutMs,
          )
      : promotable && workspaceEffectFingerprint !== undefined
        ? sanitizeProviderSessionTelemetry(
            providerTaskResultToAgentRuntimeTaskResult(providerResult.result, {
              protocolVersion: agentRuntimeTaskProtocolVersionV3,
              thread: {
                id: threadId,
                outcome: providerResult.outcome!,
              },
            }) as AgentRuntimeTaskResultV3,
          )
        : promotable
          ? postExecutionWorkspaceEffectUnavailableResult(
              providerResult.taskStarted,
              providerResult.result,
            )
          : providerResult.result.status === "completed"
          ? missingCheckpointResult(
              providerResult.taskStarted,
              providerResult.result,
            )
          : sanitizeProviderSessionTelemetry(
              providerTaskResultToAgentRuntimeTaskResult(
                providerResult.result,
                {
                  protocolVersion: agentRuntimeTaskProtocolVersionV3,
                  failureLifecycle: failureLifecycle(
                    providerResult.taskStarted,
                  ),
                },
              ) as AgentRuntimeTaskResultV3,
            );

    try {
      return await this.store.withExclusive({
        threadId,
        action: async (transaction) => {
          const current = transaction.readState();
          if (!current || current.compatibilityHash !== input.compatibilityHash) {
            return indeterminateExecutionResult();
          }
          if (current.lastCompletedExecution) {
            await transaction.writeExecution(current.lastCompletedExecution);
          }
          const recorded = await transaction.readExecution(executionId);
          if (
            recorded?.requestHash !== undefined &&
            recorded.requestHash !== requestHash
          ) {
            return requestConflictResult();
          }
          if (recorded?.status === LogicalThreadExecutionStatus.Completed) {
            return recorded.result;
          }
          if (
            current.activeExecution?.executionId !== executionId ||
            current.activeExecution.requestHash !== requestHash
          ) {
            return indeterminateExecutionResult();
          }

          const completedAt = this.now().toISOString();
          const receipt: LogicalThreadCompletedExecution = {
            status: LogicalThreadExecutionStatus.Completed,
            executionId,
            requestHash,
            result,
            ...(result.status === AgentRuntimeTaskResultStatus.Completed &&
            workspaceEffectFingerprint !== undefined
              ? { workspaceEffectFingerprint }
              : {}),
            completedAt,
          };
          const next: LogicalThreadState = {
            threadId,
            generation: current.generation +
              (result.status === AgentRuntimeTaskResultStatus.Completed ? 1 : 0),
            compatibilityHash: input.compatibilityHash,
            ...(result.status === AgentRuntimeTaskResultStatus.Completed
              ? { providerCheckpoint: providerResult.candidateCheckpoint! }
              : current.providerCheckpoint === undefined
                ? {}
                : { providerCheckpoint: current.providerCheckpoint }),
            lastCompletedExecution: receipt,
            updatedAt: completedAt,
          };
          await transaction.writeState(next);
          await transaction.writeExecution(receipt);
          return result;
        },
      });
    } catch (error) {
      return error instanceof LogicalThreadBusyError
        ? threadBusyResult()
        : logicalThreadStateUnavailableResult();
    }
  }
}

export class LogicalThreadTimeoutAbortReason {
  constructor(readonly timeoutMs: number) {}
}

export function logicalThreadTimeoutAbortReason(
  timeoutMs: number,
): LogicalThreadTimeoutAbortReason {
  return new LogicalThreadTimeoutAbortReason(timeoutMs);
}

enum LogicalThreadPreparationKind {
  Terminal = "terminal",
  Claimed = "claimed",
}

type LogicalThreadPreparation =
  | {
      readonly kind: LogicalThreadPreparationKind.Terminal;
      readonly result: AgentRuntimeTaskResultV3;
    }
  | {
      readonly kind: LogicalThreadPreparationKind.Claimed;
      readonly previousCheckpoint?: string;
    };

function terminalPreparation(
  result: AgentRuntimeTaskResultV3,
): LogicalThreadPreparation {
  return { kind: LogicalThreadPreparationKind.Terminal, result };
}

function claimedPreparation(
  previousCheckpoint: string | undefined,
): LogicalThreadPreparation {
  return {
    kind: LogicalThreadPreparationKind.Claimed,
    ...(previousCheckpoint === undefined ? {} : { previousCheckpoint }),
  };
}

export function logicalThreadCompatibilityHash(
  input: Readonly<Record<string, unknown>>,
): string {
  return sha256(stableJson(input));
}

function logicalThreadRequestHash(
  request: AgentRuntimeTaskRequestV3,
): string {
  const { executionId: _executionId, ...payload } = request;
  return sha256(stableJson(payload));
}

function validateCompatibility(
  current: LogicalThreadState | null,
  compatibilityHash: string,
): AgentRuntimeTaskResultV3 | null {
  if (!current || current.compatibilityHash === compatibilityHash) return null;
  return failure(
    AgentRuntimeFailureCode.TaskRequestInvalid,
    "Logical thread is incompatible with the selected runtime context.",
    { control: "thread" },
  );
}

function requestConflictResult(): AgentRuntimeTaskResultV3 {
  return failure(
    AgentRuntimeFailureCode.TaskRequestInvalid,
    "executionId was already used with a different request.",
    { control: "execution_id" },
  );
}

function indeterminateExecutionResult(): AgentRuntimeTaskResultV3 {
  return failure(
    AgentRuntimeFailureCode.StaleGeneration,
    "The previous execution did not reach a durable terminal state.",
    { control: "execution_id" },
  );
}

function staleWorkspaceResult(): AgentRuntimeTaskResultV3 {
  return failure(
    AgentRuntimeFailureCode.StaleGeneration,
    "The completed execution receipt does not match current workspace effects.",
    { control: "workspace_effect" },
  );
}

function threadBusyResult(): AgentRuntimeTaskResultV3 {
  return failure(
    AgentRuntimeFailureCode.StaleGeneration,
    "Logical thread already has an active execution.",
    { control: "thread" },
  );
}

function logicalThreadStateUnavailableResult(): AgentRuntimeTaskResultV3 {
  return failure(
    AgentRuntimeFailureCode.BackendUnavailable,
    "Logical thread state is unavailable.",
  );
}

function missingCheckpointResult(
  taskStarted: boolean,
  providerResult: ProviderTaskResult,
): AgentRuntimeTaskResultV3 {
  return failure(
    AgentRuntimeFailureCode.ProviderOutputInvalid,
    "Provider completed without a durable logical-thread checkpoint.",
    { control: "thread" },
    false,
    taskStarted,
    providerResult,
  );
}

function postExecutionWorkspaceEffectUnavailableResult(
  taskStarted: boolean,
  providerResult: ProviderTaskResult,
): AgentRuntimeTaskResultV3 {
  return failure(
    AgentRuntimeFailureCode.BackendUnavailable,
    "Workspace effect fingerprint is unavailable after provider execution.",
    { control: "workspace_effect" },
    false,
    taskStarted,
    providerResult,
  );
}

function replayWorkspaceEffectUnavailableResult(): AgentRuntimeTaskResultV3 {
  return failure(
    AgentRuntimeFailureCode.BackendUnavailable,
    "Workspace effect fingerprint is unavailable for replay.",
    { control: "workspace_effect" },
    true,
  );
}

function cancelledResult(
  taskStarted: boolean,
  providerResult: ProviderTaskResult,
): AgentRuntimeTaskResultV3 {
  return failure(
    AgentRuntimeFailureCode.TaskCancelled,
    "Agent runtime task was cancelled.",
    undefined,
    false,
    taskStarted,
    providerResult,
  );
}

function timedOutResult(
  taskStarted: boolean,
  providerResult: ProviderTaskResult,
  timeoutMs: number,
): AgentRuntimeTaskResultV3 {
  return failure(
    AgentRuntimeFailureCode.TaskTimeout,
    `Agent runtime task timed out after ${timeoutMs}ms.`,
    undefined,
    false,
    taskStarted,
    providerResult,
  );
}

function failure(
  code: AgentRuntimeFailureCode,
  safeMessage: string,
  details?: Readonly<Record<string, string>>,
  retryable = false,
  taskStarted = false,
  providerResult?: ProviderTaskResult,
): AgentRuntimeTaskResultV3 {
  return sanitizeProviderSessionTelemetry(
    makeFailedAgentRuntimeTaskResult({
      protocolVersion: agentRuntimeTaskProtocolVersionV3,
      code,
      safeMessage,
      retryable,
      lifecycle: failureLifecycle(taskStarted),
      ...(details === undefined ? {} : { details }),
      ...(providerResult?.telemetry === undefined
        ? {}
        : { telemetry: providerResult.telemetry }),
      ...(providerResult === undefined
        ? {}
        : { warnings: providerResult.warnings }),
    }) as AgentRuntimeTaskResultV3,
  );
}

function failureLifecycle(
  taskStarted: boolean,
): AgentRuntimeFailureLifecycle {
  return taskStarted
    ? {
        state: AgentRuntimeFailureLifecycleState.ExecutionFailed as const,
        taskStarted: true,
      }
    : {
        state: AgentRuntimeFailureLifecycleState.PreflightFailed as const,
        taskStarted: false,
      };
}

function sanitizeProviderSessionTelemetry(
  result: AgentRuntimeTaskResultV3,
): AgentRuntimeTaskResultV3 {
  if (!result.telemetry?.providerSessionId) return result;
  const { providerSessionId: _providerSessionId, ...telemetry } =
    result.telemetry;
  return { ...result, telemetry };
}

function logicalThreadTimeoutMs(reason: unknown): number | undefined {
  return reason instanceof LogicalThreadTimeoutAbortReason &&
      Number.isSafeInteger(reason.timeoutMs) &&
      reason.timeoutMs >= 0
    ? reason.timeoutMs
    : undefined;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}
