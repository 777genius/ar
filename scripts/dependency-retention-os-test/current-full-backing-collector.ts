/** Fixed FULL TEST backing observations. This module issues no REVIEW or grant. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fsyncSync, writeFileSync, fstatSync, lstatSync, openSync, opendirSync, linkSync, unlinkSync, readdirSync, readlinkSync, readSync, realpathSync, statSync, type BigIntStats, type Dirent } from "node:fs";
import { basename, dirname } from "node:path";
import { assertRetainedCurrentFullParent, retainedCurrentFullParentDescriptors, fullData, fullNativeLiveRoot, fullNativeGuestRoot, fullNativeJob, fullNativeOsBase, fullNativeTmpDir, fullNativeUnit, type retainCurrentFullParent } from "../../host-integration/managed-launcher/dependency-full-native-TEST.js";
import { fullRetainedFilesystemType } from "../../src/worker-codex/hosted-full-backing-proc.js";
import { readOriginalAdministrativeBirth, readOriginalPublicAdministrativeActor } from "./current-administrative-installation.js";
import { currentBackingStorage } from "./current-backing-geometry.js";

export enum FullBackingExposure {
  ImageDescriptor="image_descriptor_including_reopenable_readonly",
  LoopDescriptor="raw_loop_descriptor",
  AncestorDescriptor="image_ancestor_directory_handle",
  StorageDescriptor="same_backing_filesystem_handle",
  ImageMap="image_mapping",
  StorageMap="backing_storage_mapping",
  StorageMount="backing_filesystem_mount",
  NamespaceDescriptor="persistent_namespace_handle",
  SocketDescriptor="undischarged_socket_or_SCM_RIGHTS_route",
  ProcDescriptor="foreign_proc_directory_or_control_handle",
  PrivilegeCandidate="host_fsuid_or_initial_namespace_capability_candidate",
}
export enum FullBackingOwner {
  OriginalTrustedSetup="original_exact_TEST_setup",
  EstablishedTrustedAdministrator="original_administrative_installation_control_actor",
  KernelUnable="actual_zero_caps_owned_ro_routes",
  BootPid1="exact_trusted_boot_OS_init_scope",
  Unknown="unknown_enforcement_provenance",
}
export enum FullBackingRefusal {
  ToolUnavailable="exact_ioctl_tool_unavailable",
  LoopUnavailable="loop_device_unavailable",
  KernelJoinUnavailable="ioctl_backing_join_unavailable",
  OwnerUnclassified="relevant_owner_enforcement_unclassified",
  AdministrativeReference="established_administrator_has_actual_backing_reference",
  AdministrativeControlUncertain="fixed_administrative_recipe_has_undischarged_control_route",
  ProcUncertain="proc_identity_or_view_uncertain",
  Bound="bounded_observation_incomplete",
  ContinuityMissing="installed_admission_and_original_guest_fence_join_not_measured",
}
type Identity = Readonly<{dev:string;
  ino:string}>;
type Mount = Readonly<{id:string;
  parent:string;
  device:string;
  root:string;
  point:string;
  options:readonly string[];
  superOptions:readonly string[]}>;
export type FullGuestSelection = Readonly<{pid:number;
  birth:string;
  invocationId:string;
  group:string;
  rootDev:string;
  rootIno:string;
  mnt:string;
  pidNamespace:string;
  listenerInode:string;
  socketDev:string;
  socketIno:string}>;
type Target = Readonly<{image:Identity;
  ancestors:readonly Identity[];
  loopRdev:string|null;
  storageDevice:string|null}>;
const jobRoot="/srv/workers/jobs/"+fullNativeJob;
// Exact public host tool observation 85; replacement or absence refuses.
// Absence is a typed refusal, never a PATH/search/package-install fallback.
const ioctlTool = {path:"/usr/sbin/losetup",sha256:"44ccbcc5573aee3bd40fd3171ec368d62ba373f45263ac1d026c612ed86f0f02",bytes:"76304"} as const;
const hash=(bytes:Buffer):string=>createHash("sha256").update(bytes).digest("hex");
const identity=(s:BigIntStats):Identity=>({dev:String(s.dev),ino:String(s.ino)});
const same=(a:Identity,b:Identity):boolean=>a.dev===b.dev && a.ino===b.ino;
function device(dev:bigint):string {
  return String(((dev>>8n)&0xfffn)|((dev>>32n)&0xfffff000n))+":"+String((dev&0xffn)|((dev>>12n)&0xffffff00n));
}
function unescapeMount(value:string):string { return value.replace(/\\(040|011|012|134)/g,(_,oct:string)=>String.fromCharCode(Number.parseInt(oct,8)));
}
/** Kernel mount DATA, not a protection/lock or future exclusion predicate. */
export function fullBackingMounts(raw:string):readonly Mount[] {
  assert(Buffer.byteLength(raw)<=1024*1024 && raw.endsWith("\n"));
  const ids=new Set<string>();
  return raw.trimEnd().split("\n").map(row=>{
    const parts=row.split(" "),separator=parts.indexOf("-");
    assert(separator>=6 && parts.length===separator+4 && /^[1-9][0-9]*$/.test(parts[0]!) && /^[0-9]+$/.test(parts[1]!) && /^\d+:\d+$/.test(parts[2]!));
    assert(!ids.has(parts[0]!));
    ids.add(parts[0]!);
    assert(ids.size<=8192);
    return {id:parts[0]!,parent:parts[1]!,device:parts[2]!,root:unescapeMount(parts[3]!),point:unescapeMount(parts[4]!),options:parts[5]!.split(","),superOptions:parts[separator+3]!.split(",")};
  });
}
function boundedRead(path:string,bound:number,budget:()=>void):Buffer {
  budget();
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {const bytes=Buffer.alloc(bound+1);
    let size=0,count=0;
    while((count=readSync(fd,bytes,size,bytes.length-size,null))>0){size+=count;
      assert(size<=bound);
      budget();
    }
    return bytes.subarray(0,size);
  }finally{closeSync(fd);
  }
}
function text(path:string,bound:number,budget:()=>void):string{return boundedRead(path,bound,budget).toString("utf8");
}
function fdBytes(fd:number,bound:number,budget:()=>void):Buffer {
  budget();
  const bytes=Buffer.alloc(bound+1);
  let size=0,count=0;
  while((count=readSync(fd,bytes,size,bytes.length-size,size))>0){size+=count;
    assert(size<=bound);
    budget();
  }
  return bytes.subarray(0,size);
}
function mountId(fd:number,budget:()=>void):string {
  const matches=[...text(`/proc/self/fdinfo/${fd}`,4096,budget).matchAll(/^mnt_id:\s+([1-9][0-9]*)$/gm)];
  assert(matches.length===1);
  return matches[0]![1]!;
}
/** Observes actual descriptor metadata;
RO and O_PATH do not discharge exposure. */
export function fullBackingDescriptor(s:BigIntStats,target:Target,filesystemType?:bigint):FullBackingExposure|null {
  const i=identity(s);
  if(filesystemType===0x6e736673n)return FullBackingExposure.NamespaceDescriptor;
  if(filesystemType===0x9fa0n)return FullBackingExposure.ProcDescriptor;
  if(s.isSocket())return FullBackingExposure.SocketDescriptor;
  if(s.isFile() && same(i,target.image))return FullBackingExposure.ImageDescriptor;
  if(s.isBlockDevice() && String(s.rdev)===target.loopRdev)return FullBackingExposure.LoopDescriptor;
  if(s.isDirectory() && target.ancestors.some(a=>same(a,i)))return FullBackingExposure.AncestorDescriptor;
  if(target.storageDevice!==null && device(s.dev)===target.storageDevice)return FullBackingExposure.StorageDescriptor;
  return null;
}
function birthAt(prefix:string,budget:()=>void):string {
  const raw=text(prefix+"/stat",4096,budget),end=raw.lastIndexOf(") ");
  assert(end>0);
  const fields=raw.slice(end+2).trim().split(/\s+/);assert(fields[0] && !["Z","X","x"].includes(fields[0]));
  const result=fields[19];
  assert(result && /^[1-9][0-9]*$/.test(result));
  return result;
}
function birth(pid:number,tid:number,budget:()=>void):string {
  return birthAt(`/proc/${pid}/task/${tid}`,budget);
}
function numericNames(path:string,bound:number):string[] {
  const names=readdirSync(path).filter(name=>/^[1-9][0-9]*$/.test(name));
  assert(names.length<=bound);
  return names;
}

