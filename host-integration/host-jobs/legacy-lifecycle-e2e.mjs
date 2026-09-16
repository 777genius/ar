#!/usr/bin/env node
// Opt-in synthetic service only; never point this at a production ledger.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { unitFor } from './contract.mjs';
import { verifyLegacyUserService } from './fixtures/legacy-user-service.mjs';

const execute = promisify(execFile);

// Scope every lifecycle command to the one synthetic unit. In particular this
// denies any managed-launcher invocation if status/stop ever regress into start.
export function scopedSystemctl(unit, run, manager = 'system') {
  assert.ok(['system', 'user'].includes(manager));
  return (command, args) => {
    assert.equal(command, '/usr/bin/systemctl', 'Unexpected lifecycle executable');
    const bounded = manager === 'user' ? args.slice(1) : args;
    if (manager === 'user') assert.equal(args[0], '--user');
    assert.equal(bounded[1], unit, 'Unexpected unit');
    assert.ok((bounded[0] === 'stop' && bounded.length === 2) ||
      (bounded[0] === 'show' && bounded.length === 3 &&
        bounded[2] === '--property=LoadState,ActiveState,SubState,ControlGroup,Description'),
    'Unexpected lifecycle operation');
    return run(command, args);
  };
}

export async function verifyLegacyLifecycle(manager, record) {
  const before = await manager.status(record.jobId, record.machineId);
  assert.equal(before.live, true, 'Synthetic legacy unit must be live before stop');
  const after = await manager.stop(record.jobId, record.machineId);
  assert.ok(after.state.LoadState === 'not-found' ||
    ['inactive', 'failed'].includes(after.state.ActiveState), 'Stop is not confirmed');
  assert.equal(after.live, false);
  return { before: before.state, after: after.state, stopConfirmed: true };
}

async function run(command, args) {
  try { return (await execute(command, args, { timeout: 15000, maxBuffer: 1048576 })).stdout; }
  catch (error) {
    if (command === '/usr/bin/systemctl' && args.includes('show') &&
        error.code === 4 && error.stdout?.includes('LoadState=not-found')) return error.stdout;
    throw error;
  }
}

async function poisonedLifecycle() {
  // Poison every public storage-policy operation before loading the real
  // HostJobs class. This leaves the actual lifecycle code intact and makes
  // policy reads, capacity admission, and layout creation unconditionally fail.
  // No real host policy is read or modified during the lifecycle proof.
  const poisonKey = `legacy-policy-${randomBytes(16).toString('hex')}`;
  globalThis[poisonKey] = { loaded: false, calls: 0 };
  const policyUrl = new URL('./storage-policy.mjs', import.meta.url).href;
  const hook = registerHooks({ load(url, context, nextLoad) {
    if (url !== policyUrl) return nextLoad(url, context);
    return { format: 'module', shortCircuit: true, source: `
      const evidence = globalThis[${JSON.stringify(poisonKey)}];
      evidence.loaded = true;
      function deny() { evidence.calls++; throw new Error('Synthetic storage policy unavailable'); }
      export const MANAGED_STORAGE_ROOT_CONFIG = '/nonexistent-synthetic-policy';
      export const MINIMUM_FREE_BYTES = 0n, MINIMUM_FREE_INODES = 0n;
      export const deriveManagedJobLayout = deny, requireFinalJobStorage = deny;
      export const prepareManagedJobLayout = deny, requireHostStorage = deny, loadManagedStorageRoot = deny;
      export const storageProbe = new Proxy({}, { get: deny });
    ` };
  } });
  const { HostJobs } = await import('./manager.mjs');
  assert.equal(globalThis[poisonKey].loaded, true, 'Storage poison was not installed');
  return { HostJobs, evidence: globalThis[poisonKey], dispose() {
    hook.deregister();
    delete globalThis[poisonKey];
  } };
}

