/** Hosted source gates only. Real mount/FD acquisition requires NEW native TEST. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import type { spawn } from 'node:child_process';
import { acquireStoragePin, awaitStorageActivation } from './payload-guard.mjs';
import { parseNativeUnitProperties } from './launch.mjs';
import { requireAcquiredStoragePin, captureManagedStoragePin, prepareManagedJobLayout } from '../host-jobs/storage-policy.mjs';
import { fingerprint, unitFor, validateStart } from '../host-jobs/contract.mjs';

const jobId = 'test-native-pin';
const invocationId = 'ea784b0d-1a3c-41cb-a7c7-494d67d67a37';
const witness = { device: '257', inode: '123', filesystemRoot: '/jobs/test-native-pin',
  blockSource: '/dev/nvme2n1p1', filesystemUuid: 'd0f2cac1-2009-4e9d-a710-e156f417938f',
  mountDevice: '1:1', capabilitySha256: 'a'.repeat(64), jobRoot: '/volume/jobs/test-native-pin' };
const frame = { schemaVersion: 1, invocationId, generation: `${jobId}:${invocationId}`,
  unit: unitFor(jobId), fingerprint: 'b'.repeat(64), witness };
const environment = (): NodeJS.ProcessEnv => ({ LISTEN_PID: '700', LISTEN_FDS: '3',
  LISTEN_FDNAMES: 'storage-pin:storage-acquisition:storage-activation', INVOCATION_ID: 'c'.repeat(32),
  SUBSCRIPTION_RUNTIME_JOB_ID: jobId, SUBSCRIPTION_RUNTIME_JOB_ROOT: witness.jobRoot });
const metadata = (directory: boolean, device = 257n, inode = 123n): BigIntStats => ({
  uid: 0n, gid: 0n, mode: directory ? 0o700n : 0o600n, dev: device, ino: inode,
  size: 0n, nlink: 1n, isDirectory: () => directory, isFile: () => !directory,
  isSymbolicLink: () => false,
} as unknown as BigIntStats);

test('native manager evidence requires complete unique fields while explicit empty Job means no queued job', () => {
  const fields = ['LoadState', 'ActiveState', 'SubState', 'ControlGroup', 'Description', 'InvocationID', 'MainPID', 'Job', 'Slice'];
  const response = `LoadState=loaded\nActiveState=active\nSubState=running\nControlGroup=/owned\nDescription=owned\nInvocationID=${'c'.repeat(32)}\nMainPID=700\nJob=\nSlice=subscription-runtime-hosted.slice\n`;
  assert.equal(parseNativeUnitProperties(response, fields).Job, '');
  for (const invalid of [response.replace('Job=\n', ''), response + 'Job=1\n', response + 'Foreign=1\n', response.replace('MainPID=700', 'MainPID')]) {
    assert.throws(() => parseNativeUnitProperties(invalid, fields), /unsupported invocation/);
  }
});
function acquisition(fault?: 'bind' | 'verify') {
  const events: string[] = [], env = environment();
  const mount = (() => {
    events.push('mount');
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('exit', fault === 'bind' ? 32 : 0, null));
    return child;
  }) as unknown as typeof spawn;
  return { events, env, options: { mount, pid: 700, uid: () => 0, env,
    metadata: (fd: number) => metadata(fd === 3),
    namespace: async (path: string) => path.endsWith('/mnt') ? 'mnt:[11]' : 'user:[1]',
    verify: async () => { events.push('verify'); if (fault === 'verify') throw new Error('wrong pin'); return { device: '257', inode: '123', mountId: '9' }; },
    enterWorkspace: () => { events.push('enter-workspace'); },
    publish: (_fd: number, bytes: Buffer) => { const receipt = JSON.parse(bytes.toString()); events.push(`publish:${receipt.stage ?? 'acquired'}`); assert.equal(receipt.generation, frame.generation); },
    activate: async () => { events.push('activate'); },
    close: (fd: number) => { events.push(`close:${fd}`); },
  } };
}

test('real acquisition boundary publishes only after bind and independent physical guard, then closes inherited authority', async () => {
  const value = acquisition();
  const result = await acquireStoragePin(frame, value.options);
  assert.deepEqual(value.events, ['publish:bootstrap', 'mount', 'mount', 'verify', 'enter-workspace', 'publish:acquired', 'activate', 'verify', 'close:3', 'close:4', 'close:5']);
  assert.equal(result.systemdInvocationId, 'c'.repeat(32));
  assert.equal(result.namespace, 'mnt:[11]');
  assert.equal(value.env.LISTEN_FDS, undefined);
});

test('mount and final identity failures cannot activate, publish physical acquisition or release descriptors', async () => {
  for (const fault of ['bind', 'verify'] as const) {
    const value = acquisition(fault);
    await assert.rejects(acquireStoragePin(frame, value.options));
    assert.equal(value.events.includes('publish:acquired'), false);
    assert.equal(value.events.includes('activate'), false);
    assert.equal(value.events.some(event => event.startsWith('close:')), false);
    assert.equal(value.events.includes('enter-workspace'), false);
  }
});

test('acquisition waits at the first-writer activation barrier and rejects a stale invocation decision', async () => {
  const value = acquisition();
  let acknowledge: (() => void) | undefined;
  const pending = acquireStoragePin(frame, { ...value.options, activate: async () => {
    value.events.push('activate-pending'); await new Promise<void>(resolve => { acknowledge = resolve; });
  } });
  // Reach the barrier by its explicit protocol event, not elapsed wall time.
  while (!acknowledge) await new Promise<void>(resolve => queueMicrotask(resolve));
  assert.equal(value.events.includes('publish:acquired'), true);
  assert.equal(value.events.some(event => event.startsWith('close:')), false);
  acknowledge(); await pending;
  const acquired = { invocationId, generation: frame.generation, systemdInvocationId: 'c'.repeat(32), namespace: 'mnt:[11]' };
  for (const receipt of [{ ...acquired, systemdInvocationId: 'e'.repeat(32) }, { ...acquired, namespace: 'mnt:[12]' }]) {
    const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, invocationId, generation: frame.generation,
      action: 'activate', acquisition: receipt }) + '\n');
    await assert.rejects(awaitStorageActivation(5, acquired, {
      metadata: () => ({ ...metadata(false), size: BigInt(bytes.length) } as BigIntStats),
      read: (_fd: number, target: Buffer) => { bytes.copy(target); return bytes.length; },
      pause: async () => { throw new Error('unexpected wait'); },
    }), /activation denied/);
  }
});

test('revocation and a physical change during activation cannot release authority to a payload', async () => {
  const revoked = acquisition();
  await assert.rejects(acquireStoragePin(frame, { ...revoked.options, activate: async () => { throw new Error('revoked'); } }), /revoked/);
  assert.equal(revoked.events.some(event => event.startsWith('close:')), false);
  const changed = acquisition(); let observations = 0;
  await assert.rejects(acquireStoragePin(frame, { ...changed.options, verify: async () => {
    if (++observations === 2) throw new Error('became readonly');
    return { device: '257', inode: '123', mountId: '9' };
  } }), /became readonly/);
  assert.equal(changed.events.includes('activate'), true);
  assert.equal(changed.events.some(event => event.startsWith('close:')), false);
});

test('unexpected extra, absent or duplicate named descriptors cannot reach a mount or acknowledgement', async () => {
  for (const change of [{ LISTEN_FDS: '4' }, { LISTEN_PID: '701' }, { LISTEN_FDNAMES: 'storage-pin:storage-pin' },
    { LISTEN_FDNAMES: 'storage-pin:foreign' }, { LISTEN_FDNAMES: '' }, { INVOCATION_ID: '' }]) {
    const value = acquisition(); Object.assign(value.env, change);
    await assert.rejects(acquireStoragePin(frame, value.options), /acquisition denied/);
    assert.deepEqual(value.events, []);
  }
});

test('wrong physical source and closed source fail before bind; namespace root is not caller authority', async () => {
  for (const metadataFault of [(fd: number) => metadata(fd === 3, fd === 3 ? 1n : 257n),
    (_fd: number): BigIntStats => { throw new Error('EBADF'); }]) {
    const value = acquisition();
    await assert.rejects(acquireStoragePin(frame, { ...value.options, metadata: metadataFault }));
    assert.deepEqual(value.events, []);
  }
  const value = acquisition();
  await assert.rejects(acquireStoragePin(frame, { ...value.options,
    namespace: async (path: string) => path.includes('/1/') ? 'user:[1]' : 'user:[2]' }));
  assert.deepEqual(value.events, []);
});

const originalMounts = '1 0 0:1 / / ro - ext4 root rw\n2 1 1:1 / /volume ro - ext4 /dev/nvme2n1p1 rw\n';
function finalProbe(extra: string, device = 257n, inode = 123n) {
  return { lstat: async (_path: string) => metadata(true, device, inode),
    stat: async (path: string) => metadata(true, path === '/' ? 1n : device, inode),
    statfs: async () => { throw new Error('capacity is not a final identity witness'); },
    realpath: async (path: string) => path,
    readStorageRoot: async () => { throw new Error('policy cannot be reloaded'); },
    readMountInfo: async () => originalMounts + extra };
}
const privateBind = '9 2 1:1 /jobs/test-native-pin /volume/jobs/test-native-pin rw - ext4 /dev/nvme2n1p1 rw\n';
const anchor = { openDirectory: async () => ({ fd: 20, stat: async () => metadata(true), close: async () => {} } as unknown as FileHandle),
  readMountId: async () => '9' };
test('final guard selects actual opened mount ID through covered rows, preserving full table vetoes', async () => {
  const covered = '8 2 0:1 /fake /volume/jobs/test-native-pin rw - ext4 root rw\n';
  const result = await requireAcquiredStoragePin(witness, finalProbe(covered + privateBind), anchor);
  assert.equal(result.mountId, '9');
  for (const row of [privateBind.replace(' rw -', ' ro -'), privateBind.replace('/jobs/test-native-pin ', '/other '),
    privateBind.replace(' rw -', ' rw shared:7 -'), privateBind.replace('/dev/nvme2n1p1 ', '/dev/foreign '),
    privateBind + '10 9 1:1 /alias /volume/jobs/test-native-pin/workspace rw - ext4 /dev/nvme2n1p1 rw\n',
    privateBind + privateBind, privateBind.replace('/dev/nvme2n1p1 rw', '/dev/nvme2n1p1 ro')]) {
    await assert.rejects(requireAcquiredStoragePin(witness, finalProbe(row), anchor), /storage admission/);
  }
  await assert.rejects(requireAcquiredStoragePin(witness, finalProbe(privateBind, 1n), anchor), /identity mismatch/);
  await assert.rejects(requireAcquiredStoragePin(witness, finalProbe(privateBind, 257n, 124n), anchor), /identity mismatch/);
});

function retainedDirectories(extra = '') {
  const handles = new Map<number, string>(), closed: number[] = [], created: string[] = [];
  let descriptor = 30;
  const stat = (path: string): BigIntStats => path === '/etc/policy' ? metadata(false, 1n) :
    metadata(true, path.startsWith('/volume') ? 257n : 1n);
  const visible = (path: string): string => path.replace(/^\/proc\/self\/fd\/(\d+)/,
    (_match, fd: string) => handles.get(Number(fd))!);
  const options = { configPath: '/etc/policy',
    probe: { ...finalProbe(''), stat: async (path: string) => stat(path), lstat: async (path: string) => stat(path),
      statfs: async () => ({ bavail: 5368709120n, bsize: 1n, ffree: 50000n }), readStorageRoot: async () => '/volume\n',
      readMountInfo: async () => '1 0 0:1 / / rw - ext4 root rw\n2 1 1:1 / /volume rw - ext4 /dev/nvme2n1p1 rw\n' + extra },
    openDirectory: async (path: string) => {
      const fd = descriptor++, selected = visible(path); handles.set(fd, selected);
      return { fd, stat: async () => stat(selected), close: async () => { closed.push(fd); } } as unknown as FileHandle;
    }, create: async (path: string) => { assert.match(path, /^\/proc\/self\/fd\//); created.push(visible(path)); },
    fdMountId: async () => '2',
  };
  const capability = { storageRoot: '/volume', filesystemRoot: '/', blockSource: '/dev/nvme2n1p1',
    filesystemUuid: witness.filesystemUuid, capabilitySha256: witness.capabilitySha256 };
  return { options, capability, closed, created, handles };
}
test('native issuer retains actual directory handles until explicit handoff; legacy preparation closes them', async () => {
  const value = retainedDirectories();
  const pin = await captureManagedStoragePin(jobId, value.capability, value.options);
  assert.equal(value.closed.length, 0);
  assert.equal(value.handles.get(pin.handle.fd), witness.jobRoot);
  assert.equal(pin.witness.inode, '123');
  assert.equal(pin.witness.filesystemRoot, witness.filesystemRoot);
  await pin.close();
  assert.equal(value.closed.length, value.handles.size);
  const legacy = retainedDirectories();
  await prepareManagedJobLayout(jobId, legacy.options);
  assert.equal(legacy.closed.length, legacy.handles.size);
});
test('an alias to the same inode backing is unsupported and releases every pre-submission anchor', async () => {
  const value = retainedDirectories('10 2 1:1 /jobs/test-native-pin /alias rw - ext4 /dev/nvme2n1p1 rw\n');
  await assert.rejects(captureManagedStoragePin(jobId, value.capability, value.options), /alias or nested mount/);
  assert.equal(value.closed.length, value.handles.size);
  assert.equal(value.handles.size > 1, true);
});

test('caller intent participates in immutable request identity and never supplies a qualification', () => {
  const request = { operation: 'start', jobId, machineId: 'd'.repeat(32), argv: ['/usr/bin/true'],
    runtimeSeconds: 60, stopSeconds: 5, memoryMiB: 128, tasksMax: 16, cpuPercent: 50 };
  const intent = { ...request, storageLifetime: 'fd-openfile-bind-v1' };
  validateStart(request); validateStart(intent);
  assert.notEqual(fingerprint(request), fingerprint(intent));
  assert.throws(() => validateStart({ ...intent, qualified: true }), /unsupported start field/);
  assert.throws(() => validateStart({ ...request, storageLifetime: 'caller-pin' }), /unsupported storage lifetime/);
});
