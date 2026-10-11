/** NEW SOURCE proposal. Native H1/FULL8 NOT_RUN; missing original private tool
 * closure or genuine lifecycle proof is HOLD. No fault hook or recovery grant. */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { basename, dirname } from "node:path";
import { Socket } from "node:net";
import { closeSync, constants as C, fstatSync, fsyncSync, lstatSync, openSync,
  readSync, readFileSync, readlinkSync, readdirSync, statSync, writeFileSync, linkSync,
  unlinkSync, fchmodSync, type BigIntStats } from "node:fs";
import { withOriginalH1PythonTool as pythonTool, withOriginalH1NamespaceTool as namespaceTool } from "../../host-integration/managed-launcher/dependency-full-native-TEST.js";
import * as originalProfile from "../../host-integration/managed-launcher/dependency-full-native-TEST.js";
import { parseDependencyOwner } from "../../dist/core/index.js";
import { HostedActivationPhase } from "../../dist/worker-core/hosted-custody/domain/hosted-installation-activation.js";
import { HostedCustodyReservationState, HostedCustodyPhase } from "../../dist/worker-core/hosted-custody/domain/hosted-custody-epoch.js";
import type { CurrentColdHotRoots } from "./current-cold-hot-root.js";
import type { captureEvictRestoreSentinels } from "./current-evict-restore-sentinels.js";
import type { readEvictRestoreAbsent } from "./current-evict-restore-readback.js";
const runtime="/opt/subscription-runtime-dependency-os-TEST",policy="/var/lib/subscription-runtime-host-policy",
  operations=policy+"/dependency-transactions",outbox="/run/TEST-full-flow-outbox";
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
type Ref=Readonly<{path:string;identity:Readonly<{dev:string;ino:string}>;sha256:string}>;
type Pin=Readonly<{fd:number;path:string;stat:BigIntStats;bytes:Buffer;ref:Ref}>;
const encode=(v:unknown)=>Buffer.from(JSON.stringify(v)+"\n"),digest=(b:Buffer)=>createHash("sha256").update(b).digest("hex");
const equal=(a:unknown,b:unknown)=>encode(a).equals(encode(b));
const identity=(s:BigIntStats)=>({dev:String(s.dev),ino:String(s.ino)});
function fields(v:unknown,names:string):asserts v is Record<string,unknown>{assert(v && typeof v==="object" && !Array.isArray(v));assert.equal(Object.keys(v).sort().join(","),names.split(",").sort().join(","));}
function reference(v:unknown):asserts v is Ref{fields(v,"path,identity,sha256");fields(v.identity,"dev,ino");assert(typeof v.path==="string" && v.path.startsWith(policy+"/") && !v.path.split("/").some(x=>x==="." || x==="..") && !v.path.includes("//"));assert(typeof v.sha256==="string" && /^[a-f0-9]{64}$/.test(v.sha256));for(const n of [v.identity.dev,v.identity.ino])assert(typeof n==="string" && /^(0|[1-9][0-9]*)$/.test(n));}
function absent(path:string):boolean{try{lstatSync(path);return false;}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;return true;}}
function sameStat(a:BigIntStats,b:BigIntStats){return a.dev===b.dev && a.ino===b.ino && a.uid===b.uid && a.mode===b.mode && a.nlink===b.nlink && a.size===b.size && a.ctimeNs===b.ctimeNs && a.mtimeNs===b.mtimeNs;}
function recordStat(s:BigIntStats,uid:bigint,links=1n){assert(s.isFile() && s.uid===uid && s.nlink===links && (s.mode&0o7777n)===0o600n && s.size>0n && s.size<=65536n);}
function pin(path:string,max=65536,uid=0n,mode=0o600):Pin{
  const fd=openSync(path,C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK);
  try{const before=fstatSync(fd,{bigint:true});assert(before.isFile() && before.uid===uid && before.nlink===1n && (before.mode&0o7777n)===BigInt(mode) && before.size>0n && before.size<=BigInt(max) && max<=65536 && max>0);
    assert(sameStat(before,lstatSync(path,{bigint:true})));const buffer=Buffer.alloc(max+1),length=readSync(fd,buffer,0,max+1,0),bytes=buffer.subarray(0,length);assert(BigInt(length)===before.size && length<=max);
    assert(sameStat(before,fstatSync(fd,{bigint:true})) && sameStat(before,lstatSync(path,{bigint:true})));return {fd,path,stat:before,bytes,ref:{path,identity:identity(before),sha256:digest(bytes)}};
  }catch(e){closeSync(fd);throw e;}
}
/** One public compiled TEST source leaf, not a protected-record exception. */
function pinOriginalH1Program():Pin{
  const path=runtime+"/scripts/dependency-retention-os-test/current-removal-h1-fixture.js",max=128*1024,dirs:Readonly<{fd:number;path:string;stat:BigIntStats}>[]=[],namespace=openSync("/proc/self/ns/mnt",C.O_RDONLY),ns=fstatSync(namespace,{bigint:true});let fd:number|undefined;
  const rejoin=()=>{assert(equal(identity(fstatSync(namespace,{bigint:true})),identity(ns)) && equal(identity(statSync("/proc/self/ns/mnt",{bigint:true})),identity(ns)));for(const d of dirs)for(const s of [fstatSync(d.fd,{bigint:true}),lstatSync(d.path,{bigint:true})])assert(s.isDirectory() && s.uid===0n && s.gid===0n && !(s.mode&0o022n) && s.mode===d.stat.mode && equal(identity(s),identity(d.stat)));};
  try{let parent=openSync("/",C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW);dirs.push({fd:parent,path:"/",stat:fstatSync(parent,{bigint:true})});let named="";for(const component of ["opt","subscription-runtime-dependency-os-TEST","scripts","dependency-retention-os-test"]){named+="/"+component;parent=openSync("/proc/self/fd/"+parent+"/"+component,C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW);dirs.push({fd:parent,path:named,stat:fstatSync(parent,{bigint:true})});}rejoin();const anchored="/proc/self/fd/"+parent+"/current-removal-h1-fixture.js";fd=openSync(anchored,C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK);const before=fstatSync(fd,{bigint:true});assert(before.isFile() && before.uid===0n && before.gid===0n && before.nlink===1n && (before.mode&0o7777n)===0o644n && before.size>0n && before.size<=BigInt(max) && sameStat(before,lstatSync(anchored,{bigint:true})));const buffer=Buffer.alloc(max+1),length=readSync(fd,buffer,0,max+1,0);assert(length<=max && BigInt(length)===before.size);const bytes=buffer.subarray(0,length);rejoin();assert(sameStat(before,fstatSync(fd,{bigint:true})) && sameStat(before,lstatSync(anchored,{bigint:true})) && sameStat(before,lstatSync(path,{bigint:true})));const kept=fd;fd=undefined;return {fd:kept,path,stat:before,bytes,ref:{path,identity:identity(before),sha256:digest(bytes)}};
  }finally{if(fd!==undefined)closeSync(fd);for(const d of dirs)closeSync(d.fd);closeSync(namespace);}
}
export function readOriginalH1ProgramSource():Readonly<{bytes:Buffer;reference:Ref}>{const p=pinOriginalH1Program();try{return {bytes:p.bytes,reference:p.ref};}finally{closeSync(p.fd);}}
function json(p:Pin):unknown{const v:unknown=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(p.bytes));assert(p.bytes.equals(encode(v)));return v;}
function directory(path:string,uid=0n){const fd=openSync(path,C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW),s=fstatSync(fd,{bigint:true});try{const n=lstatSync(path,{bigint:true});assert(s.isDirectory() && n.isDirectory() && s.uid===uid && (s.mode&0o7777n)===0o700n && equal(identity(s),identity(n)) && n.uid===s.uid && n.mode===s.mode);return fd;}catch(e){closeSync(fd);throw e;}}
function checkDirectory(fd:number,path:string,original:BigIntStats,uid:bigint){for(const s of [fstatSync(fd,{bigint:true}),lstatSync(path,{bigint:true})])assert(s.isDirectory() && s.uid===uid && s.mode===original.mode && (s.mode&0o7777n)===0o700n && equal(identity(s),identity(original)));}
export enum H1ReadinessRecord {Request="removal-h1-request.json",Armed="removal-h1-armed.json",Dead="removal-h1-parent-dead.json",Accepted="removal-h1-supervisor-accepted.json",Recovery="removal-h1-recovery-birth.json"}
const names=new Set<string>(Object.values(H1ReadinessRecord));
/** Finite TEST filesystem transport only. An interrupted publication is kept. */
export function publishH1ReadinessRecord(parent:string,name:H1ReadinessRecord,bytes:Buffer):void{
  assert(names.has(name) && bytes.length>0 && bytes.length<=65536);const uid=BigInt(process.getuid!()),dir=directory(parent,uid),ds=fstatSync(dir,{bigint:true}),base="/proc/self/fd/"+dir,temp=base+"/."+name+".publishing";let fd:number|undefined;
  try{fd=openSync(temp,C.O_WRONLY|C.O_CREAT|C.O_EXCL|C.O_NOFOLLOW,0o600);writeFileSync(fd,bytes);fsyncSync(fd);const original=fstatSync(fd,{bigint:true});recordStat(original,uid);assert(original.size===BigInt(bytes.length));assert(sameStat(original,lstatSync(temp,{bigint:true})));checkDirectory(dir,parent,ds,uid);
    linkSync(temp,base+"/"+name);const linked=fstatSync(fd,{bigint:true});recordStat(linked,uid,2n);for(const p of [temp,base+"/"+name]){const s=lstatSync(p,{bigint:true});assert(sameStat(s,linked));}checkDirectory(dir,parent,ds,uid);
    unlinkSync(temp);recordStat(fstatSync(fd,{bigint:true}),uid);fsyncSync(dir);checkDirectory(dir,parent,ds,uid);
  }finally{if(fd!==undefined)closeSync(fd);closeSync(dir);}
}
function tryReady(parent:string,name:H1ReadinessRecord,max=65536):Pin|undefined{
  assert(names.has(name));const uid=BigInt(process.getuid!()),dir=directory(parent,uid),ds=fstatSync(dir,{bigint:true}),base="/proc/self/fd/"+dir,final=base+"/"+name,temp=base+"/."+name+".publishing";let fd:number|undefined;
  try{try{fd=openSync(final,C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK);}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return undefined;throw e;}const before=fstatSync(fd,{bigint:true});assert(equal(identity(before),identity(lstatSync(final,{bigint:true}))));
    if(before.nlink===2n){recordStat(before,uid,2n);if(absent(temp)){for(const s of [fstatSync(fd,{bigint:true}),lstatSync(final,{bigint:true})]){recordStat(s,uid);assert(equal(identity(s),identity(before)) && s.size===before.size && s.mode===before.mode && s.mtimeNs===before.mtimeNs);}}else{const pending=lstatSync(temp,{bigint:true});recordStat(pending,uid,2n);assert(equal(identity(pending),identity(before)) && pending.mode===before.mode && pending.size===before.size);}checkDirectory(dir,parent,ds,uid);return undefined;}
    recordStat(before,uid);assert(absent(temp));checkDirectory(dir,parent,ds,uid);fsyncSync(dir);checkDirectory(dir,parent,ds,uid);
    assert(sameStat(before,fstatSync(fd,{bigint:true})) && sameStat(before,lstatSync(final,{bigint:true})));assert(Number.isSafeInteger(max) && max>0 && max<=65536 && before.size<=BigInt(max));
    const b=Buffer.alloc(max+1),length=readSync(fd,b,0,max+1,0),bytes=b.subarray(0,length);assert(BigInt(length)===before.size && length<=max);assert(sameStat(before,fstatSync(fd,{bigint:true})) && sameStat(before,lstatSync(final,{bigint:true})));checkDirectory(dir,parent,ds,uid);
    const kept=fd;fd=undefined;return {fd:kept,path:parent+"/"+name,stat:before,bytes,ref:{path:parent+"/"+name,identity:identity(before),sha256:digest(bytes)}};
  }finally{if(fd!==undefined)closeSync(fd);closeSync(dir);}
}
export function readH1ReadinessRecord(parent:string,name:H1ReadinessRecord):Buffer|undefined{const p=tryReady(parent,name);if(!p)return;try{return p.bytes;}finally{closeSync(p.fd);}}
function waitReady(parent:string,name:H1ReadinessRecord,max:number,end:number):Pin{assert(Number.isFinite(end) && end<=performance.now()+2000);while(performance.now()<end){const p=tryReady(parent,name,max);if(p){if(performance.now()>=end){closeSync(p.fd);throw new Error("TEST_H1_record_HOLD");}return p;}const remaining=end-performance.now();if(remaining>0)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,Math.min(10,remaining));}throw new Error("TEST_H1_record_HOLD");}
function ready(parent:string,name:H1ReadinessRecord,max=65536):Pin{const p=waitReady(parent,name,max,performance.now()+2000);if(p.stat.uid!==0n){closeSync(p.fd);assert.fail("TEST_H1_record_owner_HOLD");}return p;}
/** Finite factual transport for the original request/death pair. No root or
 * recovery permission follows from these bytes. One caller deadline covers
 * both exact names, including verified pending publication states. */