async function main() {
  const args = process.argv.slice(2);
  assert.ok(args.length === 3 && args[0] === '--allow-live-synthetic' &&
    args[1] === '--expected-machine-id',
  'Usage (disposable Linux test host only): node legacy-lifecycle-e2e.mjs --allow-live-synthetic --expected-machine-id ID');
  assert.equal(process.platform, 'linux', 'Requires disposable Linux test host');
  const machineId = (await readFile('/etc/machine-id', 'utf8')).trim();
  assert.match(machineId, /^[a-f0-9]{32}$/);
  assert.equal(machineId, args[2], 'Machine identity mismatch');
  await run('/usr/bin/systemctl', ['show-environment']);
  await run('/usr/bin/systemctl', ['--user', 'show-environment']);

  // A separate module identity keeps setup policy reads outside the poisoned
  // lifecycle import graph. Only the normal synthetic launch needs admission.
  const setupStorage = await import('./storage-policy.mjs?legacy-e2e-setup');
  const policy = await setupStorage.loadManagedStorageRoot();
  const launchJobId = `legacy-e2e-launch-${randomBytes(24).toString('hex')}`;
  const layout = setupStorage.deriveManagedJobLayout(policy.storageRoot, launchJobId);
  await assert.rejects(lstat(layout.jobRoot), { code: 'ENOENT' }, 'Synthetic launch root already exists');
  const launcher = '/opt/subscription-runtime/managed-launcher/launch.mjs';
  const metadata = await lstat(launcher);
  assert.ok(metadata.isFile() && metadata.uid === 0 && !(metadata.mode & 0o022), 'Untrusted installed launcher');
  assert.equal(await realpath(launcher), launcher, 'Launcher must be canonical');

  const jobId = `legacy:e2e:${randomBytes(24).toString('hex')}`;
  const record = { jobId, unit: unitFor(jobId), machineId, manager: 'system',
    fingerprint: unitFor(jobId).slice('subscription-job-'.length, -'.service'.length),
    phase: 'started', createdAt: Date.now() };
  const stateDir = await mkdtemp(join(tmpdir(), 'subscription-legacy-e2e-'));
  let manager;
  let poison;
  let dispatched = false;
  let launchConfirmed = false;
  let stopped = false;
  let result;
  let legacyUser;
  try {
    const initial = await scopedSystemctl(record.unit, run)('/usr/bin/systemctl',
      ['show', record.unit, '--property=LoadState,ActiveState,SubState,ControlGroup,Description']);
    assert.match(initial, /^LoadState=not-found$/m, 'Synthetic unit name already exists');
    await writeFile(join(stateDir, `${record.unit}.json`), JSON.stringify(record), { flag: 'wx', mode: 0o600 });
    // Launch a normal admitted synthetic job, then exercise the old colon-ID
    // ledger binding to that exact unit. Never call start with the legacy ID.
    dispatched = true; // A timeout is uncertain, so cleanup must reconcile.
    await run(process.execPath, [launcher, 'job', JSON.stringify({ operation: 'job',
      jobId: launchJobId, unit: record.unit, fingerprint: record.fingerprint,
      payload: ['/usr/bin/sleep', '120'],
      limits: { runtimeSeconds: 120, stopSeconds: 5, memoryMiB: 128, tasksMax: 32, cpuPercent: 100 } })]);
    launchConfirmed = true;
    poison = await poisonedLifecycle();
    manager = new poison.HostJobs({ stateDir, run: scopedSystemctl(record.unit, run) });
    result = await verifyLegacyLifecycle(manager, record);
    stopped = true;
    if (result.after.ActiveState === 'failed') await run('/usr/bin/systemctl', ['reset-failed', record.unit]);
    legacyUser = await verifyLegacyUserService({ HostJobs: poison.HostJobs, machineId, run,
      scopedSystemctl, verifyLegacyLifecycle });
    assert.equal(poison.evidence.calls, 0, 'Lifecycle accessed storage admission');
  } finally {
    // Revalidate ledger, machine, and description through HostJobs even when
    // launch/verification failed. Never stop a unit with unverified ownership.
    if (dispatched && !stopped) {
      try {
        poison ??= await poisonedLifecycle();
        manager ??= new poison.HostJobs({ stateDir, run: scopedSystemctl(record.unit, run) });
        const final = await manager.stop(jobId, machineId);
        // An absent unit after an uncertain launch may still be queued.
        stopped = (launchConfirmed && final.state.LoadState === 'not-found') ||
          (final.state.LoadState !== 'not-found' && ['inactive', 'failed'].includes(final.state.ActiveState));
      } catch { stopped = false; }
    }
    poison?.dispose();
    if (!dispatched || stopped) {
      if (dispatched) {
        // Remove only our randomized admitted root, never the storage parent.
        // A replaced/symlinked root is preserved for explicit reconciliation.
        try {
          assert.equal(await realpath(layout.jobRoot), layout.jobRoot, 'Synthetic root changed');
          await rm(layout.jobRoot, { recursive: true, force: false });
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      await rm(stateDir, { recursive: true, force: false });
    } else throw new Error(`Uncertain synthetic stop: preserving ledger ${stateDir} and ${layout.jobRoot} for ${record.unit}`);
  }
  console.log(JSON.stringify({ ok: true, scope: 'synthetic-legacy-status-stop',
    jobId, launchJobId, unit: record.unit, machineId, policyPoisoned: true, storageAdmissionCalls: 0,
    ledgerRemoved: true, managedLaunchRootRemoved: true, manager: 'system', legacyUser, ...result }, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
