#!/usr/bin/node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fstatSync, statSync, constants } from 'node:fs';
import { mkdir, lstat, open, readFile } from 'node:fs/promises';
import { HOST_STORAGE_POLICY_PATH, requireFinalJobStorage, deriveManagedJobLayout } from '../host-jobs/storage-policy.mjs';

export const PAYLOAD_GUARD_PATH = '/usr/local/lib/subscription-runtime/managed-launcher/payload-guard.mjs';

export async function requireMappedHostRootUid({ read = path => readFile(path, 'utf8'), uid = () => process.geteuid(), gid = () => process.getegid() } = {}) {
  const parse = text => {
    const lines = text.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
    if (lines.length !== 1 || lines[0].length !== 3 || lines[0].some(value => !Number.isSafeInteger(value))) {
      throw new Error('managed payload: invalid user namespace');
    }
    return lines[0];
  };
  const [uidMap, gidMap] = await Promise.all([read('/proc/self/uid_map'), read('/proc/self/gid_map')]).then(values => values.map(parse));
  if (uid() !== 65532 || gid() !== 65532 || uidMap[0] !== 65532 || uidMap[1] !== 0 || uidMap[2] !== 1 ||
      gidMap[0] !== 65532 || gidMap[1] !== 0 || gidMap[2] !== 1) throw new Error('managed payload: invalid user namespace');
  return 65532n;
}

export async function openJobLogs(directory, unit, device, probe = { mkdir, lstat, open }, expectedUid = 0n) {
  if (!/^subscription-job-[a-f0-9]{64}\.service$/.test(unit)) throw new Error('managed payload: invalid job unit');
  await probe.mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const metadata = await probe.lstat(directory, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== expectedUid || (metadata.mode & 0o077n) !== 0n || metadata.dev !== device) {
    throw new Error('managed payload: unsafe log directory');
  }
  const handles = [];
  try {
    for (const stream of ['stdout', 'stderr']) {
      const handle = await probe.open(`${directory}/${unit}.${stream}.log`, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
      handles.push(handle);
      const info = await handle.stat({ bigint: true });
      if (!info.isFile() || info.dev !== device || info.uid !== expectedUid || (info.mode & 0o077n) !== 0n || info.nlink !== 1n) throw new Error('managed payload: unsafe log file');
    }
    return handles;
  } catch (error) {
    await Promise.all(handles.map(handle => handle.close()));
    throw error;
  }
}

// Runs inside the completed service mount namespace, not in the launcher host
// namespace. A missing external mount must never expose a root-backed cwd.
export async function runGuardedPayload(args, { cwd = process.cwd(), admit = requireFinalJobStorage, launch = spawn,
  stat = path => statSync(path, { bigint: true }), fstat = fd => fstatSync(fd, { bigint: true }),
  owner = requireMappedHostRootUid, jobId, jobUnit, logs = openJobLogs } = {}) {
  if (!Array.isArray(args) || !args[0]?.startsWith('/') || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) {
    throw new Error('managed payload: invalid command');
  }
  const expectedUid = await owner();
  const policy = await admit(cwd, HOST_STORAGE_POLICY_PATH, undefined, expectedUid, jobId);
  const layout = deriveManagedJobLayout(policy.storageRoot, jobId);
  if (cwd !== layout.workspace) throw new Error('managed payload: cwd outside job layout');
  const device = stat(policy.storageRoot).dev;
  if (device === stat('/').dev) throw new Error('managed payload: external storage lost');
  if (jobUnit !== undefined) {
    const handles = await logs(layout.payloadLogs, jobUnit, device, undefined, expectedUid);
    try { return launch(args[0], args.slice(1), { cwd, stdio: ['ignore', ...handles.map(handle => handle.fd)] }); }
    // spawn duplicates the descriptors synchronously. Do not await close here:
    // the caller must attach child error listeners before the next I/O turn.
    finally { void Promise.all(handles.map(handle => handle.close())).catch(() => {}); }
  }
  for (const fd of [0, 1, 2]) {
    const metadata = fstat(fd);
    const nullInput = fd === 0 && metadata.isCharacterDevice?.() && metadata.rdev === 259n;
    if (metadata.isFile() ? metadata.dev !== device : !metadata.isFIFO() && !metadata.isSocket() && !nullInput) {
      throw new Error('managed payload: output outside external storage');
    }
  }
  return launch(args[0], args.slice(1), { cwd, stdio: 'inherit' });
}

async function main() {
  const args = process.argv.slice(2);
  const jobId = args[0] === '--job-id' ? args.splice(0, 2)[1] : undefined;
  const jobUnit = args[0] === '--job-unit' ? args.splice(0, 2)[1] : undefined;
  if (args.shift() !== '--') throw new Error('managed payload: invalid invocation');
  const child = await runGuardedPayload(args, { jobId, jobUnit });
  const handlers = new Map(['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => [signal, () => child.kill(signal)]));
  const cleanup = () => { for (const [signal, handler] of handlers) process.removeListener(signal, handler); };
  for (const [signal, handler] of handlers) process.on(signal, handler);
  child.once('error', () => { cleanup(); process.exitCode = 70; });
  child.once('exit', (code, signal) => {
    cleanup();
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 70;
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(() => {
  process.stderr.write('managed payload: storage admission or launch failed\n');
  process.exitCode = 70;
});
