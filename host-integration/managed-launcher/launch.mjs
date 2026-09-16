#!/usr/bin/node
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { prepareManagedJobLayout } from '../host-jobs/storage-policy.mjs';
import { PAYLOAD_GUARD_PATH } from './payload-guard.mjs';
import { requireTrustedExecutable, profileProperties } from './profiles.mjs';

export const MANAGED_LAUNCHER_PATH = '/opt/subscription-runtime/managed-launcher/launch.mjs';
const denied = () => { throw new Error('managed launcher: unsupported invocation'); };
const safePath = value => typeof value === 'string' && /^\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]*$/.test(value) && !value.split('/').some(part => part === '.' || part === '..');
const UNSHARE_PATH = '/usr/bin/unshare';
const SETPRIV_PATH = '/usr/bin/setpriv';
const TINI_PATH = '/usr/bin/tini';
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
    if (!payload[1].endsWith('/hosted-app-server-launcher.js') || payload.length !== 2) denied();
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
      `RuntimeMaxSec=${request.limits.runtimeSeconds}`, `TimeoutStopSec=${request.limits.stopSeconds}`] :
      ['CPUQuota=200%', 'MemoryHigh=2G', 'MemoryMax=4G', 'TasksMax=512', 'RuntimeMaxSec=8h', 'TimeoutStopSec=30s']), 'IOWeight=25',
    ...['/', policy.storageRoot].flatMap(path => ['IOReadBandwidthMax=' + path + ' 40M', 'IOReadIOPSMax=' + path + ' 3000', 'IOWriteBandwidthMax=' + path + ' 20M', 'IOWriteIOPSMax=' + path + ' 1500']),
    'ProtectControlGroups=yes',
    ...profileProperties(),
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

async function main() {
  if (process.argv.length !== 4) denied();
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
