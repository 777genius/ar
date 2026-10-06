import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const artifact = dirname(fileURLToPath(import.meta.url));
const FixtureFailure = {
  Unknown: 'Unknown',
  OutputDecode: 'OutputDecode',
  DriverSetup: 'DriverSetup',
  BaselineCapture: 'BaselineCapture',
  BaselineReaders: 'BaselineReaders',
  BaselineCollect: 'BaselineCollect',
  BaselineClose: 'BaselineClose',
  MutationSetup: 'MutationSetup',
  AbaSpawn: 'AbaSpawn',
  AbaHeader: 'AbaHeader',
  AbaWindow: 'AbaWindow',
  AbaRestore: 'AbaRestore',
  AbaResult: 'AbaResult',
  AbaCleanup: 'AbaCleanup',
  RenameSpawn: 'RenameSpawn',
  RenameHeader: 'RenameHeader',
  RenameWindow: 'RenameWindow',
  RenameRestore: 'RenameRestore',
  RenameResult: 'RenameResult',
  RenameCleanup: 'RenameCleanup',
  PhysicalSpawn: 'PhysicalSpawn',
  PhysicalHeader: 'PhysicalHeader',
  PhysicalWindow: 'PhysicalWindow',
  PhysicalRestore: 'PhysicalRestore',
  PhysicalResult: 'PhysicalResult',
  PhysicalCleanup: 'PhysicalCleanup',
  FdBoundary: 'FdBoundary',
  IoBoundary: 'IoBoundary',
  HeapBoundary: 'HeapBoundary',
  DriverCleanup: 'DriverCleanup',
  SupervisorSetup: 'SupervisorSetup',
  SupervisorReaders: 'SupervisorReaders',
  SupervisorRootPins: 'SupervisorRootPins',
  SupervisorTableBounds: 'SupervisorTableBounds',
  SupervisorAuditorSpawn: 'SupervisorAuditorSpawn',
  SupervisorAuditorReady: 'SupervisorAuditorReady',
  SupervisorAuditorResult: 'SupervisorAuditorResult',
  SupervisorCleanup: 'SupervisorCleanup',
  AuditorSetup: 'AuditorSetup',
  AuditorCapture: 'AuditorCapture',
  AuditorCollect: 'AuditorCollect',
  AuditorFacts: 'AuditorFacts',
  AuditorCleanup: 'AuditorCleanup',
} as const;
type FixtureFailure = (typeof FixtureFailure)[keyof typeof FixtureFailure];

const failureScript = String.raw`
import sys
stage='Unknown';first_failure=None
failure_codes=('Unknown', 'OutputDecode', 'DriverSetup', 'BaselineCapture', 'BaselineReaders', 'BaselineCollect', 'BaselineClose', 'MutationSetup', 'AbaSpawn', 'AbaHeader', 'AbaWindow', 'AbaRestore', 'AbaResult', 'AbaCleanup', 'RenameSpawn', 'RenameHeader', 'RenameWindow', 'RenameRestore', 'RenameResult', 'RenameCleanup', 'PhysicalSpawn', 'PhysicalHeader', 'PhysicalWindow', 'PhysicalRestore', 'PhysicalResult', 'PhysicalCleanup', 'FdBoundary', 'IoBoundary', 'HeapBoundary', 'DriverCleanup', 'SupervisorSetup', 'SupervisorReaders', 'SupervisorRootPins', 'SupervisorTableBounds', 'SupervisorAuditorSpawn', 'SupervisorAuditorReady', 'SupervisorAuditorResult', 'SupervisorCleanup', 'AuditorSetup', 'AuditorCapture', 'AuditorCollect', 'AuditorFacts', 'AuditorCleanup')
def adopt_failure(raw,prefixes):
    global first_failure
    if first_failure is not None:return
    selected=[code for code in failure_codes if code=='Unknown' or any(code.startswith(prefix) for prefix in prefixes)]
    first_failure=next((code for code in selected if raw==('VIEW_FIXTURE_FAILURE='+code+'\n').encode()),'Unknown')
def closed_failure(_kind,_error,_trace):
    code=first_failure or stage
    if code not in failure_codes:code='Unknown'
    print('VIEW_FIXTURE_FAILURE='+code,file=sys.stderr)
sys.excepthook=closed_failure
`;

