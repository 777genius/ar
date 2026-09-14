import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, unlink, rmdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostJobs } from './manager.mjs';
import { hostTransport, sshOutput } from '../../scripts/ops/host-job-transport.mjs';
import { hostJobCli } from '../../scripts/ops/host-job-cli.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hostLock } from '../../scripts/ops/host-job-lock.mjs';
import { requireHostStorage, loadManagedStorageRoot } from './storage-policy.mjs';

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
  assert.deepEqual(JSON.parse(output), { live: true });
  await assert.rejects(hostJobCli(['fake-cli', request.machineId, '/sandbox/socket'], [JSON.stringify({ machineId: 'b'.repeat(32) })], { write() {} }, factory), /machine identity/);
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
