import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CodexAppServerClient } from "../../app-server/application/app-server-client";
import { FakeAppServerFactory } from "../../app-server/testing/fake-app-server";
import { resolveCodexExecutionProfile } from "../../codex-execution-profile";
import { HostedControllerToolName } from "../../app-server/domain/hosted-controller-dynamic-tools";
import { handleAppServerServerRequest } from "../../app-server/application/app-server-server-request-handler";
import { AppServerDynamicToolHandler } from "../../app-server/application/app-server-dynamic-tool-handler";

describe("Codex 0.155.1 dynamic tool contract", () => {
  const sendServerRequest = (factory: FakeAppServerFactory, id: string | number,
    method: string, params: Record<string, unknown>) => {
    factory.processes[0]!.stdout.emit("data", `${JSON.stringify({ id, method, params })}\n`);
  };
  const sendTurnEvent = (factory: FakeAppServerFactory, method: string, params: Record<string, unknown>) => {
    factory.processes[0]!.stdout.emit("data", `${JSON.stringify({ method, params })}\n`);
  };
  async function startFixture(factory: FakeAppServerFactory,
    dispatch: NonNullable<ConstructorParameters<typeof CodexAppServerClient>[0]["hostedControllerTools"]>["dispatch"],
    commandApprovalPolicy?: ConstructorParameters<typeof CodexAppServerClient>[0]["commandApprovalPolicy"]) {
    const workspace = await mkdtemp(join(tmpdir(), "dynamic-tool-ownership-TEST-"));
    const abort = new AbortController();
    const client = new CodexAppServerClient({
      codexBinaryPath: "/bin/codex-test", sourceEnv: {}, processFactory: factory.create,
      signalChildProcess: (child, signal) => { child.kill(signal); },
      session: { home: workspace, codexHome: workspace, env: {}, release: async () => undefined },
      workspacePath: workspace, executionProfile: resolveCodexExecutionProfile({
        kind: "custom", disableTools: false, historyMode: "none",
      }), nativeToolSurface: "disabled", timeoutMs: 2_000, startupTimeoutMs: 2_000,
      reconnectGraceMs: 100, maxOutputBytes: 4096, abortSignal: abort.signal,
      hostedControllerTools: { dispatch },
      ...(commandApprovalPolicy ? { commandApprovalPolicy } : {}),
    });
    await client.start();
    const threadId = await client.startThread({ workspacePath: workspace, model: "test",
      reasoningEffort: "low", timeoutMs: 2_000, abortSignal: abort.signal, goalMode: true });
    const turn = client.startTurn({ threadId, prompt: "test", model: "test", reasoningEffort: "low",
      workspacePath: workspace, timeoutMs: 10_000, abortSignal: abort.signal, goalMode: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { workspace, abort, client, threadId, turn };
  }
  async function stopFixture(fixture: Awaited<ReturnType<typeof startFixture>>) {
    fixture.abort.abort();
    await fixture.turn.catch(() => undefined);
    await fixture.client.stop();
    await rm(fixture.workspace, { recursive: true, force: true });
  }
  const callParams = (threadId: string, turnId: string, callId: string) => ({
    threadId, turnId, callId, namespace: null, tool: HostedControllerToolName.Observe,
    arguments: { handle: "opaque" },
  });

  it.each(["abort", "error ack"])("cancels an early dynamic dispatch when turn/start ends with %s", async (failure) => {
    // Previously clearStartingTurn discarded the early identity without cancelling
    // its dispatch, leaving the adapter signal live after either start failure.
    const factory = new FakeAppServerFactory({ emitTurnEventsWithStartResponse: true,
      mismatchTurnStartResponseId: true, suppressTurnCompletion: true,
      emitServerRequestOnTurn: { method: "item/tool/call", params: callParams("thread-1", "turn-1", "early-call") },
      onRequest: (request) => {
        if (request.method !== "turn/start") return;
        const stdout = factory.processes[0]!.stdout;
        const emit = stdout.emit.bind(stdout);
        // Deliver turn/started and the call while withholding only the start ack.
        vi.spyOn(stdout, "emit").mockImplementationOnce((event, ...args) => {
          const frames = String(args[0]).trim().split("\n")
            .filter((line) => (JSON.parse(line) as { id?: number }).id !== request.id);
          return emit(event, `${frames.join("\n")}\n`);
        });
      },
    });
    let signal: AbortSignal | undefined;
    let release: (() => void) | undefined;
    let aborts = 0;
    let dispatches = 0;
    const fixture = await startFixture(factory, async (_call, currentSignal) => {
      dispatches += 1;
      signal = currentSignal;
      currentSignal.addEventListener("abort", () => { aborts += 1; }, { once: true });
      return await new Promise((resolve) => { release = () => resolve({ status: "disabled" }); });
    });
    let settlements = 0;
    const settled = fixture.turn.then(() => { settlements += 1; }, () => { settlements += 1; });
    try {
      expect(dispatches).toBe(1);
      expect(signal?.aborted).toBe(false);
      expect(factory.responses.filter((response) => response.id === 9_002)).toHaveLength(0);
      const startId = factory.requests.find((request) => request.method === "turn/start")!.id;
      const rejected = expect(fixture.turn).rejects.toMatchObject({
        failureDetails: { phase: "turn_start_rejected" },
        message: expect.stringContaining(failure === "abort"
          ? "codex_app_server_aborted:turn/start" : "codex_app_server_turn_start_failed:synthetic rejection"),
      });
      if (failure === "abort") fixture.abort.abort();
      else factory.processes[0]!.stdout.emit("data", `${JSON.stringify({ id: startId,
        error: { message: "synthetic rejection" } })}\n`);
      await rejected;
      expect(signal?.aborted).toBe(true);
      expect(aborts).toBe(1);
      await settled;
      expect(settlements).toBe(1);

      // A late success ack, both completion identities and adapter settlement
      // must not revive the dispatch, respond to the cancelled call or stop the client.
      factory.processes[0]!.stdout.emit("data", `${JSON.stringify({ id: startId,
        result: { turn: { id: "response-turn-1" } } })}\n`);
      release?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(factory.responses.filter((response) => response.id === 9_002)).toHaveLength(0);
      for (const turnId of ["turn-1", "response-turn-1"]) {
        sendServerRequest(factory, `late-${turnId}`, "item/tool/call",
          callParams(fixture.threadId, turnId, "early-call"));
        sendServerRequest(factory, `late-${turnId}`, "item/tool/call",
          callParams(fixture.threadId, turnId, "early-call"));
        expect(factory.responses.filter((response) => response.id === `late-${turnId}`))
          .toEqual([{ id: `late-${turnId}`, result: { success: false,
            contentItems: [{ type: "inputText", text: "hosted_controller_unavailable" }] } }]);
        sendTurnEvent(factory, "turn/completed", { turn: { id: turnId, status: "completed" } });
      }
      sendServerRequest(factory, 9_002, "item/tool/call", callParams(fixture.threadId, "turn-1", "early-call"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(dispatches).toBe(1);
      expect(aborts).toBe(1);
      expect(settlements).toBe(1);
      expect(factory.responses.filter((response) => response.id === 9_002)).toHaveLength(0);
      expect(factory.processes[0]!.isExited()).toBe(false);
      expect(await fixture.client.startThread({ workspacePath: fixture.workspace, model: "test",
        reasoningEffort: "low", timeoutMs: 2_000, abortSignal: new AbortController().signal,
        goalMode: true })).toBe("thread-2");
    } finally { await stopFixture(fixture); }
  });

  it("uses one replay identity for notification and response turn IDs", async () => {
    // Previously turn-1 and response-turn-1 made separate replay keys, so both
    // request IDs dispatched and both returned hosted_controller_disabled.
    const factory = new FakeAppServerFactory({ emitTurnEventsWithStartResponse: true,
      mismatchTurnStartResponseId: true, suppressTurnCompletion: true,
      emitServerRequestOnTurn: { method: "item/tool/call", params: callParams("thread-1", "turn-1", "shared") },
    });
    let dispatches = 0;
    const fixture = await startFixture(factory, async () => { dispatches += 1; return { status: "disabled" }; });
    try {
      sendServerRequest(factory, "response-alias", "item/tool/call",
        callParams(fixture.threadId, "response-turn-1", "shared"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(dispatches).toBe(1);
      expect(factory.responses.filter((response) => response.id === 9_002)).toEqual([{ id: 9_002,
        result: { success: false, contentItems: [{ type: "inputText", text: "hosted_controller_disabled" }] } }]);
      expect(factory.responses.filter((response) => response.id === "response-alias")).toEqual([{ id: "response-alias",
        result: { success: false, contentItems: [{ type: "inputText", text: "hosted_controller_unavailable" }] } }]);
    } finally { await stopFixture(fixture); }
  });

  it("deduplicates a call received before the turn alias, then cancels its pending dispatch on canonical abort", async () => {
    // Previously the early notification ID and response ID produced different replay keys,
    // and canonical turn cancellation left the early dispatch signal live until its deadline.
    const factory = new FakeAppServerFactory({ emitTurnEventsWithStartResponse: true,
      mismatchTurnStartResponseId: true, suppressTurnCompletion: true,
      emitServerRequestOnTurn: { method: "item/tool/call", params: callParams("thread-1", "turn-1", "same-call") },
    });
    let dispatches = 0;
    let signal: AbortSignal | undefined;
    const fixture = await startFixture(factory, async (_call, currentSignal) => {
      dispatches += 1;
      signal = currentSignal;
      return await new Promise(() => undefined);
    });
    try {
      expect(dispatches).toBe(1);
      sendServerRequest(factory, "replayed-alias", "item/tool/call",
        callParams(fixture.threadId, "response-turn-1", "same-call"));
      expect(dispatches).toBe(1);
      expect(factory.responses.filter((response) => response.id === "replayed-alias"))
        .toEqual([{ id: "replayed-alias", result: { success: false,
          contentItems: [{ type: "inputText", text: "hosted_controller_unavailable" }] } }]);
      sendTurnEvent(factory, "turn/aborted", { turnId: "response-turn-1", reason: "test" });
      expect(signal?.aborted).toBe(true);
      expect(factory.responses.filter((response) => response.id === 9_002)).toHaveLength(0);
    } finally { await stopFixture(fixture); }
  });

  it.each(["turn/completed", "error"])("cancels an aliased pending dispatch on %s", async (method) => {
    // Previously pending dispatches were keyed by the notification ID, so canonical
    // completion and error left their AbortSignal live until the five-second timeout.
    const factory = new FakeAppServerFactory({ emitTurnEventsWithStartResponse: true,
      mismatchTurnStartResponseId: true, suppressTurnCompletion: true,
      emitServerRequestOnTurn: { method: "item/tool/call", params: callParams("thread-1", "turn-1", "pending") },
    });
    let dispatches = 0;
    let signal: AbortSignal | undefined;
    const fixture = await startFixture(factory, async (_call, currentSignal) => {
      dispatches += 1;
      signal = currentSignal;
      return await new Promise(() => undefined);
    });
    try {
      sendTurnEvent(factory, method, method === "error"
        ? { turnId: "response-turn-1", error: { message: "test" } }
        : { turn: { id: "response-turn-1", status: "completed" } });
      expect(signal?.aborted).toBe(true);
      expect(dispatches).toBe(1);
      expect(factory.responses.filter((response) => response.id === 9_002)).toHaveLength(0);
    } finally { await stopFixture(fixture); }
  });

  it.each([71, "request-71"])("owns %s across dynamic, unsupported and approval methods", async (id) => {
    // Previously an unsupported or approval request reused a pending dynamic ID and
    // wrote an error or approval plus the eventual dynamic result with the same ID.
    const factory = new FakeAppServerFactory({ suppressTurnCompletion: true });
    let dispatches = 0;
    let release: (() => void) | undefined;
    let approvals = 0;
    const fixture = await startFixture(factory, async () => {
      dispatches += 1;
      return await new Promise((resolve) => { release = () => resolve({ status: "disabled" }); });
    }, { reviewCommand: () => { approvals += 1; return { approved: false }; } });
    try {
      sendServerRequest(factory, id, "item/tool/call", callParams(fixture.threadId, "turn-1", "owned"));
      sendServerRequest(factory, id, "client/unsupported", {});
      sendServerRequest(factory, id, "item/commandExecution/requestApproval", { command: "ignored" });
      expect(dispatches).toBe(1);
      expect(approvals).toBe(0);
      expect(factory.responses.filter((response) => response.id === id)).toHaveLength(0);
      release?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(factory.responses.filter((response) => response.id === id)).toEqual([{ id,
        result: { success: false, contentItems: [{ type: "inputText", text: "hosted_controller_disabled" }] } }]);
      sendServerRequest(factory, id, "item/tool/call", callParams(fixture.threadId, "turn-1", "other"));
      expect(dispatches).toBe(1);
      expect(factory.responses.filter((response) => response.id === id)).toHaveLength(1);
    } finally { await stopFixture(fixture); }
  });

  it.each([71, "request-71"])("does not dispatch dynamic calls after %s was claimed by another method", async (id) => {
    // Previously reversing arrival order still let dynamic routing dispatch a duplicate ID.
    const factory = new FakeAppServerFactory({ suppressTurnCompletion: true });
    let dispatches = 0;
    const fixture = await startFixture(factory, async () => { dispatches += 1; return { status: "disabled" }; });
    try {
      sendServerRequest(factory, id, "client/unsupported", {});
      sendServerRequest(factory, id, "item/tool/call", callParams(fixture.threadId, "turn-1", "late"));
      expect(dispatches).toBe(0);
      expect(factory.responses.filter((response) => response.id === id)).toHaveLength(1);
      expect(factory.responses.find((response) => response.id === id)?.error).toBeDefined();
    } finally { await stopFixture(fixture); }
  });

  it("keeps a supported approval's response when its ID is reused by a dynamic call", async () => {
    // Previously the approval wrote a response but left its numeric ID unclaimed,
    // so the following dynamic call dispatched and wrote a second response.
    const factory = new FakeAppServerFactory({ suppressTurnCompletion: true });
    let dispatches = 0;
    let approvals = 0;
    const fixture = await startFixture(factory, async () => { dispatches += 1; return { status: "disabled" }; },
      { reviewCommand: () => { approvals += 1; return { approved: false }; } });
    try {
      sendServerRequest(factory, 71, "item/commandExecution/requestApproval", { command: "ignored" });
      sendServerRequest(factory, 71, "item/tool/call", callParams(fixture.threadId, "turn-1", "late"));
      expect(approvals).toBe(1);
      expect(dispatches).toBe(0);
      expect(factory.responses.filter((response) => response.id === 71)).toEqual([
        { id: 71, result: { decision: "decline" } },
      ]);
    } finally { await stopFixture(fixture); }
  });
  it("keeps the nonhosted unsupported request response", () => {
    const errors: string[] = [];
    handleAppServerServerRequest({ id: 1, method: "item/tool/call", params: null,
      warn: () => undefined, respond: () => { throw new Error("unexpected result"); },
      respondError: (_id, message) => errors.push(message) });
    expect(errors).toEqual(["unsupported_server_request:item/tool/call"]);
  });
  it("advertises only three bounded tools and replies to string and numeric IDs with no submission", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "dynamic-tool-contract-"));
    const factory = new FakeAppServerFactory({ suppressTurnCompletion: true });
    const abort = new AbortController();
    let submissions = 0;
    let cancelled = 0;
    let releaseDeferred: (() => void) | undefined;
    const client = new CodexAppServerClient({
      codexBinaryPath: "/bin/codex-test", sourceEnv: {}, processFactory: factory.create,
      signalChildProcess: (child, signal) => { child.kill(signal); },
      session: { home: workspace, codexHome: workspace, env: {}, release: async () => undefined },
      workspacePath: workspace, executionProfile: resolveCodexExecutionProfile({
        kind: "custom", disableTools: false, historyMode: "none",
      }),
      nativeToolSurface: "disabled", timeoutMs: 2_000, startupTimeoutMs: 2_000,
      reconnectGraceMs: 100, maxOutputBytes: 4096, abortSignal: abort.signal,
      hostedControllerTools: { dispatch: async (call, signal) => {
        submissions += 1;
        if (call.arguments.handle === "defer") return await new Promise((resolve) => {
          releaseDeferred = () => resolve({ status: "disabled" });
        });
        if (call.arguments.handle === "cancel") return await new Promise((resolve) => {
          signal.addEventListener("abort", () => { cancelled += 1; resolve({ status: "unavailable" }); }, { once: true });
        });
        return { status: "disabled" };
      } },
    });
    try {
      await client.start();
      const threadId = await client.startThread({ workspacePath: workspace, model: "test",
        reasoningEffort: "low", timeoutMs: 2_000, abortSignal: abort.signal, goalMode: true });
      const start = factory.requests.find((request) => request.method === "thread/start");
      expect(start?.params?.dynamicTools).toHaveLength(3);
      expect((start?.params?.config as Record<string, any>).features).toMatchObject({ shell_tool: false, unified_exec: false });
      expect(start?.params?.environments).toEqual([]);
      const turn = client.startTurn({ threadId, prompt: "test", model: "test", reasoningEffort: "low",
        workspacePath: workspace, timeoutMs: 2_000, abortSignal: abort.signal, goalMode: true });
      await new Promise((resolve) => setTimeout(resolve, 10));
      const send = (id: string | number, params: Record<string, unknown>) => factory.processes[0]!.stdout.emit("data",
        `${JSON.stringify({ id, method: "item/tool/call", params })}\n`);
      const valid = { threadId, turnId: "turn-1", callId: "call-1", namespace: null,
        tool: HostedControllerToolName.Observe, arguments: { handle: "opaque" } };
      send("request-a", valid);
      send(19, { ...valid, callId: "call-2" });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(factory.responses.filter((response) => response.id === "request-a" || response.id === 19))
        .toEqual([{ id: "request-a", result: { success: false, contentItems: [{ type: "inputText", text: "hosted_controller_disabled" }] } },
          { id: 19, result: { success: false, contentItems: [{ type: "inputText", text: "hosted_controller_disabled" }] } }]);
      send(20, { ...valid, callId: "call-2" });
      send("request-a", { ...valid, callId: "call-replayed-request" });
      send(21, { ...valid, callId: "call-3", threadId: "foreign" });
      send(22, { ...valid, callId: "call-4", arguments: { handle: "opaque", command: "sh" } });
      send(23, { ...valid, callId: "call-5", arguments: { handle: "x".repeat(129) } });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(factory.responses.filter((response) => [20, 21, 22, 23].includes(response.id as number)).map((r) =>
        (r.result as any).contentItems[0].text)).toEqual([
          "hosted_controller_unavailable", "hosted_controller_unavailable",
          "hosted_controller_unavailable", "hosted_controller_unavailable",
        ]);
      expect(Math.max(...factory.responses.map((response) => Buffer.byteLength(JSON.stringify(response))))).toBeLessThan(256);
      expect(factory.responses.filter((response) => response.id === "request-a")).toHaveLength(1);
      send(24, { ...valid, callId: "call-7", tool: HostedControllerToolName.Launch,
        arguments: { key: "slot-key", profile: "isolated-write", task: "Synthetic task" } });
      send(25, { ...valid, callId: "call-8", tool: HostedControllerToolName.Stop });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(factory.responses.filter((response) => response.id === 24 || response.id === 25).map((r) =>
        (r.result as any).contentItems[0].text)).toEqual(["hosted_controller_disabled", "hosted_controller_disabled"]);
      expect(submissions).toBe(4);
      send("deferred", { ...valid, callId: "call-deferred", arguments: { handle: "defer" } });
      send("deferred", { ...valid, callId: "call-duplicate", arguments: { handle: "opaque" } });
      expect(factory.responses.filter((response) => response.id === "deferred")).toHaveLength(0);
      releaseDeferred?.();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(factory.responses.filter((response) => response.id === "deferred")).toEqual([{ id: "deferred",
        result: { success: false, contentItems: [{ type: "inputText", text: "hosted_controller_disabled" }] } }]);
      expect(submissions).toBe(5);
      send("cancelled", { ...valid, callId: "call-6", arguments: { handle: "cancel" } });
      factory.processes[0]!.stdout.emit("data", `${JSON.stringify({ method: "serverRequest/resolved",
        params: { threadId: "foreign", requestId: "cancelled" } })}\n`);
      expect(cancelled).toBe(0);
      factory.processes[0]!.stdout.emit("data", `${JSON.stringify({ method: "serverRequest/resolved",
        params: { threadId, requestId: "cancelled" } })}\n`);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(cancelled).toBe(1);
      expect(factory.responses.some((response) => response.id === "cancelled")).toBe(false);
      expect(submissions).toBe(6);
      abort.abort();
      await turn.catch(() => undefined);
    } finally {
      await client.stop(); await rm(workspace, { recursive: true, force: true });
    }
  });

  it("returns one bounded unavailable response when its own dispatch deadline expires", async () => {
    vi.useFakeTimers();
    try {
      const responses: unknown[] = [];
      const handler = new AppServerDynamicToolHandler({
        adapter: { dispatch: async () => await new Promise(() => undefined) },
        isActiveTurn: () => true, isTerminal: () => false,
        logicalTurnId: (turnId) => turnId,
        respond: (_id, result) => responses.push(result),
      });
      handler.addThread("thread-1");
      const call = handler.call(7, { threadId: "thread-1", turnId: "turn-1", callId: "call-1",
        namespace: null, tool: HostedControllerToolName.Observe, arguments: { handle: "opaque" } });
      await vi.advanceTimersByTimeAsync(5_000);
      await call;
      expect(responses).toEqual([{ success: false,
        contentItems: [{ type: "inputText", text: "hosted_controller_unavailable" }] }]);
      expect(Buffer.byteLength(JSON.stringify(responses[0]))).toBeLessThan(256);
    } finally { vi.useRealTimers(); }
  });

  it("accepts a tool call in the turn/start stdout chunk and its validated turn alias", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "dynamic-tool-coalesced-"));
    const factory = new FakeAppServerFactory({ emitTurnEventsWithStartResponse: true,
      mismatchTurnStartResponseId: true, suppressTurnCompletion: true,
      emitServerRequestOnTurn: { method: "item/tool/call", params: { threadId: "thread-1", turnId: "turn-1",
        callId: "coalesced", namespace: null, tool: HostedControllerToolName.Observe,
        arguments: { handle: "opaque" } } },
    });
    const abort = new AbortController();
    let dispatches = 0;
    const client = new CodexAppServerClient({
      codexBinaryPath: "/bin/codex-test", sourceEnv: {}, processFactory: factory.create,
      signalChildProcess: (child, signal) => { child.kill(signal); },
      session: { home: workspace, codexHome: workspace, env: {}, release: async () => undefined },
      workspacePath: workspace, executionProfile: resolveCodexExecutionProfile({
        kind: "custom", disableTools: false, historyMode: "none",
      }), nativeToolSurface: "disabled", timeoutMs: 2_000, startupTimeoutMs: 2_000,
      reconnectGraceMs: 100, maxOutputBytes: 4096, abortSignal: abort.signal,
      hostedControllerTools: { dispatch: async (call) => {
        dispatches += 1;
        if (call.arguments.handle === "stall") return await new Promise<never>(() => undefined);
        return { status: "disabled" };
      } },
    });
    try {
      await client.start();
      const threadId = await client.startThread({ workspacePath: workspace, model: "test",
        reasoningEffort: "low", timeoutMs: 2_000, abortSignal: abort.signal, goalMode: true });
      const turn = client.startTurn({ threadId, prompt: "test", model: "test", reasoningEffort: "low",
        workspacePath: workspace, timeoutMs: 10_000, abortSignal: abort.signal, goalMode: true });
      await new Promise((resolve) => setTimeout(resolve, 10));
      factory.processes[0]!.stdout.emit("data", `${JSON.stringify({ id: "aliased", method: "item/tool/call",
        params: { threadId, turnId: "turn-1", callId: "later", namespace: null,
          tool: HostedControllerToolName.Observe, arguments: { handle: "opaque" } } })}\n`);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(factory.responses.filter((response) => response.id === 9_002 || response.id === "aliased")
        .map((response) => (response.result as any).contentItems[0].text))
        .toEqual(["hosted_controller_disabled", "hosted_controller_disabled"]);
      expect(dispatches).toBe(2);
      vi.useFakeTimers();
      try {
        factory.processes[0]!.stdout.emit("data", `${JSON.stringify({ id: "timed-out", method: "item/tool/call",
          params: { threadId, turnId: "turn-1", callId: "stall", namespace: null,
            tool: HostedControllerToolName.Observe, arguments: { handle: "stall" } } })}\n`);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(factory.responses.filter((response) => response.id === "timed-out")).toEqual([{ id: "timed-out",
          result: { success: false, contentItems: [{ type: "inputText", text: "hosted_controller_unavailable" }] } }]);
        expect(dispatches).toBe(3);
      } finally { vi.useRealTimers(); }
      abort.abort(); await turn.catch(() => undefined);
    } finally { await client.stop(); await rm(workspace, { recursive: true, force: true }); }
  });
});