export function waitH1OriginalDeathPublication(parent:string,end:number):Readonly<{request:Buffer;dead:Buffer}>{
  const request=waitReady(parent,H1ReadinessRecord.Request,16384,end);let dead:Pin|undefined;
  try{parseH1Request(json(request));dead=waitReady(parent,H1ReadinessRecord.Dead,65536,end);json(dead);for(const p of [request,dead])assert(sameStat(p.stat,fstatSync(p.fd,{bigint:true})) && sameStat(p.stat,lstatSync(p.path,{bigint:true})));if(performance.now()>=end)throw new Error("TEST_H1_record_HOLD");return {request:request.bytes,dead:dead.bytes};}finally{closeSync(request.fd);if(dead)closeSync(dead.fd);}
}
export enum FullH1Case {Positive="positive",ParentCrash="parent_crash_h1"}
export enum H1ObserverState {Armed="armed",ParentDead="original_parent_dead"}
export const h1Qualification="native_actual_c_cold_hot_evicted_sameboot_removal_recovery_only";
export type H1Request=Readonly<{schemaVersion:1;purpose:"TEST_original_removal_H1_request_only";sourceSha:string;jobId:string;revision:number;parentBirth:string;bootId:string;supervisorId:string;workspace:Readonly<{canonicalPath:string;dev:string;ino:string}>;absent:Ref}>;
export function parseH1Request(v:unknown):H1Request{
  fields(v,"schemaVersion,purpose,sourceSha,jobId,revision,parentBirth,bootId,supervisorId,workspace,absent");fields(v.workspace,"canonicalPath,dev,ino");reference(v.absent);
  assert(v.schemaVersion===1 && v.purpose==="TEST_original_removal_H1_request_only" && typeof v.sourceSha==="string" && /^[a-f0-9]{40}$/.test(v.sourceSha));assert(typeof v.jobId==="string" && v.jobId.startsWith("TEST-os-") && uuid.test(v.jobId.slice(8)));assert(typeof v.revision==="number" && Number.isSafeInteger(v.revision) && v.revision>0);
  assert(typeof v.parentBirth==="string" && /^[1-9][0-9]*:[1-9][0-9]*$/.test(v.parentBirth));assert(typeof v.supervisorId==="string" && /^[1-9][0-9]*:[1-9][0-9]*$/.test(v.supervisorId));assert(typeof v.bootId==="string" && uuid.test(v.bootId));
  assert(v.workspace.canonicalPath===policy+"/dependency-test-jobs/jobs/"+v.jobId+"/workspace");assert(typeof v.workspace.dev==="string" && /^(0|[1-9][0-9]*)$/.test(v.workspace.dev));assert(typeof v.workspace.ino==="string" && /^[1-9][0-9]*$/.test(v.workspace.ino));return {schemaVersion:1,purpose:v.purpose,sourceSha:v.sourceSha,jobId:v.jobId,revision:v.revision,parentBirth:v.parentBirth,supervisorId:v.supervisorId,bootId:v.bootId,workspace:{canonicalPath:v.workspace.canonicalPath,dev:v.workspace.dev,ino:v.workspace.ino},absent:v.absent};
}
export function originalH1Case():FullH1Case{const p=pin("/var/lib/subscription-runtime-full-parent-live/seals/current-full-pair.json",16384);try{const v=json(p);assert(v && typeof v==="object" && "sourceSha" in v && "removalCase" in v && "restoreConsumer" in v);assert.equal(v.sourceSha,process.env.TEST_SOURCE_SHA);assert(v.removalCase===FullH1Case.ParentCrash && v.restoreConsumer==="ordinary");return FullH1Case.ParentCrash;}finally{closeSync(p.fd);}}
function birth(proc:string):string{const s=readFileSync(proc+"/stat","utf8"),value=s.slice(s.lastIndexOf(") ")+2).trim().split(/\s+/)[19];assert(value && /^[1-9][0-9]*$/.test(value));return value;}
function bounded(path:string,max:number):string{const fd=openSync(path,C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK);try{const b=Buffer.alloc(max+1);let length=0;while(length<=max){const n=readSync(fd,b,length,b.length-length,null);if(!n)break;length+=n;}assert(length<=max);return new TextDecoder("utf-8",{fatal:true}).decode(b.subarray(0,length));}finally{closeSync(fd);}}
// One fixed administrative observer, max2 inode marks, no caller command/PID.
const kernel=String.raw`
import ctypes,hashlib,json,os,select,signal,stat,struct,sys,time
c=json.loads(sys.argv[1]);deadline=time.monotonic()+30;flags=os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC|os.O_NONBLOCK
assert os.getuid()==0 and sys.platform=='linux' and c['purpose']=='TEST_original_removal_H1_only'
lib=ctypes.CDLL(None,use_errno=True)
lib.fanotify_init.argtypes=[ctypes.c_uint,ctypes.c_uint];lib.fanotify_init.restype=ctypes.c_int
lib.fanotify_mark.argtypes=[ctypes.c_int,ctypes.c_uint,ctypes.c_uint64,ctypes.c_int,ctypes.c_char_p];lib.fanotify_mark.restype=ctypes.c_int
fan=lib.fanotify_init(0x87,os.O_RDONLY|os.O_CLOEXEC|os.O_NONBLOCK);assert fan>=0,ctypes.get_errno()
held=None;original=None;marks=0;events=0;dead=False
enc=lambda v:(json.dumps(v,separators=(',',':'),ensure_ascii=False)+'\n').encode()
def readfd(fd,path):
 a=os.fstat(fd);assert stat.S_ISREG(a.st_mode) and a.st_uid==0 and a.st_nlink==1 and stat.S_IMODE(a.st_mode)==0o600 and 0<a.st_size<=65536
 b=os.pread(fd,65537,0);z=os.fstat(fd);assert len(b)==a.st_size and (a.st_dev,a.st_ino,a.st_mode,a.st_nlink,a.st_size,a.st_ctime_ns,a.st_mtime_ns)==(z.st_dev,z.st_ino,z.st_mode,z.st_nlink,z.st_size,z.st_ctime_ns,z.st_mtime_ns)
 v=json.loads(b);assert enc(v)==b;return v,{'path':path,'identity':{'dev':str(a.st_dev),'ino':str(a.st_ino)},'sha256':hashlib.sha256(b).hexdigest()}
def pin(name,dirfd=3,path=None):
 assert '/' not in name and '\0' not in name;fd=os.open(name,flags,dir_fd=dirfd)
 try:
  v,r=readfd(fd,path or c['operations']+'/'+name);n=os.stat(name,dir_fd=dirfd,follow_symlinks=False);assert (n.st_dev,n.st_ino)==(os.fstat(fd).st_dev,os.fstat(fd).st_ino);return v,r
 finally:os.close(fd)
def proc(fd,name):
 p=os.open(name,flags,dir_fd=fd)
 try:b=os.read(p,32769);assert len(b)<=32768;return b.decode()
 finally:os.close(p)
def ticks(fd):
 s=proc(fd,'stat');return s[s.rfind(')')+2:].split()[19]
def parent():
 assert ticks(8)==c['parentTicks'] and ticks(9)==c['supervisorTicks']
 assert proc(8,'cgroup')==proc(9,'cgroup')==c['group']
 assert proc(8,'cmdline')==c['parentArgv'] and proc(9,'cmdline')==c['supervisorArgv']
 assert os.readlink('ns/pid',dir_fd=8)==os.readlink('ns/pid',dir_fd=9)==c['pidNamespace']
 s=proc(8,'stat');assert s[s.rfind(')')+2:].split()[1]==str(c['supervisorPid'])
 assert os.readlink('ns/user',dir_fd=8)=='user:[4026531837]'
 request,r=readfd(10,c['requestPath']);assert request==c['request'] and r['sha256']==c['requestDigest']
 backing,r=readfd(11,c['backingPath']);assert r['sha256']==c['backingDigest']
 assert open('/proc/sys/kernel/random/boot_id').read().strip()==c['request']['bootId']
def records():
 lock,lr=pin(c['evictionId']+'.remove.lock');assert lock['version']==2 and lock['kind']=='removal_lock' and lock['absent']==c['request']['absent'] and lock['evictionOperationId']==c['evictionId']
 op=lock['firstAttempt']['operationId'];claim,cr=pin(op+'.removal-claim.json');actor,ar=pin(op+'.removal-actor.json');retired,rr=pin(op+'.removal-retirement.json');completion,co=pin(op+'.removal-session-closed.json');consumed,cn=pin(op+'.removal-consumed.json')
 assert claim['binding']['jobId']==c['request']['jobId'] and claim['binding']['workspace']==c['request']['workspace'] and claim['absent']['reference']==c['request']['absent'] and claim['absent']['receipt']['revision']==c['request']['revision']
 assert claim['previousClaim'] is None and claim['previousRetirement'] is None
 assert actor['claim']==cr and actor['parent']['pidBirth']==c['request']['parentBirth'] and actor['parent']['supervisorId']==c['request']['supervisorId'] and actor['parent']['bootId']==c['request']['bootId']
 assert actor['parent']['unit']=='TEST-retention-supervisor.service' and actor['parent']['controlGroup']=='/system.slice/TEST-retention-supervisor.service' and actor['parent']['invocationId']==c['supervisorInvocation']
 assert lock['actor']==ar and retired['claim']==cr and retired['actor']==ar and retired['lock']==lr and retired['consumed']==cn and consumed=={'version':1,'claim':cr,'actor':ar}
 assert retired['parentClosed'] is not None and retired['proxyRevoked'] is None and retired['native']['cgroup'] in ['empty','absent']
 assert completion['claim']==cr and completion['actor']==ar and completion['disposition']=='removed' and type(completion['removedEntries']) is int and completion['removedEntries']>0
 return op,lr,claim,cr,ar,rr,co,completion['removedEntries']
def completed(row):
 op,lr,claim,cr,ar,rr,co,count=row;owner,ow=pin(c['key']+'.json',4,c['ownerPath'])
 if owner.get('owner') is None or owner['owner'].get('phase')!='fenced':return None
 assert owner['owner']['attempt']==claim['claimed']['owner']['attempt'] and owner['revision']==claim['claimed']['revision']+1 and owner['epoch']==claim['claimed']['epoch']
 idle,ir=pin(c['key']+'-'+str(owner['revision']+1)+'.removal-idle.json');assert idle['fenced']==owner and idle['claim']==cr and idle['retirement']==rr and idle['completion']==co and idle['released']==dict(owner,revision=owner['revision']+1,owner=None)
 d=os.open('readonly-epoch.'+c['request']['bootId']+'.lock',flags|os.O_DIRECTORY,dir_fd=5)
 try:
  witness,wr=pin('owner.json',d,c['policy']+'/readonly-epoch.'+c['request']['bootId']+'.lock/owner.json')
  assert os.listdir(d)==['owner.json'] and witness['purpose']=='retire_completed_dependency_removal_v1' and witness['bootId']==c['request']['bootId'] and witness['claim']==cr and witness['actor']==ar and witness['lock']==lr and witness['completion']==co
  assert witness['mutex']=={'dev':str(os.fstat(d).st_dev),'ino':str(os.fstat(d).st_ino)} and witness['parent']=={'dev':str(os.fstat(5).st_dev),'ino':str(os.fstat(5).st_ino)}
 finally:os.close(d)
 return {'owner':owner,'claim':cr,'actor':ar,'retirement':rr,'completion':co,'idle':ir,'witness':wr,'witnessReceipt':witness,'lock':lr,'removedEntries':count}
def mark(fd):
 global marks;marks+=1;assert marks<=2;assert lib.fanotify_mark(fan,1,0x10000,fd,None)==0,ctypes.get_errno()
def output(name,v):
 assert name in ['removal-h1-before-kill.json','removal-h1-parent-dead.json'];temp='.'+name+'.publishing';fd=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600,dir_fd=6)
 try:
  b=enc(v);assert 0<len(b)<=65536;at=0
  while at<len(b):n=os.write(fd,b[at:]);assert n>0;at+=n
  os.fsync(fd);s=os.fstat(fd);assert s.st_nlink==1 and s.st_size==len(b) and s.st_uid==0 and stat.S_IMODE(s.st_mode)==0o600;named=os.stat(temp,dir_fd=6,follow_symlinks=False);assert (named.st_dev,named.st_ino)==(s.st_dev,s.st_ino)
  os.link(temp,name,src_dir_fd=6,dst_dir_fd=6,follow_symlinks=False)
  for n in [temp,name]:s2=os.stat(n,dir_fd=6,follow_symlinks=False);assert s2.st_nlink==2 and (s2.st_dev,s2.st_ino)==(s.st_dev,s.st_ino)
  os.unlink(temp,dir_fd=6);assert os.fstat(fd).st_nlink==1;os.fsync(6)
 finally:os.close(fd)
try:
 parent();seed,sr=readfd(7,c['request']['absent']['path']);assert sr==c['request']['absent'];mark(7);print('armed',flush=True)
 while not dead and time.monotonic()<deadline:
  if not select.select([fan],[],[],max(0,deadline-time.monotonic()))[0]:break
  data=os.read(fan,65536);offset=0
  while offset<len(data):
   length,version,reserved,meta,mask,fd,pid=struct.unpack_from('=IBBHQii',data,offset);assert version==3 and meta==24 and length==32 and offset+length<=len(data) and mask==0x10000 and fd>=0
   info,reserved,ilen,pidfd=struct.unpack_from('=BBHi',data,offset+meta);assert info==4 and ilen==8 and pidfd>=0;offset+=length;events+=1;assert events<=4096;response=1
   try:
    event=os.fstat(fd);target=held is not None and (event.st_dev,event.st_ino)==(os.fstat(held).st_dev,os.fstat(held).st_ino);assert target or (event.st_dev,event.st_ino)==(os.fstat(7).st_dev,os.fstat(7).st_ino)
    if pid!=c['parentPid']:continue
    parent()
    if not target and held is None:
     try:original=records()
     except FileNotFoundError:original=None
     if original is not None:held=os.open(c['evictionId']+'.remove.lock',flags,dir_fd=3);v,r=readfd(held,c['operations']+'/'+c['evictionId']+'.remove.lock');assert r==original[1];mark(held)
    elif target:
     lock,lr=readfd(held,c['operations']+'/'+c['evictionId']+'.remove.lock');assert lr==original[1];op=original[0];claim,cr=pin(op+'.removal-claim.json');actor,ar=pin(op+'.removal-actor.json');retired,rr=pin(op+'.removal-retirement.json');completion,co=pin(op+'.removal-session-closed.json');assert (lr,claim,cr,ar,rr,co,completion['removedEntries'])==original[1:]
     try:snapshot=completed(original)
     except FileNotFoundError:snapshot=None
     if snapshot is not None:
      parent();fdinfo=open('/proc/self/fdinfo/'+str(pidfd)).read(4097);assert len(fdinfo)<=4096 and ('Pid:\t'+str(c['parentPid'])+'\n') in fdinfo
      assert lock['firstAttempt']==claim['claimed']['owner']['attempt'];output('removal-h1-before-kill.json',dict(snapshot,purpose='TEST_H1_before_positive_lock_unlink',parentBirth=c['request']['parentBirth']))
      signal.pidfd_send_signal(pidfd,signal.SIGKILL,None,0);response=None;os.write(fan,struct.pack('=iI',fd,2));assert select.select([pidfd],[],[],2)[0]
      named=os.stat(c['evictionId']+'.remove.lock',dir_fd=3,follow_symlinks=False);assert (named.st_dev,named.st_ino)==(event.st_dev,event.st_ino)
      output('removal-h1-parent-dead.json',{'purpose':'TEST_actual_original_parent_death_only','snapshot':snapshot,'parentBirth':c['request']['parentBirth'],'eventHostPid':pid,'kernelPidfdDeath':True});dead=True
   finally:
    if response is not None:os.write(fan,struct.pack('=iI',fd,response))
    os.close(fd);os.close(pidfd)
 assert dead,'TEST_H1_NOT_RUN';print('original_parent_dead',flush=True)
finally:
 os.close(fan)
 if held is not None:os.close(held)
`;
type Observer={child:ChildProcess;birth:string;argv:Buffer;exe:BigIntStats;parentBirth:string;request:H1Request;requestRef:Ref;root:string;hostOutbox:string;hostParent:Ref["identity"];hostDirectory:Ref["identity"];descriptors:readonly number[];stdio:readonly BigIntStats[];sources:readonly BigIntStats[];parentPid:number;lock:string;closed:boolean};
const observers=new WeakMap<object,Observer>();
type H1PreparedObserver=ReturnType<typeof retainOriginalH1ObserverInputs>;
const preparedObservers=new WeakMap<object,H1PreparedObserver>();
/** Fixed source-owned input custody, never a caller FD/namespace registry. */
function retainOriginalH1ObserverInputs(parent:originalProfile.FullParentSession){
  originalProfile.assertRetainedCurrentFullParent(parent);assert(!observers.has(parent) && !preparedObservers.has(parent));
  const held:Pin[]=[],dirs:number[]=[];
  const keep=(path:string,max?:number)=>{const p=pin(path,max);held.push(p);return p;},dir=(path:string)=>{const fd=directory(path);dirs.push(fd);return fd;},procDir=(path:string)=>{const fd=openSync(path,C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW);dirs.push(fd);return fd;};
  try{
    const pairPin=keep(originalProfile.fullNativeLiveRoot+"/current-full-pair.json"),backingPin=keep(originalProfile.fullNativeLiveRoot+"/current-full-backing.json"),pair=json(pairPin),backing=json(backingPin);
    assert(pair && typeof pair==="object" && backing && typeof backing==="object");const p=pair as Record<string,unknown>,b=backing as Record<string,unknown>;assert(p.removalCase===FullH1Case.ParentCrash && (p.restoreConsumer??"ordinary")==="ordinary" && p.sourceSha===process.env.TEST_SOURCE_SHA && b.pairSha256===pairPin.ref.sha256 && typeof p.root==="string" && typeof p.unit==="string");
    const id=/^TEST-retention-os-([a-f0-9-]{36})\.service$/.exec(p.unit)?.[1];assert(originalProfile.fullNativeGuestRoot(id,p.root));const g=b.guest;assert(g && typeof g==="object");const guest=g as Record<string,unknown>;assert(Number.isSafeInteger(guest.pid) && Number(guest.pid)>1 && typeof guest.birth==="string" && typeof guest.pidNamespace==="string");
    const root="/proc/"+guest.pid+"/root";assert.equal(birth("/proc/"+guest.pid),guest.birth);assert.equal(readlinkSync("/proc/"+guest.pid+"/ns/pid"),guest.pidNamespace);const rs=statSync(root,{bigint:true});assert.equal(String(rs.dev),p.rootDev);assert.equal(String(rs.ino),p.rootIno);
    const requestPin=ready(root+outbox,H1ReadinessRecord.Request,16384);held.push(requestPin);const request=parseH1Request(json(requestPin));assert.equal(request.sourceSha,p.sourceSha);
    const activationPin=keep(root+policy+"/host-activation.json"),activation=json(activationPin);assert(activation && typeof activation==="object" && "bootId" in activation && "supervisorId" in activation);assert.equal(activation.bootId,request.bootId);assert.equal(activation.supervisorId,request.supervisorId);
    const roster=bounded(root+"/sys/fs/cgroup/system.slice/TEST-retention-supervisor.service/cgroup.procs",4096).trim().split(/\s+/);assert(roster.length>=2 && roster.length<=16 && new Set(roster).size===roster.length && roster.every(x=>/^[1-9][0-9]*$/.test(x)));
    const select=(value:string)=>{const [pid,ticks]=value.split(":");const found=roster.filter(host=>birth("/proc/"+host)===ticks && /^NSpid:\s+([0-9 \t]+)$/m.exec(bounded("/proc/"+host+"/status",32768))?.[1]?.trim().split(/\s+/).at(-1)===pid);assert.equal(found.length,1);return Number(found[0]);};
    const parentPid=select(request.parentBirth),supervisorPid=select(request.supervisorId);assert.notEqual(parentPid,supervisorPid);
    const parentArgv=[runtime+"/toolchain/bin/node",runtime+"/scripts/dependency-retention-os-test/current-full-guest.js","qualify","--parent-crash-h1",""] .join("\0"),supervisorArgv=[runtime+"/toolchain/bin/node","--experimental-strip-types",runtime+"/scripts/dependency-retention-os-test/current-full-supervisor.js","supervisor","--parent-crash-h1",""] .join("\0");
    assert.equal(bounded("/proc/"+parentPid+"/cmdline",32768),parentArgv);assert.equal(bounded("/proc/"+supervisorPid+"/cmdline",32768),supervisorArgv);const group=bounded("/proc/"+parentPid+"/cgroup",4096);assert.equal(group,bounded("/proc/"+supervisorPid+"/cgroup",4096));assert(group.endsWith("/system.slice/TEST-retention-supervisor.service\n"));
    assert(Array.isArray(p.guestSources));for(const path of [runtime+"/toolchain/bin/node",runtime+"/scripts/dependency-retention-os-test/current-full-guest.js",runtime+"/scripts/dependency-retention-os-test/current-full-supervisor.js"]){const rows:unknown[]=p.guestSources.filter((v:unknown)=>v && typeof v==="object" && "path" in v && v.path===path);assert.equal(rows.length,1);assert.equal(digest(readFileSync(root+path)),(rows[0] as {sha256:unknown}).sha256);}
    const absentPin=keep(root+request.absent.path),av=json(absentPin);assert(equal({...absentPin.ref,path:request.absent.path},request.absent));assert(av && typeof av==="object" && "state" in av && "operationId" in av && "revision" in av && "workspace" in av);assert(av.state==="absent" && typeof av.operationId==="string" && uuid.test(av.operationId) && av.revision===request.revision && equal(av.workspace,request.workspace));
    const ops=dir(root+operations),owner=dir(root+policy+"/dependency-owners"),pd=dir(root+policy),od=dir(root+outbox),pp=procDir("/proc/"+parentPid),sp=procDir("/proc/"+supervisorPid);
    const hostOutbox=dirname(p.root)+"/policy-request-outbox",hostParentFd=directory(dirname(p.root));let hostFd:number|undefined,hostParent!:Ref["identity"],hostDirectory!:Ref["identity"];
    try{hostFd=directory("/proc/self/fd/"+hostParentFd+"/policy-request-outbox");hostParent=identity(fstatSync(hostParentFd,{bigint:true}));hostDirectory=identity(fstatSync(hostFd,{bigint:true}));assert(equal(hostDirectory,identity(fstatSync(od,{bigint:true}))));const hp=ready(hostOutbox,H1ReadinessRecord.Request,16384);try{assert(equal({...hp.ref,path:requestPin.ref.path},requestPin.ref) && equal(parseH1Request(json(hp)),request));}finally{closeSync(hp.fd);}parent.revalidate();assert.equal(birth("/proc/"+guest.pid),guest.birth);}finally{if(hostFd!==undefined)closeSync(hostFd);closeSync(hostParentFd);}
    const config={purpose:"TEST_original_removal_H1_only",request,operations,policy,key:request.workspace.dev+"-"+request.workspace.ino,evictionId:av.operationId,ownerPath:policy+"/dependency-owners/"+request.workspace.dev+"-"+request.workspace.ino+".json",parentPid,parentTicks:birth("/proc/"+parentPid),supervisorPid,supervisorTicks:birth("/proc/"+supervisorPid),group,parentArgv,supervisorArgv,pidNamespace:guest.pidNamespace,supervisorInvocation:null,requestPath:outbox+"/"+H1ReadinessRecord.Request,requestDigest:requestPin.ref.sha256,backingPath:originalProfile.fullNativeLiveRoot+"/current-full-backing.json",backingDigest:backingPin.ref.sha256};
    const mnt=openSync("/proc/"+guest.pid+"/ns/mnt",C.O_RDONLY);dirs.push(mnt);
    const pidns=openSync("/proc/"+guest.pid+"/ns/pid",C.O_RDONLY);dirs.push(pidns);
    const rootFd=openSync(root,C.O_RDONLY);dirs.push(rootFd);const ns=[mnt,pidns,rootFd] as const;
    const anchors=Object.freeze([ops,owner,pd,od,absentPin.fd,pp,sp,requestPin.fd,backingPin.fd]);
    const fixedDirs=dirs.map(fd=>({fd,stat:fstatSync(fd,{bigint:true})}));
    const guestBoot=bounded(root+"/proc/sys/kernel/random/boot_id",128).trim();assert.equal(guestBoot,request.bootId);
    let closed=false;
    function revalidateSources(){
      assert(!closed);parent.revalidate();assert.equal(birth("/proc/"+guest.pid),guest.birth);
      assert.equal(readlinkSync("/proc/"+guest.pid+"/ns/pid"),guest.pidNamespace);
      assert.equal(String(statSync(root,{bigint:true}).dev),p.rootDev);assert.equal(String(statSync(root,{bigint:true}).ino),p.rootIno);
      for(const pin of held){assert(sameStat(pin.stat,fstatSync(pin.fd,{bigint:true})) && sameStat(pin.stat,lstatSync(pin.path,{bigint:true})));const bytes=Buffer.alloc(pin.bytes.length+1),size=readSync(pin.fd,bytes,0,bytes.length,0);assert(size===pin.bytes.length && bytes.subarray(0,size).equals(pin.bytes) && sameStat(pin.stat,fstatSync(pin.fd,{bigint:true})));}
      for(const d of fixedDirs){const actual=fstatSync(d.fd,{bigint:true});assert(equal(identity(actual),identity(d.stat)) && actual.mode===d.stat.mode && actual.uid===d.stat.uid && actual.gid===d.stat.gid);}
      assert.equal(birth("/proc/"+supervisorPid),config.supervisorTicks);
      assert.equal(bounded(root+"/proc/sys/kernel/random/boot_id",128).trim(),guestBoot);parent.revalidate();
    }
    function revalidate(){revalidateSources();assert.equal(birth("/proc/"+parentPid),config.parentTicks);revalidateSources();}
    function close(){if(closed)return;closed=true;for(const fd of dirs)closeSync(fd);for(const pin of held)closeSync(pin.fd);}
    revalidate();return {config,anchors,queryAnchors:ns,revalidate,revalidateSources,descriptors:()=>Object.freeze(closed?[]:[...dirs,...held.map(pin=>pin.fd)]),close,request,requestPin,root,hostOutbox,hostParent,hostDirectory,parentPid,evictionId:av.operationId};
  }catch(error){for(const fd of dirs)closeSync(fd);for(const pin of held)closeSync(pin.fd);throw error;}
}
/** Query program stays fixed SOURCE and performs no fanotify work before the
 * constructor consumes actual private query attribution and closes its gates. */
