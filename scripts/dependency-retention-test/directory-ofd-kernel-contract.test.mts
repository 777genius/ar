/** Proposal only: kernel/OFD semantics, never dependency recovery authority.
 * Future Linux execution requires TMPDIR in a verified job-owned scratch mount.
 * No runtime/provisioning/project actions, no external process signaling.
 */
import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync,
  openSync, readFileSync, renameSync, rmdirSync, statfsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

type Identity = Readonly<{ dev: string; ino: string }>;
type Reply = Readonly<{ status: 'locked' | 'busy' | 'not_inherited'; identity: Identity }>;
type HelperMode = 'shared_fd' | 'separate_open' | 'inheritance_check';
const helper = String.raw`
import fcntl,json,os,stat,sys
mode,path,dev,ino=sys.argv[1:5]; expected=(int(dev),int(ino)); fd=None
try:
 if mode=='inheritance_check':
  for name in os.listdir('/proc/self/fd'):
   try: observed=os.fstat(int(name))
   except OSError: continue
   assert not(stat.S_ISDIR(observed.st_mode) and (observed.st_dev,observed.st_ino)==expected),'unexpected inherited mutex fd'
  status='not_inherited'
 else:
  assert mode in ('shared_fd','separate_open')
  fd=3 if mode=='shared_fd' else os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
  s=os.fstat(fd); assert stat.S_ISDIR(s.st_mode) and (s.st_dev,s.st_ino)==expected,'inode mismatch'
  try: fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB); status='locked'
  except BlockingIOError: status='busy'
 print(json.dumps({'status':status,'identity':{'dev':dev,'ino':ino}},separators=(',',':')))
finally:
 if fd is not None: os.close(fd) # No LOCK_UN: parent duplicate must retain lock.
`;
const identity = (s: { dev: bigint; ino: bigint }): Identity => ({ dev: String(s.dev), ino: String(s.ino) });
function named(path: string): Identity {
  const s = lstatSync(path, { bigint: true }); assert(s.isDirectory() && !s.isSymbolicLink()); return identity(s);
}
function bridge(mode: HelperMode, path: string, expected: Identity, fd?: number): Reply {
  const options: SpawnSyncOptionsWithStringEncoding = {
    encoding: 'utf8', timeout: 2000, killSignal: 'SIGKILL', maxBuffer: 1024,
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    stdio: fd === undefined ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe', fd],
  };
  const result = spawnSync('/usr/bin/python3', ['-I', '-c', helper, mode, path, expected.dev, expected.ino], options);
  assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  const value: unknown = JSON.parse(result.stdout);
  assert(value && typeof value === 'object');
  assert.deepEqual(Object.keys(value).sort(), ['identity', 'status']);
  assert('identity' in value && 'status' in value); assert.deepEqual(value.identity, expected);
  assert(value.status === 'locked' || value.status === 'busy' || value.status === 'not_inherited');
  return { status: value.status, identity: expected };
}

test('Linux directory OFD bridge: retained lock, exact release, separate generations',
  { skip: process.platform !== 'linux' ? 'Linux native kernel contract required; macOS is SKIP, never PASS' : false }, () => {
  assert.equal(process.platform, 'linux');
  // Future launcher supplies a verified scratch directory. No arbitrary project path fallback.
  const base = process.env.TMPDIR; assert(base && resolve(base) === base, 'verified absolute TMPDIR required');
  const basePin = named(base);
  assert.equal(statfsSync(base, { bigint: true }).type, 0xef53n, 'this proposal qualifies local ext4 only');
  const root = mkdtempSync(join(base, 'TEST-activation-ofd-'));
  const rootPin = named(root), canonical = join(root, 'boot-mutex'), archived = join(root, 'old-generation');
  const owned = new Map<string, Identity>(); const handles = new Set<number>();
  const retain = (path: string): number => {
    const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    handles.add(fd); assert.deepEqual(identity(fstatSync(fd, { bigint: true })), named(path));
    const flags = /^flags:\s+([0-7]+)$/m.exec(readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8'));
    assert(flags && (Number.parseInt(flags[1]!, 8) & 0o2000000) !== 0, 'CLOEXEC required'); return fd;
  };
  const close = (fd: number): void => { assert(handles.delete(fd)); closeSync(fd); };
  try {
    mkdirSync(canonical, { mode: 0o700 }); const old = named(canonical); owned.set(canonical, old);
    const writerFd = retain(canonical);
    // Helper exits, but its inherited duplicate shares the Node-owned OFD.
    assert.equal(bridge('shared_fd', canonical, old, writerFd).status, 'locked');
    assert.equal(bridge('separate_open', canonical, old).status, 'busy');
    assert.equal(bridge('inheritance_check', canonical, old).status, 'not_inherited');
    close(writerFd);
    assert.equal(bridge('separate_open', canonical, old).status, 'locked');
    // Recovery pins exactly the original inode and retains a fresh shared OFD lock.
    const recoveryFd = retain(canonical);
    assert.equal(bridge('shared_fd', canonical, old, recoveryFd).status, 'locked');
    assert.equal(bridge('separate_open', canonical, old).status, 'busy');
    // Owned TEST directories only: this is not production no-replace/archive proof.
    renameSync(canonical, archived); owned.delete(canonical); owned.set(archived, old);
    assert.deepEqual(named(archived), old);
    mkdirSync(canonical, { mode: 0o700 }); const next = named(canonical); owned.set(canonical, next);
    assert.notDeepEqual(next, old, 'new generation must be a different inode');
    assert.equal(bridge('separate_open', canonical, next).status, 'locked');
    assert.equal(bridge('separate_open', archived, old).status, 'busy');
    // Holding old OFD conveys no mutex permission/exclusion over replacement inode.
    assert.notDeepEqual(identity(fstatSync(recoveryFd, { bigint: true })), named(canonical));
    close(recoveryFd);
    assert.equal(bridge('separate_open', archived, old).status, 'locked');
    assert.deepEqual(named(canonical), next); assert.deepEqual(named(archived), old);
  } finally {
    for (const fd of handles) closeSync(fd);
    // Only empty known-owned directories, exact identity checked; no recursive rm.
    for (const [path, expected] of [...owned].reverse()) { assert.deepEqual(named(path), expected); rmdirSync(path); }
    assert.deepEqual(named(root), rootPin); rmdirSync(root); assert.deepEqual(named(base), basePin);
  }
});
