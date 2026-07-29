import { describe, expect, it } from "vitest";
import {
  AgentRuntimeExecutionMode,
  AgentRuntimeFailureCode,
  AgentRuntimeTaskResultStatus,
  type ProviderTaskResult,
} from "@vioxen/subscription-runtime/core";
import {
  AgentRuntimeFailureLifecycleState,
  AgentRuntimeThreadOutcome,
  agentRuntimeTaskProtocolVersionV3,
  makeFailedAgentRuntimeTaskResult,
  type AgentRuntimeTaskRequestV3,
} from "@vioxen/subscription-runtime/agent-runtime-task";
import {
  LogicalThreadBusyError,
  LogicalThreadCoordinator,
  LogicalThreadExecutionStatus,
  type LogicalThreadExecutionRecord,
  type LogicalThreadState,
  type LogicalThreadStore,
  type LogicalThreadTransaction,
  type ProviderThreadPort,
} from "../logical-thread";

describe("LogicalThreadCoordinator", () => {
  it("continues from a promoted checkpoint and exactly replays a matching receipt", async () => {
    const store = new MemoryLogicalThreadStore();
    const checkpoints: Array<string | undefined> = [];
    let calls = 0;
    const provider: ProviderThreadPort = {
      execute: async ({ previousCheckpoint }) => {
        checkpoints.push(previousCheckpoint);
        calls += 1;
        return {
          result: completed(`result-${calls}`),
          taskStarted: true,
          candidateCheckpoint: `checkpoint-${calls}`,
          outcome: previousCheckpoint === undefined
            ? AgentRuntimeThreadOutcome.StartedFresh
            : AgentRuntimeThreadOutcome.Continued,
        };
      },
    };
    const coordinator = new LogicalThreadCoordinator(store);

    const first = await coordinator.execute(execution("exec-1", provider));
    const secondInput = execution("exec-2", provider);
    const second = await coordinator.execute(secondInput);
    const replay = await coordinator.execute(secondInput);

    expect(first).toMatchObject({
      status: AgentRuntimeTaskResultStatus.Completed,
      thread: {
        id: "thread-1",
        outcome: AgentRuntimeThreadOutcome.StartedFresh,
      },
    });
    expect(second).toMatchObject({
      status: AgentRuntimeTaskResultStatus.Completed,
      thread: {
        id: "thread-1",
        outcome: AgentRuntimeThreadOutcome.Continued,
      },
    });
    expect(replay).toEqual(second);
    expect(checkpoints).toEqual([undefined, "checkpoint-1"]);
    expect(calls).toBe(2);
  });

  it("fails closed when a replay receipt no longer matches workspace effects", async () => {
    const coordinator = new LogicalThreadCoordinator(
      new MemoryLogicalThreadStore(),
    );
    let fingerprint = "workspace-a";
    let calls = 0;
    const provider: ProviderThreadPort = {
      execute: async () => {
        calls += 1;
        return {
          result: completed("done"),
          taskStarted: true,
          candidateCheckpoint: "checkpoint",
          outcome: AgentRuntimeThreadOutcome.StartedFresh,
        };
      },
    };
    const input = execution("exec-1", provider, () =>
      Promise.resolve(fingerprint));
    await coordinator.execute(input);
    fingerprint = "workspace-b";

    const replay = await coordinator.execute(input);

    expect(replay).toMatchObject({
      status: AgentRuntimeTaskResultStatus.Failed,
      failure: { code: AgentRuntimeFailureCode.StaleGeneration },
      lifecycle: {
        state: AgentRuntimeFailureLifecycleState.PreflightFailed,
        taskStarted: false,
      },
    });
    expect(calls).toBe(1);
  });

  it("reports a retryable workspace backend failure when replay fingerprinting is unavailable", async () => {
    const coordinator = new LogicalThreadCoordinator(
      new MemoryLogicalThreadStore(),
    );
    let fingerprintAvailable = true;
    let calls = 0;
    const provider: ProviderThreadPort = {
      execute: async () => {
        calls += 1;
        return {
          result: completed("done"),
          taskStarted: true,
          candidateCheckpoint: "checkpoint",
          outcome: AgentRuntimeThreadOutcome.StartedFresh,
        };
      },
    };
    const input = execution("exec-1", provider, () =>
      fingerprintAvailable
        ? Promise.resolve("workspace-a")
        : Promise.reject(new Error("fingerprint unavailable")));
    await coordinator.execute(input);
    fingerprintAvailable = false;

    const replay = await coordinator.execute(input);

    expect(replay).toMatchObject({
      status: AgentRuntimeTaskResultStatus.Failed,
      failure: {
        code: AgentRuntimeFailureCode.BackendUnavailable,
        retryable: true,
        details: { control: "workspace_effect" },
      },
      lifecycle: {
        state: AgentRuntimeFailureLifecycleState.PreflightFailed,
        taskStarted: false,
      },
    });
    expect(calls).toBe(1);
  });

  it("rejects execution id reuse with a different request", async () => {
    const coordinator = new LogicalThreadCoordinator(
      new MemoryLogicalThreadStore(),
    );
    const provider = successfulProvider();
    await coordinator.execute(execution("same-exec", provider));

    const result = await coordinator.execute({
      ...execution("same-exec", provider),
      request: request("same-exec", "different prompt"),
    });

    expect(result).toMatchObject({
      status: AgentRuntimeTaskResultStatus.Failed,
      failure: { code: AgentRuntimeFailureCode.TaskRequestInvalid },
    });
  });

  it("does not promote a failed, waiting or cancelled provider execution", async () => {
    const coordinator = new LogicalThreadCoordinator(
      new MemoryLogicalThreadStore(),
    );
    const seen: Array<string | undefined> = [];
    await coordinator.execute(execution("failed", {
      execute: async ({ previousCheckpoint }) => {
        seen.push(previousCheckpoint);
        return {
          result: failedProvider(),
          taskStarted: true,
          candidateCheckpoint: "must-not-promote",
          outcome: AgentRuntimeThreadOutcome.StartedFresh,
        };
      },
    }));
    const waiting = await coordinator.execute(execution("waiting", {
      execute: async ({ previousCheckpoint }) => {
        seen.push(previousCheckpoint);
        return {
          result: waitingProvider(),
          taskStarted: true,
          candidateCheckpoint: "must-not-promote-either",
          outcome: AgentRuntimeThreadOutcome.StartedFresh,
        };
      },
    }));
    const controller = new AbortController();
    const cancelled = await coordinator.execute({
      ...execution("cancelled", {
        execute: async ({ previousCheckpoint }) => {
          seen.push(previousCheckpoint);
          controller.abort();
          return {
            result: completed("late success"),
            taskStarted: true,
            candidateCheckpoint: "must-not-promote-on-abort",
            outcome: AgentRuntimeThreadOutcome.StartedFresh,
          };
        },
      }),
      signal: controller.signal,
    });
    const final = await coordinator.execute(
      execution("after-failures", successfulProvider(seen)),
    );

    expect(waiting).toMatchObject({
      status: AgentRuntimeTaskResultStatus.Failed,
      failure: { code: AgentRuntimeFailureCode.ProviderOutputInvalid },
    });
    expect(cancelled).toMatchObject({
      status: AgentRuntimeTaskResultStatus.Failed,
      failure: { code: AgentRuntimeFailureCode.TaskCancelled },
    });
    expect(final).toMatchObject({
      status: AgentRuntimeTaskResultStatus.Completed,
      thread: { outcome: AgentRuntimeThreadOutcome.StartedFresh },
    });
    expect(seen).toEqual([undefined, undefined, undefined, undefined]);
  });

  it("fails fast while another execution is active without holding the store lock during provider work", async () => {
    const store = new MemoryLogicalThreadStore();
    const coordinator = new LogicalThreadCoordinator(store);
    const gate = deferred<void>();
    let lockHeldDuringProvider: boolean | undefined;
    const provider: ProviderThreadPort = {
      execute: async () => {
        lockHeldDuringProvider = store.exclusiveActive;
        await gate.promise;
        return {
          result: completed("done"),
          taskStarted: true,
          candidateCheckpoint: "checkpoint",
          outcome: AgentRuntimeThreadOutcome.StartedFresh,
        };
      },
    };

    const first = coordinator.execute(execution("exec-1", provider));
    await store.locked.promise;
    const concurrent = await coordinator.execute(execution("exec-2", provider));
    gate.resolve();
    await first;

    expect(concurrent).toMatchObject({
      status: AgentRuntimeTaskResultStatus.Failed,
      failure: {
        code: AgentRuntimeFailureCode.StaleGeneration,
        retryable: false,
      },
    });
    expect(lockHeldDuringProvider).toBe(false);
  });

  it("persists the exact startup versus post-start failure lifecycle", async () => {
    const coordinator = new LogicalThreadCoordinator(
      new MemoryLogicalThreadStore(),
    );
    const startupInput = execution("startup", {
      execute: async () => ({
        result: failedProvider(),
        taskStarted: false,
      }),
    });
    const executionInput = execution("execution", {
      execute: async () => ({
        result: failedProvider(),
        taskStarted: true,
      }),
    });

    const startup = await coordinator.execute(startupInput);
    const startupReplay = await coordinator.execute(startupInput);
    const executionFailure = await coordinator.execute(executionInput);
    const executionReplay = await coordinator.execute(executionInput);

    expect(startup).toMatchObject({
      lifecycle: {
        state: AgentRuntimeFailureLifecycleState.PreflightFailed,
        taskStarted: false,
      },
    });
    expect(startupReplay).toEqual(startup);
    expect(executionFailure).toMatchObject({
      lifecycle: {
        state: AgentRuntimeFailureLifecycleState.ExecutionFailed,
        taskStarted: true,
      },
    });
    expect(executionReplay).toEqual(executionFailure);
  });

  it.each([
    [
      "missing checkpoint",
      false,
      false,
      AgentRuntimeFailureCode.ProviderOutputInvalid,
    ],
    [
      "workspace fingerprint failure",
      true,
      false,
      AgentRuntimeFailureCode.BackendUnavailable,
    ],
    ["cancellation", true, true, AgentRuntimeFailureCode.TaskCancelled],
  ])("preserves safe provider evidence on %s", async (
    _label,
    withCheckpoint,
    cancel,
    expectedCode,
  ) => {
    const store = new MemoryLogicalThreadStore();
    const coordinator = new LogicalThreadCoordinator(store);
    const controller = new AbortController();
    const provider: ProviderThreadPort = {
      execute: async () => {
        if (cancel) controller.abort();
        return {
          result: completedWithEvidence(),
          taskStarted: true,
          ...(withCheckpoint
            ? {
                candidateCheckpoint: "checkpoint",
                outcome: AgentRuntimeThreadOutcome.StartedFresh,
              }
            : {}),
        };
      },
    };
    const result = await coordinator.execute({
      ...execution(
        `evidence-${_label}`,
        provider,
        withCheckpoint && !cancel
          ? () => Promise.reject(new Error("fingerprint failed"))
          : () => Promise.resolve("workspace-a"),
      ),
      signal: controller.signal,
    });

    expect(result).toMatchObject({
      status: AgentRuntimeTaskResultStatus.Failed,
      failure: { code: expectedCode },
      lifecycle: {
        state: AgentRuntimeFailureLifecycleState.ExecutionFailed,
        taskStarted: true,
      },
      telemetry: { durationMs: 42 },
      warnings: [
        { code: "control-warning" },
        { code: "worker-warning" },
      ],
    });
    if (expectedCode === AgentRuntimeFailureCode.BackendUnavailable) {
      expect(result).toMatchObject({
        failure: {
          retryable: false,
          details: { control: "workspace_effect" },
        },
      });
    }
    expect(result.telemetry).not.toHaveProperty("providerSessionId");
  });
});

