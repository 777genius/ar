import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, linkSync, symlinkSync, lstatSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseMode, validateReport } from './cohort-audit.mts';

const artifact = dirname(fileURLToPath(import.meta.url));
// Selected Linux TEST profile is required; no silently skipped mount/proc primitive claim.
function fixture(run: (root: string) => void): void {
  assert.equal(process.platform, 'linux', 'This finite filesystem/proc fixture requires the selected Linux CI profile');
  const root = mkdtempSync(join(tmpdir(), 'TEST-fixed307-audit-'));
  try { run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}
function python(root: string, body: string): unknown {
  const encoded = Buffer.from(JSON.stringify({ root, payload: join(artifact, 'audit-payload.py') })).toString('base64');
  const code = `import base64,json,os,runpy,stat\ni=json.loads(base64.b64decode('${encoded}'))\np=runpy.run_path(i['payload'])\nr=i['root']\n${body}`;
  return JSON.parse(execFileSync('/usr/bin/python3', ['-B', '-c', code], { encoding: 'utf8', timeout: 15_000, maxBuffer: 512 * 1024 }));
}
function uniqueMetadata(roots: readonly string[]): { bytes: bigint; inodes: number } {
  const seen = new Set<string>(); let bytes = 0n;
  const visit = (path: string): void => {
    const s = lstatSync(path, { bigint: true }); const key = `${s.dev}:${s.ino}`;
    if (!seen.has(key)) { seen.add(key); bytes += s.blocks * 512n; }
    if (s.isDirectory()) for (const name of readdirSync(path)) visit(join(path, name));
  };
  for (const root of roots) visit(root);
  return { bytes, inodes: seen.size };
}

test('physical allocation deduplicates regular AND long symlink inodes without target reads', () => fixture(root => {
  const a = join(root, 'a'), b = join(root, 'b'); mkdirSync(a); mkdirSync(b);
  writeFileSync(join(a, 'file'), Buffer.alloc(8192, 7)); linkSync(join(a, 'file'), join(b, 'file-link'));
  writeFileSync(join(a, 'empty'), ''); assert.equal(lstatSync(join(a, 'empty'), { bigint: true }).blocks, 0n);
  symlinkSync('x'.repeat(3000), join(a, 'long-symlink')); linkSync(join(a, 'long-symlink'), join(b, 'symlink-link'));
  assert.equal(lstatSync(join(a, 'long-symlink'), { bigint: true }).ino, lstatSync(join(b, 'symlink-link'), { bigint: true }).ino);
  writeFileSync(join(root, 'outside-sentinel'), 'preserve');
  const expected = uniqueMetadata([a, b]);
  const actual = python(root, `budget=p['Budget'](10); shared={}; totals=[]; inode_counts=[]
for index,name in enumerate(('a','b')):
    chain=p['DirectoryChain'](r+'/'+name,budget)
    try:
        measured=p['walk_allocated'](chain.fd,budget,shared,index)
        totals.append(measured['allocatedUniqueWithinPartitionBytes']);inode_counts.append(measured['uniqueInodes'])
    finally: chain.close()
print(json.dumps({'sum':str(sum(map(int,totals))),'inodes':sum(map(int,inode_counts)),'kinds':sorted(x['fact'][0] for x in shared.values()),'ownedRemaining':len(budget.owned)}))`);
  assert.deepEqual(actual, { sum: String(expected.bytes), inodes: expected.inodes, kinds: ['Regular', 'Symlink'], ownedRemaining: 0 });
  assert.equal(readFileSync(join(root, 'outside-sentinel'), 'utf8'), 'preserve');
}));

test('prefix collision is Workspace only; exact real FD and mapping inode joins find Dependencies', () => fixture(root => {
  const workspace = join(root, 'w'), nm = join(workspace, 'node_modules'); mkdirSync(nm, { recursive: true });
  mkdirSync(`${nm}-other`); writeFileSync(join(nm, 'dep'), 'dep'); writeFileSync(join(`${nm}-other`, 'other'), 'other');
  const actual = python(root, `import mmap
budget=p['Budget'](10); w=p['DirectoryChain'](r+'/w',budget); n=p['DirectoryChain'](r+'/w/node_modules',budget)
try:
    ns=os.fstat(n.fd); ws=os.fstat(w.fd); dev=(os.major(ns.st_dev),os.minor(ns.st_dev))
    item={'status':'ObservedRoot','fd':n.fd,'workspaceFd':w.fd,'pin':p['pin'](ns),'workspacePin':p['pin'](ws),'physical':r+'/w/node_modules','workspacePhysical':r+'/w','dev':dev,'workspaceDev':dev}
    mounts=[{'point':'/','root':'/','dev':dev}]
    f=os.open(r+'/w/node_modules/dep',os.O_RDONLY)
    mapped=mmap.mmap(f,0,access=mmap.ACCESS_READ)
    try:
        raw=os.readlink('/proc/self/fd/'+str(f)); target=p['object_pin'](os.fstat(f))
        good,good_issues=p['classify_path'](raw,target,mounts,[item],budget)
        self_fd=os.open('/proc/self',os.O_RDONLY|os.O_DIRECTORY); map_scopes=[]
        try:
            for line in p['lines_at'](self_fd,'maps',budget):
                fields=line.split(None,5)
                if len(fields)==6 and os.fsdecode(fields[5])==raw:
                    major,minor=(int(x,16) for x in fields[3].split(b':'))
                    map_scopes.extend(x[2] for x in p['classify_path'](raw,(os.makedev(major,minor),int(fields[4])),mounts,[item],budget)[0])
        finally: os.close(self_fd)
        wrong,wrong_issues=p['classify_path'](r+'/w/node_modules-other/other',p['object_pin'](os.lstat(r+'/w/node_modules-other/other')),mounts,[item],budget)
        rejected,mismatch_issues=p['classify_path'](raw,p['object_pin'](os.lstat(r+'/w/node_modules-other/other')),mounts,[item],budget)
        mismatch=not rejected and bool(mismatch_issues)
        print(json.dumps({'good':[x[2] for x in good],'map':map_scopes,'collision':[x[2] for x in wrong],'mismatchRefused':mismatch}))
    finally: mapped.close();os.close(f)
finally: n.close();w.close()`);
  assert.deepEqual(actual, { good: ['Dependencies'], map: ['Dependencies'], collision: ['Workspace'], mismatchRefused: true });
}));

test('symlink refusal, incremental entry cap and replaced root leave no fixture-target FD leaks', () => fixture(root => {
  mkdirSync(join(root, 'tree')); symlinkSync(join(root, 'outside'), join(root, 'tree/escape'));
  writeFileSync(join(root, 'outside'), 'preserve');
  for (let i = 0; i < 12; i++) writeFileSync(join(root, 'tree', `f${i}`), 'x');
  const actual = python(root, `def owned_target_fds():
    total=0
    with os.scandir('/proc/self/fd') as entries:
        for e in entries:
            try:
                target=os.readlink(e.path)
                if target==r or target.startswith(r+'/'): total+=1
            except FileNotFoundError: pass
    return total
before=owned_target_fds(); expired=False
try:p['DirectoryChain'](r+'/tree',p['Budget'](-1))
except p['Refusal']:expired=True
budget=p['Budget'](10,entries=3); chain=p['DirectoryChain'](r+'/tree',budget)
try:
    escaped=False; capped=False
    try: p['source_leaf'](chain.fd,'escape',budget)
    except p['Refusal']: escaped=True
    try: p['walk_allocated'](chain.fd,budget,{},0)
    except p['Refusal']: capped=True
    os.rename(r+'/tree',r+'/old-tree');os.mkdir(r+'/tree');replaced=False
    try: chain.current()
    except p['Refusal']: replaced=True
finally: chain.close()
print(json.dumps({'expiredRefused':expired,'escapeRefused':escaped,'capRefused':capped,'enumerated':budget.entries,'replacementRefused':replaced,'before':before,'after':owned_target_fds()}))`);
  assert.deepEqual(actual, { expiredRefused: true, escapeRefused: true, capRefused: true, enumerated: 4, replacementRefused: true, before: 0, after: 0 });
  assert.equal(readFileSync(join(root, 'outside'), 'utf8'), 'preserve');
}));

test('operator accepts only one explicit mode/partition and rejects raw payload/zero-needed claims', () => {
  assert.deepEqual(parseMode(['allocated', '76']), { mode: 'AllocatedMetadata', partition: 76 });
  for (const args of [[], ['proc', 'allocated'], ['allocated', '77'], ['allocated', '01'], ['allocated', '-1']]) assert.throws(() => parseMode(args));
  const cohort = readFileSync(join(artifact, 'input/fixed-cohort.json'), 'utf8');
  const envelope = { schemaVersion: 1, mode: 'ProcReferences', cohortSha256: '8b0467e9cdf7d83bace82df97893ed77e9f311dcd83110a18cbfcd0fc01a7da4',
    necessaryBytes: 'Unknown', futureAdmissionCoverage: 'Unknown', cleanupEligibility: 'NotEstablished', status: 'Incomplete' };
  validateReport(envelope, 'ProcReferences', cohort);
  assert.throws(() => validateReport({ ...envelope, necessaryBytes: '0' }, 'ProcReferences', cohort));
  assert.throws(() => validateReport({ ...envelope, rawCmdline: 'secret' }, 'ProcReferences', cohort));
  assert.throws(() => validateReport({ ...envelope, errors: [{ phase: 'ProcessView', reason: '/unexpected/raw/path' }] }, 'ProcReferences', cohort));
});

test('AuditOwned needs exact own birth AND tracked FD; a genuine TEST child stays external', () => fixture(root => {
  writeFileSync(join(root, 'held'), 'TEST');
  const actual = python(root, `import subprocess,sys,select
budget=p['Budget'](10); self_fd=os.open('/proc/self',os.O_RDONLY|os.O_DIRECTORY)
ticks=p['birth'](self_fd,budget); audit={'ownPid':os.getpid(),'ownTasks':{os.getpid():ticks}}
tracked=budget.own(os.open(r+'/held',os.O_RDONLY)); untracked=os.open(r+'/held',os.O_RDONLY)
child=subprocess.Popen([sys.executable,'-B','-c','import os,sys; f=os.open(sys.argv[1],os.O_RDONLY); print(os.getpid(),flush=True); sys.stdin.buffer.read(1)',r+'/held'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
try:
    assert child.stdout is not None and select.select([child.stdout],[],[],3)[0]
    child_pid=int(child.stdout.readline(64)); child_proc=os.open('/proc/'+str(child_pid),os.O_RDONLY|os.O_DIRECTORY)
    try: child_ticks=p['birth'](child_proc,budget)
    finally: os.close(child_proc)
    target=p['object_pin'](os.fstat(tracked))
    print(json.dumps({'tracked':p['reference_origin'](os.getpid(),os.getpid(),ticks,audit,budget,tracked,target),'untracked':p['reference_origin'](os.getpid(),os.getpid(),ticks,audit,budget,untracked,target),'child':p['reference_origin'](child_pid,child_pid,child_ticks,audit,budget,tracked,target)}))
finally:
    if child.stdin is not None: child.stdin.close()
    try: child.wait(timeout=3)
    except subprocess.TimeoutExpired: child.kill();child.wait(timeout=3)
    if child.stdout is not None: child.stdout.close()
    budget.close(tracked);os.close(untracked);os.close(self_fd)`);
  assert.deepEqual(actual, { tracked: 'AuditCreated', untracked: 'UnclassifiedSelf', child: 'External' });
}));

test('real307 TEST roots select four/final-three only and retain cross-partition hardlink facts', () => fixture(root => {
  const roots: string[] = [];
  for (let i = 0; i < 307; i++) { const path = join(root, `TEST-${i}`, 'node_modules'); mkdirSync(path, { recursive: true }); roots.push(path); }
  const first = roots[0], last = roots[304]; assert.ok(first && last);
  writeFileSync(join(first, 'shared'), Buffer.alloc(4096, 3)); linkSync(join(first, 'shared'), join(last, 'shared'));
  const actual = python(root, `budget=p['Budget'](10);parent=p['DirectoryChain'](r,budget);self_fd=os.open('/proc/self',os.O_RDONLY|os.O_DIRECTORY);items=[]
try:
    mounts,_=p['mount_table'](self_fd,budget);rows=[]
    for index in range(307):
        name='TEST-'+str(index);workspace=r+'/'+name;s=os.lstat(workspace+'/node_modules')
        rows.append({'index':index,'name':name,'workspace':workspace,'dependencies':workspace+'/node_modules','historicalDev':str(s.st_dev),'historicalIno':str(s.st_ino)})
    items=p['capture_cohort'](rows,parent,mounts,budget);a=p['allocation_observation'](items,0,budget);b=p['allocation_observation'](items,76,budget)
    print(json.dumps({'first':[x['cohortIndex'] for x in a['trees']],'last':[x['cohortIndex'] for x in b['trees']],'allMeasured':all(x['status']=='ObservedMetadata' for x in a['trees']+b['trees']),'sameCrosslink':a['crosslinks'][0]['dev']==b['crosslinks'][0]['dev'] and a['crosslinks'][0]['ino']==b['crosslinks'][0]['ino'],'kind':a['crosslinks'][0]['kind'],'rootInodes':len({x['pin'][:2] for x in items if x['status']=='ObservedRoot'})}))
finally:p['close_cohort'](items,budget);os.close(self_fd);parent.close()`);
  assert.deepEqual(actual, { first: [0, 1, 2, 3], last: [304, 305, 306], allMeasured: true, sameCrosslink: true, kind: 'Regular', rootInodes: 307 });
}));
