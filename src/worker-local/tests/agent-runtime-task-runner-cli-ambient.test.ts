import { describe, expect, it } from "vitest";
import { runSubscriptionAgentRuntimeTaskCli, type AgentRuntimeTaskWorkerFactoryInput } from "../agent-runtime-task-runner-cli";
import {
  fakeAgentRuntimeTaskCliIo as fakeIo,
  fakeAgentRuntimeTaskWorkerFactory as fakeFactory,
} from "./agent-runtime-task-runner-cli-test-support";

describe("agent-runtime-task CLI ambient selection", () => {
  it("seeds an explicit ambient-home auth source instead of an OAuth token", async () => {
    const calls: {
      factory?: AgentRuntimeTaskWorkerFactoryInput;
      seed?: string;
      ambientSeed?: { homeDir: string; configDir?: string };
    } = {};
    const stdout: string[] = [];
    const exitCode = await runSubscriptionAgentRuntimeTaskCli(
      [
        "--provider",
        "claude",
        "--format",
        "result-json",
        "--state-root",
        "/tmp/runtime-state",
        "--claude-ambient-home",
        "/Users/dev/.claude-ambient",
        "--claude-ambient-config-dir",
        "/Users/dev/.claude-ambient/.claude",
      ],
      fakeIo({
        stdout,
        stdin: JSON.stringify({
          protocolVersion: 1,
          task: { kind: "structured-prompt", prompt: "hello" },
        }),
        env: {
          PATH: "/usr/bin",
          SUBSCRIPTION_RUNTIME_LOCAL_ENCRYPTION_KEY:
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        },
      }),
      fakeFactory(calls),
    );

    expect(exitCode).toBe(0);
    expect(calls.ambientSeed).toEqual({
      homeDir: "/Users/dev/.claude-ambient",
      configDir: "/Users/dev/.claude-ambient/.claude",
    });
    expect(calls.seed).toBeUndefined();
  });

  it("rejects --claude-ambient-home combined with a resolved Claude OAuth token", async () => {
    const stderr: string[] = [];
    const exitCode = await runSubscriptionAgentRuntimeTaskCli(
      [
        "--provider",
        "claude",
        "--state-root",
        "/tmp/runtime-state",
        "--claude-ambient-home",
        "/Users/dev/.claude-ambient",
      ],
      fakeIo({
        stderr,
        stdin: JSON.stringify({
          protocolVersion: 1,
          task: { kind: "structured-prompt", prompt: "hello" },
        }),
        env: {
          PATH: "/usr/bin",
          SUBSCRIPTION_RUNTIME_LOCAL_ENCRYPTION_KEY:
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
          CLAUDE_CODE_OAUTH_TOKEN: "claude-token",
        },
      }),
      fakeFactory({}),
    );

    expect(exitCode).toBe(2);
    expect(stderr.join("")).toContain("cannot be combined with a Claude OAuth token");
  });

  it.each(["hosted-TEST-job", ""])("rejects --claude-ambient-home with sandbox marker %j", async (marker) => {
    const stderr: string[] = [];
    const exitCode = await runSubscriptionAgentRuntimeTaskCli(
      [
        "--provider",
        "claude",
        "--state-root",
        "/tmp/runtime-state",
        "--claude-ambient-home",
        "/Users/dev/.claude-ambient",
      ],
      fakeIo({
        stderr,
        stdin: JSON.stringify({
          protocolVersion: 1,
          task: { kind: "structured-prompt", prompt: "hello" },
        }),
        env: {
          PATH: "/usr/bin",
          SUBSCRIPTION_RUNTIME_LOCAL_ENCRYPTION_KEY:
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
          SUBSCRIPTION_RUNTIME_SANDBOX_KIND: marker,
        },
      }),
      fakeFactory({}),
    );

    expect(exitCode).toBe(2);
    expect(stderr.join("")).toContain("not permitted in a hosted/sandboxed execution context");
  });

  it("still fails closed against the real default worker when no OAuth token or ambient-home is supplied", async () => {
    const stdout: string[] = [];
    const exitCode = await runSubscriptionAgentRuntimeTaskCli(
      [
        "--provider",
        "claude",
        "--format",
        "result-json",
        "--ephemeral",
      ],
      fakeIo({
        stdout,
        stdin: JSON.stringify({
          protocolVersion: 1,
          task: { kind: "structured-prompt", prompt: "hello" },
        }),
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      }),
      // No workerFactory override: exercises the real FileBackendClaudeWorker,
      // proving the isolated OAuth path still rejects a missing session
      // (no --claude-token-env resolved value and no --claude-ambient-home).
    );

    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      status: "failed",
      failure: {
        safeMessage: "Provider session is missing.",
        details: { runtimeReason: "provider_reconnect_required" },
      },
    });
  });

});
