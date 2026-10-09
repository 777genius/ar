#!/usr/bin/node
import { spawn } from 'node:child_process';
import { constants, lstatSync, openSync, fstatSync, readFileSync, closeSync } from 'node:fs';
import { access, open, readFile, writeFile, statfs, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { prepareManagedJobLayout, captureManagedStoragePin, requireManagedPinCapability, readManagedPinFile, MANAGED_STORAGE_LIFETIME_CONFIG } from '../host-jobs/storage-policy.mjs';
import { PAYLOAD_GUARD_PATH } from './payload-guard.mjs';
import { requireTrustedExecutable, profileProperties } from './profiles.mjs';
import { hasHostedActivationOrigin, HostedActivationMode, readHostedActivationMode } from './hosted-host-policy.mjs';

export const MANAGED_LAUNCHER_PATH = '/opt/subscription-runtime/managed-launcher/launch.mjs';
const denied = () => { throw new Error('managed launcher: unsupported invocation'); };
const fdUnsetEnvironment = 'NODE_OPTIONS NODE_PATH NODE_V8_COVERAGE NODE_EXTRA_CA_CERTS NODE_REDIRECT_WARNINGS OPENSSL_CONF OPENSSL_MODULES LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT GCONV_PATH LOCPATH GLIBC_TUNABLES';
function governedFdProfile(request) {
  if (readHostedActivationMode() === HostedActivationMode.Disabled && !hasHostedActivationOrigin() &&
      request.readonlyPaths === undefined) return false;
  const root = '/var/lib/subscription-runtime-host-policy';
  try { lstatSync(root + '/readonly-inventory.json'); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  for (const path of ['/', '/var', '/var/lib', root]) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022)) denied();
  }
  const read = name => {
    const path = root + '/' + name, fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || before.uid !== 0 || before.nlink !== 1 || (before.mode & 0o077) || before.size > 65536) denied();
      const bytes = readFileSync(fd), after = fstatSync(fd), current = lstatSync(path);
      if (before.dev !== current.dev || before.ino !== current.ino || before.ctimeMs !== after.ctimeMs ||
          before.mtimeMs !== after.mtimeMs || before.size !== bytes.length) denied();
      return bytes;
    } finally { closeSync(fd); }
  };
  const bytes = read('readonly-inventory.json'), inventory = JSON.parse(bytes.toString('utf8'));
  if ([1, 2, 3].includes(inventory.schemaVersion)) return false;
  if (inventory.schemaVersion !== 4 || inventory.collectorProfile?.path !== root + '/fd-collector-profile.v1.json' ||
      !/^[a-f0-9]{64}$/.test(inventory.collectorProfile?.sha256 ?? '') ||
      JSON.parse(read('host-installation.json').toString('utf8')).inventorySha256 !== createHash('sha256').update(bytes).digest('hex')) denied();
  return true;
}
const safePath = value => typeof value === 'string' && /^\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]*$/.test(value) && !value.split('/').some(part => part === '.' || part === '..');
const UNSHARE_PATH = '/usr/bin/unshare';
const SETPRIV_PATH = '/usr/bin/setpriv';
const TINI_PATH = '/usr/bin/tini';
// Namespace setup has its own finite budget, before Type=exec starts runtime accounting.
const JOB_STARTUP_SECONDS = 300;
// setpriv execs Tini as namespace PID 1; Node remains its supervised child.
export const managedBootstrap = Object.freeze([UNSHARE_PATH, '--map-user=65532', '--map-group=65532', '--keep-caps', '--pid', '--fork', '--mount-proc', '--kill-child=SIGKILL', SETPRIV_PATH, '--bounding-set=-all', '--inh-caps=-all', '--ambient-caps=-all', '--no-new-privs', TINI_PATH, '--']);

