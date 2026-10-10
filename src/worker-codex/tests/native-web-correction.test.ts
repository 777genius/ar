import "./hosted-test-egress-default-fixture";
import "./unmanaged-goal-host-fixture";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { DefaultRedactor } from "@vioxen/subscription-runtime/core";
import { SafeExecutionRunner } from "@vioxen/subscription-runtime/worker-core";
import { LocalFileAttemptJournal, LocalFileWorkspaceLockStore } from "../../store-local-file/safe-execution";
import { CodexAppServerExecutionEngine, CodexJsonAgentDriver } from "@vioxen/subscription-runtime/provider-codex";
import { AppServerExecutionLifetime } from "../../provider-codex/app-server/application/app-server-child-lifetime";
import { AppServerGoalRunner } from "../../provider-codex/app-server/application/app-server-goal-runner";
import { RecordingManagedRunStore, StaticRunner } from "../../provider-codex/tests/codex-provider-test-support";
import { web, completed, fixture } from "../../provider-codex/tests/app-server/native-web-test-support";
import { assertNativeWebHostExport } from "./native-web-host-export-support";
import { codexGoalAccountSlots, runCodexGoal } from "../codex-goal-runner";

// Reject durable receipts at the actual parser -> replay runner -> Host boundary,
// while leaving opaque result recovery and the model's worker report intact.
it('does not relabel durable native receipts with a fresh Host generation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'r3024-replay-TEST-'));
  const workspacePath = join(root, 'workspace'), journalRoot = join(root, 'journal');
  const promptPath = join(root, 'prompt.md'), outputPath = join(root, 'job', 'latest-result.json');
  const taskId = 'TEST-replay-task';
  const nativeWeb = { truncated: false, turns: [{ threadId: 'stale-thread', acknowledgedTurnId: 'stale-ACK', unknown: false, truncated: false,
    records: [{ itemId: 'stale-item', status: 'completion_only', action: 'unknown' }] }] };
  const recovered = { outputText: 'historical result', structuredOutput: { summary: 'historical report', nativeWeb }, nativeWeb, replayed: false };
  try {
    await mkdir(workspacePath); await writeFile(promptPath, 'TEST');
    const journalDir = join(journalRoot, 'attempt-journal'); await mkdir(journalDir, { recursive: true });
    const journalPath = join(journalDir, `${createHash('sha256').update(taskId).digest('hex')}.json`);
    const bytes = JSON.stringify({ taskId, workspaceRunId: 'TEST-workspace', workspacePath, effectMode: 'read_only', provider: 'codex', status: 'completed',
      executionGeneration: 'old-generation', startedAt: new Date(0), updatedAt: new Date(0), completedAt: new Date(0), attempts: [], outputSummary: 'historical summary', result: recovered });
    await writeFile(journalPath, bytes);
    const runner = new SafeExecutionRunner({ journal: new LocalFileAttemptJournal(journalRoot), lockStore: new LocalFileWorkspaceLockStore(join(root, 'locks')) });
    const pool = { run: vi.fn(async () => { throw new Error('replay must not invoke provider'); }) };
    await runCodexGoal({ workspacePath, promptPath, outputPath, jobRootDir: join(root, 'job'), authRootDir: join(root, 'auth'), taskId, jobId: 'TEST-job', accounts: codexGoalAccountSlots(['TEST-account']) }, {
      createExecutor: () => ({ async run() {
        const result = await runner.run({ taskId, workspace: { mode: 'existing_locked', path: workspacePath }, effectMode: 'read_only', provider: 'codex', pool, job: {}, originalPrompt: 'TEST' });
        expect(result).toMatchObject({ status: 'completed', replayed: true, result: recovered });
        // The result's forged replayed:false is deliberately powerless.
        return result;
      }, async dispose() {} }),
    });
    expect(pool.run).not.toHaveBeenCalled();
    expect(await readFile(journalPath, 'utf8')).toBe(bytes);
    const envelope = JSON.parse(await readFile(outputPath, 'utf8'));
    expect(envelope).toMatchObject({ status: 'done' });
    expect(envelope.evidence).toContain('historical report');
    expect(envelope.evidence).toContain('output_summary:historical summary');
    expect(envelope.details.executionGeneration).toMatch(/^[a-f0-9-]{36}$/u);
    expect(envelope.details).not.toHaveProperty('nativeWeb');
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Shared structured-output wrapper: clean, goal and logical paths all have real
// framed native events, then invalid final model JSON. Fresh successes stay green.
it.each(['clean', 'goal', 'logical', 'fresh'] as const)('preserves transport evidence through managed Host export on %s output', async path => {
  const f = await fixture((thread, turn) => [completed(thread, turn, web())], { goals: ['complete'], outputText: path === 'fresh' ? '{"answer":"ok"}' : 'invalid model JSON', usage: { inputTokens: 30, outputTokens: 10, totalTokens: 40 } });
  const engine = new CodexAppServerExecutionEngine({ codexBinaryPath: '/fake/codex', sourceEnv: {}, processFactory: f.factory.create, cleanThreadPrewarm: false, goalMode: path === 'goal' || path === 'logical', maxGoalTurns: 2 });
  const driver = new CodexJsonAgentDriver({ engine, model: 'test', outputSchemas: { TEST: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false } }, sessionMaterializer: {
    mode: 'ephemeral', materialize: async () => ({ home: f.input.workspacePath, codexHome: f.input.workspacePath, env: {}, release: async () => {} }),
  } });
  try {
    const result = await driver.runTask({ session: { kind: 'opaque-bytes', providerId: 'codex', formatVersion: 'TEST', bytes: new Uint8Array(), contentType: 'application/octet-stream' }, task: { kind: 'structured-prompt', prompt: 'TEST', outputSchemaName: 'TEST' }, workspace: { path: f.input.workspacePath }, runner: new StaticRunner(''), redactor: new DefaultRedactor(), abortSignal: f.input.abortSignal,
      ...(path === 'logical' ? { logicalThread: { threadId: 'TEST-logical', onCheckpoint: async () => {} } } : {}),
    });
    expect(result.status).toBe(path === 'fresh' ? 'completed' : 'failed');
    expect(result.telemetry?.usage).toMatchObject({ inputTokens: 30, outputTokens: 10, totalTokens: 40 });
    expect(result.telemetry?.nativeWeb?.turns[0]).toMatchObject({ acknowledgedTurnId: 'turn-1', records: [{ itemId: 'web-1', status: 'completion_only' }] });
    await assertNativeWebHostExport(result);
  } finally { await driver.dispose(); await f.close(); }
});

it('preserves resumed transport evidence when final structured output is invalid', async () => {
  const f = await fixture((thread, turn) => [completed(thread, turn, web(`web-${turn}`))], { goals: ['blocked', 'complete'], outputText: 'invalid model JSON', usage: { totalTokens: 40 } });
  const runStore = new RecordingManagedRunStore();
  const engine = new CodexAppServerExecutionEngine({ codexBinaryPath: '/fake/codex', sourceEnv: {}, processFactory: f.factory.create, cleanThreadPrewarm: false, goalMode: true, maxGoalTurns: 2, runStore });
  const driver = new CodexJsonAgentDriver({ engine, model: 'test', outputSchemas: { TEST: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false } }, sessionMaterializer: {
    mode: 'ephemeral', materialize: async () => ({ home: f.input.workspacePath, codexHome: f.input.workspacePath, env: {}, release: async () => {} }),
  } });
  const session = { kind: 'opaque-bytes' as const, providerId: 'codex', formatVersion: 'TEST', bytes: new Uint8Array(), contentType: 'application/octet-stream' };
  const common = { session, workspace: { path: f.input.workspacePath }, runner: new StaticRunner(''), redactor: new DefaultRedactor(), abortSignal: f.input.abortSignal };
  try {
    const waiting = await driver.runTask({ ...common, task: { kind: 'structured-prompt', prompt: 'TEST', outputSchemaName: 'TEST', metadata: { codexManagedRunId: 'TEST-resume' } } });
    expect(waiting.status).toBe('waiting_for_input');
    if (waiting.status !== 'waiting_for_input') throw new Error('expected managed request');
    const result = await driver.resumeManagedRun({ ...common, runId: waiting.runId, requestId: waiting.request.id, answer: 'continue', resumeHandle: waiting.resumeHandle, task: { outputSchemaName: 'TEST' } });
    expect(result).toMatchObject({ status: 'failed', failure: { code: 'provider_output_invalid' } });
    expect(result.telemetry?.usage?.totalTokens).toBe(40);
    expect(result.telemetry?.nativeWeb?.turns.at(-1)).toMatchObject({ acknowledgedTurnId: 'turn-2', records: [{ itemId: 'web-turn-2' }] });
    expect(await runStore.get({ runId: waiting.runId })).toMatchObject({ status: 'failed' });
    await assertNativeWebHostExport(result);
  } finally { await driver.dispose(); await f.close(); }
});