function execution(
  executionId: string,
  provider: ProviderThreadPort,
  fingerprint: () => Promise<string> = () => Promise.resolve("workspace-a"),
) {
  return {
    request: request(executionId),
    compatibilityHash: "runtime-a",
    provider,
    signal: new AbortController().signal,
    workspaceEffectFingerprint: fingerprint,
  };
}

function request(
  executionId: string,
  prompt = "continue",
): AgentRuntimeTaskRequestV3 {
  return {
    protocolVersion: agentRuntimeTaskProtocolVersionV3,
    executionId,
    thread: { id: "thread-1" },
    task: {
      kind: "structured-prompt",
      prompt,
      execution: {
        mode: AgentRuntimeExecutionMode.Goal,
        completionCondition: "finish the task",
      },
    },
  };
}

function completed(outputText: string): ProviderTaskResult {
  return {
    status: "completed",
    outputText,
    warnings: [],
  };
}

function completedWithEvidence(): ProviderTaskResult {
  return {
    status: "completed",
    outputText: "done",
    telemetry: {
      durationMs: 42,
      providerSessionId: "provider-session-must-not-leak",
    },
    warnings: [
      {
        code: "control-warning",
        safeMessage: "Control warning.",
      },
      {
        code: "worker-warning",
        safeMessage: "Worker warning.",
      },
    ],
  };
}

