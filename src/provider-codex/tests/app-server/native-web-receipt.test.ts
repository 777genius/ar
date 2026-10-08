import { web, completed, fixture } from "./native-web-test-support";
import * as nativeJson from "../../app-server/application/app-server-native-web-json";
import { createHash } from "node:crypto";
import { AppServerNativeWebCapture } from "../../app-server/application/app-server-native-web";
import { expect, it, vi } from "vitest";
import { DefaultRedactor, NativeWebAction, NativeWebItemStatus, anonymousWebUrl, appendNativeWebEvidence, parseNativeWebEvidence, type NativeWebEvidence, type ProviderTaskResult } from "@vioxen/subscription-runtime/core";
import { AppServerTurnRunner } from "../../app-server/application/app-server-turn-runner";
import { AppServerGoalRunner } from "../../app-server/application/app-server-goal-runner";
import { redactCompletedAppServerResult } from "../../app-server/application/app-server-result-redactor";
import { providerTaskResultToAgentTaskResult, agentTaskResultToProviderTaskResult, parseAgentTaskResult, providerTaskEventToAgentTaskEvent, parseAgentTaskEvent } from "../../../agent-task/codec";
import { providerTaskResultToAgentRuntimeTaskResult, agentRuntimeTaskResultToProviderTaskResult, parseAgentRuntimeTaskResult, providerTaskEventToAgentRuntimeTaskEvent, parseAgentRuntimeTaskEvent } from "../../../agent-runtime-task/codec";
import { CodexAppServerExecutionEngine } from "../../codex-app-server-execution-engine";
import { CodexJsonAgentDriver } from "../../codex-json-agent-driver";
import { AgentRuntimeThreadOutcome } from "../../../agent-runtime-task/types";
import { RecordingManagedRunStore, StaticRunner } from "../codex-provider-test-support";
import { AppServerUsageError, nativeWebFromError, safeNativeWebFromError } from "../../app-server/domain/app-server-usage-error";

const opaqueSummary = { shape: 'array', count: 1, observedJsonBytes: Buffer.byteLength(JSON.stringify(web().results)), sha256: createHash('sha256').update(JSON.stringify(web().results)).digest('hex'), digestScope: 'complete_reserialized_json', truncated: false };

