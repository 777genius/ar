import assert from 'node:assert/strict';
import { AssertionError } from 'node:assert';
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
// Supplemental closed diagnostics; these facts never replace any required guard.
const Phase = { ParentPreflight: 'ParentPreflight', ParentStaging: 'ParentStaging', ParentNamespacePins: 'ParentNamespacePins',
  ParentNamespaceLaunch: 'ParentNamespaceLaunch', ParentNamespaceResult: 'ParentNamespaceResult', ParentNamespaceJoin: 'ParentNamespaceJoin',
  ParentMountJoin: 'ParentMountJoin', ParentSourceJoin: 'ParentSourceJoin', ParentCleanup: 'ParentCleanup',
  ChildPreflight: 'ChildPreflight', ChildArguments: 'ChildArguments', ChildIdentity: 'ChildIdentity', ChildStaging: 'ChildStaging',
  ChildMaps: 'ChildMaps', ChildNamespacePins: 'ChildNamespacePins', ChildPropagation: 'ChildPropagation', ChildSuiteLaunch: 'ChildSuiteLaunch',
  ChildSuiteResult: 'ChildSuiteResult', ChildSuiteCounts: 'ChildSuiteCounts' } as const;
type Phase = (typeof Phase)[keyof typeof Phase];
const childPhases = [Phase.ChildPreflight, Phase.ChildArguments, Phase.ChildIdentity, Phase.ChildStaging, Phase.ChildMaps,
  Phase.ChildNamespacePins, Phase.ChildPropagation, Phase.ChildSuiteLaunch, Phase.ChildSuiteResult, Phase.ChildSuiteCounts] as const;
const names = ['physical allocation deduplicates regular AND long symlink inodes without target reads',
  'prefix collision is Workspace only; exact real FD and mapping inode joins find Dependencies',
  'symlink refusal, incremental entry cap and replaced root leave no fixture-target FD leaks',
  'operator accepts only one explicit mode/partition and rejects raw payload/zero-needed claims',
  'AuditOwned needs exact own birth AND tracked FD; a genuine TEST child stays external',
  'real307 TEST roots select four/final-three only and retain cross-partition hardlink facts',
  'actual unrecorded/chroot inherited readers and mounted objects are joined; audit-owned FDs stay separate',
  'allocated walker rejects real SAME-device directory and file bind mounts'] as const;
type Name = (typeof names)[number];
const summaryKeys = ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'] as const;
type Summary = Record<(typeof summaryKeys)[number], number | null>;
type Row = { ordinal: number; test: Name; outcome: 'Passed' | 'Failed' | 'Unknown' };
type Tap = { status: 'Complete' | 'Unknown'; plan: number | null; summary: Summary; rows: Row[]; unknownRows: number; truncated: boolean };
const codes = ['None', 'EACCES', 'EPERM', 'ENOENT', 'EINVAL', 'ETIMEDOUT', 'ENOBUFS', 'EIO', 'Other'] as const;
type Code = (typeof codes)[number];
type ProcessFacts = { status: number | null; signal: 'None' | 'SIGKILL' | 'SIGTERM' | 'Other'; error: Code };
type Reason = 'Assertion' | 'SystemError' | 'Unknown';
type Diagnostic = { version: 1; role: 'Parent' | 'Child'; phase: Phase; reason: Reason;
  process: ProcessFacts | null; tap: Tap | null; child: Diagnostic | null };
