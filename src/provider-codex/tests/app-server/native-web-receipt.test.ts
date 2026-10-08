import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { DefaultRedactor, NativeWebAction, NativeWebItemStatus, anonymousWebUrl, appendNativeWebEvidence, parseNativeWebEvidence, type NativeWebEvidence, type ProviderTaskResult } from "@vioxen/subscription-runtime/core";
import { CodexAppServerClient } from "../../app-server/application/app-server-client";
import { AppServerTurnRunner } from "../../app-server/application/app-server-turn-runner";
import { AppServerGoalRunner } from "../../app-server/application/app-server-goal-runner";
import { redactCompletedAppServerResult } from "../../app-server/application/app-server-result-redactor";
import { FakeAppServerFactory } from "../../app-server/testing/fake-app-server";
import { resolveCodexExecutionProfile } from "../../codex-execution-profile";
import { providerTaskResultToAgentTaskResult, agentTaskResultToProviderTaskResult, parseAgentTaskResult, providerTaskEventToAgentTaskEvent, parseAgentTaskEvent } from "../../../agent-task/codec";
import { providerTaskResultToAgentRuntimeTaskResult, agentRuntimeTaskResultToProviderTaskResult, parseAgentRuntimeTaskResult, providerTaskEventToAgentRuntimeTaskEvent, parseAgentRuntimeTaskEvent } from "../../../agent-runtime-task/codec";
import { CodexAppServerExecutionEngine } from "../../codex-app-server-execution-engine";
import { CodexJsonAgentDriver } from "../../codex-json-agent-driver";
import { AgentRuntimeThreadOutcome } from "../../../agent-runtime-task/types";
import { RecordingManagedRunStore, StaticRunner } from "../codex-provider-test-support";
import { AppServerUsageError, nativeWebFromError, safeNativeWebFromError } from "../../app-server/domain/app-server-usage-error";

const web = (id = 'web-1', extra: Record<string, unknown> = {}) => ({ type: 'webSearch', id, query: 'PRIVATE QUERY', action: { type: 'openPage', url: 'https://example.org/docs' }, results: [{ secret: 'PRIVATE SNIPPET' }], ...extra });
type Frame = { method: string; params: Record<string, unknown> };
type Script = (threadId: string, acknowledged: string, alias: string) => Frame[];
const completed = (threadId: string, turnId: string, item: unknown): Frame => ({ method: 'item/completed', params: { threadId, turnId, item } });
async function fixture(script: Script, options: { early?: boolean; alias?: boolean; late?: Script; failed?: boolean; goals?: readonly string[]; ackId?: string } = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'native-web-receipt-TEST-'));
  let goalRead = 0;
  const factory = new FakeAppServerFactory({ emitTurnEventsWithStartResponse: true,
    mismatchTurnStartResponseId: options.alias ?? false,
    ...(options.goals ? { goalStatusesAfterTurns: options.goals } : {}),
    onRequest: request => {
      if (request.method === 'thread/goal/get' && options.goals) {
        const stdout = factory.processes.at(-1)!.stdout; const emit = stdout.emit.bind(stdout);
        vi.spyOn(stdout, 'emit').mockImplementationOnce((event, ...args) => {
          const frame = JSON.parse(String(args[0]));
          frame.result.goal.status = options.goals![goalRead++] ?? 'complete';
          frame.result.goal.tokensUsed = 50;
          return emit(event, JSON.stringify(frame) + '\n');
        });
        return;
      }
      if (request.method !== 'turn/start') return;
      const stdout = factory.processes.at(-1)!.stdout; const emit = stdout.emit.bind(stdout);
      vi.spyOn(stdout, 'emit').mockImplementationOnce((event, ...args) => {
        const frames = String(args[0]).trim().split('\n').map(line => JSON.parse(line));
        const ack = frames.shift();
        if (options.ackId !== undefined) ack.result.turn.id = options.ackId;
        const threadId = String(request.params?.threadId);
        const actual = frames.find(frame => frame.method === 'turn/started').params.turn.id;
        const ackId = ack.result.turn.id;
        const terminal = frames.pop(); terminal.params.threadId = threadId;
        if (options.failed) { terminal.params.turn.status = 'failed'; terminal.params.turn.error = { message: 'fixture failure' }; }
        const body = [...frames, ...script(threadId, ackId, actual), terminal, ...(options.late?.(threadId, ackId, actual) ?? [])];
        return emit(event, [...(options.early ? [...body, ack] : [ack, ...body])].map(frame => JSON.stringify(frame)).join('\n') + '\n');
      });
    } });
  const abortSignal = new AbortController().signal;
  const client = new CodexAppServerClient({ codexBinaryPath: '/fake/codex', sourceEnv: {}, processFactory: factory.create,
    signalChildProcess: (child, signal) => { child.kill(signal); },
    session: { home: workspace, codexHome: workspace, env: {}, release: async () => undefined },
    workspacePath: workspace, executionProfile: resolveCodexExecutionProfile(undefined),
    timeoutMs: 2_000, startupTimeoutMs: 2_000, reconnectGraceMs: 100, maxOutputBytes: 4096, abortSignal });
  await client.start();
  const input = { workspacePath: workspace, model: 'test', reasoningEffort: 'low' as const, sandboxMode: 'read-only' as const, timeoutMs: 2_000, abortSignal, prompt: 'TEST' };
  return { client, input, factory, close: async () => { await client.stop(); await rm(workspace, { recursive: true, force: true }); vi.restoreAllMocks(); } };
}

