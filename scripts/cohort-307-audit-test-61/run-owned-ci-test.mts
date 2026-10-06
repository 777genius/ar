import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// One finite CI TEST namespace, derived from the already reviewed observer TEST launcher.
// Never invokes cohort-audit main/SSH; no arbitrary script, provider or project argument.
const self = fileURLToPath(import.meta.url), source = dirname(self);
const files = ['run-owned-ci-test.mts', 'audit-helper.test.mts', 'audit-helper.namespace.test.mts',
  'cohort-audit.mts', 'audit-payload.py', 'input/fixed-cohort.json'] as const;
const namespaces = ['user', 'mnt', 'pid'] as const;
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const pin = (fd: number): string => { const s = fstatSync(fd, { bigint: true }); return `${s.dev}:${s.ino}`; };
function sourceBytes(path: string): Buffer {
  const before = lstatSync(path, { bigint: true });
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.size <= 256n * 1024n);
  const bytes = readFileSync(path), after = lstatSync(path, { bigint: true });
  assert.equal(before.dev, after.dev); assert.equal(before.ino, after.ino); assert.equal(before.ctimeNs, after.ctimeNs);
  assert.equal(before.mtimeNs, after.mtimeNs); assert.equal(before.size, BigInt(bytes.length)); return bytes;
}
function targetMounts(root: string): string[] {
  const text = readFileSync('/proc/self/mountinfo', 'utf8'); assert.ok(Buffer.byteLength(text) <= 2 * 1024 * 1024);
  return text.trim().split('\n').filter(line => { const p = line.split(' ')[4]; return p === root || p?.startsWith(`${root}/`); });
}
try {
  assert.equal(process.platform, 'linux'); assert.equal(process.env.CI, 'true'); assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert.equal(process.versions.node, '22.23.3'); assert.equal(process.getuid?.(), 0); assert.equal(process.getgid?.(), 0);
  if (process.argv.length === 2) {
    const root = mkdtempSync('/tmp/TEST-cohort-audit-namespace-'), staged = join(root, 'helper'); mkdirSync(staged, { mode: 0o700 });
    mkdirSync(join(staged, 'input'), { mode: 0o700 }); mkdirSync(join(staged, 'tmp'), { mode: 0o700 });
    for (const path of files) { const bytes = sourceBytes(join(source, path)); writeFileSync(join(staged, path), bytes, { flag: 'wx', mode: 0o600 }); assert.equal(sha(sourceBytes(join(staged, path))), sha(bytes)); }
    const fds: number[] = [];
    try {
      for (const name of namespaces) fds.push(openSync(`/proc/self/ns/${name}`, constants.O_RDONLY));
      const before = fds.map(pin), mounts = targetMounts(root);
      const result = spawnSync('/usr/bin/unshare', ['--user', '--map-root-user', '--mount', '--pid', '--fork', '--mount-proc',
        '--propagation', 'private', '--kill-child=SIGKILL', '--', process.execPath, '--experimental-strip-types',
        join(staged, 'run-owned-ci-test.mts'), '--inside', root], { cwd: staged, uid: 0, gid: 0,
        env: { PATH: '/usr/bin:/bin', CI: 'true', GITHUB_ACTIONS: 'true', TMPDIR: join(staged, 'tmp') },
        stdio: ['ignore', 'pipe', 'pipe', ...fds], encoding: 'utf8', timeout: 90_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
      assert.ok(!result.error && result.status === 0 && result.signal === null, 'owned_TEST_namespace_or_required_suite_failed');
      assert.deepEqual(fds.map(pin), before);
      for (const [index, name] of namespaces.entries()) {
        const fresh = openSync(`/proc/self/ns/${name}`, constants.O_RDONLY);
        try { assert.equal(pin(fresh), before[index]); } finally { closeSync(fresh); }
      }
      assert.deepEqual(targetMounts(root), mounts, 'TEST mounts propagated into parent');
      for (const path of files) assert.equal(sha(sourceBytes(join(source, path))), sha(sourceBytes(join(staged, path))));
      console.log(JSON.stringify({ status: 'Passed', scope: 'NEW-owned-TEST-only', tests: 8, skipped: 0,
        parentNamespacesUnchanged: true, parentTargetMountsUnchanged: true, sourceBytesUnchanged: true, hostAuditExecuted: false }));
      rmSync(root, { recursive: true }); // Only owned staging after joined PID namespace teardown.
    } finally { for (const fd of fds.reverse()) closeSync(fd); }
  } else {
    assert.equal(process.argv.length, 4); assert.equal(process.argv[2], '--inside'); const root = process.argv[3];
    assert.ok(root && /^\/tmp\/TEST-cohort-audit-namespace-[A-Za-z0-9]+$/.test(root));
    assert.equal(source, join(root, 'helper')); assert.equal(process.pid, 1);
    assert.equal(process.getegid?.(), 0); assert.equal(process.geteuid?.(), 0); assert.deepEqual(process.getgroups?.(), [0]);
    for (const path of [root, source, join(source, 'tmp')]) {
      const s = lstatSync(path); assert.ok(s.isDirectory() && !s.isSymbolicLink());
      assert.equal(s.uid, 0); assert.equal(s.gid, 0); assert.equal(s.mode & 0o7777, 0o700);
    }
    assert.match(readFileSync('/proc/self/uid_map', 'utf8').trim(), /^0\s+0\s+1$/);
    assert.match(readFileSync('/proc/self/gid_map', 'utf8').trim(), /^0\s+0\s+1$/);
    for (const [index, name] of namespaces.entries()) {
      const fd = openSync(`/proc/self/ns/${name}`, constants.O_RDONLY);
      try { assert.notEqual(pin(fd), pin(3 + index)); } finally { closeSync(fd); }
      closeSync(3 + index);
    }
    for (const line of readFileSync('/proc/self/mountinfo', 'utf8').trim().split('\n')) {
      const fields = line.split(' '), separator = fields.indexOf('-'); assert.ok(separator >= 6);
      assert.ok(!fields.slice(6, separator).some(x => /^(shared|master|propagate_from):/.test(x)), 'TEST propagation not private');
    }
    const result = spawnSync(process.execPath, ['--experimental-strip-types', '--test',
      join(source, 'audit-helper.test.mts'), join(source, 'audit-helper.namespace.test.mts')], { cwd: source,
      env: { PATH: '/usr/bin:/bin', CI: 'true', GITHUB_ACTIONS: 'true', TMPDIR: join(source, 'tmp'), TEST_AUDIT_OWNED_NAMESPACE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
    assert.ok(!result.error && result.status === 0 && result.signal === null, 'required_TEST_suite_failed');
    for (const line of ['# tests 8', '# pass 8', '# fail 0', '# cancelled 0', '# skipped 0', '# todo 0']) assert.ok(result.stdout.split('\n').includes(line));
  }
} catch { console.error('Finite owned CI TEST failed; no host audit or cleanup was executed.'); process.exitCode = 1; }
