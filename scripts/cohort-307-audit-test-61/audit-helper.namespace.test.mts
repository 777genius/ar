import assert from 'node:assert/strict';
import { AssertionError } from 'node:assert';
import { isDeepStrictEqual } from 'node:util';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const nativeStages = ['Unknown', 'FixtureGuards', 'FixtureSetup', 'AliasMount', 'DetachedMount', 'DetachedSourceRemoval', 'PythonSetup', 'CohortCapture', 'FirstReaderLaunch', 'FirstReaderReady', 'FirstObservation', 'InheritedReaderLaunch', 'InheritedReaderReady', 'ChrootRootPin', 'ChrootMountViews', 'ChrootProcessClose', 'SecondObservation', 'ResultShape', 'ResultKinds', 'ResultChildExternal', 'ResultOwnTracked', 'ResultInheritedKinds', 'ResultInheritedExternal', 'ResultChildRootPinned', 'ResultCollectorRendered', 'ResultViewsDiffer', 'ResultDetachedPrefix', 'ResultDirectBindings', 'ResultDetachedUnknown', 'PythonTeardown', 'DetachedUnmount', 'AliasUnmount', 'FixtureCleanup'] as const;
type NativeStage = (typeof nativeStages)[number];
type NativeReason = 'Assertion' | 'SystemError' | 'Unknown';
type NativeFailure = { stage: NativeStage; reason: NativeReason };
const nativePrefix = 'AUDIT_NATIVE_FAILURE ';
const artifact = dirname(fileURLToPath(import.meta.url));
function fixture(run: (root: string) => void): void {
  assert.equal(process.platform, 'linux');
  assert.equal(process.env.TEST_AUDIT_OWNED_NAMESPACE, '1', 'Required native suite must use the finite owned CI launcher');
  assert.match(readFileSync('/proc/self/uid_map', 'utf8').trim(), /^0\s+0\s+1$/);
  assert.equal(process.getuid?.(), 0);
  const root = mkdtempSync(join(tmpdir(), 'TEST-audit-native-'));
  try { run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}
function nativeReason(error: unknown): NativeReason {
  if (error instanceof AssertionError) return 'Assertion';
  const code: unknown = error !== null && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
  return typeof code === 'string' && ['EACCES', 'EPERM', 'ENOENT', 'EINVAL', 'ETIMEDOUT', 'ENOBUFS', 'EIO'].includes(code) ? 'SystemError' : 'Unknown';
}
function capturedNativeFailure(error: unknown): NativeFailure | null {
  const text: unknown = error !== null && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'stderr')?.value : undefined;
  if (typeof text !== 'string' || Buffer.byteLength(text) > 512 * 1024) return null;
  let failure: NativeFailure | null = null, markers = 0, lines = 0;
  for (const line of text.split('\n')) {
    if (++lines > 4096 || Buffer.byteLength(line) > 4096) return null;
    if (!line.startsWith('AUDIT_NATIVE_FAILURE')) continue;
    if (++markers !== 1) return null;
    const parts = line.slice(nativePrefix.length).split(' '), stage = nativeStages.find(s => s === parts[0]), reason = parts[1];
    if (!line.startsWith(nativePrefix) || parts.length !== 2 || !stage || reason !== 'Assertion' && reason !== 'SystemError' && reason !== 'Unknown') return null;
    failure = { stage, reason };
  }
  return failure;
}
function python(root: string, body: string, diagnose?: (failure: NativeFailure | null) => void): unknown {
  const encoded = Buffer.from(JSON.stringify({ root, payload: join(artifact, 'audit-payload.py') })).toString('base64');
  if (diagnose) body = `native_stage='PythonSetup';native_failed_stage=None;native_failed_reason=None\ntry:\n${body.split('\n').map(line => '    ' + line).join('\n')}\nexcept BaseException as error:\n    reason=native_failed_reason or ('Assertion' if isinstance(error,AssertionError) else 'SystemError' if isinstance(error,OSError) else 'Unknown')\n    sys.stderr.write('AUDIT_NATIVE_FAILURE '+(native_failed_stage or native_stage)+' '+reason+'\\n')\n    raise`;
  try { return JSON.parse(execFileSync('/usr/bin/python3', ['-B', '-c',
    `import base64,json,os,runpy,subprocess,sys,select\ni=json.loads(base64.b64decode('${encoded}'))\np=runpy.run_path(i['payload']);r=i['root']\n${body}`],
    { encoding: 'utf8', timeout: 15_000, maxBuffer: 512 * 1024, stdio: diagnose ? ['pipe', 'pipe', 'pipe'] : undefined }));
  } catch (error: unknown) { diagnose?.(capturedNativeFailure(error)); throw error; }
}

