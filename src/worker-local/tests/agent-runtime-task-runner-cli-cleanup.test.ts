import { describe, expect, it, vi } from "vitest";
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
