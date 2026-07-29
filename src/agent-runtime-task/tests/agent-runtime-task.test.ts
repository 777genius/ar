import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AgentRuntimeExecutionMode,
  AgentRuntimeFailureCode,
  type ProviderTaskEvent,
} from "@vioxen/subscription-runtime/core";
import {
  agentRuntimeTaskProtocolVersion,
  AgentRuntimeFailureLifecycleState,
  agentRuntimeTaskRoundMemberFingerprint,
  assertAgentRuntimeTaskCertification,
  certifyAgentRuntimeTaskExchange,
  compareAgentRuntimeTaskRoundMembers,
  createAgentRuntimeTaskRequest,
  createAgentRuntimeTaskRequestV2,
  loadAgentRuntimeTaskHandler,
  parseAgentRuntimeTaskEvent,
  parseAgentRuntimeTaskRequest,
  parseAgentRuntimeTaskResult,
  runAgentRuntimeTaskBridge,
  runAgentRuntimeTaskCli,
  streamAgentRuntimeTaskBridge,
} from "../index";

describe("agent-runtime-task JSON adapter kit", () => {
  it("normalizes request JSON and maps it to a provider-neutral handler", async () => {
    const request = createAgentRuntimeTaskRequest({
      runId: "run-1",
      providerInstanceId: "provider:test",
      cwd: "/workspace",
      timeoutMs: 30_000,
      task: {
        kind: "structured-prompt",
        prompt: "Return OK.",
        systemPrompt: "System rules stay separate.",
        controls: {
          model: "test-model",
          responseFormat: "json",
          outputSchema: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
            },
          },
        },
        metadata: { app: "qa-rig" },
      },
      context: {
        application: "qa-rig",
        purpose: "triage",
        correlationId: "corr-1",
        round: {
          roundId: "review-round-1",
          roundIndex: 1,
          totalRounds: 3,
          member: {
            id: "critic-codex",
            adapterId: "subscription-runtime-codex",
            agentType: "critic",
            provider: "openai",
            model: "gpt-5.5",
            independenceGroup: "openai:gpt-5.5",
          },
          adversaryOf: {
            id: "advocate-claude",
            adapterId: "subscription-runtime-claude",
            agentType: "advocate",
            provider: "anthropic",
            model: "sonnet",
            independenceGroup: "anthropic:sonnet",
          },
        },
      },
    });

    expect(parseAgentRuntimeTaskRequest(request)).toMatchObject({
      protocolVersion: agentRuntimeTaskProtocolVersion,
      task: {
        kind: "structured-prompt",
        prompt: "Return OK.",
        systemPrompt: "System rules stay separate.",
      },
      context: {
        round: {
          member: {
            id: "critic-codex",
          },
        },
      },
    });

    const run = await runAgentRuntimeTaskBridge(request, async (received) => ({
      status: "completed",
      outputText: `handled:${received.task.systemPrompt}:${received.task.prompt}`,
      structuredOutput: { ok: true },
      telemetry: {
        turns: 1,
        cost: { amount: 0.01, currency: "USD" },
      },
      warnings: [],
    }));

    expect(run.result).toMatchObject({
      protocolVersion: agentRuntimeTaskProtocolVersion,
      status: "completed",
      outputText: "handled:System rules stay separate.:Return OK.",
      structuredOutput: { ok: true },
    });
    expect(run.events.map((event) => event.type)).toEqual([
      "started",
      "completed",
    ]);
  });

  it("preserves protocol v2 across bridge results and terminal events", async () => {
    const request = createAgentRuntimeTaskRequestV2({
      timeoutMs: 30_000,
      task: {
        kind: "structured-prompt",
        prompt: "Finish the bounded fixture.",
        execution: {
          mode: AgentRuntimeExecutionMode.Goal,
          completionCondition: "The bounded fixture is complete.",
        },
      },
    });

    const run = await runAgentRuntimeTaskBridge(request, async () => ({
      status: "completed",
      outputText: "done",
      warnings: [],
    }));

    expect(run.result).toMatchObject({
      protocolVersion: 2,
      status: "completed",
    });
    expect(run.events).toEqual([
      expect.objectContaining({ protocolVersion: 2, type: "started" }),
      expect.objectContaining({
        protocolVersion: 2,
        type: "completed",
        result: expect.objectContaining({ protocolVersion: 2 }),
      }),
    ]);
  });

  it("fails a mismatched handler protocol without downgrading v2", async () => {
    const request = createAgentRuntimeTaskRequestV2({
      task: {
        kind: "structured-prompt",
        prompt: "Inspect the fixture.",
        execution: { mode: AgentRuntimeExecutionMode.SingleRun },
      },
    });

    const run = await runAgentRuntimeTaskBridge(request, async () => ({
      protocolVersion: 1,
      status: "completed",
      outputText: "wrong protocol",
      warnings: [],
    }));

    expect(run.result).toMatchObject({
      protocolVersion: 2,
      status: "failed",
      failure: { code: AgentRuntimeFailureCode.ProviderOutputInvalid },
      lifecycle: {
        state: AgentRuntimeFailureLifecycleState.ExecutionFailed,
        taskStarted: true,
      },
    });
    expect(run.events.at(-1)).toMatchObject({
      protocolVersion: 2,
      type: "completed",
      result: { protocolVersion: 2 },
    });
  });

  it("normalizes provider stream events into JSON-safe bridge events", async () => {
    const request = createAgentRuntimeTaskRequest({
      task: {
        kind: "review",
        prompt: "Review this diff.",
      },
    });

    async function* streamTask(): AsyncIterable<ProviderTaskEvent> {
      yield {
        type: "started",
        occurredAt: new Date("2026-06-13T12:00:00.000Z"),
      };
      yield {
        type: "text_delta",
        occurredAt: new Date("2026-06-13T12:00:01.000Z"),
        text: "No findings.",
      };
      yield {
        type: "completed",
        occurredAt: new Date("2026-06-13T12:00:02.000Z"),
        result: {
          status: "completed",
          outputText: "No findings.",
          warnings: [],
        },
      };
    }

    const run = await runAgentRuntimeTaskBridge(request, { streamTask });

    expect(run.result).toMatchObject({
      status: "completed",
      outputText: "No findings.",
    });
    expect(run.events.map((event) => event.type)).toEqual([
      "started",
      "text_delta",
      "completed",
    ]);
    expect(run.events[0]?.occurredAt).toBe("2026-06-13T12:00:00.000Z");
  });

  it("rejects oversized task system prompts before provider dispatch", () => {
    expect(() =>
      parseAgentRuntimeTaskRequest({
        protocolVersion: agentRuntimeTaskProtocolVersion,
        task: {
          kind: "review",
          prompt: "Review this diff.",
          systemPrompt: "x".repeat(256 * 1024 + 1),
        },
      }),
    ).toThrow("request.task.systemPrompt exceeds 262144 bytes");
  });

  it("rejects empty task system prompts before provider dispatch", () => {
    expect(() =>
      parseAgentRuntimeTaskRequest({
        protocolVersion: agentRuntimeTaskProtocolVersion,
        task: {
          kind: "review",
          prompt: "Review this diff.",
          systemPrompt: "  ",
        },
      }),
    ).toThrow("request.task.systemPrompt must not be empty");
  });

  it("rejects low-level provider controls at the public task boundary", () => {
    expect(() =>
      parseAgentRuntimeTaskRequest({
        protocolVersion: agentRuntimeTaskProtocolVersion,
        task: {
          kind: "review",
          prompt: "Review this diff.",
          controls: {
            editMode: "read-only",
            providerSandboxMode: "danger-full-access",
          },
        },
      }),
    ).toThrow(/controls.editMode is unsupported/);
  });

  it("turns an unterminated provider stream into a failed terminal event", async () => {
    const request = createAgentRuntimeTaskRequest({
      task: {
        kind: "review",
        prompt: "Review this diff.",
      },
    });

    async function* streamTask(): AsyncIterable<ProviderTaskEvent> {
      yield {
        type: "text_delta",
        occurredAt: new Date("2026-06-13T12:00:01.000Z"),
        text: "partial",
      };
    }

    const run = await runAgentRuntimeTaskBridge(request, { streamTask });

    expect(run.result).toMatchObject({
      status: "failed",
      failure: { code: "provider_output_invalid" },
    });
    expect(run.events.map((event) => event.type)).toEqual([
      "started",
      "text_delta",
      "completed",
    ]);
    expect(() =>
      assertAgentRuntimeTaskCertification({
        request,
        result: run.result,
        events: run.events,
        requireTerminalEvent: true,
      }),
    ).not.toThrow();
  });

  it("uses completed events emitted through stream context as the terminal result", async () => {
    const request = createAgentRuntimeTaskRequest({
      task: {
        kind: "review",
        prompt: "Review this diff.",
      },
    });

    const run = await runAgentRuntimeTaskBridge(request, {
      async *streamTask(_received, context) {
        await context.emit({
          type: "completed",
          occurredAt: new Date("2026-06-13T12:00:02.000Z"),
          result: {
            status: "completed",
            outputText: "context emitted result",
            warnings: [],
          },
        });
      },
    });

    expect(run.result).toMatchObject({
      status: "completed",
      outputText: "context emitted result",
    });
    expect(run.events.map((event) => event.type)).toEqual(["completed"]);
    expect(() =>
      assertAgentRuntimeTaskCertification({
        request,
        result: run.result,
        events: run.events,
        requireTerminalEvent: true,
      }),
    ).not.toThrow();
  });

  it("streams emitted events before the task completes", async () => {
    const request = createAgentRuntimeTaskRequest({
      task: {
        kind: "structured-prompt",
        prompt: "stream",
      },
    });
    let releaseTask!: () => void;
    const taskGate = new Promise<void>((resolve) => {
      releaseTask = resolve;
    });
    const iterator = streamAgentRuntimeTaskBridge(
      request,
      async (_received, context) => {
        await context.emit({
          type: "text_delta",
          occurredAt: new Date("2026-06-13T12:00:01.000Z"),
          text: "partial",
        });
        await taskGate;
        return {
          status: "completed",
          outputText: "done",
          warnings: [],
        };
      },
      { now: () => new Date("2026-06-13T12:00:00.000Z") },
    )[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: "started" },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: "text_delta", text: "partial" },
    });

    releaseTask();

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: "completed", result: { outputText: "done" } },
    });
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
  });

  it("enforces the request deadline against a non-cooperative handler", async () => {
    let handlerSignal: AbortSignal | undefined;
    const request = createAgentRuntimeTaskRequest({
      timeoutMs: 25,
      task: {
        kind: "structured-prompt",
        prompt: "never completes",
      },
    });

    const startedAt = Date.now();
    const run = await runAgentRuntimeTaskBridge(
      request,
      async (_received, context) => {
        handlerSignal = context.abortSignal;
        return await new Promise<never>(() => {});
      },
    );

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(handlerSignal?.aborted).toBe(true);
    expect(run.result).toMatchObject({
      status: "failed",
      failure: {
        code: AgentRuntimeFailureCode.TaskTimeout,
        safeMessage: "Agent runtime task timed out after 25ms.",
      },
    });
    expect(run.events.map((event) => event.type)).toEqual([
      "started",
      "completed",
    ]);
  });

  it("cancels a non-cooperative stream and emits one terminal result", async () => {
    const abortController = new AbortController();
    let streamStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      streamStarted = resolve;
    });
    const request = createAgentRuntimeTaskRequest({
      task: {
        kind: "structured-prompt",
        prompt: "never yields",
      },
    });
    const run = runAgentRuntimeTaskBridge(
      request,
      {
        async *streamTask(_received, context) {
          expect(context.abortSignal.aborted).toBe(false);
          streamStarted();
          await new Promise(() => {});
        },
      },
      { abortSignal: abortController.signal },
    );

    await started;
    abortController.abort();

    await expect(run).resolves.toMatchObject({
      result: {
        status: "failed",
        failure: { code: AgentRuntimeFailureCode.TaskCancelled },
      },
      events: [
        { type: "started" },
        { type: "completed" },
      ],
    });
  });

  it("rejects unsupported telemetry and tool-call enum values", () => {
    expect(() =>
      parseAgentRuntimeTaskResult({
        protocolVersion: agentRuntimeTaskProtocolVersion,
        status: "completed",
        outputText: "x",
        telemetry: { finishReason: "made_up" },
        warnings: [],
      }),
    ).toThrow("telemetry.finishReason is unsupported");

    expect(() =>
      parseAgentRuntimeTaskEvent({
        protocolVersion: agentRuntimeTaskProtocolVersion,
        type: "tool_call",
        occurredAt: "2026-06-13T12:00:00.000Z",
        toolCall: {
          name: "read",
          status: "made_up",
        },
      }),
    ).toThrow("event.toolCall.status is unsupported");
  });

  it("certifies round member identity and adversarial independence", async () => {
    const request = createAgentRuntimeTaskRequest({
      task: {
        kind: "structured-prompt",
        prompt: "Judge the prior round.",
      },
      context: {
        round: {
          member: {
            id: "critic-codex",
            adapterId: "subscription-runtime-codex",
            agentType: "critic",
            provider: "openai",
            model: "gpt-5.5",
            independenceGroup: "openai:gpt-5.5",
          },
          adversaryOf: {
            id: "advocate-claude",
            adapterId: "subscription-runtime-claude",
            agentType: "advocate",
            provider: "anthropic",
            model: "sonnet",
            independenceGroup: "anthropic:sonnet",
          },
        },
      },
    });
    const run = await runAgentRuntimeTaskBridge(request, async () => ({
      status: "completed",
      outputText: "independent",
      warnings: [],
    }));

    expect(() =>
      assertAgentRuntimeTaskCertification({
        request,
        result: run.result,
        events: run.events,
        requireRoundMemberIdentity: true,
        requireRoundMemberIndependence: true,
        requireTerminalEvent: true,
      }),
    ).not.toThrow();

    expect(agentRuntimeTaskRoundMemberFingerprint(request.context!.round!.member)).toBe(
      "12:critic-codex|26:subscription-runtime-codex|6:critic|6:openai|7:gpt-5.5|14:openai:gpt-5.5",
    );
  });

  it("rejects round members that are not adversarially independent", () => {
    const member = {
      id: "critic-a",
      adapterId: "subscription-runtime-claude",
      agentType: "critic",
      provider: "anthropic",
      model: "sonnet",
      independenceGroup: "anthropic:sonnet",
    };
    const sameModel = {
      ...member,
      id: "advocate-a",
      agentType: "advocate",
    };
    const sameGroup = {
      ...member,
      id: "advocate-b",
      agentType: "advocate",
      model: "opus",
    };

    expect(compareAgentRuntimeTaskRoundMembers(member, sameModel)).toMatchObject({
      ok: false,
      failure: "same-provider-model",
    });
    expect(compareAgentRuntimeTaskRoundMembers(member, sameGroup)).toMatchObject({
      ok: false,
      failure: "same-independence-group",
    });
  });

  it("loads a handler module and drives it through the CLI bridge", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agent-runtime-task-cli-"));
    try {
      const handlerPath = join(tempDir, "handler.mjs");
      const requestPath = join(tempDir, "request.json");
      await writeFile(
        handlerPath,
        [
          "export async function runAgentRuntimeTask(request) {",
          "  return {",
          "    protocolVersion: 1,",
          "    status: 'completed',",
          "    outputText: `cli:${request.task.prompt}`,",
          "    warnings: []",
          "  };",
          "}",
        ].join("\n"),
      );
      await writeFile(
        requestPath,
        JSON.stringify(
          createAgentRuntimeTaskRequest({
            task: {
              kind: "structured-prompt",
              prompt: "hello",
            },
          }),
        ),
      );

      const stdout: string[] = [];
      const stderr: string[] = [];
      const exitCode = await runAgentRuntimeTaskCli(
        [
          "--handler",
          handlerPath,
          "--input",
          requestPath,
          "--format",
          "result-json",
        ],
        {
          readStdin: async () => "",
          writeStdout: (chunk) => stdout.push(chunk),
          writeStderr: (chunk) => stderr.push(chunk),
          cwd: () => tempDir,
        },
      );

      expect(exitCode).toBe(0);
      expect(stderr).toEqual([]);
      expect(JSON.parse(stdout.join(""))).toMatchObject({
        status: "completed",
        outputText: "cli:hello",
      });
      await expect(loadAgentRuntimeTaskHandler(handlerPath)).resolves.toBeTypeOf(
        "function",
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("certifies terminal event consistency and catches output secret leaks", async () => {
    const request = createAgentRuntimeTaskRequest({
      task: {
        kind: "structured-prompt",
        prompt: "Summarize failure.",
      },
    });
    const run = await runAgentRuntimeTaskBridge(request, async () => ({
      status: "completed",
      outputText: "safe summary",
      warnings: [],
    }));

    expect(() =>
      assertAgentRuntimeTaskCertification({
        request,
        result: run.result,
        events: run.events,
        forbiddenSecrets: ["secret-token"],
        requireTerminalEvent: true,
      }),
    ).not.toThrow();

    const failed = certifyAgentRuntimeTaskExchange({
      request,
      result: {
        ...run.result,
        outputText: "leaked secret-token",
      },
      events: run.events,
      forbiddenSecrets: ["secret-token"],
    });

    expect(failed.status).toBe("failed");
    expect(failed.checks).toContainEqual(
      expect.objectContaining({
        name: "secret-redaction",
        status: "failed",
      }),
    );
  });
});
