import { describe, expect, it } from "vitest";
import { runSubscriptionAgentRuntimeTaskCli } from "../agent-runtime-task-runner-cli";
import { fakeAgentRuntimeTaskCliIo as fakeIo } from "./agent-runtime-task-runner-cli-test-support";

describe("agent runtime CLI dispose failures", () => {
  it("keeps the task result when worker dispose fails", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runSubscriptionAgentRuntimeTaskCli(
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
          task: {
            kind: "structured-prompt",
            prompt: "finishes before cleanup fails",
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
          throw new Error("dispose exploded");
        },
      }),
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      status: "completed",
      outputText: "done",
    });
    expect(stderr.join("")).toContain("dispose exploded");
  });

  it("keeps the task result when worker dispose throws synchronously", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runSubscriptionAgentRuntimeTaskCli(
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
          task: {
            kind: "structured-prompt",
            prompt: "finishes before cleanup throws",
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
        dispose() {
          throw new Error("dispose sync exploded");
        },
      }),
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      status: "completed",
      outputText: "done",
    });
    expect(stderr.join("")).toContain("dispose sync exploded");
  });

});
