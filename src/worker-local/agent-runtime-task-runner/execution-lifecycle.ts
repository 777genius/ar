import {
  AgentRuntimeFailureCode,
  AgentRuntimeFailureLifecycleState,
  AgentRuntimePendingAuthority,
  agentRuntimeTaskProtocolVersionV1,
  agentRuntimeTaskProtocolVersionV3,
  agentRuntimeTaskRequestToProviderTask,
  makeFailedAgentRuntimeTaskResult,
  type AgentRuntimeTaskProtocolVersion,
  type AgentRuntimeTaskRequest,
  type AgentRuntimeTaskResult,
} from "@vioxen/subscription-runtime/agent-runtime-task";
import type { ProviderName, AgentRuntimeTaskWorker } from "./ports";
import { AgentRuntimeTaskProvider } from "./ports";
import { compileCodexExecutionPlan } from "./codex-execution-plan";

export async function runWorkerTaskWithTimeout(input: {
  readonly timeoutMs?: number;
  readonly reportedTimeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly settlementTimeoutMs?: number;
  readonly authoritativeTimeoutAbortReason?: (timeoutMs: number) => unknown;
  readonly run: (abortSignal: AbortSignal) => Promise<AgentRuntimeTaskResult>;
}): Promise<AgentRuntimeTaskResult> {
  const abortController = new AbortController();
  let run: Promise<AgentRuntimeTaskResult> | undefined;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let removeAbortListener = (): void => {};
  try {
    if (input.signal?.aborted) {
      abortController.abort();
      return makeCancelledAgentRuntimeTaskResult();
    }

    run = input.run(abortController.signal);
    run.catch(() => undefined);
    const races: Promise<AgentRuntimeTaskResult>[] = [run];

    if (input.timeoutMs !== undefined) {
      races.push(new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          const error = new AgentRuntimeTaskTimeoutError(
            input.reportedTimeoutMs ?? input.timeoutMs!,
          );
          abortController.abort(
            input.authoritativeTimeoutAbortReason?.(error.timeoutMs),
          );
          reject(error);
        }, input.timeoutMs);
      }));
    }
    if (input.signal) {
      races.push(new Promise<never>((_, reject) => {
        const onAbort = () => {
          abortController.abort();
          reject(new AgentRuntimeTaskCancelledError());
        };
        input.signal!.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () =>
          input.signal!.removeEventListener("abort", onAbort);
      }));
    }

    return await Promise.race(races);
  } catch (error) {
    if (error instanceof AgentRuntimeTaskTimeoutError) {
      if (run && input.settlementTimeoutMs !== undefined) {
        const settlement = await settleWithin(run, input.settlementTimeoutMs);
        if (settlement.status === PromiseSettlementStatus.Pending) {
          return makeCleanupUnconfirmedResult(
            AgentRuntimeCleanupUnconfirmedReason.TaskSettlement,
          );
        }
        if (
          input.authoritativeTimeoutAbortReason &&
          settlement.status === PromiseSettlementStatus.Fulfilled
        ) {
          return settlement.value;
        }
      }
      return makeTimeoutAgentRuntimeTaskResult(error.timeoutMs);
    }
    if (error instanceof AgentRuntimeTaskCancelledError) {
      if (
        run && input.settlementTimeoutMs !== undefined &&
        (await settleWithin(run, input.settlementTimeoutMs)).status ===
          PromiseSettlementStatus.Pending
      ) {
        return makeCleanupUnconfirmedResult(
          AgentRuntimeCleanupUnconfirmedReason.TaskSettlement,
        );
      }
      return makeCancelledAgentRuntimeTaskResult();
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
    removeAbortListener();
  }
}

export class AgentRuntimeTaskPreflightDeadline {
  readonly signal: AbortSignal;
  timedOut = false;

  private readonly startedAt = Date.now();
  private readonly abortController = new AbortController();
  private readonly aborted: Promise<never>;
  private abortListener: (() => void) | undefined;
  private timeout: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly timeoutMs: number | undefined,
    parentSignal: AbortSignal,
  ) {
    this.signal = AbortSignal.any([
      parentSignal,
      this.abortController.signal,
    ]);
    this.aborted = new Promise<never>((_, reject) => {
      const onAbort = (): void => {
        reject(
          this.timedOut && this.timeoutMs !== undefined
            ? new AgentRuntimeTaskTimeoutError(this.timeoutMs)
            : new AgentRuntimeTaskCancelledError(),
        );
      };
      this.abortListener = onAbort;
      if (this.signal.aborted) onAbort();
      else this.signal.addEventListener("abort", onAbort, { once: true });
    });
    if (timeoutMs !== undefined) {
      this.timeout = setTimeout(() => {
        this.timedOut = true;
        this.abortController.abort();
      }, timeoutMs);
    }
  }

  async race<T>(operation: Promise<T>): Promise<T> {
    return await Promise.race([operation, this.aborted]);
  }

  remainingTimeoutMs(): number | undefined {
    if (this.timeoutMs === undefined) return undefined;
    return Math.max(0, this.timeoutMs - (Date.now() - this.startedAt));
  }

  dispose(): void {
    if (this.abortListener) {
      this.signal.removeEventListener("abort", this.abortListener);
      this.abortListener = undefined;
    }
    if (this.timeout !== undefined) {
      clearTimeout(this.timeout);
      this.timeout = undefined;
    }
  }
}

export function makeCancelledAgentRuntimeTaskResult(): AgentRuntimeTaskResult {
  return makeFailedAgentRuntimeTaskResult({
    code: AgentRuntimeFailureCode.TaskCancelled,
    safeMessage: "Agent runtime task was cancelled.",
  });
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new AgentRuntimeTaskCancelledError();
}

