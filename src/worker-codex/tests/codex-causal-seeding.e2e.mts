// Disposable fixtures only: actual workers/custody and OS processes, fake external protocol.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, rm, readdir, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { worker, fresh, auth, hash, assert } from './codex-restart-quota-remediation.e2e.mts';
import { Peer } from './codex-seed-publication.e2e.mts';
import type { RuntimeEvent } from '../../core/index.js';

const repository = process.env.SR_SYNTHETIC_RUNTIME_COPY!;
const { FileBackendCodexSeedWriteback } = await import(pathToFileURL(join(repository, 'dist/worker-codex/file-backend-codex-seed-writeback.js')).href) as typeof import('../file-backend-codex-seed-writeback.js');
const { FileBackendCodexWorker } = await import(pathToFileURL(join(repository, 'dist/worker-codex/file-backend-codex-worker.js')).href) as typeof import('../file-backend-codex-worker.js');
const { LocalEncryptedFileStore } = await import(pathToFileURL(join(repository, 'dist/store-local-file/index.js')).href) as typeof import('../../store-local-file/index.js');
const { codexAuthJsonFromArtifact } = await import(pathToFileURL(join(repository, 'dist/provider-codex/index.js')).href) as typeof import('../../provider-codex/index.js');
const { codexAccountCapacityStore } = await import(pathToFileURL(join(repository, 'dist/worker-codex/application/codex-account-capacity-store.js')).href) as typeof import('../application/codex-account-capacity-store.js');
const { codexSessionCapacityAccountId } = await import(pathToFileURL(join(repository, 'dist/worker-codex/codex-session-capacity-identity.js')).href) as typeof import('../codex-session-capacity-identity.js');
type Result = { completed: boolean; imports: string[]; failureCode: string | null; events?: string[] };
const cases: { id: string; passed: boolean; facts: Record<string, unknown>; error?: string }[] = [];
async function scenario(id: string, run: (facts: Record<string, unknown>) => Promise<void>) {
  const facts: Record<string, unknown> = {};
  try { await run(facts); cases.push({ id, passed: true, facts }); }
  catch (e) { cases.push({ id, passed: false, facts, error: e instanceof Error ? e.message : 'unknown' }); }
  await writeFile(join(dirname(repository), (process.env.SR_SYNTHETIC_PHASE ?? 'causal') + '-causal-cases.json'), JSON.stringify(cases, null, 2) + '\n');
  console.log(JSON.stringify(cases.at(-1)));
}
async function child(root: string, mode: string, expected: string): Promise<Result> {
  // Root qualification can supply its independently reconstructed exact 058.
  // Without it, use the real public API to create an explicitly unbound fixture.
  const prebinding = mode.startsWith('unbound') ? process.env.SR_SYNTHETIC_PREBINDING_RUNTIME_COPY : undefined;
  const childMode = prebinding ? mode.replace('unbound', 'prebinding') : mode;
  const out = await promisify(execFile)(process.execPath, [fileURLToPath(import.meta.url), '--child', root, childMode, hash(expected)], {
    env: { ...process.env, ...(prebinding ? { SR_SYNTHETIC_RUNTIME_COPY: prebinding } : {}) }, timeout: 20000,
  });
  return JSON.parse(out.stdout) as Result;
}
async function run(w: ReturnType<typeof worker>, imports: string[]): Promise<Result> {
  let completed = false, failureCode: string | null = null;
  try { completed = (await w.run({ prompt: 'Synthetic provenance boundary' })).outputText === 'SYNTHETIC OK'; }
  catch (e) { failureCode = e instanceof Error ? e.message : 'unknown'; }
  return { completed, imports, failureCode };
}
async function stored(root: string) {
  return new LocalEncryptedFileStore({ providerId: 'codex', rootDir: join(root, 'jobs/restarted/sessions'), encryptionKey: new Uint8Array(32).fill(27) })
    .read({ providerInstanceId: 'synthetic-restarted', expectedProviderId: 'codex', purpose: 'synthetic-evidence' });
}
async function main() {
  // d0a break: read selects encrypted N(parent R), but local freshness keeps R.
  for (const lifecycle of ['reused', 'new-process'] as const) for (const missing of [false, true]) {
    await scenario('trusted-descendant-' + lifecycle + '-' + missing, async f => {
      const x = await fresh('causal'); const n = auth(randomUUID(), missing ? null : '2026-10-06T18:00:00Z');
      let turns = 0; const imports: string[] = [];
      const first = worker(x.root, async (p, h, b) => {
        if (turns++ === 0) { await writeFile(join(h, 'auth.json'), x.r, { mode: 0o600 }); p.complete(); }
        else b === n ? p.complete() : p.invalid();
      }, imports);
      try {
        await first.start(); await first.seedCodexAuthJsonFile(x.source);
        assert((await run(first, imports)).completed, 'initial_R_rotation');
        await writeFile(join(x.root, 'next.fixture'), n, { mode: 0o600 });
        const descendant = await child(x.root, 'descendant', x.r);
        assert(descendant.completed && descendant.imports[0] === hash(x.r), 'independent_process_R_to_N');
        const journal = new FileBackendCodexSeedWriteback(x.source);
        assert(await journal.read(x.s0) === n, 'reader_selected_N');
        let result: Result;
        if (lifecycle === 'reused') result = await run(first, imports.slice(1));
        else { await first.dispose(); result = await child(x.root, 'accept', n); }
        Object.assign(f, { descendant, result, expectedN: hash(n), staleR: hash(x.r), sourceUnchanged: await readFile(x.source, 'utf8') === x.s0 });
        // run(first, slice) captures the result list after the asynchronous turn.
        if (lifecycle === 'reused') result.imports = imports.slice(1);
        assert(result.completed && result.imports[0] === hash(n), 'worker_ignored_trusted_descendant');
        assert(await readFile(x.source, 'utf8') === x.s0, 'source_overwritten');
      } finally { await first.dispose(); }
    });
  }
  // A selected sibling is not a descendant: changed bytes alone grant no replacement.
  for (const unproven of ['original', 'sibling', 'newer-sibling'] as const) await scenario('unpublished-R-retained-' + unproven, async f => {
    const x = await fresh('unproven'); const loss = join(x.root, 'auth/a/.subscription-runtime-auth-writeback');
    const first = worker(x.root, async (p, h) => { await writeFile(join(h, 'auth.json'), x.r, { mode: 0o600 }); await writeFile(loss, 'synthetic publication unavailable'); p.complete(); });
    try { await first.start(); await first.seedCodexAuthJsonFile(x.source); assert(!(await run(first, [])).completed, 'publication_loss_explicit'); } finally { await first.dispose(); }
    await rm(loss);
    const sibling = auth(randomUUID(), unproven === 'sibling' ? '2026-10-06T18:00:00Z' : '2032-01-01');
    const journal = new FileBackendCodexSeedWriteback(x.source);
    if (unproven !== 'original') await journal.publishRefresh({ source: x.s0, expected: x.s0, next: sibling });
    const result = await child(x.root, 'accept', x.r); Object.assign(f, { result, expectedR: hash(x.r) });
    assert(result.completed && result.imports[0] === hash(x.r), 'unproven_incoming_destroyed_R');
    assert(await readFile(x.source, 'utf8') === x.s0, 'source_overwritten');
    if (unproven === 'newer-sibling') assert(await journal.read(x.s0) === sibling, 'writeback_fabricated_sibling_ancestry');
  });
  // d0a break: missing binding silently uses clocks and has no migration observation.
  // Default fixtures use the public worker/store API, NOT an actual 058 binary.
  // SR_SYNTHETIC_PREBINDING_RUNTIME_COPY enables exact-058-before/new-candidate-after qualification.
  for (const stamp of ['older', 'missing', 'future'] as const) await scenario('unbound-explicit-recovery-' + stamp, async f => {
    const x = await fresh('unbound'); await writeFile(join(x.root, 'next.fixture'), x.r, { mode: 0o600 });
    assert((await child(x.root, 'unbound', x.s0)).completed, 'unbound_rotation_setup');
    const before = await stored(x.root); assert(before && !before.metadata.codexSourceAuthorizationIdentity, 'fixture_actually_unbound');
    const s1 = auth(randomUUID(), stamp === 'missing' ? null : stamp === 'future' ? '2032-01-01' : '2026-10-06T18:00:00Z');
    await writeFile(x.source, s1, { mode: 0o600 });
    const result = await child(x.root, 'observe-unbound', s1);
    const after = await stored(x.root);
    Object.assign(f, { result, prebindingRuntimeSupplied: Boolean(process.env.SR_SYNTHETIC_PREBINDING_RUNTIME_COPY), beforeGeneration: before.generation, afterGeneration: after?.generation, retainedR: after ? hash(codexAuthJsonFromArtifact(after.artifact)) : null, expectedR: hash(x.r) });
    assert(!result.completed && result.imports[0] === hash(x.r), 'unbound_R_overwritten_by_clock');
    assert(result.events?.includes('codex.auth_path.unbound_local_retained'), 'migration_not_observable');
    assert(after && codexAuthJsonFromArtifact(after.artifact) === x.r && !after.metadata.codexSourceAuthorizationIdentity, 'unbound_custody_or_binding_corrupted');
    const shared = codexAccountCapacityStore(join(x.root, 'auth'));
    const s1State = shared.read({ accountId: 'a', now: new Date('2030-01-01') });
    const rState = shared.read({ accountId: codexSessionCapacityAccountId(JSON.parse(x.r))!, now: new Date('2030-01-01') });
    assert(s1State?.reason !== 'provider_session_invalid' && rState?.reason === 'provider_session_invalid', 'unbound_failure_poisoned_S1');
    const recovery = await child(x.root, 'recover', s1);
    assert(recovery.completed && recovery.imports[0] === hash(s1), 'explicit_distinct_custody_recovery_failed');
    assert(await readFile(x.source, 'utf8') === s1, 'recovery_overwrote_source');
    for (const entry of await readdir(join(x.root, 'jobs/restarted/sessions'), { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const path = join(x.root, 'jobs/restarted/sessions', entry.name);
      assert(!(await readFile(path, 'utf8')).includes('NOT-A-CREDENTIAL-') && ((await stat(path)).mode & 0o777) === 0o600, 'encrypted_recovery_custody_lost');
    }
    Object.assign(f, { independentS1Invalid: s1State?.reason === 'provider_session_invalid', retainedRInvalid: rState?.reason, recovery, sourceUnchanged: true });
  });
  await scenario('unbound-unchanged-source-no-publication-loss', async f => {
    const x = await fresh('unbound-control'); await writeFile(join(x.root, 'next.fixture'), x.r, { mode: 0o600 });
    await child(x.root, 'unbound', x.s0);
    const result = await child(x.root, 'accept', x.r); Object.assign(f, { result, expectedR: hash(x.r) });
    assert(result.completed && result.imports[0] === hash(x.r) && await readFile(x.source, 'utf8') === x.s0, 'unbound_original_destroyed_R');
  });
  await scenario('unbound-unchanged-source-unpublished-only-R', async f => {
    const x = await fresh('unbound-unpublished'); await writeFile(join(x.root, 'next.fixture'), x.r, { mode: 0o600 });
    const before = await child(x.root, 'unbound-loss', x.s0);
    await rm(join(x.root, 'auth/a/.subscription-runtime-auth-writeback'), { force: true });
    const result = await child(x.root, 'accept', x.r);
    Object.assign(f, { before, result, expectedR: hash(x.r), prebindingRuntimeSupplied: Boolean(process.env.SR_SYNTHETIC_PREBINDING_RUNTIME_COPY) });
    assert(result.completed && result.imports[0] === hash(x.r) && await readFile(x.source, 'utf8') === x.s0, 'unbound_unpublished_only_R_destroyed');
    if (process.env.SR_SYNTHETIC_PREBINDING_RUNTIME_COPY) assert(!before.completed, 'prebinding_publication_loss_not_explicit');
  });
  await scenario('unbound-reused-observation-is-not-a-binding', async f => {
    const x = await fresh('unbound-reused'), s1 = auth(randomUUID(), null);
    const imports: string[] = []; let turns = 0;
    const w = worker(x.root, async (p, h, b) => {
      if (turns++ === 0) { await writeFile(join(h, 'auth.json'), x.r, { mode: 0o600 }); p.complete(); }
      else b === s1 ? p.complete() : p.invalid();
    }, imports);
    try {
      await w.start(); await w.seedCodexAuthJson(x.s0); await w.run({ prompt: 'Synthetic unbound R' });
      await w.seedCodexAuthJsonFile(x.source); await writeFile(x.source, s1, { mode: 0o600 });
      const result = await run(w, imports); const local = await stored(x.root);
      Object.assign(f, { result, retainedR: local ? hash(codexAuthJsonFromArtifact(local.artifact)) : null, expectedR: hash(x.r) });
      assert(!result.completed && imports.at(-1) === hash(x.r) && local && !local.metadata.codexSourceAuthorizationIdentity, 'observed_source_fabricated_unbound_binding');
      assert(await readFile(x.source, 'utf8') === s1, 'unbound_source_overwritten');
    } finally { await w.dispose(); }
  });
  await scenario('unbound-further-rotation-is-explicit-local-recovery', async f => {
    const x = await fresh('unbound-refresh'), s1 = auth(randomUUID(), null), next = auth(randomUUID(), null);
    await writeFile(join(x.root, 'next.fixture'), x.r, { mode: 0o600 }); await child(x.root, 'unbound', x.s0);
    await writeFile(x.source, s1, { mode: 0o600 }); await writeFile(join(x.root, 'next.fixture'), next, { mode: 0o600 });
    const result = await child(x.root, 'rotate-retained', x.r), local = await stored(x.root);
    Object.assign(f, { result, recoveryHash: local ? hash(codexAuthJsonFromArtifact(local.artifact)) : null, expectedHash: hash(next) });
    assert(!result.completed && result.failureCode === 'Codex refresh publication failed; encrypted local session retained.', 'unbound_rotation_publication_loss_hidden');
    assert(local && codexAuthJsonFromArtifact(local.artifact) === next && !local.metadata.codexSourceAuthorizationIdentity && await readFile(x.source, 'utf8') === s1, 'unbound_refresh_recovery_lost');
  });
  await scenario('owner-S1-versus-late-local-N', async f => {
    const x = await fresh('owner'); const n = auth(randomUUID(), null), s1 = auth(randomUUID(), null);
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(r => { release = r; }), ready = new Promise<void>(r => { entered = r; });
    let turns = 0; const imports: string[] = [];
    const w = worker(x.root, async (p, h, b) => {
      if (turns++ === 0) { await writeFile(join(h, 'auth.json'), x.r, { mode: 0o600 }); p.complete(); }
      else if (turns === 2) { entered(); await held; await writeFile(join(h, 'auth.json'), n, { mode: 0o600 }); p.complete(); }
      else b === s1 ? p.complete() : p.invalid();
    }, imports);
    try {
      await w.start(); await w.seedCodexAuthJsonFile(x.source); await w.run({ prompt: 'Synthetic R' });
      const late = w.run({ prompt: 'Synthetic held N' }); await ready; await writeFile(x.source, s1, { mode: 0o600 }); release(); await late;
      assert(await readFile(x.source, 'utf8') === s1, 'late_N_overwrote_S1');
      const result = await run(w, imports); Object.assign(f, { result, expectedS1: hash(s1), sourceUnchanged: await readFile(x.source, 'utf8') === s1 });
      assert(result.completed && imports.at(-1) === hash(s1), 'owner_replacement_defeated_by_late_N');
    } finally { release(); await w.dispose(); }
  });
  await scenario('causal-import-does-not-release-confirmed-invalid-source', async f => {
    const x = await fresh('invalid-causal'), n = auth(randomUUID(), null);
    await writeFile(join(x.root, 'next.fixture'), n, { mode: 0o600 });
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(r => { release = r; }), ready = new Promise<void>(r => { entered = r; });
    let turns = 0;
    const w = worker(x.root, async (p, h) => {
      if (turns++ === 0) { await writeFile(join(h, 'auth.json'), x.r, { mode: 0o600 }); p.complete(); }
      else { entered(); await held; p.invalid(); }
    });
    try {
      await w.start(); await w.seedCodexAuthJsonFile(x.source); await w.run({ prompt: 'Synthetic R' });
      const stale = run(w, []); await ready;
      const descendant = await child(x.root, 'descendant', x.r); release();
      assert(descendant.completed && !(await stale).completed, 'actual_concurrent_R_invalidation');
      await w.seedCodexAuthJsonFile(x.source);
      const local = await stored(x.root);
      Object.assign(f, { descendant, importedHash: local ? hash(codexAuthJsonFromArtifact(local.artifact)) : null, expectedN: hash(n), capacity: w.capacity() });
      assert(local && codexAuthJsonFromArtifact(local.artifact) === n, 'causal_import_not_applied');
      assert(w.capacity().reason === 'provider_session_invalid' && await readFile(x.source, 'utf8') === x.s0, 'causal_refresh_released_invalid_source');
    } finally { release(); await w.dispose(); }
  });
  await scenario('immutable-ambiguous-siblings-retain-explicit-recovery', async f => {
    const x = await fresh('siblings'), a = auth(randomUUID(), null), b = auth(randomUUID(), null);
    await writeFile(join(x.root, 'next.fixture'), b, { mode: 0o600 });
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(r => { release = r; }), ready = new Promise<void>(r => { entered = r; });
    const w = worker(x.root, async (p, h) => { entered(); await held; await writeFile(join(h, 'auth.json'), a, { mode: 0o600 }); p.complete(); });
    try {
      await w.start(); await w.seedCodexAuthJsonFile(x.source); const late = run(w, []); await ready;
      const other = await child(x.root, 'descendant', x.s0); release(); const result = await late;
      let conflict: string | null = null;
      try { await new FileBackendCodexSeedWriteback(x.source).read(x.s0); } catch (e) { conflict = e instanceof Error ? e.message : 'unknown'; }
      const local = await stored(x.root);
      const scopes = await readdir(join(x.root, 'auth/a/.subscription-runtime-auth-writeback'));
      const tickets = await readdir(join(x.root, 'auth/a/.subscription-runtime-auth-writeback', scopes[0]!, 'publications'));
      Object.assign(f, { other, result, conflict, immutableRecordCount: tickets.length, localHash: local ? hash(codexAuthJsonFromArtifact(local.artifact)) : null, expectedA: hash(a) });
      assert(other.completed && !result.completed && conflict === 'codex_seed_publication_ambiguous_rotation_recovery_retained', 'ambiguous_sibling_conflict_suppressed');
      assert(tickets.length === 2 && local && codexAuthJsonFromArtifact(local.artifact) === a && await readFile(x.source, 'utf8') === x.s0, 'immutable_sibling_or_local_recovery_lost');
    } finally { release(); await w.dispose(); }
  });
  process.exitCode = cases.some(c => !c.passed) ? 1 : 0;
}
if (process.argv[2] === '--child') {
  const root = process.argv[3]!, mode = process.argv[4]!, expected = process.argv[5]!;
  assert(root.startsWith(process.env.SR_SYNTHETIC_FIXTURES! + '/synthetic-effective-reader-'), 'owned_fixture');
  const imports: string[] = [], events: RuntimeEvent[] = [];
  const action = async (p: Peer, h: string, b: string) => {
    if (mode === 'descendant' || mode === 'rotate-retained' || mode.startsWith('unbound') || mode.startsWith('prebinding')) {
      if (hash(b) !== expected) { p.invalid(); return; }
      await writeFile(join(h, 'auth.json'), await readFile(join(root, 'next.fixture'), 'utf8'), { mode: 0o600 });
      if (mode.endsWith('-loss')) await writeFile(join(root, 'auth/a/.subscription-runtime-auth-writeback'), 'synthetic publication unavailable');
      p.complete();
    } else hash(b) === expected ? p.complete() : p.invalid();
  };
  const tag = mode === 'descendant' ? 'descendant' : mode === 'recover' ? 'explicit-recovery' : 'restarted';
  const shared = codexAccountCapacityStore(join(root, 'auth'));
  const w = mode === 'observe-unbound' ? new FileBackendCodexWorker({
    providerInstanceId: 'synthetic-restarted', stateRootDir: join(root, 'jobs/restarted'), encryptionKey: new Uint8Array(32).fill(27),
    codexBinaryPath: '/SYNTHETIC-NONEXISTENT', model: 'gpt-6.1-sol', reasoningEffort: 'high', serviceTier: 'default', sourceEnv: { SUBSCRIPTION_RUNTIME_MANAGED_LAUNCH: '1' },
    appServerProcessFactory: input => new Peer(input.env.CODEX_HOME!, async (p, h) => { const b = await readFile(join(h, 'auth.json'), 'utf8'); imports.push(hash(b)); await action(p, h, b); }),
    observability: { emit: e => events.push(e), count() {}, timing() {} },
    onSessionInvalid: capacity => shared.observe({ accountId: 'a', capacity, observedAt: new Date('2026-10-06T20:00:00Z') }),
  }) : worker(root, action, imports, tag);
  try {
    await w.start();
    if (mode.startsWith('unbound')) await w.seedCodexAuthJson(await readFile(join(root, 'auth/a/auth.json'), 'utf8'));
    else await w.seedCodexAuthJsonFile(join(root, 'auth/a/auth.json'));
    const result = await run(w, imports); result.events = events.map(e => e.name); console.log(JSON.stringify(result));
  } finally { await w.dispose(); }
} else await main();
