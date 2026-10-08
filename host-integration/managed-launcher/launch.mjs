#!/usr/bin/node
import { spawn } from 'node:child_process';
import { constants, lstatSync, openSync, fstatSync, readFileSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { access, lstat, realpath } from 'node:fs/promises';
import { dirname } from 'node:path';
import { readlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { prepareManagedJobLayout } from '../host-jobs/storage-policy.mjs';
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
      if (!before.isFile() || before.uid !== 0 || before.nlink !== 1 || (before.mode & 0o077) ||
          before.size > (name === 'readonly-inventory.json' ? 4 * 1024 * 1024 : 65536)) denied();
      const bytes = readFileSync(fd), after = fstatSync(fd), current = lstatSync(path);
      if (before.dev !== current.dev || before.ino !== current.ino || before.ctimeMs !== after.ctimeMs ||
          before.mtimeMs !== after.mtimeMs || before.size !== bytes.length ||
          after.ctimeMs !== current.ctimeMs || after.mtimeMs !== current.mtimeMs) denied();
      return bytes;
    } finally { closeSync(fd); }
  };
  const bytes = read('readonly-inventory.json');
  let inventory = JSON.parse(bytes.toString('utf8'));
  if (inventory.schemaVersion === 5) {
    if (JSON.parse(read('host-installation.json').toString('utf8')).inventorySha256 !==
        createHash('sha256').update(bytes).digest('hex')) denied();
    // The installer publishes this measured, zero-import helper before its only
    // new consumer. Never select a module from inventory or a current pointer.
    const codecPath = fileURLToPath(new URL('./host-inventory-codec.cjs', import.meta.url));
    for (let path = new URL('.', import.meta.url);; path = new URL('../', path)) {
      const directory = lstatSync(fileURLToPath(path));
      if (!directory.isDirectory() || directory.uid !== 0 || (directory.mode & 0o022)) denied();
      if (fileURLToPath(path) === '/') break;
    }
    const codec = lstatSync(codecPath);
    if (!codec.isFile() || codec.uid !== 0 || codec.nlink !== 1 || (codec.mode & 0o022)) denied();
    const profileBytes = read('fd-collector-profile.v1.json');
    if (inventory.collectorProfile?.path !== root + '/fd-collector-profile.v1.json' ||
        createHash('sha256').update(profileBytes).digest('hex') !== inventory.collectorProfile?.sha256) denied();
    const profile = JSON.parse(profileBytes.toString('utf8'));
    for (const path of [fileURLToPath(import.meta.url), codecPath]) {
      const pins = profile.bootstraps?.filter(pin => pin.path === path);
      if (!Array.isArray(pins) || pins.length !== 1) denied();
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const before = fstatSync(fd);
        if (!before.isFile() || before.uid !== 0 || before.nlink !== 1 || (before.mode & 0o022) ||
            before.size < 1 || before.size > 4 * 1024 * 1024) denied();
        const body = readFileSync(fd), after = fstatSync(fd), current = lstatSync(path);
        if (body.length !== before.size || before.dev !== current.dev || before.ino !== current.ino ||
            before.ctimeMs !== after.ctimeMs || before.mtimeMs !== after.mtimeMs ||
            after.ctimeMs !== current.ctimeMs || after.mtimeMs !== current.mtimeMs ||
            createHash('sha256').update(body).digest('hex') !== pins[0].sha256) denied();
      } finally { closeSync(fd); }
    }
    inventory = createRequire(import.meta.url)('./host-inventory-codec.cjs').decodeHostedInventoryBytes(bytes);
  } else if (bytes.length > 65536) denied();
  if ([1, 2, 3].includes(inventory.schemaVersion)) return false;
  if (![4, 5].includes(inventory.schemaVersion) || inventory.collectorProfile?.path !== root + '/fd-collector-profile.v1.json' ||
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
const bootstrap = [UNSHARE_PATH, '--map-user=65532', '--map-group=65532', '--keep-caps', '--pid', '--fork', '--mount-proc', '--kill-child=SIGKILL', SETPRIV_PATH, '--bounding-set=-all', '--inh-caps=-all', '--ambient-caps=-all', '--no-new-privs', TINI_PATH, '--'];

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

export async function buildSystemdInvocation(request, admit = prepareManagedJobLayout, { trust = requireTrustedExecutable, nodePath = process.execPath, executable = path => access(path, constants.X_OK) } = {}) {
  const { operation, unit, payload, trusted, readonlyPaths = [] } = parseInvocation(request);
  const confinementExecutables = [MANAGED_LAUNCHER_PATH, PAYLOAD_GUARD_PATH, UNSHARE_PATH, SETPRIV_PATH, TINI_PATH];
  for (const path of [nodePath, ...trusted, ...confinementExecutables]) await trust(path);
  await executable(TINI_PATH);
  const policy = await admit(request.jobId);
  if (!policy || !safePath(policy.storageRoot) || policy.storageRoot === '/') denied();
  const cwd = policy.workspace;
  if (policy.jobRoot !== `${policy.storageRoot}/jobs/${request.jobId}` || cwd !== `${policy.jobRoot}/workspace`) denied();
  for (const path of [nodePath, PAYLOAD_GUARD_PATH, MANAGED_LAUNCHER_PATH, ...trusted]) {
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
    ...(governedFdProfile(request) ? ['FileDescriptorStoreMax=0', 'PassEnvironment=', `UnsetEnvironment=${fdUnsetEnvironment}`] : []),
    ...(operation === 'job' ? ['StandardOutput=null', 'StandardError=null'] : []),
    'ProtectSystem=strict', `ReadWritePaths=${policy.jobRoot}`, `RequiresMountsFor=${policy.storageRoot}`,
    'TemporaryFileSystem=/tmp:rw,nosuid,nodev,mode=1777,size=256M /var/tmp:rw,nosuid,nodev,mode=1777,size=64M',
    'NoNewPrivileges=yes', 'MemorySwapMax=0', 'LimitCORE=0',
    ...readonlyPaths.map(path => `BindReadOnlyPaths=${path}:${path}:norbind`),
  ];
  return { command: '/usr/bin/systemd-run', args: [
    ...(operation === 'job' ? [`--description=subscription-job:${request.fingerprint}`] : ['--quiet', '--wait', '--pipe', '--collect']),
    `--unit=${unit}`, `--working-directory=${cwd}`, '--service-type=exec', '--expand-environment=no',
    `--setenv=HOME=${policy.home}`, `--setenv=TMPDIR=${policy.tmp}`,
    ...(operation === 'job' ? [`--setenv=SUBSCRIPTION_RUNTIME_HOST_JOB_ID=${request.jobId}`] : []),
    `--setenv=SUBSCRIPTION_RUNTIME_JOB_ID=${request.jobId}`,
    '--setenv=SUBSCRIPTION_RUNTIME_MANAGED_LAUNCH=1',
    `--setenv=SUBSCRIPTION_RUNTIME_JOB_ROOT=${policy.jobRoot}`,
    ...properties.map(property => `--property=${property}`), '--', ...bootstrap,
    nodePath, PAYLOAD_GUARD_PATH, '--job-id', request.jobId, ...(operation === 'job' ? ['--job-unit', unit] : []), '--', ...payload,
  ] };
}

// Optional transport deadlines only narrow an existing job. They are never
// request fields, policy selectors, or authority for a longer service lifetime.
export function parseOriginalEnds(raw, timeNamespace) {
  if (typeof raw !== 'string' || raw.length > 512) denied();
  const value = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      value.version !== 1 || value.kind !== 'ManagedOriginalEnds' ||
      typeof value.timeNamespace !== 'string' || !/^time:\[[1-9][0-9]{0,19}\]$/.test(value.timeNamespace) ||
      value.timeNamespace !== timeNamespace) denied();
  for (const end of [value.workEndNs, value.cleanupEndNs]) {
    if (typeof end !== 'string' || !/^[1-9][0-9]{0,18}$/.test(end) || BigInt(end) > (1n << 63n) - 1n) denied();
  }
  const canonical = { version: 1, kind: 'ManagedOriginalEnds', timeNamespace: value.timeNamespace,
    workEndNs: value.workEndNs, cleanupEndNs: value.cleanupEndNs };
  if (JSON.stringify(canonical) !== raw || BigInt(value.cleanupEndNs) <= BigInt(value.workEndNs)) denied();
  return Object.freeze({ timeNamespace: value.timeNamespace,
    workEndNs: BigInt(value.workEndNs), cleanupEndNs: BigInt(value.cleanupEndNs) });
}

