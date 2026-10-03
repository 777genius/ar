import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nspawnArgs, parseArgs, treeDigest } from './run.mjs';
import { assertDisposableIdentity, runGuestCommand } from './guest-contract.mjs';

test('outside probe distinguishes kernel refusal, unexpected admission and unrelated failure', () => {
  const source = readFileSync(new URL('./denied-probe.mjs', import.meta.url), 'utf8');
  for (const [body, expected] of [
    ['throw new Error("hosted_custody_kernel_evidence_invalid")', 73],
    ['', 72],
    ['throw new Error("some_other_failure")', 74],
  ]) {
    const mocked = source.replace(/^import .*;$/m, `class HostedReadonlyHostKernel { operatorSession() { ${body} } }`);
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', mocked], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, expected, result.stderr);
  }
});

test('operator command uses bounded pipes for all descriptors, forwards output and fails on uncertain completion', () => {
  const output = [];
  runGuestCommand('/test/node', ['install-host'], 0, (command, args, options) => {
    assert.equal(options.stdio, 'pipe');
    assert.equal(options.maxBuffer, 1024 * 1024);
    assert.equal(options.timeout, 90000);
    return { status: 0, stdout: Buffer.from('ok'), stderr: Buffer.from('diagnostic') };
  }, bytes => output.push(bytes.toString()));
  assert.deepEqual(output, ['ok', 'diagnostic']);
  assert.throws(() => runGuestCommand('/test/node', [], 0, () => ({ status: null, signal: 'SIGTERM' })));
});

test('shutdown eligibility requires independent guest facts and exact trusted config', () => {
  const config = { name: 'sr-custody-canary-0123456789abcdef', machineId: 'a'.repeat(32), sha: 'b'.repeat(40), manifestSha256: 'c'.repeat(64) };
  const facts = { machineId: config.machineId, container: 'systemd-nspawn', pid1: 'systemd', hostname: config.name, configUid: 0, configMode: 0o600 };
  assert.doesNotThrow(() => assertDisposableIdentity(config, facts));
  for (const bad of [null, {}, { ...config, name: 'production' }, { ...config, machineId: 'd'.repeat(32) }]) assert.throws(() => assertDisposableIdentity(bad, facts));
  for (const bad of [{ container: '' }, { pid1: 'launchd' }, { hostname: 'production' }, { configUid: 1000 }, { configMode: 0o666 }]) assert.throws(() => assertDisposableIdentity(config, { ...facts, ...bad }));
});

const valid = ['--external-root', '/mnt/test', '--runtime', '/mnt/artifact', '--node', '/usr/bin/node', '--sha', 'a'.repeat(40), '--manifest-sha256', 'b'.repeat(64)];
test('requires exact identities and canonical paths; refuses unknown and duplicate flags', () => {
  assert.equal(parseArgs(valid).sha, 'a'.repeat(40));
  for (const args of [[], [...valid, '--cleanup', 'yes'], [...valid, '--sha', 'a'.repeat(40)], valid.map(v => v === '/mnt/test' ? '/' : v), valid.map(v => v === '/mnt/test' ? '/mnt/../root' : v), valid.slice(0, -1)]) assert.throws(() => parseArgs(args));
});
test('nspawn uses isolated namespaces, no host binds and exact disposable path', () => {
  const name = 'sr-custody-canary-0123456789abcdef';
  const args = nspawnArgs(`/mnt/tests/${name}/rootfs`, name);
  assert.ok(args.includes('--private-users=no'));
  assert.ok(args.includes('--private-network'));
  assert.ok(args.includes('--settings=no'));
  assert.ok(!args.some(arg => arg.startsWith('--bind')));
  assert.throws(() => nspawnArgs('/var/lib/machines/production', 'production'));
  assert.throws(() => nspawnArgs('/mnt/production', name));
});
test('manifest binds contents and rejects symlink escape', () => {
  const directory = mkdtempSync(join(tmpdir(), 'custody-canary-unit-'));
  try {
    writeFileSync(join(directory, 'a'), 'one');
    const first = treeDigest(directory);
    assert.equal(first, treeDigest(directory));
    writeFileSync(join(directory, 'a'), 'two');
    assert.notEqual(first, treeDigest(directory));
    symlinkSync('/etc/passwd', join(directory, 'escape'));
    assert.throws(() => treeDigest(directory));
  } finally { rmSync(directory, { recursive: true }); }
});
