import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AgentRuntimeAccessBoundary,
  AgentRuntimeBudgetMetric,
  AgentRuntimeExecutionMode,
  AgentRuntimeFailureCode,
  AgentRuntimeTool,
  ProviderLogicalThreadOutcome,
} from "@vioxen/subscription-runtime/core";
import {
  AgentRuntimeFailureLifecycleState,
  AgentRuntimeThreadOutcome,
  agentRuntimeTaskProtocolVersionV3,
  type AgentRuntimeTaskRequestV3,
  type JsonObject,
} from "@vioxen/subscription-runtime/agent-runtime-task";
import {
  AgentRuntimeTaskProvider,
  AuthSourceKind,
  createLocalAgentRuntimeTaskRunner,
  type AgentRuntimeTaskWorkerFactory,
} from "../agent-runtime-task-runner";
import {
  AgentRuntimeTaskReasoningEffort,
  AgentRuntimeTaskServiceTier,
} from "../../agent-runtime-task-runner/domain";

const execFileAsync = promisify(execFile);

describe("local AgentRuntimeTaskRunner logical threads", () => {
  it("continues typed provider checkpoints and replays only exact workspace effects", async () => {
    const root = await gitFixture();
    const stateRootDir = await mkdtemp(
      join(tmpdir(), "agent-runtime-thread-state-"),
    );
    let starts = 0;
    let runs = 0;
    const seenCheckpoints: Array<string | undefined> = [];
    const workerFactory: AgentRuntimeTaskWorkerFactory = (factoryInput) => ({
      async start() {
        starts += 1;
      },
      async run(job, options) {
        runs += 1;
        await options?.onProviderTaskStarted?.();
        const logicalThread = job.logicalThread;
        seenCheckpoints.push(logicalThread?.previousCheckpoint);
        await writeFile(join(factoryInput.cwd, "effect.txt"), `${job.prompt}\n`);
        await logicalThread?.onCheckpoint({
          checkpoint: `provider-checkpoint-${runs}`,
          outcome: logicalThread.previousCheckpoint === undefined
            ? ProviderLogicalThreadOutcome.StartedFresh
            : ProviderLogicalThreadOutcome.Continued,
        });
        return {
          outputText: `worker:${job.prompt}`,
          warnings: [],
        };
      },
      async dispose() {},
    });
    const runner = createLocalAgentRuntimeTaskRunner({
      provider: AgentRuntimeTaskProvider.Claude,
      stateRootDir,
      encryptionKey: "legacy-session-key",
      workspaceRoot: root,
      env: {},
      authSource: { kind: AuthSourceKind.PreseededSession },
      workerFactory,
    });
    const firstRequest = request("execution-1", "first");
    const secondRequest = request("execution-2", "second");
    try {
      const first = await runner.run(firstRequest);
      const replay = await runner.run(firstRequest);
      const second = await runner.run(secondRequest);

      expect(first).toMatchObject({
        protocolVersion: 3,
        status: "completed",
        thread: {
          id: "thread-1",
          outcome: AgentRuntimeThreadOutcome.StartedFresh,
        },
      });
      expect(replay).toEqual(first);
      expect(second).toMatchObject({
        status: "completed",
        thread: { outcome: AgentRuntimeThreadOutcome.Continued },
      });
      expect(starts).toBe(2);
      expect(runs).toBe(2);
      expect(seenCheckpoints).toEqual([
        undefined,
        "provider-checkpoint-1",
      ]);

      await writeFile(join(root, "effect.txt"), "externally changed\n");
      const staleReplay = await runner.run(secondRequest);
      expect(staleReplay).toMatchObject({
        status: "failed",
        failure: {
          code: AgentRuntimeFailureCode.StaleGeneration,
          retryable: false,
        },
        lifecycle: {
          state: AgentRuntimeFailureLifecycleState.PreflightFailed,
          taskStarted: false,
        },
      });
      expect(runs).toBe(2);
    } finally {
      await runner.dispose();
      await rm(root, { recursive: true, force: true });
      await rm(stateRootDir, { recursive: true, force: true });
    }
  });

  it("preserves preflight versus execution failure lifecycle through durable receipts", async () => {
    const root = await gitFixture();
    const stateRootDir = await mkdtemp(
      join(tmpdir(), "agent-runtime-thread-state-"),
    );
    let mode: "startup" | "execution" = "startup";
    const workerFactory: AgentRuntimeTaskWorkerFactory = () => ({
      async start() {
        if (mode === "startup") throw new Error("startup failed");
      },
      async run(_job, options) {
        await options?.onProviderTaskStarted?.();
        throw new Error("execution failed");
      },
      async dispose() {},
    });
    const runner = createLocalAgentRuntimeTaskRunner({
      provider: AgentRuntimeTaskProvider.Claude,
      stateRootDir,
      encryptionKey: "legacy-session-key",
      workspaceRoot: root,
      env: {},
      workerFactory,
    });
    try {
      const startupRequest = request(
        "startup-execution",
        "startup",
        "startup-thread",
      );
      const startup = await runner.run(startupRequest);
      const startupReplay = await runner.run(startupRequest);
      mode = "execution";
      const executionRequest = request(
        "provider-execution",
        "execution",
        "execution-thread",
      );
      const executionFailure = await runner.run(executionRequest);
      const executionReplay = await runner.run(executionRequest);

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
    } finally {
      await runner.dispose();
      await rm(root, { recursive: true, force: true });
      await rm(stateRootDir, { recursive: true, force: true });
    }
  });

  it("persists one authoritative timeout result for exact replay", async () => {
    const root = await gitFixture();
    const stateRootDir = await mkdtemp(
      join(tmpdir(), "agent-runtime-thread-timeout-state-"),
    );
    let runs = 0;
    const workerFactory: AgentRuntimeTaskWorkerFactory = () => ({
      async start() {},
      async run(job, options) {
        runs += 1;
        await options?.onProviderTaskStarted?.();
        if (!job.abortSignal) throw new Error("expected abort signal");
        await aborted(job.abortSignal);
        return {
          outputText: "stopped after timeout",
          warnings: [],
        };
      },
      async dispose() {},
    });
    const runner = createLocalAgentRuntimeTaskRunner({
      provider: AgentRuntimeTaskProvider.Claude,
      stateRootDir,
      encryptionKey: "legacy-session-key",
      workspaceRoot: root,
      env: {},
      workerFactory,
    });
    const timedRequest = {
      ...request("timeout-execution", "timeout", "timeout-thread"),
      timeoutMs: 250,
    };
    try {
      const first = await runner.run(timedRequest);
      const replay = await runner.run(timedRequest);

      expect(first).toMatchObject({
        protocolVersion: 3,
        status: "failed",
        failure: {
          code: AgentRuntimeFailureCode.TaskTimeout,
          retryable: false,
        },
        lifecycle: {
          state: AgentRuntimeFailureLifecycleState.ExecutionFailed,
          taskStarted: true,
        },
      });
      expect(replay).toEqual(first);
      expect(runs).toBe(1);
    } finally {
      await runner.dispose();
      await rm(root, { recursive: true, force: true });
      await rm(stateRootDir, { recursive: true, force: true });
    }
  });

  it("rejects Codex execution-profile drift on a durable logical thread", async () => {
    const root = await gitFixture();
    const stateRootDir = await mkdtemp(
      join(tmpdir(), "agent-runtime-thread-profile-state-"),
    );
    let runs = 0;
    const workerFactory: AgentRuntimeTaskWorkerFactory = () => ({
      async start() {},
      async run(job, options) {
        runs += 1;
        await options?.onProviderTaskStarted?.();
        await job.logicalThread?.onCheckpoint({
          checkpoint: `profile-checkpoint-${runs}`,
          outcome: job.logicalThread.previousCheckpoint === undefined
            ? ProviderLogicalThreadOutcome.StartedFresh
            : ProviderLogicalThreadOutcome.Continued,
        });
        return { outputText: "ok", warnings: [] };
      },
      async dispose() {},
    });
    const common = {
      provider: AgentRuntimeTaskProvider.Codex,
      stateRootDir,
      encryptionKey: "legacy-session-key",
      workspaceRoot: root,
      env: {},
      workerFactory,
      codexRuntimeFeatureProbe: { async supports() { return true; } },
    } as const;
    const baseline = createLocalAgentRuntimeTaskRunner(common);
    const legacyCompatible = createLocalAgentRuntimeTaskRunner(common);
    const high = createLocalAgentRuntimeTaskRunner({
      ...common,
      reasoningEffort: AgentRuntimeTaskReasoningEffort.High,
    });
    const highDefault = createLocalAgentRuntimeTaskRunner({
      ...common,
      reasoningEffort: AgentRuntimeTaskReasoningEffort.High,
      serviceTier: AgentRuntimeTaskServiceTier.Default,
    });
    try {
      const legacyRequest = codexRequest("profile-1", "effort-thread");
      const first = await baseline.run(legacyRequest);
      expect(first).toMatchObject({ status: "completed" });
      expect(await legacyCompatible.run(legacyRequest)).toEqual(first);
      expect(
        await legacyCompatible.run(codexRequest("profile-2", "effort-thread")),
      ).toMatchObject({
        status: "completed",
        thread: { outcome: AgentRuntimeThreadOutcome.Continued },
      });
      expect(await high.run(codexRequest("profile-3", "effort-thread")))
        .toMatchObject({
          status: "failed",
          failure: { code: AgentRuntimeFailureCode.TaskRequestInvalid },
        });
      expect(await high.run(codexRequest("profile-4", "service-thread")))
        .toMatchObject({
          status: "completed",
        });
      expect(
        await highDefault.run(codexRequest("profile-5", "service-thread")),
      ).toMatchObject({
        protocolVersion: 3,
        status: "failed",
        failure: { code: AgentRuntimeFailureCode.TaskRequestInvalid },
      });
      const schema = {
        type: "object",
        properties: {
          verdict: { type: "string" },
          score: { type: "number" },
        },
      } as const;
      expect(await high.run(codexRequest("schema-1", "schema-thread", schema)))
        .toMatchObject({ status: "completed" });
      expect(await high.run(codexRequest("schema-2", "schema-thread", {
        properties: {
          score: { type: "number" },
          verdict: { type: "string" },
        },
        type: "object",
      }))).toMatchObject({ status: "completed" });
      expect(await high.run(codexRequest("schema-3", "schema-thread", {
        type: "object",
        properties: { verdict: { type: "boolean" } },
      }))).toMatchObject({
        status: "failed",
        failure: { code: AgentRuntimeFailureCode.TaskRequestInvalid },
      });
      expect(runs).toBe(5);
    } finally {
      await baseline.dispose();
      await legacyCompatible.dispose();
      await high.dispose();
      await highDefault.dispose();
      await rm(root, { recursive: true, force: true });
      await rm(stateRootDir, { recursive: true, force: true });
    }
  });

  it("fails closed on one checkpoint reported with conflicting outcomes", async () => {
    const root = await gitFixture();
    const stateRootDir = await mkdtemp(
      join(tmpdir(), "agent-runtime-thread-checkpoint-state-"),
    );
    let runs = 0;
    const workerFactory: AgentRuntimeTaskWorkerFactory = () => ({
      async start() {},
      async run(job, options) {
        runs += 1;
        await options?.onProviderTaskStarted?.();
        await job.logicalThread?.onCheckpoint({
          checkpoint: "provider-checkpoint",
          outcome: ProviderLogicalThreadOutcome.StartedFresh,
        });
        await job.logicalThread?.onCheckpoint({
          checkpoint: "provider-checkpoint",
          outcome: ProviderLogicalThreadOutcome.Continued,
        });
        return { outputText: "must not complete", warnings: [] };
      },
      async dispose() {},
    });
    const runner = createLocalAgentRuntimeTaskRunner({
      provider: AgentRuntimeTaskProvider.Claude,
      stateRootDir,
      encryptionKey: "legacy-session-key",
      workspaceRoot: root,
      env: {},
      workerFactory,
    });
    const conflicting = request(
      "checkpoint-conflict",
      "conflicting checkpoint",
      "checkpoint-thread",
    );
    try {
      const first = await runner.run(conflicting);
      const replay = await runner.run(conflicting);

      expect(first).toMatchObject({
        status: "failed",
        lifecycle: {
          state: AgentRuntimeFailureLifecycleState.ExecutionFailed,
          taskStarted: true,
        },
      });
      expect(first).not.toHaveProperty("thread");
      expect(replay).toEqual(first);
      expect(runs).toBe(1);
    } finally {
      await runner.dispose();
      await rm(root, { recursive: true, force: true });
      await rm(stateRootDir, { recursive: true, force: true });
    }
  });

  it("preserves one control warning before worker warnings", async () => {
    const root = await gitFixture();
    const stateRootDir = await mkdtemp(
      join(tmpdir(), "agent-runtime-thread-state-"),
    );
    const workerFactory: AgentRuntimeTaskWorkerFactory = () => ({
      async start() {},
      async run(job, options) {
        await options?.onProviderTaskStarted?.();
        if (job.prompt === "wait") {
          return {
            status: "waiting_for_input",
            runId: "run-waiting",
            outputText: "Need input.",
            request: {
              id: "request-waiting",
              kind: "decision_required",
              question: "Continue?",
              audience: "orchestrator",
            },
            resumeHandle: {
              runId: "run-waiting",
              providerId: "codex",
              workspacePath: root,
            },
            telemetry: {
              durationMs: 42,
              providerSessionId: "provider-session-must-not-leak",
            },
            warnings: [{
              code: "worker-warning",
              safeMessage: "Worker warning.",
            }],
          };
        }
        await job.logicalThread?.onCheckpoint({
          checkpoint: "codex-thread-1",
          outcome: ProviderLogicalThreadOutcome.StartedFresh,
        });
        return {
          outputText: "done",
          warnings: [{
            code: "worker-warning",
            safeMessage: "Worker warning.",
          }],
        };
      },
      async dispose() {},
    });
    const runner = createLocalAgentRuntimeTaskRunner({
      provider: AgentRuntimeTaskProvider.Codex,
      stateRootDir,
      encryptionKey: "legacy-session-key",
      workspaceRoot: root,
      env: {},
      workerFactory,
      codexRuntimeFeatureProbe: { supports: async () => true },
    });
    try {
      const result = await runner.run({
        ...request("warning-execution", "warn", "warning-thread"),
        task: {
          ...request("unused", "warn").task,
          controls: {
            maxTurns: 3,
            accessBoundary: AgentRuntimeAccessBoundary.ReadOnly,
            toolPolicy: {
              allow: [AgentRuntimeTool.WebAccess],
              onUnsupported: "warn",
            },
            budget: {
              metric: AgentRuntimeBudgetMetric.WeightedTokens,
              limit: 10_000,
            },
          },
        },
      });

      expect(result).toMatchObject({
        status: "completed",
        warnings: [
          {
            code: "agent_runtime_task_control_unsupported",
            details: {
              control: "toolPolicy",
              provider: AgentRuntimeTaskProvider.Codex,
            },
          },
          { code: "worker-warning" },
        ],
      });
      expect(result.warnings).toHaveLength(2);

      const waiting = await runner.run({
        ...request("waiting-execution", "wait", "waiting-thread"),
        task: {
          ...request("unused", "wait").task,
          controls: {
            maxTurns: 3,
            accessBoundary: AgentRuntimeAccessBoundary.ReadOnly,
            toolPolicy: {
              allow: [AgentRuntimeTool.WebAccess],
              onUnsupported: "warn",
            },
            budget: {
              metric: AgentRuntimeBudgetMetric.WeightedTokens,
              limit: 10_000,
            },
          },
        },
      });
      expect(waiting).toMatchObject({
        status: "failed",
        failure: {
          code: AgentRuntimeFailureCode.ProviderOutputInvalid,
        },
        lifecycle: {
          state: AgentRuntimeFailureLifecycleState.ExecutionFailed,
          taskStarted: true,
        },
        telemetry: { durationMs: 42 },
        warnings: [
          { code: "agent_runtime_task_control_unsupported" },
          { code: "worker-warning" },
        ],
      });
      expect(waiting.telemetry).not.toHaveProperty("providerSessionId");
    } finally {
      await runner.dispose();
      await rm(root, { recursive: true, force: true });
      await rm(stateRootDir, { recursive: true, force: true });
    }
  });
});