export type FullProcTaskAnchor=Readonly<{path:string;birth:string;processPid:number;processBirth:string;procIdentity:Identity;taskIdentity:Identity;revalidate():void;close():void}>;
type DescriptorStamp=Readonly<{native:string;mount:string;flags:string}>;
const observerDescriptors=new Map<number,DescriptorStamp>();
let observerBirth:Readonly<{identity:Identity;birth:string}>|undefined;
function descriptorInfo(raw:string):Readonly<{mount:string;flags:string;ino:string}> {
  const field=(name:string)=>{const rows=[...raw.matchAll(new RegExp("^"+name+":\\s+([0-9]+)$","gm"))];assert(rows.length===1);return rows[0]![1]!;};
  return {mount:field("mnt_id"),flags:field("flags"),ino:field("ino")};
}
function descriptorStamp(fd:number,budget:()=>void):DescriptorStamp {
  const stat=fstatSync(fd,{bigint:true}),info=descriptorInfo(text(`/proc/self/fdinfo/${fd}`,4096,budget));
  assert.equal(info.ino,String(stat.ino));
  return {native:[stat.dev,stat.ino,stat.mode,stat.uid,stat.gid,stat.rdev,fullRetainedFilesystemType(fd)].map(String).join(":"),mount:info.mount,flags:info.flags};
}
function rememberObserverDescriptor(fd:number,budget:()=>void):void {
  assert(!observerDescriptors.has(fd) && observerDescriptors.size<65536);
  const self=identity(statSync("/proc/self",{bigint:true})),birth=birthAt("/proc/self",budget);
  if(observerBirth){assert(same(self,observerBirth.identity) && birth===observerBirth.birth);}else observerBirth={identity:self,birth};
  observerDescriptors.set(fd,descriptorStamp(fd,budget));
}
function openObserverDescriptor(path:string,flags:number,budget:()=>void):number {
  const fd=openSync(path,flags);
  try{rememberObserverDescriptor(fd,budget);return fd;}catch(error){observerDescriptors.delete(fd);closeSync(fd);throw error;}
}
function closeObserverDescriptor(fd:number):void {
  // Invalidate ownership BEFORE close, so numeric FD reuse inherits no entry.
  assert(observerDescriptors.delete(fd));closeSync(fd);
}
function observerOwner(anchor:FullProcTaskAnchor,budget:()=>void):boolean {
  return observerBirth!==undefined && anchor.processPid===process.pid && anchor.processBirth===observerBirth.birth
    && same(anchor.procIdentity,observerBirth.identity) && same(identity(statSync("/proc/self",{bigint:true})),observerBirth.identity)
    && birthAt("/proc/self",budget)===observerBirth.birth;
}
/** Same descriptor census used by the real collector and owned Linux TEST.
 * Private metadata ownership removes only observer-created exact native slots.
 * Unexpected own slots and all foreign routes retain the original bounds. */
export function sampleFullProcDescriptors(anchor:FullProcTaskAnchor,target:Target,budget:()=>void) {
  return scanFullProcDescriptors(anchor,target,budget);
}
function scanFullProcDescriptors(anchor:FullProcTaskAnchor,target:Target,budget:()=>void,owned?:()=>ReadonlyMap<number,DescriptorStamp>) {
  anchor.revalidate();const self=observerOwner(anchor,budget),prefix=anchor.path;
  function openNames():Readonly<{names:string[];close():void}> {
    if(!self)return {names:readdirSync(prefix+"/fd").sort((a,b)=>Number(a)-Number(b)),close(){}};
    // Keep the actual directory stream alive. readdirSync(self/fd) otherwise
    // lists its own transient FD and closes it before the returned names scan.
    function liveNames():Set<string> {
      const result=new Set<string>();
      for(const name of readdirSync("/proc/self/fd")){assert(/^[0-9]+$/.test(name));budget();
        try{statSync("/proc/self/fd/"+name);result.add(name);}catch(error){assert.equal((error as NodeJS.ErrnoException).code,"ENOENT");}}
      assert(result.size<=65536);return result;
    }
    const before=liveNames(),dir=opendirSync(prefix+"/fd");let fd:number|undefined;
    try {
      const after=liveNames();assert([...before].every(name=>after.has(name)));
      const added=[...after].filter(name=>!before.has(name));assert.equal(added.length,1);fd=Number(added[0]);
      const actual=fstatSync(fd,{bigint:true}),named=statSync(prefix+"/fd",{bigint:true});
      assert(actual.isDirectory() && same(identity(actual),identity(named)) && fullRetainedFilesystemType(fd)===0x9fa0n);
      // Linux glibc/libuv directory streams may also carry harmless
      // NONBLOCK/LARGEFILE. No access/write/create/truncate/O_PATH bits qualify.
      const flags=BigInt("0o"+descriptorStamp(fd,budget).flags);
      const required=BigInt(constants.O_DIRECTORY)|0o2000000n; // O_CLOEXEC
      const allowed=required|BigInt(constants.O_NONBLOCK)|0o100000n; // O_LARGEFILE
      assert((flags&required)===required && (flags&~allowed)===0n);
      rememberObserverDescriptor(fd,budget);const names:string[]=[];let entry:Dirent|null;
      while((entry=dir.readSync())!==null){assert(/^[0-9]+$/.test(entry.name));names.push(entry.name);assert(names.length<=65536);budget();}
      return {names:names.sort((a,b)=>Number(a)-Number(b)),close(){assert(fd!==undefined && observerDescriptors.delete(fd));dir.closeSync();}};
    }catch(error){if(fd!==undefined)observerDescriptors.delete(fd);dir.closeSync();throw error;}
  }
  function sample(){
    anchor.revalidate();const extra=self?owned?.():undefined;
    const exposures=new Set<FullBackingExposure>(),joins:Record<string,unknown>[]=[],unaccounted:string[]=[];
    let custody=0;
    const directory=openNames();try{for(const name of directory.names){
      assert(/^[0-9]+$/.test(name));budget();const number=Number(name),path=prefix+"/fd/"+name,metadata=openSync(path,0x200000);
      try {
        const stat=fstatSync(metadata,{bigint:true}),filesystem=fullRetainedFilesystemType(metadata);
        const source=descriptorInfo(text(prefix+"/fdinfo/"+name,4096,budget));
        const actual:DescriptorStamp={native:[stat.dev,stat.ino,stat.mode,stat.uid,stat.gid,stat.rdev,filesystem].map(String).join(":"),mount:source.mount,flags:source.flags};
        assert.equal(source.ino,String(stat.ino));assert.equal(source.mount,mountId(metadata,budget));
        const held=self?(observerDescriptors.get(number)??extra?.get(number)):undefined;
        if(held){
          assert.deepEqual(actual,held);assert.deepEqual(descriptorStamp(number,budget),held);custody++;continue;
        }
        unaccounted.push(name);assert(unaccounted.length<=4096);
        const kind=fullBackingDescriptor(stat,target,filesystem);
        if(kind){exposures.add(kind);assert(joins.length<32);const after=statSync(path,{bigint:true});
          assert(same(identity(stat),identity(after)) && stat.rdev===after.rdev && stat.mode===after.mode);
          joins.push({fd:name,...identity(stat),rdev:String(stat.rdev),mode:String(stat.mode),mountId:source.mount,flags:source.flags,filesystemType:String(filesystem),exposure:kind});}
      }finally{closeSync(metadata);}
    }}finally{directory.close();}
    anchor.revalidate();return {exposures,joins,unaccounted,custody};
  }
  const first=sample();return Object.freeze({exposures:first.exposures,joins:first.joins,count:first.unaccounted.length,custody:first.custody,
    revalidate(){const next=sample();assert.deepEqual(next.unaccounted,first.unaccounted);assert.deepEqual(next.joins,first.joins);assert.deepEqual([...next.exposures].sort(),[...first.exposures].sort());}});
}

/** A proc directory descriptor refers to one kernel process object even when
 * its numeric PID is reused. This metadata adapter creates no authority. */
export function retainFullProcProcess(pid:number,budget:()=>void) {
  assert(Number.isSafeInteger(pid) && pid>0 && pid<=2147483647);
  const flags=constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW|constants.O_NONBLOCK;
  const descriptors:number[]=[],tasks=new Set<{close():void}>();
  let closed=false;
  function open(path:string):number {
    budget();
    const fd=openObserverDescriptor(path,flags,budget);
    descriptors.push(fd);
    assert(fstatSync(fd,{bigint:true}).isDirectory() && fullRetainedFilesystemType(fd)===0x9fa0n);
    return fd;
  }
  try {
    const proc=open("/proc"),processFd=open(`/proc/self/fd/${proc}/${pid}`);
    const taskDirectory=open(`/proc/self/fd/${processFd}/task`);
    const procStat=fstatSync(proc,{bigint:true}),processStat=fstatSync(processFd,{bigint:true}),taskStat=fstatSync(taskDirectory,{bigint:true});
    const prefix=`/proc/self/fd/${processFd}`,start=birthAt(prefix,budget);
    function join(fd:number,expected:BigIntStats,named:string):void {
      budget();
      const held=fstatSync(fd,{bigint:true}),current=lstatSync(named,{bigint:true});
      assert(held.isDirectory() && current.isDirectory() && !current.isSymbolicLink());
      assert(same(identity(held),identity(expected)) && same(identity(current),identity(expected)));
      const fresh=openSync(named,flags);try{assert(same(identity(fstatSync(fresh,{bigint:true})),identity(held)) && mountId(fresh,budget)===mountId(fd,budget));}finally{closeSync(fresh);}
    }
    function revalidate():void {
      assert(!closed);
      join(proc,procStat,"/proc");
      join(processFd,processStat,`/proc/self/fd/${proc}/${pid}`);
      join(taskDirectory,taskStat,prefix+"/task");
      assert.equal(birthAt(prefix,budget),start);
    }
    revalidate();
    return Object.freeze({
      taskIds(){revalidate();return numericNames(`/proc/self/fd/${taskDirectory}`,1024);},
      revalidate,
      retainTask(tid:number):FullProcTaskAnchor {
        assert(Number.isSafeInteger(tid) && tid>0 && tid<=2147483647);
        revalidate();
        const fd=openObserverDescriptor(`/proc/self/fd/${taskDirectory}/${tid}`,flags,budget);
        let taskClosed=false;
        try {
          const stat=fstatSync(fd,{bigint:true});assert(stat.isDirectory());
          const path=`/proc/self/fd/${fd}`,taskBirth=birthAt(path,budget);
          function current():void {
            assert(!taskClosed);revalidate();
            join(fd,stat,`/proc/self/fd/${taskDirectory}/${tid}`);
            assert.equal(birthAt(path,budget),taskBirth);
          }
          const task:FullProcTaskAnchor=Object.freeze({path,birth:taskBirth,processPid:pid,processBirth:start,procIdentity:identity(processStat),taskIdentity:identity(stat),revalidate:current,
            close(){if(taskClosed)return;taskClosed=true;tasks.delete(task);closeObserverDescriptor(fd);}});
          current();tasks.add(task);return task;
        }catch(error){closeObserverDescriptor(fd);throw error;}
      },
    close(){if(closed)return;for(const task of [...tasks])task.close();closed=true;for(const fd of descriptors)closeObserverDescriptor(fd);}
    });
  }catch(error){for(const fd of descriptors)closeObserverDescriptor(fd);throw error;}
}