test('actual unrecorded/chroot inherited readers and mounted objects are joined; audit-owned FDs stay separate', () => {
  let stage: NativeStage = 'FixtureGuards', reason: NativeReason | null = null, failed = false;
  try { fixture(root => {
  try {
  stage = 'FixtureSetup';
  const nm = join(root, 'w/node_modules'), alias = join(root, 'alias'); mkdirSync(nm, { recursive: true }); mkdirSync(alias);
  writeFileSync(join(nm, 'dep'), 'TEST'); mkdirSync(join(nm, 'gone')); mkdirSync(join(root, 'detached')); mkdirSync(join(root, 'jail'));
  stage = 'AliasMount';
  execFileSync('/usr/bin/mount', ['--bind', nm, alias], { timeout: 3000, stdio: 'pipe' });
  try {
    stage = 'DetachedMount';
    execFileSync('/usr/bin/mount', ['--bind', join(nm, 'gone'), join(root, 'detached')], { timeout: 3000, stdio: 'pipe' });
    try {
    stage = 'DetachedSourceRemoval';
    rmdirSync(join(nm, 'gone')); // Held bind survives; the original source pathname no longer joins.
    stage = 'PythonSetup';
    const result = python(root, `budget=p['Budget'](10);parent=p['DirectoryChain'](r,budget);proc=p['DirectoryChain']('/proc',budget);self_fd=os.open('/proc/self',os.O_RDONLY|os.O_DIRECTORY)
items=[];child=None;chroot=None;held=None
try:
    mounts,_=p['mount_table'](self_fd,budget);s=os.lstat(r+'/w/node_modules')
    rows=[{'index':0,'name':'w','workspace':r+'/w','dependencies':r+'/w/node_modules','historicalDev':str(s.st_dev),'historicalIno':str(s.st_ino)}]
    native_stage='CohortCapture'
    items=p['capture_cohort'](rows,parent,mounts,budget)
    ticks=p['birth'](self_fd,budget);facts={'proc':proc,'ownPid':os.getpid(),'ownBirth':ticks,'ownTasks':{os.getpid():ticks},'mounts':mounts}
    native_stage='FirstReaderLaunch'
    child=subprocess.Popen([sys.executable,'-B','-c','import os,sys,mmap; os.chdir(sys.argv[1]); f=os.open("dep",os.O_RDONLY); m=mmap.mmap(f,0,access=mmap.ACCESS_READ); print(os.getpid(),flush=True); sys.stdin.buffer.read(1)',r+'/alias'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
    native_stage='FirstReaderReady'
    assert child.stdout is not None and select.select([child.stdout],[],[],3)[0]
    native_stage='FirstObservation'
    child_pid=int(child.stdout.readline(64));observed=p['proc_observation'](facts,items,budget)
    matches=[m for m in observed['matches'] if m['pid']==child_pid and m['scope']=='Dependencies']
    held=os.open(r+'/w/node_modules/dep',os.O_RDONLY)
    native_stage='InheritedReaderLaunch'
    chroot=subprocess.Popen([sys.executable,'-B','-c','import os,sys,mmap; m=mmap.mmap(int(sys.argv[2]),0,access=mmap.ACCESS_READ); os.chroot(sys.argv[1]); os.chdir("/"); print(os.getpid(),flush=True); sys.stdin.buffer.read(1)',r+'/jail',str(held)],pass_fds=(held,),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
    native_stage='InheritedReaderReady'
    assert chroot.stdout is not None and select.select([chroot.stdout],[],[],3)[0]
    chroot_pid=int(chroot.stdout.readline(64));chroot_proc=os.open('/proc/'+str(chroot_pid),os.O_RDONLY|os.O_DIRECTORY)
    try:
        native_stage='ChrootRootPin'
        raw=os.readlink('/proc/'+str(chroot_pid)+'/fd/'+str(held));target_mounts,_=p['mount_table'](chroot_proc,budget)
        root_pinned=p['object_pin'](os.stat('root',dir_fd=chroot_proc))==p['object_pin'](os.lstat(r+'/jail'))
        native_stage='ChrootMountViews'
        collector_physical=p['filesystem_path'](raw,mounts)[1]
        try:
            target_physical=p['filesystem_path'](raw,target_mounts)[1]
        except p['Refusal'] as error:
            if str(error)!='MountJoinUnknown' or any(p['beneath'](raw,m['point']) for m in target_mounts):raise
            views_differ=True
        else:
            views_differ=target_physical!=collector_physical
    except BaseException as error:
        native_failed_stage=native_stage
        native_failed_reason='Assertion' if isinstance(error,AssertionError) else 'SystemError' if isinstance(error,OSError) else 'Unknown'
        raise
    finally:
        native_stage='ChrootProcessClose'
        os.close(chroot_proc)
    native_stage='SecondObservation'
    second=p['proc_observation'](facts,items,budget)
    inherited=[m for m in second['matches'] if m['pid']==chroot_pid and m['scope']=='Dependencies' and m['kind'] in ('Fd','Map')]
    detached_prefix=any(p['beneath'](m['root'],items[0]['physical']) and m['point']==r+'/detached' for m in mounts)
    direct=[m for m in matches if m['kind']=='DirectMountBinding']
    detached_mounts=[m for m in mounts if m['point']==r+'/detached' and m['dev']==items[0]['dev']]
    detached_root=detached_mounts[0]['root'] if len(detached_mounts)==1 else None
    detached_reason='PathShape' if detached_root==items[0]['physical']+'/gone//deleted' else 'ENOENT' if detached_root==items[0]['physical']+'/gone' else None
    detached_unknown=len(direct)==1 and budget.incomplete and detached_reason is not None and any(x['phase']=='ProcessView' and x.get('pid')==child_pid and x['reason']==detached_reason for x in budget.errors)
    print(json.dumps({'kinds':sorted(set(m['kind'] for m in matches)),'childExternal':all(m['bucket']=='ExternalCurrentReference' for m in matches),'ownTracked':any(m['bucket']=='AuditOwned' and m['auditCreatedHandle'] is True for m in observed['matches']),'inheritedKinds':sorted(set(m['kind'] for m in inherited)),'inheritedExternal':all(m['bucket']=='ExternalCurrentReference' for m in inherited),'childRootPinned':root_pinned,'collectorRendered':raw==r+'/w/node_modules/dep','viewsDiffer':views_differ,'detachedPrefixExercised':detached_prefix,'directBindings':len(direct),'detachedUnknown':detached_unknown}))
except BaseException as error:
    if native_failed_stage is None:
        native_failed_stage=native_stage
        native_failed_reason='Assertion' if isinstance(error,AssertionError) else 'SystemError' if isinstance(error,OSError) else 'Unknown'
    raise
finally:
    native_stage='PythonTeardown'
    for process in (chroot,child):
        if process is not None:
            if process.stdin is not None:process.stdin.close()
            try:process.wait(timeout=3)
            except subprocess.TimeoutExpired:process.kill();process.wait(timeout=3)
            if process.stdout is not None:process.stdout.close()
    if held is not None:os.close(held)
    p['close_cohort'](items,budget);os.close(self_fd);proc.close();parent.close()`, failure => { stage = failure?.stage ?? 'Unknown'; reason = failure?.reason ?? 'Unknown'; });
    const expected = { kinds: ['Cwd', 'DirectMountBinding', 'Fd', 'Map'], childExternal: true, ownTracked: true,
      inheritedKinds: ['Fd', 'Map'], inheritedExternal: true, childRootPinned: true, collectorRendered: true, viewsDiffer: true,
      detachedPrefixExercised: true, directBindings: 1, detachedUnknown: true };
    const fields = [['kinds', 'ResultKinds'], ['childExternal', 'ResultChildExternal'], ['ownTracked', 'ResultOwnTracked'],
      ['inheritedKinds', 'ResultInheritedKinds'], ['inheritedExternal', 'ResultInheritedExternal'], ['childRootPinned', 'ResultChildRootPinned'],
      ['collectorRendered', 'ResultCollectorRendered'], ['viewsDiffer', 'ResultViewsDiffer'], ['detachedPrefixExercised', 'ResultDetachedPrefix'],
      ['directBindings', 'ResultDirectBindings'], ['detachedUnknown', 'ResultDetachedUnknown']] as const;
    stage = 'ResultShape';
    if (result !== null && typeof result === 'object' && !Array.isArray(result)) {
      const actual = result as Record<string, unknown>;
      const keys = Object.keys(actual), expectedKeys = Object.keys(expected);
      if (keys.length === expectedKeys.length && keys.every(key => expectedKeys.includes(key)))
        stage = fields.find(([key]) => !isDeepStrictEqual(actual[key], expected[key]))?.[1] ?? 'ResultShape';
    }
    assert.deepEqual(result, expected);
    } catch (error: unknown) { if (!failed) reason ??= nativeReason(error); failed = true; throw error; } finally { if (!failed) stage = 'DetachedUnmount'; execFileSync('/usr/bin/umount', ['--', join(root, 'detached')], { timeout: 3000, stdio: 'pipe' }); }
  } catch (error: unknown) { if (!failed) reason ??= nativeReason(error); failed = true; throw error; } finally { if (!failed) stage = 'AliasUnmount'; execFileSync('/usr/bin/umount', ['--', alias], { timeout: 3000, stdio: 'pipe' }); }
  stage = 'FixtureCleanup';
  } catch (error: unknown) { if (!failed) reason ??= nativeReason(error); failed = true; throw error; }
  }); } catch (error: unknown) {
    console.error(nativePrefix + stage + ' ' + (reason ?? nativeReason(error)));
    throw error;
  }
});

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