function failedProvider(): ProviderTaskResult {
  return {
    status: "failed",
    failure: {
      code: AgentRuntimeFailureCode.UnknownRuntimeFailure,
      retryable: true,
      reconnectRequired: false,
      safeMessage: "failed",
    },
    warnings: [],
  };
}

function waitingProvider(): ProviderTaskResult {
  return {
    status: "waiting_for_input",
    runId: "run-1",
    outputText: "",
    request: {
      id: "request-1",
      kind: "decision_required",
      question: "input",
      audience: "orchestrator",
    },
    resumeHandle: {
      providerId: "codex",
      runId: "run-1",
      workspacePath: "/workspace",
    },
    warnings: [],
  };
}

function successfulProvider(
  seen?: Array<string | undefined>,
): ProviderThreadPort {
  return {
    execute: async ({ previousCheckpoint }) => {
      seen?.push(previousCheckpoint);
      return {
        result: completed("ok"),
        taskStarted: true,
        candidateCheckpoint: "checkpoint",
        outcome: previousCheckpoint === undefined
          ? AgentRuntimeThreadOutcome.StartedFresh
          : AgentRuntimeThreadOutcome.Continued,
      };
    },
  };
}

class MemoryLogicalThreadStore implements LogicalThreadStore {
  private active = false;
  private state: LogicalThreadState | null = null;
  private readonly executions = new Map<string, LogicalThreadExecutionRecord>();
  readonly locked = deferred<void>();

  get exclusiveActive(): boolean {
    return this.active;
  }

  async withExclusive<T>(input: {
    readonly threadId: string;
    readonly action: (transaction: LogicalThreadTransaction) => Promise<T>;
  }): Promise<T> {
    if (this.active) throw new LogicalThreadBusyError(input.threadId);
    this.active = true;
    this.locked.resolve();
    try {
      return await input.action({
        readState: () => this.state,
        readExecution: async (executionId) =>
          this.executions.get(executionId) ?? null,
        writeState: async (state) => {
          this.state = state;
        },
        writeExecution: async (record) => {
          this.executions.set(record.executionId, record);
        },
      });
    } finally {
      this.active = false;
    }
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
