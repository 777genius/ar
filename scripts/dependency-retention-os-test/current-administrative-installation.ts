/** One original PUBLIC installation-control operation. No application payload API. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  spawnSync
}
from "node:child_process";
import {
  createHash
}
from "node:crypto";
import {
  closeSync, constants as C, fstatSync, fsyncSync, lstatSync, openSync, readFileSync,
  readlinkSync, readSync, realpathSync, statSync, statfsSync, writeFileSync, type BigIntStats
}
from "node:fs";
import {
  basename, dirname
}
from "node:path";
import {
  fileURLToPath
}
from "node:url";
const base="/srv/workers/public-intake/TEST-dependency-full-native-20261007-r1";
const control=base+"/control", unit="subscription-runtime-installer-10000000-0000-4000-8000-9ca302fabd07.service";
const group="/system.slice/"+unit;
const administrativeWork=base+"/administrative-work";
const actorPath=control+"/administrative-public-maintenance.js";
const hostNode="/opt/nodejs/node-v24.21.0-linux-x64/bin/node";
const guestProducer="/opt/subscription-runtime-dependency-os-TEST/scripts/dependency-retention-os-test/registration-guest.js";
const guestNode="/opt/subscription-runtime-dependency-os-TEST/toolchain/bin/node";
const boundarySha="904c612e066edd7679287cf4e135553cf1d0f625fca0a5c7f89335829ea5c360";
const job="/srv/workers/jobs/TEST-dependency-full-native-20261007-r1";
const environment={
  PATH:"/usr/bin:/bin",LANG:"C",LC_ALL:"C",HOME:base,TMPDIR:base+"/bootstrap-tmp"
}
;
const digest=(b:Buffer|string)=>createHash("sha256").update(b).digest("hex");
type Identity=Readonly<{
  dev:string;
  ino:string;
  mode:string;
  uid:string;
  gid:string
}
>;
type Source=Readonly<{
  path:string;
  sha256:string
}
>;
type Selection=Readonly<{
  schemaVersion:1;
  producer:Source;
  actor:Source;
  node:Source;
  operation:Source;
  sourceReviewSha256:string;
  sourceSha:string
}
>;
type Held=Readonly<{
  fd:number;
  path:string;
  stat:BigIntStats;
  mount:string;
  sha256:string
}
>;
type NativeAnchor=Readonly<{
  path:string;
  birth:string;
  processPid:number;
  processBirth:string;
  revalidate():void
}
>;
export type AdministrativeActor=Readonly<{
  pid:number;
  birth:string;
  proc:Identity;
  exe:Identity;
  root:Identity;
  cwd:Identity;
  user:string;
  pidNamespace:string;
  mountNamespace:string;
  invocationId:string;
  unit:string;
  group:string
}
>;
type Origin=Readonly<{
  beforeSha256:string;
  selectionSha256:string;
  readySha256:string;
  actor:AdministrativeActor
}
>;
function identity(s:BigIntStats):Identity{
  return {
    dev:String(s.dev),ino:String(s.ino),mode:String(s.mode),uid:String(s.uid),gid:String(s.gid)
  }
  ;
}
function equal(a:unknown,b:unknown):void{
  assert.deepEqual(a,b);
}
function mount(fd:number):string{
  const rows=[...readFileSync(`/proc/self/fdinfo/${fd}`,"utf8").matchAll(/^mnt_id:\s+([1-9][0-9]*)$/gm)];
  assert.equal(rows.length,1);
  return rows[0]![1]!;
}
function ancestry(path:string):void{
  // These transient ancestry FDs never survive to administrative ready.
  for(let p=dirname(path);;p=dirname(p)){
    const fd=openSync(p,C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW);
    try{
      const s=fstatSync(fd,{
        bigint:true
      }
      );
      assert(s.isDirectory() && s.uid===0n && s.gid===0n && !(s.mode&0o022n));
      equal(identity(s),identity(lstatSync(p,{
        bigint:true
      }
      )));
      assert.equal(realpathSync(`/proc/self/fd/${fd}`),p);
    }
    finally{
      closeSync(fd);
    }
    if(p==="/")break;
  }
}
function bytes(fd:number,max=1024*1024):Buffer{
  const s=fstatSync(fd,{
    bigint:true
  }
  );
  assert(s.size>=0n && s.size<=BigInt(max));
  const result=Buffer.alloc(Number(s.size));
  let at=0;
  while(at<result.length){
    const n=readSync(fd,result,at,result.length-at,at);
    assert(n>0);
    at+=n;
  }
  return result;
}
function ancestryMetadata(path:string):void{
  for(let p=dirname(path);;p=dirname(p)){
    const s=lstatSync(p,{
      bigint:true
    }
    );
    assert(s.isDirectory() && !s.isSymbolicLink() && s.uid===0n && s.gid===0n && !(s.mode&0o022n));
    assert.equal(realpathSync(p),p);
    if(p==="/")break;
  }
}
function retain(path:string,max=1024*1024,directoryDescriptors=true):Held{
  if(directoryDescriptors)ancestry(path);
  else ancestryMetadata(path);
  const fd=openSync(path,C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK);
  try{
    const stat=fstatSync(fd,{
      bigint:true
    }
    );
    assert(stat.isFile() && stat.uid===0n && stat.gid===0n && stat.nlink===1n && !(stat.mode&0o022n));
    const held={
      fd,path,stat,mount:mount(fd),sha256:digest(bytes(fd,max))
    }
    ;
    rejoin(held,max,directoryDescriptors);
    return held;
  }
  catch(error){
    closeSync(fd);
    throw error;
  }
}
function rejoin(h:Held,max=1024*1024,directoryDescriptors=true):void{
  if(directoryDescriptors)ancestry(h.path);
  else ancestryMetadata(h.path);
  const fd=openSync(h.path,C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK);
  try{
    for(const f of [h.fd,fd]){
      const s=fstatSync(f,{
        bigint:true
      }
      );
      equal(identity(s),identity(h.stat));
      assert(s.nlink===1n && s.size===h.stat.size && s.ctimeNs===h.stat.ctimeNs && s.mtimeNs===h.stat.mtimeNs);
      assert.equal(mount(f),h.mount);
      assert.equal(digest(bytes(f,max)),h.sha256);
    }
  }
  finally{
    closeSync(fd);
  }
}
function json<T>(h:Held):T{
  const b=bytes(h.fd);
  const value:unknown=JSON.parse(new TextDecoder("utf-8",{
    fatal:true
  }
  ).decode(b));
  assert(b.equals(Buffer.from(JSON.stringify(value)+"\n")));
  return value as T;
}
function seal(name:string,value:unknown):Buffer{
  const path=control+"/"+name;
  ancestry(path);
  const b=Buffer.from(JSON.stringify(value)+"\n");
  const fd=openSync(path,C.O_WRONLY|C.O_CREAT|C.O_EXCL|C.O_NOFOLLOW,0o400);
  try{
    writeFileSync(fd,b);
    fsyncSync(fd);
  }
  finally{
    closeSync(fd);
  }
  const directory=openSync(control,C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW);
  try{
    fsyncSync(directory);
  }
  finally{
    closeSync(directory);
  }
  return b;
}
function absent(path:string):void{
  try{
    lstatSync(path);
  }
  catch(error){
    if((error as NodeJS.ErrnoException).code==="ENOENT")return;
    throw error;
  }
  assert.fail("administrative origin/target already exists; no adoption or replay");
}
function birth(prefix:string):string{
  const raw=readFileSync(prefix+"/stat","utf8"),end=raw.lastIndexOf(") "),parts=raw.slice(end+2).trim().split(/\s+/);
  assert(end>0 && !["Z","X","x"].includes(parts[0]??""));
  assert.match(parts[19]??"",/^[1-9][0-9]*$/);
  return parts[19]!;
}
function show():Readonly<Record<string,string>>{
  const keys=["Id","InvocationID","MainPID","ControlGroup","LoadState","ActiveState","User","Group","Delegate","Restart","NoNewPrivileges","CapabilityBoundingSet","AmbientCapabilities","ExecMainCode","RootDirectory","WorkingDirectory","PrivateNetwork","PrivateDevices"];
  const r=spawnSync("/usr/bin/systemctl",["show",unit,"--property="+keys.join(",")],{
    cwd:"/",env:environment,encoding:"utf8",timeout:5000,maxBuffer:8192,stdio:["ignore","pipe","pipe"]
  }
  );
  assert(!r.error && r.status===0 && r.signal===null);
  const value:Record<string,string>={
  }
  ;
  for(const line of r.stdout.trimEnd().split("\n")){
    const at=line.indexOf("=");
    assert(at>0 && !Object.hasOwn(value,line.slice(0,at)));
    value[line.slice(0,at)]=line.slice(at+1);
  }
  equal(Object.keys(value).sort(),keys.sort());
  return Object.freeze(value);
}
function loaded(s:Readonly<Record<string,string>>):void{
  assert(s.Id===unit && s.LoadState==="loaded" && ["active","activating"].includes(s.ActiveState??"") && s.ControlGroup===group);
  assert.match(s.InvocationID??"",/^[a-f0-9]{32}$/);
  assert.match(s.MainPID??"",/^[1-9][0-9]*$/);
  for(const [key,value] of Object.entries({
    User:"0",Group:"0",Delegate:"no",Restart:"no",NoNewPrivileges:"yes",CapabilityBoundingSet:"",AmbientCapabilities:"",RootDirectory:"",WorkingDirectory:administrativeWork,PrivateNetwork:"yes",PrivateDevices:"yes"
  }
  ))assert.equal(s[key],value);
}
/** Only current package factual readers compose the existing canonical DATA parser.
 * The original relocated operation keeps its exact historical raw-v2 predicates. */
