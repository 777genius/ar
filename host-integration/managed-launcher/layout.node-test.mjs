import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveManagedJobLayout, prepareManagedJobLayout, requireFinalJobStorage } from '../host-jobs/storage-policy.mjs';

function fixture(fault) {
  const created = [];
  const metadata = path => ({ uid: 0n, mode: 0o700n, ino: 1n,
    dev: path.startsWith('/volume') ? 257n : 1n,
    isDirectory: () => path !== '/etc/policy', isFile: () => path === '/etc/policy',
    isSymbolicLink: () => fault === 'symlink' && path === '/volume/jobs/synthetic/workspace' });
  const probe = {
    lstat: async path => metadata(path), stat: async path => metadata(path), realpath: async path => path,
    readPolicy: async () => JSON.stringify({ schemaVersion: 1, storageRoot: '/volume' }),
    statfs: async () => ({ bavail: fault === 'full' ? 1n : 5368709120n, bsize: 1n, ffree: 50000n }),
    readMountInfo: async () => `1 0 0:1 / / rw - ext4 root rw\n2 1 1:1 / /volume rw - ext4 volume rw\n${fault === 'mount' ? '3 2 0:1 / /volume/jobs/synthetic/workspace rw - ext4 root rw\n' : ''}`,
  };
  const descriptors = new Map();
  let nextFd = 10;
  const visiblePath = path => path.replace(/^\/proc\/self\/fd\/(\d+)/, (_, fd) => descriptors.get(Number(fd)));
  const openDirectory = async path => {
    const visible = visiblePath(path);
    if (metadata(visible).isSymbolicLink()) throw Error('unsafe path');
    const fd = nextFd++;
    descriptors.set(fd, visible);
    return { fd, stat: async () => metadata(visible), close: async () => {} };
  };
  return { created, options: { policyPath: '/etc/policy', probe, openDirectory, create: async path => {
    assert.match(path, /^\/proc\/self\/fd\/\d+\//);
    created.push(visiblePath(path));
  } } };
}

test('fixed layout rejects hostile identities without path normalization', () => {
  const layout = deriveManagedJobLayout('/volume', 'synthetic');
  assert.equal(layout.workspace, '/volume/jobs/synthetic/workspace');
  assert.equal(deriveManagedJobLayout('/volume', 'synthetic-1').jobRoot, '/volume/jobs/synthetic-1');
  assert.ok(Object.isFrozen(layout));
  for (const id of ['', '.', '..', '../other', '/root', 'x/y', 'x:y', 'a'.repeat(129), null]) {
    assert.throws(() => deriveManagedJobLayout('/volume', id), /invalid managed identity/);
  }
});

test('layout creates only fixed directories after capacity and mount admission', async () => {
  const good = fixture();
  await prepareManagedJobLayout('synthetic', good.options);
  assert.deepEqual(good.created, ['/volume/jobs', '/volume/jobs/synthetic', ...['workspace', 'state', 'logs', 'output', 'home', 'tmp', 'payload-logs'].map(key => `/volume/jobs/synthetic/${key}`)]);
  for (const fault of ['full']) {
    const bad = fixture(fault);
    await assert.rejects(prepareManagedJobLayout('synthetic', bad.options), /storage admission/);
    assert.deepEqual(bad.created, []);
  }
  await assert.rejects(prepareManagedJobLayout('synthetic', fixture('symlink').options), /unsafe path/);
});

test('mount loss after first mkdir retains descriptor writes and fails final admission', async () => {
  const value = fixture();
  const original = value.options.probe.stat;
  value.options.probe.stat = async path => {
    const metadata = await original(path);
    return value.created.length && path.startsWith('/volume') ? { ...metadata, dev: 1n } : metadata;
  };
  await assert.rejects(prepareManagedJobLayout('synthetic', value.options), /root filesystem forbidden/);
  // fixture.create asserts every write uses /proc/self/fd, including after loss.
  assert.ok(value.created.length > 1);
});

test('a different root descriptor is rejected before the first write', async () => {
  const value = fixture();
  const original = value.options.openDirectory;
  let closed = false;
  value.options.openDirectory = async path => {
    const handle = await original(path);
    const stat = handle.stat;
    return { ...handle, stat: async () => ({ ...await stat(), ino: 2n }), close: async () => { closed = true; } };
  };
  await assert.rejects(prepareManagedJobLayout('synthetic', value.options), /storage root changed/);
  assert.deepEqual(value.created, []);
  assert.equal(closed, true);
});

test('final namespace check uses minimal boundary and only inspects mounts in its job', async () => {
  const layout = deriveManagedJobLayout('/volume', 'synthetic');
  const env = { SUBSCRIPTION_RUNTIME_JOB_ROOT: layout.jobRoot, SUBSCRIPTION_RUNTIME_JOB_ID: layout.jobId };
  const good = fixture();
  good.options.probe.statfs = async () => assert.fail('capacity must not be repeated');
  good.options.probe.readPolicy = async () => assert.fail('policy must not be reloaded');
  const originalMounts = good.options.probe.readMountInfo;
  good.options.probe.readMountInfo = async () => await originalMounts() + '3 2 0:1 / /volume/jobs/unrelated/root rw - ext4 root rw\n';
  assert.deepEqual(await requireFinalJobStorage({ cwd: layout.workspace, probe: good.options.probe, jobId: layout.jobId, env }), { layout, device: 257n });
  await assert.rejects(requireFinalJobStorage({ cwd: layout.workspace, probe: fixture('mount').options.probe, jobId: layout.jobId, env }), /nested filesystem/);
  await assert.rejects(requireFinalJobStorage({ cwd: layout.workspace, probe: good.options.probe, jobId: layout.jobId, env: { ...env, SUBSCRIPTION_RUNTIME_JOB_ROOT: '/root' } }), /invalid launcher boundary/);
});