export function parseLauncherArguments(args, timeNamespace) {
  if (!Array.isArray(args) || ![2, 4].includes(args.length) || args.some(arg => typeof arg !== 'string')) denied();
  const request = JSON.parse(args[1]);
  if (!request || typeof request !== 'object' || request.operation !== args[0]) denied();
  const optional = args.length === 4;
  if (optional && (args[0] !== 'job' || args[2] !== '--original-ends-v1' || JSON.stringify(request) !== args[1])) denied();
  const ends = optional ? parseOriginalEnds(args[3], timeNamespace) : null;
  // Legacy parsing remains in the existing builder; optional job transport
  // is validated and frozen before any asynchronous preparation.
  if (optional) { parseInvocation(request); Object.freeze(request.payload); Object.freeze(request.limits); Object.freeze(request); }
  return { request, ends };
}

export function originalJobReservation(request) {
  const parsed = parseInvocation(request);
  if (parsed.operation !== 'job') denied();
  const workNs = BigInt(JOB_STARTUP_SECONDS + parsed.limits.runtimeSeconds) * 1_000_000_000n;
  return Object.freeze({ workNs, cleanupNs: workNs + BigInt(parsed.limits.stopSeconds) * 1_000_000_000n });
}

export function assertOriginalReservation(ends, reservation, anchor, now) {
  if (typeof anchor !== 'bigint' || typeof now !== 'bigint' || anchor <= 0n || now < anchor ||
      typeof ends.workEndNs !== 'bigint' || typeof ends.cleanupEndNs !== 'bigint' ||
      typeof reservation.workNs !== 'bigint' || typeof reservation.cleanupNs !== 'bigint' ||
      reservation.workNs <= 0n || reservation.cleanupNs <= reservation.workNs ||
      ends.cleanupEndNs <= ends.workEndNs || now + reservation.workNs >= ends.workEndNs ||
      now + reservation.cleanupNs >= ends.cleanupEndNs) throw new Error('managed launcher: original ends exhausted');
}