const stagedQuery=String.raw`
qr,qw=os.pipe();er,ew=os.pipe();ar,aw=os.pipe()
query=os.fork()
if query==0:
 os.close(qr);os.close(er);os.close(ar)
 assert os.read(0,1)==b'2'
 os.write(aw,b'1');os.close(aw)
 os.dup2(qw,1);os.dup2(ew,2);os.close(qw);os.close(ew)
 for fd in range(3,12):os.close(fd)
 for fd in (13,14,15):os.set_inheritable(fd,True)
 os.execve('/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2',['/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2','--inhibit-cache','--library-path','/usr/lib/x86_64-linux-gnu:/usr/lib/x86_64-linux-gnu/systemd','/usr/bin/nsenter','--mount=/proc/self/fd/13','--pid=/proc/self/fd/14','--root=/proc/self/fd/15','--wdns=/','--','/usr/bin/systemctl','--system','show','--property=Id,MainPID,InvocationID,ControlGroup,ActiveState,Job','--','TEST-retention-supervisor.service'],{'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C','DBUS_SYSTEM_BUS_ADDRESS':'unix:path=/run/systemd/private'})
os.close(qw);os.close(ew);os.close(aw)
queryfd=os.pidfd_open(query,0)
print('query:'+str(query),flush=True)
try:
 assert select.select([ar],[],[],max(0,deadline-time.monotonic()))[0] and os.read(ar,2)==b'1'
 os.close(ar);ar=None;queryend=min(deadline,time.monotonic()+2);data=b'';errors=b'';streams={qr,er}
 while streams:
  ready=select.select(list(streams),[],[],max(0,queryend-time.monotonic()))[0];assert ready,'TEST_H1_query_timeout_HOLD'
  for fd in ready:
   chunk=os.read(fd,4097)
   if fd==qr:data+=chunk
   else:errors+=chunk
   assert len(data)+len(errors)<=4096
   if not chunk:streams.remove(fd)
 assert not errors and select.select([queryfd],[],[],max(0,queryend-time.monotonic()))[0]
 assert os.waitpid(query,0)[1]==0
 values={}
 for line in data.decode().rstrip('\n').split('\n'):
  key,value=line.split('=',1);assert key not in values;values[key]=value
 assert sorted(values)==['ActiveState','ControlGroup','Id','InvocationID','Job','MainPID']
 assert values['Id']=='TEST-retention-supervisor.service' and values['MainPID']==c['request']['supervisorId'].split(':')[0] and values['ControlGroup']=='/system.slice/TEST-retention-supervisor.service' and values['ActiveState']=='active' and values['Job']==''
 invocation=values['InvocationID'];assert len(invocation)==32 and all(x in '0123456789abcdef' for x in invocation)
 c['supervisorInvocation']=invocation
 print('query_complete:'+json.dumps(values,separators=(',',':')),flush=True)
 assert select.select([0],[],[],max(0,deadline-time.monotonic()))[0] and os.read(0,1)==b'3'
 assert select.select([0],[],[],max(0,deadline-time.monotonic()))[0] and os.read(0,1)==b''
finally:
 try:
  if not select.select([queryfd],[],[],0)[0]:signal.pidfd_send_signal(queryfd,signal.SIGKILL,None,0)
 finally:
  os.close(queryfd);os.close(qr);os.close(er)
  if ar is not None:os.close(ar)
`;
const stagedKernel=kernel.replace("lib=ctypes.CDLL(None,use_errno=True)",stagedQuery+"\nlib=ctypes.CDLL(None,use_errno=True)").replace("assert open('/proc/sys/kernel/random/boot_id').read().strip()==c['request']['bootId']","boot=os.open('proc/sys/kernel/random/boot_id',flags,dir_fd=15)\n try:assert os.read(boot,129).decode().strip()==c['request']['bootId']\n finally:os.close(boot)");
/** Fixed factory called only by the retained original native slot. */
export function prepareOriginalH1StagedObserver(parent:originalProfile.FullParentSession){
  const prepared=retainOriginalH1ObserverInputs(parent);preparedObservers.set(parent,prepared);
  return Object.freeze({program:stagedKernel,config:JSON.stringify(prepared.config),anchors:prepared.anchors,queryAnchors:prepared.queryAnchors,revalidate:prepared.revalidate,revalidateSources:prepared.revalidateSources,descriptors:prepared.descriptors,close:prepared.close});
}
type StagedObserverContext=Pick<Observer,"request"|"requestRef"|"hostOutbox"|"hostParent"|"hostDirectory"|"closed">;
const stagedObservers=new WeakMap<object,StagedObserverContext>();
export async function startOriginalH1StagedObserver(parent:originalProfile.FullParentSession):Promise<Readonly<{armed:Promise<void>;closed:Promise<H1ObserverState>}>>{
  const launch=await originalProfile.constructOriginalH1StagedObserver(parent),prepared=preparedObservers.get(parent);assert(prepared);
  const own:StagedObserverContext={request:prepared.request,requestRef:prepared.requestPin.ref,hostOutbox:prepared.hostOutbox,hostParent:prepared.hostParent,hostDirectory:prepared.hostDirectory,closed:false};stagedObservers.set(parent,own);
  let resolveArm!:()=>void,rejectArm!:(e:Error)=>void;const armed=new Promise<void>((resolve,reject)=>{resolveArm=resolve;rejectArm=reject;});void armed.catch(()=>{});
  let output="",errors=0,arm=false,failed=false;
  const fail=()=>{failed=true;rejectArm(new Error("TEST_H1_staged_protocol_HOLD"));void originalProfile.closeOriginalH1StagedObserver(parent).catch(()=>{});};
  launch.stdout.on("data",(chunk:Buffer)=>{try{output+=chunk.toString("utf8");assert(output.length<=128 && "armed\noriginal_parent_dead\n".startsWith(output));if(!arm && output.startsWith("armed\n")){publishH1ReadinessRecord(own.hostOutbox,H1ReadinessRecord.Armed,encode({purpose:"TEST_observer_armed_only",requestSha256:own.requestRef.sha256}));arm=true;resolveArm();}}catch{fail();}});
  launch.stderr.on("data",(chunk:Buffer)=>{errors+=chunk.length;if(errors>4096)fail();});
  const closed=launch.closed.then(async()=>{own.closed=true;assert(!failed && arm && errors===0 && launch.child.exitCode===0 && launch.child.signalCode===null && output==="armed\noriginal_parent_dead\n");await originalProfile.closeOriginalH1StagedObserver(parent);parent.revalidate();return H1ObserverState.ParentDead;},error=>{rejectArm(new Error("TEST_H1_staged_not_armed"));throw error;});void closed.catch(()=>rejectArm(new Error("TEST_H1_staged_not_armed")));return Object.freeze({armed,closed});
}
export function startOriginalH1Observer(parent:originalProfile.FullParentSession):Readonly<{armed:Promise<void>;closed:Promise<H1ObserverState>}>{
  const prepared=retainOriginalH1ObserverInputs(parent);
  const {config,anchors,request,requestPin,root,hostOutbox,hostParent,hostDirectory,parentPid,evictionId}=prepared;
  const [ops,owner,pd,od,absentFd,pp,sp,requestFd,backingFd]=anchors;
  assert(ops!==undefined && owner!==undefined && pd!==undefined && od!==undefined && absentFd!==undefined && pp!==undefined && sp!==undefined && requestFd!==undefined && backingFd!==undefined);
  let child:ChildProcess|undefined;
  try{
    const ns=prepared.queryAnchors;let supervisorInvocation:string;
    try{prepared.revalidate();
      const shown=namespaceTool(parent,tool=>{assert.equal(tool.executable,"/usr/bin/nsenter");const before=fstatSync(tool.executableFd,{bigint:true});assert(before.isFile() && before.uid===0n && (before.mode&0o7777n)===0o755n);
        const result=spawnSync("/proc/self/fd/6",["--mount=/proc/self/fd/3","--pid=/proc/self/fd/4","--root=/proc/self/fd/5","--wdns=/","--","/usr/bin/systemctl","--system","show","--property=Id,MainPID,InvocationID,ControlGroup,ActiveState,Job","--","TEST-retention-supervisor.service"],{stdio:["ignore","pipe","pipe",...ns,tool.executableFd],encoding:"utf8",timeout:2000,maxBuffer:4096,env:{PATH:"/usr/bin:/bin",LANG:"C",LC_ALL:"C",DBUS_SYSTEM_BUS_ADDRESS:"unix:path=/run/systemd/private"}});assert(sameStat(before,fstatSync(tool.executableFd,{bigint:true})));return result;});
      assert(!shown.error && shown.status===0 && shown.signal===null && shown.stderr==="");const values:Record<string,string>={};for(const line of shown.stdout.trimEnd().split("\n")){const at=line.indexOf("=");assert(at>0 && !Object.hasOwn(values,line.slice(0,at)));values[line.slice(0,at)]=line.slice(at+1);}assert.equal(Object.keys(values).sort().join(","),"ActiveState,ControlGroup,Id,InvocationID,Job,MainPID");assert(values.Id==="TEST-retention-supervisor.service" && values.MainPID===request.supervisorId.split(":")[0] && values.ControlGroup==="/system.slice/TEST-retention-supervisor.service" && values.ActiveState==="active" && values.Job==="" && values.InvocationID && /^[a-f0-9]{32}$/.test(values.InvocationID));supervisorInvocation=values.InvocationID;parent.revalidate();prepared.revalidate();
    }finally{prepared.revalidate();}
    const launchConfig={...config,supervisorInvocation};
    let exe!:BigIntStats,sources!:readonly BigIntStats[],executableFd!:number;
    child=pythonTool(parent,tool=>{assert.equal(tool.executable,"/usr/bin/python3.12");exe=fstatSync(tool.executableFd,{bigint:true});sources=[exe,...tool.closure.map(x=>fstatSync(x.fd,{bigint:true}))];executableFd=tool.executableFd;child=spawn("/proc/self/fd/12",["-I","-S","-B","-c",kernel,JSON.stringify(launchConfig)],{stdio:["pipe","pipe","pipe",ops,owner,pd,od,absentFd,pp,sp,requestPin.fd,backingFd,tool.executableFd],env:{PATH:"/usr/bin:/bin",LANG:"C",LC_ALL:"C"}});return child;});assert(child?.pid && child.stdin && child.stdout && child.stderr);child.stdin.end();assert(equal(identity(statSync("/proc/"+child.pid+"/exe",{bigint:true})),identity(exe)));
    const own:Observer={child,birth:birth("/proc/"+child.pid),argv:Buffer.from(["/proc/self/fd/12","-I","-S","-B","-c",kernel,JSON.stringify(launchConfig),""].join("\0")),exe,parentBirth:process.pid+":"+birth("/proc/self"),request,requestRef:requestPin.ref,root,hostOutbox,hostParent,hostDirectory,descriptors:[ops,owner,pd,od,absentFd,pp,sp,requestPin.fd,backingFd,executableFd],stdio:[0,1,2].map(fd=>statSync("/proc/"+child!.pid+"/fd/"+fd,{bigint:true})),sources,parentPid,lock:root+operations+"/"+evictionId+".remove.lock",closed:false};observers.set(parent,own);
    let armResolve!:()=>void,armReject!:(e:Error)=>void;const armed=new Promise<void>((r,j)=>{armResolve=r;armReject=j;});void armed.catch(()=>{});let output="",errors=0,arm=false,failed=false;
    const fail=()=>{failed=true;armReject(new Error("TEST_H1_protocol_HOLD"));child!.kill("SIGTERM");};child.stdout.on("data",(chunk:Buffer)=>{try{output+=chunk.toString("utf8");assert(output.length<=128 && "armed\noriginal_parent_dead\n".startsWith(output));if(!arm && output.startsWith("armed\n")){publishH1ReadinessRecord(hostOutbox,H1ReadinessRecord.Armed,encode({purpose:"TEST_observer_armed_only",requestSha256:requestPin.ref.sha256}));arm=true;armResolve();}}catch{fail();}});child.stderr.on("data",(chunk:Buffer)=>{errors+=chunk.length;if(errors>4096)fail();});
    const closed=new Promise<H1ObserverState>((resolve,reject)=>{const timer=setTimeout(()=>child!.kill("SIGTERM"),32000);child!.once("close",(code,signal)=>{clearTimeout(timer);own.closed=true;prepared.close();if(!failed && arm && code===0 && signal===null && errors===0 && output==="armed\noriginal_parent_dead\n"){try{parent.revalidate();resolve(H1ObserverState.ParentDead);}catch{reject(new Error("TEST_H1_parent_HOLD"));}}else{armReject(new Error("TEST_H1_not_armed"));reject(new Error("TEST_H1_NOT_RUN"));}});child!.once("error",()=>armReject(new Error("TEST_H1_spawn_HOLD")));});void closed.catch(()=>{});return {armed,closed};
  }catch(e){if(child)child.kill("SIGTERM");prepared.close();throw e;}
}
export enum H1DescriptorKind {OriginalAnchor="original_anchor",OwnPipe="own_fixed_pipe",ProtectedRecord="original_protected_record",ToolSource="original_tool_source",Fanotify="own_finite_fanotify_group",Requester="own_original_requester_pidfd"}
export type H1TaskAnchor=Readonly<{path:string;processPid:number;processBirth:string;revalidate():void}>;
export function readOriginalH1Observer(parent:object,task:H1TaskAnchor):Readonly<{pid:number;birth:string;programSha256:string;descriptors:readonly Readonly<{fd:number;dev:string;ino:string;kind:H1DescriptorKind}>[];sources:readonly Readonly<{dev:string;ino:string}>[]}>|undefined{
  originalProfile.assertRetainedCurrentFullParent(parent);const own=observers.get(parent);if(!own || own.closed || own.child.pid!==task.processPid)return;const pid=task.processPid;
  const rejoin=()=>{originalProfile.assertRetainedCurrentFullParent(parent);task.revalidate();assert.equal(task.processBirth,own.birth);assert.equal(birth("/proc/"+pid),own.birth);assert(readFileSync("/proc/"+pid+"/cmdline").equals(own.argv));assert(equal(identity(statSync("/proc/"+pid+"/exe",{bigint:true})),identity(own.exe)));assert.equal(process.pid+":"+birth("/proc/self"),own.parentBirth);for(const n of ["pid","mnt","user"])assert.equal(readlinkSync("/proc/"+pid+"/ns/"+n),readlinkSync("/proc/self/ns/"+n));const s=bounded("/proc/"+pid+"/stat",32768);assert.equal(s.slice(s.lastIndexOf(") ")+2).split(/\s+/)[1],String(process.pid));};rejoin();
  const list=readdirSync(task.path+"/fd").sort((a,b)=>Number(a)-Number(b));assert(list.length<=64 && list.every(x=>/^(0|[1-9][0-9]*)$/.test(x)));const match=(a:BigIntStats,b:BigIntStats)=>a.dev===b.dev && a.ino===b.ino && a.mode===b.mode;
  const records:BigIntStats[]=[fstatSync(own.descriptors[4]!,{bigint:true})];
  function regular(path:string,publishing=false){if(absent(path))return;const s=lstatSync(path,{bigint:true});assert(s.isFile() && s.uid===0n && (s.mode&0o7777n)===0o600n && s.size<=65536n && (s.nlink===1n || publishing && s.nlink===2n));if(s.nlink===2n){const name=path.slice(path.lastIndexOf("/")+1),mate=name.startsWith(".")?dirname(path)+"/"+name.slice(1,-".publishing".length):dirname(path)+"/."+name+".publishing",m=lstatSync(mate,{bigint:true});assert(match(m,s) && m.nlink===2n && m.uid===s.uid && m.size===s.size);}records.push(s);}
  const key=own.request.workspace.dev+"-"+own.request.workspace.ino,ownerPath=own.root+policy+"/dependency-owners/"+key+".json";regular(ownerPath);regular(own.lock);
  if(!absent(own.lock)){const selected=pin(own.lock);let operation:string;try{const v=json(selected);assert(v && typeof v==="object" && "firstAttempt" in v && v.firstAttempt && typeof v.firstAttempt==="object" && "operationId" in v.firstAttempt && typeof v.firstAttempt.operationId==="string" && uuid.test(v.firstAttempt.operationId));operation=v.firstAttempt.operationId;}finally{closeSync(selected.fd);}for(const suffix of ["claim","actor","retirement","session-closed","consumed","revoked","submitted"])regular(own.root+operations+"/"+operation+".removal-"+suffix+".json");const owner=pin(ownerPath,16384);try{const v=json(owner);assert(v && typeof v==="object" && "revision" in v && Number.isSafeInteger(v.revision));regular(own.root+operations+"/"+key+"-"+(Number(v.revision)+1)+".removal-idle.json");}finally{closeSync(owner.fd);}}
  const witness=own.root+policy+"/readonly-epoch."+own.request.bootId+".lock";if(!absent(witness)){const fd=directory(witness);try{records.push(fstatSync(fd,{bigint:true}));regular(witness+"/owner.json");}finally{closeSync(fd);}}
  for(const name of ["removal-h1-before-kill.json",H1ReadinessRecord.Dead]){regular(own.hostOutbox+"/"+name,true);regular(own.hostOutbox+"/."+name+".publishing",true);}let groups=0,requesters=0;
  const descriptors=list.map(n=>{const fd=Number(n),path=task.path+"/fd/"+n,s=statSync(path,{bigint:true}),link=readlinkSync(path);let kind:H1DescriptorKind;
    if(fd<3){const pipe=own.stdio[fd]!;assert(s.dev===pipe.dev && s.ino===pipe.ino && s.uid===pipe.uid && (s.mode&0o170000n)===(pipe.mode&0o170000n));kind=H1DescriptorKind.OwnPipe;}else if(fd<=11){assert(match(s,fstatSync(own.descriptors[fd-3]!,{bigint:true})));kind=H1DescriptorKind.OriginalAnchor;}else if(own.sources.some(source=>match(s,source)))kind=H1DescriptorKind.ToolSource;
    else if(records.some(record=>match(s,record)))kind=H1DescriptorKind.ProtectedRecord;else if(link==="anon_inode:[fanotify]"){assert(++groups===1);kind=H1DescriptorKind.Fanotify;}else if(link==="anon_inode:[pidfd]"){assert(++requesters===1);assert(new RegExp("^Pid:\\t(?:"+own.parentPid+"|-1)$","m").test(bounded(task.path+"/fdinfo/"+fd,4096)));kind=H1DescriptorKind.Requester;}else assert.fail("TEST_H1_unknown_descriptor_HOLD");assert(match(s,statSync(path,{bigint:true})));assert.equal(readlinkSync(path),link);return Object.freeze({fd,dev:String(s.dev),ino:String(s.ino),kind});});
  for(let fd=0;fd<=12;fd++)assert(list.includes(String(fd)));assert.equal(groups,1);const maps=bounded(task.path+"/maps",1024*1024);for(const line of maps.trimEnd().split("\n")){const m=/^[0-9a-f]+-[0-9a-f]+\s+[rwxps-]{4}\s+[0-9a-f]+\s+([0-9a-f]+):([0-9a-f]+)\s+([0-9]+)(?:\s+.*)?$/.exec(line);assert(m);if(m[3]==="0")continue;const major=BigInt("0x"+m[1]),minor=BigInt("0x"+m[2]),dev=(minor&255n)|(major<<8n)|((minor&~255n)<<12n);assert(own.sources.some(source=>source.dev===dev && String(source.ino)===m[3]));}assert.equal(bounded(task.path+"/maps",1024*1024),maps);assert(equal(list,readdirSync(task.path+"/fd").sort((a,b)=>Number(a)-Number(b))));rejoin();return Object.freeze({pid,birth:own.birth,programSha256:digest(Buffer.from(kernel)),descriptors:Object.freeze(descriptors),sources:Object.freeze(own.sources.map(source=>Object.freeze(identity(source))))});
}
export function readOriginalH1SupervisorAcceptance(parent:object):Readonly<{supervisorBirth:string;originalParentPid:number;recoveryPid:number;originalRequest:H1Request}>{
  originalProfile.assertRetainedCurrentFullParent(parent);const own=stagedObservers.get(parent)??observers.get(parent);assert(own?.closed);const hostParent=directory(dirname(own.hostOutbox));let hostDir:number|undefined,a:Pin|undefined,r:Pin|undefined;
  const rejoin=()=>{originalProfile.assertRetainedCurrentFullParent(parent);assert(equal(identity(fstatSync(hostParent,{bigint:true})),own.hostParent) && equal(identity(lstatSync(dirname(own.hostOutbox),{bigint:true})),own.hostParent));assert(hostDir!==undefined && equal(identity(fstatSync(hostDir,{bigint:true})),own.hostDirectory) && equal(identity(lstatSync("/proc/self/fd/"+hostParent+"/policy-request-outbox",{bigint:true})),own.hostDirectory));originalProfile.assertRetainedCurrentFullParent(parent);};
  try{hostDir=directory("/proc/self/fd/"+hostParent+"/policy-request-outbox");rejoin();a=ready(own.hostOutbox,H1ReadinessRecord.Accepted,4096);r=ready(own.hostOutbox,H1ReadinessRecord.Request,16384);const v=json(a),request=parseH1Request(json(r));assert(equal({...r.ref,path:own.requestRef.path},own.requestRef) && equal(request,own.request));fields(v,"schemaVersion,purpose,sourceSha,supervisorBirth,originalParentPid,recoveryPid");assert(v.schemaVersion===1 && v.purpose==="TEST_actual_supervisor_H1_child_close_only" && v.sourceSha===request.sourceSha && v.supervisorBirth===request.supervisorId && String(v.originalParentPid)===request.parentBirth.split(":")[0] && Number.isSafeInteger(v.recoveryPid) && Number(v.recoveryPid)>1 && v.recoveryPid!==v.originalParentPid);rejoin();const again=ready(own.hostOutbox,H1ReadinessRecord.Request,16384);try{assert(equal({...again.ref,path:own.requestRef.path},own.requestRef) && equal(parseH1Request(json(again)),request));}finally{closeSync(again.fd);}rejoin();return Object.freeze({supervisorBirth:request.supervisorId,originalParentPid:Number(v.originalParentPid),recoveryPid:Number(v.recoveryPid),originalRequest:Object.freeze({...request,workspace:Object.freeze({...request.workspace}),absent:Object.freeze({...request.absent,identity:Object.freeze({...request.absent.identity})})})});
  }finally{if(a)closeSync(a.fd);if(r)closeSync(r.fd);if(hostDir!==undefined)closeSync(hostDir);closeSync(hostParent);}
}
export async function requestOriginalH1(jobId:string,revision:number,workspace:H1Request["workspace"],absentReference:Ref):Promise<void>{
  const authority:typeof import("../../dist/worker-codex/hosted-readonly-authority.js")=await import(runtime+"/dist/worker-codex/hosted-readonly-authority.js"),origin:typeof import("../../dist/worker-codex/hosted-installation-origin-facts.js")=await import(runtime+"/dist/worker-codex/hosted-installation-origin-facts.js");authority.assertReadonlyHostOperator();originalH1Case();
  assert.equal(bounded("/proc/self/cmdline",32768),[runtime+"/toolchain/bin/node",runtime+"/scripts/dependency-retention-os-test/current-full-guest.js","qualify","--parent-crash-h1",""] .join("\0"));const actual=origin.readHostedInstallationActivation();
  const request=parseH1Request({schemaVersion:1,purpose:"TEST_original_removal_H1_request_only",sourceSha:actual.installation.runtimeSha,jobId,revision,workspace,absent:absentReference,parentBirth:process.pid+":"+birth("/proc/self"),bootId:actual.activation.bootId,supervisorId:actual.activation.supervisorId});assert.equal(request.sourceSha,process.env.TEST_SOURCE_SHA);publishH1ReadinessRecord(outbox,H1ReadinessRecord.Request,encode(request));const requestPin=ready(outbox,H1ReadinessRecord.Request,16384),hash=requestPin.ref.sha256;closeSync(requestPin.fd);const end=performance.now()+30000;
  while(performance.now()<end){const armed=tryReady(outbox,H1ReadinessRecord.Armed,4096);if(armed){try{const v=json(armed);fields(v,"purpose,requestSha256");assert(v.purpose==="TEST_observer_armed_only" && v.requestSha256===hash);return;}finally{closeSync(armed.fd);}}await new Promise(resolve=>setTimeout(resolve,50));}throw new Error("TEST_H1_arm_HOLD");
}
type Checkpoint=Readonly<{schemaVersion:1;purpose:"TEST_H1_preservation_only";roots:CurrentColdHotRoots;sentinels:ReturnType<typeof captureEvictRestoreSentinels>;proof:ReturnType<typeof readEvictRestoreAbsent>}>;
function publishFact(path:string,value:unknown,mode=0o600):void{
  assert([outbox+"/removal-h1-preservation.json",outbox+"/removal-h1-recovered.json",policy+"/current-full-terminal.json",policy+"/current-full-h1-terminal-proof.json",runtime+"/guest-evidence.json"].includes(path));assert(mode===(path===runtime+"/guest-evidence.json"?0o644:0o600));const bytes=encode(value);assert(bytes.length>0 && bytes.length<=65536);
  const parentPath=dirname(path),parent=openSync(parentPath,C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW),before=fstatSync(parent,{bigint:true}),expectedMode=parentPath===runtime?0o755n:0o700n;
  function rejoin(){for(const s of [fstatSync(parent,{bigint:true}),lstatSync(parentPath,{bigint:true})])assert(s.isDirectory() && s.uid===0n && s.gid===0n && (s.mode&0o7777n)===expectedMode && equal(identity(s),identity(before)));}
  let fd:number|undefined;try{rejoin();const anchored="/proc/self/fd/"+parent+"/"+basename(path);fd=openSync(anchored,C.O_WRONLY|C.O_CREAT|C.O_EXCL|C.O_NOFOLLOW,mode);fchmodSync(fd,mode);writeFileSync(fd,bytes);fsyncSync(fd);const s=fstatSync(fd,{bigint:true});assert(s.isFile() && s.uid===0n && s.gid===0n && s.nlink===1n && s.size===BigInt(bytes.length) && (s.mode&0o7777n)===BigInt(mode) && sameStat(s,lstatSync(anchored,{bigint:true})));rejoin();fsyncSync(parent);rejoin();assert(sameStat(s,fstatSync(fd,{bigint:true})) && sameStat(s,lstatSync(anchored,{bigint:true})));}finally{if(fd!==undefined)closeSync(fd);closeSync(parent);}
}
export function captureOriginalH1Checkpoint(roots:Checkpoint["roots"],sentinels:Checkpoint["sentinels"],proof:Checkpoint["proof"]):void{originalH1Case();publishFact(outbox+"/removal-h1-preservation.json",{schemaVersion:1,purpose:"TEST_H1_preservation_only",roots,sentinels,proof});}
function readOriginalDead(end=performance.now()+2000){assert.equal(process.getuid!(),0);const bytes=waitH1OriginalDeathPublication(outbox,end);const decode=(b:Buffer):unknown=>{const v:unknown=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(b));assert(b.equals(encode(v)));return v;};const request=parseH1Request(decode(bytes.request)),v=decode(bytes.dead);fields(v,"purpose,snapshot,parentBirth,eventHostPid,kernelPidfdDeath");assert(v.purpose==="TEST_actual_original_parent_death_only" && v.kernelPidfdDeath===true && v.parentBirth===request.parentBirth);fields(v.snapshot,"owner,claim,actor,retirement,completion,idle,witness,witnessReceipt,lock,removedEntries");return {request,snapshot:v.snapshot};}
export function assertOriginalH1RecoveryReady(qualifierPid:number):void{const end=performance.now()+2000;originalH1Case();assert(Number.isSafeInteger(qualifierPid) && qualifierPid>1);const {request}=readOriginalDead(end);assert.equal(request.parentBirth.split(":")[0],String(qualifierPid));assert.equal(request.supervisorId,process.pid+":"+birth("/proc/self"));assert.equal(readFileSync("/proc/sys/kernel/random/boot_id","utf8").trim(),request.bootId);try{assert.notEqual(birth("/proc/"+qualifierPid),request.parentBirth.split(":")[1]);}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}}