// The request contains identity and payload data, never systemd options.
export function parseInvocation(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) denied();
  const { operation, unit, payload } = request;
  if (!['job', 'provider'].includes(operation) || typeof request.jobId !== 'string' || request.jobId !== request.jobId.trim() || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(request.jobId) ||
      !Array.isArray(payload) || !payload.length || payload.length > 4096 ||
      payload.some(x => typeof x !== 'string' || x.includes('\0')) || !safePath(payload[0])) denied();
  const allowed = ['operation', 'unit', 'jobId', 'payload', ...(operation === 'job' ? ['fingerprint', 'limits'] : ['readonlyPaths'])];
  if (Object.keys(request).some(key => !allowed.includes(key))) denied();
  let trusted = [];
  if (operation === 'job') {
    if (!/^subscription-job-[a-f0-9]{64}\.service$/.test(unit) || !/^[a-f0-9]{64}$/.test(request.fingerprint) ||
        !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(request.jobId)) denied();
    const bounds = { runtimeSeconds: 86400, stopSeconds: 300, memoryMiB: 1048576, tasksMax: 65536, cpuPercent: 100000 };
    if (!request.limits || typeof request.limits !== 'object' || Array.isArray(request.limits) ||
        Object.keys(request.limits).length !== Object.keys(bounds).length || Object.entries(bounds).some(([key, max]) =>
          !Number.isSafeInteger(request.limits[key]) || request.limits[key] < 1 || request.limits[key] > max)) denied();
  } else {
    if (!/^subscription-runtime-hosted-[a-f0-9-]{36}\.service$/.test(unit) ||
        !payload[0].endsWith('/node') || !safePath(payload[1])) denied();
    if (!payload[1].endsWith('/hosted-app-server-launcher.js') ||
        !(payload.length === 2 || (payload.length === 3 && payload[2] === '--fd-ready-v1' && governedFdProfile(request)))) denied();
    trusted = payload.slice(0, 2);
  }
  if (request.readonlyPaths !== undefined) {
    if (!Array.isArray(request.readonlyPaths) || request.readonlyPaths.length > 256 ||
        request.readonlyPaths.some(path => !safePath(path) || path === '/')) denied();
  }
  return { ...request, trusted };
}

export function managedLauncherInvocation(request) {
  parseInvocation(request);
  return { command: process.execPath, args: [MANAGED_LAUNCHER_PATH, request.operation, JSON.stringify(request)] };
}

