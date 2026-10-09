#!/usr/bin/node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fstatSync, constants, writeSync } from 'node:fs';
import { mkdir, lstat, open } from 'node:fs/promises';
import { requireFinalJobStorage, MINIMUM_FREE_BYTES, MINIMUM_FREE_INODES } from '../host-jobs/storage-policy.mjs';
import { prepareScratchPressureGuard, ScratchPressureError } from './storage-pressure-guard.mjs';

export const PAYLOAD_GUARD_PATH = '/opt/subscription-runtime/managed-launcher/payload-guard.mjs';
const pressureGuards = new WeakMap();

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
  fstat = fd => fstatSync(fd, { bigint: true }),
  owner = async () => BigInt(process.geteuid()), jobId, jobUnit, logs = openJobLogs,
  pressure = prepareScratchPressureGuard, forceExit = () => process.exit(70) } = {}) {
  if (!Array.isArray(args) || !args[0]?.startsWith('/') || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) {
    throw new Error('managed payload: invalid command');
  }
  const expectedUid = await owner();
  const { layout, device } = await admit({ cwd, jobId });
  let handles = [];
  let stdio = 'inherit';
  if (jobUnit !== undefined) {
    handles = await logs(layout.payloadLogs, jobUnit, device, undefined, expectedUid);
    stdio = ['ignore', ...handles.map(handle => handle.fd)];
  } else {
  // These are the only inherited descriptors: spawn closes every other FD.
  // Bound the check to actual payload inheritance, never scan the job tree.
  for (const fd of [0, 1, 2]) {
    const metadata = fstat(fd);
    const nullInput = fd === 0 && metadata.isCharacterDevice?.() && metadata.rdev === 259n;
    if (metadata.isFile() ? metadata.dev !== device : !metadata.isFIFO() && !metadata.isSocket() && !nullInput) {
      throw new Error('managed payload: output outside external storage');
    }
  }
  }
  // Keep the validated job stderr descriptor for a finite, sanitized pressure
  // reason. The outer job service intentionally discards its own stderr.
  const report = reason => writeSync(handles[1]?.fd ?? 2, `managed payload: ${reason}\n`);
  const closeLogs = () => { void Promise.all(handles.map(handle => handle.close())).catch(() => {}); };
  let guard;
  try {
    guard = await pressure({ directory: layout.jobRoot, device, uid: expectedUid,
      minimumBytes: MINIMUM_FREE_BYTES, minimumInodes: MINIMUM_FREE_INODES, report, forceExit });
    const child = launch(args[0], args.slice(1), { cwd, stdio });
    guard.attach(child); pressureGuards.set(child, guard);
    child.once('exit', closeLogs); child.once('error', closeLogs);
    return child;
  } catch (error) {
    if (error instanceof ScratchPressureError) { try { report(error.reason); } catch { /* Full filesystem. */ } }
    guard?.close(); closeLogs(); throw error;
  }
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
    if (pressureGuards.get(child)?.reason) process.exit(70);
    else if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 70;
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(() => {
  process.stderr.write('managed payload: storage admission or launch failed\n');
  process.exitCode = 70;
});
