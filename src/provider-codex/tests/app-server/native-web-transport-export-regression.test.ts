// These regressions import only pre-existing APIs and also run against the exact base.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { ProviderTaskResult } from "@vioxen/subscription-runtime/core";
import { CodexAppServerClient } from "../../app-server/application/app-server-client";
import { FakeAppServerFactory } from "../../app-server/testing/fake-app-server";
import { resolveCodexExecutionProfile } from "../../codex-execution-profile";
import { providerTaskResultToAgentTaskResult, agentTaskResultToProviderTaskResult, parseAgentTaskResult } from "../../../agent-task/codec";
import { providerTaskResultToAgentRuntimeTaskResult, agentRuntimeTaskResultToProviderTaskResult, parseAgentRuntimeTaskResult } from "../../../agent-runtime-task/codec";

it('exports a recognized native transport completion delivered before turn/start ACK', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'native-web-base-regression-TEST-'));
  const factory = new FakeAppServerFactory({ emitTurnEventsWithStartResponse: true, onRequest: request => {
    if (request.method !== 'turn/start') return;
    const stdout = factory.processes[0]!.stdout; const emit = stdout.emit.bind(stdout);
    vi.spyOn(stdout, 'emit').mockImplementationOnce((event, ...args) => {
      const frames = String(args[0]).trim().split('\n').map(line => JSON.parse(line));
      const ack = frames.shift(); const terminal = frames.pop();
      terminal.params.threadId = request.params?.threadId;
      const native = { method: 'item/completed', params: { threadId: request.params?.threadId, turnId: ack.result.turn.id,
        item: { type: 'webSearch', id: 'web-1', query: 'private query', action: { type: 'openPage', url: 'turn0search0' }, results: null } } };
      return emit(event, [...frames, native, terminal, ack].map(frame => JSON.stringify(frame)).join('\n') + '\n');
    });
  } });
  const abortSignal = new AbortController().signal;
  const client = new CodexAppServerClient({ codexBinaryPath: '/fake/codex', sourceEnv: {}, processFactory: factory.create,
    signalChildProcess: (child, signal) => { child.kill(signal); },
    session: { home: workspace, codexHome: workspace, env: {}, release: async () => undefined },
    workspacePath: workspace, executionProfile: resolveCodexExecutionProfile(undefined),
    timeoutMs: 2_000, startupTimeoutMs: 2_000, reconnectGraceMs: 100, maxOutputBytes: 4096, abortSignal });
  try {
    await client.start();
    const input = { workspacePath: workspace, model: 'test', reasoningEffort: 'low' as const, timeoutMs: 2_000, abortSignal };
    const threadId = await client.startThread(input);
    const result = await client.startTurn({ ...input, threadId, prompt: 'TEST' });
    expect(result).toHaveProperty('nativeWeb', { truncated: false, turns: [{ threadId, acknowledgedTurnId: 'turn-1', unknown: false, truncated: false,
      records: [{ itemId: 'web-1', status: 'completion_only', action: 'open_page' }] }] });
  } finally { await client.stop(); await rm(workspace, { recursive: true, force: true }); vi.restoreAllMocks(); }
});

it.each(['agent-task', 'agent-runtime-task'])('keeps the finite sidechannel through %s JSON export', codec => {
  const nativeWeb = { truncated: false, turns: [{ threadId: 'thread-1', acknowledgedTurnId: 'turn-1', unknown: false, truncated: false,
    records: [{ itemId: 'web-1', status: 'completion_only', action: 'unknown' }] }] };
  // Boundary input is intentionally JSON shaped, so this test can run on old APIs.
  const input = { status: 'completed', outputText: 'done', warnings: [], telemetry: { nativeWeb } } as ProviderTaskResult;
  const result = codec === 'agent-task'
    ? agentTaskResultToProviderTaskResult(parseAgentTaskResult(JSON.parse(JSON.stringify(providerTaskResultToAgentTaskResult(input)))))
    : agentRuntimeTaskResultToProviderTaskResult(parseAgentRuntimeTaskResult(JSON.parse(JSON.stringify(providerTaskResultToAgentRuntimeTaskResult(input)))));
  expect(result.telemetry).toHaveProperty('nativeWeb', nativeWeb);
});
