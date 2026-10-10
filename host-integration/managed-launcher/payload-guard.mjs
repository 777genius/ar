#!/usr/bin/node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fstatSync, constants, closeSync, writeSync, fsyncSync, readSync, ftruncateSync } from 'node:fs';
import { mkdir, lstat, open, readlink } from 'node:fs/promises';
import { requireFinalJobStorage, requireAcquiredStoragePin } from '../host-jobs/storage-policy.mjs';
import { managedBootstrap } from './launch.mjs';

export const PAYLOAD_GUARD_PATH = '/opt/subscription-runtime/managed-launcher/payload-guard.mjs';
/** Namespace authority is a string identity, never a Buffer/encoding operation.
 * @param {string} path
 */
async function namespaceIdentity(path) { return readlink(path); }

export async function awaitStorageActivation(fd, acquisition, {
  metadata = descriptor => fstatSync(descriptor, { bigint: true }),
  read = (descriptor, bytes) => readSync(descriptor, bytes, 0, bytes.length, 0),
  pause = () => new Promise(resolve => setTimeout(resolve, 250)) } = {}) {
  const bytes = Buffer.alloc(65537);
  for (;;) {
    const before = metadata(fd);
    if (!before.isFile() || before.uid !== 0n || before.nlink !== 1n || (before.mode & 0o077n) || before.size > 65536n) {
      throw new Error('managed payload: activation denied');
    }
    const count = read(fd, bytes), after = metadata(fd);
    if (count > 65536 || after.dev !== before.dev || after.ino !== before.ino) throw new Error('managed payload: activation denied');
    // A partially written receipt is not a decision. Only the complete newline
    // terminated record can cross the first-writer activation barrier.
    if (count && bytes[count - 1] === 10 && after.size === BigInt(count)) {
      const decision = JSON.parse(bytes.subarray(0, count).toString('utf8'));
      if (!decision || Object.keys(decision).sort().join(',') !== 'acquisition,action,generation,invocationId,schemaVersion' ||
          decision.schemaVersion !== 1 || decision.action !== 'activate' ||
          decision.invocationId !== acquisition.invocationId || decision.generation !== acquisition.generation ||
          JSON.stringify(decision.acquisition) !== JSON.stringify(acquisition)) throw new Error('managed payload: activation denied');
      return;
    }
    await pause();
  }
}

/** Privileged, installed bootstrap only. It consumes named native descriptors,
 * not caller pathname/boolean authority, before entering the existing sandbox.
 */
