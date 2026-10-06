import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const artifact = dirname(fileURLToPath(import.meta.url));
// Native procfs identity boundary, separate from the required eight namespace cases.
test('verified procfs root tolerates only volatile link counts and rejects replacement mounts', { timeout: 45_000 }, () => {
  assert.equal(process.platform, 'linux');
  assert.equal(process.getuid?.(), 0);
  let root: string | undefined;
  try {
    root = mkdtempSync(join(tmpdir(), 'TEST-proc-root-identity-'));
    const encoded = Buffer.from(JSON.stringify({ root, payload: join(artifact, 'audit-payload.py') })).toString('base64');
    let result: unknown;
    try {
      result = JSON.parse(execFileSync('/usr/bin/unshare', ['--mount', '--fork', '--kill-child=SIGKILL', '--propagation', 'private',
        '/usr/bin/python3', '-B', '-c', `
import base64,json,os,runpy,subprocess
spec=json.loads(base64.b64decode('${encoded}'));p=runpy.run_path(spec['payload']);budget=p['Budget'](30)
chains=[];children=[];mounted=False

def chain(path):
    value=p['DirectoryChain'](path,budget);chains.append(value);return value

def refused(value):
    try:value.current()
    except p['Refusal'] as error:return str(error)=='AncestorDrift'
    return False

try:
    verified=chain('/proc')
    parent=os.open('self',os.O_RDONLY|os.O_DIRECTORY|os.O_CLOEXEC,dir_fd=verified.fd)
    try:rows,_=p['mount_table'](parent,budget)
    finally:os.close(parent)
    mount,_=p['filesystem_path']('/proc',rows)
    verified._bind_proc_root(mount)
    ordinary_proc=chain('/proc');before=os.fstat(verified.fd).st_nlink
    for _ in range(32):
        child=subprocess.Popen(['/usr/bin/python3','-B','-c','import sys;sys.stdin.buffer.read()'],stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        children.append(child)
    churn=os.fstat(verified.fd).st_nlink!=before
    verified.current()
    strict_proc=refused(ordinary_proc)
    for child in children:
        child.communicate(timeout=5)
    children=[]
    leaf=spec['root']+'/ordinary';os.mkdir(leaf);ordinary=chain(leaf)
    os.mkdir(leaf+'/child');ordinary_nlink=refused(ordinary)
    os.rmdir(leaf+'/child');replacement=chain(leaf)
    os.rename(leaf,leaf+'-old');os.mkdir(leaf);replaced=refused(replacement)
    unverified_nonproc=chain(leaf);nonproc_rejected=False
    try:unverified_nonproc._bind_proc_root(mount)
    except p['Refusal'] as error:nonproc_rejected=str(error)=='HostProcViewUnknown'
    same_before=os.fstat(verified.fd)
    subprocess.run(['/usr/bin/mount','--bind','/proc','/proc'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=5);mounted=True
    fresh=os.open('/proc',p['O_DIR'])
    try:
        same_after=os.fstat(fresh)
        same_object=(same_before.st_dev,same_before.st_ino)==(same_after.st_dev,same_after.st_ino)
        new_mount=p['mount_id'](fresh,budget)!=p['mount_id'](verified.fd,budget)
    finally:os.close(fresh)
    overmount=refused(verified)
    print(json.dumps({'churn':churn,'verifiedStable':True,'unverifiedProcStrict':strict_proc,'ordinaryNlinkStrict':ordinary_nlink,'replacementStrict':replaced,'nonprocRejected':nonproc_rejected,'sameObjectOvermount':same_object,'distinctMount':new_mount,'overmountStrict':overmount}))
finally:
    for child in children:
        if child.poll() is None:child.kill()
        child.communicate(timeout=5)
    if mounted:subprocess.run(['/usr/bin/umount','/proc'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=5)
    for value in reversed(chains):value.close()
`], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 40_000, maxBuffer: 4096 }));
    } catch { throw new Error('Native procfs identity fixture failed'); }
    assert.deepEqual(result, { churn: true, verifiedStable: true, unverifiedProcStrict: true, ordinaryNlinkStrict: true,
      replacementStrict: true, nonprocRejected: true, sameObjectOvermount: true, distinctMount: true, overmountStrict: true });
  } finally {
    if (root !== undefined) {
      try { rmSync(root, { recursive: true, force: true }); }
      catch { throw new Error('Native procfs identity fixture cleanup failed'); }
    }
  }
});