// Regression: old item/completed silently discarded native items, including those before ACK.
it.each([false, true])('captures exact acknowledged native items with early=%s and fresh lifetime', async early => {
  const f = await fixture((thread, turn) => [completed(thread, turn, web()), completed(thread, turn, web()), completed(thread, turn, web(`only-${turn}`))], { early });
  try {
    const threadId = await f.client.startThread(f.input);
    for (let n = 1; n <= 2; n++) {
      const result = await f.client.startTurn({ ...f.input, threadId });
      expect(result.nativeWeb?.turns).toHaveLength(1);
      expect(result.nativeWeb?.turns[0]).toEqual({ threadId, acknowledgedTurnId: `turn-${n}`, records: [{ itemId: 'web-1', status: NativeWebItemStatus.CompletionOnly, action: NativeWebAction.OpenPage, requestedUrl: 'https://example.org/docs' }, { itemId: `only-turn-${n}`, status: NativeWebItemStatus.CompletionOnly, action: NativeWebAction.OpenPage, requestedUrl: 'https://example.org/docs' }], unknown: false, truncated: false });
      expect(JSON.stringify(result.nativeWeb)).not.toMatch(/PRIVATE/);
      expect(result.nativeWeb?.truncated).toBe(false);
    }
  } finally { await f.close(); }
});

// Regression: existing output aliases must never lend native evidence to an unrelated ACK.
it('rejects arbitrary early alias, wrong thread/turn, model text and outer stdout imitation', async () => {
  const f = await fixture((thread, ack, alias) => [
    completed(thread, alias, web('alias')), completed('wrong-thread', ack, web('wrong-thread')),
    completed(thread, 'wrong-turn', web('wrong-turn')),
    completed(thread, ack, { type: 'agentMessage', text: JSON.stringify(web('spoof')) }),
    completed(thread, ack, { type: 'commandExecution', id: 'exec', aggregatedOutput: JSON.stringify(web('stdout')), items: [web('nested-guess')] }),
    completed(thread, ack, web('trusted')),
  ], { early: true, alias: true });
  try {
    const threadId = await f.client.startThread(f.input);
    const result = await f.client.startTurn({ ...f.input, threadId });
    expect(result.acknowledgedTurnId).toBe('response-turn-1');
    expect(result.nativeWeb?.turns[0]?.records.map(item => item.itemId)).toEqual(['trusted']);
  } finally { await f.close(); }
});

// Regression: duplicate conflicts revoke the original record; malformed and failed items cannot be completion evidence.
it('rejects conflicting duplicates and malformed IDs, preserves finite failed/unknown observations', async () => {
  const f = await fixture((thread, turn) => [completed(thread, turn, web()), completed(thread, turn, web('web-1', { query: 'different' })), completed(thread, turn, web('bad id')), completed(thread, turn, web('failed', { error: { message: 'PRIVATE ERROR' } })), completed(thread, turn, { type: 'webSearch', id: 'malformed' })]);
  try {
    const threadId = await f.client.startThread(f.input); const result = await f.client.startTurn({ ...f.input, threadId });
    expect(result.nativeWeb?.turns[0]?.unknown).toBe(true);
    expect(result.nativeWeb?.turns[0]?.records.map(item => [item.itemId, item.status])).toEqual([['web-1', NativeWebItemStatus.Unknown], ['failed', NativeWebItemStatus.Failed], ['malformed', NativeWebItemStatus.Unknown]]);
    expect(JSON.stringify(result.nativeWeb)).not.toMatch(/PRIVATE/);
  } finally { await f.close(); }
});

