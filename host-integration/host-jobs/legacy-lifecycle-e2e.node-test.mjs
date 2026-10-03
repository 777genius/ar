import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostJobs } from './manager.mjs';
import { unitFor } from './contract.mjs';
import { scopedSystemctl, verifyLegacyLifecycle } from './legacy-lifecycle-e2e.mjs';
import { verifyLegacyUserService } from './fixtures/legacy-user-service.mjs';

for (const scope of ['legacy-user', 'system']) test(`legacy colon lifecycle uses only owned operations in ${scope}`, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'legacy-lifecycle-test-'));
  const record = { jobId: 'legacy:test:colon', machineId: 'a'.repeat(32),
    fingerprint: 'b'.repeat(64), phase: 'started', unit: unitFor('legacy:test:colon'),
    ...(scope === 'system' ? { manager: 'system' } : {}) };
  let active = true;
  const calls = [];
  const manager = new HostJobs({ stateDir, machineId: async () => record.machineId,
    run: scopedSystemctl(record.unit, async (command, args) => {
      const operation = args[scope === 'system' ? 0 : 1];
      calls.push(operation);
      if (operation === 'stop') { active = false; return ''; }
      return `LoadState=loaded\nActiveState=${active ? 'active' : 'inactive'}\nDescription=subscription-job:${record.fingerprint}\n`;
    }, scope === 'system' ? 'system' : 'user') });
  try {
    await writeFile(manager.path(record.jobId), JSON.stringify(record));
    assert.equal((await verifyLegacyLifecycle(manager, record)).stopConfirmed, true);
    assert.deepEqual(calls, ['show', 'show', 'stop', 'show']);
  } finally { await rm(stateDir, { recursive: true }); }
});

test('command fence rejects other units, launchers, and extra flags', () => {
  const run = scopedSystemctl('owned.service', () => assert.fail('must not dispatch'));
  for (const [cmd, args] of [
    ['/usr/bin/systemctl', ['--user', 'stop', 'foreign.service']],
    ['/usr/bin/systemctl', ['stop', 'foreign.service']],
    ['/usr/bin/systemctl', ['stop', 'owned.service', '--all']],
    ['/usr/bin/node', ['launcher.mjs']],
    ['/usr/bin/systemctl', ['--user', 'stop', 'owned.service', '--all']],
  ]) assert.throws(() => run(cmd, args));
});

test('uncertain deactivating state does not count as a confirmed stop', async () => {
  await assert.rejects(verifyLegacyLifecycle({
    status: async () => ({ live: true, state: { ActiveState: 'active' } }),
    stop: async () => ({ live: false, state: { LoadState: 'loaded', ActiveState: 'deactivating' } }),
  }, { jobId: 'legacy:test', machineId: 'a'.repeat(32) }), /Stop is not confirmed/);
});

for (const uncertain of [false, true]) test(`user canary uses absent-manager ledger and preserves uncertain evidence: ${uncertain}`, async () => {
  const machineId = 'a'.repeat(32);
  let ledger;
  let active = false;
  let launches = 0;
  class SyntheticHostJobs extends HostJobs {
    constructor(options) {
      super({ ...options, machineId: async () => machineId });
      ledger = options.stateDir;
    }
  }
  const run = async (command, args) => {
    if (command === '/usr/bin/systemd-run') {
      launches++;
      assert.equal(args[0], '--user');
      assert.deepEqual(args.slice(args.indexOf('--')), ['--', '/usr/bin/sleep', '120']);
      assert.ok(args.includes('--property=RuntimeMaxSec=120'));
      const unit = args.find(arg => arg.startsWith('--unit=')).slice(7);
      const record = JSON.parse(await readFile(join(ledger, `${unit}.json`), 'utf8'));
      assert.equal(Object.hasOwn(record, 'manager'), false);
      assert.match(record.jobId, /^legacy:e2e:user:[a-f0-9]{48}$/);
      assert.equal(record.unit, unitFor(record.jobId));
      assert.ok(args.includes(`--description=subscription-job:${record.fingerprint}`));
      if (uncertain) throw Error('synthetic transport timeout');
      active = true;
      return '';
    }
    assert.equal(command, '/usr/bin/systemctl');
    assert.equal(args[0], '--user');
    if (!active) return 'LoadState=not-found';
    const record = JSON.parse(await readFile(join(ledger, `${args[2]}.json`), 'utf8'));
    if (args[1] === 'stop') active = false;
    return `LoadState=loaded\nActiveState=${active ? 'active' : 'inactive'}\nDescription=subscription-job:${record.fingerprint}`;
  };
  try {
    const result = verifyLegacyUserService({ HostJobs: SyntheticHostJobs, machineId, run,
      scopedSystemctl, verifyLegacyLifecycle });
    if (uncertain) {
      await assert.rejects(result, /Uncertain synthetic user stop: preserving ledger/);
      assert.equal((await stat(ledger)).isDirectory(), true);
    } else {
      assert.equal((await result).stopConfirmed, true);
      await assert.rejects(stat(ledger), { code: 'ENOENT' });
    }
    assert.equal(launches, 1);
  } finally { if (ledger) await rm(ledger, { recursive: true, force: true }); }
});
