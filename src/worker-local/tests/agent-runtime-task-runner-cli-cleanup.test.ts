import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as hostScratchTemp from "../../worker-codex/host-scratch-temp";
import { runSubscriptionAgentRuntimeTaskCli } from "../agent-runtime-task-runner-cli";
import { fakeAgentRuntimeTaskCliIo as fakeIo } from "./agent-runtime-task-runner-cli-test-support";

describe("agent runtime CLI cleanup deadline", () => {
  it("keeps the task result when worker dispose never resolves", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    let markDisposeEntered!: () => void;
    const disposeEntered = new Promise<void>((resolve) => {
      markDisposeEntered = resolve;
    });
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      const execution = runSubscriptionAgentRuntimeTaskCli(
        [
          "--provider",
          "claude",
          "--state-root",
          "/tmp/runtime-state",
          "--format",
          "result-json",
        ],
        fakeIo({
          stdout,
          stderr,
          stdin: JSON.stringify({
            protocolVersion: 1,
            timeoutMs: 5,
            task: {
              kind: "structured-prompt",
              prompt: "finishes before cleanup hangs",
            },
          }),
          env: {
            SUBSCRIPTION_RUNTIME_LOCAL_ENCRYPTION_KEY:
              "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
          },
        }),
        () => ({
          async start() {},
          async run() {
            return {
              outputText: "done",
              warnings: [],
            };
          },
          async dispose() {
            markDisposeEntered();
            return await new Promise<void>(() => {});
          },
        }),
      );

      // Keep the 5 ms task budget independent of host scheduling. Only advance
      // time after the completed task has entered its separate cleanup phase.
      let settled = false;
      await Promise.race([
        disposeEntered,
        execution.then(() => {
          throw new Error("task finished before worker.dispose entered");
        }),
      ]);
      void execution.then(
        () => { settled = true; },
        () => { settled = true; },
      );
      await vi.advanceTimersByTimeAsync(4_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const exitCode = await execution;

      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout.join(""))).toMatchObject({
        status: "completed",
        outputText: "done",
      });
      expect(stderr.join("")).toContain("subscription_worker_dispose_timeout:5000\n");
    } finally {
      vi.useRealTimers();
    }
  });

});

describe("agent runtime CLI phase deadlines", () => {
  let phaseExecution: Promise<number> | undefined;
  let phaseAbort: AbortController | undefined;

  beforeEach(() => {
    // These fixtures exercise the packaged worker protocol and cwd ownership.
    // Host cache effects have separate storage-policy tests and must not touch
    // the machine's installed policy or mounts from this unit suite.
    vi.spyOn(hostScratchTemp, "prepareHostScratchCaches").mockResolvedValue(undefined);
  });

  afterEach(async () => {
    const cleanupErrors: unknown[] = [];
    try {
      if (vi.isFakeTimers()) await vi.runAllTimersAsync();
    } catch (error) {
      cleanupErrors.push(error);
    } finally {
      try {
        vi.useRealTimers();
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        phaseAbort?.abort();
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        await phaseExecution;
      } catch (error) {
        cleanupErrors.push(error);
      } finally {
        phaseExecution = undefined;
        phaseAbort = undefined;
        try {
          vi.restoreAllMocks();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
    }
    if (cleanupErrors.length === 1) throw cleanupErrors[0];
    if (cleanupErrors.length > 1) {
      throw new AggregateError(cleanupErrors, "CLI test cleanup failed");
    }
  });

  it("returns a timeout result when the worker start never resolves", async () => {
    const stdout: string[] = [];
    let runCalled = false;
    let disposed = false;
    let markStartEntered!: () => void;
    const startEntered = new Promise<void>((resolve) => {
      markStartEntered = resolve;
    });
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      const controller = new AbortController();
      phaseAbort = controller;
      const execution = runSubscriptionAgentRuntimeTaskCli(
        [
          "--provider",
          "claude",
          "--state-root",
          "/tmp/runtime-state",
          "--format",
          "result-json",
        ],
        fakeIo({
          stdout,
          stdin: JSON.stringify({
            protocolVersion: 1,
            timeoutMs: 5,
            task: {
              kind: "structured-prompt",
              prompt: "never starts",
            },
          }),
          env: {
            SUBSCRIPTION_RUNTIME_LOCAL_ENCRYPTION_KEY:
              "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
          },
        }),
        () => ({
          async start() {
            markStartEntered();
            return await new Promise<void>(() => {});
          },
          async run() {
            runCalled = true;
            return {
              outputText: "unexpected",
              warnings: [],
            };
          },
          async dispose() {
            disposed = true;
          },
        }),
        { signal: controller.signal },
      );

      phaseExecution = execution;
      await Promise.race([
        startEntered,
        execution.then(() => {
          throw new Error("task finished before worker.start entered");
        }),
      ]);
      await vi.advanceTimersByTimeAsync(5);
      const exitCode = await execution;

      expect(exitCode).toBe(1);
      expect(runCalled).toBe(false);
      expect(disposed).toBe(true);
      expect(JSON.parse(stdout.join(""))).toMatchObject({
        status: "failed",
        failure: {
          code: "task_timeout",
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns a timeout result when worker auth seeding never resolves", async () => {
    const stdout: string[] = [];
    let runCalled = false;
    let disposeCalls = 0;
    let markSeedEntered!: () => void;
    const seedEntered = new Promise<void>((resolve) => {
      markSeedEntered = resolve;
    });
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      const controller = new AbortController();
      phaseAbort = controller;
      const execution = runSubscriptionAgentRuntimeTaskCli(
        [
          "--provider",
          "claude",
          "--state-root",
          "/tmp/runtime-state",
          "--format",
          "result-json",
        ],
        fakeIo({
          stdout,
          stdin: JSON.stringify({
            protocolVersion: 1,
            timeoutMs: 5,
            task: {
              kind: "structured-prompt",
              prompt: "never seeds",
            },
          }),
          env: {
            CLAUDE_CODE_OAUTH_TOKEN: "token",
            SUBSCRIPTION_RUNTIME_LOCAL_ENCRYPTION_KEY:
              "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
          },
        }),
        () => ({
          async start() {},
          async seedClaudeOAuth() {
            markSeedEntered();
            return await new Promise<void>(() => {});
          },
          async run() {
            runCalled = true;
            return {
              outputText: "unexpected",
              warnings: [],
            };
          },
          async dispose() {
            disposeCalls += 1;
          },
        }),
        { signal: controller.signal },
      );

      phaseExecution = execution;
      await Promise.race([
        seedEntered,
        execution.then(() => {
          throw new Error("task finished before worker.seedClaudeOAuth entered");
        }),
      ]);
      await vi.advanceTimersByTimeAsync(5);
      const exitCode = await execution;

      expect(exitCode).toBe(1);
      expect(runCalled).toBe(false);
      expect(disposeCalls).toBe(1);
      expect(JSON.parse(stdout.join(""))).toMatchObject({
        status: "failed",
        failure: {
          code: "task_timeout",
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

});