export function assertOriginalH1RecoveryComplete():void{originalH1Case();const {request,snapshot}=readOriginalDead();assert.equal(request.supervisorId,process.pid+":"+birth("/proc/self"));const done=pin(outbox+"/removal-h1-recovered.json"),e=pin(runtime+"/guest-evidence.json",65536,0n,0o644);try{const result=json(done),publicFact=json(e);fields(result,"purpose,originalParentBirth,recoveryBirth,operationId,removedEntries,owner");assert(result.purpose==="TEST_genuine_independent_original_recovery_only" && result.originalParentBirth===request.parentBirth && result.recoveryBirth!==request.parentBirth && result.removedEntries===snapshot.removedEntries);reference(snapshot.lock);assert(absent(snapshot.lock.path));const owner=pin(policy+"/dependency-owners/"+request.workspace.dev+"-"+request.workspace.ino+".json");try{const fenced=parseDependencyOwner(snapshot.owner);assert(fenced.owner!==null && fenced.owner.phase==="fenced");assert(equal(json(owner),result.owner) && equal(result.owner,parseDependencyOwner({...fenced,revision:fenced.revision+1,owner:null})));}finally{closeSync(owner.fd);}reference(snapshot.claim);const claim=pin(snapshot.claim.path);try{const v=json(claim);assert(v && typeof v==="object" && "absent" in v && v.absent && typeof v.absent==="object" && "receipt" in v.absent && v.absent.receipt && typeof v.absent.receipt==="object" && "operationId" in v.absent.receipt);assert.equal(result.operationId,v.absent.receipt.operationId);}finally{closeSync(claim.fd);}assert(publicFact && typeof publicFact==="object" && "sourceSha" in publicFact && "qualification" in publicFact && "status" in publicFact && "originalFullEightCases" in publicFact);assert(publicFact.sourceSha===request.sourceSha && publicFact.qualification===h1Qualification && publicFact.status==="partial_pass" && publicFact.originalFullEightCases==="NOT_RUN_in_this_H1_cohort");}finally{closeSync(done.fd);closeSync(e.fd);}}
export function publishOriginalH1SupervisorAccepted(originalParentPid:number,recoveryPid:number):void{assertOriginalH1RecoveryReady(originalParentPid);assertOriginalH1RecoveryComplete();assert(Number.isSafeInteger(recoveryPid) && recoveryPid>1 && recoveryPid!==originalParentPid);const completed=pin(outbox+"/removal-h1-recovered.json");try{const v=json(completed);assert(v && typeof v==="object" && "recoveryBirth" in v && typeof v.recoveryBirth==="string" && v.recoveryBirth.split(":")[0]===String(recoveryPid));}finally{closeSync(completed.fd);}publishH1ReadinessRecord(outbox,H1ReadinessRecord.Accepted,encode({schemaVersion:1,purpose:"TEST_actual_supervisor_H1_child_close_only",sourceSha:process.env.TEST_SOURCE_SHA,supervisorBirth:process.pid+":"+birth("/proc/self"),originalParentPid,recoveryPid}));}
export type H1TerminalProof=Readonly<{schemaVersion:1;purpose:"TEST_original_H1_closed_archive_facts_only";sourceSha:string;bootId:string;supervisorId:string;jobId:string;revision:number;workspace:H1Request["workspace"];claim:Ref;actor:Ref;retirement:Ref;completion:Ref;idle:Ref;originalIdle:Ref;sourceClosed:Ref;absent:Ref;header:Ref;archivedWitness:Ref;owner:Ref;expectedOwner:import("../../dist/core/index.js").DependencyOwnerRecord;operationId:string;removedEntries:number;activation:import("../../dist/worker-core/index.js").HostedActivation;epochGeneration:number|null;terminal:Ref}>;
export function readOriginalH1Request():H1Request{originalH1Case();const p=ready(outbox,H1ReadinessRecord.Request,16384);try{return parseH1Request(json(p));}finally{closeSync(p.fd);}}
/** Exact fixed extra stdio of our owned Node child; libuv uses a socketpair.
 * The single byte and EOF precede any authority/API work. No socket enrollment. */