const prefix = 'AUDIT_TEST_DIAGNOSTIC ';
const role = process.argv.length === 2 ? 'Parent' : 'Child';
let phase: Phase = role === 'Parent' ? Phase.ParentPreflight : Phase.ChildPreflight;
let processFacts: ProcessFacts | null = null, tapFacts: Tap | null = null, childFacts: Diagnostic | null = null;
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean { const own = Object.keys(value); return own.length === keys.length && own.every(k => keys.includes(k)); }
function bounded(value: unknown, max: number): value is number { return Number.isSafeInteger(value) && typeof value === 'number' && value >= 0 && value <= max; }
function code(error: unknown): Code {
  if (error === null || error === undefined) return 'None';
  const raw: unknown = object(error) ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
  return codes.find(c => c !== 'None' && c === raw) ?? 'Other';
}
function observedProcess(value: { status: number | null; signal: string | null; error?: unknown }): ProcessFacts {
  return { status: bounded(value.status, 255) ? value.status : null,
    signal: value.signal === null ? 'None' : value.signal === 'SIGKILL' || value.signal === 'SIGTERM' ? value.signal : 'Other', error: code(value.error) };
}
function emptyTap(): Tap { return { status: 'Unknown', plan: null, summary: { tests: null, pass: null, fail: null, cancelled: null, skipped: null, todo: null }, rows: [], unknownRows: 0, truncated: false }; }
function parseTap(text: unknown): Tap {
  const facts = emptyTap(); if (typeof text !== 'string') return facts;
  if (Buffer.byteLength(text) > 1024 * 1024) { facts.truncated = true; return facts; }
  let plan: number | null = null, invalid = false, lines = 0;
  const seenSummary = new Set<keyof Summary>();
  if (!text.startsWith('TAP version 13\n')) return facts;
  for (let offset = 0; offset < text.length;) {
    const next = text.indexOf('\n', offset), end = next < 0 ? text.length : next;
    if (++lines > 4096 || end - offset > 4096) { facts.truncated = true; break; }
    const line = text.slice(offset, end); offset = next < 0 ? end : end + 1;
    if (Buffer.byteLength(line) > 4096) { facts.truncated = true; break; }
    const planned = /^1\.\.(0|[1-9][0-9]?)$/.exec(line);
    if (planned) { const count = Number(planned[1]); if (plan !== null || count > 32) invalid = true; else plan = count; continue; }
    const row = /^(ok|not ok) ([1-9][0-9]?) - (.+)$/.exec(line);
    if (row) {
      if (plan !== null) invalid = true;
      const ordinal = Number(row[2]), rendered = row[3] ?? '';
      const directive = / # (SKIP|TODO)(?: |$)/.exec(rendered), title = directive ? rendered.slice(0, directive.index) : rendered;
      const test = names.find(name => name === title);
      if (!test || ordinal > 8) { facts.unknownRows = Math.min(4096, facts.unknownRows + 1); invalid = true; continue; }
      const duplicate = facts.rows.find(r => r.ordinal === ordinal || r.test === test);
      if (duplicate) { duplicate.outcome = 'Unknown'; invalid = true; continue; }
      if (facts.rows.length === 8) { facts.truncated = true; break; }
      facts.rows.push({ ordinal, test, outcome: directive ? 'Unknown' : row[1] === 'ok' ? 'Passed' : 'Failed' }); continue;
    }
    if (line.startsWith('ok ') || line.startsWith('not ok ')) { facts.unknownRows = Math.min(4096, facts.unknownRows + 1); invalid = true; }
    if (line.startsWith('1..') || lines > 1 && line.startsWith('TAP version ')) invalid = true;
    // Only trailer summary diagnostics, never indented YAML or forwarded '# ...' result rows.
    if (plan !== null) {
      const summary = /^# (tests|pass|fail|cancelled|skipped|todo) (0|[1-9][0-9]?)$/.exec(line);
      if (!summary && /^# (tests|pass|fail|cancelled|skipped|todo)(?: |$)/.test(line)) invalid = true;
      if (summary) {
        const key = summaryKeys.find(k => k === summary[1]), count = Number(summary[2]);
        if (!key) invalid = true;
        else if (seenSummary.has(key) || count > 32) { seenSummary.add(key); facts.summary[key] = null; invalid = true; }
        else { seenSummary.add(key); facts.summary[key] = count; }
      }
    }
  }
  facts.plan = plan;
  const summary = facts.summary;
  if (!invalid && !facts.truncated && plan === 8 && facts.rows.length === 8 &&
      facts.rows.every((r, i) => r.ordinal === i + 1 && r.test === names[i] && r.outcome !== 'Unknown') &&
      summary.tests === 8 && summary.pass !== null && summary.fail !== null && summary.pass + summary.fail === 8 &&
      summary.pass === facts.rows.filter(r => r.outcome === 'Passed').length && summary.fail === facts.rows.filter(r => r.outcome === 'Failed').length &&
      summary.cancelled === 0 && summary.skipped === 0 && summary.todo === 0) facts.status = 'Complete';
  return facts;
}
function closedTap(value: unknown): Tap | null {
  if (!object(value) || !exact(value, ['status', 'plan', 'summary', 'rows', 'unknownRows', 'truncated']) ||
      value.status !== 'Complete' && value.status !== 'Unknown' || value.plan !== null && !bounded(value.plan, 32) || !object(value.summary) || !exact(value.summary, summaryKeys) ||
      !Array.isArray(value.rows) || value.rows.length > 8 || !bounded(value.unknownRows, 4096) || typeof value.truncated !== 'boolean') return null;
  const result = emptyTap(); result.status = value.status; result.plan = value.plan; result.unknownRows = value.unknownRows; result.truncated = value.truncated;
  for (const key of summaryKeys) { const count = value.summary[key]; if (count !== null && !bounded(count, 32)) return null; result.summary[key] = count; }
  for (const entry of value.rows) {
    if (!object(entry) || !exact(entry, ['ordinal', 'test', 'outcome']) || !bounded(entry.ordinal, 8) || entry.ordinal === 0 ||
        entry.outcome !== 'Passed' && entry.outcome !== 'Failed' && entry.outcome !== 'Unknown') return null;
    const test = names.find(name => name === entry.test); if (!test || result.rows.some(r => r.ordinal === entry.ordinal || r.test === test)) return null;
    result.rows.push({ ordinal: entry.ordinal, test, outcome: entry.outcome });
  }
  const counts = result.summary;
  if (result.status === 'Complete' && (result.plan !== 8 || result.truncated || result.unknownRows !== 0 || result.rows.length !== 8 ||
      !result.rows.every((r, i) => r.ordinal === i + 1 && r.test === names[i] && r.outcome !== 'Unknown') || counts.tests !== 8 ||
      counts.pass !== result.rows.filter(r => r.outcome === 'Passed').length || counts.fail !== result.rows.filter(r => r.outcome === 'Failed').length ||
      counts.cancelled !== 0 || counts.skipped !== 0 || counts.todo !== 0)) return null;
  return result;
}
function childDiagnostic(text: unknown): Diagnostic | null {
  if (typeof text !== 'string') return null;
  if (Buffer.byteLength(text) > 1024 * 1024) return null;
  let marker: Diagnostic | null = null, matches = 0, lines = 0;
  for (let offset = 0; offset < text.length;) {
    const next = text.indexOf('\n', offset), end = next < 0 ? text.length : next;
    if (++lines > 4096 || end - offset > 16 * 1024) return null;
    const line = text.slice(offset, end); offset = next < 0 ? end : end + 1;
    if (Buffer.byteLength(line) > 16 * 1024) return null;
    if (!line.startsWith(prefix)) continue;
    if (++matches !== 1) return null;
    let value: unknown; try { value = JSON.parse(line.slice(prefix.length)); } catch { return null; }
    if (!object(value) || !exact(value, ['version', 'role', 'phase', 'reason', 'process', 'tap', 'child']) || value.version !== 1 ||
        value.role !== 'Child' || value.child !== null || value.reason !== 'Assertion' && value.reason !== 'SystemError' && value.reason !== 'Unknown') return null;
    const childPhase = childPhases.find(p => p === value.phase); if (!childPhase) return null;
    let observed: ProcessFacts | null = null;
    if (value.process !== null) {
      const p = value.process;
      if (!object(p) || !exact(p, ['status', 'signal', 'error']) || p.status !== null && !bounded(p.status, 255) ||
          p.signal !== 'None' && p.signal !== 'SIGKILL' && p.signal !== 'SIGTERM' && p.signal !== 'Other') return null;
      const error = codes.find(c => c === p.error); if (!error) return null;
      observed = { status: p.status, signal: p.signal, error };
    }
    const tap = value.tap === null ? null : closedTap(value.tap); if (value.tap !== null && tap === null) return null;
    marker = { version: 1, role: 'Child', phase: childPhase, reason: value.reason, process: observed, tap, child: null };
  }
  return marker;
}
function emitDiagnostic(error: unknown): void {
  const reason: Reason = error instanceof AssertionError ? 'Assertion' : code(error) !== 'None' && code(error) !== 'Other' ? 'SystemError' : 'Unknown';
  const value: Diagnostic = { version: 1, role, phase, reason, process: processFacts, tap: tapFacts, child: childFacts };
  const line = prefix + JSON.stringify(value);
  console.error(Buffer.byteLength(line) <= 16 * 1024 ? line : prefix + JSON.stringify({ ...value, tap: null, child: null }));
}

try {
  assert.equal(process.platform, 'linux'); assert.equal(process.env.CI, 'true'); assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert.equal(process.versions.node, '22.23.3'); assert.equal(process.getuid?.(), 0); assert.equal(process.getgid?.(), 0);
  if (process.argv.length === 2) {
    phase = Phase.ParentStaging;
    const root = mkdtempSync('/tmp/TEST-cohort-audit-namespace-'), staged = join(root, 'helper'); mkdirSync(staged, { mode: 0o700 });
    mkdirSync(join(staged, 'input'), { mode: 0o700 }); mkdirSync(join(staged, 'tmp'), { mode: 0o700 });
    for (const path of files) { const bytes = sourceBytes(join(source, path)); writeFileSync(join(staged, path), bytes, { flag: 'wx', mode: 0o600 }); assert.equal(sha(sourceBytes(join(staged, path))), sha(bytes)); }
    const fds: number[] = [];
    try {
      phase = Phase.ParentNamespacePins;
      for (const name of namespaces) fds.push(openSync(`/proc/self/ns/${name}`, constants.O_RDONLY));
      const before = fds.map(pin), mounts = targetMounts(root);
      phase = Phase.ParentNamespaceLaunch;
      const result = spawnSync('/usr/bin/unshare', ['--user', '--map-root-user', '--mount', '--pid', '--fork', '--mount-proc',
        '--propagation', 'private', '--kill-child=SIGKILL', '--', process.execPath, '--experimental-strip-types',
        join(staged, 'run-owned-ci-test.mts'), '--inside', root], { cwd: staged, uid: 0, gid: 0,
        env: { PATH: '/usr/bin:/bin', CI: 'true', GITHUB_ACTIONS: 'true', TMPDIR: join(staged, 'tmp') },
        stdio: ['ignore', 'pipe', 'pipe', ...fds], encoding: 'utf8', timeout: 90_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
      phase = Phase.ParentNamespaceResult; processFacts = observedProcess(result); childFacts = childDiagnostic(result.stderr);
      assert.ok(!result.error && result.status === 0 && result.signal === null, 'owned_TEST_namespace_or_required_suite_failed');
      phase = Phase.ParentNamespaceJoin;
      assert.deepEqual(fds.map(pin), before);
      for (const [index, name] of namespaces.entries()) {
        const fresh = openSync(`/proc/self/ns/${name}`, constants.O_RDONLY);
        try { assert.equal(pin(fresh), before[index]); } finally { closeSync(fresh); }
      }
      phase = Phase.ParentMountJoin;
      assert.deepEqual(targetMounts(root), mounts, 'TEST mounts propagated into parent');
      phase = Phase.ParentSourceJoin;
      for (const path of files) assert.equal(sha(sourceBytes(join(source, path))), sha(sourceBytes(join(staged, path))));
      console.log(JSON.stringify({ status: 'Passed', scope: 'NEW-owned-TEST-only', tests: 8, skipped: 0,
        parentNamespacesUnchanged: true, parentTargetMountsUnchanged: true, sourceBytesUnchanged: true, hostAuditExecuted: false }));
      phase = Phase.ParentCleanup;
      rmSync(root, { recursive: true }); // Only owned staging after joined PID namespace teardown.
    } finally { for (const fd of fds.reverse()) closeSync(fd); }
  } else {
    phase = Phase.ChildArguments;
    assert.equal(process.argv.length, 4); assert.equal(process.argv[2], '--inside'); const root = process.argv[3];
    assert.ok(root && /^\/tmp\/TEST-cohort-audit-namespace-[A-Za-z0-9]+$/.test(root));
    phase = Phase.ChildIdentity;
    assert.equal(source, join(root, 'helper')); assert.equal(process.pid, 1);
    assert.equal(process.getegid?.(), 0); assert.equal(process.geteuid?.(), 0); assert.deepEqual(process.getgroups?.(), [0]);
    phase = Phase.ChildStaging;
    for (const path of [root, source, join(source, 'tmp')]) {
      const s = lstatSync(path); assert.ok(s.isDirectory() && !s.isSymbolicLink());
      assert.equal(s.uid, 0); assert.equal(s.gid, 0); assert.equal(s.mode & 0o7777, 0o700);
    }
    phase = Phase.ChildMaps;
    assert.match(readFileSync('/proc/self/uid_map', 'utf8').trim(), /^0\s+0\s+1$/);
    assert.match(readFileSync('/proc/self/gid_map', 'utf8').trim(), /^0\s+0\s+1$/);
    phase = Phase.ChildNamespacePins;
    for (const [index, name] of namespaces.entries()) {
      const fd = openSync(`/proc/self/ns/${name}`, constants.O_RDONLY);
      try { assert.notEqual(pin(fd), pin(3 + index)); } finally { closeSync(fd); }
      closeSync(3 + index);
    }
    phase = Phase.ChildPropagation;
    for (const line of readFileSync('/proc/self/mountinfo', 'utf8').trim().split('\n')) {
      const fields = line.split(' '), separator = fields.indexOf('-'); assert.ok(separator >= 6);
      assert.ok(!fields.slice(6, separator).some(x => /^(shared|master|propagate_from):/.test(x)), 'TEST propagation not private');
    }
    phase = Phase.ChildSuiteLaunch;
    const result = spawnSync(process.execPath, ['--experimental-strip-types', '--test',
      join(source, 'audit-helper.test.mts'), join(source, 'audit-helper.namespace.test.mts')], { cwd: source,
      env: { PATH: '/usr/bin:/bin', CI: 'true', GITHUB_ACTIONS: 'true', TMPDIR: join(source, 'tmp'), TEST_AUDIT_OWNED_NAMESPACE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
    phase = Phase.ChildSuiteResult; processFacts = observedProcess(result); tapFacts = parseTap(result.stdout);
    assert.ok(!result.error && result.status === 0 && result.signal === null, 'required_TEST_suite_failed');
    phase = Phase.ChildSuiteCounts;
    for (const line of ['# tests 8', '# pass 8', '# fail 0', '# cancelled 0', '# skipped 0', '# todo 0']) assert.ok(result.stdout.split('\n').includes(line));
  }
} catch (error: unknown) { emitDiagnostic(error); console.error('Finite owned CI TEST failed; no host audit or cleanup was executed.'); process.exitCode = 1; }
