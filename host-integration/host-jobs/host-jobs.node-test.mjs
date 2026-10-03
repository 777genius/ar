import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, unlink, rmdir, stat, rm, realpath, readlink, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostJobs, systemCommand } from './manager.mjs';
import { hostTransport, sshOutput } from '../../scripts/ops/host-job-transport.mjs';
import { hostJobCli } from '../../scripts/ops/host-job-cli.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hostLock } from '../../scripts/ops/host-job-lock.mjs';
import { requireHostStorage, loadManagedStorageRoot } from './storage-policy.mjs';
import { readRequest } from './read-request.mjs';
import { PassThrough, Readable } from 'node:stream';

test('request ingress rejects missing EOF by deadline and retains byte bounds', async () => {
  const idle = new PassThrough();
  idle.write('{"operation":"status"}');
  await assert.rejects(readRequest(idle, { timeoutMs: 15 }), /deadline exceeded/);
  assert.equal(idle.destroyed, true);
  await assert.rejects(readRequest(Readable.from([Buffer.alloc(65537)]), { timeoutMs: 1000 }), /too large/);
  assert.deepEqual(await readRequest(Readable.from(['{"operation":"status"}']), { timeoutMs: 1000 }), { operation: 'status' });
});

test('system command defaults the user runtime directory and preserves inherited environment', async t => {
  const previous = process.env.XDG_RUNTIME_DIR;
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = previous;
  });
  delete process.env.XDG_RUNTIME_DIR;
  t.mock.method(process, 'getuid', () => 0);
  const inherited = { ...process.env };
  const output = await systemCommand('/usr/bin/systemctl', ['--user', 'show', 'test.service'], async (cmd, args, options) => {
    assert.equal(cmd, '/usr/bin/systemctl');
    assert.deepEqual(args, ['--user', 'show', 'test.service']);
    assert.deepEqual(options, { timeout: 15000, maxBuffer: 1048576, env: { ...inherited, XDG_RUNTIME_DIR: '/run/user/0' } });
    return { stdout: 'LoadState=not-found' };
  });
  assert.equal(output, 'LoadState=not-found');
  assert.equal(process.env.XDG_RUNTIME_DIR, undefined);
  for (const explicit of ['/run/user/1234', '']) {
    process.env.XDG_RUNTIME_DIR = explicit;
    await systemCommand('/usr/bin/systemctl', ['--user', 'show'], async (_cmd, _args, options) => {
      assert.equal(options.env.XDG_RUNTIME_DIR, explicit);
      return { stdout: '' };
    });
  }
});

