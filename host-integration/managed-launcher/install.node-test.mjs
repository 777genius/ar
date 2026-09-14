import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, statSync, lstatSync, readlinkSync, symlinkSync, rmSync, readdirSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'launcher-install-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const destination = join(root, 'destination');
  const integration = join(root, 'source');
  const bin = join(root, 'bin');
  for (const path of [bin, `${integration}/managed-launcher`, `${integration}/host-jobs`, `${destination}/managed-launcher`, `${destination}/host-jobs`]) mkdirSync(path, { recursive: true });
  for (const path of ['managed-launcher/managed-host', 'managed-launcher/launch.mjs', 'managed-launcher/payload-guard.mjs', 'managed-launcher/profiles.mjs', 'host-jobs/storage-policy.mjs']) {
    writeFileSync(`${integration}/${path}`, `trusted ${path}\n`);
    if (!path.endsWith('/managed-host')) writeFileSync(`${destination}/${path}`, 'old installation\n');
  }
  const mountinfo = join(root, 'mountinfo');
  const tini = join(bin, 'tini');
  writeFileSync(tini, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(mountinfo, '1 0 0:1 / / rw - ext4 root rw\n');
  const source = readFileSync(new URL('./install', import.meta.url), 'utf8')
    .replace('destination=/opt/subscription-runtime', `destination=${destination}`)
    .replace('tini=/usr/bin/tini', `tini=${tini}`)
    // The fixture root substitutes for /; host temporary ancestors are not
    // trusted installation paths and may intentionally be writable/symlinked.
    .replace('[ "$trusted_path" != / ]', `[ "$trusted_path" != "${root}" ]`)
    .replaceAll('/proc/self/mountinfo', mountinfo);
  const installer = `${integration}/managed-launcher/install`;
  writeFileSync(installer, source);
  // Simulate root metadata and drop chown options only inside this disposable
  // fixture, allowing the same tests on unprivileged macOS and Linux runners.
  for (const [name, script] of Object.entries({
    id: 'process.stdout.write("0\\n");',
    ln: `require('node:fs').linkSync(process.argv[3], process.argv[4]); if(process.env.TEST_SIGNAL_AFTER_LINK) process.kill(process.ppid, 'SIGTERM');`,
    stat: `const fs = require('node:fs'); const s = fs.statSync(process.argv[4]); process.stdout.write(process.argv[3] === '%u' ? (process.env.TEST_MARKER_UID || '0') : (s.mode & 0o7777).toString(8));`,
    install: `const {spawnSync} = require('node:child_process'); const args = process.argv.slice(2); const filtered=[]; for(let i=0;i<args.length;i++) { if(args[i]==='-o'||args[i]==='-g') i++; else filtered.push(args[i]); } const r=spawnSync('/usr/bin/install',filtered,{stdio:'inherit'}); process.exit(r.status ?? 1);`,
  })) {
    writeFileSync(join(bin, name), `#!${process.execPath}\n${script}\n`, { mode: 0o755 });
  }
  const marker = `${destination}/managed-launcher/managed-host`;
  const run = (env = {}) => spawnSync('/bin/sh', [installer], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env } });
  const snapshot = () => {
    const result = {};
    const visit = relative => {
      const path = join(destination, relative);
      const s = lstatSync(path);
      result[relative] = { ino: s.ino, mtime: s.mtimeMs, mode: s.mode,
        content: s.isSymbolicLink() ? readlinkSync(path) : s.isFile() ? readFileSync(path, 'utf8') : null };
      if (s.isDirectory()) for (const name of readdirSync(path)) visit(join(relative, name));
    };
    visit('');
    return result;
  };
  return { marker, mountinfo, tini, run, snapshot, trusted: readFileSync(`${integration}/managed-launcher/managed-host`) };
}

for (const invalid of ['missing', 'not-executable', 'writable', 'symlink', 'directory', 'owner', 'ancestor-writable', 'ancestor-symlink']) test(`invalid Tini (${invalid}) fails before destination writes`, t => {
  const f = fixture(t);
  if (invalid === 'missing' || invalid === 'symlink' || invalid === 'directory') rmSync(f.tini);
  if (invalid === 'symlink') symlinkSync(process.execPath, f.tini);
  if (invalid === 'directory') mkdirSync(f.tini);
  if (invalid === 'not-executable') chmodSync(f.tini, 0o644);
  if (invalid === 'writable') chmodSync(f.tini, 0o777);
  if (invalid === 'ancestor-writable') chmodSync(join(f.tini, '..'), 0o777);
  if (invalid === 'ancestor-symlink') {
    // Exercise an ancestor link using a sibling target within the fixture.
    const parent = join(f.tini, '..');
    const moved = parent + '-target';
    renameSync(parent, moved);
    symlinkSync(moved, parent);
  }
  const before = f.snapshot();
  const result = f.run(invalid === 'owner' ? { TEST_MARKER_UID: '1000' } : {});
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /[Tt]ini/);
  assert.deepEqual(f.snapshot(), before);
});

test('exact marker mountpoint fails before changing installed files', t => {
  const f = fixture(t);
  writeFileSync(f.marker, f.trusted);
  writeFileSync(f.mountinfo, `2 1 0:1 / ${f.marker} ro - ext4 root rw\n`);
  const before = f.snapshot();
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exact mountpoint/);
  assert.deepEqual(f.snapshot(), before);
});

for (const invalid of ['content', 'writable', 'symlink', 'directory', 'owner']) test(`invalid marker (${invalid}) fails before destination changes`, t => {
  const f = fixture(t);
  if (invalid === 'symlink') symlinkSync('missing-target', f.marker);
  else if (invalid === 'directory') mkdirSync(f.marker);
  else writeFileSync(f.marker, invalid === 'content' ? 'untrusted' : f.trusted);
  if (invalid === 'writable') chmodSync(f.marker, 0o666);
  const before = f.snapshot();
  assert.notEqual(f.run(invalid === 'owner' ? { TEST_MARKER_UID: '1000' } : {}).status, 0);
  assert.deepEqual(f.snapshot(), before);
});

test('identical trusted marker remains the same inode across repeated installs', t => {
  const f = fixture(t);
  writeFileSync(f.marker, f.trusted, { mode: 0o644 });
  const before = statSync(f.marker);
  for (let i = 0; i < 2; i++) {
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(statSync(f.marker).ino, before.ino);
    assert.equal(statSync(f.marker).mtimeMs, before.mtimeMs);
  }
});

test('absent marker is installed completely without temporary residue', t => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(f.marker), f.trusted);
  assert.equal(statSync(f.marker).mode & 0o777, 0o644);
  assert.ok(!Object.keys(f.snapshot()).some(path => path.includes('.managed-host.')));
});

test('termination after marker publication stops before launcher files change', t => {
  const f = fixture(t);
  const before = f.snapshot();
  const result = f.run({ TEST_SIGNAL_AFTER_LINK: '1' });
  assert.notEqual(result.status, 0);
  assert.deepEqual(readFileSync(f.marker), f.trusted);
  const after = f.snapshot();
  for (const path of ['managed-launcher/launch.mjs', 'managed-launcher/payload-guard.mjs',
    'managed-launcher/profiles.mjs', 'host-jobs/storage-policy.mjs']) assert.deepEqual(after[path], before[path]);
  assert.ok(!Object.keys(after).some(path => path.includes('.managed-host.')));
});
