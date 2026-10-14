import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { CodexAppServerClient } from "../../app-server/application/app-server-client";
import { FakeAppServerFactory } from "../../app-server/testing/fake-app-server";
import { resolveCodexExecutionProfile } from "../../codex-execution-profile";

it.each([
  { terminalBeforeAck: true, failed: false, emptyOutput: false },
  { terminalBeforeAck: true, failed: true, emptyOutput: false },
  { terminalBeforeAck: false, failed: false, emptyOutput: false },
  { terminalBeforeAck: false, failed: true, emptyOutput: false },
  { terminalBeforeAck: true, failed: true, emptyOutput: true },
])("returns ACK identity after alias cleanup ($terminalBeforeAck before ACK, failed=$failed, empty=$emptyOutput)", async ({ terminalBeforeAck, failed, emptyOutput }) => {
  const workspace = await mkdtemp(join(tmpdir(), "acknowledged-turn-identity-TEST-"));
  const factory = new FakeAppServerFactory({
    emitTurnEventsWithStartResponse: true,
    mismatchTurnStartResponseId: true,
    reuseActualTurnId: "notification-alias",
    suppressTurnCompletion: !terminalBeforeAck,
    agentMessageDeltas: emptyOutput ? [] : ["early"],
    ...(failed ? { completeTurnWithError: { message: "synthetic failure", codexErrorInfo: "other" } } : {}),
    onRequest: request => {
      if (request.method !== "turn/start") return;
      const stdout = factory.processes[0]!.stdout;
      const emit = stdout.emit.bind(stdout);
      vi.spyOn(stdout, "emit").mockImplementationOnce((event, ...args) => {
        const frames = String(args[0]).trim().split("\n");
        const ack = frames.shift()!;
        // Real framed transport: started/delta (and optionally terminal) arrive
        // before the response, whose ID differs from every notification ID.
        return emit(event, `${[...frames, ack].join("\n")}\n`);
      });
    },
  });
  const abortSignal = new AbortController().signal;
  const client = new CodexAppServerClient({
    codexBinaryPath: "/fake/codex", sourceEnv: {}, processFactory: factory.create,
    signalChildProcess: (child, signal) => { child.kill(signal); },
    session: { home: workspace, codexHome: workspace, env: {}, release: async () => undefined },
    workspacePath: workspace, executionProfile: resolveCodexExecutionProfile(undefined),
    timeoutMs: 2_000, startupTimeoutMs: 2_000, reconnectGraceMs: 100,
    maxOutputBytes: 4096, abortSignal,
  });
  try {
    await client.start();
    const threadInput = { workspacePath: workspace, model: "test", reasoningEffort: "low" as const,
      timeoutMs: 2_000, abortSignal };
    const targetThreadId = await client.startThread(threadInput);
    const latestThreadId = await client.startThread(threadInput);
    expect(latestThreadId).not.toBe(targetThreadId);
    for (let turnNumber = 1; turnNumber <= 2; turnNumber++) {
      const deltas: string[] = [];
      let sinkAttached!: () => void;
      const ready = new Promise<void>(resolve => { sinkAttached = resolve; });
      const resultPromise = client.startTurn({ ...threadInput, threadId: targetThreadId, prompt: "TEST",
        onTextDelta: delta => { deltas.push(delta); sinkAttached(); } });
      if (!terminalBeforeAck) {
        await ready;
        // The buffered delta reaches the sink only once waitForTurn has processed
        // the ACK and installed the alias; subsequent frames use the alias again.
        const emit = (message: unknown) => factory.processes[0]!.stdout.emit("data", `${JSON.stringify(message)}\n`);
        emit({ method: "item/agentMessage/delta", params: { turnId: "notification-alias", delta: "after" } });
        emit({ method: "turn/completed", params: { turn: { id: "notification-alias",
          status: failed ? "failed" : "completed",
          ...(failed ? { error: { message: "synthetic failure", codexErrorInfo: "other" } } : {}),
        } } });
      }
      const result = await resultPromise;
      const startRequest = factory.requests.filter(request => request.method === "turn/start").at(-1)!;
      expect(startRequest.params?.threadId).toBe(targetThreadId);
      expect(result).toMatchObject({ threadId: targetThreadId, acknowledgedTurnId: `response-turn-${turnNumber}`,
        outputText: emptyOutput ? "" : terminalBeforeAck ? "early" : "earlyafter", completed: true, usagePoisoned: false });
      expect(result.usage).toBeUndefined();
      expect(deltas.join("")).toBe(terminalBeforeAck && failed ? "" : result.outputText);
      if (failed) expect(result.error).toMatchObject({ message: expect.stringContaining("synthetic failure"),
        failureDetails: { phase: emptyOutput ? "turn_error_before_output" : "turn_error_after_output" } });
      else expect(result.error).toBeNull();
      // Inspect cleanup as a secondary invariant; identity assertions above are
      // observed public behavior. Reusing the alias next turn also tests cleanup.
      const tracking = client as unknown as { turnIdAliases: Map<string, string>; turns: Map<string, unknown> };
      expect(tracking.turnIdAliases.size).toBe(0);
      expect(tracking.turns.size).toBe(0);
    }
  } finally {
    await client.stop();
    await rm(workspace, { recursive: true, force: true });
    vi.restoreAllMocks();
  }
});

it("rejects a missing ACK ID even when early notifications contain an identity", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "missing-ack-identity-TEST-"));
  const factory = new FakeAppServerFactory({ emitTurnEventsWithStartResponse: true,
    onRequest: request => {
      if (request.method !== "turn/start") return;
      const stdout = factory.processes[0]!.stdout;
      const emit = stdout.emit.bind(stdout);
      vi.spyOn(stdout, "emit").mockImplementationOnce((event, ...args) => {
        const frames = String(args[0]).trim().split("\n");
        frames.shift();
        return emit(event, `${[...frames, JSON.stringify({ id: request.id, result: { turn: {} } })].join("\n")}\n`);
      });
    } });
  const abortSignal = new AbortController().signal;
  const client = new CodexAppServerClient({
    codexBinaryPath: "/fake/codex", sourceEnv: {}, processFactory: factory.create,
    signalChildProcess: (child, signal) => { child.kill(signal); },
    session: { home: workspace, codexHome: workspace, env: {}, release: async () => undefined },
    workspacePath: workspace, executionProfile: resolveCodexExecutionProfile(undefined),
    timeoutMs: 2_000, startupTimeoutMs: 2_000, reconnectGraceMs: 100,
    maxOutputBytes: 4096, abortSignal,
  });
  try {
    await client.start();
    const input = { workspacePath: workspace, model: "test", reasoningEffort: "low" as const,
      timeoutMs: 2_000, abortSignal };
    const threadId = await client.startThread(input);
    await expect(client.startTurn({ ...input, threadId, prompt: "TEST" })).rejects.toMatchObject({
      message: expect.stringContaining("codex_app_server_turn_id_missing"),
      failureDetails: { phase: "turn_start_rejected" },
      cause: { name: "AppServerRequestMayHaveReachedProviderError", method: "turn/start" },
    });
  } finally {
    await client.stop();
    await rm(workspace, { recursive: true, force: true });
    vi.restoreAllMocks();
  }
});