// Regression: a bounded collector must not silently export a complete-looking partial set.
it.each([false, true])('reports overflow with early=%s', async early => {
  const f = await fixture((thread, turn) => Array.from({ length: 70 }, (_, n) => completed(thread, turn, web(`web-${n}`))), { early });
  try {
    const threadId = await f.client.startThread(f.input); const result = await f.client.startTurn({ ...f.input, threadId });
    expect(result.nativeWeb?.turns[0]?.records.length).toBeLessThanOrEqual(64);
    expect(result.nativeWeb?.turns[0]?.truncated).toBe(true); expect(result.nativeWeb?.truncated).toBe(true);
  } finally { await f.close(); }
});

// Regression: closed turns and later turns cannot acquire trailing transport evidence.
it.each([{ early: false, alias: false }, { early: true, alias: false }, { early: false, alias: true }, { early: true, alias: true }])('ignores late items after completed ($early/$alias); absent is empty', async ({ early, alias }) => {
  const f = await fixture(() => [], { early, alias, late: (thread, turn) => [completed(thread, turn, web('late'))] });
  try {
    const threadId = await f.client.startThread(f.input); const result = await f.client.startTurn({ ...f.input, threadId });
    expect(result.nativeWeb?.turns[0]?.records).toEqual([]);
    expect(result.nativeWeb?.turns[0]?.unknown).toBe(alias);
  } finally { await f.close(); }
});

it.each(['https://user:pass@example.org/docs', 'https://@example.org/docs', 'https://:@example.org/docs', 'http:example.org', 'https://example.org/?token=secret', 'https://example.org/#secret', 'file:///private', 'https://example.org/?', 'https://example.org/#', 'not a URL'])('rejects unsafe requested URL %s', url => {
  expect(anonymousWebUrl(url)).toBeUndefined();
});

// Regression: request references and opaque results are API completion only, never retrieved-page metadata.
it('drops ref_id and unsafe request URLs without inventing source results', async () => {
  const f = await fixture((thread, turn) => [completed(thread, turn, web('ref', { action: { type: 'openPage', url: 'turn0search0' } })), completed(thread, turn, web('unsafe', { action: { type: 'openPage', url: 'https://user:pass@example.org/?secret=yes' } }))]);
  try {
    const threadId = await f.client.startThread(f.input); const result = await f.client.startTurn({ ...f.input, threadId });
    expect(result.nativeWeb?.turns[0]?.records).toEqual(['ref', 'unsafe'].map(itemId => ({ itemId, status: NativeWebItemStatus.CompletionOnly, action: NativeWebAction.OpenPage })));
  } finally { await f.close(); }
});

// Regression: successful clean result projection, redaction and both public task envelopes used to drop the sidechannel.
it('exports clean and logical-thread results through redaction and both task codec roundtrips', async () => {
  const f = await fixture((thread, turn) => [completed(thread, turn, web())], { goals: ['active', 'complete'] });
  try {
    const runner = new AppServerTurnRunner({ client: f.client, cleanThreadPrewarm: false });
    const clean = await runner.runCleanTurn({ ...f.input, prepareNext: false });
    const goal = new AppServerGoalRunner({ client: f.client, runStore: new RecordingManagedRunStore() });
    const logical = await goal.runLogicalThreadGoal({ ...f.input, redactor: new DefaultRedactor(), maxGoalTurns: 2, goalContinuePrompt: 'continue' });
    for (const result of [clean, logical]) {
      expect(result.nativeWeb?.turns.length).toBeGreaterThan(0);
      const projected = redactCompletedAppServerResult({ result, schemaWarnings: [], redactor: new DefaultRedactor(), maxOutputBytes: 4096 });
      expect(projected.nativeWeb).toEqual(result.nativeWeb);
      expect(projected).not.toHaveProperty('structuredOutput');
      const provider: ProviderTaskResult = { status: 'completed', outputText: projected.outputText, warnings: [], telemetry: { nativeWeb: projected.nativeWeb! } };
      const task = agentTaskResultToProviderTaskResult(parseAgentTaskResult(JSON.parse(JSON.stringify(providerTaskResultToAgentTaskResult(provider)))));
      const runtime = agentRuntimeTaskResultToProviderTaskResult(parseAgentRuntimeTaskResult(JSON.parse(JSON.stringify(providerTaskResultToAgentRuntimeTaskResult(provider)))));
      expect(task.telemetry?.nativeWeb).toEqual(projected.nativeWeb); expect(runtime.telemetry?.nativeWeb).toEqual(projected.nativeWeb);
      const v3 = providerTaskResultToAgentRuntimeTaskResult(provider, { protocolVersion: 3, thread: { id: 'logical-thread', outcome: AgentRuntimeThreadOutcome.StartedFresh } });
      expect(parseAgentRuntimeTaskResult(JSON.parse(JSON.stringify(v3))).telemetry?.nativeWeb).toEqual(projected.nativeWeb);
      const event = { type: 'completed' as const, occurredAt: new Date(0), result: provider, telemetry: provider.telemetry! };
      expect(parseAgentTaskEvent(JSON.parse(JSON.stringify(providerTaskEventToAgentTaskEvent(event)))).telemetry?.nativeWeb).toEqual(projected.nativeWeb);
      expect(parseAgentRuntimeTaskEvent(JSON.parse(JSON.stringify(providerTaskEventToAgentRuntimeTaskEvent(event)))).telemetry?.nativeWeb).toEqual(projected.nativeWeb);
      const secretRedactor = new DefaultRedactor(); secretRedactor.registerSecret('example.org');
      expect(() => redactCompletedAppServerResult({ result, schemaWarnings: [], redactor: secretRedactor, maxOutputBytes: 4096 })).toThrow();
    }
    expect(logical.nativeWeb?.turns).toHaveLength(2);
  } finally { await f.close(); }
});