export async function buildSystemdInvocation(request, admit = prepareManagedJobLayout, { trust = requireTrustedExecutable, nodePath = process.execPath,
  guardPath = PAYLOAD_GUARD_PATH, launcherPath = MANAGED_LAUNCHER_PATH,
  executable = path => access(path, constants.X_OK), storagePin } = {}) {
  const { operation, unit, payload, trusted, readonlyPaths = [] } = parseInvocation(request);
  const confinementExecutables = [launcherPath, guardPath, UNSHARE_PATH, SETPRIV_PATH, TINI_PATH,
    ...(storagePin ? ['/usr/bin/mount', '/usr/sbin/blkid'] : [])];
  for (const path of [nodePath, ...trusted, ...confinementExecutables]) await trust(path);
  await executable(TINI_PATH);
  const policy = storagePin ? storagePin.pin.layout : await admit(request.jobId);
  if (storagePin && (operation !== 'job' || storagePin.binding.jobId !== request.jobId ||
      storagePin.binding.fingerprint !== request.fingerprint || storagePin.binding.unit !== unit)) denied();
  if (!policy || !safePath(policy.storageRoot) || policy.storageRoot === '/') denied();
  const cwd = policy.workspace;
  if (policy.jobRoot !== `${policy.storageRoot}/jobs/${request.jobId}` || cwd !== `${policy.jobRoot}/workspace`) denied();
  for (const path of [nodePath, guardPath, launcherPath, ...trusted]) {
    if (path === policy.storageRoot || path.startsWith(policy.storageRoot + '/')) denied();
  }
  const properties = [
    'Slice=subscription-runtime-hosted.slice', 'KillMode=control-group', 'SendSIGKILL=yes', 'Delegate=no', 'Restart=no',
    ...(operation === 'job' ? [`CPUQuota=${request.limits.cpuPercent}%`, `MemoryMax=${request.limits.memoryMiB}M`, `TasksMax=${request.limits.tasksMax}`,
      `RuntimeMaxSec=${request.limits.runtimeSeconds}`, `TimeoutStopSec=${request.limits.stopSeconds}`,
      `TimeoutStartSec=${JOB_STARTUP_SECONDS}`] :
      ['CPUQuota=200%', 'MemoryHigh=2G', 'MemoryMax=4G', 'TasksMax=512', 'RuntimeMaxSec=8h', 'TimeoutStopSec=30s']), 'IOWeight=25',
    ...['/', policy.storageRoot].flatMap(path => ['IOReadBandwidthMax=' + path + ' 40M', 'IOReadIOPSMax=' + path + ' 3000', 'IOWriteBandwidthMax=' + path + ' 20M', 'IOWriteIOPSMax=' + path + ' 1500']),
    'ProtectControlGroups=yes',
    ...profileProperties(),
    ...(governedFdProfile(request) ? ['FileDescriptorStoreMax=0', 'PassEnvironment=', `UnsetEnvironment=${fdUnsetEnvironment}`,
      'SystemCallFilter=~io_uring_setup:ENOSYS io_uring_enter:ENOSYS io_uring_register:ENOSYS',
      'SystemCallArchitectures=native', 'NoNewPrivileges=yes'] : []),
    ...(operation === 'job' ? ['StandardOutput=null', 'StandardError=null'] : []),
    'ProtectSystem=strict', `ReadWritePaths=${policy.jobRoot}`, `RequiresMountsFor=${policy.storageRoot}`,
    'TemporaryFileSystem=/tmp:rw,nosuid,nodev,mode=1777,size=256M /var/tmp:rw,nosuid,nodev,mode=1777,size=64M',
    'NoNewPrivileges=yes', 'MemorySwapMax=0', 'LimitCORE=0',
    ...readonlyPaths.map(path => `BindReadOnlyPaths=${path}:${path}:norbind`),
    ...(storagePin ? ['MountFlags=private', 'RemainAfterExit=yes',
      `OpenFile=/proc/${process.pid}/fd/${storagePin.pin.handle.fd}:storage-pin:read-only`,
      `OpenFile=/proc/${process.pid}/fd/${storagePin.receipt.fd}:storage-acquisition`,
      `OpenFile=/proc/${process.pid}/fd/${storagePin.activation.fd}:storage-activation:read-only`,
      `InaccessiblePaths=${storagePin.binding.directory}`] : []),
  ];
  return { command: '/usr/bin/systemd-run', args: [
    ...(operation === 'job' ? [`--description=subscription-job:${request.fingerprint}${storagePin ? ':storage:' + storagePin.binding.invocationId : ''}`] : ['--quiet', '--wait', '--pipe', '--collect']),
    `--unit=${unit}`, `--working-directory=${cwd}`, '--service-type=exec', '--expand-environment=no',
    `--setenv=HOME=${policy.home}`, `--setenv=TMPDIR=${policy.tmp}`,
    ...(operation === 'job' ? [`--setenv=SUBSCRIPTION_RUNTIME_HOST_JOB_ID=${request.jobId}`] : []),
    `--setenv=SUBSCRIPTION_RUNTIME_JOB_ID=${request.jobId}`,
    '--setenv=SUBSCRIPTION_RUNTIME_MANAGED_LAUNCH=1',
    `--setenv=SUBSCRIPTION_RUNTIME_JOB_ROOT=${policy.jobRoot}`,
    ...properties.map(property => `--property=${property}`), '--', ...(storagePin ? [nodePath, guardPath,
      '--acquire-storage-pin', JSON.stringify({ schemaVersion: 1, invocationId: storagePin.binding.invocationId,
        generation: storagePin.binding.generation, unit, fingerprint: request.fingerprint, witness: storagePin.pin.witness }),
      '--node', nodePath] : [...managedBootstrap, nodePath, guardPath]),
    '--job-id', request.jobId, ...(operation === 'job' ? ['--job-unit', unit] : []), '--', ...payload,
  ] };
}

