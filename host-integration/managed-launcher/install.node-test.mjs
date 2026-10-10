import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, statSync, lstatSync, readlinkSync, symlinkSync, linkSync, rmSync, readdirSync, renameSync } from 'node:fs';
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
  // Keep the generated CommonJS commands independent of temporary ancestors.
  writeFileSync(join(bin, 'package.json'), '{"type":"commonjs"}\n');
  for (const path of ['managed-launcher/host-inventory-codec.cjs', 'managed-launcher/launch.mjs', 'managed-launcher/payload-guard.mjs', 'managed-launcher/profiles.mjs', 'managed-launcher/hosted-host-policy.mjs', 'host-jobs/storage-policy.mjs']) {
    writeFileSync(`${integration}/${path}`, `trusted ${path}\n`);
    writeFileSync(`${destination}/${path}`, path.endsWith('host-inventory-codec.cjs') ? `trusted ${path}\n` : 'old installation\n');
  }
  const tini = join(bin, 'tini');
  writeFileSync(tini, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const source = readFileSync(new URL('./install', import.meta.url), 'utf8')
    .replace('destination=/opt/subscription-runtime', `destination=${destination}`)
    .replace('tini=/usr/bin/tini', `tini=${tini}`)
    .replaceAll('/var/lib/subscription-runtime-host-policy/readonly-inventory.json', `${root}/readonly-inventory.json`)
    .replaceAll('/var/lib/subscription-runtime-host-policy/fd-collector-profile.v1.json', `${root}/fd-collector-profile.v1.json`)
    // The fixture root substitutes for /; host temporary ancestors are not
    // trusted installation paths and may intentionally be writable/symlinked.
    .replaceAll('[ "$trusted_path" != / ]', `[ "$trusted_path" != "${root}" ]`);
  const installer = `${integration}/managed-launcher/install`;
  writeFileSync(installer, source);
  // Simulate root metadata and drop chown options only inside this disposable
  // fixture, allowing the same tests on unprivileged macOS and Linux runners.
  for (const [name, script] of Object.entries({
    id: 'process.stdout.write("0\\n");',
    stat: `const fs = require('node:fs'); const s = fs.statSync(process.argv[4]); process.stdout.write(process.argv[3] === '%u' ? (process.argv[4] === process.env.TEST_BAD_UID_PATH ? '1000' : '0') : process.argv[3] === '%h' ? String(s.nlink) : (s.mode & 0o7777).toString(8));`,
    install: `const {spawnSync} = require('node:child_process'); const args = process.argv.slice(2); const filtered=[]; for(let i=0;i<args.length;i++) { if(args[i]==='-o'||args[i]==='-g') i++; else filtered.push(args[i]); } const r=spawnSync('/usr/bin/install',filtered,{stdio:'inherit'}); process.exit(r.status ?? 1);`,
  })) {
    writeFileSync(join(bin, name), `#!${process.execPath}\n${script}\n`, { mode: 0o755 });
  }
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
  return { root, destination, integration, tini, run, snapshot };
}

for (const directory of ['', 'managed-launcher', 'host-jobs']) {
  for (const invalid of ['writable', 'symlink', 'owner']) test(`untrusted destination ${directory || 'root'} (${invalid}) refuses before changes`, t => {
    const f = fixture(t);
    const target = join(f.destination, directory);
    if (invalid === 'writable') chmodSync(target, 0o777);
    else if (invalid === 'symlink') {
      const moved = target + '-target';
      renameSync(target, moved);
      symlinkSync(moved, target);
    }
    const before = f.snapshot();
    const result = f.run(invalid === 'owner' ? { TEST_BAD_UID_PATH: target } : {});
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /untrusted path|root-owned/);
    assert.deepEqual(f.snapshot(), before);
  });
}

for (const invalid of ['writable', 'symlink', 'hardlink', 'ancestor-writable']) test(`untrusted source (${invalid}) refuses before changes`, t => {
  const f = fixture(t);
  const source = join(f.integration, 'host-jobs/storage-policy.mjs');
  if (invalid === 'writable') chmodSync(source, 0o666);
  if (invalid === 'ancestor-writable') chmodSync(join(f.integration, 'host-jobs'), 0o777);
  if (invalid === 'hardlink') linkSync(source, source + '.alias');
  if (invalid === 'symlink') {
    renameSync(source, source + '.target');
    symlinkSync(source + '.target', source);
  }
  const before = f.snapshot();
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.deepEqual(f.snapshot(), before);
});

test('absent trusted destination tree is created successfully', t => {
  const f = fixture(t);
  rmSync(f.destination, { recursive: true });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  for (const directory of ['', 'managed-launcher', 'host-jobs']) assert.equal(statSync(join(f.destination, directory)).mode & 0o777, 0o755);
});

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
  const result = f.run(invalid === 'owner' ? { TEST_BAD_UID_PATH: f.tini } : {});
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /[Tt]ini/);
  assert.deepEqual(f.snapshot(), before);
});

for (const invalid of ['writable', 'symlink', 'directory', 'owner']) test(`untrusted destination file (${invalid}) refuses before changes`, t => {
  const f = fixture(t);
  const target = join(f.destination, 'managed-launcher/launch.mjs');
  if (invalid === 'writable') chmodSync(target, 0o666);
  if (invalid === 'symlink' || invalid === 'directory') rmSync(target);
  if (invalid === 'symlink') symlinkSync('missing-target', target);
  if (invalid === 'directory') mkdirSync(target);
  const before = f.snapshot();
  assert.notEqual(f.run(invalid === 'owner' ? { TEST_BAD_UID_PATH: target } : {}).status, 0);
  assert.deepEqual(f.snapshot(), before);
});

test('trusted files are installed completely with expected permissions', t => {
  const f = fixture(t);
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    for (const path of ['managed-launcher/host-inventory-codec.cjs', 'managed-launcher/launch.mjs', 'managed-launcher/payload-guard.mjs', 'managed-launcher/profiles.mjs', 'managed-launcher/hosted-host-policy.mjs', 'host-jobs/storage-policy.mjs']) {
      assert.deepEqual(readFileSync(join(f.destination, path)), readFileSync(join(f.integration, path)));
      assert.equal(statSync(join(f.destination, path)).mode & 0o777, 0o644);
    }
  }
});

for (const invalid of ['missing', 'conflicting']) test(`inventory codec ${invalid} refuses before copied cohort changes`, t => {
  const f = fixture(t);
  const source = join(f.integration, 'managed-launcher/host-inventory-codec.cjs');
  if (invalid === 'missing') rmSync(source);
  else writeFileSync(join(f.destination, 'managed-launcher/host-inventory-codec.cjs'), 'foreign codec\n');
  const before = f.snapshot();
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.deepEqual(f.snapshot(), before);
});

for (const record of ['readonly-inventory.json', 'fd-collector-profile.v1.json']) test(`bootstrap install cannot replace a governed copied cohort (${record})`, t => {
  const f = fixture(t);
  writeFileSync(join(f.root, record), '{}\n');
  const before = f.snapshot();
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /qualified pair publication/);
  assert.deepEqual(f.snapshot(), before);
});