// Regression: old item/completed silently discarded native items, including those before ACK.
it.each([false, true])('captures exact acknowledged native items with early=%s and fresh lifetime', async early => {
  const f = await fixture((thread, turn) => [completed(thread, turn, web()), completed(thread, turn, web()), completed(thread, turn, web(`only-${turn}`))], { early });
  try {
    const threadId = await f.client.startThread(f.input);
    for (let n = 1; n <= 2; n++) {
      const result = await f.client.startTurn({ ...f.input, threadId });
      expect(result.nativeWeb?.turns).toHaveLength(1);
      expect(result.nativeWeb?.turns[0]).toEqual({ threadId, acknowledgedTurnId: `turn-${n}`, records: [{ itemId: 'web-1', status: NativeWebItemStatus.CompletionOnly, action: NativeWebAction.OpenPage, resultSummary: opaqueSummary, requestedUrl: 'https://example.org/docs' }, { itemId: `only-turn-${n}`, status: NativeWebItemStatus.CompletionOnly, action: NativeWebAction.OpenPage, resultSummary: opaqueSummary, requestedUrl: 'https://example.org/docs' }], unknown: false, truncated: false });
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
    completed(thread, 'wrong-turn', web('bad id')),
    completed(thread, ack, { type: 'agentMessage', text: JSON.stringify(web('spoof')) }),
    completed(thread, ack, { type: 'commandExecution', id: 'exec', aggregatedOutput: JSON.stringify(web('stdout')), items: [web('nested-guess')] }),
    completed(thread, ack, web('trusted')),
  ], { early: true, alias: true });
  try {
    const threadId = await f.client.startThread(f.input);
    const result = await f.client.startTurn({ ...f.input, threadId });
    expect(result.acknowledgedTurnId).toBe('response-turn-1');
    expect(result.nativeWeb?.turns[0]?.records.map(item => item.itemId)).toEqual(['trusted']);
    expect(result.nativeWeb?.turns[0]?.unknown).toBe(true); // alias terminal still fences exact ACK
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
    expect(result.nativeWeb?.turns[0]?.records).toEqual(['ref', 'unsafe'].map(itemId => ({ itemId, status: NativeWebItemStatus.CompletionOnly, action: NativeWebAction.OpenPage, resultSummary: opaqueSummary })));
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
it.each([{ logical: false, large: false }, { logical: true, large: false }, { logical: false, large: true }])('preserves actual native transport through engine/driver for logical=$logical/large=$large', async ({ logical, large }) => {
  const f = await fixture((thread, turn) => [completed(thread, turn, web('web-1', large ? { results: ['PRIVATE'.repeat(20_000)] } : {}))], { goals: ['complete'] });
  const engine = new CodexAppServerExecutionEngine({ codexBinaryPath: '/fake/codex', sourceEnv: {}, processFactory: f.factory.create, cleanThreadPrewarm: false, goalMode: logical, maxGoalTurns: 2 });
  const driver = new CodexJsonAgentDriver({ engine, model: 'test', reasoningEffort: 'low', sessionMaterializer: {
    mode: 'ephemeral', materialize: async () => ({ home: f.input.workspacePath, codexHome: f.input.workspacePath, env: {}, release: async () => {} }),
  } });
  try {
    const result = await driver.runTask({ session: { kind: 'opaque-bytes', providerId: 'codex', formatVersion: 'TEST', bytes: new Uint8Array(), contentType: 'application/octet-stream' }, task: { kind: 'structured-prompt', prompt: 'TEST' }, workspace: { path: f.input.workspacePath }, runner: new StaticRunner(''), redactor: new DefaultRedactor(), abortSignal: f.input.abortSignal,
      ...(logical ? { logicalThread: { threadId: 'TEST-logical', onCheckpoint: async () => {} } } : {}),
    });
    expect(result.status).toBe('completed');
    expect(result.telemetry?.nativeWeb?.turns[0]?.records[0]?.resultSummary?.digestScope).toBe(large ? 'prefix_reserialized_json' : 'complete_reserialized_json');
    expect(result.telemetry?.nativeWeb?.truncated).toBe(large);
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

// d38 discarded opaque results and rejected serde Option/default omissions.
it('distinguishes absent, null, empty, populated and invalid results through framed transport', async () => {
  const absent = web('absent'); delete (absent as Record<string, unknown>).results; delete (absent as Record<string, unknown>).action;
  const f = await fixture((thread, turn) => [absent, web('null', { results: null, action: null }), web('empty', { results: [], action: { type: 'search' } }), web('populated'), web('invalid', { results: {} }), web('nested', { action: { type: 'findInPage' } })].map(item => completed(thread, turn, item)));
  try {
    const threadId = await f.client.startThread(f.input);
    const result = await f.client.startTurn({ ...f.input, threadId });
    const records = result.nativeWeb!.turns[0]!.records;
    expect(records.map(item => item.status)).toEqual(['completion_only', 'completion_only', 'completion_only', 'completion_only', 'unknown', 'completion_only']);
    expect(records.map(item => item.resultSummary?.shape)).toEqual(['absent', 'null', 'array', 'array', 'invalid', 'array']);
    expect(records[2]?.resultSummary).toEqual({ shape: 'array', count: 0, observedJsonBytes: 2, sha256: createHash('sha256').update('[]').digest('hex'), digestScope: 'complete_reserialized_json', truncated: false });
    expect(records[3]?.resultSummary).toEqual(opaqueSummary);
    expect(JSON.stringify(records)).not.toMatch(/PRIVATE|secret/);
    expect(parseNativeWebEvidence(JSON.parse(JSON.stringify(result.nativeWeb)))).toEqual(result.nativeWeb);
  } finally { await f.close(); }
});

// A prefix is an observation, never a complete hash/byte count or an empty array.
it('exports truthful bounded UTF-8 prefixes and bounds repeated duplicate work', () => {
  const capture = new AppServerNativeWebCapture('thread'); capture.bind('turn');
  const results = ['é'.repeat(100_000)];
  capture.observe({ threadId: 'thread', turnId: 'wrong', item: web('wrong', { results }) }, false);
  capture.observe({ threadId: 'thread', turnId: 'turn', item: web('large', { results }) }, false);
  const serialized = Buffer.from(JSON.stringify(results)); const prefix = serialized.subarray(0, 64 * 1024);
  expect(capture.result()?.turns[0]?.records[0]?.resultSummary).toEqual({ shape: 'array', count: 1, observedJsonBytes: prefix.length, sha256: createHash('sha256').update(prefix).digest('hex'), digestScope: 'prefix_reserialized_json', truncated: true });
  expect(capture.result()).toMatchObject({ truncated: true, turns: [{ unknown: true, truncated: true }] });
  for (let n = 0; n < 300; n++) capture.observe({ threadId: 'thread', turnId: 'turn', item: web('large', { results }) }, false);
  expect(capture.result()?.turns[0]?.records).toEqual([{ itemId: 'large', status: 'unknown', action: 'unknown' }]);
  // Once processing budget is consumed a new item cannot masquerade as observed.
  capture.observe({ threadId: 'thread', turnId: 'turn', item: web('after-budget') }, false);
  expect(capture.result()?.turns[0]?.records).toHaveLength(1);
});

// Logical failure wrapping previously returned the prior aggregate, hiding the
// rejecting turn's real client timeout after exact ACK/native notifications.
it.each([1, 2])('retains native observations when turn %s rejects after notifications', async rejectTurn => {
  const f = await fixture((thread, turn) => [completed(thread, turn, web(`web-${turn}`))], { rejectTurn, goals: ['active', 'complete'] });
  try {
    const goal = new AppServerGoalRunner({ client: f.client, runStore: new RecordingManagedRunStore() });
    const error = await goal.runLogicalThreadGoal({ ...f.input, redactor: new DefaultRedactor(), maxGoalTurns: 2, goalContinuePrompt: 'continue' }).catch(error => error);
    expect(error).toBeInstanceOf(AppServerUsageError);
    const evidence = nativeWebFromError(error);
    expect(evidence?.turns).toHaveLength(rejectTurn);
    expect(evidence?.turns.at(-1)?.records[0]).toMatchObject({ itemId: `web-turn-${rejectTurn}`, resultSummary: opaqueSummary });
    expect(parseNativeWebEvidence(evidence)).toEqual(evidence);
    expect(JSON.stringify(evidence)).not.toMatch(/PRIVATE/);
  } finally { await f.close(); }
});

// Admission must reject foreign identity and unique overflow before hashing;
// duplicate storms must terminate bounded processing even for identical items.
it('admits identities and caps before spending its finite processing budget', () => {
  const digest = vi.spyOn(nativeJson, 'boundedNativeWebJson');
  try {
    const capture = new AppServerNativeWebCapture('thread'); capture.bind('turn');
    for (let n = 0; n < 300; n++) capture.observe({ threadId: 'thread', turnId: 'foreign', item: web() }, false);
    capture.observe({ threadId: 'foreign', turnId: 'turn', item: web() }, false);
    expect(digest).not.toHaveBeenCalled();
    for (let n = 0; n < 64; n++) capture.observe({ threadId: 'thread', turnId: 'turn', item: web(`item-${n}`) }, false);
    expect(digest).toHaveBeenCalledTimes(128);
    for (let n = 0; n < 300; n++) capture.observe({ threadId: 'thread', turnId: 'turn', item: web(`overflow-${n}`) }, false);
    expect(digest).toHaveBeenCalledTimes(128);
    for (let n = 0; n < 300; n++) capture.observe({ threadId: 'thread', turnId: 'turn', item: web('item-0') }, false);
    expect(digest.mock.calls.length).toBeLessThanOrEqual(512);
    expect(capture.result()).toMatchObject({ truncated: true, turns: [{ records: expect.any(Array), unknown: true, truncated: true }] });
    expect(capture.result()?.turns[0]?.records).toHaveLength(64);
  } finally { digest.mockRestore(); }
});

it.each([
  { type: 'search', query: [] }, { type: 'search', queries: [1] },
  { type: 'openPage', url: false }, { type: 'findInPage', pattern: 1 },
])('does not normalize invalid present action members to completion (%j)', action => {
  const capture = new AppServerNativeWebCapture('thread'); capture.bind('turn');
  capture.observe({ threadId: 'thread', turnId: 'turn', item: web('invalid-action', { action }) }, false);
  expect(capture.result()?.turns[0]).toMatchObject({ unknown: true, records: [{ status: 'unknown' }] });
});

// Finite summary contract cannot smuggle payloads or claim a prefix is complete.
it('rejects summary payload injection and inconsistent digest/cap semantics at codecs', () => {
  const capture = new AppServerNativeWebCapture('thread'); capture.bind('turn');
  capture.observe({ threadId: 'thread', turnId: 'turn', item: web() }, false);
  const evidence = capture.result()!;
  for (const change of [{ body: 'PRIVATE' }, { count: -1 }, { observedJsonBytes: 65_537 }, { digestScope: 'raw_wire' }, { sha256: 'bad' }, { truncated: true }, { shape: 'null' }]) {
    const forged = { ...evidence, turns: [{ ...evidence.turns[0]!, records: [{ ...evidence.turns[0]!.records[0]!, resultSummary: { ...opaqueSummary, ...change } }] }] };
    expect(() => parseNativeWebEvidence(forged)).toThrow('native_web_evidence_invalid');
  }
});

// Independently isolates gap 1: all optional members are present and valid,
// so d38 fails solely because it discards the returned opaque result payload.
it('summarizes populated opaque results independently of optional normalization', async () => {
  const f = await fixture((thread, turn) => [completed(thread, turn, web())]);
  try {
    const threadId = await f.client.startThread(f.input);
    const result = await f.client.startTurn({ ...f.input, threadId });
    expect(result.nativeWeb?.turns[0]?.records[0]?.resultSummary).toEqual(opaqueSummary);
    expect(JSON.stringify(result.nativeWeb)).not.toMatch(/PRIVATE|secret/);
  } finally { await f.close(); }
});

it('filters malformed pre-ACK items by exact turn before marking unknown', async () => {
  const f = await fixture((thread, turn) => [completed(thread, 'foreign', web('bad id')), completed(thread, turn, web())], { early: true });
  try {
    const threadId = await f.client.startThread(f.input);
    const result = await f.client.startTurn({ ...f.input, threadId });
    expect(result.nativeWeb?.turns[0]).toMatchObject({ unknown: false, truncated: false, records: [{ itemId: 'web-1' }] });
  } finally { await f.close(); }
});

// JSON bytes/digests are reserialized UTF-8 observations, including escapes and
// surrogate pairs. Depth loss is explicit, and opaque unsafe URLs stay opaque.
it('bounds depth and hashes complete reserialized JSON without extracting opaque URLs', () => {
  const results = [{ text: 'é😀\n"\\', url: 'https://user:password@example.org/?token=PRIVATE', nested: [null, false, 0] }];
  const capture = new AppServerNativeWebCapture('thread'); capture.bind('turn');
  capture.observe({ threadId: 'thread', turnId: 'turn', item: web('utf8', { results }) }, false);
  expect(capture.result()?.turns[0]?.records[0]?.resultSummary).toEqual({ shape: 'array', count: 1, observedJsonBytes: Buffer.byteLength(JSON.stringify(results)), sha256: createHash('sha256').update(JSON.stringify(results)).digest('hex'), digestScope: 'complete_reserialized_json', truncated: false });
  expect(JSON.stringify(capture.result())).not.toMatch(/user:password|token=|PRIVATE|\"text\"|\"nested\"/);
  let deep: unknown = null; for (let n = 0; n < 200; n++) deep = [deep];
  const bounded = new AppServerNativeWebCapture('thread'); bounded.bind('turn');
  bounded.observe({ threadId: 'thread', turnId: 'turn', item: web('deep', { results: [deep] }) }, false);
  expect(bounded.result()).toMatchObject({ truncated: true, turns: [{ unknown: true, truncated: true, records: [{ resultSummary: { count: 1, digestScope: 'prefix_reserialized_json', truncated: true } }] }] });
  expect(parseNativeWebEvidence(bounded.result())).toEqual(bounded.result());
  // JSON.parse can overflow a numeric exponent to Infinity; never normalize
  // that malformed observation to a complete JSON null payload digest.
  const nonfinite = new AppServerNativeWebCapture('thread'); nonfinite.bind('turn');
  nonfinite.observe({ threadId: 'thread', turnId: 'turn', item: web('nonfinite', { results: JSON.parse('[1e999]') }) }, false);
  expect(nonfinite.result()).toMatchObject({ truncated: true, turns: [{ unknown: true, records: [{ resultSummary: { count: 1, observedJsonBytes: 1, digestScope: 'prefix_reserialized_json', truncated: true } }] }] });
});

// Terminal failures fence same-burst trailing input, retaining only preterminal ACK items.
const failureFenceCases = ['turn/aborted', 'turn_aborted', 'error', 'global'].flatMap(method =>
  [false, true].flatMap(early => [false, true].flatMap(alias => [false, true].map(populated => ({ method, early, alias, populated })))));
it.each(failureFenceCases)('terminal native fence $method early=$early alias=$alias populated=$populated', async ({ method, early, alias, populated }) => {
  const f = await fixture((thread, ack, output) => [
    ...(populated ? [completed(thread, ack, web('before')), completed(thread, output, web('alias-before'))] : []),
    { method: method === 'global' ? 'error' : method, params: { threadId: thread, ...(method === 'global' ? {} : { turnId: output }), reason: 'TEST terminal', error: { message: 'TEST terminal' } } },
    completed(thread, ack, web('after')), completed(thread, output, web('alias-after')),
  ], { early, alias });
  try {
    const threadId = await f.client.startThread(f.input);
    const result = await f.client.startTurn({ ...f.input, threadId });
    expect(result.error?.message).toMatch(/codex_app_server_(turn_aborted|error)/);
    expect(result.acknowledgedTurnId).toBe(alias ? 'response-turn-1' : 'turn-1');
    expect(result.nativeWeb?.turns[0]?.acknowledgedTurnId).toBe(result.acknowledgedTurnId);
    expect(result.nativeWeb?.turns[0]?.records.map(item => item.itemId)).toEqual(populated ? (alias ? ['before'] : ['before', 'alias-before']) : []);
    if (populated) expect(result.nativeWeb?.turns[0]?.records[0]?.resultSummary).toEqual(opaqueSummary);
  } finally { await f.close(); }
});

// Reconnect is progress: sealing here would discard legitimate following ACK evidence.
it.each([false, true])('terminal native fence keeps reconnect open early=%s', async early => {
  const f = await fixture((thread, ack) => [
    { method: 'error', params: { turnId: ack, error: { message: 'Reconnecting... 2/5' } } },
    completed(thread, ack, web('after-reconnect')),
  ], { early });
  try {
    const threadId = await f.client.startThread(f.input);
    const result = await f.client.startTurn({ ...f.input, threadId });
    expect(result.error).toBeNull();
    expect(result.nativeWeb?.turns[0]?.records.map(item => item.itemId)).toEqual(['after-reconnect']);
  } finally { await f.close(); }
});

// Two real active turns distinguish global sealing from specific-turn isolation.
it.each([false, true].flatMap(global => [false, true].map(alias => ({ global, alias }))))('terminal native fence concurrent global=$global alias=$alias', async ({ global, alias }) => {
  const f = await fixture((thread, ack) => ack.endsWith('turn-1') ? [completed(thread, ack, web('first-before'))] : [
    { method: 'error', params: { ...(global ? {} : { turnId: 'turn-1' }), error: { message: 'TEST terminal' } } },
    completed('thread-1', alias ? 'response-turn-1' : 'turn-1', web('first-after')), completed(thread, ack, web('second-after')),
  ], { rejectTurn: 1, alias });
  try {
    const firstThread = await f.client.startThread(f.input);
    const secondThread = await f.client.startThread(f.input);
    let outputObserved!: () => void;
    const active = new Promise<void>(resolve => { outputObserved = resolve; });
    const first = f.client.startTurn({ ...f.input, threadId: firstThread, onTextDelta: outputObserved });
    await active;
    const secondResult = await f.client.startTurn({ ...f.input, threadId: secondThread });
    const firstResult = await first;
    expect(firstResult.error?.message).toMatch(/codex_app_server_error/);
    expect(firstResult.nativeWeb?.turns[0]?.records.map(item => item.itemId)).toEqual(['first-before']);
    expect(Boolean(secondResult.error)).toBe(global);
    expect(secondResult.nativeWeb?.turns[0]?.records.map(item => item.itemId)).toEqual(global ? [] : ['second-after']);
  } finally { await f.close(); }
});