/** Finite observer completion, not admission or future absence authority. */
export function retainFullProcRoster(budget:()=>void):Readonly<{revalidate():void}> {
  const names=numericNames("/proc",4096).sort((a,b)=>Number(a)-Number(b));
  return Object.freeze({revalidate(){budget();assert.deepEqual(numericNames("/proc",4096).sort((a,b)=>Number(a)-Number(b)),names);}});
}
export function retainFullProcTaskView(anchor:FullProcTaskAnchor,budget:()=>void) {
  const prefix=anchor.path,descriptors:{name:string;fd:number;stat:BigIntStats;filesystem:bigint;info:string}[]=[];
  const objects:{name:string;fd:number;stat:BigIntStats;mount:string}[]=[];
  const retained:number[]=[];
  function open(path:string,flags:number):number {const fd=openObserverDescriptor(path,flags,budget);retained.push(fd);return fd;}
  const names=()=>readdirSync(prefix+"/fd").sort((a,b)=>Number(a)-Number(b));
  function descriptorInfo(name:string):string {
    const raw=text(prefix+"/fdinfo/"+name,4096,budget);
    return ["flags","mnt_id","ino"].map(key=>{const rows=[...raw.matchAll(new RegExp("^"+key+":\\s+([^\\n]+)$","gm"))];assert(rows.length===1 && rows[0]?.[1]);return key+":"+rows[0]![1];}).join("\n");
  }
  function view(){anchor.revalidate();const status=text(prefix+"/status",16384,budget);
    const statusFields=["Uid","Gid","NSpid","NoNewPrivs","CapInh","CapPrm","CapEff","CapBnd","CapAmb","Kthread"].map(key=>[key,new RegExp("^"+key+":(.*)$","m").exec(status)?.[1]??null]);
    for(const object of objects){const fresh=openSync(prefix+"/"+object.name,constants.O_RDONLY|(object.name==="root"?constants.O_DIRECTORY:0));
      try{assert(same(identity(fstatSync(object.fd,{bigint:true})),identity(object.stat)) && same(identity(fstatSync(fresh,{bigint:true})),identity(object.stat)) && mountId(fresh,budget)===object.mount);}finally{closeSync(fresh);}}
    const root=statSync(prefix+"/root",{bigint:true});
    return {exe:readlinkSync(prefix+"/exe"),birth:birthAt(prefix,budget),names:names(),statusFields,root:identity(root),user:readlinkSync(prefix+"/ns/user"),mnt:readlinkSync(prefix+"/ns/mnt"),pid:readlinkSync(prefix+"/ns/pid"),cgroup:text(prefix+"/cgroup",4096,budget),uidMap:text(prefix+"/uid_map",4096,budget),gidMap:text(prefix+"/gid_map",4096,budget),cmdline:hash(boundedRead(prefix+"/cmdline",32768,budget)),maps:hash(boundedRead(prefix+"/maps",1024*1024,budget)),mounts:hash(boundedRead(prefix+"/mountinfo",1024*1024,budget))};
  }
  let closed=false;
  try{for(const name of ["root","cwd","exe","ns/user","ns/pid","ns/mnt"]){const fd=open(prefix+"/"+name,constants.O_RDONLY|(name==="root"?constants.O_DIRECTORY:0));
      objects.push({name,fd,stat:fstatSync(fd,{bigint:true}),mount:mountId(fd,budget)});}
    const initial=view();assert(initial.names.length<=4096);
    for(const name of initial.names){assert(/^[0-9]+$/.test(name));const fd=open(prefix+"/fd/"+name,0x200000);
      descriptors.push({name,fd,stat:fstatSync(fd,{bigint:true}),filesystem:fullRetainedFilesystemType(fd),info:descriptorInfo(name)});}
    function revalidate(){assert(!closed);budget();anchor.revalidate();assert.deepEqual(view(),initial);
      for(const entry of descriptors){const named=openSync(prefix+"/fd/"+entry.name,0x200000);
        try{const held=fstatSync(entry.fd,{bigint:true}),now=fstatSync(named,{bigint:true});assert(same(identity(held),identity(entry.stat)) && same(identity(now),identity(held)) && now.rdev===held.rdev && now.mode===held.mode && fullRetainedFilesystemType(named)===entry.filesystem && descriptorInfo(entry.name)===entry.info);}finally{closeSync(named);}}
      anchor.revalidate();assert.deepEqual(names(),initial.names);
    }
    revalidate();return Object.freeze({count:descriptors.length,revalidate,close(){if(closed)return;closed=true;for(const fd of retained)closeObserverDescriptor(fd);}});
  }catch(error){for(const fd of retained)closeObserverDescriptor(fd);throw error;}
}
/** Physical original administrative origin and actual references. No caller
 * role flag/UID list can satisfy this predicate; it issues no custody grant. */
