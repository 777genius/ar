import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { CodexAppServerClient } from "../../app-server/application/app-server-client";
import { FakeAppServerFactory } from "../../app-server/testing/fake-app-server";
import { resolveCodexExecutionProfile } from "../../codex-execution-profile";

const graceMs = 100;
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function runTurn(script: (emit: (frame: unknown) => void) => Promise<void>) {
  const workspace = await mkdtemp(join(tmpdir(), "app-server-reconnect-grace-TEST-"));
  const factory = new FakeAppServerFactory({ emitTurnEventsWithStartResponse: true, suppressTurnCompletion: true, agentMessageDeltas: [] });
  const abortSignal = new AbortController().signal;
  const client = new CodexAppServerClient({
    codexBinaryPath: "/fake/codex", sourceEnv: {}, processFactory: factory.create,
    signalChildProcess: (child, signal) => { child.kill(signal); },
    session: { home: workspace, codexHome: workspace, env: {}, release: async () => undefined },
    workspacePath: workspace, executionProfile: resolveCodexExecutionProfile(undefined),
    timeoutMs: 5_000, startupTimeoutMs: 5_000, reconnectGraceMs: graceMs, maxOutputBytes: 4096, abortSignal,
  });
  try {
    await client.start();
    const input = { workspacePath: workspace, model: "test", reasoningEffort: "low" as const, timeoutMs: 5_000, abortSignal };
    const threadId = await client.startThread(input);
    const result = client.startTurn({ ...input, threadId, prompt: "TEST" });
    await pause(10);
    const emit = (frame: unknown) => { factory.processes[0]!.stdout.emit("data", `${JSON.stringify(frame)}\n`); };
    await script(emit);
    return await result;
  } finally { await client.stop(); await rm(workspace, { recursive: true, force: true }); }
}

const turn = "turn-1";
const completed = (emit: (frame: unknown) => void) => emit({ method: "turn/completed", params: { turn: { id: turn, status: "completed" } } });

// Regression: MiMo emits little agent text, so tool-only work after a successful reconnect used to hit the grace timer.
it("keeps a reconnected turn alive through tool-only activity longer than the grace window", async () => {
  const result = await runTurn(async emit => {
    emit({ method: "error", params: { turnId: turn, error: { message: "Reconnecting... 1/8" }, willRetry: true } });
    for (const method of ["item/started", "item/commandExecution/outputDelta", "item/completed", "thread/tokenUsage/updated"]) {
      await pause(graceMs * 0.6);
      emit({ method, params: { turnId: turn, threadId: "thread-1", item: { type: "commandExecution", id: "cmd-1" }, delta: "x" } });
    }
    completed(emit);
  });
  expect(result.error).toBeNull();
  expect(result.completed).toBe(true);
});

it("still fails a reconnecting turn that shows no further progress", async () => {
  const result = await runTurn(async emit => {
    emit({ method: "error", params: { turnId: turn, error: { message: "Reconnecting... 1/8" }, willRetry: true } });
    await pause(graceMs * 3);
  });
  expect(result.error?.message).toMatch(/codex_app_server_reconnect_timeout/);
});

const reconnecting = (emit: (frame: unknown) => void) =>
  emit({ method: "error", params: { turnId: turn, error: { message: "Reconnecting... 1/8" }, willRetry: true } });

// Every 0.159.2 delta method, each after a fresh reconnect: the timer is one-shot, so each must clear it on its own.
it.each([
  "item/agentMessage/delta", "item/plan/delta", "item/reasoning/textDelta", "item/reasoning/summaryTextDelta",
  "item/commandExecution/outputDelta", "item/fileChange/outputDelta",
])("clears the reconnect grace on %s", async method => {
  const result = await runTurn(async emit => {
    reconnecting(emit);
    await pause(graceMs * 0.5);
    emit({ method, params: { turnId: turn, threadId: "thread-1", delta: "x" } });
    await pause(graceMs * 0.8);
    completed(emit);
  });
  expect(result.error).toBeNull();
  expect(result.completed).toBe(true);
});

// "waiting for network" is the unbounded connection retry of 0.159.2: it must not be swallowed.
it("fails at once on a willRetry error that is not a numbered reconnect", async () => {
  const startedAt = Date.now();
  const result = await runTurn(async emit => {
    emit({ method: "error", params: { turnId: turn, error: { message: "Reconnecting... waiting for network" }, willRetry: true } });
    await pause(10);
  });
  expect(result.error?.message).toMatch(/codex_app_server_error/);
  expect(Date.now() - startedAt).toBeLessThan(graceMs * 5);
});

it("fails at once on a terminal error after a reconnect and activity", async () => {
  const result = await runTurn(async emit => {
    reconnecting(emit);
    emit({ method: "item/started", params: { turnId: turn, threadId: "thread-1", item: { type: "commandExecution", id: "cmd-1" } } });
    emit({ method: "error", params: { turnId: turn, error: { message: "stream disconnected before completion" }, willRetry: false } });
    await pause(10);
  });
  expect(result.error?.message).toMatch(/codex_app_server_error/);
});