export const ManagedPinObservation = Object.freeze({ Held: 'held', Acquired: 'acquired', CancelPending: 'cancel-pending',
  AwaitingAcquisition: 'awaiting-acquisition', CancelledDrained: 'cancelled-owned-cgroup-drained',
  TerminalDrained: 'terminal-owned-cgroup-drained', CancelledBeforeSubmit: 'cancelled-before-submit', Unknown: 'unknown' });
const issuerDescription = binding => `subscription-storage-issuer:${binding.invocationId}:${binding.fingerprint}`;
export const storageTargetUnit = (jobId, invocationId) => `subscription-job-${createHash('sha256').update(`${jobId}:${invocationId}`).digest('hex')}.service`;
export function validateStorageIssuerBinding(binding) {
  if (!binding || Object.keys(binding).sort().join(',') !== 'acquisitionPath,activationPath,capabilitySha256,directory,envelopePath,fingerprint,generation,invocationId,issuerUnit,jobId,machineId,unit' ||
      !/^[a-f0-9-]{36}$/.test(binding.invocationId) || !/^[a-f0-9]{64}$/.test(binding.fingerprint) ||
      !/^[a-f0-9]{64}$/.test(binding.capabilitySha256) || !/^[a-f0-9]{32}$/.test(binding.machineId) ||
      binding.issuerUnit !== `subscription-storage-issuer-${binding.invocationId}.service` ||
      binding.generation !== `${binding.jobId}:${binding.invocationId}` || !safePath(binding.directory) ||
      binding.envelopePath !== `${binding.directory}/launch.json` || binding.acquisitionPath !== `${binding.directory}/acquisition.json` ||
      binding.activationPath !== `${binding.directory}/activation.json` ||
      !/^subscription-job-[a-f0-9]{64}\.service$/.test(binding.unit) ||
      binding.unit !== storageTargetUnit(binding.jobId, binding.invocationId) ||
      !binding.directory.endsWith(`/native-storage/${binding.unit}/${binding.invocationId}`)) denied();
  return binding;
}
/** Own service, never a detached transport child. No payload command runs here. */
export async function storageIssuerInvocation(binding, nodePath = process.execPath) {
  validateStorageIssuerBinding(binding);
  for (const path of [nodePath, MANAGED_LAUNCHER_PATH]) await requireTrustedExecutable(path);
  return { command: '/usr/bin/systemd-run', args: [`--unit=${binding.issuerUnit}`, '--service-type=exec', '--expand-environment=no',
    `--description=${issuerDescription(binding)}`, '--property=Slice=subscription-runtime-hosted.slice',
    '--property=KillMode=control-group', '--property=Delegate=no', '--property=Restart=no',
    // A transport/stop timeout cannot be permission to drop an unresolved pin.
    '--property=TimeoutStopSec=infinity', '--property=SendSIGKILL=no', '--property=NoNewPrivileges=yes',
    '--property=UMask=0077', '--property=StandardOutput=null', '--property=StandardError=null', '--',
    nodePath, MANAGED_LAUNCHER_PATH, 'storage-issuer', binding.envelopePath] };
}
export function parseNativeUnitProperties(text, properties) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 1048576 || text.includes('\0')) denied();
  /** @type {Record<string, string>} */
  const state = {};
  const rows = text.trimEnd().split('\n');
  for (const line of rows) {
    const split = line.indexOf('='), key = line.slice(0, split);
    if (split < 1 || !properties.includes(key) || Object.hasOwn(state, key)) denied();
    state[key] = line.slice(split + 1);
  }
  if (Object.keys(state).length !== properties.length) denied();
  return state;
}
async function nativeUnit(run, binding) {
  const text = await run('/usr/bin/systemctl', ['show', binding.unit,
    '--property=LoadState,ActiveState,SubState,ControlGroup,Description,InvocationID,MainPID,Job,Slice']);
  const state = parseNativeUnitProperties(text, ['LoadState', 'ActiveState', 'SubState', 'ControlGroup', 'Description', 'InvocationID', 'MainPID', 'Job', 'Slice']);
  if (state.LoadState !== 'not-found' && state.Description !== `subscription-job:${binding.fingerprint}:storage:${binding.invocationId}`) denied();
  return state;
}
async function observedOwnership(binding, expectedWitness, target) {
  const bytes = await readManagedPinFile(binding.acquisitionPath);
  if (!bytes.length) return undefined;
  const value = JSON.parse(bytes.toString('utf8'));
  const fields = value?.stage === 'bootstrap' ? 'fingerprint,generation,invocationId,namespace,pid,schemaVersion,stage,systemdInvocationId,unit,witness' :
    'fingerprint,generation,invocationId,namespace,pid,pin,schemaVersion,systemdInvocationId,unit,witness';
  if (!value || Object.keys(value).sort().join(',') !== fields ||
      value.schemaVersion !== 1 || value.invocationId !== binding.invocationId || value.generation !== binding.generation ||
      value.unit !== binding.unit || value.fingerprint !== binding.fingerprint ||
      JSON.stringify(value.witness) !== JSON.stringify(expectedWitness) || !/^[a-f0-9]{32}$/.test(value.systemdInvocationId) ||
      target.InvocationID !== value.systemdInvocationId || !Number.isSafeInteger(value.pid) || value.pid < 1 ||
      !/^mnt:\[[0-9]+\]$/.test(value.namespace) || (value.stage !== 'bootstrap' && (value.pin?.device !== expectedWitness.device ||
      value.pin?.inode !== expectedWitness.inode || !/^[1-9][0-9]*$/.test(value.pin?.mountId)))) denied();
  if (await ownedTargetDrained(binding, target, value.systemdInvocationId)) return { ...value, ownedTargetDrained: true };
  const expectedGroup = `/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/${binding.unit}`;
  if (target.MainPID === '0' && (['inactive', 'failed'].includes(target.ActiveState) ||
      (target.ActiveState === 'active' && target.SubState === 'exited')) && target.Slice === 'subscription-runtime-hosted.slice' &&
      (!target.ControlGroup || target.ControlGroup === expectedGroup)) return { ...value, mainExited: true };
  if (target.MainPID !== String(value.pid)) denied();
  // The witness's namespace is the actual current namespace of this exact main process.
  const { readlink } = await import('node:fs/promises');
  if (await readlink(`/proc/${value.pid}/ns/mnt`) !== value.namespace) denied();
  return value;
}
async function observedAcquisition(binding, expectedWitness, target) {
  const ownership = await observedOwnership(binding, expectedWitness, target);
  return ownership?.stage === 'bootstrap' || ownership?.mainExited ? undefined : ownership;
}
export async function currentStorageOwnership(binding, run) {
  validateStorageIssuerBinding(binding);
  const source = JSON.parse((await readManagedPinFile(`${binding.directory}/source.json`)).toString('utf8'));
  if (Object.keys(source).sort().join(',') !== 'generation,invocationId,schemaVersion,witness' || source.schemaVersion !== 1 ||
      source.invocationId !== binding.invocationId || source.generation !== binding.generation ||
      source.witness.capabilitySha256 !== binding.capabilitySha256) denied();
  return observedOwnership(binding, source.witness, await nativeUnit(run, binding));
}
/** Cancellation targets the retained actual cgroup directory, never a mutable
 * unit name after a token check. Replaced/deleted groups cannot redirect this FD.
 */