test('system command retains inherited environment when getuid is unavailable', async t => {
  const getuid = process.getuid;
  const previous = process.env.XDG_RUNTIME_DIR;
  t.after(() => {
    process.getuid = getuid;
    if (previous === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = previous;
  });
  process.getuid = undefined;
  delete process.env.XDG_RUNTIME_DIR;
  await systemCommand('/usr/bin/systemctl', ['--user', 'show'], async (_cmd, _args, options) => {
    assert.deepEqual(options.env, { ...process.env });
    assert.equal(Object.hasOwn(options.env, 'XDG_RUNTIME_DIR'), false);
    return { stdout: '' };
  });
});

test('system command never swallows unavailable user or system bus errors', async () => {
  for (const scope of [[], ['--user']]) {
    for (const stderr of ['Failed to connect to bus: No medium found\n', 'Failed to connect to bus: Permission denied\n']) {
      const failure = Object.assign(new Error(stderr), { code: 1, stdout: '', stderr });
      await assert.rejects(systemCommand('/usr/bin/systemctl', [...scope, 'show', 'test.service'], async () => { throw failure; }), error => error === failure);
      const { manager, calls } = await fixture();
      const run = manager.run;
      manager.run = async (cmd, args) => {
        if (args.includes('--user') === scope.includes('--user')) throw failure;
        return run(cmd, args);
      };
      await assert.rejects(manager.start(request), error => error === failure);
      assert.equal(await manager.read(request.jobId), null);
      assert.equal(calls.filter(isLaunch).length, 0);
    }
  }
});

function fakeStorage(overrides = {}) {
  const calls = [];
  const policy = { storageRoot: '/volume' };
  const metadata = path => ({ dev: path === '/volume' || path.startsWith('/volume/') ? 2n : 1n,
    ino: 10n, uid: 0n, mode: 0o100644n, isFile: () => path === '/policy.json', isDirectory: () => path !== '/policy.json', isSymbolicLink: () => false });
  const probe = {
    lstat: async path => { calls.push(['lstat', path]); return metadata(path); },
    stat: async path => { calls.push(['stat', path]); return metadata(path); },
    realpath: async path => path,
    readStorageRoot: async () => `${policy.storageRoot}\n`,
    readMountInfo: async () => '1 0 0:1 / / rw - ext4 root rw\n2 1 0:2 / /volume rw - ext4 volume rw\n',
    statfs: async path => { calls.push(['statfs', path]); return { bavail: 1310720n, bsize: 4096n, ffree: 50000n }; },
    ...overrides,
  };
  return { probe, calls, policy, metadata };
}

test('policy ancestors must stay root-owned, protected and unchanged through admission', async () => {
  const configPath = '/etc/runtime/policy.json';
  for (const ancestor of ['/', '/etc', '/etc/runtime']) {
    for (const change of [{ uid: 1000n }, { mode: 0o40777n }, { mode: 0o40770n }]) {
      for (const race of [false, true]) {
        const { probe, metadata } = fakeStorage();
        let changed = !race;
        probe.lstat = async path => ({ ...metadata(path === configPath ? '/policy.json' : path), ...(changed && path === ancestor ? change : {}) });
        const readStorageRoot = probe.readStorageRoot;
        probe.readStorageRoot = async () => { changed = true; return readStorageRoot(); };
        await assert.rejects(loadManagedStorageRoot(configPath, probe), /untrusted config parent/);
      }
    }
    const { probe, metadata } = fakeStorage();
    let changed = false;
    probe.lstat = async path => ({ ...metadata(path === configPath ? '/policy.json' : path), ...(changed && path === ancestor ? { ino: 11n } : {}) });
    const readMountInfo = probe.readMountInfo;
    probe.readMountInfo = async () => { changed = true; return readMountInfo(); };
    await assert.rejects(loadManagedStorageRoot(configPath, probe), /config parent changed/);
  }
});

test('storage root must remain root-owned and protected, but job children may be user-owned', async () => {
  for (const [uid, mode, allowed] of [[0n, 0o40700n, true], [0n, 0o40750n, true], [1000n, 0o40700n, false], [0n, 0o40770n, false], [0n, 0o40702n, false]]) {
    const { probe, metadata } = fakeStorage();
    probe.stat = async path => ({ ...metadata(path), ...(path === '/volume' ? { uid, mode } : path.startsWith('/volume/') ? { uid: 1000n, mode: 0o40770n } : {}) });
    const admission = requireHostStorage('/volume/job/workspace', '/policy.json', probe);
    if (allowed) await admission;
    else await assert.rejects(admission, /untrusted storage root/);
  }
  const { probe, metadata } = fakeStorage();
  const capacity = probe.statfs;
  probe.statfs = async path => {
    probe.stat = async candidate => ({ ...metadata(candidate), ...(candidate === '/volume' ? { mode: 0o40777n } : {}) });
    return capacity(path);
  };
  await assert.rejects(loadManagedStorageRoot('/policy.json', probe), /untrusted storage root/);
});

test('final namespace may require the exact mapped host-root owner', async () => {
  const { probe, metadata } = fakeStorage();
  probe.lstat = async path => ({ ...metadata(path), uid: 65532n });
  probe.stat = async path => ({ ...metadata(path), uid: 65532n });
  probe.readStorageRoot = async (_path, expectedUid) => {
    assert.equal(expectedUid, 65532n);
    return '/volume\n';
  };
  await requireHostStorage('/volume/job/workspace', '/policy.json', probe, 65532n);
  await assert.rejects(requireHostStorage('/volume/job/workspace', '/policy.json', probe), /untrusted config/);
});

test('mount table rejects foreign nested binds below the admitted job and ignores unrelated jobs', async () => {
  const { probe } = fakeStorage();
  const base = await probe.readMountInfo();
  for (const [suffix, denied] of [
    ['', false],
    ['3 2 0:2 /other /volume/job/workspace/cache rw - ext4 volume rw\n', false],
    ['3 2 0:1 /root /volume/job/workspace/cache rw - ext4 root rw\n', true],
    ['3 2 0:3 / /volume/other rw - ext4 other rw\n', false],
    ['3 2 0:1 /root /volume/job/workspace/cache\\040files rw - ext4 root rw\n', true],
    ['3 2 0:1 /root /volume/job/workspace/cache\\134name rw - ext4 root rw\n', true],
    ['3 1 0:1 /root /volume-other rw - ext4 root rw\n', false],
  ]) {
    probe.readMountInfo = async () => base + suffix;
    const admission = requireHostStorage('/volume/job/workspace', '/policy.json', probe);
    if (denied) await assert.rejects(admission, /nested filesystem forbidden/);
    else await admission;
  }
  for (const invalid of ['', 'invalid', 'x'.repeat(1024 * 1024 + 1)]) {
    probe.readMountInfo = async () => invalid;
    await assert.rejects(loadManagedStorageRoot('/policy.json', probe), /invalid mount table/);
  }
});

test('trusted policy export returns frozen configuration only after root admission', async () => {
  const { probe, policy, calls } = fakeStorage();
  const loaded = await loadManagedStorageRoot('/policy.json', probe);
  assert.deepEqual(loaded, policy);
  assert.equal(Object.isFrozen(loaded), true);
  assert.deepEqual(calls.filter(([name]) => name === 'statfs'), [['statfs', '/volume']]);
  probe.statfs = async () => ({ bavail: 0n, bsize: 4096n, ffree: 50000n });
  await assert.rejects(loadManagedStorageRoot('/policy.json', probe), /insufficient bytes/);
  probe.readStorageRoot = async () => '{';
  await assert.rejects(loadManagedStorageRoot('/policy.json', probe), /storage admission:/);
});

test('storage root config accepts only a single canonical absolute path', async () => {
  for (const text of ['{"storageRoot":"/volume"}', '/volume\n/other\n', '/volume ', '/volume\n\n', '/', '/volume/../other']) {
    const { probe } = fakeStorage();
    probe.readStorageRoot = async () => text;
    await assert.rejects(loadManagedStorageRoot('/policy.json', probe), /invalid storage root config/);
  }
});

test('storage ancestors must retain trusted ownership and identity', async () => {
  for (const change of [{ uid: 1000n }, { mode: 0o40777n }, { ino: 99n }]) {
    const { probe, metadata, policy } = fakeStorage();
    policy.storageRoot = '/volume/managed';
    let changed = false;
    probe.lstat = async path => ({ ...metadata(path), ...(changed && path === '/volume' ? change : {}) });
    const capacity = probe.statfs;
    probe.statfs = async path => { changed = true; return capacity(path); };
    await assert.rejects(loadManagedStorageRoot('/policy.json', probe), /untrusted config parent|config parent changed/);
  }
});

test('managed admission uses external cwd, exact bytes/inode thresholds and bounded bigint probes', async () => {
  const { probe, calls } = fakeStorage();
  await requireHostStorage('/volume/job/workspace', '/policy.json', probe);
  assert.equal(calls.filter(([name]) => name === 'statfs').length, 1);
  assert.ok(calls.length < 35);
  probe.statfs = async () => ({ bavail: 2n ** 60n, bsize: 4096n, ffree: 2n ** 60n });
  await requireHostStorage('/volume/job/workspace', '/policy.json', probe);
  for (const [capacity, message] of [
    [{ bavail: 5368709119n, bsize: 1n, ffree: 50000n }, /insufficient bytes/],
    [{ bavail: 5368709120n, bsize: 1n, ffree: 49999n }, /insufficient inodes/],
    [{ bavail: 1, bsize: 4096n, ffree: 50000n }, /invalid capacity/],
  ]) {
    probe.statfs = async () => capacity;
    await assert.rejects(requireHostStorage('/volume/job', '/policy.json', probe), message);
  }
});

test('managed admission rejects untrusted config, missing paths, symlinks and nested root mounts', async () => {
  for (const scenario of ['missing-policy', 'invalid-json', 'extra-key', 'oversize', 'policy-owner', 'policy-mode', 'policy-symlink', 'missing-root', 'root-backed', 'ancestor-symlink', 'nested-root', 'noncanonical', 'outside', 'cwd-missing', 'canonical-alias', 'swapped-job', 'replaced-inode']) {
    const { probe, metadata, policy } = fakeStorage();
    let cwd = '/volume/job/workspace';
    probe.lstat = async path => {
      if ((scenario === 'missing-policy' && path === '/policy.json') || (scenario === 'missing-root' && path === '/volume') || (scenario === 'cwd-missing' && path === cwd)) throw Object.assign(new Error('private path'), { code: 'ENOENT' });
      const value = metadata(path);
      if (path === '/policy.json') {
        if (scenario === 'policy-owner') value.uid = 1000n;
        if (scenario === 'policy-mode') value.mode = 0o100666n;
        if (scenario === 'policy-symlink') value.isSymbolicLink = () => true;
      }
      if (path === '/volume/job') {
        if (scenario === 'ancestor-symlink') value.isSymbolicLink = () => true;
        if (scenario === 'nested-root') value.dev = 1n;
      }
      return value;
    };
    if (scenario === 'root-backed') probe.stat = async path => ({ ...metadata(path), dev: 1n });
    if (scenario === 'invalid-json') probe.readStorageRoot = async () => '{';
    if (scenario === 'extra-key') probe.readStorageRoot = async () => '/volume\nother=true';
    if (scenario === 'oversize') probe.readStorageRoot = async () => ' '.repeat(16385);
    if (scenario === 'noncanonical') cwd = '/volume/job/../workspace';
    if (scenario === 'outside') cwd = '/elsewhere/workspace';
    if (scenario === 'canonical-alias') probe.realpath = async path => path === cwd ? '/volume/other' : path;
    if (scenario === 'swapped-job') probe.statfs = async () => {
      probe.lstat = async path => ({ ...metadata(path), isSymbolicLink: () => path === '/volume/job' });
      return { bavail: 5368709120n, bsize: 1n, ffree: 50000n };
    };
    if (scenario === 'replaced-inode') probe.statfs = async () => {
      probe.stat = async path => ({ ...metadata(path), ino: path === cwd ? 11n : 10n });
      return { bavail: 5368709120n, bsize: 1n, ffree: 50000n };
    };
    await assert.rejects(requireHostStorage(cwd, '/policy.json', probe), /storage admission:/, scenario);
  }
});

test('managed policy denial prevents launch and cannot prevent persisted reconciliation, status or stop', async () => {
  const { manager, calls } = await fixture({ denied: true });
  const managedRequest = { ...request };
  const first = await manager.start(managedRequest);
  assert.equal(first.phase, 'uncertain');
  assert.equal((await manager.start(managedRequest)).retry, true);
  await manager.status(request.jobId, request.machineId);
  await manager.stop(request.jobId, request.machineId);
  assert.equal((await manager.status(request.jobId, request.machineId)).unresolved, true);
  assert.equal(calls.filter(isLaunch).length, 1);
  assert.equal((await manager.read(request.jobId)).phase, 'uncertain');
});

const request = { operation: 'start', jobId: 'test-1', machineId: 'a'.repeat(32), argv: ['/bin/test', '$(touch nope)'], runtimeSeconds: 60, stopSeconds: 5, memoryMiB: 128, tasksMax: 16, cpuPercent: 50 };
const isLaunch = call => call.cmd === process.execPath && call.args[0] === '/opt/subscription-runtime/managed-launcher/launch.mjs';
test('system manager is persisted before launch and used for reconciliation and stop', async () => {
  let manager;
  const calls = [];
  let launched = false;
  ({ manager } = await fixture({ run: async (cmd, args) => {
    calls.push(args);
    if (isLaunch({ cmd, args })) {
      assert.equal((await manager.read(request.jobId)).manager, 'system');
      launched = true;
    }
    return launched ? `LoadState=loaded\nActiveState=active\nDescription=subscription-job:${(await manager.read(request.jobId)).fingerprint}` : 'LoadState=not-found';
  } }));
  await manager.start(request);
  await manager.stop(request.jobId, request.machineId);
  assert.equal(calls.filter(args => args.includes('--user')).length, 1);
  assert.ok(calls.some(args => args[0] === 'stop'));
});
test('collisions in either manager deny new launch', async () => {
  for (const scope of ['system', 'user']) {
    const { manager, calls } = await fixture({ run: async (cmd, args) => {
      assert.equal(cmd, '/usr/bin/systemctl');
      return (args.includes('--user') ? 'user' : 'system') === scope ? 'LoadState=loaded' : 'LoadState=not-found';
    } });
    await assert.rejects(manager.start(request), /unowned unit/);
    assert.equal(await manager.read(request.jobId), null);
    assert.equal(calls.filter(isLaunch).length, 0);
  }
});
test('invalid persisted manager fails closed and callers cannot select manager', async () => {
  const { manager, calls } = await fixture();
  await manager.start(request);
  const record = await manager.read(request.jobId);
  for (const value of [null, false, '', 'SYSTEM', '--user', [], {}]) {
    await manager.save({ ...record, manager: value });
    const count = calls.length;
    await assert.rejects(manager.status(request.jobId, request.machineId), /invalid persisted manager/);
    await assert.rejects(manager.stop(request.jobId, request.machineId), /invalid persisted manager/);
    await assert.rejects(manager.start(request), /invalid persisted manager/);
    assert.equal(calls.length, count);
  }
  await assert.rejects(manager.start({ ...request, manager: 'user' }), /unsupported start field/);
});
async function fixture(options = {}) {
  const calls = [];
  let state = 'LoadState=not-found';
  const manager = new HostJobs({ stateDir: await mkdtemp(join(tmpdir(), 'host-jobs-test-')), machineId: async () => request.machineId,
    run: async (cmd, args) => {
      calls.push({ cmd, args });
      if (isLaunch({ cmd, args })) {
        if (options.denied) throw new Error('storage admission denied');
        const launch = JSON.parse(args[2]);
        state = `LoadState=loaded\nActiveState=active\nDescription=subscription-job:${launch.fingerprint}`;
        if (options.uncertain) throw new Error('connection lost');
      }
      return state;
    }, ...options });
  return { manager, calls };
}
test('bounded service preserves argv, concurrent and uncertain starts execute once', async () => {
  const { manager, calls } = await fixture({ uncertain: true });
  const first = await manager.start(request);
  assert.equal(first.phase, 'uncertain');
  await Promise.all([manager.start(request), manager.start(request)]);
  const launches = calls.filter(isLaunch);
  assert.equal(launches.length, 1);
  assert.equal(calls.some(call => call.cmd === '/usr/bin/systemd-run'), false);
  assert.equal(launches[0].args[1], 'job');
  const launch = JSON.parse(launches[0].args[2]);
  assert.deepEqual(launch.payload, request.argv);
  assert.equal(launch.jobId, request.jobId);
  assert.equal(Object.hasOwn(launch, 'cwd'), false);
  assert.deepEqual(launch.limits, {
    runtimeSeconds: request.runtimeSeconds,
    stopSeconds: request.stopSeconds,
    memoryMiB: request.memoryMiB,
    tasksMax: request.tasksMax,
    cpuPercent: request.cpuPercent,
  });
  await assert.rejects(manager.start({ ...request, argv: ['/bin/other'] }), /already bound/);
  const reconciled = await manager.status(request.jobId, request.machineId);
  assert.equal(reconciled.live, true);
  assert.equal(reconciled.unresolved, false);
  assert.equal(reconciled.abandoned, false);
  await manager.stop(request.jobId, request.machineId);
  assert.ok(calls.some(x => x.args.includes('stop')));
});
test('new starts delegate layout exclusively to launcher and persist only bounded lifecycle metadata', async () => {
  const { manager, calls } = await fixture({
    prepareLayout: async () => { assert.fail('host manager must not prepare payload layout'); },
    storageProbe: { lstat: async () => { assert.fail('host manager must not admit storage'); } },
  });
  await manager.start(request);
  assert.equal(calls.filter(isLaunch).length, 1);
  const record = await manager.read(request.jobId);
  assert.deepEqual(Object.keys(record).sort(), ['createdAt', 'fingerprint', 'jobId', 'machineId', 'manager', 'phase', 'unit']);
  assert.ok(Buffer.byteLength(JSON.stringify(record)) < 1024);
});
test('admission and unknown ownership fail closed', async () => {
  const { manager, calls } = await fixture({ denied: true });
  const result = await manager.start(request);
  assert.equal(result.phase, 'uncertain');
  assert.equal(result.state.LoadState, 'not-found');
  await assert.rejects(manager.stop('unknown', request.machineId), /unknown job/);
  await assert.rejects(manager.stop('unknown', 'b'.repeat(32)), /machine identity/);
  await assert.rejects(manager.status('unknown'), /machine identity/);
  assert.equal(calls.filter(isLaunch).length, 1);
  const other = await fixture({ run: async () => 'LoadState=loaded\nDescription=other' });
  await assert.rejects(other.manager.start(request), /unowned/);
});
test('start rejects caller paths and unknown fields before admission or state writes', async () => {
  const { manager, calls } = await fixture();
  manager.stateDir = join(manager.stateDir, 'not-created');
  for (const extra of [{ cwd: '/sandbox' }, { stateRoot: '/sandbox' }, { unknown: true }, { jobId: 'legacy:1' }]) {
    await assert.rejects(manager.start({ ...request, ...extra }), /unsupported start field|invalid managed jobId/);
  }
  assert.equal(calls.length, 0);
  await assert.rejects(stat(manager.stateDir), { code: 'ENOENT' });
});
test('legacy colon IDs retain status and stop without managed storage', async () => {
  const { manager, calls } = await fixture({ denied: true });
  const { unitFor } = await import('./contract.mjs');
  const legacyId = 'legacy:1';
  await writeFile(manager.path(legacyId), JSON.stringify({ jobId: legacyId, machineId: request.machineId,
    unit: unitFor(legacyId), fingerprint: 'a'.repeat(64), phase: 'started' }));
  assert.equal((await manager.status(legacyId, request.machineId)).live, false);
  assert.equal((await manager.stop(legacyId, request.machineId)).jobId, legacyId);
  assert.equal(calls.filter(isLaunch).length, 0);
});
test('transport serializes host calls and sends payload only on stdin', async () => {
  const pending = [];
  const calls = [];
  const transport = hostTransport({ host: 'fake-test', machineId: request.machineId, socketDir: await mkdtemp(join(tmpdir(), 'host-ssh-test-')),
    run: async (args, stdin) => { calls.push({ args, stdin }); if (!stdin) return ''; return new Promise(resolve => pending.push(() => resolve('{"ok":true,"result":{}}'))); } });
  const starts = Array.from({ length: 4 }, () => transport.request(request));
  const readyDeadline = Date.now() + 5000;
  while (!pending.length && Date.now() < readyDeadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(pending.length, 1);
  const status = transport.request({ operation: 'status', jobId: request.jobId, machineId: request.machineId });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(pending.length, 1);
  for (let i = 0; i < 5; i++) {
    while (!pending.length) await new Promise(resolve => setTimeout(resolve, 10));
    pending.shift()();
  }
  await Promise.all([...starts, status]);
  const remote = calls.filter(x => x.stdin);
  assert.ok(remote.every(x => x.args.includes('-oProxyCommand=false')));
  assert.ok(remote.every(x => !x.args.includes(request.jobId)));
  assert.ok(remote.every(x => JSON.parse(x.stdin).machineId === request.machineId));
  assert.ok(calls.every(x => x.args.at(-1) === 'sr-transport@fake-test'));
  assert.ok(remote.every(x => x.args.includes('-T')));
});
test('restricted transport pins its SSH identity and rejects caller username overrides before SSH', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'host-restricted-destination-test-'));
  const calls = [];
  try {
    for (const host of ['root@host', 'admin@host', 'sr-transport@host']) {
      assert.throws(() => hostTransport({ host, machineId: request.machineId, socketDir: dir,
        run: async () => { throw new Error('must not execute'); } }), /without a user/);
    }
    const transport = hostTransport({ host: 'fake-admin-alias', machineId: request.machineId, socketDir: dir,
      run: async (args, stdin) => {
        calls.push({ args, stdin });
        if (args.includes('check')) throw new Error('create synthetic master');
        return stdin ? '{"ok":true,"result":{}}' : '';
      } });
    await transport.request({ operation: 'status', machineId: request.machineId, jobId: '$(touch /never-execute); sh -i' });
    assert.equal(calls.length, 3);
    assert.ok(calls.every(call => call.args.at(-1) === 'sr-transport@fake-admin-alias'));
    assert.ok(calls.every(call => !call.args.some(arg => arg.includes('touch'))));
    assert.match(calls.at(-1).stdin, /touch/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('restricted login shell never evaluates caller commands or forwards arguments', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'host-ingress-test-'));
  try {
    const marker = join(dir, 'executed');
    const sudo = join(dir, 'sudo');
    await writeFile(sudo, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
    const source = await readFile(new URL('./ssh-ingress-shell', import.meta.url), 'utf8');
    const shell = join(dir, 'shell');
    await writeFile(shell, source.replace('/usr/bin/sudo', sudo));
    for (const command of [`touch ${marker}`, `$(touch ${marker})`, 'internal-sftp', 'sh -i']) {
      const { stdout } = await promisify(execFile)('/bin/sh', [shell, '-c', command], { env: { SSH_ORIGINAL_COMMAND: command } });
      assert.equal(stdout, '-n\n--\n/opt/subscription-runtime/host-jobs/ssh-endpoint\n');
      await assert.rejects(stat(marker), { code: 'ENOENT' });
    }
    const endpoint = join(dir, 'endpoint');
    const endpointSource = await readFile(new URL('./ssh-endpoint', import.meta.url), 'utf8');
    await writeFile(endpoint, endpointSource);
    await assert.rejects(promisify(execFile)('/bin/sh', [endpoint, 'unexpected']), error => error.code === 64);
    const node = join(dir, 'node');
    await writeFile(node, '#!/bin/sh\n/usr/bin/env\n', { mode: 0o755 });
    const lock = join(dir, 'ingress.lock');
    const flock = join(dir, 'flock');
    const timeout = join(dir, 'timeout');
    await writeFile(lock, '');
    await writeFile(flock, '#!/bin/sh\n[ "$1" = -n ] && [ "$2" = 9 ]\n', { mode: 0o755 });
    await writeFile(timeout, '#!/bin/sh\n[ "$1" = --kill-after=5s ] && [ "$2" = 120s ] || exit 88\nshift 2\nexec "$@"\n', { mode: 0o755 });
    await writeFile(endpoint, endpointSource.replace('/opt/subscription-runtime/runtime/node', node)
      .replace('/opt/subscription-runtime/host-jobs/ingress.lock', lock).replace('/usr/bin/flock', flock).replace('/usr/bin/timeout', timeout));
    const { stdout } = await promisify(execFile)('/bin/sh', [endpoint], { env: {
      HOME: '/attacker', NODE_OPTIONS: '--require=/attacker', SSH_ORIGINAL_COMMAND: 'evil', LD_PRELOAD: '/nonexistent',
    } });
    assert.match(stdout, /^HOME=\/root$/m);
    assert.doesNotMatch(stdout, /NODE_OPTIONS|SSH_ORIGINAL_COMMAND|LD_PRELOAD|attacker/);
    await writeFile(flock, '#!/bin/sh\nexit 1\n');
    await assert.rejects(promisify(execFile)('/bin/sh', [endpoint]), error => {
      assert.equal(error.code, 1);
      assert.deepEqual(JSON.parse(error.stdout), { ok: false, error: 'ingress busy' });
      return true;
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('obsolete legacy transport option cannot bypass restricted ingress', async () => {
  const calls = [];
  const dir = await mkdtemp(join(tmpdir(), 'host-legacy-transport-test-'));
  try {
    assert.throws(() => hostTransport({ host: 'root@fake-legacy-opt-in', machineId: request.machineId, socketDir: dir, legacyCommand: true }), /host alias without a user/);
    const transport = hostTransport({ host: 'fake-legacy-opt-in', machineId: request.machineId, socketDir: dir, legacyCommand: true,
      run: async (args, stdin) => { calls.push({ args, stdin }); return stdin ? '{"ok":true,"result":{}}' : ''; } });
    await transport.request({ operation: 'status', jobId: request.jobId, machineId: request.machineId });
    assert.ok(calls.every(call => call.args.at(-1) === 'sr-transport@fake-legacy-opt-in'));
    assert.ok(calls.every(call => !call.args.includes('/opt/subscription-runtime/host-jobs/endpoint.mjs')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('installer requires restricted SSH ingress and rejects legacy mode', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'host-ingress-install-test-'));
  try {
    await writeFile(join(dir, 'id'), '#!/bin/sh\necho 0\n', { mode: 0o755 });
    const script = join(dir, 'install');
    await writeFile(script, await readFile(new URL('./install', import.meta.url)));
    for (const args of [[], ['--legacy-unmanaged'], ['--ssh-public-key'], ['--ssh-public-key', join(dir, 'missing'), 'extra'], ['--ssh-public-key', join(dir, 'missing')]]) {
      await assert.rejects(promisify(execFile)('/bin/sh', [script, ...args], { env: { PATH: `${dir}:/usr/bin:/bin` } }), /usage:|not readable/);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('restricted installer is repeatable and rejects identity, key and policy drift before writes', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'host-restricted-install-test-')));
  try {
    const bin = join(dir, 'bin');
    const scripts = join(dir, 'host-jobs');
    const account = join(dir, 'account');
    const trace = join(dir, 'writes');
    const home = join(dir, 'var/lib/sr-transport');
    const target = join(dir, 'opt/subscription-runtime/host-jobs');
    const policy = join(dir, 'etc/sudoers.d/sr-transport');
    await Promise.all([bin, scripts, join(dir, 'managed-launcher'), join(dir, 'etc/sudoers.d')].map(path => mkdir(path, { recursive: true })));
    const executable = (path, body) => writeFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    await executable(join(bin, 'id'), 'echo 0');
    await executable(join(bin, 'stat'), 'if [ "$2" = %u ]; then echo 0; else echo 755; fi');
    await executable(join(bin, 'getent'), `if [ -f '${account}' ]; then /bin/cat '${account}'; else exit 2; fi`);
    await executable(join(bin, 'useradd'), `echo useradd >> '${trace}'; printf '%s\\n' 'sr-transport:x:65531:65531::${home}:${target}/ssh-ingress-shell' > '${account}'`);
    await executable(join(bin, 'ssh-keygen'), 'exit 0');
    await executable(join(bin, 'visudo'), '/bin/cat >/dev/null');
    await executable(join(bin, 'sudo'), 'exit 0');
    await executable(join(bin, 'flock'), 'exit 0');
    await executable(join(bin, 'timeout'), 'exit 0');
    await executable(join(bin, 'chown'), 'exit 0');
    await executable(join(bin, 'chmod'), 'exit 0');
    await executable(join(bin, 'node'), 'exit 0');
    await executable(join(bin, 'install'), `echo install >> '${trace}'\nif [ "$1" = -d ]; then\n  shift\n  while [ "$#" -gt 0 ]; do case "$1" in -o|-g|-m) shift 2;; *) /bin/mkdir -p "$1"; shift;; esac; done\nelse\n  while [ "$#" -gt 2 ]; do shift; done\n  /bin/cp "$1" "$2"\nfi`);
    await executable(join(dir, 'managed-launcher/install'), `echo managed >> '${trace}'`);
    for (const name of ['launch.mjs', 'payload-guard.mjs', 'profiles.mjs']) {
      await writeFile(join(dir, 'managed-launcher', name), 'synthetic fixture\n');
    }
    for (const name of ['contract.mjs', 'manager.mjs', 'read-request.mjs', 'endpoint.mjs', 'storage-policy.mjs', 'ssh-endpoint', 'ssh-ingress-shell']) {
      await writeFile(join(scripts, name), 'synthetic fixture\n');
    }
    let source = await readFile(new URL('./install', import.meta.url), 'utf8');
    for (const path of ['/opt/subscription-runtime', '/var/lib/sr-transport', '/etc/sudoers.d']) source = source.replaceAll(path, join(dir, path));
    for (const tool of ['ssh-keygen', 'sudo', 'flock', 'timeout']) source = source.replaceAll(`/usr/bin/${tool}`, join(bin, tool));
    for (const tool of ['visudo', 'useradd']) source = source.replaceAll(`/usr/sbin/${tool}`, join(bin, tool));
    await writeFile(join(scripts, 'install'), source);
    const key = join(dir, 'key.pub');
    await writeFile(key, 'ssh-ed25519 AAAA synthetic-key\n');
    const invoke = () => promisify(execFile)('/bin/sh', [join(scripts, 'install'), '--ssh-public-key', key], { env: { PATH: `${bin}:/usr/bin:/bin` } });
    await invoke();
    const expectedAccount = await readFile(account, 'utf8');
    const expectedKey = await readFile(join(home, '.ssh/authorized_keys'), 'utf8');
    const expectedPolicy = await readFile(policy, 'utf8');
    const lockBefore = await stat(join(target, 'ingress.lock'));
    await writeFile(trace, '');
    await invoke();
    assert.equal((await stat(join(target, 'ingress.lock'))).ino, lockBefore.ino);
    assert.doesNotMatch(await readFile(trace, 'utf8'), /useradd/);
    assert.equal(await readFile(join(home, '.ssh/authorized_keys'), 'utf8'), expectedKey);
    for (const [path, bad, original] of [[account, expectedAccount.replace('65531:', '65532:'), expectedAccount],
      [join(home, '.ssh/authorized_keys'), expectedKey.replace('AAAA', 'BBBB'), expectedKey], [policy, 'sr-transport ALL=(ALL) NOPASSWD: ALL\n', expectedPolicy]]) {
      await writeFile(path, bad);
      await writeFile(trace, '');
      await assert.rejects(invoke(), /identity|key differs|sudoers differs/);
      assert.equal(await readFile(trace, 'utf8'), '');
      await writeFile(path, original);
    }
    await unlink(join(bin, 'timeout'));
    await writeFile(trace, '');
    await assert.rejects(invoke(), /requires executable/);
    assert.equal(await readFile(trace, 'utf8'), '');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Node installer accepts both layouts and rejects untrusted paths before writes', async () => {
  const source = await readFile(new URL('./install', import.meta.url), 'utf8');
  const stagedFiles = ['contract.mjs', 'manager.mjs', 'read-request.mjs', 'endpoint.mjs', 'storage-policy.mjs', 'ssh-endpoint', 'ssh-ingress-shell', '../managed-launcher/install', '../managed-launcher/launch.mjs', '../managed-launcher/payload-guard.mjs', '../managed-launcher/profiles.mjs'];
  const scenarios = ['system', 'fixed', 'untrusted-source', 'untrusted-fixed', 'writable-ancestor',
    ...stagedFiles.flatMap(file => [`writable-staged:${file}`, `symlink-staged:${file}`]),
    ...stagedFiles.filter(file => !file.startsWith('../')).flatMap(file => [`writable-destination:${file}`, `symlink-destination:${file}`])];
  for (const scenario of scenarios) {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'host-node-install-test-')));
    try {
      const bin = join(root, 'bin');
      const runtime = join(root, 'opt/subscription-runtime/runtime');
      const scripts = join(root, 'host-jobs');
      const trace = join(root, 'writes');
      await Promise.all([bin, runtime, scripts, join(root, 'managed-launcher'), join(root, 'etc/sudoers.d')].map(dir => mkdir(dir, { recursive: true })));
      const executable = (path, body) => writeFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
      await executable(join(bin, 'id'), 'printf "0\\n"');
      // Fake ownership metadata only; real filesystem checks and resolution run
      // exclusively inside this disposable installation tree.
      await executable(join(bin, 'stat'), 'field=$2; shift 2; if [ "$field" = %u ]; then if [ "$1" = "$BAD_OWNER" ]; then echo 1000; else echo 0; fi; else if [ "$1" = "$BAD_MODE" ]; then echo 777; else echo 755; fi; fi');
      await executable(join(bin, 'install'), 'echo install >> "$TRACE"\nif [ "$1" = -d ]; then\n shift\n while [ "$#" -gt 0 ]; do case "$1" in -o|-g|-m) shift 2;; *) /bin/mkdir -p "$1"; shift;; esac; done\nelse\n while [ "$#" -gt 2 ]; do shift; done\n /bin/cp "$1" "$2"\nfi');
      for (const tool of ['ssh-keygen', 'sudo', 'flock', 'timeout', 'useradd', 'chown']) await executable(join(bin, tool), 'exit 0');
      await executable(join(bin, 'visudo'), '/bin/cat >/dev/null');
      await executable(join(bin, 'getent'), 'exit 2');
      const key = join(root, 'key.pub');
      await writeFile(key, 'ssh-ed25519 AAAA synthetic-key\n');
      await executable(join(root, 'managed-launcher/install'), 'echo managed >> "$TRACE"');
      for (const file of stagedFiles.filter(file => file !== '../managed-launcher/install')) {
        await writeFile(join(scripts, file), 'synthetic fixture\n');
      }
      const stagedFile = scenario.split(':')[1];
      const destinationLeaf = stagedFile && join(root, 'opt/subscription-runtime/host-jobs', stagedFile);
      if (scenario.includes('-destination:')) {
        await mkdir(join(root, 'opt/subscription-runtime/host-jobs'), { recursive: true });
        if (scenario.startsWith('symlink-destination:')) await symlink(join(bin, 'id'), destinationLeaf);
        else await writeFile(destinationLeaf, 'existing destination\n');
      }
      if (scenario.startsWith('symlink-staged:')) {
        await unlink(join(scripts, stagedFile));
        await symlink(join(bin, 'id'), join(scripts, stagedFile));
      }
      await executable(join(bin, 'node'), 'exit 99');
      const fixed = join(runtime, 'node');
      if (scenario === 'fixed' || scenario === 'untrusted-fixed') await executable(fixed, 'exit 98');
      let fixtureSource = source;
      for (const path of ['/opt/subscription-runtime', '/var/lib/sr-transport', '/etc/sudoers.d']) fixtureSource = fixtureSource.replaceAll(path, join(root, path));
      for (const tool of ['ssh-keygen', 'sudo', 'flock', 'timeout']) fixtureSource = fixtureSource.replaceAll(`/usr/bin/${tool}`, join(bin, tool));
      for (const tool of ['visudo', 'useradd']) fixtureSource = fixtureSource.replaceAll(`/usr/sbin/${tool}`, join(bin, tool));
      await writeFile(join(scripts, 'install'), fixtureSource);
      const invocation = promisify(execFile)('/bin/sh', [join(scripts, 'install'), '--ssh-public-key', key], { env: {
        PATH: `${bin}:/usr/bin:/bin`, TRACE: trace,
        BAD_OWNER: scenario === 'untrusted-source' || scenario === 'fixed' ? join(bin, 'node') : scenario === 'untrusted-fixed' ? fixed : '',
        BAD_MODE: scenario === 'writable-ancestor' ? runtime : scenario.startsWith('writable-staged:') ? `${scripts}/${stagedFile}` : scenario.startsWith('writable-destination:') ? destinationLeaf : '',
      } });
      if (scenario === 'system' || scenario === 'fixed') {
        await invocation;
        assert.match(await readFile(trace, 'utf8'), /managed/);
        if (scenario === 'system') assert.equal(await readlink(fixed), join(bin, 'node'));
        else assert.equal(await readFile(fixed, 'utf8'), '#!/bin/sh\nexit 98\n');
      } else {
        await assert.rejects(invocation, /Node path|staged source|installed destination/);
        await assert.rejects(stat(trace), { code: 'ENOENT' });
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});
test('transport reconnects a lost master once and does not retry endpoint errors', async () => {
  let checks = 0;
  let masters = 0;
  let requests = 0;
  const transport = hostTransport({ host: 'fake-reconnect', machineId: request.machineId, socketDir: await mkdtemp(join(tmpdir(), 'host-ssh-reconnect-')),
    run: async (args, stdin) => {
      if (args.includes('check')) { checks++; if (checks === 2) throw new Error('expired'); return ''; }
      if (args.includes('-M')) { masters++; return ''; }
      requests++;
      if (requests === 1) throw new Error('lost socket');
      return sshOutput(1, '{"ok":false,"error":"admission denied"}');
    } });
  await assert.rejects(transport.request(request), /admission denied/);
  assert.equal(checks, 2);
  assert.equal(masters, 1);
  assert.equal(requests, 2);
  await assert.rejects(transport.request(request), /admission denied/);
  assert.equal(requests, 3);
  await assert.rejects(transport.request({ operation: 'stop', jobId: request.jobId, machineId: 'b'.repeat(32) }), /machine identity/);
  assert.equal(requests, 3);
});
test('uncertain missing service is unresolved, not automatically abandoned', async () => {
  const { manager } = await fixture({ run: async (cmd, args) => {
    if (isLaunch({ cmd, args })) throw new Error('unknown outcome');
    return 'LoadState=not-found';
  } });
  await manager.start(request);
  const status = await manager.status(request.jobId, request.machineId);
  assert.equal(status.live, false);
  assert.equal(status.unresolved, true);
  assert.equal(status.abandoned, false);
});
test('concurrent first starts reconcile a unit launched after the initial record read', async () => {
  const { manager, calls } = await fixture();
  const read = manager.read.bind(manager);
  let initialReads = 0;
  let releaseSecond;
  let bothRead;
  let firstRead;
  const firstGate = new Promise(resolve => { firstRead = resolve; });
  const secondGate = new Promise(resolve => { releaseSecond = resolve; });
  const readGate = new Promise(resolve => { bothRead = resolve; });
  manager.read = async id => {
    const result = await read(id);
    if (initialReads < 2) {
      initialReads++;
      if (initialReads === 1) { firstRead(); await readGate; }
      else { bothRead(); await secondGate; }
    }
    return result;
  };
  const first = manager.start(request);
  await firstGate;
  const second = manager.start(request);
  await first;
  releaseSecond();
  const result = await second;
  assert.equal(result.retry, true);
  assert.equal(calls.filter(isLaunch).length, 1);
});
test('CLI forwards JSON stdin and configured identity without a real transport', async () => {
  let received;
  let output = '';
  const factory = config => ({ request: async payload => { received = { config, payload }; return { live: true }; } });
  await hostJobCli(['fake-cli', request.machineId, '/sandbox/socket'], [JSON.stringify({ operation: 'status', jobId: 'test:1' })], { write: value => { output += value; } }, factory);
  assert.equal(received.payload.machineId, request.machineId);
  assert.equal(received.payload.jobId, 'test:1');
  assert.equal(received.config.legacyCommand, undefined);
  assert.deepEqual(JSON.parse(output), { live: true });
  await assert.rejects(hostJobCli(['fake-cli', request.machineId, '/sandbox/socket'], [JSON.stringify({ machineId: 'b'.repeat(32) })], { write() {} }, factory), /machine identity/);
});
test('CLI accepts exactly three arguments and rejects legacy flags', async () => {
  const args = ['fake-cli', request.machineId, '/sandbox/socket'];
  const input = [JSON.stringify({ operation: 'status', jobId: 'test:1' })];
  await assert.rejects(hostJobCli(args.slice(0, 2), input, { write() {} }), /usage:/);
  for (const extra of [['--legacy-command'], ['--legacy'], ['--legacy-command=true'], ['--legacy-command', '--legacy-command']]) {
    await assert.rejects(hostJobCli([...args, ...extra], input, { write() {} }, () => { throw new Error('must not create transport'); }), /usage:/);
  }
});
test('CLI preserves UTF-8 characters split across byte chunks', async () => {
  const bytes = Buffer.from(JSON.stringify({ operation: 'start', argv: ['/test', 'Привіт 🧪'] }));
  let received;
  await hostJobCli(['fake-cli', request.machineId, '/sandbox/socket'], Array.from(bytes, byte => Buffer.from([byte])), { write() {} }, () => ({ request: async value => { received = value; return {}; } }));
  assert.equal(received.argv[1], 'Привіт 🧪');
});
test('independent processes cannot enter one host critical section concurrently', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'host-lock-processes-'));
  const module = new URL('../../scripts/ops/host-job-lock.mjs', import.meta.url).href;
  const script = `import {hostLock} from ${JSON.stringify(module)};
    import {mkdir,rmdir} from 'node:fs/promises';
    const directory=process.argv[1];
    const release=await hostLock(directory,'fake-host');
    await mkdir(directory+'/exclusive');
    await new Promise(resolve=>setTimeout(resolve,30));
    await rmdir(directory+'/exclusive');
    await release();`;
  await Promise.all(Array.from({ length: 4 }, () => promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, directory])));
});
test('lock waiter reconciles owner release during process identity lookup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'host-lock-release-race-'));
  const lock = join(directory, 'fake-host.lock');
  await mkdir(lock, { mode: 0o700 });
  await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: 123, started: 'previous-owner' }));
  const release = await hostLock(directory, 'fake-host', { processIdentity: async pid => {
    if (pid !== 123) return 'new-owner';
    await unlink(join(lock, 'owner.json'));
    await rmdir(lock);
    return '';
  } });
  assert.equal(JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')).pid, process.pid);
  await release();
});
test('lock waiter preserves unchanged stale owner and does not steal replacement owner', async () => {
  for (const replacement of [false, true]) {
    const directory = await mkdtemp(join(tmpdir(), 'host-lock-stale-race-'));
    const lock = join(directory, 'fake-host.lock');
    await mkdir(lock, { mode: 0o700 });
    const previous = { pid: 123, started: 'previous-owner' };
    const next = { pid: 456, started: 'replacement-owner' };
    await writeFile(join(lock, 'owner.json'), JSON.stringify(previous));
    await assert.rejects(hostLock(directory, 'fake-host', { timeoutMs: 50, processIdentity: async pid => {
      if (replacement && pid === 123) await writeFile(join(lock, 'owner.json'), JSON.stringify(next));
      return pid === 456 ? next.started : '';
    } }), replacement ? /queue timeout/ : /stale host lock/);
    assert.deepEqual(JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')), replacement ? next : previous);
    await unlink(join(lock, 'owner.json'));
    await rmdir(lock);
  }
});
test('lock waiter tolerates unpublished owner and never parses partial temporary JSON', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'host-lock-publication-'));
  const lock = join(directory, 'fake-host.lock');
  await mkdir(lock, { mode: 0o700 });
  await writeFile(join(lock, 'owner.pending'), '{"pid":');
  await assert.rejects(hostLock(directory, 'fake-host', { timeoutMs: 40 }), /queue timeout/);
  await unlink(join(lock, 'owner.pending'));
  await rmdir(lock);
  const release = await hostLock(directory, 'fake-host');
  await release();
});
