/** Fixed FULL TEST backing observations. This module issues no REVIEW or grant. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readlinkSync, readSync, realpathSync, statSync, type BigIntStats } from "node:fs";
import { basename, dirname } from "node:path";
import { fullData, fullNativeGuestRoot, fullNativeJob, fullNativeOsBase, fullNativeTmpDir, fullNativeUnit, type retainCurrentFullParent } from "../../host-integration/managed-launcher/dependency-full-native-TEST.js";
import { currentBackingStorage } from "./current-backing-geometry.js";

export enum FullBackingExposure {
  ImageDescriptor="image_descriptor_including_reopenable_readonly",
  LoopDescriptor="raw_loop_descriptor",
  AncestorDescriptor="image_ancestor_directory_handle",
  StorageDescriptor="same_backing_filesystem_handle",
  ImageMap="image_mapping",
  StorageMount="backing_filesystem_mount",
  NamespaceDescriptor="persistent_namespace_handle",
  PrivilegeCandidate="host_fsuid_or_initial_namespace_capability_candidate",
}
export enum FullBackingOwner {
  OriginalTrustedSetup="original_exact_TEST_setup",
  Unknown="unknown_enforcement_provenance",
}
export enum FullBackingRefusal {
  ToolUnavailable="exact_ioctl_tool_unavailable",
  LoopUnavailable="loop_device_unavailable",
  KernelJoinUnavailable="ioctl_backing_join_unavailable",
  OwnerUnclassified="relevant_owner_enforcement_unclassified",
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
export function fullBackingDescriptor(s:BigIntStats,target:Target):FullBackingExposure|null {
  const i=identity(s);
  if(s.isFile() && same(i,target.image))return FullBackingExposure.ImageDescriptor;
  if(s.isBlockDevice() && String(s.rdev)===target.loopRdev)return FullBackingExposure.LoopDescriptor;
  if(s.isDirectory() && target.ancestors.some(a=>same(a,i)))return FullBackingExposure.AncestorDescriptor;
  if(target.storageDevice!==null && device(s.dev)===target.storageDevice)return FullBackingExposure.StorageDescriptor;
  return null;
}
function birthAt(prefix:string,budget:()=>void):string {
  const raw=text(prefix+"/stat",4096,budget),end=raw.lastIndexOf(") ");
  assert(end>0);
  const result=raw.slice(end+2).trim().split(/\s+/)[19];
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

export type FullProcTaskAnchor=Readonly<{path:string;birth:string;procIdentity:Identity;taskIdentity:Identity;revalidate():void;close():void}>;

/** A proc directory descriptor refers to one kernel process object even when
 * its numeric PID is reused. This metadata adapter creates no authority. */
export function retainFullProcProcess(pid:number,budget:()=>void) {
  assert(Number.isSafeInteger(pid) && pid>0 && pid<=2147483647);
  const flags=constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW|constants.O_NONBLOCK;
  const descriptors:number[]=[],tasks=new Set<{close():void}>();
  let closed=false;
  function open(path:string):number {
    budget();
    const fd=openSync(path,flags);
    descriptors.push(fd);
    assert(fstatSync(fd,{bigint:true}).isDirectory());
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
        const fd=openSync(`/proc/self/fd/${taskDirectory}/${tid}`,flags);
        let taskClosed=false;
        try {
          const stat=fstatSync(fd,{bigint:true});assert(stat.isDirectory());
          const path=`/proc/self/fd/${fd}`,taskBirth=birthAt(path,budget);
          function current():void {
            assert(!taskClosed);revalidate();
            join(fd,stat,`/proc/self/fd/${taskDirectory}/${tid}`);
            assert.equal(birthAt(path,budget),taskBirth);
          }
          const task:FullProcTaskAnchor=Object.freeze({path,birth:taskBirth,procIdentity:identity(processStat),taskIdentity:identity(stat),revalidate:current,
            close(){if(taskClosed)return;taskClosed=true;tasks.delete(task);closeSync(fd);}});
          current();tasks.add(task);return task;
        }catch(error){closeSync(fd);throw error;}
      },
      close(){if(closed)return;for(const task of [...tasks])task.close();closed=true;for(const fd of descriptors)closeSync(fd);}
    });
  }catch(error){for(const fd of descriptors)closeSync(fd);throw error;}
}