function request(
  executionId: string,
  prompt: string,
  threadId = "thread-1",
): AgentRuntimeTaskRequestV3 {
  return {
    protocolVersion: agentRuntimeTaskProtocolVersionV3,
    executionId,
    thread: { id: threadId },
    timeoutMs: 30_000,
    task: {
      kind: "structured-prompt",
      prompt,
      execution: {
        mode: AgentRuntimeExecutionMode.Goal,
        completionCondition: "The fixture is complete.",
      },
      controls: {
        maxTurns: 3,
        accessBoundary: AgentRuntimeAccessBoundary.IsolatedWorkspaceWrite,
        toolPolicy: {
          allow: [
            AgentRuntimeTool.ReadFile,
            AgentRuntimeTool.EditFile,
          ],
        },
        budget: {
          metric: AgentRuntimeBudgetMetric.Usd,
          limit: 1,
        },
      },
    },
  };
}

function codexRequest(
  executionId: string,
  threadId: string,
  outputSchema?: JsonObject,
): AgentRuntimeTaskRequestV3 {
  const base = request(executionId, "review", threadId);
  const controls = {
    maxTurns: 3,
    accessBoundary: AgentRuntimeAccessBoundary.ReadOnly,
    toolPolicy: { allow: [AgentRuntimeTool.ReadFile] },
    budget: {
      metric: AgentRuntimeBudgetMetric.WeightedTokens,
      limit: 1_000,
    },
  } as const;
  return {
    ...base,
    task: outputSchema === undefined
      ? { ...base.task, controls }
      : {
          ...base.task,
          outputSchemaName: "review-schema",
          controls: { ...controls, outputSchema },
        },
  };
}

async function gitFixture(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "agent-runtime-thread-runner-"));
  await git(cwd, ["init"]);
  await git(cwd, ["config", "user.email", "test@example.com"]);
  await git(cwd, ["config", "user.name", "Test"]);
  await writeFile(join(cwd, "tracked.txt"), "initial\n");
  await git(cwd, ["add", "tracked.txt"]);
  await git(cwd, ["commit", "-m", "initial"]);
  return cwd;
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true })
  );
}
