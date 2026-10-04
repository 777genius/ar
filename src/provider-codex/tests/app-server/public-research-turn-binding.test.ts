import { expect, it, vi } from "vitest";
import { CodexAppServerClient } from "../../app-server/application/app-server-client";
import { PublicSourceAuthentication, PublicSourceBodyEncoding } from "../../app-server/application/public-research-source-port";
import { codexProviderEgressPolicy, CodexProviderEgressProfileId } from "../../codex-provider-egress-policy";
import { resolveCodexExecutionProfile } from "../../codex-execution-profile";
import { ControlledPeer } from "./controlled-readiness-peer";

async function fixture() {
  const peer = new ControlledPeer();
  const read = vi.fn(async (url: string, signal?: AbortSignal) => {
    expect(signal?.aborted).toBe(false);
    return { url, retrievedAt: new Date().toISOString(), status: 200, contentType: "text/plain",
      authentication: PublicSourceAuthentication.Anonymous, bodyEncoding: PublicSourceBodyEncoding.Utf8, body: "TEST source" };
  });
  const abort = new AbortController();
  const client = new CodexAppServerClient({ codexBinaryPath: "/TEST/peer", sourceEnv: {},
    processFactory: () => peer, signalChildProcess: child => { child.kill(); },
    session: { home: "/TEST/home", codexHome: "/TEST/codex-home", env: {}, release: async () => undefined },
    workspacePath: "/TEST/workspace", executionProfile: resolveCodexExecutionProfile(undefined),
    providerEgressPolicy: codexProviderEgressPolicy(CodexProviderEgressProfileId.FullInternetV1),
    publicSourceReader: { read }, timeoutMs: 2000, startupTimeoutMs: 2000,
    reconnectGraceMs: 100, maxOutputBytes: 4096, abortSignal: abort.signal });
  const starting = client.start(); await peer.initialize(); await starting;
  const input = { workspacePath: "/TEST/workspace", model: "gpt-6.1-sol", reasoningEffort: "high" as const,
    serviceTier: "default" as const, timeoutMs: 2000, abortSignal: abort.signal, goalMode: true };
  const thread = client.startThread(input);
  peer.reply(await peer.next("thread/start"), { thread: { id: "TEST-thread" } });
  expect(await thread).toBe("TEST-thread");
  const emit = (...frames: readonly unknown[]) => peer.stdout.emit("data", frames.map(frame => JSON.stringify(frame)).join("\n") + "\n");
  const call = (id: number, turnId: string, callId = String(id)) => ({ id, method: "item/tool/call", params: {
    threadId: "TEST-thread", turnId, callId, tool: "public_source_read", arguments: { url: "https://public.example.test/?q=TEST&lang=en" } } });
  const complete = (turnId: string) => emit({ method: "turn/completed", params: {
    threadId: "TEST-thread", turn: { id: turnId, status: "completed" } } });
  return { peer, read, abort, client, input, emit, call, complete };
}

it("binds source authority synchronously when ACK and tool call share one transport chunk", async () => {
  const f = await fixture();
  try {
    const pending = f.client.startTurn({ ...f.input, threadId: "TEST-thread", prompt: "TEST" });
    const request = await f.peer.next("turn/start");
    f.emit({ id: request.id, result: { turn: { id: "ACK-turn" } } }, f.call(9001, "ACK-turn"));
    await vi.waitFor(() => expect(f.peer.responses).toContainEqual(expect.objectContaining({ id: 9001, result: expect.objectContaining({ success: true }) })));
    expect(f.read).toHaveBeenCalledOnce();
    // Call-id replay remains closed even with a fresh JSON-RPC request id.
    f.emit(f.call(9002, "ACK-turn", "9001"));
    expect(f.peer.responses.at(-1)).toMatchObject({ id: 9002, result: { success: false } });
    expect(f.read).toHaveBeenCalledOnce();
    f.complete("ACK-turn"); await pending;
    f.emit({ id: request.id, result: { turn: { id: "ACK-turn" } } }, f.call(9003, "ACK-turn"));
    expect(f.peer.responses.at(-1)).toMatchObject({ id: 9003, result: { success: false } });
    expect(f.read).toHaveBeenCalledOnce();
  } finally { await f.client.stop(); }
});

it("an aborted request's late ACK cannot bind a subsequent turn on the same thread", async () => {
  const f = await fixture();
  try {
    const firstAbort = new AbortController();
    const first = f.client.startTurn({ ...f.input, abortSignal: firstAbort.signal, threadId: "TEST-thread", prompt: "TEST first" });
    const old = await f.peer.next("turn/start");
    firstAbort.abort(); await expect(first).rejects.toThrow("aborted");
    const next = f.client.startTurn({ ...f.input, threadId: "TEST-thread", prompt: "TEST next" });
    const current = await f.peer.next("turn/start", 2);
    f.emit({ id: old.id, result: { turn: { id: "stale-turn" } } },
      { method: "turn/started", params: { threadId: "TEST-thread", turn: { id: "stale-turn" } } }, f.call(9010, "stale-turn"));
    expect(f.peer.responses.at(-1)).toMatchObject({ id: 9010, result: { success: false } });
    expect(f.read).not.toHaveBeenCalled();
    f.emit({ id: current.id, result: { turn: { id: "current-turn" } } }, f.call(9011, "current-turn"));
    await vi.waitFor(() => expect(f.peer.responses.at(-1)).toMatchObject({ id: 9011, result: { success: true } }));
    expect(f.read).toHaveBeenCalledOnce();
    f.complete("current-turn"); await next;
  } finally { await f.client.stop(); }
});

it("terminal client closure drops a late ACK and tool frames without source reads or replies", async () => {
  const f = await fixture();
  const pending = f.client.startTurn({ ...f.input, threadId: "TEST-thread", prompt: "TEST" });
  const request = await f.peer.next("turn/start");
  const failed = expect(pending).rejects.toThrow();
  await f.client.stop(); await failed;
  const replies = f.peer.responses.length;
  f.emit({ id: request.id, result: { turn: { id: "late-turn" } } }, f.call(9020, "late-turn"));
  expect(f.read).not.toHaveBeenCalled(); expect(f.peer.responses).toHaveLength(replies);
});