export async function cancelOwnedStorageTarget(binding, invocationId, run, controlGroup) {
  validateStorageIssuerBinding(binding);
  if (!/^[a-f0-9]{32}$/.test(invocationId)) denied();
  const target = await nativeUnit(run, binding), expected = controlGroup ??
    `/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/${binding.unit}`;
  if (target.InvocationID !== invocationId || target.Slice !== 'subscription-runtime-hosted.slice' ||
      typeof expected !== 'string' || expected !== `/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/${binding.unit}` ||
      (target.ControlGroup && target.ControlGroup !== expected)) denied();
  const path = `/sys/fs/cgroup${expected}`;
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let kill;
  try {
    const identity = await directory.stat({ bigint: true }), current = await stat(path, { bigint: true });
    if (identity.dev !== current.dev || identity.ino !== current.ino || identity.uid !== 0n ||
        (await statfs(`/proc/self/fd/${directory.fd}`, { bigint: true })).type !== 0x63677270n) denied();
    kill = await open(`/proc/self/fd/${directory.fd}/cgroup.kill`, constants.O_WRONLY | constants.O_NOFOLLOW);
    const after = await nativeUnit(run, binding);
    if (after.InvocationID !== invocationId || (after.ControlGroup && after.ControlGroup !== expected) || after.Slice !== target.Slice) denied();
    await kill.writeFile('1\n');
  } finally { await kill?.close(); await directory.close(); }
}
export async function currentStorageAcquisition(binding, run) {
  validateStorageIssuerBinding(binding);
  const source = JSON.parse((await readManagedPinFile(`${binding.directory}/source.json`)).toString('utf8'));
  if (Object.keys(source).sort().join(',') !== 'generation,invocationId,schemaVersion,witness' || source.schemaVersion !== 1 ||
      source.invocationId !== binding.invocationId || source.generation !== binding.generation ||
      source.witness.capabilitySha256 !== binding.capabilitySha256) denied();
  const acquisition = await observedAcquisition(binding, source.witness, await nativeUnit(run, binding));
  if (!acquisition || acquisition.ownedTargetDrained) return acquisition;
  const decision = await readStorageDecision(binding);
  if (decision?.action !== 'activate' || JSON.stringify(decision.acquisition) !== JSON.stringify(acquisition)) return undefined;
  const activation = JSON.parse((await readManagedPinFile(binding.activationPath)).toString('utf8'));
  if (JSON.stringify(activation) !== JSON.stringify(decision)) denied();
  return acquisition;
}
/** Exclusive creation is the shared activation/cancellation linearization point. */
export async function decideStorageInvocation(binding, action, acquisition) {
  validateStorageIssuerBinding(binding);
  if (!['activate', 'cancel'].includes(action) || (action === 'activate') !== Boolean(acquisition)) denied();
  const decision = { schemaVersion: 1, invocationId: binding.invocationId, generation: binding.generation,
    action, ...(acquisition ? { acquisition } : {}) };
  try { await writeFile(`${binding.directory}/decision.json`, JSON.stringify(decision) + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  return readStorageDecision(binding);
}
export async function readStorageDecision(binding) {
  let bytes;
  try { bytes = await readManagedPinFile(`${binding.directory}/decision.json`); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  const value = JSON.parse(bytes.toString('utf8'));
  const fields = value?.action === 'activate' ? 'acquisition,action,generation,invocationId,schemaVersion' : 'action,generation,invocationId,schemaVersion';
  if (!value || Object.keys(value).sort().join(',') !== fields || value.schemaVersion !== 1 ||
      value.invocationId !== binding.invocationId || value.generation !== binding.generation || !['activate', 'cancel'].includes(value.action)) denied();
  return value;
}
async function cancellationRequested(binding) {
  let bytes;
  try { bytes = await readManagedPinFile(`${binding.directory}/cancel.json`); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  const cancel = JSON.parse(bytes.toString('utf8'));
  if (Object.keys(cancel).sort().join(',') !== 'generation,invocationId,schemaVersion' || cancel.schemaVersion !== 1 ||
      cancel.invocationId !== binding.invocationId || cancel.generation !== binding.generation) denied();
  return true;
}
async function ownedTargetDrained(binding, target, invocationId, controlGroup) {
  const terminal = ['inactive', 'failed'].includes(target.ActiveState) || (target.ActiveState === 'active' && target.SubState === 'exited');
  if (target.LoadState === 'not-found' || target.InvocationID !== invocationId ||
      !terminal || !Object.hasOwn(target, 'Job') || (target.Job !== '' && !/^0(?:\s|$)/.test(target.Job))) return false;
  if (target.Slice !== 'subscription-runtime-hosted.slice') return false;
  const expected = controlGroup ?? `/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/${binding.unit}`;
  if (typeof expected !== 'string' || !/^\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/.test(expected) ||
      !expected.endsWith(`/${binding.unit}`)) return false;
  if (target.ControlGroup && target.ControlGroup !== expected) return false;
  try {
    const events = await readFile(`/sys/fs/cgroup${expected}/cgroup.events`, 'utf8');
    return /^populated 0$/m.test(events);
  } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}
/** Independently owned invocation retains FD on unknown, with no retry or expiry. */
export async function runStorageIssuer(envelopePath, { capabilityPath = MANAGED_STORAGE_LIFETIME_CONFIG,
  layoutOptions = {}, launchOptions = {} } = {}) {
  const envelope = JSON.parse((await readManagedPinFile(envelopePath, 131072)).toString('utf8'));
  if (!envelope || Object.keys(envelope).sort().join(',') !== 'binding,request,schemaVersion' || envelope.schemaVersion !== 1) denied();
  const binding = validateStorageIssuerBinding(envelope.binding), request = parseInvocation(envelope.request);
  if (binding.envelopePath !== envelopePath || request.operation !== 'job' || request.jobId !== binding.jobId ||
      request.unit !== binding.unit || request.fingerprint !== binding.fingerprint ||
      (await readFile('/etc/machine-id', 'utf8')).trim() !== binding.machineId || process.getuid() !== 0) denied();
  const { systemCommand } = await import('../host-jobs/manager.mjs');
  const capability = await requireManagedPinCapability(binding.machineId, { path: capabilityPath });
  if (capability.capabilitySha256 !== binding.capabilitySha256) denied();
  const issuerState = parseNativeUnitProperties(await systemCommand('/usr/bin/systemctl', ['show', binding.issuerUnit,
    '--property=Description,MainPID,InvocationID']), ['Description', 'MainPID', 'InvocationID']);
  if (issuerState.Description !== issuerDescription(binding) || issuerState.MainPID !== String(process.pid) ||
      !/^[a-f0-9]{32}$/.test(process.env.INVOCATION_ID) || issuerState.InvocationID !== process.env.INVOCATION_ID) denied();
  await writeFile(`${binding.directory}/issuer.json`, JSON.stringify({ schemaVersion: 1,
    invocationId: binding.invocationId, generation: binding.generation,
    systemdInvocationId: process.env.INVOCATION_ID, pid: process.pid }) + '\n', { flag: 'wx', mode: 0o600 });
  if (await cancellationRequested(binding)) return ManagedPinObservation.CancelledBeforeSubmit;
  const pin = await captureManagedStoragePin(binding.jobId, capability, layoutOptions);
  const receipt = await open(binding.acquisitionPath, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const activation = await open(binding.activationPath, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let sourceReleased = false, stopped = false, targetInvocationId, targetControlGroup;
  // Signals fence further action. They do not implicitly close native references.
  const signal = () => { stopped = true; };
  for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(name, signal);
  const release = async () => { if (!sourceReleased) { await pin.close(); sourceReleased = true; } };
  try {
    const receiptInfo = await receipt.stat({ bigint: true });
    const activationInfo = await activation.stat({ bigint: true });
    if (!receiptInfo.isFile() || receiptInfo.uid !== 0n || receiptInfo.nlink !== 1n || (receiptInfo.mode & 0o077n) || receiptInfo.size !== 0n) denied();
    if (!activationInfo.isFile() || activationInfo.uid !== 0n || activationInfo.nlink !== 1n || (activationInfo.mode & 0o077n) || activationInfo.size !== 0n) denied();
    const invocation = await buildSystemdInvocation(request, undefined, { ...launchOptions, storagePin: { binding, pin, receipt, activation } });
    await writeFile(`${binding.directory}/source.json`, JSON.stringify({ schemaVersion: 1, invocationId: binding.invocationId,
      generation: binding.generation, witness: pin.witness }) + '\n', { flag: 'wx', mode: 0o600 });
    if (stopped || await cancellationRequested(binding)) return ManagedPinObservation.CancelledBeforeSubmit;
    // Immutable attempt fence precedes submission. A service restart cannot replay.
    await writeFile(`${binding.directory}/submit-attempt.json`, JSON.stringify({ schemaVersion: 1,
      invocationId: binding.invocationId, generation: binding.generation }) + '\n', { flag: 'wx', mode: 0o600 });
    // A return/timeout is transport state only. Never release from this result.
    let submit;
    try { submit = spawn(invocation.command, invocation.args, { stdio: 'ignore' }); }
    catch { stopped = true; }
    if (submit) {
      submit.once('error', () => { stopped = true; });
      submit.once('exit', () => {});
    }
    for (;;) {
      let target, acquisition;
      try {
        target = await nativeUnit(systemCommand, binding);
        const ownership = await observedOwnership(binding, pin.witness, target);
        if (ownership) {
          if (targetInvocationId && ownership.systemdInvocationId !== targetInvocationId) denied();
          targetInvocationId = ownership.systemdInvocationId;
          if (target.ControlGroup) {
            if (targetControlGroup && target.ControlGroup !== targetControlGroup) denied();
            targetControlGroup = target.ControlGroup;
          }
        }
        acquisition = await observedAcquisition(binding, pin.witness, target);
      } catch {
        // Partial receipt, unit/namespace mismatch and unavailable manager remain protected unknown.
        target = undefined;
      }
      try { if (await cancellationRequested(binding)) stopped = true; }
      catch { target = undefined; }
      if (acquisition && !stopped && target) {
        try {
          if (acquisition.ownedTargetDrained) { await release(); return ManagedPinObservation.TerminalDrained; }
          const decision = await decideStorageInvocation(binding, 'activate', acquisition);
          if (decision.action === 'cancel') stopped = true;
          else {
            if (JSON.stringify(decision.acquisition) !== JSON.stringify(acquisition)) denied();
            // The bootstrap's readonly descriptor receives only this exact fenced
            // decision. Acquisition by itself cannot permit a first payload write.
            await activation.writeFile(JSON.stringify(decision) + '\n'); await activation.sync();
            await release(); return ManagedPinObservation.Acquired;
          }
        } catch { target = undefined; }
      }
      if (stopped && target && targetInvocationId) {
        // Only this supervisor's own child is signalled; no PID search or foreign kill.
        if (submit && submit.exitCode === null && submit.signalCode === null) { submit.kill('SIGTERM'); }
        try {
          if (!await ownedTargetDrained(binding, target, targetInvocationId, targetControlGroup)) {
            await cancelOwnedStorageTarget(binding, targetInvocationId, systemCommand, targetControlGroup);
          }
          const final = await nativeUnit(systemCommand, binding);
          if (await ownedTargetDrained(binding, final, targetInvocationId, targetControlGroup)) { await release(); return ManagedPinObservation.CancelledDrained; }
        } catch { /* Exact owner must reconcile again. There is no resubmission. */ }
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  } finally {
    // This finally is reached only after an acquired/drained proof or a pre-submit failure.
    // Unknown never reaches it merely because a transport or signal expires.
    await release(); await receipt.close(); await activation.close();
    for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.removeListener(name, signal);
  }
}

async function main() {
  if (process.argv.length !== 4) denied();
  if (process.argv[2] === 'storage-issuer') { await runStorageIssuer(process.argv[3]); return; }
  const request = JSON.parse(process.argv[3]);
  if (request.operation !== process.argv[2]) denied();
  const invocation = await buildSystemdInvocation(request);
  const child = spawn(invocation.command, invocation.args, { stdio: 'inherit' });
  const handlers = new Map(['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => [signal, () => child.kill(signal)]));
  for (const [signal, handler] of handlers) process.on(signal, handler);
  child.on('error', () => { process.exitCode = 70; });
  child.on('exit', (code, signal) => {
    for (const [name, handler] of handlers) process.removeListener(name, handler);
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 70;
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(error => {
  console.error(error.message);
  process.exitCode = 70;
});
