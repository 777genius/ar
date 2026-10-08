import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { CodexAppServerClient } from "../../app-server/application/app-server-client";
import { FakeAppServerFactory } from "../../app-server/testing/fake-app-server";
import { resolveCodexExecutionProfile } from "../../codex-execution-profile";

export const web = (id = 'web-1', extra: Record<string, unknown> = {}) => ({ type: 'webSearch', id, query: 'PRIVATE QUERY', action: { type: 'openPage', url: 'https://example.org/docs' }, results: [{ secret: 'PRIVATE SNIPPET' }], ...extra });
type Frame = { method: string; params: Record<string, unknown> };
type Script = (threadId: string, acknowledged: string, alias: string) => Frame[];
export const completed = (threadId: string, turnId: string, item: unknown): Frame => ({ method: 'item/completed', params: { threadId, turnId, item } });
export async function fixture(script: Script, options: { early?: boolean; alias?: boolean; late?: Script; failed?: boolean; goals?: readonly string[]; ackId?: string; rejectTurn?: number } = {}) {
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
        const body = [...frames, ...script(threadId, ackId, actual), ...(options.rejectTurn === Number(ackId.split("-").at(-1)) ? [] : [terminal]), ...(options.late?.(threadId, ackId, actual) ?? [])];
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