/** Keeps the exact exclusively born image and ancestry, before formatting or boot.
* close() releases observations;
it does not attest terminal custody or cleanup. */
export function retainFullBackingBirth(id:string,bornFd:number,budget:()=>number, parent:Pick<ReturnType<typeof retainCurrentFullParent>,"unit"|"revalidate">) {
  const root=fullNativeOsBase+"/"+id+"/root";
  assert(fullNativeGuestRoot(id,root));
  assert(process.platform==="linux" && process.arch==="x64" && process.geteuid?.()===0);
  parent.revalidate();
  assert.equal(parent.unit,fullNativeUnit);
  assert.equal(readlinkSync("/proc/self/ns/user"),"user:[4026531837]");
  assert.equal(readlinkSync("/proc/self/ns/pid"),"pid:[4026531836]");
  assert.equal(text("/proc/self/uid_map",4096,budget).trim().replace(/\s+/g," "),"0 0 4294967295");
  assert.match(text("/proc/1/status",16384,budget),/^NSpid:\s+1$/m);
  assert(/^[a-f0-9]{32}$/.test(process.env.INVOCATION_ID??""));
  assert(text("/proc/self/cgroup",4096,budget).trim().endsWith("/"+fullNativeUnit));
  const owned=dirname(root),image=owned+"/readonly-data.ext4",held:{path:string;
    fd:number;
    stat:BigIntStats;
    mount:string}[]=[];
  let closed=false,selection:FullGuestSelection|undefined,loopFd:number|undefined,loopStat:BigIntStats|undefined,storageMount:Mount|undefined;
  let sealBytes:Buffer[]=[];
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
      held.push({path,fd,stat:s,mount:mountId(fd,budget)});
      return fd;
    }catch(error){closeSync(fd);
      throw error;
    }
  }
  function revalidateImage(size?:bigint):void {
    assert(!closed);
    budget();
    parent.revalidate();
    for(const entry of held){
      const s=fstatSync(entry.fd,{bigint:true}),named=lstatSync(entry.path,{bigint:true});
      assert(!named.isSymbolicLink() && same(identity(s),identity(entry.stat)) && same(identity(named),identity(s)) && s.mode===entry.stat.mode && s.uid===entry.stat.uid && s.gid===entry.stat.gid);
      assert.equal(mountId(entry.fd,budget),entry.mount);
      if(!s.isDirectory())assert(s.nlink===1n && s.size===(entry.path===image && size!==undefined?size:entry.stat.size));
    }
  }
  function select(seen:FullGuestSelection,namespaceFds:readonly number[]):void {
    assert(!selection && namespaceFds.length===3);
    revalidateImage(6n*1024n*1024n*1024n);
    const pairPath=jobRoot+"/current-full-pair.json",invocationPath=jobRoot+"/current-full-pair-invocation.json";
    const bytes=[pairPath,invocationPath].map(path=>{const fd=hold(path,false,0o600n);return fdBytes(fd,4096,budget);});
    const pair=fullData(JSON.parse(bytes[0]!.toString()),["schemaVersion","jobId","parentUnit","parentInvocationId","unit","fragmentSha256","root","rootDev","rootIno","machineId","bootId","sourceSha"]);
    const invocation=fullData(JSON.parse(bytes[1]!.toString()),["schemaVersion","pairSha256","parentInvocationId","unit","guestInvocationId"]);
    for(let i=0;i<bytes.length;i++)assert(Buffer.from(JSON.stringify(i===0?pair:invocation)+"\n").equals(bytes[i]!));
    assert(pair.schemaVersion===1 && pair.jobId===fullNativeJob && pair.parentUnit===fullNativeUnit && pair.parentInvocationId===process.env.INVOCATION_ID && pair.root===root && pair.unit===`TEST-retention-os-${id}.service` && pair.sourceSha===process.env.TEST_SOURCE_SHA);
    assert.equal(pair.machineId,text("/etc/machine-id",64,budget).trim());
    assert.equal(pair.bootId,text("/proc/sys/kernel/random/boot_id",64,budget).trim());
    assert(invocation.guestInvocationId===seen.invocationId);
    assert(invocation.schemaVersion===1 && invocation.pairSha256===hash(bytes[0]!) && invocation.parentInvocationId===pair.parentInvocationId && invocation.unit===pair.unit && /^[a-f0-9]{32}$/.test(String(invocation.guestInvocationId)));
    assert(seen.rootDev===pair.rootDev && seen.rootIno===pair.rootIno && (seen.group==="0::/system.slice/"+pair.unit || seen.group.startsWith("0::/system.slice/"+pair.unit+"/")));
    const fragment=hold("/run/systemd/system/"+pair.unit,false,0o644n);
    assert.equal(hash(fdBytes(fragment,16384,budget)),pair.fragmentSha256);
    for(const fd of namespaceFds){const copy=openSync(`/proc/self/fd/${fd}`,constants.O_RDONLY);
      extra.push(copy);
    }
    assert.equal(String(fstatSync(extra[0]!,{bigint:true}).ino),/^mnt:\[([0-9]+)\]$/.exec(seen.mnt)?.[1]);
    assert.equal(String(fstatSync(extra[1]!,{bigint:true}).ino),/^pid:\[([0-9]+)\]$/.exec(seen.pidNamespace)?.[1]);
    assert(same(identity(fstatSync(extra[2]!,{bigint:true})),{dev:seen.rootDev,ino:seen.rootIno}));
    selection=Object.freeze({...seen});
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
      loopFd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      loopStat=fstatSync(loopFd,{bigint:true});
      assert(loopStat.isBlockDevice() && loopStat.rdev===named.rdev && loopStat.dev===named.dev && loopStat.ino===named.ino);
    }catch{if(loopFd!==undefined)closeSync(loopFd);
      loopFd=undefined;
      loopStat=undefined;
    }
  }
  function revalidateSelection():void {
    assert(selection);
    const s=selection;
    assert.equal(birth(s.pid,s.pid,budget),s.birth);
    assert.equal(readlinkSync(`/proc/${s.pid}/ns/mnt`),s.mnt);
    assert.equal(readlinkSync(`/proc/${s.pid}/ns/pid`),s.pidNamespace);
    assert.equal(text(`/proc/${s.pid}/cgroup`,4096,budget).trim(),s.group);
    assert(same(identity(statSync(`/proc/${s.pid}/root`,{bigint:true})),{dev:s.rootDev,ino:s.rootIno}));
    const status=text(`/proc/${s.pid}/status`,16384,budget);
    assert.match(status,/^Uid:\s+0\s+0\s+0\s+0$/m);
    const ids=/^NSpid:\s+([0-9 \t]+)$/m.exec(status)?.[1]?.trim().split(/\s+/);
    assert(ids?.[0]===String(s.pid) && ids.at(-1)==="1");
    for(let i=0;i<sealBytes.length;i++)assert(boundedRead(jobRoot+(i===0?"/current-full-pair.json":"/current-full-pair-invocation.json"),4096,budget).equals(sealBytes[i]!));
    if(storageMount){const current=fullBackingMounts(text(`/proc/${s.pid}/mountinfo`,1024*1024,budget)).filter(m=>m.id===storageMount!.id);
      assert.deepEqual(current,[storageMount]);
    }
    if(loopFd!==undefined && loopStat){const actual=fstatSync(loopFd,{bigint:true}),named=lstatSync("/dev/loop"+storageMount!.device.split(":")[1],{bigint:true});
      assert(actual.isBlockDevice() && actual.rdev===loopStat.rdev && same(identity(actual),identity(loopStat)) && named.rdev===actual.rdev && same(identity(named),identity(actual)));
    }
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
  return Object.freeze({
    select,
    revalidate(){revalidateImage(6n*1024n*1024n*1024n);
      if(selection)revalidateSelection();
    },
    observe():Record<string,unknown> {
      revalidateImage(6n*1024n*1024n*1024n);
      revalidateSelection();
      const refusals=new Set<FullBackingRefusal>([FullBackingRefusal.ContinuityMissing]);
      const loop=loopFacts(refusals),owners:Record<string,unknown>[]=[];
      let tasks=0,descriptors=0;
      const scanDeadline=process.hrtime.bigint()+BigInt(Math.max(0,Math.min(15000,budget()-10000)))*1000000n;
      const scanBudget=()=>{budget();
        assert(process.hrtime.bigint()<scanDeadline);
      };
      try {for(const name of numericNames("/proc",4096)){const pid=Number(name);
          let processAnchor:ReturnType<typeof retainFullProcProcess>|undefined;
          try {
            processAnchor=retainFullProcProcess(pid,scanBudget);
            for(const task of processAnchor.taskIds()){const tid=Number(task);
              assert(++tasks<=16384);
              scanBudget();
              let taskAnchor:FullProcTaskAnchor|undefined;
              try {
                taskAnchor=processAnchor.retainTask(tid);
                const start=taskAnchor.birth,prefix:string=taskAnchor.path,status=text(prefix+"/status",16384,scanBudget),mnt:string=readlinkSync(prefix+"/ns/mnt"),user=readlinkSync(prefix+"/ns/user");
                const exposures=new Set<FullBackingExposure>(),fdJoins:Record<string,unknown>[]=[],fds=readdirSync(prefix+"/fd");
                assert(fds.length<=4096);
                for(const fd of fds){assert(/^[0-9]+$/.test(fd) && ++descriptors<=131072);
                  scanBudget();
                  // O_PATH retains target metadata without reading its body or
                  // inheriting the foreign description's write/access flags.
                  const path=prefix+"/fd/"+fd,metadata=openSync(path,0x200000);
                  try {
                    const first=fstatSync(metadata,{bigint:true}),kind=fullBackingDescriptor(first,target());
                    const link=readlinkSync(`/proc/self/fd/${metadata}`);
                    const namespaceHandle=link===selection!.mnt || link===selection!.pidNamespace || link===readlinkSync("/proc/1/ns/mnt");
                    if(kind)exposures.add(kind);
                    if(namespaceHandle)exposures.add(FullBackingExposure.NamespaceDescriptor);
                    if(kind || namespaceHandle){
                      assert(fdJoins.length<32);
                      const info=text(prefix+"/fdinfo/"+fd,4096,scanBudget),after=statSync(path,{bigint:true});
                      const sourceInode=/^ino:\s+([0-9]+)$/m.exec(info)?.[1],sourceMount=/^mnt_id:\s+([0-9]+)$/m.exec(info)?.[1];
                      assert(same(identity(first),identity(after)) && first.rdev===after.rdev && first.mode===after.mode);
                      assert.equal(sourceInode,String(first.ino));
                      assert.equal(sourceMount,mountId(metadata,scanBudget));
                      // Numeric source FD and ino/mount were sampled around one
                      // retained target. Transient source access flags are omitted.
                      fdJoins.push({fd,...identity(first),rdev:String(first.rdev),mode:String(first.mode),mountId:sourceMount});
                    }
                  }finally{closeSync(metadata);}
                }
                const mounts=fullBackingMounts(text(prefix+"/mountinfo",1024*1024,scanBudget));
                if(mounts.some(m=>m.device===storageMount!.device))exposures.add(FullBackingExposure.StorageMount);
                const maps=text(prefix+"/maps",1024*1024,scanBudget);
                for(const row of maps.split("\n")){const match=/^[0-9a-f]+-[0-9a-f]+ [rwxps-]{4} [0-9a-f]+ ([0-9a-f]+):([0-9a-f]+) ([0-9]+)/.exec(row);
                  if(match && BigInt(match[3]!)===BigInt(imageIdentity.ino) && String(BigInt("0x"+match[1]!))+":"+String(BigInt("0x"+match[2]!))===device(BigInt(imageIdentity.dev)))exposures.add(FullBackingExposure.ImageMap);
                }
                const uids=/^Uid:\s+([0-9 \t]+)$/m.exec(status)?.[1]?.trim().split(/\s+/);
                assert(uids?.length===4);
                const caps=["Inh","Prm","Eff","Bnd","Amb"].map(set=>{const value=new RegExp("^Cap"+set+":\\s+([0-9a-f]+)$","m").exec(status)?.[1];assert(value);return value;});
                const hostStorageCapabilities=[0n,1n,2n,3n,6n,7n,8n,18n,19n,21n,27n].reduce((mask,bit)=>mask|(1n<<bit),0n);
                const initialNamespaceCapabilities=user==="user:[4026531837]" && [caps[1]!,caps[2]!,caps[4]!].some(value=>(BigInt("0x"+value)&hostStorageCapabilities)!==0n);
                if(uids[3]==="0" || initialNamespaceCapabilities)exposures.add(FullBackingExposure.PrivilegeCandidate);
                const uidMap=text(prefix+"/uid_map",4096,scanBudget).trim().replace(/\s+/g," ");
                taskAnchor.revalidate();
                assert.equal(readlinkSync(prefix+"/ns/mnt"),mnt);
                assert.equal(readlinkSync(prefix+"/ns/user"),user);
                if(exposures.size){assert(owners.length<256);
                  const original=pid===process.pid || (pid===selection!.pid && tid===pid);
                  const classification=original?FullBackingOwner.OriginalTrustedSetup:FullBackingOwner.Unknown;
                  if(!original)refusals.add(FullBackingRefusal.OwnerUnclassified);
                  owners.push({pid,tid,birth:start,procIdentity:taskAnchor.procIdentity,taskIdentity:taskAnchor.taskIdentity,mountNamespace:mnt,userNamespace:user,uidMap,uids,capabilities:caps,noNewPrivileges:/^NoNewPrivs:\s+([01])$/m.exec(status)?.[1]??null,exposures:[...exposures].sort(),fdJoins,classification});
                }
              }catch{refusals.add(FullBackingRefusal.ProcUncertain);
              }finally{taskAnchor?.close();}
            }
            processAnchor.revalidate();
          }catch{refusals.add(FullBackingRefusal.ProcUncertain);}
          finally{processAnchor?.close();}
      }}catch{refusals.add(FullBackingRefusal.Bound);
      }
      revalidateImage(6n*1024n*1024n*1024n);
      revalidateSelection();
      const afterLoop=loopFacts(refusals);
      if(JSON.stringify(afterLoop)!==JSON.stringify(loop))refusals.add(FullBackingRefusal.KernelJoinUnavailable);
      const result={schemaVersion:1,purpose:"TEST_backing_facts_only_no_exclusion_authority",pairSha256:hash(sealBytes[0]!),invocationSealSha256:hash(sealBytes[1]!),image:{...imageIdentity,bytes:String(6n*1024n*1024n*1024n),descriptorMountId:held.find(e=>e.path===image)!.mount},guest:selection,storageMount,loop,owners,observedTasks:tasks,observedDescriptors:descriptors,refusals:[...refusals].sort()};
      assert(Buffer.byteLength(JSON.stringify(result))<=256*1024);
      return result;
    },
    close(){if(closed)return;
      closed=true;
      for(const entry of held)closeSync(entry.fd);
      for(const fd of extra)closeSync(fd);
      if(loopFd!==undefined)closeSync(loopFd);
    }
  });
}
