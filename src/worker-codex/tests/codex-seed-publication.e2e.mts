// Independent review adaptation: only the external app-server protocol is fake.
// Real workers, encrypted stores, source readers and separate Node processes run.
import { EventEmitter } from 'node:events';
import { spawn, execFile, fork } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { CodexAppServerChildProcess, CodexAppServerProcessFactory } from '../../provider-codex/index.js';
import type { ObservabilityPort, RuntimeEvent } from '../../core/index.js';

const repository = process.env.SR_SYNTHETIC_RUNTIME_COPY!;
if (!repository || !repository.includes('/artifacts/')) throw new Error('owned_disposable_runtime_copy_required');
const { FileBackendCodexWorker } = await import(pathToFileURL(join(repository, 'dist/worker-codex/file-backend-codex-worker.js')).href) as typeof import('../file-backend-codex-worker.js');
const { FileBackendCodexSeedWriteback } = await import(pathToFileURL(join(repository, 'dist/worker-codex/file-backend-codex-seed-writeback.js')).href) as typeof import('../file-backend-codex-seed-writeback.js');
const { LocalEncryptedFileStore } = await import(pathToFileURL(join(repository, 'dist/store-local-file/index.js')).href) as typeof import('../../store-local-file/index.js');
const { codexAuthJsonFromArtifact } = await import(pathToFileURL(join(repository, 'dist/provider-codex/index.js')).href) as typeof import('../../provider-codex/index.js');
const fixtureRoot = process.env.SR_SYNTHETIC_FIXTURES!;
if (!fixtureRoot || !fixtureRoot.includes('/artifacts/fixtures')) throw new Error('owned_fixture_root_required');
const digest = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
function auth(refresh: string, last: string): string {
  return JSON.stringify({ auth_mode: 'chatgpt', last_refresh: last, tokens: {
    account_id: 'NOT-AN-ACCOUNT-SYNTHETIC', access_token: 'test-fixture-literal',
    refresh_token: `NOT-A-CREDENTIAL-${refresh}`, expiry: '2035-01-01T00:00:00Z',
  } });
}
const seed = auth('S0', '2026-10-06T19:00:00Z');
const rotated = auth('R', '2026-10-06T19:30:00Z');
const newer = auth('N', '2026-10-06T19:40:00Z');
function invariant(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((r, j) => { resolve = r; reject = j; });
  return { promise, resolve, reject };
}
class Readable extends EventEmitter { setEncoding(_encoding: BufferEncoding) { return this; } }
class Peer extends EventEmitter implements CodexAppServerChildProcess {
  readonly stdout = new Readable(); readonly stderr = new Readable();
  readonly stdin = { write: (chunk: string | Uint8Array) => { this.receive(String(chunk)); return true; }, end() {} };
  private readonly home: string;
  private readonly action: (peer: Peer, home: string) => Promise<void>;
  private objective = '';
  private goalStatus = 'active';
  readonly turnContracts: { model: string; effort: string; serviceTier: string | null }[] = [];
  constructor(home: string, action: (peer: Peer, home: string) => Promise<void>) { super(); this.home = home; this.action = action; }
  kill() { queueMicrotask(() => this.emit('exit', 0, null)); return true; }
  complete() {
    this.goalStatus = 'complete';
    this.stdout.emit('data', JSON.stringify({ method: 'item/agentMessage/delta', params: { turnId: 'turn', delta: 'SYNTHETIC OK' } }) + '\n');
    this.stdout.emit('data', JSON.stringify({ method: 'turn/completed', params: { turn: { id: 'turn', status: { type: 'completed' } } } }) + '\n');
  }
  invalid() { this.stdout.emit('data', JSON.stringify({ method: 'error', message: 'refresh_token_invalidated' }) + '\n'); }
  private receive(chunk: string) {
    for (const line of chunk.trim().split('\n')) {
      const request = JSON.parse(line) as { id: number; method: string; params?: Record<string, unknown> };
      let result: unknown = {};
      if (request.method === 'initialize') result = { userAgent: 'synthetic-e2e' };
      if (request.method === 'thread/start') result = { thread: { id: 'thread' } };
      if (request.method === 'account/rateLimits/read') result = { rateLimits: { primary: null, secondary: null } };
      if (request.method === 'turn/start') {
        invariant(request.params?.model === 'gpt-6.1-sol' && request.params.effort === 'high' &&
          (request.params.serviceTier === null || request.params.serviceTier === 'default'), 'exact_requested_synthetic_model_contract');
        this.turnContracts.push({ model: request.params.model, effort: request.params.effort, serviceTier: request.params.serviceTier });
        result = { turn: { id: 'turn' } };
      }
      if (request.method === 'thread/goal/set') this.objective = String(request.params?.objective);
      if (request.method === 'thread/goal/set' || request.method === 'thread/goal/get') result = { goal: {
        threadId: 'thread', objective: this.objective, status: this.goalStatus, tokenBudget: null,
        tokensUsed: 0, timeUsedSeconds: 0, createdAt: 0, updatedAt: 0,
      } };
      this.stdout.emit('data', JSON.stringify({ id: request.id, result }) + '\n');
      if (request.method === 'turn/start') queueMicrotask(() => { void this.action(this, this.home).catch(() => this.invalid()); });
    }
  }
}
async function fresh(tag: string) {
  await mkdir(fixtureRoot, { recursive: true });
  const root = await mkdtemp(join(fixtureRoot, `synthetic-publication-${tag}-`));
  await mkdir(join(root, 'auth'), { mode: 0o700 });
  await writeFile(join(root, 'auth/auth.json'), seed, { mode: 0o600 });
  return root;
}
async function runWorker(root: string, tag: string) {
  invariant(root.startsWith(join(fixtureRoot, 'synthetic-publication-')), 'synthetic_fixture_required');
  const events: RuntimeEvent[] = []; const imports: string[] = []; const peers: Peer[] = [];
  const observability: ObservabilityPort = { emit: event => events.push(event), count() {}, timing() {} };
  const factory: CodexAppServerProcessFactory = input => {
    const home = input.env.CODEX_HOME!;
    invariant(home.startsWith(root), 'new_synthetic_home_required');
    const peer = new Peer(home, async (peer, path) => {
      const bytes = await readFile(join(path, 'auth.json'), 'utf8'); imports.push(digest(bytes));
      if (tag === 'only-newest' && bytes !== newer) peer.invalid();
      else {
        if (tag === 'held-newer') {
          const released = new Promise<void>(resolve => process.once('message', () => resolve()));
          process.send?.({ syntheticHeld: true }); await released;
        }
        if (tag === 'rotated' || tag === 'newer' || tag === 'unpublishable' || tag === 'held-newer') await writeFile(join(path, 'auth.json'), tag === 'rotated' ? rotated : newer, { mode: 0o600 });
        if (tag === 'unpublishable') await writeFile(join(root, 'auth/.subscription-runtime-auth-writeback'), 'synthetic filesystem publication denial', { mode: 0o600 });
        peer.complete();
      }
    });
    peers.push(peer); return peer;
  };
  const worker = new FileBackendCodexWorker({
    providerInstanceId: `synthetic-${tag}`, stateRootDir: join(root, 'jobs', tag),
    codexBinaryPath: '/SYNTHETIC-NONEXISTENT-PROVIDER', encryptionKey: new Uint8Array(32).fill(29),
    model: 'gpt-6.1-sol', reasoningEffort: 'high', serviceTier: 'default',
    sourceEnv: { SUBSCRIPTION_RUNTIME_MANAGED_LAUNCH: '1' }, appServerProcessFactory: factory, observability,
    clock: { now: () => new Date('2026-10-06T20:00:00Z'), monotonicMs: () => performance.now() },
  });
  let completed = false; let failed = false;
  try {
    await worker.start(); await worker.seedCodexAuthJsonFile(join(root, 'auth/auth.json'));
    try { completed = (await worker.run({ prompt: 'Disposable synthetic publication qualification' })).outputText === 'SYNTHETIC OK'; }
    catch { failed = true; }
    const stored = await new LocalEncryptedFileStore({ providerId: 'codex', rootDir: join(root, 'jobs', tag, 'sessions'), encryptionKey: new Uint8Array(32).fill(29) }).read({ providerInstanceId: `synthetic-${tag}` });
    console.log(JSON.stringify({ completed, failed, imports, turnContracts: peers.flatMap(peer => peer.turnContracts), durableLocalHash: stored ? digest(codexAuthJsonFromArtifact(stored.artifact)) : null,
      exportFailureEvent: events.some(e => e.name === 'codex.auth_path.export_failed') }));
  } finally { await worker.dispose(); }
}
async function child(root: string, tag: string) {
  const result = await promisify(execFile)(process.execPath, [fileURLToPath(import.meta.url), '--worker', root, tag], {
    env: { ...process.env }, timeout: 30_000,
  });
  return JSON.parse(result.stdout.trim()) as { completed: boolean; failed: boolean; imports: string[]; durableLocalHash: string | null; exportFailureEvent: boolean };
}
type InspectorMessage = { id?: number; method?: string; params?: { callFrames?: { location: { lineNumber: number } }[] }; result?: unknown; error?: unknown };
async function stoppedWriter(root: string) {
  const handle = spawn(process.execPath, ['--inspect-brk=127.0.0.1:0', fileURLToPath(import.meta.url), '--worker', root, 'rotated'], {
    env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const endpoint = deferred<string>(); const exited = deferred<{ code: number | null; signal: string | null }>();
  let stderr = ''; let stdout = '';
  const deadline = setTimeout(() => { handle.kill('SIGKILL'); endpoint.reject(new Error('owned_process_observation_timeout')); }, 30_000);
  handle.stderr.on('data', bytes => { stderr += String(bytes); const url = stderr.match(/ws:\/\/127\.0\.0\.1:[0-9]+\/[a-f0-9-]+/); if (url) endpoint.resolve(url[0]); });
  handle.stdout.on('data', bytes => { stdout += String(bytes); });
  handle.on('exit', (code, signal) => { clearTimeout(deadline); exited.resolve({ code, signal }); });
  const socket = new WebSocket(await endpoint.promise);
  await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error('inspector_unavailable')); });
  let id = 0; const pending = new Map<number, ReturnType<typeof deferred<unknown>>>();
  const pauses: InspectorMessage[] = []; const waiters: ReturnType<typeof deferred<InspectorMessage>>[] = [];
  socket.onmessage = event => {
    const message = JSON.parse(String(event.data)) as InspectorMessage;
    if (message.id !== undefined) { const waiter = pending.get(message.id); pending.delete(message.id); if (message.error) waiter?.reject(new Error('inspector_command_failed')); else waiter?.resolve(message.result); }
    if (message.method === 'Debugger.paused') { const waiter = waiters.shift(); if (waiter) waiter.resolve(message); else pauses.push(message); }
  };
  const send = (method: string, params: Record<string, unknown> = {}) => {
    const waiter = deferred<unknown>(); const next = ++id; pending.set(next, waiter); socket.send(JSON.stringify({ id: next, method, params })); return waiter.promise;
  };
  const pause = () => { const event = pauses.shift(); if (event) return Promise.resolve(event); const waiter = deferred<InspectorMessage>(); waiters.push(waiter); return waiter.promise; };
  await send('Debugger.enable');
  // Locate the actual encrypted-store call, never substitute filesystem/locks.
  let module = 'file-backend-codex-seed-writeback';
  let js = await readFile(join(repository, `dist/worker-codex/${module}.js`), 'utf8');
  if (js.includes('publishRefresh')) { module = 'codex-seed-refresh-journal'; js = await readFile(join(repository, `dist/worker-codex/${module}.js`), 'utf8'); }
  const line = js.split('\n').findIndex(text => text.includes('const result = await store.write('));
  invariant(line >= 0, 'actual_store_publication_required');
  await send('Debugger.setBreakpointByUrl', { urlRegex: `.*${module}\\.js$`, lineNumber: line });
  await send('Runtime.runIfWaitingForDebugger'); await pause(); await send('Debugger.resume');
  const boundary = await pause(); invariant(boundary.params?.callFrames?.[0]?.location.lineNumber === line, 'actual_publication_barrier');
  return { handle, socket, send, exited: exited.promise, output: () => stdout, module, line: line + 1 };
}
type Case = { id: string; passed: boolean; facts: Record<string, unknown>; error?: string };
const cases: Case[] = [];
async function scenario(id: string, run: (facts: Record<string, unknown>) => Promise<void>) {
  const facts: Record<string, unknown> = {};
  try { await run(facts); cases.push({ id, passed: true, facts }); }
  catch (error) { cases.push({ id, passed: false, facts, error: error instanceof Error ? error.message : 'unknown' }); }
  console.log(JSON.stringify(cases.at(-1)));
}
async function main() {
  // Real IO failure must be reported to the supported caller, with encrypted
  // job custody retained. ENOTDIR exercises the nearest failure boundary; it
  // does not claim to qualify a systemd read-only mount namespace.
  await scenario('publication-failure-is-visible-and-local-refresh-recoverable', async facts => {
    const root = await fresh('denial'); const result = await child(root, 'unpublishable');
    const local = await new LocalEncryptedFileStore({ providerId: 'codex', rootDir: join(root, 'jobs/unpublishable/sessions'), encryptionKey: new Uint8Array(32).fill(29) }).read({ providerInstanceId: 'synthetic-unpublishable' });
    invariant(local, 'existing_encrypted_job_custody_retained');
    // A trusted parent can consume the existing encrypted job custody and the
    // bounded publisher port. No writable auth mount is granted to the worker.
    await rm(join(root, 'auth/.subscription-runtime-auth-writeback'));
    const custody = new FileBackendCodexSeedWriteback(join(root, 'auth/auth.json'));
    const method = typeof custody.publishRefresh === 'function' ? custody.publishRefresh.bind(custody) : custody.publish.bind(custody);
    const published = await method({ source: seed, expected: seed, next: codexAuthJsonFromArtifact(local.artifact) });
    const reader = await child(root, 'only-newest');
    Object.assign(facts, { root, result, expectedHash: digest(newer), trustedParentPublication: published, independentReader: reader });
    invariant(published && reader.completed && reader.imports[0] === digest(newer), 'trusted_custody_recovery_contract');
    invariant(result.failed && !result.completed && result.exportFailureEvent && result.durableLocalHash === digest(newer), 'publication_loss_falsely_completed');
  });
  // R4 without an outstanding lock: both jobs imported S0; R is committed
  // before the second already-running provider finishes its later N rotation.
  await scenario('R4-known-lineage-parallel-refresh-reconciles-after-another-commit', async facts => {
    const root = await fresh('parallel-cas');
    const handle = fork(fileURLToPath(import.meta.url), ['--worker', root, 'held-newer'], { execPath: process.execPath,
      env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const ready = deferred<void>(); const exited = deferred<number | null>();
    let stdout = '';
    handle.stdout!.on('data', bytes => { stdout += String(bytes); });
    handle.on('message', () => ready.resolve());
    handle.on('exit', code => exited.resolve(code));
    const deadline = setTimeout(() => { handle.kill('SIGKILL'); ready.reject(new Error('owned_parallel_worker_timeout')); }, 30_000);
    try {
      await ready.promise; const first = await child(root, 'rotated');
      handle.send('release'); const exit = await exited.promise; const later = JSON.parse(stdout.trim()) as { completed: boolean };
      const reader = await child(root, 'only-newest'); Object.assign(facts, { root, first, exit, later, reader, expectedHash: digest(newer) });
      invariant(first.completed && exit === 0 && later.completed && reader.completed && reader.imports[0] === digest(newer), 'CAS_discarded_later_known_lineage_rotation');
    } finally { clearTimeout(deadline); if (handle.exitCode === null && handle.signalCode === null) handle.kill('SIGKILL'); }
  });
  // R4 red: B finishes N while A is stopped at the real store publication.
  await scenario('R4-later-only-usable-refresh-survives-concurrent-publication', async facts => {
    const root = await fresh('contention'); const owner = await stoppedWriter(root);
    try {
      const later = await child(root, 'newer');
      await owner.send('Debugger.resume'); owner.socket.close(); const older = await owner.exited;
      const reader = await child(root, 'only-newest');
      Object.assign(facts, { root, boundary: { module: owner.module, line: owner.line }, later, older, reader, expectedHash: digest(newer) });
      invariant(later.completed && reader.completed && reader.imports[0] === digest(newer), 'later_provider_refresh_lost_on_publication_contention');
    } finally { owner.socket.close(); if (owner.handle.exitCode === null && owner.handle.signalCode === null) owner.handle.kill('SIGKILL'); }
  });
  // R5 red: kill only the owned writer, then publish N and read in NEW process.
  await scenario('R5-crashed-publication-cannot-indefinitely-suppress-refresh', async facts => {
    const root = await fresh('crash'); const owner = await stoppedWriter(root);
    owner.handle.kill('SIGKILL'); owner.socket.close(); const killed = await owner.exited;
    const entries = await readdir(join(root, 'auth/.subscription-runtime-auth-writeback'));
    const later = await child(root, 'newer'); const reader = await child(root, 'only-newest');
    Object.assign(facts, { root, killed, entries, later, reader, expectedHash: digest(newer) });
    invariant(killed.signal === 'SIGKILL', 'owned_writer_killed');
    invariant(later.completed && reader.completed && reader.imports[0] === digest(newer), 'crash_silently_lost_refresh');
  });
  for (const atomic of [false, true]) await scenario(`relogin-during-publication-${atomic}`, async facts => {
    const root = await fresh('relogin'); const owner = await stoppedWriter(root);
    try {
      const path = join(root, 'auth/auth.json');
      if (atomic) { await writeFile(path + '.new', newer, { mode: 0o600 }); const { rename } = await import('node:fs/promises'); await rename(path + '.new', path); }
      else await writeFile(path, newer);
      await owner.send('Debugger.resume'); owner.socket.close(); const exit = await owner.exited;
      const reader = await child(root, 'only-newest');
      Object.assign(facts, { root, exit, reader, sourceHash: digest(await readFile(path, 'utf8')) });
      invariant(await readFile(path, 'utf8') === newer && reader.completed, 'new_authorization_overwritten');
    } finally { owner.socket.close(); if (owner.handle.exitCode === null && owner.handle.signalCode === null) owner.handle.kill('SIGKILL'); }
  });
  await scenario('R1-new-process-metadata-rewrite-retains-rotated-refresh', async facts => {
    const root = await fresh('metadata'); await child(root, 'newer');
    await writeFile(join(root, 'auth/auth.json'), seed + '\n'); const reader = await child(root, 'only-newest');
    Object.assign(facts, { root, reader, expectedHash: digest(newer) });
    invariant(reader.completed && reader.imports[0] === digest(newer), 'metadata_rewrite_lost_refresh');
  });
  await scenario('immutable-refresh-custody-encryption-and-private-modes', async facts => {
    const root = await fresh('private'); await child(root, 'newer');
    const directories: string[] = []; const files: string[] = [];
    async function walk(path: string): Promise<void> {
      directories.push(path);
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const next = join(path, entry.name); if (entry.isDirectory()) await walk(next); else files.push(next);
      }
    }
    await walk(join(root, 'auth/.subscription-runtime-auth-writeback'));
    invariant(files.length > 0, 'actual_encrypted_refresh_record');
    for (const path of directories) invariant(((await stat(path)).mode & 0o777) === 0o700, 'private_directory_0700');
    for (const path of files) {
      invariant(((await stat(path)).mode & 0o777) === 0o600, 'private_record_0600');
      invariant(!(await readFile(path, 'utf8')).includes('NOT-A-CREDENTIAL'), 'encrypted_refresh_no_plaintext');
    }
    Object.assign(facts, { root, directoryCount: directories.length, recordCount: files.length, directoryMode: '0700', recordMode: '0600', opaqueRecordDigests: await Promise.all(files.map(async path => digest(await readFile(path, 'utf8')))) });
  });
  await writeFile(join(dirname(repository), `${process.env.SR_SYNTHETIC_PHASE ?? 'unknown'}-publication.json`), JSON.stringify(cases, null, 2) + '\n');
  process.exitCode = cases.some(c => !c.passed) ? 1 : 0;
}
export { Peer, fresh, seed, rotated, newer, digest, child };
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--worker') await runWorker(process.argv[3]!, process.argv[4]!);
  else await main();
}