const readerScript = String.raw`
import ctypes,mmap,os,sys,threading
private=int(sys.argv[2]);lib=ctypes.CDLL(None,use_errno=True)
assert not private or lib.unshare(0x00020000)==0
f=open(sys.argv[1],'rb');m=mmap.mmap(f.fileno(),0,access=mmap.ACCESS_READ)
jail=sys.argv[3]
if jail:os.chroot(jail);os.chdir('/')
event=threading.Event();threads=[threading.Thread(target=event.wait) for _ in range(int(sys.argv[4]))]
for thread in threads:thread.start()
print(os.getpid(),flush=True);sys.stdin.buffer.read(1);event.set()
for thread in threads:thread.join()
`;
const auditorScript = String.raw`
import base64,json,os,runpy,sys
spec=json.loads(base64.b64decode(sys.argv[1]));p=runpy.run_path(spec['payload']);r=spec['root'];budget=p['Budget'](35)
parent=None;proc=None;self_fd=None;items=[];table=None
stage='AuditorSetup'
try:
    stage='AuditorCapture'
    parent=p['DirectoryChain'](r,budget);proc=p['DirectoryChain']('/proc',budget)
    self_fd=os.open('self',os.O_RDONLY|os.O_DIRECTORY|os.O_CLOEXEC,dir_fd=proc.fd)
    table,_=p['mount_table'](self_fd,budget);rows=[]
    for index,name in enumerate(('w','w2')):
        path=r+'/'+name;st=os.stat(path+'/node_modules');rows.append({'index':index,'name':name,'workspace':path,'dependencies':path+'/node_modules','historicalDev':str(st.st_dev),'historicalIno':str(st.st_ino)})
    items=p['capture_cohort'](rows,parent,table,budget);ticks=p['birth'](self_fd,budget)
    facts={'proc':proc,'ownPid':os.getpid(),'ownBirth':ticks,'ownTasks':{os.getpid():ticks},'mounts':table}
    print('READY',flush=True)
    stage='AuditorCollect'
    observed=p['proc_observation'](facts,items,budget)
    stage='AuditorFacts'
    def observations(pid):return [row for row in observed['observations'] if row['pid']==pid]
    def kinds(pid):return {row['kind'] for row in observed['matches'] if row['pid']==pid and row['bucket']=='ExternalCurrentReference' and row['join']=='Joined'}
    shared=observations(spec['shared']);stable=observations(spec['stable'])
    direct_errors=[row for row in budget.errors if row.get('pid')==spec['shared']]
    sibling_kinds={row['kind'] for row in observed['matches'] if row['pid']==spec['shared'] and row['cohortIndex']==0 and row['scope']=='Dependencies'}
    direct_failure=bool(direct_errors) and all(row['phase']=='ProcessView' and row['reason']=='ReferenceObjectMismatch' for row in direct_errors) and not any(row['reason']=='MountDrift' for row in budget.errors) and {'Fd','Map'}<=sibling_kinds and any(row['pid']==1 and row['kind']=='DirectMountBinding' and row['cohortIndex']==0 and row['scope']=='Dependencies' for row in observed['matches'])
    plain=observations(spec['plain']);bound=observations(spec['bound'])
    print(json.dumps({'directFailure':direct_failure,'affectedUnknown':len(shared)==33 and all(row['join']=='Unknown' for row in shared),'stableJoined':len(stable)==33 and all(row['join']=='Joined' for row in stable) and {'Fd','Map'}<=kinds(spec['stable']),'distinctReported':spec['sameRootDifferentMount'] and observed['namespaceRootViewsObserved']==4 and len(plain)==len(bound)==1 and plain[0]['join']==bound[0]['join']=='Joined' and {'Fd','Map'}<=kinds(spec['plain']) and {'Fd','Map'}<=kinds(spec['bound'])}))
except BaseException:
    first_failure=first_failure or stage
    raise
finally:
    stage='AuditorCleanup'
    p['close_cohort'](items,budget)
    if table is not None:budget.release_mounts(table)
    if self_fd is not None:os.close(self_fd)
    if proc is not None:proc.close()
    if parent is not None:parent.close()
`;
const supervisorScript = String.raw`
import base64,ctypes,hashlib,json,os,runpy,select,subprocess,sys
spec=json.loads(base64.b64decode(sys.argv[1]));r=spec['root'];p=runpy.run_path(spec['payload']);budget=p['Budget'](35)
lib=ctypes.CDLL(None,use_errno=True);lib.mount.argtypes=[ctypes.c_char_p,ctypes.c_char_p,ctypes.c_char_p,ctypes.c_ulong,ctypes.c_void_p];lib.umount2.argtypes=[ctypes.c_char_p,ctypes.c_int]
children=[];audit=None;proc_mounted=False;extra_mounted=False;descendant_mounted=False

def reader(path,private=False,jail='',threads=0):
    child=subprocess.Popen([sys.executable,'-B','-c',spec['reader'],path,str(int(private)),jail,str(threads)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
    children.append(child);assert select.select([child.stdout],[],[],5)[0];return int(child.stdout.readline(32))
stage='SupervisorSetup'
try:
    assert lib.mount(b'proc',b'/proc',b'proc',0,None)==0;proc_mounted=True
    stage='SupervisorReaders'
    shared=reader(r+'/w/node_modules/dep',threads=32)
    stable=reader(r+'/w2/node_modules/dep',private=True,threads=32)
    assert lib.mount(os.fsencode(r+'/w/node_modules/descendant'),os.fsencode(r+'/descendant-alias'),None,4096,None)==0;descendant_mounted=True
    assert lib.mount(os.fsencode(spec['source']),os.fsencode(r+'/extra'),None,4096,None)==0;extra_mounted=True
    plain=reader(r+'/w2/node_modules/dep',jail=r+'/jail');bound=reader(r+'/w2/node_modules/dep',jail=r+'/jail-bind')
    stage='SupervisorRootPins'
    roots=[]
    for pid in (plain,bound):
        fd=os.open('/proc/'+str(pid)+'/root',os.O_RDONLY|os.O_DIRECTORY|os.O_CLOEXEC)
        try:roots.append((p['object_pin'](os.fstat(fd)),p['mount_id'](fd,budget)))
        finally:os.close(fd)
    spec.update({'shared':shared,'stable':stable,'plain':plain,'bound':bound,'sameRootDifferentMount':roots[0][0]==roots[1][0] and roots[0][1]!=roots[1][1]})
    stage='SupervisorTableBounds'
    with open('/proc/self/mountinfo','rb') as file:table_text=file.read(8*1024**2+1)
    table_bytes=len(table_text);table_hash=hashlib.sha256(table_text).hexdigest()
    with open('/proc/'+str(stable)+'/mountinfo','rb') as file:stable_table_bytes=len(file.read(8*1024**2+1))
    assert max(table_bytes,stable_table_bytes)<8*1024**2
    stage='SupervisorAuditorSpawn'
    audit=subprocess.Popen([sys.executable,'-B','-c',spec['auditor'],base64.b64encode(json.dumps(spec).encode()).decode()],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    stage='SupervisorAuditorReady'
    assert select.select([audit.stdout],[],[],5)[0] and audit.stdout.readline(32)==b'READY\n'
    print(json.dumps({'auditor':audit.pid,'shared':shared,'stable':stable,'tableBytes':table_bytes,'stableTableBytes':stable_table_bytes,'mainTableHash':table_hash}),flush=True)
    stage='SupervisorAuditorResult'
    output,error=audit.communicate(timeout=40)
    if audit.returncode!=0 or error:adopt_failure(error,('Auditor',))
    assert audit.returncode==0 and not error and len(output)<4096
    print(output.decode().strip(),flush=True)
except BaseException:
    if audit is not None and audit.poll() is not None:
        try:
            _output,error=audit.communicate(timeout=5);adopt_failure(error,('Auditor',))
        except BaseException:pass
    first_failure=first_failure or stage
    raise
finally:
    stage='SupervisorCleanup'
    if audit is not None and audit.poll() is None:audit.kill();audit.communicate(timeout=5)
    for child in children:
        if child.poll() is None:child.kill()
        child.communicate(timeout=5)
    if extra_mounted:
        target=r+'/extra-renamed' if os.path.exists(r+'/extra-renamed') else r+'/extra'
        assert lib.umount2(os.fsencode(target),0)==0
    if descendant_mounted:assert lib.umount2(os.fsencode(r+'/descendant-alias'),0)==0
    if proc_mounted:assert lib.umount2(b'/proc',0)==0
`;
const driverScript = String.raw`
import base64,ctypes,hashlib,json,os,resource,runpy,select,subprocess,sys,time
spec=json.loads(base64.b64decode('__SPEC__'));p=runpy.run_path(spec['payload']);r=spec['root']
lib=ctypes.CDLL(None,use_errno=True);mounted=[];children=[];groups=[];items=[];parent=None;proc=None;self_fd=None;table=None
lib.mount.argtypes=[ctypes.c_char_p,ctypes.c_char_p,ctypes.c_char_p,ctypes.c_ulong,ctypes.c_void_p]
lib.umount2.argtypes=[ctypes.c_char_p,ctypes.c_int]
def mount(source,target,kind=None,flags=4096):
    if lib.mount(os.fsencode(source),os.fsencode(target),None if kind is None else os.fsencode(kind),flags,None):raise OSError(ctypes.get_errno())
    mounted.append(target)
def unmount(target):
    if lib.umount2(os.fsencode(target),0):raise OSError(ctypes.get_errno())
    mounted.remove(target)
def reader(path,private=False,jail='',threads=0):
    child=subprocess.Popen([sys.executable,'-B','-c',spec['reader'],path,str(int(private)),jail,str(threads)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
    children.append(child)
    assert select.select([child.stdout],[],[],5)[0]
    return int(child.stdout.readline(32))
def refused(call,reason):
    try:call()
    except p['Refusal'] as error:return str(error)==reason
    return False
stage='DriverSetup'
try:
    mount('proc','/proc','proc',0)
    source=r+'/'+('/'.join(['s'*180]*8));targets=r+'/'+('/'.join(['t'*180]*8));os.makedirs(source);os.makedirs(targets);spec['source']=source
    for i in range(2048):
        target=targets+'/'+str(i);os.mkdir(target);mount(source,target)
    for name in ('w','w2'):
        os.makedirs(r+'/'+name+'/node_modules');open(r+'/'+name+'/node_modules/dep','wb').write(b'TEST')
    stage='BaselineCapture'
    budget=p['Budget'](35);parent=p['DirectoryChain'](r,budget);proc=p['DirectoryChain']('/proc',budget)
    self_fd=os.open('self',os.O_RDONLY|os.O_DIRECTORY|os.O_CLOEXEC,dir_fd=proc.fd)
    table,_=p['mount_table'](self_fd,budget)
    rows=[]
    for index,name in enumerate(('w','w2')):
        path=r+'/'+name;st=os.stat(path+'/node_modules');rows.append({'index':index,'name':name,'workspace':path,'dependencies':path+'/node_modules','historicalDev':str(st.st_dev),'historicalIno':str(st.st_ino)})
    items=p['capture_cohort'](rows,parent,table,budget)
    stage='BaselineReaders'
    shared=reader(r+'/w/node_modules/dep',threads=32);independent=reader(r+'/w2/node_modules/dep',private=True)
    facts={'proc':proc,'ownPid':os.getpid(),'ownBirth':p['birth'](self_fd,budget),'ownTasks':{os.getpid():p['birth'](self_fd,budget)},'mounts':table}
    length_fd=os.open('mountinfo',os.O_RDONLY,dir_fd=self_fd)
    try:
        table_bytes=0
        while True:
            chunk=os.read(length_fd,65536)
            if not chunk:break
            table_bytes+=len(chunk)
    finally:os.close(length_fd)
    stage='BaselineCollect'
    before_read=budget.mount_io;first=p['proc_observation'](facts,items,budget);charged=budget.mount_io-before_read
    shared_rows=[row for row in first['matches'] if row['pid']==shared and row['bucket']=='ExternalCurrentReference']
    shared_obs=[row for row in first['observations'] if row['pid']==shared]
    reuse=not budget.incomplete and len(shared_obs)==33 and all(row['join']=='Joined' for row in shared_obs) and {'Fd','Map'}<=set(row['kind'] for row in shared_rows) and charged<6*table_bytes and 4*table_bytes*len(shared_obs)>64*1024**2
    stage='BaselineClose'
    for child in children:
        if child.poll() is None:child.kill()
        child.communicate(timeout=5)
    children=[]
    p['close_cohort'](items,budget);items=[];budget.release_mounts(table);table=None;parent.close();parent=None;proc.close();proc=None;os.close(self_fd);self_fd=None
    stage='MutationSetup'
    os.mkdir(r+'/jail');os.mkdir(r+'/jail-bind');mount(r+'/jail',r+'/jail-bind');os.mkdir(r+'/extra');os.mkdir(r+'/aba');os.mkdir(r+'/descendant-alias');os.mkdir(r+'/w/node_modules/descendant')
    def observe(mode):
        global stage,first_failure
        phases={'aba':('AbaSpawn','AbaHeader','AbaWindow','AbaRestore','AbaResult','AbaCleanup'),'rename':('RenameSpawn','RenameHeader','RenameWindow','RenameRestore','RenameResult','RenameCleanup'),'physical':('PhysicalSpawn','PhysicalHeader','PhysicalWindow','PhysicalRestore','PhysicalResult','PhysicalCleanup')}[mode]
        stage=phases[0]
        request=dict(spec);request['mode']=mode
        supervisor=subprocess.Popen(['/usr/bin/unshare','--pid','--fork','--kill-child=SIGKILL',sys.executable,'-B','-c',spec['supervisor'],base64.b64encode(json.dumps(request).encode()).decode()],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        mutated=False;restored=mode!='physical'
        try:
            stage=phases[1]
            assert select.select([supervisor.stdout],[],[],10)[0]
            header=json.loads(supervisor.stdout.readline(4096));auditor=header['auditor'];stable_pid=header['stable'];shared_pid=header['shared'];length=header['tableBytes'];stable_length=header['stableTableBytes']
            main_fd=stable_fd=None;first_main_end=first_stable_end=0;main_rewound=main_final_end=False
            stage=phases[2]
            deadline=time.monotonic()+30
            while time.monotonic()<deadline and supervisor.poll() is None:
                active_shared=False
                try:
                    with os.scandir('/proc/'+str(auditor)+'/fd') as entries:
                        for entry in entries:
                            target=os.readlink(entry.path)
                            if target=='/proc/1/task/1/mountinfo':main_fd=entry.name
                            if target=='/proc/'+str(stable_pid)+'/task/'+str(stable_pid)+'/mountinfo':stable_fd=entry.name
                            if target=='/proc/'+str(shared_pid)+'/task/'+str(shared_pid):active_shared=True
                    if main_fd is None or stable_fd is None:continue
                    positions=[]
                    for name in (main_fd,stable_fd):
                        with open('/proc/'+str(auditor)+'/fdinfo/'+name,'rb') as info:data=info.read(8193)
                        assert len(data)<=8192
                        values=[line[5:] for line in data.splitlines() if line.startswith(b'pos:\t')]
                        assert len(values)==1 and values[0].isdigit();positions.append(int(values[0]))
                    main_pos,stable_pos=positions
                except (FileNotFoundError,ProcessLookupError):continue
                if mode=='physical' and mutated:
                    if stable_pos>0:
                        stage=phases[3]
                        os.rmdir(r+'/w/node_modules/descendant');os.rename(r+'/w/node_modules/descendant-parked',r+'/w/node_modules/descendant')
                        with open('/proc/1/mountinfo','rb') as file:restored_text=file.read(8*1024**2+1)
                        restored=len(restored_text)==length and hashlib.sha256(restored_text).hexdigest()==header['mainTableHash'];break
                    continue
                if not first_main_end and main_pos>=length:first_main_end=main_pos
                if not first_stable_end and stable_pos>=stable_length:first_stable_end=stable_pos
                if mode=='physical':
                    ready=bool(first_main_end and stable_pos==0 and active_shared)
                else:
                    if first_main_end and first_stable_end and main_pos<first_main_end-65536:main_rewound=True
                    if main_rewound and main_pos>=first_main_end:main_final_end=True
                    ready=bool(main_rewound and 0<main_pos<first_main_end-65536) if mode=='rename' else bool(main_final_end and 0<stable_pos<first_stable_end-65536)
                if ready:
                    if mode=='aba':mount(source,r+'/aba');unmount(r+'/aba')
                    elif mode=='rename':os.rename(r+'/extra',r+'/extra-renamed')
                    else:os.rename(r+'/w/node_modules/descendant',r+'/w/node_modules/descendant-parked');os.mkdir(r+'/w/node_modules/descendant')
                    mutated=True
                    if mode!='physical':break
            stage=phases[4]
            output,error=supervisor.communicate(timeout=45)
            if supervisor.returncode!=0 or error:adopt_failure(error,('Supervisor','Auditor'))
            assert supervisor.returncode==0 and not error and len(output)<4096
            observed=json.loads(output)
            return mutated and restored and observed['affectedUnknown'] and (mode!='physical' or observed['directFailure']),observed['stableJoined'],observed['distinctReported']
        except BaseException:
            if supervisor.poll() is not None:
                try:
                    _output,error=supervisor.communicate(timeout=5);adopt_failure(error,('Supervisor','Auditor'))
                except BaseException:pass
            first_failure=first_failure or stage
            raise
        finally:
            stage=phases[5]
            if supervisor.poll() is None:supervisor.kill();supervisor.communicate(timeout=5)
            if os.path.exists(r+'/extra-renamed'):os.rename(r+'/extra-renamed',r+'/extra')
            if os.path.exists(r+'/w/node_modules/descendant-parked'):
                os.rmdir(r+'/w/node_modules/descendant');os.rename(r+'/w/node_modules/descendant-parked',r+'/w/node_modules/descendant')
    aba,aba_stable,aba_roots=observe('aba')
    renamed,rename_stable,rename_roots=observe('rename')
    physical,physical_stable,physical_roots=observe('physical')
    stage='FdBoundary'
    budget=p['Budget'](35);task=os.open('/proc/1',p['O_DIR']);root_fd=os.open('root',os.O_RDONLY|os.O_DIRECTORY|os.O_CLOEXEC,dir_fd=task)
    original_limit=resource.getrlimit(resource.RLIMIT_NOFILE);census=os.open('/proc/self/fd',p['O_DIR'])
    try:open_count=len(os.listdir(census))
    finally:os.close(census)
    try:
        resource.setrlimit(resource.RLIMIT_NOFILE,(open_count+2,original_limit[1]))
        low_fd=refused(lambda:p['MountView'](task,p['identity'](task,budget),root_fd,budget),'FdLimit')
    finally:resource.setrlimit(resource.RLIMIT_NOFILE,original_limit);os.close(root_fd);os.close(task)
    # Real bounded reads exhaust the production-sized cumulative limit, with no injected budget state.
    stage='IoBoundary'
    line=b'1 1 0:1 / / rw - tmpfs tmpfs '+b'x'*8100+b'\n';path=r+'/finite-table'
    with open(path,'wb') as output:output.write(line*1024)
    fd=os.open(path,os.O_RDONLY);io_budget=p['Budget'](35)
    try:
        io_failed=False
        for _ in range(130):
            if refused(lambda:p['mount_digest_fd'](fd,io_budget),'ByteLimit'):io_failed=True;break
        os.lseek(fd,0,os.SEEK_SET)
        sticky=io_failed and refused(lambda:list(p['mount_lines'](fd,io_budget)),'ByteLimit') and os.lseek(fd,0,os.SEEK_CUR)==0
    finally:os.close(fd)
    stage='HeapBoundary'
    os.mkdir(r+'/heap');heap_path=r+'/heap/mountinfo'
    with open(heap_path,'wb') as output:
        for index in range(230000):output.write((str(index+1)+' 1 0:1 / / rw - x x rw\n').encode())
    heap_budget=p['Budget'](35);heap_fd=os.open(r+'/heap',p['O_DIR']);held=last=None
    try:
        held,_=p['mount_table'](heap_fd,heap_budget)
        heap_failed=refused(lambda:p['mount_table'](heap_fd,heap_budget),'ByteLimit')
        heap_budget.release_mounts(held);held=None
        last,_=p['mount_table'](heap_fd,heap_budget)
        heap_recovered=heap_failed and len(last)==230000
    finally:
        if held is not None:heap_budget.release_mounts(held)
        if last is not None:heap_budget.release_mounts(last)
        os.close(heap_fd)
    print(json.dumps({'sharedViewBounded':reuse,'descendantReplacementUnknown':physical,'sameInodeDistinctRootReported':physical_roots,'lateAbaPublicationUnknown':aba,'lateRenamePublicationUnknown':renamed,'independentViewJoined':aba_stable and rename_stable and physical_stable,'lowFdRefused':low_fd,'globalIoSticky':sticky,'heapCapAndRollback':heap_recovered}))
except BaseException:
    first_failure=first_failure or stage
    raise
finally:
    stage='DriverCleanup'
    for child in children:
        if child.poll() is None:child.kill()
        child.communicate(timeout=5)
    for group in groups:group.close()
    if items:p['close_cohort'](items,budget)
    if table is not None:budget.release_mounts(table)
    if parent is not None:parent.close()
    if proc is not None:proc.close()
    if self_fd is not None:os.close(self_fd)
    for target in reversed(mounted):
        if lib.umount2(os.fsencode(target),0):raise OSError(ctypes.get_errno())
`;
test('finite joined mount views preserve actual member publication and allocation faults', { timeout: 120_000 }, () => {
  assert.equal(process.platform, 'linux'); assert.equal(process.getuid?.(), 0);
  const root = mkdtempSync(join(tmpdir(), 'TEST-view-lifecycle-'));
  try {
    const encoded = Buffer.from(JSON.stringify({ root, payload: join(artifact, 'audit-payload.py'),
      reader: readerScript, auditor: failureScript + auditorScript, supervisor: failureScript + supervisorScript })).toString('base64');
    let result: unknown;
    let failure: FixtureFailure = FixtureFailure.Unknown;
    try {
      const output = execFileSync('/usr/bin/unshare', ['--mount', '--pid', '--fork', '--kill-child=SIGKILL', '--propagation', 'private',
        '/usr/bin/python3', '-B', '-c', (failureScript + driverScript).replace('__SPEC__', encoded)],
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 110_000, maxBuffer: 4096 });
      failure = FixtureFailure.OutputDecode;
      result = JSON.parse(output);
    } catch (error: unknown) {
      if (failure !== FixtureFailure.OutputDecode && typeof error === 'object' && error !== null && 'stderr' in error) {
        const captured = typeof error.stderr === 'string' ? error.stderr : Buffer.isBuffer(error.stderr) ? error.stderr.toString('utf8') : '';
        failure = Object.values(FixtureFailure).find(code => captured === `VIEW_FIXTURE_FAILURE=${code}\n`) ?? FixtureFailure.Unknown;
      }
      throw new Error(`Finite mount view lifecycle fixture failed: ${failure}`);
    }
    assert.deepEqual(result, { sharedViewBounded: true, descendantReplacementUnknown: true, sameInodeDistinctRootReported: true,
      lateAbaPublicationUnknown: true, lateRenamePublicationUnknown: true, independentViewJoined: true,
      lowFdRefused: true, globalIoSticky: true, heapCapAndRollback: true });
  } finally {
    try { rmSync(root, { recursive: true, force: true }); }
    catch { throw new Error('Finite mount view lifecycle fixture cleanup failed'); }
  }
});