async function admitOriginalManagerExecutable(path) {
  if (path !== '/usr/bin/systemd-run' || await realpath(path) !== path) denied();
  for (let current = path; ; current = dirname(current)) {
    const info = await lstat(current);
    if (info.isSymbolicLink() || info.uid !== 0 || info.gid !== 0 || (info.mode & 0o022) ||
        (current === path ? !info.isFile() || info.nlink !== 1 || !(info.mode & 0o111) : !info.isDirectory())) denied();
    if (current === '/') break;
  }
  await access(path, constants.X_OK);
}

async function main() {
  const args = process.argv.slice(2);
  const { request, ends } = parseLauncherArguments(args,
    args.length === 4 ? readlinkSync('/proc/self/ns/time') : undefined);
  const anchor = process.hrtime.bigint();
  const invocation = await buildSystemdInvocation(request);
  if (ends) await admitOriginalManagerExecutable(invocation.command);
  const reservation = ends ? originalJobReservation(request) : null;
  const command = invocation.command, childArgs = [...invocation.args], options = { stdio: 'inherit' };
  // Every real asynchronous admission has completed. No await, callback or
  // renewed timeout lies between this original monotonic sample and birth.
  if (ends) assertOriginalReservation(ends, reservation, anchor, process.hrtime.bigint());
  const child = spawn(command, childArgs, options);
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
