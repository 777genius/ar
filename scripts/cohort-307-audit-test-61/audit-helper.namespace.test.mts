import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const artifact = dirname(fileURLToPath(import.meta.url));
function fixture(run: (root: string) => void): void {
  assert.equal(process.platform, 'linux');
  assert.equal(process.env.TEST_AUDIT_OWNED_NAMESPACE, '1', 'Required native suite must use the finite owned CI launcher');
  assert.match(readFileSync('/proc/self/uid_map', 'utf8').trim(), /^0\s+0\s+1$/);
  assert.equal(process.getuid?.(), 0);
  const root = mkdtempSync(join(tmpdir(), 'TEST-audit-native-'));
  try { run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}
function python(root: string, body: string): unknown {
  const encoded = Buffer.from(JSON.stringify({ root, payload: join(artifact, 'audit-payload.py') })).toString('base64');
  return JSON.parse(execFileSync('/usr/bin/python3', ['-B', '-c',
    `import base64,json,os,runpy,subprocess,sys,select\ni=json.loads(base64.b64decode('${encoded}'))\np=runpy.run_path(i['payload']);r=i['root']\n${body}`],
    { encoding: 'utf8', timeout: 15_000, maxBuffer: 512 * 1024 }));
}

test('actual unrecorded/chroot inherited readers and mounted objects are joined; audit-owned FDs stay separate', () => fixture(root => {
  const nm = join(root, 'w/node_modules'), alias = join(root, 'alias'); mkdirSync(nm, { recursive: true }); mkdirSync(alias);
  writeFileSync(join(nm, 'dep'), 'TEST'); mkdirSync(join(nm, 'gone')); mkdirSync(join(root, 'detached')); mkdirSync(join(root, 'jail'));
  execFileSync('/usr/bin/mount', ['--bind', nm, alias], { timeout: 3000, stdio: 'pipe' });
  try {
    execFileSync('/usr/bin/mount', ['--bind', join(nm, 'gone'), join(root, 'detached')], { timeout: 3000, stdio: 'pipe' });
    try {
    rmdirSync(join(nm, 'gone')); // Held bind survives; the original source pathname no longer joins.
    const result = python(root, `budget=p['Budget'](10);parent=p['DirectoryChain'](r,budget);proc=p['DirectoryChain']('/proc',budget);self_fd=os.open('/proc/self',os.O_RDONLY|os.O_DIRECTORY)
items=[];child=None;chroot=None;held=None
try:
    mounts,_=p['mount_table'](self_fd,budget);s=os.lstat(r+'/w/node_modules')
    rows=[{'index':0,'name':'w','workspace':r+'/w','dependencies':r+'/w/node_modules','historicalDev':str(s.st_dev),'historicalIno':str(s.st_ino)}]
    items=p['capture_cohort'](rows,parent,mounts,budget)
    ticks=p['birth'](self_fd,budget);facts={'proc':proc,'ownPid':os.getpid(),'ownBirth':ticks,'ownTasks':{os.getpid():ticks},'mounts':mounts}
    child=subprocess.Popen([sys.executable,'-B','-c','import os,sys,mmap; os.chdir(sys.argv[1]); f=os.open("dep",os.O_RDONLY); m=mmap.mmap(f,0,access=mmap.ACCESS_READ); print(os.getpid(),flush=True); sys.stdin.buffer.read(1)',r+'/alias'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
    assert child.stdout is not None and select.select([child.stdout],[],[],3)[0]
    child_pid=int(child.stdout.readline(64));observed=p['proc_observation'](facts,items,budget)
    matches=[m for m in observed['matches'] if m['pid']==child_pid and m['scope']=='Dependencies']
    held=os.open(r+'/w/node_modules/dep',os.O_RDONLY)
    chroot=subprocess.Popen([sys.executable,'-B','-c','import os,sys,mmap; m=mmap.mmap(int(sys.argv[2]),0,access=mmap.ACCESS_READ); os.chroot(sys.argv[1]); os.chdir("/"); print(os.getpid(),flush=True); sys.stdin.buffer.read(1)',r+'/jail',str(held)],pass_fds=(held,),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
    assert chroot.stdout is not None and select.select([chroot.stdout],[],[],3)[0]
    chroot_pid=int(chroot.stdout.readline(64));chroot_proc=os.open('/proc/'+str(chroot_pid),os.O_RDONLY|os.O_DIRECTORY)
    try:
        raw=os.readlink('/proc/'+str(chroot_pid)+'/fd/'+str(held));target_mounts,_=p['mount_table'](chroot_proc,budget)
        root_pinned=p['object_pin'](os.stat('root',dir_fd=chroot_proc))==p['object_pin'](os.lstat(r+'/jail'))
        views_differ=p['filesystem_path'](raw,target_mounts)[1]!=p['filesystem_path'](raw,mounts)[1]
    finally:os.close(chroot_proc)
    second=p['proc_observation'](facts,items,budget)
    inherited=[m for m in second['matches'] if m['pid']==chroot_pid and m['scope']=='Dependencies' and m['kind'] in ('Fd','Map')]
    detached_prefix=any(p['beneath'](m['root'],items[0]['physical']) and m['point']==r+'/detached' for m in mounts)
    direct=[m for m in matches if m['kind']=='DirectMountBinding']
    print(json.dumps({'kinds':sorted(set(m['kind'] for m in matches)),'childExternal':all(m['bucket']=='ExternalCurrentReference' for m in matches),'ownTracked':any(m['bucket']=='AuditOwned' and m['auditCreatedHandle'] is True for m in observed['matches']),'inheritedKinds':sorted(set(m['kind'] for m in inherited)),'inheritedExternal':all(m['bucket']=='ExternalCurrentReference' for m in inherited),'childRootPinned':root_pinned,'collectorRendered':raw==r+'/w/node_modules/dep','viewsDiffer':views_differ,'detachedPrefixExercised':detached_prefix,'directBindings':len(direct),'detachedUnknown':any(x['phase']=='ProcessView' and x['reason']=='ENOENT' for x in budget.errors)}))
finally:
    for process in (chroot,child):
        if process is not None:
            if process.stdin is not None:process.stdin.close()
            try:process.wait(timeout=3)
            except subprocess.TimeoutExpired:process.kill();process.wait(timeout=3)
            if process.stdout is not None:process.stdout.close()
    if held is not None:os.close(held)
    p['close_cohort'](items,budget);os.close(self_fd);proc.close();parent.close()`);
    assert.deepEqual(result, { kinds: ['Cwd', 'DirectMountBinding', 'Fd', 'Map'], childExternal: true, ownTracked: true,
      inheritedKinds: ['Fd', 'Map'], inheritedExternal: true, childRootPinned: true, collectorRendered: true, viewsDiffer: true,
      detachedPrefixExercised: true, directBindings: 1, detachedUnknown: true });
    } finally { execFileSync('/usr/bin/umount', ['--', join(root, 'detached')], { timeout: 3000, stdio: 'pipe' }); }
  } finally { execFileSync('/usr/bin/umount', ['--', alias], { timeout: 3000, stdio: 'pipe' }); }
}));

test('allocated walker rejects real SAME-device directory and file bind mounts', () => fixture(root => {
  const nm = join(root, 'nm'), outside = join(root, 'outside'); mkdirSync(nm); mkdirSync(outside);
  mkdirSync(join(nm, 'bound')); writeFileSync(join(outside, 'sentinel'), 'preserve'); writeFileSync(join(nm, 'file'), 'placeholder');
  const run = (source: string, target: string): void => {
    execFileSync('/usr/bin/mount', ['--bind', source, target], { timeout: 3000, stdio: 'pipe' });
    try {
      const result = python(root, `budget=p['Budget'](10);root=p['DirectoryChain'](r+'/nm',budget);reason=None
try:
    try:p['walk_allocated'](root.fd,budget,{},0)
    except p['Refusal'] as error:reason=str(error)
finally:root.close()
print(json.dumps({'reason':reason,'closed':not budget.owned,'sameDevice':os.lstat(r+'/nm').st_dev==os.lstat(r+'/outside').st_dev}))`);
      assert.deepEqual(result, { reason: 'EntryIdentityOrMountDrift', closed: true, sameDevice: true });
    } finally { execFileSync('/usr/bin/umount', ['--', target], { timeout: 3000, stdio: 'pipe' }); }
  };
  run(outside, join(nm, 'bound')); run(join(outside, 'sentinel'), join(nm, 'file'));
  assert.equal(readFileSync(join(outside, 'sentinel'), 'utf8'), 'preserve');
}));