function sourceReaderCgroup(raw:string):string {
  const name=basename(fileURLToPath(import.meta.url));
  if(name==="administrative-installation.js")return raw;
  assert.equal(name,"current-administrative-installation.js");
  // Pure existing ESM helper has no top-level await; synchronous require is supported by
  // original Node24 and Node22.12+ CI. Never resolve from cwd or an absolute fallback.
  const parser=createRequire(import.meta.url)("../../dist/core/host-infrastructure/process-cgroup.js") as typeof import("../../src/core/host-infrastructure/process-cgroup.js");
  return parser.observedProcessCgroup(raw)+"\n";
}
function actor(s:Readonly<Record<string,string>>,selection:Selection,sourceReader=false):AdministrativeActor{
  loaded(s);
  const numeric="/proc/"+s.MainPID,fd=openSync(numeric,C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW);
  try{
    const prefix=`/proc/self/fd/${fd}`,proc=identity(fstatSync(fd,{
      bigint:true
    }
    )),start=birth(prefix);
    assert.equal(statfsSync(prefix,{
      bigint:true
    }
    ).type,0x9fa0n);
    const status=readFileSync(prefix+"/status","utf8");
    assert.match(status,/^Uid:\s+0\s+0\s+0\s+0$/m);
    assert.match(status,/^Gid:\s+0\s+0\s+0\s+0$/m);
    assert.match(status,/^NoNewPrivs:\s+1$/m);
    for(const cap of ["Inh","Prm","Eff","Bnd","Amb"])assert.match(status,new RegExp("^Cap"+cap+":\\s+0+$","m"));
    const cgroup=readFileSync(prefix+"/cgroup","utf8");assert.equal(sourceReader?sourceReaderCgroup(cgroup):cgroup,"0::"+group+"\n");
    assert(readFileSync(prefix+"/cmdline").equals(Buffer.from([selection.node.path,selection.actor.path,"--maintain",""] .join("\0"))));
    const executable=openSync(prefix+"/exe",C.O_RDONLY),named=retain(selection.node.path,128*1024*1024);
    try{
      equal(identity(fstatSync(executable,{
        bigint:true
      }
      )),identity(named.stat));
      assert.equal(named.sha256,selection.node.sha256);
    }
    finally{
      closeSync(executable);
      closeSync(named.fd);
    }
    const result={
      pid:Number(s.MainPID),birth:start,proc,exe:identity(statSync(prefix+"/exe",{
        bigint:true
      }
      )),root:identity(statSync(prefix+"/root",{
        bigint:true
      }
      )),cwd:identity(statSync(prefix+"/cwd",{
        bigint:true
      }
      )),user:readlinkSync(prefix+"/ns/user"),pidNamespace:readlinkSync(prefix+"/ns/pid"),mountNamespace:readlinkSync(prefix+"/ns/mnt"),invocationId:s.InvocationID!,unit,group
    }
    ;
    equal(result.cwd,identity(lstatSync(administrativeWork,{
      bigint:true
    }
    )));
    const fresh=openSync(numeric,C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW);
    try{
      equal(identity(fstatSync(fresh,{
        bigint:true
      }
      )),proc);
      assert.equal(mount(fresh),mount(fd));
      assert.equal(birth(`/proc/self/fd/${fresh}`),start);
      equal(identity(statSync(prefix+"/root",{
        bigint:true
      }
      )),result.root);
      equal(identity(statSync(prefix+"/cwd",{
        bigint:true
      }
      )),result.cwd);
      assert.equal(birth(prefix),start);
      for(const [name,value] of [["user",result.user],["pid",result.pidNamespace],["mnt",result.mountNamespace]])assert.equal(readlinkSync(prefix+"/ns/"+name),value);
      equal(identity(statSync(prefix+"/exe",{
        bigint:true
      }
      )),result.exe);
      equal(show(),s);
    }
    finally{
      closeSync(fresh);
    }
    return Object.freeze(result);
  }
  finally{
    closeSync(fd);
  }
}
function selection(h:Held):Selection{
  const s=json<Selection>(h);
  equal(Object.keys(s).sort(),["actor","node","operation","producer","schemaVersion","sourceReviewSha256","sourceSha"].sort());
  assert.equal(s.schemaVersion,1);
  assert.match(s.sourceSha,/^[a-f0-9]{40}$/);
  for(const row of [s.producer,s.actor,s.node,s.operation]){
    equal(Object.keys(row).sort(),["path","sha256"]);
    assert.match(row.sha256,/^[a-f0-9]{64}$/);
  }
  assert(s.node.path===hostNode || s.node.path===guestNode);
  assert.equal(s.actor.path,actorPath);
  assert(s.producer.path===control+"/run-public-stage-9ca.mts" || s.producer.path===guestProducer);
  assert.equal(s.operation.path,control+"/administrative-installation.js");
  assert.match(s.sourceReviewSha256,/^[a-f0-9]{64}$/);
  const selectedReview=retain(control+(s.producer.path===guestProducer?"/original-bootstrap-boundary-FREEZE.json":"/administration-independent-review-FREEZE.json"));
  try{
    assert.equal(selectedReview.sha256,s.sourceReviewSha256);
    const record=JSON.parse(new TextDecoder("utf-8",{
      fatal:true
    }
    ).decode(bytes(selectedReview.fd))) as Record<string,unknown>;
    assert.equal(record.sourceSha,s.sourceSha);
    if(s.producer.path!==guestProducer){
      assert(Array.isArray(record.files));
      for(const [row,name] of [[s.producer,"run-public-stage-9ca.mts"],[s.operation,"administrative-installation.js"],[s.actor,"administrative-public-maintenance.js"]] as const){
        const matches:unknown[]=record.files.filter((file:unknown)=>file && typeof file==="object" && "path" in file && file.path===name);
        assert.equal(matches.length,1);
        assert.equal((matches[0] as Record<string,unknown>).sha256,row.sha256);
      }
      assert.equal(s.node.path,hostNode);
      assert.equal(s.node.sha256,"7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c");
    }
    rejoin(selectedReview);
  }
  finally{
    closeSync(selectedReview.fd);
  }
  return Object.freeze(s);
}
const producerCustody=new WeakMap<object,Readonly<{
  selected:Selection;
  review:Held;
  catalog:Held;
  sources:Held[];
  own:string;
  pid:number
}
>>();
const publicUnit="subscription-runtime-installer-73000000-0000-4000-8000-9ca302fabd07.service";
const publicGroup="/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/"+publicUnit;
function selfPid():number{
  const row=readFileSync("/proc/self/stat","utf8");
  const match=/^([1-9][0-9]*) \(/.exec(row);
  assert(match);
  return Number(match[1]);
}
/** A private once-only capability is minted only for the original actual
* administrative installer birth. Mutable JS argv/env are not its origin. */
export function retainOriginalAdministrativeProducer():object {
  const review=retain(control+"/original-bootstrap-boundary-FREEZE.json"),catalog=retain(control+"/administration-reviewed-source.json"),sources:Held[]=[];
  try{
    const selected=selection(catalog),own=birth("/proc/self"),pid=selfPid();
    assert(process.platform==="linux" && process.getuid?.()===0 && process.getgid?.()===0);
    for(const row of [selected.producer,selected.actor,selected.node,selected.operation]){
      const h=retain(row.path,128*1024*1024);
      assert.equal(h.sha256,row.sha256);
      sources.push(h);
    }
    const sourceReview=retain(control+(selected.producer.path===guestProducer?"/original-bootstrap-boundary-FREEZE.json":"/administration-independent-review-FREEZE.json"));
    assert.equal(sourceReview.sha256,selected.sourceReviewSha256);
    sources.push(sourceReview);
    const exe=openSync("/proc/self/exe",C.O_RDONLY);
    try{
      equal(identity(fstatSync(exe,{
        bigint:true
      }
      )),identity(sources[2]!.stat));
    }
    finally{
      closeSync(exe);
    }
    assert.equal(digest(readFileSync(fileURLToPath(import.meta.url))),selected.operation.sha256);
    assert.match(readFileSync("/proc/self/status","utf8"),/^Uid:\s+0\s+0\s+0\s+0$/m);
    if(selected.producer.path===guestProducer){
      const origin=retain(control+"/administrative-producer-birth.json");
      sources.push(origin);
      const record=json<Record<string,unknown>>(origin);
      assert.equal(record.pid,pid);
      assert.equal(record.birth,own);
      assert.equal(record.producerSha256,selected.producer.sha256);
      assert.equal(record.sourceSha,selected.sourceSha);
      assert.equal(record.bootId,readFileSync("/proc/sys/kernel/random/boot_id","utf8").trim());
      assert.equal(readFileSync("/proc/self/cgroup","utf8"),"0::/system.slice/TEST-retention-supervisor.service\n");
      const stat=readFileSync("/proc/self/stat","utf8");
      const fields=stat.slice(stat.lastIndexOf(") ")+2).trim().split(/\s+/);
      assert.equal(Number(fields[1]),record.parentPid);
      const parent=openSync("/proc/"+record.parentPid,C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW);
      try{
        const prefix=`/proc/self/fd/${parent}`;
        assert.equal(statfsSync(prefix,{
          bigint:true
        }
        ).type,0x9fa0n);
        assert.equal(birth(prefix),record.parentBirth);
        equal(identity(fstatSync(parent,{
          bigint:true
        }
        )),record.parentIdentity);
        const result=spawnSync("/usr/bin/systemctl",["show","TEST-retention-supervisor.service","--property=MainPID,InvocationID,ControlGroup"],{
          cwd:"/",env:environment,encoding:"utf8",timeout:5000
        }
        );
        assert(!result.error && result.status===0 && result.signal===null);
        const rows=result.stdout.trimEnd().split("\n");
        assert.equal(rows.length,3);
        assert(rows.includes("MainPID="+record.parentPid) && rows.includes("InvocationID="+record.parentInvocationId) && rows.includes("ControlGroup=/system.slice/TEST-retention-supervisor.service"));
        assert.equal(birth(prefix),record.parentBirth);
      }
      finally{
        closeSync(parent);
      }
      const establishment=json<Record<string,unknown>>(review);
      assert.equal(establishment.sourceSha,selected.sourceSha);
      assert.equal(establishment.entry,"registration-outer.ts");
      assert.equal(establishment.guestProducerSha256,selected.producer.sha256);
    }
    else{
      assert.equal(review.sha256,boundarySha);
      const attempt=retain(base+"/results/PUBLIC-bootstrap-attempt.jsonl",32768),submission=retain(base+"/results/PUBLIC-submit-once.json",65536);
      sources.push(attempt,submission);
      const first=bytes(attempt.fd).toString("utf8").split("\n")[0];
      assert(first);
      const record=JSON.parse(first) as Record<string,unknown>;
      assert.equal(record.kind,"OWNED_PUBLIC_ATTEMPT");
      assert.equal(record.unit,publicUnit);
      assert.equal(record.pid,pid);
      assert.equal(record.startTicks,own);
      const submitted=json<Record<string,unknown>>(submission);
      assert.equal(submitted.kind,"OWNED_SUBMISSION_RESERVED");
      assert.equal(submitted.unit,publicUnit);
      assert(Array.isArray(submitted.sourcePins) && submitted.sourcePins.some((row:unknown)=>Array.isArray(row) && row[0]==="run-public-stage-9ca.mts" && row[2]===selected.producer.sha256));
      assert.equal(readFileSync("/proc/self/cgroup","utf8"),"0::"+publicGroup+"\n");
      const result=spawnSync("/usr/bin/systemctl",["show",publicUnit,"--property=MainPID,InvocationID,ControlGroup,Transient,NoNewPrivileges,CapabilityBoundingSet,AmbientCapabilities"],{
        cwd:"/",env:environment,encoding:"utf8",timeout:5000
      }
      );
      assert(!result.error && result.status===0 && result.signal===null);
      const rows=result.stdout.trimEnd().split("\n");
      assert.equal(rows.length,7);
      for(const value of ["MainPID="+pid,"InvocationID="+record.invocationId,"ControlGroup="+publicGroup,"Transient=yes","NoNewPrivileges=yes","CapabilityBoundingSet=","AmbientCapabilities="])assert(rows.includes(value));
      assert.match(String(record.invocationId),/^[a-f0-9]{32}$/);
    }
    for(const h of [review,catalog,...sources])rejoin(h,128*1024*1024);
    assert.equal(birth("/proc/self"),own);
    assert.equal(selfPid(),pid);
    const capability=Object.freeze({
    }
    );
    producerCustody.set(capability,{
      selected,review,catalog,sources,own,pid
    }
    );
    return capability;
  }
  catch(error){
    for(const h of [review,catalog,...sources])closeSync(h.fd);
    throw error;
  }
}
/** The only submit accepts the private native birth/source custody above. No
* role enum, PID input, copied receipt or arbitrary application call qualifies. */
export function submitPublicAdministrativeMaintenance(capability:object):void{
  const custody=producerCustody.get(capability);
  assert(custody);
  producerCustody.delete(capability);
  const {
    selected,review,catalog,sources,own,pid
  }
  =custody;
  try{
    assert.equal(selfPid(),pid);
    assert.equal(birth("/proc/self"),own);
    for(const h of [review,catalog,...sources])rejoin(h,128*1024*1024);
    absent(job+"/os-TEST");
    absent(control+"/TEST-native-backing.img");
    absent(control+"/administrative-before.json");
    absent(control+"/administrative-origin.json");
    absent(control+"/administrative-ready.json");
    const uncreated=spawnSync("/usr/bin/systemctl",["show",unit,"--property=LoadState","--value"],{
      env:environment,encoding:"utf8",timeout:5000,maxBuffer:512
    }
    );
    assert(!uncreated.error && [0,4].includes(uncreated.status??-1) && uncreated.signal===null && uncreated.stdout.trim()==="not-found");
    const machineId=readFileSync("/etc/machine-id","utf8").trim(),bootId=readFileSync("/proc/sys/kernel/random/boot_id","utf8").trim();
    for(const h of [review,catalog,...sources])rejoin(h,128*1024*1024);
    const before=seal("administrative-before.json",{
      schemaVersion:1,machineId,bootId,producerPid:pid,producerBirth:own,producerRoot:identity(statSync("/proc/self/root",{
        bigint:true
      }
      )),producerUser:readlinkSync("/proc/self/ns/user"),producerPidNamespace:readlinkSync("/proc/self/ns/pid"),producerSourceSha256:selected.producer.sha256,selectionSha256:catalog.sha256,boundaryFreezeSha256:review.sha256
    }
    );
    const properties=["User=0","Group=0","Slice=system.slice","Delegate=no","Restart=no","KillMode=control-group","NoNewPrivileges=yes","CapabilityBoundingSet=","AmbientCapabilities=","PrivateNetwork=yes","PrivateDevices=yes","StandardInput=null","StandardOutput=null","StandardError=null","RuntimeMaxSec=20min","TimeoutStopSec=30s","WorkingDirectory="+administrativeWork,"UMask=0077","EnvironmentFile=","PassEnvironment=","UnsetEnvironment=NODE_OPTIONS NODE_PATH NODE_CHANNEL_FD NODE_CHANNEL_SERIALIZATION_MODE LISTEN_FDS LISTEN_PID LISTEN_FDNAMES LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT GCONV_PATH LOCPATH GLIBC_TUNABLES OPENSSL_CONF OPENSSL_MODULES NODE_V8_COVERAGE"];
    const r=spawnSync("/usr/bin/systemd-run",["--collect","--unit="+unit,"--service-type=exec","--expand-environment=no",...properties.map(p=>"--property="+p),...Object.entries(environment).map(([k,v])=>"--setenv="+k+"="+v),"--",selected.node.path,selected.actor.path,"--maintain"],{
      cwd:"/",env:environment,encoding:"utf8",timeout:10000,maxBuffer:8192,stdio:["ignore","pipe","pipe"]
    }
    );
    // Any uncertainty preserves before.json and forbids another submit.
    assert(!r.error && r.status===0 && r.signal===null);
    const state=show(),actual=actor(state,selected),ready=waitReady(actual,selected);
    try {
    equal(actual.root,identity(statSync("/proc/self/root",{
      bigint:true
    }
    )));
    assert.equal(actual.user,readlinkSync("/proc/self/ns/user"));
    assert.equal(actual.pidNamespace,readlinkSync("/proc/self/ns/pid"));
    assert.equal(birth("/proc/self"),own);
    for(const h of [review,catalog,...sources])rejoin(h,128*1024*1024);
    rejoin(ready,4096);
    equal(actor(show(),selected),actual);
    equal(show(),state);
    seal("administrative-origin.json",{
      beforeSha256:digest(before),selectionSha256:catalog.sha256,readySha256:ready.sha256,actor:actual
    }
    );
    } finally {closeSync(ready.fd);}
  }
  finally{
    for(const h of [review,catalog,...sources])closeSync(h.fd);
  }
}
/** Factual reader only. Caller owns actual retained proc/task and complete
* target/control exposure census. It never returns an administrator role. */
export function readOriginalPublicAdministrativeActor(anchor:NativeAnchor,expectedSourceSha:string):AdministrativeActor|undefined{
  const path=control+"/administrative-origin.json";
  try{
    lstatSync(path);
  }
  catch(error){
    if((error as NodeJS.ErrnoException).code==="ENOENT")return undefined;
    throw error;
  }
  const origin=retain(path),ready=retain(control+"/administrative-ready.json",4096),before=retain(control+"/administrative-before.json"),catalog=retain(control+"/administration-reviewed-source.json"),review=retain(control+"/original-bootstrap-boundary-FREEZE.json"),sources:Held[]=[];
  try{
    const value=json<Origin>(origin),selected=selection(catalog),earlier=json<Record<string,unknown>>(before);
    assert(selected.producer.path===guestProducer || review.sha256===boundarySha);
    equal(Object.keys(value).sort(),["actor","beforeSha256","readySha256","selectionSha256"]);
    assert.equal(value.readySha256,ready.sha256);
    const initialized=json<Record<string,unknown>>(ready);
    equal(Object.keys(initialized).sort(),["birth","invocationId","pid","schemaVersion"]);
    assert(initialized.schemaVersion===1 && initialized.pid===value.actor.pid && initialized.birth===value.actor.birth && initialized.invocationId===value.actor.invocationId);
    assert.equal(value.beforeSha256,before.sha256);
    assert.equal(value.selectionSha256,catalog.sha256);
    assert.equal(earlier.selectionSha256,catalog.sha256);
    assert.equal(earlier.boundaryFreezeSha256,review.sha256);
    assert.equal(earlier.producerSourceSha256,selected.producer.sha256);
    assert.equal(earlier.machineId,readFileSync("/etc/machine-id","utf8").trim());
    assert.equal(earlier.bootId,readFileSync("/proc/sys/kernel/random/boot_id","utf8").trim());
    assert.equal(selected.sourceSha,expectedSourceSha);
    if(value.actor.pid!==anchor.processPid || value.actor.birth!==anchor.processBirth)return undefined;
    anchor.revalidate();
    assert.equal(statfsSync(anchor.path,{
      bigint:true
    }
    ).type,0x9fa0n);
    const current=actor(show(),selected,true);
    equal(current,value.actor);
    equal(current.root,earlier.producerRoot);
    assert.equal(current.user,earlier.producerUser);
    assert.equal(current.pidNamespace,earlier.producerPidNamespace);
    // A Node task has its own birth/proc inode. Join the actual retained task
    // to the born leader through namespace/root/cgroup/status, never a PID-only
    // role waiver or leader-inode comparison against a different thread.
    function taskJoin():void{
      anchor.revalidate();
      assert.equal(birth(anchor.path),anchor.birth);
      assert.equal(sourceReaderCgroup(readFileSync(anchor.path+"/cgroup","utf8")),"0::"+group+"\n");
      equal(identity(statSync(anchor.path+"/root",{
        bigint:true
      }
      )),current.root);
      equal(identity(statSync(anchor.path+"/exe",{
        bigint:true
      }
      )),current.exe);
      for(const [name,value] of [["user",current.user],["pid",current.pidNamespace],["mnt",current.mountNamespace]])assert.equal(readlinkSync(anchor.path+"/ns/"+name),value);
      const status=readFileSync(anchor.path+"/status","utf8");
      assert.match(status,/^Uid:\s+0\s+0\s+0\s+0$/m);
      assert.match(status,/^Gid:\s+0\s+0\s+0\s+0$/m);
      assert.match(status,/^NoNewPrivs:\s+1$/m);
      for(const cap of ["Inh","Prm","Eff","Bnd","Amb"])assert.match(status,new RegExp("^Cap"+cap+":\\s+0+$","m"));
      anchor.revalidate();
    }
    taskJoin();
    for(const row of [selected.producer,selected.actor,selected.node,selected.operation]){
      const h=retain(row.path,128*1024*1024);
      assert.equal(h.sha256,row.sha256);
      sources.push(h);
    }
    for(const h of [origin,ready,before,catalog,review,...sources])rejoin(h,128*1024*1024);
    taskJoin();
    equal(actor(show(),selected,true),current);
    return current;
  }
  finally{
    for(const h of [origin,ready,before,catalog,review,...sources])closeSync(h.fd);
  }
}
/** READY is only completed initialization of the already source-selected
 * born actor. This leaf publication NEVER opens a target-ancestor directory. */
function publishReady():void {
  const invocationId=process.env.INVOCATION_ID;assert.match(invocationId??"",/^[a-f0-9]{32}$/);
  const data={schemaVersion:1,pid:selfPid(),birth:birth("/proc/self"),invocationId};
  assert.equal(readFileSync("/proc/self/cgroup","utf8"),"0::"+group+"\n");
  ancestryMetadata(control+"/administrative-ready.json");
  const fd=openSync(control+"/administrative-ready.json",C.O_WRONLY|C.O_CREAT|C.O_EXCL|C.O_NOFOLLOW,0o400);
  try {writeFileSync(fd,JSON.stringify(data)+"\n");fsyncSync(fd);} finally {closeSync(fd);}
}
function waitReady(actual:AdministrativeActor,selected:Selection):Held {
  const deadline=process.hrtime.bigint()+5000000000n;
  for(;;){
    assert(process.hrtime.bigint()<deadline,"fixed actor initialization did not complete; preserve attempt");
    equal(actor(show(),selected),actual);
    let held:Held|undefined;
    try {
      held=retain(control+"/administrative-ready.json",4096);
      assert.equal(held.stat.mode&0o7777n,0o400n);
      const row=json<Record<string,unknown>>(held);
      equal(Object.keys(row).sort(),["birth","invocationId","pid","schemaVersion"]);
      assert(row.schemaVersion===1 && row.pid===actual.pid && row.birth===actual.birth && row.invocationId===actual.invocationId);
      rejoin(held,4096);return held;
    } catch(error) {
      if(held)closeSync(held.fd);
      // Creation/short startup bytes are unqualified. Only this pre-origin
      // phase polls; no unit resubmit or post-admission effect is retried.
      assert((error as NodeJS.ErrnoException).code==="ENOENT" || error instanceof SyntaxError || (error as NodeJS.ErrnoException).code==="ERR_ASSERTION");
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
  }
}
async function maintain():Promise<void>{
  assert(process.argv.length===3 && process.argv[1]===actorPath && process.argv[2]==="--maintain" && process.execArgv.length===0);
  assert(Object.keys(process.env).every(k=>Object.hasOwn(environment,k) || ["INVOCATION_ID","JOURNAL_STREAM","SYSTEMD_EXEC_PID","USER","LOGNAME","SHELL"].includes(k)));
  for(const [key,value] of Object.entries(environment))assert.equal(process.env[key],value);
  assert.match(process.env.INVOCATION_ID??"",/^[a-f0-9]{32}$/);
  const catalog=retain(control+"/administration-reviewed-source.json"),selected=selection(catalog),source=retain(actorPath),node=retain(selected.node.path,128*1024*1024);
  try{
    assert.equal(source.sha256,selected.actor.sha256);
    assert.equal(node.sha256,selected.node.sha256);
    assert.equal(process.execPath,selected.node.path);
    const self=birth("/proc/self"),deadline=process.hrtime.bigint()+20n*60n*1000000000n;
    publishReady();
    while(process.hrtime.bigint()<deadline){
      for(const h of [catalog,source,node])rejoin(h,128*1024*1024,false);
      assert.equal(birth("/proc/self"),self);
      // One genuine administrative maintenance operation: verify the original
      // PUBLIC installation receipt. No target/image, arbitrary path, command,
      // inherited endpoint, provider or requester data is accepted.
      const receipt=job+"/public-stage-receipt.json";
      try{
        const h=retain(receipt,65536,false);
        try{
          const value:unknown=JSON.parse(bytes(h.fd).toString("utf8"));
          assert(value && typeof value==="object" && "kind" in value);
          assert.equal(value.kind,"PUBLIC_DATA_ONLY_NON_AUTHORITATIVE");
          rejoin(h,65536,false);
        }
        finally{
          closeSync(h.fd);
        }
      }
      catch(error){
        if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;
      }
      await new Promise<void>(resolve=>setTimeout(resolve,250));
    }
  }
  finally{
    for(const h of [catalog,source,node])closeSync(h.fd);
  }
}
if(fileURLToPath(import.meta.url)===process.argv[1])maintain().catch(()=>{
  process.exitCode=70;
}
);
/** Before-target physical DATA capture. Only the actual SOURCE caller's causal
* exclusive-create order establishes target birth; this never labels a PID. */
export function readOriginalAdministrativeBirth(expectedSourceSha:string):Readonly<{actor:AdministrativeActor;originSha256:string}>|undefined {
  const path=control+"/administrative-origin.json";
  try{lstatSync(path);}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return undefined;throw error;}
  const origin=retain(path);
  try{
    const row=json<Origin>(origin);assert(Number.isSafeInteger(row.actor.pid));
    const fd=openSync("/proc/"+row.actor.pid,C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW);
    try{
      const prefix=`/proc/self/fd/${fd}`,start=birth(prefix),held=fstatSync(fd,{bigint:true}),mnt=mount(fd);
      const anchor={path:prefix,birth:start,processPid:row.actor.pid,processBirth:start,revalidate(){
        const fresh=openSync("/proc/"+row.actor.pid,C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW);
        try{equal(identity(fstatSync(fresh,{bigint:true})),identity(held));assert.equal(mount(fresh),mnt);assert.equal(birth(`/proc/self/fd/${fresh}`),start);assert.equal(birth(prefix),start);}
        finally{closeSync(fresh);}
      }};
      const actual=readOriginalPublicAdministrativeActor(anchor,expectedSourceSha);assert(actual);rejoin(origin);anchor.revalidate();
      return Object.freeze({actor:actual,originSha256:origin.sha256});
    }finally{closeSync(fd);}
  }finally{closeSync(origin.fd);}
}
/** Sole original supervisor callsite, immediately before its existing spawn.
* The private parent custody is not serializable or an administrative grant. */
export function retainOriginalAdministrativeGuestSpawn():Readonly<{sealChild(pid:number):void}> {
  const review=retain(control+"/original-bootstrap-boundary-FREEZE.json"),catalog=retain(control+"/administration-reviewed-source.json"),selected=selection(catalog),sources:Held[]=[];
  try{
    assert.equal(selected.producer.path,guestProducer);
    const record=json<Record<string,unknown>>(review),parentSource="/opt/subscription-runtime-dependency-os-TEST/scripts/dependency-retention-os-test/common.ts";
    const fragment="/etc/systemd/test-units/TEST-retention-supervisor.service",parentPid=selfPid(),parentBirth=birth("/proc/self");
    for(const [path,sha256] of [[parentSource,record.supervisorSha256],[fragment,record.supervisorUnitSha256],[selected.producer.path,selected.producer.sha256],[selected.operation.path,selected.operation.sha256],[selected.node.path,selected.node.sha256]]){
      assert(typeof path==="string" && typeof sha256==="string");const held=retain(path,128*1024*1024);assert.equal(held.sha256,sha256);sources.push(held);
    }
    assert.equal(readFileSync("/proc/self/cgroup","utf8"),"0::/system.slice/TEST-retention-supervisor.service\n");
    assert(readFileSync("/proc/self/cmdline").equals(Buffer.from([selected.node.path,"--experimental-strip-types",parentSource,"supervisor",""].join("\0"))));
    equal(identity(statSync("/proc/self/root",{bigint:true})),record.rootIdentity);
    const result=spawnSync("/usr/bin/systemctl",["show","TEST-retention-supervisor.service","--property=MainPID,InvocationID,ControlGroup,FragmentPath"],{cwd:"/",env:environment,encoding:"utf8",timeout:5000});
    assert(!result.error && result.status===0 && result.signal===null);const rows=result.stdout.trimEnd().split("\n");assert.equal(rows.length,4);
    const invocation=rows.find(row=>/^InvocationID=[a-f0-9]{32}$/.test(row))?.slice(13);assert(invocation);
    assert(rows.includes("MainPID="+parentPid) && rows.includes("ControlGroup=/system.slice/TEST-retention-supervisor.service") && rows.includes("FragmentPath="+fragment));
    const parentIdentity=identity(statSync("/proc/self",{bigint:true}));let used=false;
    return Object.freeze({sealChild(pid:number){
      assert(!used);used=true;assert(Number.isSafeInteger(pid) && pid>1);
      try{
        assert.equal(selfPid(),parentPid);assert.equal(birth("/proc/self"),parentBirth);
        const fd=openSync("/proc/"+pid,C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW);
        try{
          const prefix=`/proc/self/fd/${fd}`,start=birth(prefix),childIdentity=identity(fstatSync(fd,{bigint:true}));assert.equal(statfsSync(prefix,{bigint:true}).type,0x9fa0n);
          const raw=readFileSync(prefix+"/stat","utf8"),fields=raw.slice(raw.lastIndexOf(") ")+2).trim().split(/\s+/);assert.equal(Number(fields[1]),parentPid);
          assert.equal(readFileSync(prefix+"/cgroup","utf8"),"0::/system.slice/TEST-retention-supervisor.service\n");
          const node=sources.find(h=>h.path===selected.node.path);assert(node);
          const exe=openSync(prefix+"/exe",C.O_RDONLY);
          try {equal(identity(fstatSync(exe,{bigint:true})),identity(node.stat));assert.equal(digest(bytes(exe,128*1024*1024)),node.sha256);}
          finally {closeSync(exe);}
          assert(readFileSync(prefix+"/cmdline").equals(Buffer.from([selected.node.path,"--experimental-strip-types",selected.producer.path,"qualify",""].join("\0"))));
          equal(identity(statSync(prefix+"/root",{bigint:true})),record.rootIdentity);
          for(const name of ["user","pid"])assert.equal(readlinkSync(prefix+"/ns/"+name),readlinkSync("/proc/self/ns/"+name));
          for(const h of [review,catalog,...sources])rejoin(h,128*1024*1024);
          const current=spawnSync("/usr/bin/systemctl",["show","TEST-retention-supervisor.service","--property=MainPID,InvocationID,ControlGroup,FragmentPath"],{cwd:"/",env:environment,encoding:"utf8",timeout:5000});
          assert(!current.error && current.status===0 && current.signal===null && current.stdout===result.stdout);
          assert.equal(birth(prefix),start);assert.equal(birth("/proc/self"),parentBirth);
          const fresh=openSync("/proc/"+pid,C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW);try{equal(identity(fstatSync(fresh,{bigint:true})),childIdentity);assert.equal(birth(`/proc/self/fd/${fresh}`),start);}finally{closeSync(fresh);}
          seal("administrative-producer-birth.json",{pid,birth:start,producerSha256:selected.producer.sha256,sourceSha:selected.sourceSha,parentPid,parentBirth,parentIdentity,parentInvocationId:invocation,bootId:readFileSync("/proc/sys/kernel/random/boot_id","utf8").trim()});
        }finally{closeSync(fd);}
      }finally{for(const h of [review,catalog,...sources])closeSync(h.fd);}
    }});
  }catch(error){for(const h of [review,catalog,...sources])closeSync(h.fd);throw error;}
}
