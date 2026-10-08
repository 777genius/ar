#!/usr/bin/env node
// A fake external protocol executable, copied only to a fresh synthetic fixture.
import { readFile, appendFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixture = dirname(fileURLToPath(import.meta.url));
if (!fixture.includes('synthetic-effective-reader-')) throw new Error('disposable_fake_provider_copy_required');
const home = process.env.CODEX_HOME;
if (!home) throw new Error('synthetic_home_required');
const bytes = await readFile(join(home, 'auth.json'), 'utf8');
const parsed = JSON.parse(bytes) as { tokens?: { refresh_token?: string } };
if (!parsed.tokens?.refresh_token?.startsWith('NOT-A-CREDENTIAL-PROBE-')) throw new Error('synthetic_authorization_required');
const accepted = parsed.tokens.refresh_token === 'NOT-A-CREDENTIAL-PROBE-R';
await appendFile(join(fixture, 'imports.jsonl'), JSON.stringify({ digest: createHash('sha256').update(bytes).digest('hex') }) + '\n');
if (process.argv[2] !== 'app-server') {
  if (accepted) process.stdout.write('SYNTHETIC OK\n');
  else { process.stderr.write('refresh_token_invalidated\n'); process.exitCode = 1; }
} else {
  let objective = ''; let status = 'active';
  const output = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
  const goal = () => ({ threadId: 'thread', objective, status, tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 0, updatedAt: 0 });
  for await (const line of createInterface({ input: process.stdin })) {
    const request = JSON.parse(line) as { id?: number; method: string; params?: Record<string, unknown> };
    if (request.id === undefined) continue;
    if (!accepted && request.method !== 'initialize') { output({ id: request.id, error: { code: -32000, message: 'refresh_token_invalidated' } }); continue; }
    let result: unknown = {};
    if (request.method === 'account/read') result = { account: { id: 'NOT-AN-ACCOUNT-PROBE', type: 'chatgpt' } };
    if (request.method === 'account/rateLimits/read') result = { rateLimits: { primary: { usedPercent: 0, windowDurationMins: 300 }, secondary: { usedPercent: 0, windowDurationMins: 10080 } } };
    if (request.method === 'thread/start') result = { thread: { id: 'thread' } };
    if (request.method === 'thread/goal/set') { objective = String(request.params?.objective); result = { goal: goal() }; }
    if (request.method === 'thread/goal/get') result = { goal: goal() };
    if (request.method === 'turn/start') result = { turn: { id: 'turn' } };
    output({ id: request.id, result });
    if (request.method === 'turn/start') {
      status = 'complete';
      output({ method: 'item/agentMessage/delta', params: { turnId: 'turn', delta: 'SYNTHETIC OK' } });
      output({ method: 'turn/completed', params: { turn: { id: 'turn', status: { type: 'completed' } } } });
    }
  }
}