// Existing runner/engine and snapshot ports arm a one-shot lifetime assertion
// only after actual transport return. Closing the lifetime aborts the joined wait;
// unresolved peer cleanup must not replace cancellation or release session custody.
// Driver return separately proves the driver's ownership after engine success.
it.each(['engine-return', 'driver-return', 'snapshot', 'empty'] as const)('retains observed receipts without changing cancellation at %s', async window => {
  const f = await fixture((thread, turn) => window === 'empty' ? [] : [completed(thread, turn, web())], { goals: ['complete'], usage: { inputTokens: 30, outputTokens: 10, totalTokens: 40 }, late: (thread, turn) => [completed(thread, turn, web('late'))] });
  const lifetime = new AppServerExecutionLifetime({ deadlineEpochMs: Date.now() + 60_000, maxGoalTurns: 2, binding: { allocationId: 'TEST-allocation', incarnationId: 'TEST-incarnation' } });
  const cancellation = new Error('codex_app_server_aborted');
  const originalAssertActive = lifetime.assertActive.bind(lifetime);
  const cancel = (signal?: AbortSignal) => { lifetime.close(cancellation); originalAssertActive(signal); };
  const arm = () => vi.spyOn(lifetime, 'assertActive').mockImplementationOnce(cancel);
  const engine = new CodexAppServerExecutionEngine({ codexBinaryPath: '/fake/codex', sourceEnv: {}, processFactory: f.factory.create, cleanThreadPrewarm: false, goalMode: true, maxGoalTurns: 2, nativeToolSurface: 'disabled', executionLifetime: lifetime });
  if (window === 'engine-return') {
    const original = AppServerGoalRunner.prototype.runGoal;
    vi.spyOn(AppServerGoalRunner.prototype, 'runGoal').mockImplementation(async function(this: AppServerGoalRunner, input) { const result = await original.call(this, input); arm(); return result; });
  } else if (window !== 'snapshot') {
    const original = engine.run.bind(engine);
    vi.spyOn(engine, 'run').mockImplementation(async input => { const result = await original(input); arm(); return result; });
  }
  const released = vi.fn(async () => {});
  const driver = new CodexJsonAgentDriver({ engine, executionLifetime: lifetime, model: 'test', sessionMaterializer: {
    mode: 'ephemeral', materialize: async () => ({ home: f.input.workspacePath, codexHome: f.input.workspacePath, env: {}, release: released,
      ...(window === 'snapshot' ? { snapshotSession: async () => {
        await Promise.resolve();
        vi.spyOn(lifetime, 'assertActive').mockImplementationOnce(originalAssertActive).mockImplementationOnce(originalAssertActive).mockImplementationOnce(cancel);
        return null;
      } } : {}),
    }),
  } });
  try {
    const result = await driver.runTask({ session: { kind: 'opaque-bytes', providerId: 'codex', formatVersion: 'TEST', bytes: new Uint8Array(), contentType: 'application/octet-stream' }, task: { kind: 'structured-prompt', prompt: 'TEST' }, workspace: { path: f.input.workspacePath }, runner: new StaticRunner(''), redactor: new DefaultRedactor(), abortSignal: f.input.abortSignal });
    expect(lifetime.signal.aborted).toBe(true);
    expect(lifetime.signal.reason).toBe(cancellation);
    expect(result).toMatchObject({ status: 'failed', failure: { code: 'task_cancelled' } });
    expect(result.telemetry?.usage).toMatchObject({ inputTokens: 30, outputTokens: 10, totalTokens: 40 });
    expect(result.telemetry?.nativeWeb).toMatchObject({ truncated: false, turns: [{ threadId: 'thread-1', acknowledgedTurnId: 'turn-1', unknown: false, truncated: false }] });
    expect(result.telemetry?.nativeWeb?.turns).toHaveLength(1);
    expect(result.telemetry?.nativeWeb?.turns[0]?.records).toHaveLength(window === 'empty' ? 0 : 1);
    if (window !== 'empty') expect(result.telemetry?.nativeWeb?.turns[0]?.records).toMatchObject([{ itemId: 'web-1', status: 'completion_only', action: 'open_page', requestedUrl: 'https://example.org/docs', resultSummary: { shape: 'array', count: 1, truncated: false } }]);
    await assertNativeWebHostExport(result);
    expect(f.factory.requests.filter(request => request.method === 'turn/start')).toHaveLength(1);
    expect(released).not.toHaveBeenCalled();
  } finally {
    await expect(driver.dispose()).rejects.toThrow('codex_driver_hosted_cleanup_unresolved');
    lifetime.close(); await f.close();
  }
  expect(released).not.toHaveBeenCalled();
});
