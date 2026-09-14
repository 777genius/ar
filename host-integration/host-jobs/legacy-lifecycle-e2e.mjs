#!/usr/bin/env node
// Opt-in synthetic service only; never point this at a production ledger.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { unitFor } from './contract.mjs';

const execute = promisify(execFile);

// Scope every lifecycle command to the one synthetic unit. In particular this
// denies any managed-launcher invocation if status/stop ever regress into start.
export function scopedSystemctl(unit, run) {
  return (command, args) => {
    assert.equal(command, '/usr/bin/systemctl', 'Unexpected lifecycle executable');
    assert.equal(args[0], '--user');
    assert.equal(args[2], unit, 'Unexpected unit');
    assert.ok((args[1] === 'stop' && args.length === 3) ||
      (args[1] === 'show' && args.length === 4 &&
        args[3] === '--property=LoadState,ActiveState,SubState,ControlGroup,Description'),
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

async function main() {
  const args = process.argv.slice(2);
  assert.ok(args.length === 3 && args[0] === '--allow-live-synthetic' &&
    args[1] === '--expected-machine-id',
  'Usage (disposable Linux test host only): node legacy-lifecycle-e2e.mjs --allow-live-synthetic --expected-machine-id ID');
  assert.equal(process.platform, 'linux', 'Requires disposable Linux test host');
  const machineId = (await readFile('/etc/machine-id', 'utf8')).trim();
  assert.match(machineId, /^[a-f0-9]{32}$/);
  assert.equal(machineId, args[2], 'Machine identity mismatch');
  await run('/usr/bin/systemctl', ['--user', 'show-environment']);

  // Poison every public storage-policy operation before loading the real
  // HostJobs class. This leaves the actual lifecycle code intact and makes
  // policy reads, capacity admission, and layout creation unconditionally fail.
  // No real host policy is read or modified by this proof.
  const poisonKey = `legacy-policy-${randomBytes(16).toString('hex')}`;
  globalThis[poisonKey] = { loaded: false, calls: 0 };
  const policyUrl = new URL('./storage-policy.mjs', import.meta.url).href;
  const hook = registerHooks({ load(url, context, nextLoad) {
    if (url !== policyUrl) return nextLoad(url, context);
    return { format: 'module', shortCircuit: true, source: `
      const evidence = globalThis[${JSON.stringify(poisonKey)}];
      evidence.loaded = true;
      function deny() { evidence.calls++; throw new Error('Synthetic storage policy unavailable'); }
      export const HOST_STORAGE_POLICY_PATH = '/nonexistent-synthetic-policy';
      export const MINIMUM_FREE_BYTES = 0n, MINIMUM_FREE_INODES = 0n;
      export const deriveManagedJobLayout = deny, requireFinalJobStorage = deny;
      export const prepareManagedJobLayout = deny, requireHostStorage = deny, loadHostStoragePolicy = deny;
      export const storageProbe = new Proxy({}, { get: deny });
    ` };
  } });
  const { HostJobs } = await import('./manager.mjs');
  assert.equal(globalThis[poisonKey].loaded, true, 'Storage poison was not installed');

  const jobId = `legacy:e2e:${randomBytes(24).toString('hex')}`;
  const record = { jobId, unit: unitFor(jobId), machineId,
    fingerprint: randomBytes(32).toString('hex'), phase: 'started', createdAt: Date.now() };
  const stateDir = await mkdtemp(join(tmpdir(), 'subscription-legacy-e2e-'));
  const manager = new HostJobs({ stateDir, run: scopedSystemctl(record.unit, run) });
  let dispatched = false;
  let launchConfirmed = false;
  let stopped = false;
  let result;
  try {
    const initial = await manager.inspect(record.unit);
    assert.equal(initial.LoadState, 'not-found', 'Synthetic unit name already exists');
    await writeFile(manager.path(jobId), JSON.stringify(record), { flag: 'wx', mode: 0o600 });
    // Seed precisely the old ledger shape, then launch an inert owned service.
    // This bypass is limited to this fixture: HostJobs.start rejects colon IDs.
    dispatched = true; // A timeout is uncertain, so cleanup must reconcile.
    await run('/usr/bin/systemd-run', ['--user', `--unit=${record.unit}`,
      `--description=subscription-job:${record.fingerprint}`,
      '--property=Type=exec', '--property=RuntimeMaxSec=120', '--property=TimeoutStopSec=5',
      '--property=KillMode=control-group', '--property=MemoryMax=32M', '--property=TasksMax=4',
      '--property=StandardOutput=null', '--property=StandardError=null', '/usr/bin/sleep', '120']);
    launchConfirmed = true;
    result = await verifyLegacyLifecycle(manager, record);
    stopped = true;
    assert.equal(globalThis[poisonKey].calls, 0, 'Lifecycle accessed storage admission');
  } finally {
    // Revalidate ledger, machine, and description through HostJobs even when
    // launch/verification failed. Never stop a unit with unverified ownership.
    if (dispatched && !stopped) {
      try {
        const final = await manager.stop(jobId, machineId);
        // An absent unit after an uncertain launch may still be queued.
        stopped = (launchConfirmed && final.state.LoadState === 'not-found') ||
          (final.state.LoadState !== 'not-found' && ['inactive', 'failed'].includes(final.state.ActiveState));
      } catch { stopped = false; }
    }
    hook.deregister();
    delete globalThis[poisonKey];
    if (!dispatched || stopped) await rm(stateDir, { recursive: true, force: false });
    else throw new Error(`Uncertain synthetic stop: preserving ledger ${stateDir} for ${record.unit}`);
  }
  console.log(JSON.stringify({ ok: true, scope: 'synthetic-legacy-status-stop',
    jobId, unit: record.unit, machineId, policyPoisoned: true, storageAdmissionCalls: 0,
    ledgerRemoved: true, ...result }, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
