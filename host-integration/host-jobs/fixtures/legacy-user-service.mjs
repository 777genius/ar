// Synthetic-only legacy compatibility fixture. Never accepts a payload or unit.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unitFor } from '../contract.mjs';

export async function verifyLegacyUserService({ HostJobs, machineId, run, scopedSystemctl, verifyLegacyLifecycle }) {
  const jobId = `legacy:e2e:user:${randomBytes(24).toString('hex')}`;
  // Deliberately absent manager: this is the persisted format before migration.
  const record = { jobId, unit: unitFor(jobId), machineId,
    fingerprint: randomBytes(32).toString('hex'), phase: 'started', createdAt: Date.now() };
  const stateDir = await mkdtemp(join(tmpdir(), 'subscription-legacy-user-e2e-'));
  const scopedRun = scopedSystemctl(record.unit, run, 'user');
  const manager = new HostJobs({ stateDir, run: scopedRun });
  let dispatched = false;
  let launchConfirmed = false;
  let stopped = false;
  let result;
  try {
    const initial = await scopedRun('/usr/bin/systemctl',
      ['--user', 'show', record.unit, '--property=LoadState,ActiveState,SubState,ControlGroup,Description']);
    assert.match(initial, /^LoadState=not-found$/m, 'Synthetic legacy user unit already exists');
    await writeFile(manager.path(jobId), JSON.stringify(record), { flag: 'wx', mode: 0o600 });
    // Fixed read-only sleep only, never managed work or caller-supplied code.
    dispatched = true;
    await run('/usr/bin/systemd-run', ['--user', `--unit=${record.unit}`,
      `--description=subscription-job:${record.fingerprint}`, '--service-type=exec',
      '--property=RuntimeMaxSec=120', '--property=TimeoutStopSec=5',
      '--property=KillMode=control-group', '--property=MemoryMax=32M', '--property=TasksMax=8',
      '--property=StandardOutput=null', '--property=StandardError=null',
      '--', '/usr/bin/sleep', '120']);
    launchConfirmed = true;
    result = await verifyLegacyLifecycle(manager, record);
    stopped = true;
  } finally {
    if (dispatched && !stopped) {
      try {
        const final = await manager.stop(jobId, machineId);
        stopped = (launchConfirmed && final.state.LoadState === 'not-found') ||
          (final.state.LoadState !== 'not-found' && ['inactive', 'failed'].includes(final.state.ActiveState));
      } catch { stopped = false; }
    }
    if (!dispatched || stopped) await rm(stateDir, { recursive: true, force: false });
    else throw new Error(`Uncertain synthetic user stop: preserving ledger ${stateDir} for ${record.unit}`);
  }
  return { manager: 'user', managerFieldAbsent: true, jobId, unit: record.unit, ledgerRemoved: true, ...result };
}
