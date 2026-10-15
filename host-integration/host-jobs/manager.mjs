import { mkdir, readFile, writeFile, rename, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { unitFor, validateStart, fingerprint } from './contract.mjs';
import { managedLauncherInvocation, storageIssuerInvocation, validateStorageIssuerBinding, currentStorageAcquisition, currentStorageOwnership,
  cancelOwnedStorageTarget, decideStorageInvocation, ManagedPinObservation } from '../managed-launcher/launch.mjs';
import { ManagedLauncherProfile, assertManagedLauncherProfile, storageTargetUnit, parseNativeUnitProperties } from '../managed-launcher/launch.mjs';
import { requireManagedPinCapability, readManagedPinFile } from './storage-policy.mjs';
import { randomUUID } from 'node:crypto';

const execute = promisify(execFile);
function managerArgs(record) {
  if (!Object.hasOwn(record, 'manager')) return ['--user'];
  if (record.manager === 'system') return [];
  if (record.manager === 'user') return ['--user'];
  throw new Error('invalid persisted manager');
}
export async function systemCommand(cmd, args, executeCommand = execute) {
  const env = { ...process.env };
  // Noninteractive SSH may omit the runtime directory of the existing user bus.
  if (env.XDG_RUNTIME_DIR === undefined && typeof process.getuid === 'function') env.XDG_RUNTIME_DIR = `/run/user/${process.getuid()}`;
  try { return (await executeCommand(cmd, args, { timeout: 15000, maxBuffer: 1048576, env })).stdout; }
  catch (error) {
    if (cmd === '/usr/bin/systemctl' && args.includes('show') && error.code === 4 && error.stdout.includes('LoadState=not-found')) return error.stdout;
    throw error;
  }
}
export class HostJobs {
  /** @param {{stateDir:string, run?:typeof systemCommand, machineId?:()=>Promise<string>, clock?:()=>number, launcherProfile?:'standard'|'fixed_full_positive_test'}} options */
  constructor({ stateDir, run = systemCommand,
    machineId = async () => (await readFile('/etc/machine-id', 'utf8')).trim(),
    clock = () => Date.now(), launcherProfile = ManagedLauncherProfile.Standard }) {
    if (!Object.values(ManagedLauncherProfile).includes(launcherProfile)) throw new Error('invalid launcher profile');
    Object.assign(this, { stateDir, run, machineId, clock, launcherProfile });
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
  async inspect(unit, scope, native = false) {
    const output = await this.run('/usr/bin/systemctl', [...scope, 'show', unit, `--property=LoadState,ActiveState,SubState,ControlGroup,Description${native ? ',InvocationID,MainPID' : ''}`]);
    if (native) return parseNativeUnitProperties(output, ['LoadState', 'ActiveState', 'SubState', 'ControlGroup', 'Description', 'InvocationID', 'MainPID']);
    return Object.fromEntries(output.trim().split('\n').filter(Boolean).map(line => { const n = line.indexOf('='); return [line.slice(0,n), line.slice(n+1)]; }));
  }
  async owned(record) {
    if (record.machineId !== await this.machineId()) throw new Error('machine identity changed');
    const state = await this.inspect(record.unit, managerArgs(record), Boolean(record.storageLifetime));
    if (state.LoadState !== 'not-found' && state.Description !== `subscription-job:${record.fingerprint}${record.storageLifetime ? ':storage:' + record.storageLifetime.invocationId : ''}`) throw new Error('unit ownership mismatch');
    return state;
  }
  async start(request) {
    validateStart(request);
    assertManagedLauncherProfile(this.launcherProfile, request.jobId);
    if (await this.machineId() !== request.machineId) throw new Error('machine identity mismatch');
    const digest = fingerprint(request);
    let record = await this.read(request.jobId);
    if (record && record.fingerprint !== digest) throw new Error('jobId already bound to different request');
    if (record) {
      const state = await this.owned(record);
      // Never rerun a completed or ambiguous job merely because its unit disappeared.
      return { ...record, state, retry: true, ...(record.storageLifetime ? { storage: await this.storageStatus(record) } : {}) };
    }
    // Only the managed launcher admits storage and creates payload layout.
    // This bounded lifecycle ledger stays outside jobRoot, including on denial,
    // so an uncertain launcher outcome can never cause a replay.
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    let unit = unitFor(request.jobId);
    const initial = await Promise.all([this.inspect(unit, []), this.inspect(unit, ['--user'])]);
    if (initial.some(state => state.LoadState !== 'not-found')) {
      // Another endpoint may have claimed and launched after our first read.
      // Re-enter the record/fingerprint check before classifying the unit.
      if (await this.read(request.jobId)) return this.start(request);
      throw new Error('unowned unit already exists');
    }
    record = { jobId: request.jobId, unit, manager: 'system', machineId: request.machineId, fingerprint: digest, phase: 'starting', createdAt: this.clock() };
    let capability;
    if (request.storageLifetime) {
      // Intent is not authority. Only the protected exact-host/runtime native
      // qualification enables this producer; absent means unsupported.
      capability = await requireManagedPinCapability(request.machineId);
      const invocationId = randomUUID();
      unit = storageTargetUnit(request.jobId, invocationId); record.unit = unit;
      const initialNative = await Promise.all([this.inspect(unit, []), this.inspect(unit, ['--user'])]);
      if (initialNative.some(state => state.LoadState !== 'not-found')) throw new Error('unowned native unit already exists');
      const directory = join(this.stateDir, 'native-storage', unit, invocationId);
      record.storageLifetime = validateStorageIssuerBinding({ jobId: request.jobId, machineId: request.machineId,
        fingerprint: digest, unit, invocationId, generation: `${request.jobId}:${invocationId}`,
        issuerUnit: `subscription-storage-issuer-${invocationId}.service`, directory,
        envelopePath: join(directory, 'launch.json'), acquisitionPath: join(directory, 'acquisition.json'),
        activationPath: join(directory, 'activation.json'),
        capabilitySha256: capability.capabilitySha256 });
    }
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
          ...(Object.hasOwn(request, 'startupSeconds') ? { startupSeconds: request.startupSeconds } : {}),
        },
      }, this.launcherProfile);
      if (record.storageLifetime) {
        const binding = record.storageLifetime;
        // An installed root-owned path, never a worker-writable job directory.
        await readManagedPinFile(this.path(request.jobId));
        await mkdir(binding.directory, { recursive: true, mode: 0o700 });
        for (let current = binding.directory; ; current = join(current, '..')) {
          const info = await lstat(current);
          if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022)) throw new Error('untrusted native invocation directory');
          if (current === '/') break;
        }
        await writeFile(binding.acquisitionPath, '', { flag: 'wx', mode: 0o600 });
        await writeFile(binding.activationPath, '', { flag: 'wx', mode: 0o600 });
        await writeFile(binding.envelopePath, JSON.stringify({ schemaVersion: 1, binding, request: JSON.parse(invocation.args[2]) }) + '\n', { flag: 'wx', mode: 0o600 });
        const issuer = await storageIssuerInvocation(binding);
        await this.run(issuer.command, issuer.args);
      } else await this.run(invocation.command, invocation.args);
      record.phase = record.storageLifetime ? 'issuer-started' : 'started';
    } catch { record.phase = 'uncertain'; }
    await this.save(record);
    return { ...record, state: await this.owned(record), ...(record.storageLifetime ? { storage: await this.storageStatus(record) } : {}) };
  }
  async status(jobId, expectedMachineId) {
    if (expectedMachineId !== await this.machineId()) throw new Error('machine identity mismatch');
    const record = await this.read(jobId);
    if (!record) throw new Error('unknown job');
    const state = await this.owned(record);
    const live = ['active', 'activating', 'reloading'].includes(state.ActiveState);
    const storage = record.storageLifetime ? await this.storageStatus(record) : undefined;
    return { ...record, state, live, unresolved: storage ? storage.observation !== ManagedPinObservation.Acquired :
      !live && ['starting', 'uncertain'].includes(record.phase), abandoned: false, ...(storage ? { storage } : {}) };
  }
  async storageStatus(record) {
    const binding = validateStorageIssuerBinding(record.storageLifetime);
    if (binding.jobId !== record.jobId || binding.fingerprint !== record.fingerprint || binding.unit !== record.unit ||
        binding.machineId !== record.machineId || !binding.directory.startsWith(join(this.stateDir, 'native-storage') + '/')) throw new Error('native invocation ownership mismatch');
    const issuer = await this.inspect(binding.issuerUnit, [], true);
    if (issuer.LoadState !== 'not-found' && issuer.Description !== `subscription-storage-issuer:${binding.invocationId}:${binding.fingerprint}`) throw new Error('native issuer ownership mismatch');
    let acquisition, issuerOwned = false, cancelled = false, cancellationUnknown = false, cancelledDrained = false;
    try {
      const cancel = JSON.parse((await readManagedPinFile(join(binding.directory, 'cancel.json'))).toString('utf8'));
      if (Object.keys(cancel).sort().join(',') !== 'generation,invocationId,schemaVersion' || cancel.schemaVersion !== 1 ||
          cancel.invocationId !== binding.invocationId || cancel.generation !== binding.generation) throw new Error('invalid cancellation');
      cancelled = true;
    } catch (error) { if (error.code !== 'ENOENT') cancellationUnknown = true; }
    try {
      const receipt = JSON.parse((await readManagedPinFile(join(binding.directory, 'issuer.json'))).toString('utf8'));
      if (Object.keys(receipt).sort().join(',') !== 'generation,invocationId,pid,schemaVersion,systemdInvocationId' ||
          receipt.schemaVersion !== 1 || receipt.invocationId !== binding.invocationId || receipt.generation !== binding.generation ||
          !/^[a-f0-9]{32}$/.test(receipt.systemdInvocationId) || !Number.isSafeInteger(receipt.pid) || receipt.pid < 1) throw new Error('invalid issuer identity');
      issuerOwned = issuer.InvocationID === receipt.systemdInvocationId && issuer.MainPID === String(receipt.pid);
    } catch { /* Unbound or replaced issuer is pending, never name-only authority. */ }
    try {
      acquisition = await currentStorageAcquisition(binding, this.run);
    } catch { /* Unknown/partial receipts never establish acquisition. */ }
    if (cancelled) {
      try { cancelledDrained = (await currentStorageOwnership(binding, this.run))?.ownedTargetDrained === true; }
      catch { /* A bootstrap receipt can prove owned drain, never acquisition. */ }
    }
    return { kind: 'fd-openfile-bind-v1', invocationId: binding.invocationId, generation: binding.generation,
      issuerUnit: binding.issuerUnit, observation: cancellationUnknown ? ManagedPinObservation.Unknown :
        cancelled ? cancelledDrained ? ManagedPinObservation.CancelledDrained : ManagedPinObservation.CancelPending :
        acquisition ? acquisition.ownedTargetDrained ? ManagedPinObservation.TerminalDrained : ManagedPinObservation.Acquired :
        issuerOwned && ['active', 'activating', 'reloading'].includes(issuer.ActiveState) ? ManagedPinObservation.AwaitingAcquisition : ManagedPinObservation.Unknown,
      qualifiedDrain: false };
  }
  async stop(jobId, expectedMachineId) {
    if (expectedMachineId !== await this.machineId()) throw new Error('machine identity mismatch');
    const record = await this.read(jobId);
    if (!record) throw new Error('unknown job');
    const state = await this.owned(record);
    if (record.storageLifetime) {
      await this.storageStatus(record); // Exact persisted issuer ownership, never a raw unit from the caller.
      const binding = record.storageLifetime;
      // This competes with activation at the same immutable authority fence.
      // A cancellation that wins cannot permit the bootstrap's first payload.
      let decision;
      try { decision = await decideStorageInvocation(binding, 'cancel'); }
      catch { /* Invalid/partial immutable activation never blocks independent owned containment. */ }
      if (decision?.action === 'cancel') {
        // Convey a winning pre-activation revocation through the already-issued
        // readonly descriptor, including a bootstrap that starts after this stop.
        try { await writeFile(binding.activationPath, JSON.stringify(decision) + '\n', { flag: 'r+', mode: 0o600 }); }
        catch { /* Delivery uncertainty cannot grant activation or skip the bound stop directive. */ }
      }
      const directive = JSON.stringify({ schemaVersion: 1, invocationId: binding.invocationId, generation: binding.generation }) + '\n';
      let directiveError;
      try { await writeFile(join(binding.directory, 'cancel.json'), directive, { flag: 'wx', mode: 0o600 }); }
      catch (error) {
        try {
          if (error.code !== 'EEXIST' || (await readManagedPinFile(join(binding.directory, 'cancel.json'))).toString('utf8') !== directive) directiveError = error;
        } catch (readError) { directiveError = readError; }
      }
      // The owned issuer fences/compensates its one submission while retaining
      // the FD. Never stop that holder first, and never replay after uncertainty.
      try {
        const ownership = await currentStorageOwnership(binding, this.run);
        if (ownership && !ownership.ownedTargetDrained) await cancelOwnedStorageTarget(binding, ownership.systemdInvocationId, this.run);
      } catch { /* Unknown/replaced invocation stays pending under its own holder. */ }
      // Containment is attempted even if immutable directive delivery failed.
      // Preserve that failure/unknown; never repair bytes or report a resolved stop.
      if (directiveError) throw directiveError;
      return this.status(jobId, expectedMachineId);
    }
    if (state.LoadState === 'not-found' && record.phase === 'starting') throw new Error('start is unresolved; reconcile before stop');
    if (state.LoadState !== 'not-found') await this.run('/usr/bin/systemctl', [...managerArgs(record), 'stop', record.unit]);
    return this.status(jobId, expectedMachineId);
  }
}