export async function disposeWorker(input: {
  readonly worker: AgentRuntimeTaskWorker;
  readonly timeoutMs?: number;
  readonly onDisposeError?: (message: string) => void;
}): Promise<string | undefined> {
  if (!input.worker.dispose) return undefined;
  const timeoutMs = input.timeoutMs ?? 5_000;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    const dispose = Promise.resolve().then(() => input.worker.dispose?.());
    dispose.catch(() => undefined);
    await Promise.race([
      dispose,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`subscription_worker_dispose_timeout:${timeoutMs}`));
        }, timeoutMs);
      }),
    ]);
    return undefined;
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : "subscription worker dispose failed";
    input.onDisposeError?.(message);
    return message;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function resultForProtocol(
  result: AgentRuntimeTaskResult,
  protocolVersion: AgentRuntimeTaskProtocolVersion,
  taskStarted: boolean,
  pendingAuthorities: readonly [
    AgentRuntimePendingAuthority,
    ...AgentRuntimePendingAuthority[],
  ],
): AgentRuntimeTaskResult {
  if (protocolVersion === agentRuntimeTaskProtocolVersionV1) {
    return { ...result, protocolVersion } as AgentRuntimeTaskResult;
  }
  if (result.status !== "failed") {
    return { ...result, protocolVersion } as AgentRuntimeTaskResult;
  }
  if (result.failure.code === AgentRuntimeFailureCode.CleanupUnconfirmed) {
    return {
      ...result,
      protocolVersion,
      lifecycle: {
        state: AgentRuntimeFailureLifecycleState.CleanupUnconfirmed,
        taskStarted,
        pendingAuthorities,
      },
    } as AgentRuntimeTaskResult;
  }
  if (
    protocolVersion === agentRuntimeTaskProtocolVersionV3 &&
    result.protocolVersion === agentRuntimeTaskProtocolVersionV3
  ) {
    return result;
  }
  return {
    ...result,
    protocolVersion,
    lifecycle: taskStarted
      ? {
          state: AgentRuntimeFailureLifecycleState.ExecutionFailed,
          taskStarted: true,
        }
      : {
          state: AgentRuntimeFailureLifecycleState.PreflightFailed,
          taskStarted: false,
        },
  } as AgentRuntimeTaskResult;
}

export function pendingAuthoritiesForRequest(
  request: AgentRuntimeTaskRequest,
  provider: ProviderName,
): readonly [
  AgentRuntimePendingAuthority,
  ...AgentRuntimePendingAuthority[],
] {
  const common = [
    AgentRuntimePendingAuthority.ProviderProcess,
    AgentRuntimePendingAuthority.ProviderSession,
  ] as const;
  if (provider !== AgentRuntimeTaskProvider.Codex) return common;
  try {
    const plan = compileCodexExecutionPlan(
      agentRuntimeTaskRequestToProviderTask(request),
    );
    return plan?.workspaceToolPolicy
      ? [...common, AgentRuntimePendingAuthority.ToolServer]
      : common;
  } catch {
    return common;
  }
}

enum PromiseSettlementStatus {
  Fulfilled = "fulfilled",
  Rejected = "rejected",
  Pending = "pending",
}

type PromiseSettlement<T> =
  | {
      readonly status: PromiseSettlementStatus.Fulfilled;
      readonly value: T;
    }
  | {
      readonly status:
        | PromiseSettlementStatus.Rejected
        | PromiseSettlementStatus.Pending;
    };

async function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<PromiseSettlement<T>> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        (value) => ({
          status: PromiseSettlementStatus.Fulfilled,
          value,
        }) as const,
        () => ({ status: PromiseSettlementStatus.Rejected }) as const,
      ),
      new Promise<{
        readonly status: PromiseSettlementStatus.Pending;
      }>((resolve) => {
        timeout = setTimeout(
          () => resolve({ status: PromiseSettlementStatus.Pending }),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export class AgentRuntimeTaskTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Agent runtime task timed out after ${timeoutMs}ms.`);
    this.name = "AgentRuntimeTaskTimeoutError";
  }
}

export class AgentRuntimeTaskCancelledError extends Error {
  constructor() {
    super("Agent runtime task was cancelled.");
    this.name = "AgentRuntimeTaskCancelledError";
  }
}

export function makeTimeoutAgentRuntimeTaskResult(
  timeoutMs: number,
): AgentRuntimeTaskResult {
  return makeFailedAgentRuntimeTaskResult({
    code: AgentRuntimeFailureCode.TaskTimeout,
    safeMessage: `Agent runtime task timed out after ${timeoutMs}ms.`,
  });
}

enum AgentRuntimeCleanupUnconfirmedReason {
  TaskSettlement = "task_settlement_timeout",
  WorkerDispose = "worker_dispose_unconfirmed",
}

export function makeWorkerDisposeUnconfirmedResult(): AgentRuntimeTaskResult {
  return makeCleanupUnconfirmedResult(
    AgentRuntimeCleanupUnconfirmedReason.WorkerDispose,
  );
}

function makeCleanupUnconfirmedResult(
  reason: AgentRuntimeCleanupUnconfirmedReason,
): AgentRuntimeTaskResult {
  return makeFailedAgentRuntimeTaskResult({
    code: AgentRuntimeFailureCode.CleanupUnconfirmed,
    safeMessage:
      "Agent runtime cleanup could not be confirmed after task execution.",
    details: { cleanup: reason },
  });
}
