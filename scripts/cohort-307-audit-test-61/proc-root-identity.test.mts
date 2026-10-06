import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { validateReport } from './cohort-audit.mts';

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

def chain(path,selected=budget):
    value=p['DirectoryChain'](path,selected);chains.append(value);return value

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
    diagnostic_source=spec['root']+'/diagnostic-source';diagnostic_target=spec['root']+'/diagnostic-target';os.mkdir(diagnostic_source);os.mkdir(diagnostic_target)
    assert p['object_pin'](os.lstat(diagnostic_source))!=p['object_pin'](os.lstat(diagnostic_target))
    diagnostic_replacement=chain(diagnostic_target,p['Budget'](10));diagnostic_mounted=False;diagnostic_parent_before=os.stat(spec['root']);diagnostic_target_before=os.lstat(diagnostic_target)
    try:
        subprocess.run(['/usr/bin/mount','--bind',diagnostic_source,diagnostic_target],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=5);diagnostic_mounted=True
        assert p['pin'](os.stat(spec['root']))==p['pin'](diagnostic_parent_before) and p['object_pin'](os.stat(diagnostic_target))==p['object_pin'](os.lstat(diagnostic_source))
        assert refused(diagnostic_replacement) and diagnostic_replacement.budget.failure_facts==[{'gate':'AncestorNamed','facet':'Inode'}]
    finally:
        if diagnostic_mounted:
            subprocess.run(['/usr/bin/umount',diagnostic_target],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=5)
            assert p['object_pin'](os.lstat(diagnostic_target))==p['object_pin'](diagnostic_target_before)
    unverified_nonproc=chain(leaf);nonproc_rejected=False
    try:unverified_nonproc._bind_proc_root(mount)
    except p['Refusal'] as error:nonproc_rejected=str(error)=='HostProcViewUnknown'
    identity_budget=p['Budget'](10);jail=spec['root']+'/identity-jail';os.mkdir(jail)
    child=subprocess.Popen(['/usr/bin/python3','-B','-c',"import os,sys;print(os.getpid(),flush=True);sys.stdin.buffer.read(1);os.chroot(sys.argv[1]);os.chdir('/');print('CHROOTED',flush=True);sys.stdin.buffer.read(1)",jail],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
    children.append(child);member=None;root_fd=None;view=None
    try:
        import select
        assert select.select([child.stdout],[],[],3)[0] and int(child.stdout.readline(32))==child.pid
        member=os.open('/proc/'+str(child.pid)+'/task/'+str(child.pid),p['O_DIR']);before=p['identity'](member,identity_budget)
        root_fd=os.open('root',os.O_RDONLY|os.O_DIRECTORY|os.O_CLOEXEC,dir_fd=member)
        view=p['MountView'](member,before,root_fd,identity_budget);identity_budget.heap_reserve(512);view.members.append((child.pid,child.pid,before))
        child.stdin.write(b'X');child.stdin.flush();assert select.select([child.stdout],[],[],3)[0] and child.stdout.readline(32)==b'CHROOTED\\n'
        assert p['object_pin'](os.stat('root',dir_fd=member))==p['object_pin'](os.lstat(jail))
        try:view.validate(verified.fd)
        except p['Refusal'] as error:assert str(error)=='ProcessIdentityDrift'
        else:raise AssertionError()
        assert identity_budget.failure_facts==[{'gate':'FinalMemberCompare','facet':'PhysicalRootPin'}]
    finally:
        if view is not None:view.close()
        if root_fd is not None:os.close(root_fd)
        if member is not None:os.close(member)
        if child.poll() is None:child.kill()
        child.communicate(timeout=3);children.remove(child)
    same_before=os.fstat(verified.fd)
    subprocess.run(['/usr/bin/mount','--bind','/proc','/proc'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=5);mounted=True
    fresh=os.open('/proc',p['O_DIR'])
    try:
        same_after=os.fstat(fresh)
        same_object=(same_before.st_dev,same_before.st_ino)==(same_after.st_dev,same_after.st_ino)
        new_mount=p['mount_id'](fresh,budget)!=p['mount_id'](verified.fd,budget)
    finally:os.close(fresh)
    overmount=refused(verified)
    assert {'gate':'AncestorReopened','facet':'RootMountIdentity'} in budget.failure_facts
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

// One native lifecycle boundary: real child limits, genuine own census, distinct roots.
test('finite child descriptor qualification preserves parent limits and refuses the next unsupported roster', { timeout: 45_000 }, () => {
  assert.equal(process.platform, 'linux'); assert.equal(process.getuid?.(), 0);
  let root: string | undefined;
  try {
    root = mkdtempSync(join(tmpdir(), 'TEST-fd-qualification-'));
    const encoded = Buffer.from(JSON.stringify({ root, payload: join(artifact, 'audit-payload.py') })).toString('base64');
    const childCode = String.raw`
import base64,ctypes,json,os,resource,runpy,select,subprocess,sys
spec=json.loads(base64.b64decode(sys.argv[1]));mode=sys.argv[2];p=runpy.run_path(spec['payload']);budget=p['Budget'](25)
lib=ctypes.CDLL(None,use_errno=True);lib.umount2.argtypes=[ctypes.c_char_p,ctypes.c_int];lib.mount.argtypes=[ctypes.c_char_p,ctypes.c_char_p,ctypes.c_char_p,ctypes.c_ulong,ctypes.c_void_p]
assert lib.umount2(b'/proc',2)==0 and lib.mount(b'proc',b'/proc',b'proc',0,None)==0
p['preflight'].__globals__['MACHINE']=spec['machine'];facts=p['preflight'](budget);parent=p['DirectoryChain'](spec['root'],budget)
fillers=[];owned_before=set(budget.owned);tasks=[];roots=[];views=[];child=None;directory=None;inventory=None;active_ns=[];active_root=None;active_task=None

def own_count():
    census=os.open('fd',p['O_DIR'],dir_fd=facts['selfFd'])
    try:return len(p['bounded_names'](census,4096,budget,True))
    finally:os.close(census)
try:
    original=resource.getrlimit(resource.RLIMIT_NOFILE);assert original[1]==resource.RLIM_INFINITY or original[1]>=4096
    if mode=='hard':
        resource.setrlimit(resource.RLIMIT_NOFILE,(512,512))
        try:p['qualify_proc_resources'](facts['selfFd'],budget)
        except p['Refusal'] as error:assert str(error)=='FdLimit'
        else:raise AssertionError()
        q=budget.resource_qualification;assert q['status']=='Unknown' and q['reason']=='FdLimit' and q['softBefore']==q['softAfter']=='512' and q['hardBefore']==q['hardAfter']=='512'
        print(json.dumps({'qualification':q,'rosterComplete':False,'nextRefused':True,'closedBaseline':True}))
    else:
        resource.setrlimit(resource.RLIMIT_NOFILE,(1024,original[1]));q=p['qualify_proc_resources'](facts['selfFd'],budget)
        assert q['status']=='Qualified' and q['softBefore']=='1024' and q['softAfter']=='4096' and q['hardBefore']==q['hardAfter']
        baseline=own_count();jail=spec['root']+'/jail';os.mkdir(jail)
        child=subprocess.Popen([sys.executable,'-B','-c',"import os,sys;os.chroot(sys.argv[1]);os.chdir('/');print(os.getpid(),flush=True);sys.stdin.buffer.read(1)",jail],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
        assert select.select([child.stdout],[],[],3)[0] and int(child.stdout.readline(32))==child.pid
        for pid in (os.getpid(),child.pid):
            task=os.open('/proc/'+str(pid)+'/task/'+str(pid),p['O_DIR']);tasks.append(task);roots.append(os.open('root',os.O_RDONLY|os.O_DIRECTORY|os.O_CLOEXEC,dir_fd=task))
        before=[p['identity'](task,budget) for task in tasks];assert before[0][5]!=before[1][5]
        count=own_count();assert count<1014
        for _ in range(1014-count):fillers.append(os.open('/dev/null',os.O_RDONLY|os.O_CLOEXEC))
        assert own_count()==1014
        view=p['MountView'](tasks[0],before[0],roots[0],budget);views.append(view)
        active_task=os.open('/proc/'+str(os.getpid())+'/task/'+str(os.getpid()),p['O_DIR']);active_root=budget.own(os.open('root',os.O_RDONLY|os.O_DIRECTORY|os.O_CLOEXEC,dir_fd=active_task));active_ns=p['retain_namespaces'](active_task,budget)
        directory=os.open('fd',p['O_DIR'],dir_fd=active_task);inventory=p['FdInventory'](directory,budget);names=inventory.names(1024)
        assert {str(fd) for fd in fillers+tasks+roots+[active_task,active_root,directory,inventory.fd]+active_ns}<=set(names)
        for name in names:os.readlink(name,dir_fd=directory);os.stat(name,dir_fd=directory)
        inventory.verify(names,1024);inventory.close();inventory=None;os.close(directory);directory=None
        for fd in reversed(active_ns):budget.close(fd)
        active_ns=[];budget.close(active_root);active_root=None;os.close(active_task);active_task=None
        try:p['MountView'](tasks[1],before[1],roots[1],budget)
        except p['Refusal'] as error:assert str(error)=='FdLimit'
        else:raise AssertionError()
        failure=budget.fd_envelope_failure;assert failure is not None and failure['ownDescriptorCount']==1017 and failure['reason']=='FdLimit'
        for value in reversed(views):value.close()
        views=[]
        for fd in reversed(roots+tasks+fillers):os.close(fd)
        roots=[];tasks=[];fillers=[]
        child.kill();child.communicate(timeout=3);child=None
        assert set(budget.owned)==owned_before and own_count()==baseline
        print(json.dumps({'qualification':q,'rosterComplete':True,'nextRefused':True,'closedBaseline':True}))
finally:
    if inventory is not None:inventory.close()
    if directory is not None:os.close(directory)
    for fd in reversed(active_ns):budget.close(fd)
    if active_root is not None:budget.close(active_root)
    if active_task is not None:os.close(active_task)
    for value in reversed(views):value.close()
    for fd in reversed(roots+tasks+fillers):os.close(fd)
    if child is not None:
        if child.poll() is None:child.kill()
        child.communicate(timeout=3)
    parent.close();p['close_preflight'](facts)
`;
    const outer = String.raw`
import base64,json,resource,subprocess
spec=json.loads(base64.b64decode('__SPEC__'));spec['machine']=open('/etc/machine-id').read().strip();encoded=base64.b64encode(json.dumps(spec).encode()).decode()
before=resource.getrlimit(resource.RLIMIT_NOFILE);results=[]
for mode in ('soft','hard'):
    child=subprocess.run(['/usr/bin/unshare','--mount','--pid','--fork','--kill-child=SIGKILL','--propagation','private','/usr/bin/python3','-B','-c',spec['child'],encoded,mode],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=18)
    assert child.returncode==0 and not child.stderr and len(child.stdout)<4096
    results.append(json.loads(child.stdout))
assert resource.getrlimit(resource.RLIMIT_NOFILE)==before
print(json.dumps({'parentUnchanged':True,'results':results}))
`;
    const spec = Buffer.from(JSON.stringify({ root, payload: join(artifact, 'audit-payload.py'), child: childCode })).toString('base64');
    let result: unknown;
    try { result = JSON.parse(execFileSync('/usr/bin/python3', ['-B', '-c', outer.replace('__SPEC__', spec)],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 40_000, maxBuffer: 8192 })); }
    catch { throw new Error('Finite descriptor qualification fixture failed'); }
    assert.ok(result !== null && typeof result === 'object');
    const envelope = result as { parentUnchanged: unknown; results: unknown };
    assert.equal(envelope.parentUnchanged, true); assert.ok(Array.isArray(envelope.results)); assert.equal(envelope.results.length, 2);
    const base = { schemaVersion: 1, mode: 'ProcReferences', cohortSha256: '8b0467e9cdf7d83bace82df97893ed77e9f311dcd83110a18cbfcd0fc01a7da4', necessaryBytes: 'Unknown', futureAdmissionCoverage: 'Unknown', cleanupEligibility: 'NotEstablished', status: 'Incomplete' };
    for (const item of envelope.results) {
      assert.ok(item !== null && typeof item === 'object'); const row = item as Record<string, unknown>;
      validateReport({ ...base, resourceQualification: row.qualification }, 'ProcReferences', '{"cohort":[]}');
      assert.equal(row.nextRefused, true); assert.equal(row.closedBaseline, true);
    }
    const positive = envelope.results[0] as Record<string, unknown>, negative = envelope.results[1] as Record<string, unknown>;
    assert.equal(positive.rosterComplete, true); assert.equal(negative.rosterComplete, false);
    const qualified = positive.qualification as Record<string, unknown>;
    assert.throws(() => validateReport({ ...base, resourceQualification: { ...qualified, hardAfter: '4095' } }, 'ProcReferences', '{"cohort":[]}'));
    assert.throws(() => validateReport({ ...base, resourceQualification: { ...qualified, softAfter: 'Infinity' } }, 'ProcReferences', '{"cohort":[]}'));
    assert.throws(() => validateReport({ ...base, failureFacts: [{ gate: 'DiscoveryCompare', facet: '/private/raw' }] }, 'ProcReferences', '{"cohort":[]}'));
  } finally {
    if (root !== undefined) { try { rmSync(root, { recursive: true, force: true }); } catch { throw new Error('Finite descriptor qualification fixture cleanup failed'); } }
  }
});