// Regression: failed clean execution must carry earlier transport facts without changing failure into success.
it('retains finite native observations on clean turn failure', async () => {
  const f = await fixture((thread, turn) => [completed(thread, turn, web('failed', { error: {} }))], { failed: true });
  try {
    const runner = new AppServerTurnRunner({ client: f.client, cleanThreadPrewarm: false });
    const error = await runner.runCleanTurn({ ...f.input, prepareNext: false }).catch(error => error);
    expect(error).toBeInstanceOf(AppServerUsageError);
    expect(nativeWebFromError(error)?.turns[0]?.records[0]?.status).toBe(NativeWebItemStatus.Failed);
  } finally { await f.close(); }
});

it('validates finite codec records instead of trusting opaque JSON; aggregate cap is explicit', () => {
  const evidence: NativeWebEvidence = { truncated: false, turns: [{ threadId: 'thread-1', acknowledgedTurnId: 'turn-1', records: [{ itemId: 'web-1', status: NativeWebItemStatus.CompletionOnly, action: NativeWebAction.OpenPage }], truncated: false, unknown: false }] };
  for (const change of [{ requestedUrl: 'https://example.org/?token=secret' }, { status: 'success' }, { sourceText: 'PRIVATE' }, { itemId: 'bad id' }]) {
    const forged = { ...evidence, turns: [{ ...evidence.turns[0], records: [{ ...evidence.turns[0]!.records[0], ...change }] }] };
    expect(() => parseNativeWebEvidence(forged)).toThrow();
    expect(() => providerTaskResultToAgentTaskResult({ status: 'completed', outputText: 'x', warnings: [], telemetry: { nativeWeb: forged as NativeWebEvidence } })).toThrow();
    expect(() => providerTaskResultToAgentRuntimeTaskResult({ status: 'completed', outputText: 'x', warnings: [], telemetry: { nativeWeb: forged as NativeWebEvidence } })).toThrow();
  }
  expect(() => parseNativeWebEvidence({ ...evidence, turns: [evidence.turns[0], evidence.turns[0]] })).toThrow();
  let aggregate: NativeWebEvidence = { turns: [], truncated: false };
  for (let n = 0; n < 70; n++) aggregate = appendNativeWebEvidence(aggregate, { ...evidence, turns: [{ ...evidence.turns[0]!, acknowledgedTurnId: `turn-${n}` }] });
  expect(aggregate.truncated).toBe(true); expect(aggregate.turns).toHaveLength(64); expect(parseNativeWebEvidence(aggregate)).toEqual(aggregate);
});

