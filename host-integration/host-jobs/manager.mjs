import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { unitFor, validateStart, fingerprint } from './contract.mjs';
import { prepareManagedJobLayout, storageProbe as defaultStorageProbe, HOST_STORAGE_POLICY_PATH } from './storage-policy.mjs';
import { managedLauncherInvocation } from '../managed-launcher/launch.mjs';

const execute = promisify(execFile);
async function systemCommand(cmd, args) {
  try { return (await execute(cmd, args, { timeout: 15000, maxBuffer: 1048576 })).stdout; }
  catch (error) {
    if (cmd === '/usr/bin/systemctl' && args.includes('show') && error.code === 4 && error.stdout.includes('LoadState=not-found')) return error.stdout;
    throw error;
  }
}
export class HostJobs {
  constructor({ stateDir, run = systemCommand,
    machineId = async () => (await readFile('/etc/machine-id', 'utf8')).trim(),
    storagePolicyPath = HOST_STORAGE_POLICY_PATH, storageProbe = defaultStorageProbe,
    prepareLayout = jobId => prepareManagedJobLayout(jobId, { policyPath: storagePolicyPath, probe: storageProbe }),
    clock = () => Date.now() }) {
    Object.assign(this, { stateDir, run, machineId, prepareLayout, clock });
  }
  path(id) { return join(this.stateDir, `${unitFor(id)}.json`); }
  async read(id) {
    try { return JSON.parse(await readFile(this.path(id), 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }
  async save(record) {
    const path = this.path(record.jobId);
    const temp = `${path}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(record), { mode: 0o600 });
    await rename(temp, path);
  }
  async inspect(unit) {
    const output = await this.run('/usr/bin/systemctl', ['--user', 'show', unit, '--property=LoadState,ActiveState,SubState,ControlGroup,Description']);
    return Object.fromEntries(output.trim().split('\n').filter(Boolean).map(line => { const n = line.indexOf('='); return [line.slice(0,n), line.slice(n+1)]; }));
  }
  async owned(record) {
    if (record.machineId !== await this.machineId()) throw new Error('machine identity changed');
    const state = await this.inspect(record.unit);
    if (state.LoadState !== 'not-found' && state.Description !== `subscription-job:${record.fingerprint}`) throw new Error('unit ownership mismatch');
    return state;
  }
  async start(request) {
    validateStart(request);
    if (await this.machineId() !== request.machineId) throw new Error('machine identity mismatch');
    const digest = fingerprint(request);
    let record = await this.read(request.jobId);
    if (record && record.fingerprint !== digest) throw new Error('jobId already bound to different request');
    if (record) {
      const state = await this.owned(record);
      // Never rerun a completed or ambiguous job merely because its unit disappeared.
      return { ...record, state, retry: true };
    }
    await this.prepareLayout(request.jobId);
    // Small control records are the lifecycle metadata exception, never payload data.
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    const unit = unitFor(request.jobId);
    const initial = await this.inspect(unit);
    if (initial.LoadState !== 'not-found') {
      // Another endpoint may have claimed and launched after our first read.
      // Re-enter the record/fingerprint check before classifying the unit.
      if (await this.read(request.jobId)) return this.start(request);
      throw new Error('unowned unit already exists');
    }
    record = { jobId: request.jobId, unit, machineId: request.machineId, fingerprint: digest, phase: 'starting', createdAt: this.clock() };
    // Exclusive create arbitrates concurrent requests across endpoint processes.
    try { await writeFile(this.path(request.jobId), JSON.stringify(record), { flag: 'wx', mode: 0o600 }); }
    catch (e) { if (e.code === 'EEXIST') return this.start(request); throw e; }
    try {
      const invocation = managedLauncherInvocation({
        operation: 'job', unit, payload: request.argv,
        jobId: request.jobId, fingerprint: digest,
        limits: {
          runtimeSeconds: request.runtimeSeconds,
          stopSeconds: request.stopSeconds,
          memoryMiB: request.memoryMiB,
          tasksMax: request.tasksMax,
          cpuPercent: request.cpuPercent,
        },
      });
      await this.run(invocation.command, invocation.args);
      record.phase = 'started';
    } catch { record.phase = 'uncertain'; }
    await this.save(record);
    return { ...record, state: await this.owned(record) };
  }
  async status(jobId, expectedMachineId) {
    if (expectedMachineId !== await this.machineId()) throw new Error('machine identity mismatch');
    const record = await this.read(jobId);
    if (!record) throw new Error('unknown job');
    const state = await this.owned(record);
    const live = ['active', 'activating', 'reloading'].includes(state.ActiveState);
    return { ...record, state, live, unresolved: !live && ['starting', 'uncertain'].includes(record.phase), abandoned: false };
  }
  async stop(jobId, expectedMachineId) {
    if (expectedMachineId !== await this.machineId()) throw new Error('machine identity mismatch');
    const record = await this.read(jobId);
    if (!record) throw new Error('unknown job');
    const state = await this.owned(record);
    if (state.LoadState === 'not-found' && record.phase === 'starting') throw new Error('start is unresolved; reconcile before stop');
    if (state.LoadState !== 'not-found') await this.run('/usr/bin/systemctl', ['--user', 'stop', record.unit]);
    return this.status(jobId, expectedMachineId);
  }
}