export async function acquireStoragePin(frame, { mount = spawn, verify = requireAcquiredStoragePin,
  metadata = fd => fstatSync(fd, { bigint: true }), namespace = namespaceIdentity, env = process.env,
  uid = () => process.geteuid(), pid = process.pid, close = closeSync,
  activate = awaitStorageActivation,
  enterWorkspace = root => process.chdir(`${root}/workspace`),
  publish = (fd, bytes) => { ftruncateSync(fd, 0); let offset = 0; while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset, offset); fsyncSync(fd); } } = {}) {
  const deny = () => { throw new Error('managed payload: native storage acquisition denied'); };
  if (!frame || Object.keys(frame).sort().join(',') !== 'fingerprint,generation,invocationId,schemaVersion,unit,witness' ||
      frame.schemaVersion !== 1 || !/^[a-f0-9-]{36}$/.test(frame.invocationId) || !/^[a-f0-9]{64}$/.test(frame.fingerprint) ||
      frame.generation !== `${env.SUBSCRIPTION_RUNTIME_JOB_ID}:${frame.invocationId}` ||
      !/^subscription-job-[a-f0-9]{64}\.service$/.test(frame.unit) || frame.witness?.jobRoot !== env.SUBSCRIPTION_RUNTIME_JOB_ROOT ||
      uid() !== 0 || env.LISTEN_PID !== String(pid) || env.LISTEN_FDS !== '3' || !/^[a-f0-9]{32}$/.test(env.INVOCATION_ID)) deny();
  const names = (env.LISTEN_FDNAMES ?? '').split(':');
  if (names.length !== 3 || new Set(names).size !== 3 || !names.includes('storage-pin') || !names.includes('storage-acquisition') || !names.includes('storage-activation')) deny();
  const source = 3 + names.indexOf('storage-pin'), receipt = 3 + names.indexOf('storage-acquisition'), activation = 3 + names.indexOf('storage-activation');
  // A payload-created user namespace cannot invoke the privileged acquisition mode.
  if (await namespace('/proc/self/ns/user') !== await namespace('/proc/1/ns/user')) deny();
  const identity = metadata(source), acknowledgement = metadata(receipt), permission = metadata(activation);
  if (!identity.isDirectory() || identity.dev.toString() !== frame.witness.device || identity.ino.toString() !== frame.witness.inode ||
      !acknowledgement.isFile() || acknowledgement.uid !== 0n || acknowledgement.nlink !== 1n ||
      (acknowledgement.mode & 0o077n) || acknowledgement.size !== 0n ||
      !permission.isFile() || permission.uid !== 0n || permission.nlink !== 1n || (permission.mode & 0o077n) || permission.size !== 0n) deny();
  const ownership = { schemaVersion: 1, invocationId: frame.invocationId, generation: frame.generation,
    unit: frame.unit, fingerprint: frame.fingerprint, systemdInvocationId: env.INVOCATION_ID,
    pid, namespace: await namespace('/proc/self/ns/mnt'), witness: frame.witness };
  if (!/^mnt:\[[0-9]+\]$/.test(ownership.namespace)) deny();
  // Issued FDs bind this bootstrap's systemd identity before mount acquisition.
  // Cancellation can address its exact cgroup even if the bind then fails.
  publish(receipt, Buffer.from(JSON.stringify({ ...ownership, stage: 'bootstrap' }) + '\n'));
  const run = args => new Promise((resolve, reject) => {
    let child;
    try { child = mount('/usr/bin/mount', args, { stdio: ['ignore', 'ignore', 'ignore', source] }); }
    catch (error) { reject(error); return; }
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 && !signal ? resolve() : reject(new Error('managed payload: native bind failed')));
  });
  // The child sees the retained directory as FD3. -c prevents libmount from
  // replacing that magic-link source with its mutable original pathname.
  await run(['--internal-only', '--no-mtab', '--no-canonicalize', '--bind', '/proc/self/fd/3', frame.witness.jobRoot]);
  await run(['--internal-only', '--no-mtab', '--no-canonicalize', '--make-private', frame.witness.jobRoot]);
  const pin = await verify(frame.witness);
  const after = metadata(source);
  if (after.dev !== identity.dev || after.ino !== identity.ino) deny();
  // systemd's earlier chdir may refer to a covered lower directory. Re-enter
  // through the actual newly acquired bind before any application can execute.
  enterWorkspace(frame.witness.jobRoot);
  const witness = { ...ownership, namespace: await namespace('/proc/self/ns/mnt'), pin };
  if (!/^mnt:\[[0-9]+\]$/.test(witness.namespace)) deny();
  publish(receipt, Buffer.from(JSON.stringify(witness) + '\n'));
  await activate(activation, witness);
  // Activation may have waited across a read-only transition or physical change.
  // Revalidate this actual private bind immediately before exposing any payload.
  await verify(frame.witness);
  // No pin/authority descriptors reach the untrusted provider. The actual bind
  // belongs to this private kernel namespace and its owned descendants.
  close(source); close(receipt); close(activation);
  for (const key of ['LISTEN_FDS', 'LISTEN_PID', 'LISTEN_FDNAMES']) delete env[key];
  return witness;
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
  fstat = fd => fstatSync(fd, { bigint: true }),
  owner = async () => BigInt(process.geteuid()), jobId, jobUnit, logs = openJobLogs } = {}) {
  if (!Array.isArray(args) || !args[0]?.startsWith('/') || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) {
    throw new Error('managed payload: invalid command');
  }
  const expectedUid = await owner();
  const { layout, device } = await admit({ cwd, jobId });
  if (jobUnit !== undefined) {
    const handles = await logs(layout.payloadLogs, jobUnit, device, undefined, expectedUid);
    try { return launch(args[0], args.slice(1), { cwd, stdio: ['ignore', ...handles.map(handle => handle.fd)] }); }
    // spawn duplicates the descriptors synchronously. Do not await close here:
    // the caller must attach child error listeners before the next I/O turn.
    finally { void Promise.all(handles.map(handle => handle.close())).catch(() => {}); }
  }
  // These are the only inherited descriptors: spawn closes every other FD.
  // Bound the check to actual payload inheritance, never scan the job tree.
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
  if (args[0] === '--acquire-storage-pin') {
    const frame = JSON.parse(args.splice(0, 2)[1]);
    if (args.splice(0, 1)[0] !== '--node' || args.splice(0, 1)[0] !== process.execPath) throw new Error('managed payload: invalid native bootstrap');
    if (args[0] !== '--job-id' || args[1] !== process.env.SUBSCRIPTION_RUNTIME_JOB_ID ||
        args[2] !== '--job-unit' || args[3] !== frame.unit) throw new Error('managed payload: native job binding mismatch');
    await acquireStoragePin(frame);
    const child = spawn(managedBootstrap[0], [...managedBootstrap.slice(1), process.execPath, fileURLToPath(import.meta.url), ...args], { stdio: 'inherit' });
    supervise(child); return;
  }
  const jobId = args[0] === '--job-id' ? args.splice(0, 2)[1] : undefined;
  const jobUnit = args[0] === '--job-unit' ? args.splice(0, 2)[1] : undefined;
  if (args.shift() !== '--') throw new Error('managed payload: invalid invocation');
  const child = await runGuardedPayload(args, { jobId, jobUnit });
  supervise(child);
}
function supervise(child) {
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
