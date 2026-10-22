/** Finite fresh-VM TEST only; no runtime, provider or recovery authority. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmdirSync, statfsSync, writeFileSync } from 'node:fs';
import { release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

assert.equal(process.platform, 'linux', 'Linux CI required; SKIP is not qualification');
assert.equal(process.env.GITHUB_ACTIONS, 'true');
const base = process.env.RUNNER_TEMP;
assert(base && resolve(base) === base && realpathSync(base) === base, 'canonical runner scratch required');
const pin = (path: string) => {
  const s = lstatSync(path, { bigint: true });
  assert(s.isDirectory() && !s.isSymbolicLink());
  assert.equal(s.uid, BigInt(process.getuid!()), 'scratch must be job-user owned');
  return { dev: String(s.dev), ino: String(s.ino) };
};
const basePin = pin(base);
assert.equal(statfsSync(base, { bigint: true }).type, 0xef53n, 'local ext4 scratch required');
const environment = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' };
const mount = spawnSync('/usr/bin/findmnt', ['--noheadings', '--raw', '--output', 'FSTYPE,MAJ:MIN,OPTIONS', '--target', base],
  { encoding: 'utf8', env: environment, timeout: 2000, maxBuffer: 2048 });
assert.equal(mount.error, undefined); assert.equal(mount.status, 0); assert.equal(mount.stderr, '');
assert(/^ext4\s+[0-9]+:[0-9]+\s+\S+\n?$/.test(mount.stdout), 'findmnt must independently identify ext4');
const script = fileURLToPath(import.meta.url);
const probe = join(dirname(script), 'directory-ofd-kernel-contract.test.mts');
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
assert.equal(sha(probe), 'c51293a8e67d29e00d4c3c33d070366033e12e83e715244c83e8d155c3c42b21');
const python = realpathSync('/usr/bin/python3');
const pythonVersion = spawnSync('/usr/bin/python3', ['-I', '--version'],
  { encoding: 'utf8', env: environment, timeout: 2000, maxBuffer: 1024 });
assert.equal(pythonVersion.error, undefined); assert.equal(pythonVersion.status, 0);
assert.equal(pythonVersion.stderr, ''); assert(/^Python 3\.\d+\.\d+\n$/.test(pythonVersion.stdout));
const compiler = join(dirname(script), '../../node_modules/typescript');
const compilerVersion: unknown = JSON.parse(readFileSync(join(compiler, 'package.json'), 'utf8'));
assert(compilerVersion && typeof compilerVersion === 'object' && 'version' in compilerVersion);
assert.equal(typeof compilerVersion.version, 'string');
const source = process.env.TEST_SOURCE_SHA;
assert(source && /^[a-f0-9]{40}$/.test(source));
const scratch = mkdtempSync(join(base, 'TEST-directory-ofd-ci-'));
const scratchPin = pin(scratch);
try {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--test', '--test-timeout=15000', probe],
    { encoding: 'utf8', env: { ...environment, TMPDIR: scratch }, timeout: 30000, killSignal: 'SIGKILL', maxBuffer: 16384 });
  const evidence = { kind: 'TEST-directory-ofd-kernel-only', source, kernel: release(),
    scratch: scratchPin, scratchParent: basePin, mount: mount.stdout.trim(),
    node: { version: process.version, sha256: sha(process.execPath) },
    python: { version: pythonVersion.stdout.trim(), sha256: sha(python) },
    typescript: { version: compilerVersion.version, sha256: sha(join(compiler, 'lib/_tsc.js')) },
    launcherSha256: sha(script), probeSha256: sha(probe),
    status: result.status, signal: result.signal, error: result.error?.name ?? null };
  writeFileSync(join(process.cwd(), 'dependency-retention-evidence/directory-ofd-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  writeFileSync(join(process.cwd(), 'dependency-retention-evidence/directory-ofd-test.log'), result.stdout + result.stderr);
  assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.status, 0);
  assert(/^# tests 1$/m.test(result.stdout) && /^# pass 1$/m.test(result.stdout) && /^# skipped 0$/m.test(result.stdout),
    'exactly one native PASS and zero SKIP required');
} finally {
  assert.deepEqual(pin(scratch), scratchPin); rmdirSync(scratch);
  assert.deepEqual(pin(base), basePin);
}
