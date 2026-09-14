import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { CONFIG_FILE_MODE, parseStorageRootArguments, validateCandidate } from './install-policy.mjs';

test('host installers use the fixed trusted /opt installation root', () => {
  for (const [path, assignment] of [
    ['./install', 'destination=/opt/subscription-runtime'],
    ['../host-jobs/install', 'target=/opt/subscription-runtime/host-jobs'],
  ]) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.equal(spawnSync('/bin/sh', ['-n'], { input: source }).status, 0);
    assert.ok(source.split('\n').includes(assignment));
  }
});

test('config is readable by non-root managers and writable only by root', () => {
  assert.equal(CONFIG_FILE_MODE, 0o644);
  assert.equal(CONFIG_FILE_MODE & 0o044, 0o044);
  assert.equal(CONFIG_FILE_MODE & 0o022, 0);
});

test('shell installer resolves and checks Node without a fixed binary location', () => {
  const source = readFileSync(new URL('./install-policy', import.meta.url), 'utf8');
  assert.equal(spawnSync('/bin/sh', ['-n'], { input: source }).status, 0);
  assert.match(source, /command -v node/);
  assert.match(source, /readlink -f/);
  assert.match(source, /stat -c %u/);
  assert.match(source, /0\$mode & 0022/);
  assert.match(source, /trusted_path=\$\{trusted_path%\/\*\}/);
  assert.match(source, /exec "\$node_binary"/);
  assert.doesNotMatch(source, /exec \/usr\/bin\/node/);
});

test('explicit argv config has only root and rejects threshold overrides', () => {
  assert.deepEqual(parseStorageRootArguments(['/volume/jobs']), { check: false, config: { storageRoot: '/volume/jobs' } });
  assert.equal(parseStorageRootArguments(['--check', '/volume']).check, true);
  for (const args of [[], ['/'], ['relative'], ['/volume/'], ['/volume/../x'], ['/volume%h'], ['/volume', '-1'], ['/volume', '1e9'], ['/volume', '01'], ['/volume', '9007199254740992'], ['/volume', '1', '2', '3'], ['--destination', '/tmp']]) {
    assert.throws(() => parseStorageRootArguments(args));
  }
});

function syntheticProbe({ rootBacked = false, symlink = false, free = 5368709120n, nested = false } = {}) {
  const metadata = path => ({ uid: 0n, mode: 0o755n, dev: path.startsWith('/volume') && !rootBacked ? 257n : 1n, ino: 1n, isDirectory: () => true, isSymbolicLink: () => symlink && path === '/volume' });
  return {
    lstat: async path => metadata(path), stat: async path => metadata(path), realpath: async path => path,
    statfs: async () => ({ bavail: free, bsize: 1n, ffree: free }),
    readMountInfo: async () => `1 0 0:1 / / rw - ext4 root rw\n2 1 1:1 / /volume rw - ext4 volume rw\n${nested ? '3 2 0:1 / /volume/hidden rw - ext4 root rw\n' : ''}`,
  };
}

test('candidate checks its external root without inspecting unrelated jobs', async () => {
  const { config } = parseStorageRootArguments(['/volume']);
  assert.deepEqual(await validateCandidate(config, syntheticProbe()), config);
  assert.deepEqual(await validateCandidate(config, syntheticProbe({ nested: true })), config);
  for (const options of [{ rootBacked: true }, { symlink: true }, { free: 9n }]) {
    await assert.rejects(validateCandidate(config, syntheticProbe(options)), /storage admission:/);
  }
});
