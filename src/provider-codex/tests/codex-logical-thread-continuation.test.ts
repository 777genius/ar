import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AgentRuntimeExecutionMode,
  DefaultRedactor,
  ProviderLogicalThreadOutcome,
  type ProviderTask,
} from "@vioxen/subscription-runtime/core";
import {
  CodexAppServerExecutionEngine,
  CodexJsonAgentDriver,
  sessionArtifactFromCodexAuthJson,
} from "../index";
import { FakeAppServerFactory } from "../app-server/testing/fake-app-server";
import {
  StaticRunner,
  validAuthJson,
} from "./codex-provider-test-support";

describe("Codex logical-thread continuation", () => {
  it("forks full history with the official request shape and keeps checkpoint ids internal", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-app-thread-fork-"));
    const fakeFactory = new FakeAppServerFactory();
    const driver = logicalThreadDriver(fakeFactory);
    const checkpoints: unknown[] = [];
    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: logicalThreadTask(),
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
        logicalThread: {
          threadId: "logical-thread-1",
          previousCheckpoint: "source-thread-1",
          onCheckpoint: (checkpoint) => {
            checkpoints.push(checkpoint);
          },
        },
      });

      expect(result).toMatchObject({
        status: "completed",
        outputText: "app-server output:continue the fixture",
      });
      expect(result.telemetry).not.toHaveProperty("providerSessionId");
      expect(checkpoints).toEqual([{
        checkpoint: "thread-1",
        outcome: ProviderLogicalThreadOutcome.Continued,
      }]);
      const fork = fakeFactory.requests.find(
        (request) => request.method === "thread/fork",
      );
      expect(fork?.params).toEqual({ threadId: "source-thread-1" });
      expect(fork?.params).not.toHaveProperty("excludeTurns");
      expect(fork?.params).not.toHaveProperty("lastTurnId");
      expect(
        fakeFactory.requests.some(
          (request) => request.method === "thread/start",
        ),
      ).toBe(false);
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("recovers fresh only when the source thread is explicitly missing", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-app-thread-recover-"));
    const fakeFactory = new FakeAppServerFactory({
      threadForkError: "source thread not found",
    });
    const driver = logicalThreadDriver(fakeFactory);
    const checkpoints: unknown[] = [];
    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: logicalThreadTask(),
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
        logicalThread: {
          threadId: "logical-thread-1",
          previousCheckpoint: "missing-thread",
          onCheckpoint: (checkpoint) => {
            checkpoints.push(checkpoint);
          },
        },
      });

      expect(result.status).toBe("completed");
      expect(checkpoints).toEqual([{
        checkpoint: "thread-1",
        outcome: ProviderLogicalThreadOutcome.RecoveredFresh,
      }]);
      expect(
        fakeFactory.requests.map((request) => request.method),
      ).toEqual(expect.arrayContaining(["thread/fork", "thread/start"]));
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it.each([
    ["ambiguous source unavailability", {
      threadForkError:
        "source thread provider-secret-checkpoint is unavailable",
      timeoutMs: 100,
      abortBeforeRun: false,
      checkpoint: "provider-secret-checkpoint",
    }],
    ["unknown fork failure", {
      threadForkError: "thread service unavailable",
      timeoutMs: 100,
      abortBeforeRun: false,
    }],
    ["fork timeout", {
      suppressThreadForkResponse: true,
      timeoutMs: 20,
      abortBeforeRun: false,
    }],
    ["fork abort", {
      timeoutMs: 100,
      abortBeforeRun: true,
    }],
  ])("does not recover fresh after %s", async (_label, scenario) => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-app-thread-fail-"));
    const fakeFactory = new FakeAppServerFactory({
      ...(!("threadForkError" in scenario)
        ? {}
        : { threadForkError: scenario.threadForkError }),
      ...(!("suppressThreadForkResponse" in scenario)
        ? {}
        : {
            suppressThreadForkResponse:
              scenario.suppressThreadForkResponse,
          }),
    });
    const driver = logicalThreadDriver(fakeFactory, scenario.timeoutMs);
    const controller = new AbortController();
    if (scenario.abortBeforeRun) controller.abort();
    let checkpointCalled = false;
    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: logicalThreadTask(),
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: controller.signal,
        logicalThread: {
          threadId: "logical-thread-1",
          previousCheckpoint: "checkpoint" in scenario
            ? scenario.checkpoint
            : "source-thread",
          onCheckpoint: () => {
            checkpointCalled = true;
          },
        },
      });

      expect(result.status).toBe("failed");
      expect(checkpointCalled).toBe(false);
      expect(
        fakeFactory.requests.filter(
          (request) =>
            request.method === "thread/start" ||
            request.method === "turn/start",
        ),
      ).toEqual([]);
      if ("checkpoint" in scenario) {
        expect(JSON.stringify(result)).not.toContain(scenario.checkpoint);
      }
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

function logicalThreadDriver(
  fakeFactory: FakeAppServerFactory,
  timeoutMs?: number,
): CodexJsonAgentDriver {
  return new CodexJsonAgentDriver({
    engine: new CodexAppServerExecutionEngine({
      codexBinaryPath: "/bin/codex-test",
      processFactory: fakeFactory.create,
      cleanThreadPrewarm: false,
      goalMode: true,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    }),
    model: "gpt-test",
    reasoningEffort: "low",
  });
}

function logicalThreadTask(): ProviderTask {
  return {
    kind: "structured-prompt",
    prompt: "continue the fixture",
    execution: {
      mode: AgentRuntimeExecutionMode.Goal,
      completionCondition: "finish the fixture",
    },
    controls: { editMode: "allow-edits" },
  };
}