export async function consumeOriginalH1RecoveryGate():Promise<void>{
  const original=fstatSync(3,{bigint:true});assert(original.isSocket());
  await new Promise<void>((resolve,reject)=>{const socket=new Socket({fd:3,readable:true,writable:false,allowHalfOpen:true}),parts:Buffer[]=[];let size=0,ended=false,failure:unknown;
    const fail=(e:unknown)=>{failure=e;socket.destroy();};const timer=setTimeout(()=>fail(new Error("TEST_H1_recovery_gate_timeout_HOLD")),2000);
    socket.on("data",(chunk:Buffer)=>{size+=chunk.length;if(size>1){fail(new Error("TEST_H1_recovery_gate_bytes_HOLD"));return;}parts.push(chunk);});
    socket.on("error",fail);socket.on("end",()=>{try{assert(size===1 && Buffer.concat(parts,size)[0]===49);const now=fstatSync(3,{bigint:true});assert(now.isSocket());assert.equal(now.dev,original.dev);assert.equal(now.ino,original.ino);assert.equal(now.mode&0o170000n,original.mode&0o170000n);assert.equal(now.uid,original.uid);ended=true;socket.destroy();}catch(e){fail(e);}});
    socket.on("close",()=>{clearTimeout(timer);if(failure!==undefined)reject(failure);else if(!ended)reject(new Error("TEST_H1_recovery_gate_EOF_HOLD"));else resolve();});socket.resume();
  });
}
function assertOriginalRecoveryBirth(request:H1Request):void{
  const r=ready(outbox,H1ReadinessRecord.Request,16384),b=ready(outbox,H1ReadinessRecord.Recovery,4096),program=pinOriginalH1Program();
  try{assert(equal(parseH1Request(json(r)),request));const v=json(b);fields(v,"schemaVersion,purpose,sourceSha,bootId,supervisorBirth,originalParentBirth,recoveryBirth,requestRef,programSha256");fields(v.requestRef,"identity,sha256");fields(v.requestRef.identity,"dev,ino");assert(v.schemaVersion===1 && v.purpose==="TEST_original_supervisor_recovery_child_birth_only" && v.sourceSha===request.sourceSha && v.bootId===request.bootId && v.supervisorBirth===request.supervisorId && v.originalParentBirth===request.parentBirth && v.recoveryBirth===process.pid+":"+birth("/proc/self") && v.programSha256===program.ref.sha256);assert(equal(v.requestRef,{identity:r.ref.identity,sha256:r.ref.sha256}));
    const supervisor=Number(request.supervisorId.split(":")[0]);assert(supervisor===process.ppid && birth("/proc/"+supervisor)===request.supervisorId.split(":")[1]);assert.equal(bounded("/proc/"+supervisor+"/cmdline",32768),[runtime+"/toolchain/bin/node","--experimental-strip-types",runtime+"/scripts/dependency-retention-os-test/current-full-supervisor.js","supervisor","--parent-crash-h1",""] .join("\0"));assert.equal(bounded("/proc/self/cgroup",4096),bounded("/proc/"+supervisor+"/cgroup",4096));for(const n of ["pid","mnt","user","cgroup"])assert.equal(readlinkSync("/proc/self/ns/"+n),readlinkSync("/proc/"+supervisor+"/ns/"+n));assert.equal(readFileSync("/proc/sys/kernel/random/boot_id","utf8").trim(),request.bootId);
    for(const p of [r,b,program])assert(sameStat(p.stat,fstatSync(p.fd,{bigint:true})) && sameStat(p.stat,lstatSync(p.path,{bigint:true})));
  }finally{closeSync(r.fd);closeSync(b.fd);closeSync(program.fd);}
}
function checkpointShape(v:unknown):asserts v is Checkpoint{fields(v,"schemaVersion,purpose,roots,sentinels,proof");assert(v.schemaVersion===1 && v.purpose==="TEST_H1_preservation_only" && v.roots && typeof v.roots==="object" && v.sentinels && typeof v.sentinels==="object" && v.proof && typeof v.proof==="object");}
async function finishRecoveredH1(request:H1Request,snapshot:Record<string,unknown>,expected:import("../../dist/core/index.js").DependencyOwnerRecord,operationId:string,removedEntries:number):Promise<void>{
  const rootModule:typeof import("./current-cold-hot-root.js")=await import(runtime+"/scripts/dependency-retention-os-test/current-cold-hot-root.js"),preservation:typeof import("./current-evict-restore-sentinels.js")=await import(runtime+"/scripts/dependency-retention-os-test/current-evict-restore-sentinels.js"),proofModule:typeof import("./current-evict-restore-readback.js")=await import(runtime+"/scripts/dependency-retention-os-test/current-evict-restore-readback.js");
  const activation:typeof import("../../dist/worker-codex/hosted-installation-activation.js")=await import(runtime+"/dist/worker-codex/hosted-installation-activation.js"),records:typeof import("../../dist/worker-codex/hosted-dependency-removal-records.js")=await import(runtime+"/dist/worker-codex/hosted-dependency-removal-records.js"),references:typeof import("../../dist/worker-codex/hosted-dependency-legacy-reference-records.js")=await import(runtime+"/dist/worker-codex/hosted-dependency-legacy-reference-records.js");
  const ownerModule:typeof import("../../dist/store-local-file/dependency-environment/local-dependency-owner-store.js")=await import(runtime+"/dist/store-local-file/dependency-environment/local-dependency-owner-store.js"),fences:typeof import("../../dist/provider-codex/app-server/adapters/hosted-process-activation.js")=await import(runtime+"/dist/provider-codex/app-server/adapters/hosted-process-activation.js"),kernelModule:typeof import("../../dist/worker-codex/hosted-readonly-host-kernel.js")=await import(runtime+"/dist/worker-codex/hosted-readonly-host-kernel.js"),epochs:typeof import("../../dist/worker-codex/hosted-readonly-epoch-store.js")=await import(runtime+"/dist/worker-codex/hosted-readonly-epoch-store.js"),backing:typeof import("../../dist/worker-codex/hosted-full-backing-interval.js")=await import(runtime+"/dist/worker-codex/hosted-full-backing-interval.js");
  const cp=pin(outbox+"/removal-h1-preservation.json");let data:unknown;try{data=json(cp);}finally{closeSync(cp.fd);}checkpointShape(data);const checkpoint=data;rootModule.assertRootScope(checkpoint.roots);assert(checkpoint.roots.candidateJobId===request.jobId && checkpoint.roots.sourceSha===request.sourceSha && equal(checkpoint.roots.workspaceIdentity,request.workspace));assert(equal(checkpoint.proof.absent.reference,request.absent));proofModule.assertRetainedEvictionProof(checkpoint.proof);proofModule.assertPathAbsent(checkpoint.proof.trash);proofModule.assertPathAbsent(checkpoint.proof.operation+".remove.lock");const preserved=preservation.assertEvictRestoreSentinels(checkpoint.roots,checkpoint.sentinels);
  reference(snapshot.claim);const claimRef=snapshot.claim,claim=records.parseHostedDependencyRemovalClaim(JSON.parse(references.pinReferenceFile(claimRef.path).bytes.toString("utf8")));assert(claim.binding.jobId===request.jobId && claim.absent.receipt.revision===request.revision && equal(claim.absent.reference,request.absent));
  const store=new activation.HostedInstallationActivationStore(),baseline=store.finishClosed();fields(snapshot.witnessReceipt,"version,purpose,acquisitionId,bootId,parent,mutex,claim,actor,lock,completion");const receipt=snapshot.witnessReceipt;assert(typeof receipt.acquisitionId==="string" && uuid.test(receipt.acquisitionId));reference(snapshot.witness);const witnessRef=snapshot.witness,archive=policy+"/activation-fence-retired/"+receipt.acquisitionId;
  function rejoin():Ref{assert(equal(activation.readHostedInstallationActivation().activation,baseline));const owners=ownerModule.LocalDependencyOwnerStore.open({rootPath:policy+"/dependency-owners",maxRecordBytes:16384});try{assert(equal(owners.read(request.workspace),expected));}finally{owners.close();}for(const name of ["claim","actor","retirement","completion","idle"] as const){const ref=snapshot[name];reference(ref);assert(equal(references.pinReferenceFile(ref.path).reference,ref));}for(const ref of [claim.originalIdle,claim.sourceClosed,claim.absent.reference,claim.header])assert(equal(references.pinReferenceFile(ref.path).reference,ref));proofModule.assertRetainedEvictionProof(checkpoint.proof);proofModule.assertPathAbsent(checkpoint.proof.trash);proofModule.assertPathAbsent(checkpoint.proof.operation+".remove.lock");
    const dir=directory(archive),owner=pin(archive+"/owner.json",16384);try{assert(equal(identity(fstatSync(dir,{bigint:true})),receipt.mutex) && equal({...owner.ref,path:witnessRef.path},witnessRef) && equal(json(owner),receipt));return owner.ref;}finally{closeSync(owner.fd);closeSync(dir);}}
  rejoin();const acknowledged=await store.recoverDependencyCommittedTrash(request.jobId,request.revision);assert(acknowledged.outcome==="trash_removed" && "operationId" in acknowledged && "removedEntries" in acknowledged && acknowledged.operationId===operationId && acknowledged.removedEntries===removedEntries);
  fences.withHostedActivationFence(()=>{const archivedWitness=rejoin();backing.assertOriginalFullBackingPreparation();const actual=activation.readHostedInstallationActivation();assert(actual.activation.phase===HostedActivationPhase.Closed && actual.activation.bootId===request.bootId && actual.activation.supervisorId===request.supervisorId && actual.activation.ordinaryStarts.every(row=>row.state===HostedCustodyReservationState.Terminal));let epochGeneration:number|null=null;
    if(!absent(policy+"/readonly-enrollment.json")){assert(!absent(policy+"/readonly-epoch.json"));const epoch=new epochs.HostedReadonlyEpochStore().readEpoch();assert(epoch.phase===HostedCustodyPhase.Closed && epoch.revoked && epoch.reservations.every(row=>row.state===HostedCustodyReservationState.Terminal) && (epoch.outerRuntime===null || epoch.outerRuntime.state===HostedCustodyReservationState.Terminal));epochGeneration=epoch.generation;}else{assert(absent(policy+"/readonly-epoch.json") && actual.activation.exclusiveEnrollmentSha256===null);}
    const kernel=new kernelModule.HostedReadonlyHostKernel();kernel.verifyExclusiveInventory();kernel.verifyDescriptorBoundary();const pair=pin("/var/lib/subscription-runtime-full-parent-live/seals/current-full-pair.json",16384),invocation=pin("/var/lib/subscription-runtime-full-parent-live/seals/current-full-pair-invocation.json",4096);try{publishFact(policy+"/current-full-terminal.json",{schemaVersion:1,sourceSha:request.sourceSha,pairSha256:pair.ref.sha256,invocationSealSha256:invocation.ref.sha256,activationGeneration:actual.activation.generation,epochGeneration,workspace:request.workspace,sourceClosed:claim.sourceClosed,idleClosed:claim.originalIdle});const terminal=pin(policy+"/current-full-terminal.json",16384),owner=pin(policy+"/dependency-owners/"+request.workspace.dev+"-"+request.workspace.ino+".json");try{assert(equal(json(owner),expected));reference(snapshot.actor);reference(snapshot.retirement);reference(snapshot.completion);reference(snapshot.idle);const proof:H1TerminalProof={schemaVersion:1,purpose:"TEST_original_H1_closed_archive_facts_only",sourceSha:request.sourceSha,bootId:request.bootId,supervisorId:request.supervisorId,jobId:request.jobId,revision:request.revision,workspace:request.workspace,claim:claimRef,actor:snapshot.actor,retirement:snapshot.retirement,completion:snapshot.completion,idle:snapshot.idle,originalIdle:claim.originalIdle,sourceClosed:claim.sourceClosed,absent:claim.absent.reference,header:claim.header,archivedWitness,owner:owner.ref,expectedOwner:expected,operationId,removedEntries,activation:actual.activation,epochGeneration,terminal:terminal.ref};publishFact(policy+"/current-full-h1-terminal-proof.json",proof);assert(equal(rejoin(),archivedWitness));assert(equal(references.pinReferenceFile(owner.ref.path).reference,owner.ref) && equal(references.pinReferenceFile(terminal.ref.path).reference,terminal.ref));}finally{closeSync(terminal.fd);closeSync(owner.fd);}}finally{closeSync(pair.fd);closeSync(invocation.fd);}});
  proofModule.assertRetainedEvictionProof(checkpoint.proof);preservation.assertEvictRestoreSentinels(checkpoint.roots,checkpoint.sentinels);publishFact(runtime+"/guest-evidence.json",{schemaVersion:1,sourceSha:request.sourceSha,machineId:readFileSync("/etc/machine-id","utf8").trim(),qualification:h1Qualification,restoreConsumer:"ordinary",removalCase:FullH1Case.ParentCrash,status:"partial_pass",fullPlanQualification:"pending",originalFullEightCases:"NOT_RUN_in_this_H1_cohort",nativeH1:"actual_original_parent_SIGKILL_and_independent_same_supervisor_recovery",preserved,authCustody:"retained_until_original_owned_OS_recursive_teardown"},0o644);
}
export async function recoverOriginalH1():Promise<void>{
  assert.equal(process.platform,"linux");assert.equal(process.getuid!(),0);
  // FD3 is ONE pipe owned by the original supervisor. Its fixed byte is sent
  // only after actual own-child birth record is durably published; no API work
  // begins first. Missing/extra/foreign pipe state is HOLD, never fallback.
  assert.equal(bounded("/proc/self/cmdline",32768),[runtime+"/toolchain/bin/node",runtime+"/scripts/dependency-retention-os-test/current-removal-h1-fixture.js","recover_h1",""] .join("\0"));await consumeOriginalH1RecoveryGate();originalH1Case();const causal=readOriginalDead();assertOriginalRecoveryBirth(causal.request);
  const authority:typeof import("../../dist/worker-codex/hosted-readonly-authority.js")=await import(runtime+"/dist/worker-codex/hosted-readonly-authority.js"),origin:typeof import("../../dist/worker-codex/hosted-installation-origin-facts.js")=await import(runtime+"/dist/worker-codex/hosted-installation-origin-facts.js"),activation:typeof import("../../dist/worker-codex/hosted-installation-activation.js")=await import(runtime+"/dist/worker-codex/hosted-installation-activation.js"),core:typeof import("../../dist/core/index.js")=await import(runtime+"/dist/core/index.js");authority.assertReadonlyHostOperator();originalH1Case();const {request,snapshot}=readOriginalDead(),actual=origin.readHostedInstallationActivation();assert(actual.installation.runtimeSha===request.sourceSha && actual.activation.bootId===request.bootId && actual.activation.supervisorId===request.supervisorId && process.pid+":"+birth("/proc/self")!==request.parentBirth);
  reference(snapshot.lock);const originalLock=pin(snapshot.lock.path);try{assert(equal(originalLock.ref,snapshot.lock));}finally{closeSync(originalLock.fd);}for(const name of ["claim","actor","retirement","completion","idle","witness"] as const){const ref=snapshot[name];reference(ref);const p=pin(ref.path);try{assert(equal(p.ref,ref));}finally{closeSync(p.fd);}}
  reference(snapshot.claim);const originalClaim=pin(snapshot.claim.path);let originalOperation:string;try{const v=json(originalClaim);fields(v,"absent,binding,claimed,header,kind,originalIdle,previous,previousClaim,previousRetirement,sourceClosed,version");fields(v.absent,"receipt,reference");assert(v.absent.receipt && typeof v.absent.receipt==="object" && "operationId" in v.absent.receipt && typeof v.absent.receipt.operationId==="string" && uuid.test(v.absent.receipt.operationId));originalOperation=v.absent.receipt.operationId;}finally{closeSync(originalClaim.fd);}
  const fenced=core.parseDependencyOwner(snapshot.owner),expected=core.parseDependencyOwner({...fenced,revision:fenced.revision+1,owner:null});assert(Number.isSafeInteger(snapshot.removedEntries) && Number(snapshot.removedEntries)>0);const store=new activation.HostedInstallationActivationStore(),result=await store.recoverDependencyCommittedTrash(request.jobId,request.revision);assert(result.outcome==="trash_removed" && "operationId" in result && "removedEntries" in result && result.operationId===originalOperation && typeof result.removedEntries==="number" && result.removedEntries===snapshot.removedEntries);assert(absent(snapshot.lock.path));const owner=pin(policy+"/dependency-owners/"+request.workspace.dev+"-"+request.workspace.ino+".json");try{assert(equal(json(owner),expected));}finally{closeSync(owner.fd);}
  publishFact(outbox+"/removal-h1-recovered.json",{purpose:"TEST_genuine_independent_original_recovery_only",originalParentBirth:request.parentBirth,recoveryBirth:process.pid+":"+birth("/proc/self"),operationId:result.operationId,removedEntries:result.removedEntries,owner:expected});await finishRecoveredH1(request,snapshot,expected,result.operationId,result.removedEntries);
}
if(process.argv[1]===runtime+"/scripts/dependency-retention-os-test/current-removal-h1-fixture.js"){assert.equal(process.argv.length,3);assert.equal(process.argv[2],"recover_h1");await recoverOriginalH1();}
