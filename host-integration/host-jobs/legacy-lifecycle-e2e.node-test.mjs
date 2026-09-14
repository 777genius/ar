import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostJobs } from './manager.mjs';
import { unitFor } from './contract.mjs';
import { scopedSystemctl, verifyLegacyLifecycle } from './legacy-lifecycle-e2e.mjs';

test('legacy colon lifecycle uses only the owned status and stop operations', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'legacy-lifecycle-test-'));
  const record = { jobId: 'legacy:test:colon', machineId: 'a'.repeat(32),
    fingerprint: 'b'.repeat(64), phase: 'started', unit: unitFor('legacy:test:colon') };
  let active = true;
  const calls = [];
  const manager = new HostJobs({ stateDir, machineId: async () => record.machineId,
    run: scopedSystemctl(record.unit, async (command, args) => {
      calls.push(args[1]);
      if (args[1] === 'stop') { active = false; return ''; }
      return `LoadState=loaded\nActiveState=${active ? 'active' : 'inactive'}\nDescription=subscription-job:${record.fingerprint}\n`;
    }) });
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