export function readOriginalAdministrativeTaskReferences(anchor:FullProcTaskAnchor,sourceSha:string,originSha256:string,target:Target,budget:()=>void):Readonly<{actor:NonNullable<ReturnType<typeof readOriginalPublicAdministrativeActor>>;material:boolean;unresolved:readonly FullBackingExposure[]}>|undefined {
  budget();const actor=readOriginalPublicAdministrativeActor(anchor,sourceSha);if(!actor)return undefined;
  const origin=readOriginalAdministrativeBirth(sourceSha);assert(origin?.originSha256===originSha256);
  const descriptors=scanFullProcDescriptors(anchor,target,budget);
  const controls=new Set([FullBackingExposure.ProcDescriptor,FullBackingExposure.NamespaceDescriptor,FullBackingExposure.SocketDescriptor]);
  let material=[...descriptors.exposures].some(kind=>kind!==FullBackingExposure.PrivilegeCandidate && !controls.has(kind));
  const unresolved=new Set<FullBackingExposure>();
  for(const row of descriptors.joins){
    const kind=row.exposure as FullBackingExposure;if(!controls.has(kind))continue;
    let metadata=false;
    if(kind===FullBackingExposure.ProcDescriptor){
      assert(typeof row.fd==="string" && typeof row.flags==="string");
      const fd=openSync(anchor.path+"/fd/"+row.fd,0x200000);
      try{const actual=fstatSync(fd,{bigint:true});assert(same(identity(actual),{dev:String(row.dev),ino:String(row.ino)}));
        assert.equal(fullRetainedFilesystemType(fd),0x9fa0n);
        const flags=BigInt("0o"+row.flags);
        metadata=actual.isFile() && (flags&3n)===0n && ["stat","status"].some(name=>same(identity(statSync(anchor.path+"/"+name,{bigint:true})),identity(actual)));
        if(!metadata && actual.isFile() && (flags&3n)===0n){
          const processFd=openSync("/proc/"+anchor.processPid,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
          try{const prefix=`/proc/self/fd/${processFd}`;assert(same(identity(fstatSync(processFd,{bigint:true})),anchor.procIdentity));assert.equal(fullRetainedFilesystemType(processFd),0x9fa0n);assert.equal(birthAt(prefix,budget),anchor.processBirth);
            metadata=["stat","status"].some(name=>same(identity(statSync(prefix+"/"+name,{bigint:true})),identity(actual)));
            assert.equal(birthAt(prefix,budget),anchor.processBirth);anchor.revalidate();
          }finally{closeSync(processFd);}
        }
      }finally{closeSync(fd);}
    }
    // Only actual same-birth readonly own stat/status in the closed recipe is
    // discharged. Other controls violate this finite nondelegating layout;
    // they are unresolved routes, not automatically material image readers.
    if(!metadata)unresolved.add(kind);
  }
  for(const name of ["root","cwd","exe"]){const object=statSync(anchor.path+"/"+name,{bigint:true});
    // An implicit host root is ambient admin capability, not an open image
    // ancestor FD. A cwd at an actual image ancestor IS a concrete reference.
    material ||= same(identity(object),target.image) || (object.isBlockDevice() && String(object.rdev)===target.loopRdev) || (target.storageDevice!==null && device(object.dev)===target.storageDevice) || (name==="cwd" && target.ancestors.some(value=>same(value,identity(object))));
  }
  const mounts=fullBackingMounts(text(anchor.path+"/mountinfo",1024*1024,budget));
  material ||= target.storageDevice!==null && mounts.some(value=>value.device===target.storageDevice);
  for(const row of text(anchor.path+"/maps",1024*1024,budget).split("\n")){const match=/^[0-9a-f]+-[0-9a-f]+ [rwxps-]{4} [0-9a-f]+ ([0-9a-f]+):([0-9a-f]+) ([0-9]+)/.exec(row);if(!match)continue;
    const mappedDevice=String(BigInt("0x"+match[1]!))+":"+String(BigInt("0x"+match[2]!));
    material ||= mappedDevice===target.storageDevice || (BigInt(match[3]!)===BigInt(target.image.ino) && mappedDevice===device(BigInt(target.image.dev)));
  }
  descriptors.revalidate();anchor.revalidate();assert(readOriginalPublicAdministrativeActor(anchor,sourceSha));
  assert(readOriginalAdministrativeBirth(sourceSha)?.originSha256===originSha256);
  return Object.freeze({actor,material,unresolved:[...unresolved].sort()});
}
const administrativeBirths=new WeakMap<object,Readonly<{parent:object;sourceSha:string;originSha256:string}>>();
/** Original FULL parent captures the new installer origin before O_EXCL image
 * birth. Absence preserves the ordinary Unknown/Hold branch. */
export function captureFullAdministrativeBirth(parent:ReturnType<typeof retainCurrentFullParent>):object|undefined {
  assertRetainedCurrentFullParent(parent);parent.revalidate();
  const sourceSha=process.env.TEST_SOURCE_SHA;assert(sourceSha && /^[a-f0-9]{40}$/.test(sourceSha));
  const origin=readOriginalAdministrativeBirth(sourceSha);if(!origin)return undefined;
  parent.revalidate();const token=Object.freeze({});
  administrativeBirths.set(token,{parent,sourceSha,originSha256:origin.originSha256});return token;
}
const fullBackingTerminals=new WeakMap<object,object>();
export function assertFullBackingTerminal(parent:object,result:unknown):void {assert(result!==null && typeof result==="object" && fullBackingTerminals.get(result)===parent);}

/** Keeps the exact exclusively born image and ancestry, before formatting or boot.
* Only closeAfterTerminal releases observations after original recursive terminal
* proofs; close() refuses premature release. */
export function retainFullBackingBirth(id:string,bornFd:number,budget:()=>number, parent:ReturnType<typeof retainCurrentFullParent>,administrativeBeforeBirth?:object) {
  const administrativeOrigin=administrativeBeforeBirth?administrativeBirths.get(administrativeBeforeBirth):undefined;
  if(administrativeBeforeBirth){assert(administrativeOrigin?.parent===parent);administrativeBirths.delete(administrativeBeforeBirth);}
  const root=fullNativeOsBase+"/"+id+"/root";
  assert(fullNativeGuestRoot(id,root));
  assert(process.platform==="linux" && process.arch==="x64" && process.geteuid?.()===0);
  assertRetainedCurrentFullParent(parent);
  assert.equal(parent.unit,fullNativeUnit);
  assert.equal(readlinkSync("/proc/self/ns/user"),"user:[4026531837]");
  assert.equal(readlinkSync("/proc/self/ns/pid"),"pid:[4026531836]");
  assert.equal(text("/proc/self/uid_map",4096,budget).trim().replace(/\s+/g," "),"0 0 4294967295");
  assert.match(text("/proc/1/status",16384,budget),/^NSpid:\s+1$/m);
  assert(/^[a-f0-9]{32}$/.test(process.env.INVOCATION_ID??""));
  assert.equal(text("/proc/self/cgroup",4096,budget).trim(),"0::/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/"+fullNativeUnit);
  const owned=dirname(root),image=owned+"/readonly-data.ext4",held:{path:string;
    fd:number;
    stat:BigIntStats;
    mount:string}[]=[];
  let closed=false,selection:FullGuestSelection|undefined,loopFd:number|undefined,loopStat:BigIntStats|undefined,storageMount:Mount|undefined;
  let sealBytes:Buffer[]=[];
  let selectedProcess:ReturnType<typeof retainFullProcProcess>|undefined,selectedTask:FullProcTaskAnchor|undefined;
  const ownerNamespaces=new Map<string,{fd:number;owner:string}>();
  let qualifiedSeal:Buffer|undefined,qualificationStarted=false;
  const answeredPulses=new Set<string>();
  let guestSources:ReadonlyMap<string,string>|undefined;
  let guestUnitBirth:Readonly<Record<string,string>>|undefined;
  function liveGuestUnit():Readonly<Record<string,string>> {
    assert(selection);
    const result=spawnSync("/usr/bin/systemctl",["show",`TEST-retention-os-${id}.service`,"--property=InvocationID,ActiveState,MainPID,ControlGroup,Job"],{env:{PATH:"/usr/bin:/bin",LANG:"C",TMPDIR:fullNativeTmpDir},encoding:"utf8",timeout:2000,maxBuffer:4096});
    assert(!result.error && result.status===0 && result.signal===null);
    const values:Record<string,string>={};
    for(const line of result.stdout.trimEnd().split("\n")){const at=line.indexOf("=");assert(at>0 && !Object.hasOwn(values,line.slice(0,at)));values[line.slice(0,at)]=line.slice(at+1);}
    assert(Object.keys(values).sort().join(",")==="ActiveState,ControlGroup,InvocationID,Job,MainPID");
    assert(values.InvocationID===selection.invocationId && ["active","activating"].includes(values.ActiveState??"") && /^[1-9][0-9]*$/.test(values.MainPID??"") && values.ControlGroup==="/system.slice/TEST-retention-os-"+id+".service" && values.Job==="");
    return Object.freeze(values);
  }
  const collectorDescriptors=new Map<number,DescriptorStamp>();
  function rememberCollector(fd:number):void {assert(!collectorDescriptors.has(fd));collectorDescriptors.set(fd,descriptorStamp(fd,budget));}
  function originalCustody(source:ReadonlyMap<number,DescriptorStamp>):ReadonlyMap<number,DescriptorStamp> {
    const result=new Map(collectorDescriptors);
    for(const [fd,stamp] of result)assert.deepEqual(descriptorStamp(fd,budget),stamp);
    for(const [fd,stamp] of source){assert(!result.has(fd));assert.deepEqual(descriptorStamp(fd,budget),stamp);result.set(fd,stamp);}
    return result;
  }
  const extra:number[]=[];
  function hold(path:string,directory:boolean,mode?:bigint):number {
    budget();
    const found=held.find(entry=>entry.path===path);
    if(found){if(mode!==undefined)assert.equal(found.stat.mode&0o7777n,mode);
      return found.fd;
    }
    const parent=path==="/"?undefined:hold(dirname(path),true);
    const fd=openSync(parent===undefined?"/":`/proc/self/fd/${parent}/${basename(path)}`,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK|(directory?constants.O_DIRECTORY:0));
    try {const s=fstatSync(fd,{bigint:true}),named=lstatSync(path,{bigint:true});
      assert(s.uid===0n && s.gid===0n && !(s.mode&0o022n) && (directory?s.isDirectory():s.isFile() && s.nlink===1n));
      if(mode!==undefined)assert.equal(s.mode&0o7777n,mode);
      assert(!named.isSymbolicLink() && same(identity(s),identity(named)) && realpathSync(`/proc/self/fd/${fd}`)===path);
      rememberCollector(fd);held.push({path,fd,stat:s,mount:mountId(fd,budget)});
      return fd;
    }catch(error){collectorDescriptors.delete(fd);closeSync(fd);
      throw error;
    }
  }
  function revalidateImage(size?:bigint):void {
    assert(!closed);
    budget();
    assertRetainedCurrentFullParent(parent);
    for(const entry of held){
      const s=fstatSync(entry.fd,{bigint:true}),named=lstatSync(entry.path,{bigint:true});
      assert(!named.isSymbolicLink() && same(identity(s),identity(entry.stat)) && same(identity(named),identity(s)) && s.mode===entry.stat.mode && s.uid===entry.stat.uid && s.gid===entry.stat.gid);
      assert.equal(mountId(entry.fd,budget),entry.mount);
      const fresh=openSync(entry.path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK|(s.isDirectory()?constants.O_DIRECTORY:0));
      try{assert(same(identity(fstatSync(fresh,{bigint:true})),identity(s)) && mountId(fresh,budget)===entry.mount);}finally{closeSync(fresh);}
      if(!s.isDirectory())assert(s.nlink===1n && s.size===(entry.path===image && size!==undefined?size:entry.stat.size));
    }
  }
  function select(seen:FullGuestSelection,namespaceFds:readonly number[]):void {
    assert(!selection && namespaceFds.length===3);
    revalidateImage(6n*1024n*1024n*1024n);
    const pairPath=fullNativeLiveRoot+"/current-full-pair.json",invocationPath=fullNativeLiveRoot+"/current-full-pair-invocation.json";
    const bytes=[pairPath,invocationPath].map(path=>{const fd=hold(path,false,0o600n);return fdBytes(fd,16384,budget);});
    const pair=fullData(JSON.parse(bytes[0]!.toString()),["schemaVersion","jobId","parentUnit","parentInvocationId","guestMachineId","parentProc","guestSources","unit","fragmentSha256","root","rootDev","rootIno","machineId","bootId","sourceSha"]);
    const invocation=fullData(JSON.parse(bytes[1]!.toString()),["schemaVersion","pairSha256","parentInvocationId","unit","guestInvocationId"]);
    for(let i=0;i<bytes.length;i++)assert(Buffer.from(JSON.stringify(i===0?pair:invocation)+"\n").equals(bytes[i]!));
    assert(pair.schemaVersion===2 && pair.jobId===fullNativeJob && pair.parentUnit===fullNativeUnit && pair.parentInvocationId===process.env.INVOCATION_ID && pair.root===root && pair.unit===`TEST-retention-os-${id}.service` && pair.sourceSha===process.env.TEST_SOURCE_SHA);
    assert.equal(pair.machineId,text("/etc/machine-id",64,budget).trim());
    assert.equal(pair.bootId,text("/proc/sys/kernel/random/boot_id",64,budget).trim());
    assert(invocation.guestInvocationId===seen.invocationId);
    assert(invocation.schemaVersion===1 && invocation.pairSha256===hash(bytes[0]!) && invocation.parentInvocationId===pair.parentInvocationId && invocation.unit===pair.unit && /^[a-f0-9]{32}$/.test(String(invocation.guestInvocationId)));
    assert(seen.rootDev===pair.rootDev && seen.rootIno===pair.rootIno && (seen.group==="0::/system.slice/"+pair.unit || seen.group.startsWith("0::/system.slice/"+pair.unit+"/")));
    const fragment=hold("/run/systemd/system/"+pair.unit,false,0o644n);
    assert.equal(hash(fdBytes(fragment,16384,budget)),pair.fragmentSha256);
    for(const fd of namespaceFds){const copy=openSync(`/proc/self/fd/${fd}`,constants.O_RDONLY);
      rememberCollector(copy);extra.push(copy);
    }
    assert.equal(String(fstatSync(extra[0]!,{bigint:true}).ino),/^mnt:\[([0-9]+)\]$/.exec(seen.mnt)?.[1]);
    assert.equal(String(fstatSync(extra[1]!,{bigint:true}).ino),/^pid:\[([0-9]+)\]$/.exec(seen.pidNamespace)?.[1]);
    assert(same(identity(fstatSync(extra[2]!,{bigint:true})),{dev:seen.rootDev,ino:seen.rootIno}));
    assert(Array.isArray(pair.guestSources) && pair.guestSources.length===8);
    const sources=new Map<string,string>();
    for(const entry of pair.guestSources){const row=fullData(entry,["path","sha256"]);assert(typeof row.path==="string" && typeof row.sha256==="string" && /^[a-f0-9]{64}$/.test(row.sha256) && !sources.has(row.path));sources.set(row.path,row.sha256);}
    guestSources=sources;
    selectedProcess=retainFullProcProcess(seen.pid,budget);selectedTask=selectedProcess.retainTask(seen.pid);assert.equal(selectedTask.birth,seen.birth);
    selection=Object.freeze({...seen});
    guestUnitBirth=liveGuestUnit();
    sealBytes=bytes;
    revalidateSelection();
    const mounts=fullBackingMounts(text(`/proc/${seen.pid}/mountinfo`,1024*1024,budget));
    const matches=mounts.filter(m=>m.point===currentBackingStorage);
    assert.equal(matches.length,1);
    storageMount=matches[0]!;
    // No partition/label inference: FULL MountImages creates one whole loop FS.
    assert(/^7:[0-9]+$/.test(storageMount.device));
    const number=storageMount.device.split(":")[1]!,path="/dev/loop"+number;
    try {const named=lstatSync(path,{bigint:true});
      assert(named.isBlockDevice() && device(named.rdev)===storageMount.device);
      loopFd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);rememberCollector(loopFd);
      loopStat=fstatSync(loopFd,{bigint:true});
      assert(loopStat.isBlockDevice() && loopStat.rdev===named.rdev && loopStat.dev===named.dev && loopStat.ino===named.ino);
    }catch{if(loopFd!==undefined){collectorDescriptors.delete(loopFd);closeSync(loopFd);}
      loopFd=undefined;
      loopStat=undefined;
    }
  }
  function revalidateSelection():void {
    assert(selection);
    const s=selection;assert(selectedTask && selectedProcess && guestUnitBirth);selectedTask.revalidate();
    const unitBefore=liveGuestUnit();assert.equal(unitBefore.MainPID,guestUnitBirth.MainPID);
    const prefix=selectedTask.path;
    assert.equal(birthAt(prefix,budget),s.birth);
    assert.equal(readlinkSync(prefix+"/ns/mnt"),s.mnt);
    assert.equal(readlinkSync(prefix+"/ns/pid"),s.pidNamespace);
    assert.equal(text(prefix+"/cgroup",4096,budget).trim(),s.group);
    assert(same(identity(statSync(prefix+"/root",{bigint:true})),{dev:s.rootDev,ino:s.rootIno}));
    const status=text(prefix+"/status",16384,budget);
    assert.match(status,/^Uid:\s+0\s+0\s+0\s+0$/m);
    const ids=/^NSpid:\s+([0-9 \t]+)$/m.exec(status)?.[1]?.trim().split(/\s+/);
    assert(ids?.[0]===String(s.pid) && ids.at(-1)==="1");
    for(let i=0;i<sealBytes.length;i++)assert(boundedRead(fullNativeLiveRoot+(i===0?"/current-full-pair.json":"/current-full-pair-invocation.json"),16384,budget).equals(sealBytes[i]!));
    if(storageMount){const current=fullBackingMounts(text(prefix+"/mountinfo",1024*1024,budget)).filter(m=>m.id===storageMount!.id);
      assert.deepEqual(current,[storageMount]);
    }
    if(loopFd!==undefined && loopStat){const actual=fstatSync(loopFd,{bigint:true}),named=lstatSync("/dev/loop"+storageMount!.device.split(":")[1],{bigint:true});
      assert(actual.isBlockDevice() && actual.rdev===loopStat.rdev && same(identity(actual),identity(loopStat)) && named.rdev===actual.rdev && same(identity(named),identity(actual)));
    }
    selectedTask.revalidate();assert.deepEqual(liveGuestUnit(),unitBefore);
  }
  /** lsns2.39.3 ONS is NS_GET_USERNS+fstat, not a mountinfo flag.
   * Cache only while the exact nsfs object remains physically retained. */
  function mountOwner(pid:number,namespace:string):string {
    assert(/^mnt:\[[1-9][0-9]*\]$/.test(namespace));
    const existing=ownerNamespaces.get(namespace);
    if(existing){assert.equal(readlinkSync(`/proc/self/fd/${existing.fd}`),namespace);return existing.owner;}
    const ns=openSync(`/proc/${pid}/ns/mnt`,constants.O_RDONLY);rememberCollector(ns);
    try{
      const stat=fstatSync(ns,{bigint:true});assert.equal(fullRetainedFilesystemType(ns),0x6e736673n);
      assert.equal("mnt:["+stat.ino+"]",namespace);
      const path="/usr/bin/lsns",fd=hold(path,false,0o755n);
      assert.equal(hash(fdBytes(fd,1024*1024,budget)),"c9fe8adcfe480c47a052adcde50002c78e8fadd4d124bc337893a0f9a9e8cf3b");
      const result=spawnSync("/proc/self/fd/3",["--task",String(pid),"--type","mnt","--raw","--noheadings","--output","NS,ONS"],{cwd:"/",env:{PATH:"/usr/bin:/bin",LANG:"C",TMPDIR:fullNativeTmpDir},encoding:"utf8",timeout:2000,maxBuffer:1024,stdio:["ignore","pipe","pipe",fd]});
      assert(!result.error && result.status===0 && result.signal===null && !result.stderr);
      const row=/^([1-9][0-9]*) ([1-9][0-9]*)\n$/.exec(result.stdout);assert(row && row[1]===String(stat.ino));
      const fresh=openSync(`/proc/${pid}/ns/mnt`,constants.O_RDONLY);
      try{assert(same(identity(fstatSync(fresh,{bigint:true})),identity(stat)) && readlinkSync(`/proc/${pid}/ns/mnt`)===namespace);}finally{closeSync(fresh);}
      assert.equal(hash(fdBytes(fd,1024*1024,budget)),"c9fe8adcfe480c47a052adcde50002c78e8fadd4d124bc337893a0f9a9e8cf3b");
      ownerNamespaces.set(namespace,{fd:ns,owner:"user:["+row[2]+"]"});return "user:["+row[2]+"]";
    }catch(error){collectorDescriptors.delete(ns);closeSync(ns);throw error;}
  }
  function bootPid1(pid:number,tid:number,prefix:string,user:string,mnt:string):boolean {
    if(pid!==1 || tid!==1)return false;
    assert(user==="user:[4026531837]" && readlinkSync(prefix+"/ns/pid")==="pid:[4026531836]" && mnt==="mnt:[4026531841]");
    assert.equal(mountOwner(pid,mnt),user);
    assert.match(text(prefix+"/status",16384,budget),/^NSpid:\s+1$/m);
    assert.equal(text(prefix+"/uid_map",4096,budget).trim().replace(/\s+/g," "),"0 0 4294967295");
    const group=text(prefix+"/cgroup",4096,budget).trim().split("\n");assert(group.includes("0::/init.scope") && group.every(row=>row==="0::/init.scope" || row==="1:name=systemd:/"));
    assert.equal(text("/sys/fs/cgroup/init.scope/cgroup.procs",4096,budget),"1\n");
    const path="/usr/lib/systemd/systemd",fd=hold(path,false,0o755n),named=fstatSync(fd,{bigint:true});
    assert(named.dev===2306n && named.ino===20477772n && named.size===100816n);
    assert.equal(hash(fdBytes(fd,1024*1024,budget)),"b472aadf808bef87c0eb203056a77cb64bd268b71b756306013a53de68a94173");
    // Intentional real proc exe_file lookup; limited to trusted boot PID1.
    const exe=openSync(prefix+"/exe",constants.O_RDONLY);
    try{assert(same(identity(fstatSync(exe,{bigint:true})),identity(named)) && readlinkSync(prefix+"/exe")===path);}finally{closeSync(exe);}
    return true;
  }
  /** Finite original ROOT guest callgraph. Arbitrary guest ROOT programs,
   * descendants and helper names never inherit this designation. Its complete
   * source/ELF closure was held by the original parent before guest submission. */
  function originalGuest(pid:number,prefix:string,user:string):boolean {
    assert(selection && guestSources);
    if(user!=="user:[4026531837]" || readlinkSync(prefix+"/ns/pid")!==selection.pidNamespace)return false;
    const group=text(prefix+"/cgroup",4096,budget).trim();if(!group.startsWith("0::/system.slice/TEST-retention-os-"+id+".service/"))return false;
    const rootStat=statSync(prefix+"/root",{bigint:true});if(!same(identity(rootStat),{dev:selection.rootDev,ino:selection.rootIno}))return false;
    const nodePath="/opt/subscription-runtime-dependency-os-TEST/toolchain/bin/node",argv=text(prefix+"/cmdline",32768,budget).split("\0");assert(argv.pop()==="");
    const exe=readlinkSync(prefix+"/exe");let script:string|undefined;
    if(exe===nodePath){
      if(argv.length===4 && argv[1]==="--experimental-strip-types" && argv[2]==="/opt/subscription-runtime-dependency-os-TEST/scripts/dependency-retention-os-test/current-full-supervisor.js" && argv[3]==="supervisor")script=argv[2];
      if(argv.length===3 && argv[1]==="/opt/subscription-runtime-dependency-os-TEST/scripts/dependency-retention-os-test/current-full-guest.js" && argv[2]==="qualify")script=argv[1];
      if(argv.length===3 && argv[1]==="/opt/subscription-runtime-dependency-os-TEST/dist/worker-codex/hosted-readonly-host-launch-cli.js" && argv[2]==="ordinary-bootstrap")script=argv[1];
      if(argv.length===2 && argv[1]==="/opt/subscription-runtime-dependency-os-TEST/dist/worker-codex/hosted-readonly-runtime-bootstrap.js")script=argv[1];
      if(!script)return false;
    }else if(exe!=="/usr/bin/dbus-daemon" || argv.join(" ")!=="/usr/bin/dbus-daemon --config-file=/etc/subscription-runtime/system-bus/bus.conf --address=systemd: --nofork --nopidfile --nosyslog")return false;
    const expected=guestSources.get(exe);if(!expected)return false;
    const kernel=openSync(prefix+"/exe",constants.O_RDONLY);
    try{const actual=hold(root+exe,false);assert(same(identity(fstatSync(kernel,{bigint:true})),identity(fstatSync(actual,{bigint:true}))) && hash(fdBytes(actual,128*1024*1024,budget))===expected);}finally{closeSync(kernel);}
    if(script){const fd=hold(root+script,false);assert.equal(hash(fdBytes(fd,128*1024*1024,budget)),guestSources.get(script));}
    return true;
  }
  function kernelUnable(pid:number,prefix:string,user:string,mnt:string,caps:readonly string[],mounts:readonly Mount[],exposures:Set<FullBackingExposure>):boolean {
    if(caps.some(cap=>BigInt("0x"+cap)!==0n) || user==="user:[4026531837]" || !/^NoNewPrivs:\s+1$/m.test(text(prefix+"/status",16384,budget)))return false;
    if(text(prefix+"/uid_map",4096,budget).trim().replace(/\s+/g," ")!=="65532 0 1" || text(prefix+"/gid_map",4096,budget).trim().replace(/\s+/g," ")!=="65532 0 1")return false;
    if(readlinkSync(`/proc/${pid}/ns/mnt`)!==mnt || readlinkSync(`/proc/${pid}/ns/user`)!==user)return false;
    if(readlinkSync(prefix+"/ns/pid")==="pid:[4026531836]")return false;
    const owner=mountOwner(pid,mnt);if(owner!=="user:[4026531837]")return false;
    // The payload has no capability in this immutable owning user namespace.
    // Payload-owned mount namespaces need a separate causal locked-birth proof;
    // current RO flags alone never discharge their remount/uncover authority.
    if([...exposures].some(kind=>kind!==FullBackingExposure.PrivilegeCandidate && kind!==FullBackingExposure.StorageMount))return false;
    const ownImage=held.find(entry=>entry.path===image)!;
    const baseMount=fullBackingMounts(text("/proc/self/mountinfo",1024*1024,budget)).find(row=>row.id===ownImage.mount);assert(baseMount);
    const relative=(baseMount.root==="/"?"":baseMount.root)+image.slice(baseMount.point==="/"?0:baseMount.point.length);
    const covers=(root:string,path:string)=>root==="/" || path===root || path.startsWith(root+"/");
    // Every actual alias that can name the image or backing storage is RO.
    // An unrelated own-job RW bind cannot reach the target outside its root.
    if(mounts.some(row=>((row.device===device(BigInt(imageIdentity.dev)) && covers(row.root,relative)) || row.device===storageMount!.device) && !row.options.includes("ro")))return false;
    for(const path of ["/run/systemd/private","/run/dbus","/var/lib/subscription-runtime-host-policy","/var/lib/subscription-runtime-full-parent-live","/run/docker.sock","/run/containerd/containerd.sock","/run/podman/podman.sock"]){
      try{const stat=statSync(prefix+"/root"+path,{bigint:true});if(stat.isSocket() || (stat.isDirectory() && (stat.mode&0o777n)!==0n))return false;}catch(error){if(!["ENOENT","EACCES"].includes((error as NodeJS.ErrnoException).code??""))throw error;}
    }
    // Private device names are not enough: refuse ANY block-device alias,
    // including symlinks to another raw path. Bounded metadata only, no device
    // is opened and no auth/environment/provider body is read.
    let deviceEntries=0;
    const harmlessLinks=new Map([["fd","/proc/self/fd"],["stdin","/proc/self/fd/0"],["stdout","/proc/self/fd/1"],["stderr","/proc/self/fd/2"],["ptmx","pts/ptmx"]]);
    function devices(path:string,depth:number):boolean {
      budget();assert(++deviceEntries<=1024 && depth<=4);
      for(const name of readdirSync(path)){assert(/^[A-Za-z0-9_.-]+$/.test(name));const child=path+"/"+name,stat=lstatSync(child,{bigint:true});
        if(stat.isBlockDevice())return false;
        if(stat.isSymbolicLink()){if(depth!==0 || harmlessLinks.get(name)!==readlinkSync(child))return false;}
        else if(stat.isDirectory() && !devices(child,depth+1))return false;
      }return true;
    }
    if(!devices(prefix+"/root/dev",0))return false;
    return true;
  }
  function loopFacts(refusals:Set<FullBackingRefusal>):Record<string,unknown>|null {
    if(loopFd===undefined || !loopStat){refusals.add(FullBackingRefusal.LoopUnavailable);
      return null;
    }
    const retained={rdev:String(loopStat.rdev),device:device(loopStat.rdev),descriptorMountId:mountId(loopFd,budget)};
    let toolVerified=false;
    try {
      const fd=hold(ioctlTool.path,false,0o755n),tool=held.find(entry=>entry.path===ioctlTool.path)!;
      assert(String(tool.stat.size)===ioctlTool.bytes && hash(fdBytes(fd,32*1024*1024,budget))===ioctlTool.sha256);
      toolVerified=true;
      const answer=spawnSync(`/proc/self/fd/4`,["--list","--noheadings","--raw","--output","MAJ:MIN,BACK-MAJ:MIN,BACK-INO,OFFSET,SIZELIMIT,RO,AUTOCLEAR","--","/proc/self/fd/3"],{env:{PATH:"/usr/bin:/bin",LANG:"C",TMPDIR:fullNativeTmpDir},cwd:"/",encoding:"utf8",timeout:2000,maxBuffer:4096,stdio:["ignore","pipe","pipe",loopFd,fd]});
      assert(!answer.error && answer.status===0 && answer.signal===null);
      const row=/^(\d+:\d+) (\d+:\d+) ([1-9][0-9]*) ([0-9]+) ([0-9]+) ([01]) ([01])\n$/.exec(answer.stdout);
      assert(row);
      assert.equal(row[1],retained.device);
      assert.equal(row[2],device(BigInt(imageIdentity.dev)));
      assert.equal(row[3],imageIdentity.ino);
      assert.equal(row[4],"0");
      assert.equal(row[5],"0");
      assert.equal(hash(fdBytes(fd,32*1024*1024,budget)),ioctlTool.sha256);
      revalidateSelection();
      return {retained,kernelBacking:{device:row[2],inode:row[3],offset:row[4],sizeLimit:row[5],readonly:row[6],autoclear:row[7]},toolSha256:ioctlTool.sha256};
    }catch{refusals.add(toolVerified?FullBackingRefusal.KernelJoinUnavailable:FullBackingRefusal.ToolUnavailable);
      return {retained};
    }
  }
  const born=fstatSync(bornFd,{bigint:true}),imageIdentity=identity(born);
  try {
    assert(born.isFile() && born.uid===0n && born.gid===0n && born.nlink===1n && (born.mode&0o7777n)===0o600n && born.size===0n);
    for(let path=owned;;path=dirname(path)){hold(path,true,path===owned || path===jobRoot?0o700n:undefined);
      if(path==="/")break;
    }
    const retained=hold(image,false,0o600n);
    assert(same(identity(fstatSync(retained,{bigint:true})),imageIdentity));
  }catch(error){for(const entry of held)closeSync(entry.fd);
    throw error;
  }
  const target=():Target=>({image:imageIdentity,ancestors:held.filter(e=>e.stat.isDirectory()).map(e=>identity(e.stat)),loopRdev:loopStat?String(loopStat.rdev):null,storageDevice:storageMount?.device??null});
  let completion:Readonly<{revalidate():void;close():void}>|undefined;
  function observe(retainForPublication=false):Record<string,unknown> {
      assert(!completion);
      const roster=retainFullProcRoster(budget),processes:ReturnType<typeof retainFullProcProcess>[]=[],anchors:FullProcTaskAnchor[]=[],views:ReturnType<typeof retainFullProcTaskView>[]=[],memberships:(()=>void)[]=[];
      let retainedDescriptors=0;
      completion=Object.freeze({revalidate(){roster.revalidate();for(const check of memberships)check();for(const view of views)view.revalidate();for(const anchor of anchors)anchor.revalidate();for(const process of processes)process.revalidate();roster.revalidate();},close(){for(const view of views)view.close();for(const anchor of anchors)anchor.close();for(const process of processes)process.close();completion=undefined;}});
      revalidateImage(6n*1024n*1024n*1024n);
      revalidateSelection();
      // Capture only the genuine private session's retained slots after its
      // source/birth/invocation rejoin. Publication repeats that original join.
      const sourceCustody=new Map(retainedCurrentFullParentDescriptors(parent).map(fd=>[fd,descriptorStamp(fd,budget)] as const));
      const refusals=new Set<FullBackingRefusal>();
      const loop=loopFacts(refusals),owners:Record<string,unknown>[]=[],unablePeers:{user:string;mnt:string}[]=[],capablePeers=new Set<string>();
      let tasks=0,descriptors=0,kernelTasks=0;
      const scanDeadline=process.hrtime.bigint()+BigInt(Math.max(0,Math.min(15000,budget()-10000)))*1000000n;
      const scanBudget=()=>{budget();
        assert(process.hrtime.bigint()<scanDeadline);
      };
      try {for(const name of numericNames("/proc",4096)){const pid=Number(name);
          let processAnchor:ReturnType<typeof retainFullProcProcess>|undefined;
          try {
            processAnchor=retainFullProcProcess(pid,scanBudget);processes.push(processAnchor);
            const taskIds=processAnchor.taskIds().sort((a,b)=>Number(a)-Number(b)),owner=processAnchor;
            memberships.push(()=>assert.deepEqual(owner.taskIds().sort((a,b)=>Number(a)-Number(b)),taskIds));
            for(const task of taskIds){const tid=Number(task);
              assert(++tasks<=16384);
              scanBudget();
              let taskAnchor:FullProcTaskAnchor|undefined;
              try {
                taskAnchor=processAnchor.retainTask(tid);anchors.push(taskAnchor);
                const start=taskAnchor.birth,prefix:string=taskAnchor.path,status=text(prefix+"/status",16384,scanBudget);
                // Only genuine kernel tasks, under the explicit trusted boot
                // kernel assumption. UID0, task names and absent exe alone do
                // not designate native user-space programs as trusted.
                if(/^Kthread:\s+1$/m.test(status)){
                  const stat=text(prefix+"/stat",4096,scanBudget),flags=stat.slice(stat.lastIndexOf(") ")+2).trim().split(/\s+/)[6];assert(flags && /^[0-9]+$/.test(flags) && (BigInt(flags)&0x200000n)!==0n);
                  assert(text(prefix+"/cmdline",4096,scanBudget)==="" && text(prefix+"/maps",1024*1024,scanBudget)==="" && readdirSync(prefix+"/fd").length===0);
                  try{readlinkSync(prefix+"/exe");assert.fail("kernel task unexpectedly has userspace exe_file");}catch(error){assert((error as NodeJS.ErrnoException).code==="ENOENT");}
                  taskAnchor.revalidate();assert.match(text(prefix+"/status",16384,scanBudget),/^Kthread:\s+1$/m);
                  memberships.push(()=>{assert.match(text(prefix+"/status",16384,budget),/^Kthread:\s+1$/m);const raw=text(prefix+"/stat",4096,budget),flags=raw.slice(raw.lastIndexOf(") ")+2).trim().split(/\s+/)[6];assert(flags && (BigInt(flags)&0x200000n)!==0n && readdirSync(prefix+"/fd").length===0);});
                  kernelTasks++;continue;
                }
                if(pid!==process.pid){const sample=retainFullProcTaskView(taskAnchor,scanBudget);views.push(sample);retainedDescriptors+=sample.count;assert(retainedDescriptors<=16384);}
                const mnt:string=readlinkSync(prefix+"/ns/mnt"),user=readlinkSync(prefix+"/ns/user");
                const descriptorSample=scanFullProcDescriptors(taskAnchor,target(),scanBudget,pid===process.pid?()=>originalCustody(sourceCustody):undefined);
                const exposures=descriptorSample.exposures,fdJoins=descriptorSample.joins;
                descriptors+=descriptorSample.count;assert(descriptors<=131072);
                if(pid===process.pid)memberships.push(()=>descriptorSample.revalidate());
                const mounts=fullBackingMounts(text(prefix+"/mountinfo",1024*1024,scanBudget));
                if(mounts.some(m=>m.device===storageMount!.device))exposures.add(FullBackingExposure.StorageMount);
                const maps=text(prefix+"/maps",1024*1024,scanBudget);
                for(const row of maps.split("\n")){const match=/^[0-9a-f]+-[0-9a-f]+ [rwxps-]{4} [0-9a-f]+ ([0-9a-f]+):([0-9a-f]+) ([0-9]+)/.exec(row);
                  if(match && String(BigInt("0x"+match[1]!))+":"+String(BigInt("0x"+match[2]!))===storageMount!.device)exposures.add(FullBackingExposure.StorageMap);
                  if(match && BigInt(match[3]!)===BigInt(imageIdentity.ino) && String(BigInt("0x"+match[1]!))+":"+String(BigInt("0x"+match[2]!))===device(BigInt(imageIdentity.dev)))exposures.add(FullBackingExposure.ImageMap);
                }
                const uids=/^Uid:\s+([0-9 \t]+)$/m.exec(status)?.[1]?.trim().split(/\s+/);
                assert(uids?.length===4);
                const caps=["Inh","Prm","Eff","Bnd","Amb"].map(set=>{const value=new RegExp("^Cap"+set+":\\s+([0-9a-f]+)$","m").exec(status)?.[1];assert(value);return value;});
                const hostStorageCapabilities=[0n,1n,2n,3n,6n,7n,8n,18n,19n,21n,27n].reduce((mask,bit)=>mask|(1n<<bit),0n);
                const initialNamespaceCapabilities=user==="user:[4026531837]" && [caps[1]!,caps[2]!,caps[4]!].some(value=>(BigInt("0x"+value)&hostStorageCapabilities)!==0n);
                if(uids[3]==="0" || initialNamespaceCapabilities)exposures.add(FullBackingExposure.PrivilegeCandidate);
                const uidMap=text(prefix+"/uid_map",4096,scanBudget).trim().replace(/\s+/g," ");
                if(caps.some(cap=>BigInt("0x"+cap)!==0n))capablePeers.add(user);
                taskAnchor.revalidate();
                assert.equal(readlinkSync(prefix+"/ns/mnt"),mnt);
                assert.equal(readlinkSync(prefix+"/ns/user"),user);
                const relevant=[...exposures].some(kind=>kind!==FullBackingExposure.SocketDescriptor && kind!==FullBackingExposure.NamespaceDescriptor && kind!==FullBackingExposure.ProcDescriptor);
                // Generic peer/control handles alone do not enroll unrelated
                // nonprivileged host actors. For every actual target/privilege
                // candidate, ALL such inherited routes remain veto checks.
                if(relevant){assert(owners.length<256);
                  const original=pid===process.pid || (pid===selection!.pid && tid===pid) || originalGuest(pid,prefix,user);
                  const unable=!original && kernelUnable(pid,prefix,user,mnt,caps,mounts,exposures);
                  const os=!original && !unable && bootPid1(pid,tid,prefix,user,mnt);
                  let administrator=false;
                  if(!original && !unable && !os && administrativeOrigin){
                    const disposition=readOriginalAdministrativeTaskReferences(taskAnchor,administrativeOrigin.sourceSha,administrativeOrigin.originSha256,target(),scanBudget);
                    administrator=disposition!==undefined;
                    if(administrator){
                      if(disposition!.material || [...exposures].some(value=>![FullBackingExposure.PrivilegeCandidate,FullBackingExposure.ProcDescriptor,FullBackingExposure.NamespaceDescriptor,FullBackingExposure.SocketDescriptor].includes(value)))refusals.add(FullBackingRefusal.AdministrativeReference);
                      if(disposition!.unresolved.length>0)refusals.add(FullBackingRefusal.AdministrativeControlUncertain);
                      const anchored=taskAnchor;memberships.push(()=>{
                        assert(readOriginalPublicAdministrativeActor(anchored,administrativeOrigin.sourceSha));
                        const origin=readOriginalAdministrativeBirth(administrativeOrigin.sourceSha);assert(origin?.originSha256===administrativeOrigin.originSha256);
                      });
                    }
                  }
                  const classification=administrator?FullBackingOwner.EstablishedTrustedAdministrator:original?FullBackingOwner.OriginalTrustedSetup:unable?FullBackingOwner.KernelUnable:os?FullBackingOwner.BootPid1:FullBackingOwner.Unknown;
                  taskAnchor.revalidate();
                  assert.equal(readlinkSync(prefix+"/ns/mnt"),mnt);assert.equal(readlinkSync(prefix+"/ns/user"),user);
                  const afterStatus=text(prefix+"/status",16384,scanBudget);
                  for(const field of ["Uid","Gid","NoNewPrivs","CapInh","CapPrm","CapEff","CapBnd","CapAmb"])assert.equal(new RegExp("^"+field+":(.*)$","m").exec(afterStatus)?.[1],new RegExp("^"+field+":(.*)$","m").exec(status)?.[1]);
                  if(unable)unablePeers.push({user,mnt});
                  if(classification===FullBackingOwner.Unknown)refusals.add(FullBackingRefusal.OwnerUnclassified);
                  owners.push({pid,tid,birth:start,procIdentity:taskAnchor.procIdentity,taskIdentity:taskAnchor.taskIdentity,mountNamespace:mnt,userNamespace:user,uidMap,uids,capabilities:caps,noNewPrivileges:/^NoNewPrivs:\s+([01])$/m.exec(status)?.[1]??null,exposures:[...exposures].sort(),fdJoins,classification});
                }
              }catch{refusals.add(FullBackingRefusal.ProcUncertain);
              }finally{/* Retain every sampled foreign object through completion/publication. */}
            }
            processAnchor.revalidate();
          }catch{refusals.add(FullBackingRefusal.ProcUncertain);}
          finally{/* Process membership anchors close only with the completed sample. */}
      }}catch{refusals.add(FullBackingRefusal.Bound);
      }
      try{completion.revalidate();}catch{refusals.add(FullBackingRefusal.ProcUncertain);}
      if(unablePeers.some(peer=>capablePeers.has(peer.user)))refusals.add(FullBackingRefusal.OwnerUnclassified);
      revalidateImage(6n*1024n*1024n*1024n);
      revalidateSelection();
      const afterLoop=loopFacts(refusals);
      if(JSON.stringify(afterLoop)!==JSON.stringify(loop))refusals.add(FullBackingRefusal.KernelJoinUnavailable);
      const result={schemaVersion:1,purpose:"TEST_backing_facts_only_no_exclusion_authority",pairSha256:hash(sealBytes[0]!),invocationSealSha256:hash(sealBytes[1]!),image:{...imageIdentity,bytes:String(6n*1024n*1024n*1024n),descriptorMountId:held.find(e=>e.path===image)!.mount},guest:selection,storageMount,loop,owners,observedTasks:tasks,observedKernelTasks:kernelTasks,observedDescriptors:descriptors,refusals:[...refusals].sort()};
      assert(Buffer.byteLength(JSON.stringify(result))<=256*1024);
      if(!retainForPublication)completion.close();
      return result;
  }
  return Object.freeze({
    select,
    revalidate(){revalidateImage(6n*1024n*1024n*1024n);
      if(selection)revalidateSelection();
      if(qualifiedSeal)assert(boundedRead(fullNativeLiveRoot+"/current-full-backing.json",16384,budget).equals(qualifiedSeal));
    },
    observe(){try{return observe();}finally{completion?.close();}},
    qualify(){
      assert(!qualificationStarted);qualificationStarted=true;const facts=observe(true);
      assert(Array.isArray(facts.refusals) && facts.refusals.length===0 && selection && storageMount && loopStat);
      const rootFd=hold(fullNativeLiveRoot,true,0o700n);
      const data={schemaVersion:1,pairSha256:hash(sealBytes[0]!),invocationSealSha256:hash(sealBytes[1]!),guest:selection,image:imageIdentity,storageMount,storageIdentity:identity(statSync(selectedTask!.path+"/root"+currentBackingStorage,{bigint:true})),loopRdev:String(loopStat.rdev),factsSha256:hash(Buffer.from(JSON.stringify(facts)+"\n"))};
      const bytes=Buffer.from(JSON.stringify(data)+"\n"),pending=`/proc/self/fd/${rootFd}/current-full-backing.pending`,final=`/proc/self/fd/${rootFd}/current-full-backing.json`;
      const fd=openSync(pending,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
      try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}
      // Complete all causal joins before the once-only, no-overwrite link.
      revalidateImage(6n*1024n*1024n*1024n);revalidateSelection();
      assert(completion);completion.revalidate();
      linkSync(pending,final);unlinkSync(pending);fsyncSync(rootFd);qualifiedSeal=bytes;completion.close();return facts;
    },
    pulse(requestPath:string){
      assert(qualifiedSeal && selection);
      const prefix=fullNativeOsBase+"/"+id+"/policy-request-outbox/current-full-pulses/";
      assert(requestPath.startsWith(prefix) && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.json$/.test(requestPath.slice(prefix.length)));
      if(answeredPulses.has(requestPath))return;assert(answeredPulses.size<256);
      const bytes=fdBytes(hold(requestPath,false,0o600n),4096,budget),request=fullData(JSON.parse(bytes.toString("utf8")),["schemaVersion","nonce","parentInvocationId","pairSha256","invocationSealSha256","backingSha256"]);
      assert(Buffer.from(JSON.stringify(request)+"\n").equals(bytes) && request.schemaVersion===1 && request.nonce===requestPath.slice(prefix.length,-5) && request.parentInvocationId===process.env.INVOCATION_ID && request.pairSha256===hash(sealBytes[0]!) && request.invocationSealSha256===hash(sealBytes[1]!) && request.backingSha256===hash(qualifiedSeal));
      try{const facts=observe(true);assert(Array.isArray(facts.refusals) && facts.refusals.length===0 && completion);
        const parentFd=hold(fullNativeLiveRoot,true,0o700n),path=`/proc/self/fd/${parentFd}/current-full-pulse-${request.nonce}.json`;
        const response=Buffer.from(JSON.stringify({schemaVersion:1,nonce:request.nonce,requestSha256:hash(bytes),pairSha256:request.pairSha256,invocationSealSha256:request.invocationSealSha256,backingSha256:request.backingSha256,factsSha256:hash(Buffer.from(JSON.stringify(facts)+"\n"))})+"\n");
        revalidateImage(6n*1024n*1024n*1024n);revalidateSelection();completion.revalidate();
        const pending=path+".pending",fd=openSync(pending,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
        try{writeFileSync(fd,response);fsyncSync(fd);}finally{closeSync(fd);}
        completion.revalidate();linkSync(pending,path);unlinkSync(pending);fsyncSync(parentFd);answeredPulses.add(requestPath);
      }finally{completion?.close();}
    },
    closeAfterTerminal(){
      assert(!closed && qualifiedSeal && selection);
      parent.revalidate();revalidateImage(6n*1024n*1024n*1024n);
      const policy=root+"/var/lib/subscription-runtime-host-policy",terminalFd=hold(policy+"/current-full-terminal.json",false,0o600n),terminal=fdBytes(terminalFd,16384,budget),row=fullData(JSON.parse(terminal.toString("utf8")),["schemaVersion","sourceSha","pairSha256","invocationSealSha256","activationGeneration","epochGeneration","workspace","sourceClosed","idleClosed"]);
      assert(Buffer.from(JSON.stringify(row)+"\n").equals(terminal) && row.schemaVersion===1 && row.sourceSha===process.env.TEST_SOURCE_SHA && row.pairSha256===hash(sealBytes[0]!) && row.invocationSealSha256===hash(sealBytes[1]!));
      for(const name of ["host-activation.json","readonly-epoch.json"]){const fd=hold(policy+"/"+name,false,0o600n),bytes=fdBytes(fd,65536,budget),value:unknown=JSON.parse(bytes.toString("utf8"));
        assert(value && typeof value==="object" && "phase" in value && value.phase==="closed" && "generation" in value && value.generation===row[name==="host-activation.json"?"activationGeneration":"epochGeneration"]);
      }
      for(const reference of [row.sourceClosed,row.idleClosed]){assert(reference && typeof reference==="object" && "path" in reference && typeof reference.path==="string" && /^\/var\/lib\/subscription-runtime-host-policy\/dependency-generation-(?:source-closures\/[0-9a-f-]{36}|idle-closures\/[1-9][0-9]*-[1-9][0-9]*\/[0-9]+)\.json$/.test(reference.path) && "sha256" in reference && typeof reference.sha256==="string");assert.equal(hash(fdBytes(hold(root+reference.path,false,0o600n),65536,budget)),reference.sha256);}
      for(const directory of [policy+"/dependency-transactions",policy+"/dependency-owners"]){const fd=hold(directory,true,0o700n);assert(!readdirSync(`/proc/self/fd/${fd}`).some(name=>/\.remove\.lock$|\.close-unresolved\.json$|\.lock$|^\.pending-/.test(name)));}
      const unit=`TEST-retention-os-${id}.service`,group="/system.slice/"+unit;
      function stopped(){const result=spawnSync("/usr/bin/systemctl",["show",unit,"--property=InvocationID,ActiveState,SubState,MainPID,ControlGroup,Job"],{env:{PATH:"/usr/bin:/bin",LANG:"C",TMPDIR:fullNativeTmpDir},encoding:"utf8",timeout:2000,maxBuffer:4096});assert(!result.error && result.status===0 && result.signal===null);
        const values:Record<string,string>={};for(const line of result.stdout.trimEnd().split("\n")){const at=line.indexOf("=");assert(at>0 && !Object.hasOwn(values,line.slice(0,at)));values[line.slice(0,at)]=line.slice(at+1);}
        assert(Object.keys(values).sort().join(",")==="ActiveState,ControlGroup,InvocationID,Job,MainPID,SubState" && values.InvocationID===selection!.invocationId && ["inactive","failed"].includes(values.ActiveState??"") && values.MainPID==="0" && values.Job==="" && (values.ControlGroup===group || values.ControlGroup===""));return values;
      }
      const before=stopped();let groups=0;
      function drained(path:string,depth:number){budget();assert(++groups<=4096 && depth<=16);let names:string[];try{names=readdirSync(path);}catch(error){assert((error as NodeJS.ErrnoException).code==="ENOENT");return;}
        assert(text(path+"/cgroup.procs",65536,budget)==="" && text(path+"/cgroup.threads",65536,budget)==="");for(const name of names){assert(/^[A-Za-z0-9_.:@+-]+$/.test(name));if(lstatSync(path+"/"+name).isDirectory())drained(path+"/"+name,depth+1);}}
      drained("/sys/fs/cgroup"+group,0);assert.deepEqual(stopped(),before);
      revalidateImage(6n*1024n*1024n*1024n);parent.revalidate();assert(fdBytes(terminalFd,16384,budget).equals(terminal));
      closed=true;collectorDescriptors.clear();selectedTask?.close();selectedProcess?.close();for(const entry of held)closeSync(entry.fd);for(const fd of extra)closeSync(fd);for(const entry of ownerNamespaces.values())closeSync(entry.fd);if(loopFd!==undefined){collectorDescriptors.delete(loopFd);closeSync(loopFd);}
      const result=Object.freeze({purpose:"actual_recursive_guest_and_original_source_terminal",terminalSha256:hash(terminal),groups});fullBackingTerminals.set(result,parent);return result;
    },
    close(){assert(closed);return;}
  });
}