// Full result path: framed client -> runner -> engine -> driver -> Host task envelope.
it.each([false, true])('preserves actual native transport through engine/driver for logical=%s', async logical => {
  const f = await fixture((thread, turn) => [completed(thread, turn, web())], { goals: ['complete'] });
  const engine = new CodexAppServerExecutionEngine({ codexBinaryPath: '/fake/codex', sourceEnv: {}, processFactory: f.factory.create, cleanThreadPrewarm: false, goalMode: logical, maxGoalTurns: 2 });
  const driver = new CodexJsonAgentDriver({ engine, model: 'test', reasoningEffort: 'low', sessionMaterializer: {
    mode: 'ephemeral', materialize: async () => ({ home: f.input.workspacePath, codexHome: f.input.workspacePath, env: {}, release: async () => {} }),
  } });
  try {
    const result = await driver.runTask({ session: { kind: 'opaque-bytes', providerId: 'codex', formatVersion: 'TEST', bytes: new Uint8Array(), contentType: 'application/octet-stream' }, task: { kind: 'structured-prompt', prompt: 'TEST' }, workspace: { path: f.input.workspacePath }, runner: new StaticRunner(''), redactor: new DefaultRedactor(), abortSignal: f.input.abortSignal,
      ...(logical ? { logicalThread: { threadId: 'TEST-logical', onCheckpoint: async () => {} } } : {}),
    });
    expect(result.status).toBe('completed');
    expect(result.telemetry?.nativeWeb?.turns[0]?.records[0]?.status).toBe(NativeWebItemStatus.CompletionOnly);
    const host = providerTaskResultToAgentRuntimeTaskResult(result);
    expect(agentRuntimeTaskResultToProviderTaskResult(parseAgentRuntimeTaskResult(JSON.parse(JSON.stringify(host)))).telemetry?.nativeWeb).toEqual(result.telemetry?.nativeWeb);
  } finally { await driver.dispose(); await f.close(); }
});

// Failure is still failure; empty observations and redaction loss cannot assert native success.
it.each([false, true])('exports failed driver results with native item=%s safely', async withItem => {
  const f = await fixture((thread, turn) => withItem ? [completed(thread, turn, web('failed', { error: { message: 'PRIVATE' } }))] : [], { failed: true });
  const engine = new CodexAppServerExecutionEngine({ codexBinaryPath: '/fake/codex', sourceEnv: {}, processFactory: f.factory.create, cleanThreadPrewarm: false, goalMode: false });
  const driver = new CodexJsonAgentDriver({ engine, model: 'test', sessionMaterializer: { mode: 'ephemeral', materialize: async () => ({ home: f.input.workspacePath, codexHome: f.input.workspacePath, env: {}, release: async () => {} }) } });
  try {
    const result = await driver.runTask({ session: { kind: 'opaque-bytes', providerId: 'codex', formatVersion: 'TEST', bytes: new Uint8Array(), contentType: 'application/octet-stream' }, task: { kind: 'structured-prompt', prompt: 'TEST' }, workspace: { path: f.input.workspacePath }, runner: new StaticRunner(''), redactor: new DefaultRedactor(), abortSignal: f.input.abortSignal });
    expect(result.status).toBe('failed');
    expect(result.telemetry?.nativeWeb?.turns[0]?.records.map(item => item.status)).toEqual(withItem ? [NativeWebItemStatus.Failed] : []);
    expect(agentRuntimeTaskResultToProviderTaskResult(parseAgentRuntimeTaskResult(JSON.parse(JSON.stringify(providerTaskResultToAgentRuntimeTaskResult(result))))).telemetry?.nativeWeb).toEqual(result.telemetry?.nativeWeb);
    expect(JSON.stringify(result.telemetry?.nativeWeb)).not.toMatch(/PRIVATE/);
    const redactor = new DefaultRedactor(); redactor.registerSecret('thread');
    expect(safeNativeWebFromError(new AppServerUsageError(new Error('failure'), undefined, true, result.telemetry?.nativeWeb), redactor)).toEqual({ turns: [], truncated: true });
  } finally { await driver.dispose(); await f.close(); }
});

// A notification identity cannot repair an invalid ACK or malformed target thread ID.
it.each(['bad id', '../turn', 'a'.repeat(129)])('rejects malformed ACK %s', async ackId => {
  const f = await fixture((thread, turn) => [completed(thread, turn, web())], { early: true, ackId });
  try {
    const threadId = await f.client.startThread(f.input);
    await expect(f.client.startTurn({ ...f.input, threadId })).rejects.toThrow(/turn_id_missing/);
    await expect(f.client.startTurn({ ...f.input, threadId: 'bad thread' })).rejects.toThrow(/thread_id_invalid/);
  } finally { await f.close(); }
});
