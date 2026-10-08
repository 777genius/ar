/** Run only in the owned disposable Linux ROOT kernel-test profile. This file
 * never submits a production job or operates a foreign device/process. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { assertFullParentProcFiles, fullProcBirth, fullRetainedFilesystemType, type FullParentProcIdentity } from "../../src/worker-codex/hosted-full-backing-proc.js";
import { FullBackingExposure, fullBackingDescriptor, fullBackingMounts, retainFullProcProcess, retainFullProcRoster, retainFullProcTaskView, sampleFullProcDescriptors, type FullProcTaskAnchor } from "./current-full-backing-collector.js";
const script=fileURLToPath(import.meta.url),role=process.argv[2];
function run(file:string,args:readonly string[]):string {
  const result=spawnSync(file,[...args],{cwd:"/",env:{PATH:"/usr/bin:/bin",LANG:"C",TMPDIR:process.env.TMPDIR},encoding:"utf8",timeout:10000,maxBuffer:4096,stdio:["ignore","pipe","pipe"]});
  assert(!result.error && result.status===0 && result.signal===null);return result.stdout;
}
function denied(action:()=>unknown):void {assert.throws(action,(error:unknown)=>["EPERM","EACCES","EROFS","ENOENT"].includes((error as NodeJS.ErrnoException).code??""));}
if(role==="--TEST-full-task-view-child") {
  const path=process.argv[3];assert(path && process.send);let fd:number|undefined;
  process.send("TEST-view-ready");process.on("message",message=>{
    if(message==="TEST-new-target-fd"){assert(fd===undefined);fd=openSync(path,constants.O_RDONLY);process.send?.("TEST-target-fd-open");}
    else if(message==="TEST-exit"){if(fd!==undefined)closeSync(fd);process.exit(0);}
    else assert.fail("unknown TEST message");
  });process.once("disconnect",()=>process.exit(0));
} else if(role==="--TEST-full-proc-live-child") {
  assert(process.send);process.send("TEST-live");process.once("message",message=>{assert.equal(message,"TEST-exit");process.exit(0);});process.once("disconnect",()=>process.exit(0));
} else if(role==="--TEST-full-mapped-mount-probe") {
  const root=process.argv[3];assert(root && /^\/.*\/TEST-full-interval-[A-Za-z0-9]+$/.test(root));
  assert.equal(run("/usr/bin/id",["-u"]).trim(),"65532");
  assert.equal(readFileSync("/proc/self/uid_map","utf8").trim().replace(/\s+/g," "),"65532 0 1");
  const status=readFileSync("/proc/self/status","utf8");assert(BigInt("0x"+(/^CapEff:\s+([0-9a-f]+)$/m.exec(status)?.[1]??"0"))&(1n<<21n));
  // This probe deliberately retains child CAP_SYS_ADMIN. Failures therefore
  // distinguish inherited kernel mount locks from a mere cap0 permission error.
  for(const path of [root+"/view",root+"/private",root+"/control"]){
    assert.notEqual(spawnSync("/usr/bin/mount",["-o","remount,bind,rw",path],{stdio:"ignore"}).status,0);
    assert.notEqual(spawnSync("/usr/bin/umount",[path],{stdio:"ignore"}).status,0);
  }
  denied(()=>writeFileSync(root+"/view/image","changed"));
  denied(()=>writeFileSync("/proc/self/root"+root+"/view/image","changed"));
  denied(()=>openSync(root+"/view/raw",constants.O_RDONLY|constants.O_NONBLOCK));
  denied(()=>lstatSync(root+"/control/socket"));
  // Counterexample: a RO mount created by this capable namespace owner has no
  // inherited MNT_LOCK_READONLY guarantee and can actually become RW again.
  const own=root+"/scratch/unlocked";mkdirSync(own,{mode:0o700});
  run("/usr/bin/mount",["-t","tmpfs","-o","size=64k,nodev,nosuid,mode=700","TEST-unlocked",own]);
  run("/usr/bin/mount",["-o","remount,ro",own]);
  assert(fullBackingMounts(readFileSync("/proc/self/mountinfo","utf8")).find(row=>row.point===own)?.options.includes("ro"));
  run("/usr/bin/mount",["-o","remount,rw",own]);writeFileSync(own+"/writable","actual same-owner RO counterexample");
  process.stdout.write("TEST-locked-and-unlocked-observed\n");
} else if(role==="--TEST-full-retained-alias-probe") {
  const root=process.argv[3];assert(root);const stat=fstatSync(3,{bigint:true}),target={image:{dev:String(stat.dev),ino:String(stat.ino)},ancestors:[],loopRdev:null,storageDevice:null};
  assert.equal(fullBackingDescriptor(stat,target,fullRetainedFilesystemType(3)),FullBackingExposure.ImageDescriptor);
  const reopened=openSync("/proc/self/fd/3",constants.O_WRONLY);try{writeSync(reopened,"TEST-reopenable-alias",0,"utf8");}finally{closeSync(reopened);}
  // Genuine kernel namespace handle of ANY provenance cannot be silently
  // discharged just because it differs from the selected guest namespace.
  const ns=openSync("/proc/self/ns/user",constants.O_RDONLY),proc=openSync("/proc",constants.O_RDONLY|constants.O_DIRECTORY);
  try{assert.equal(fullBackingDescriptor(fstatSync(ns,{bigint:true}),target,fullRetainedFilesystemType(ns)),FullBackingExposure.NamespaceDescriptor);
    assert.equal(fullBackingDescriptor(fstatSync(proc,{bigint:true}),target,fullRetainedFilesystemType(proc)),FullBackingExposure.ProcDescriptor);
  }finally{closeSync(ns);closeSync(proc);}
  process.stdout.write("TEST-retained-alias-exposure-observed\n");
} else if(role==="--TEST-full-kernel-setup") {
  assert.equal(process.geteuid?.(),0);const root=process.argv[3];assert(root && realpathSync(root)===root && /^\/.*\/TEST-full-interval-[A-Za-z0-9]+$/.test(root));
  run("/usr/bin/mount",["-t","tmpfs","-o","size=16m,nodev,nosuid,mode=700","TEST-full-interval",root]);
  for(const name of ["private","view","control","scratch","binds"])mkdirSync(root+"/"+name,{mode:0o700});
  writeFileSync(root+"/private/image","TEST-original-image",{flag:"wx",mode:0o600});
  // A private disposable node on nodev tmpfs. No foreign loop is opened/written.
  run("/usr/bin/mknod",[root+"/private/raw","b","7","0"]);
  const inherited=openSync(root+"/private/image",constants.O_RDONLY);
  const server=createServer();server.listen(root+"/control/socket");await once(server,"listening");
  const socket=openSync("/proc/self/ns/mnt",constants.O_RDONLY);
  try {
    const target={image:{dev:"0",ino:"0"},ancestors:[],loopRdev:null,storageDevice:null};
    const socketPath=root+"/control/socket";assert.equal(fullBackingDescriptor(lstatSync(socketPath,{bigint:true}),target),FullBackingExposure.SocketDescriptor);
    run("/usr/bin/mount",["--bind",root+"/private",root+"/view"]);run("/usr/bin/mount",["--bind",root+"/private",root+"/private"]);
    for(const name of ["view","private"])run("/usr/bin/mount",["-o","remount,bind,ro",root+"/"+name]);
    run("/usr/bin/mount",["-t","tmpfs","-o","size=64k,nodev,nosuid,mode=000","TEST-control-denied",root+"/control"]);
    const prefix=["--user","--map-user=65532","--map-group=65532","--keep-caps","--mount","--pid","--fork","--mount-proc","--kill-child=SIGKILL","--",process.execPath,script];
    assert.equal(run("/usr/bin/unshare",[...prefix,"--TEST-full-mapped-mount-probe",root]),"TEST-locked-and-unlocked-observed\n");
    const alias=spawnSync("/usr/bin/unshare",[...prefix,"--TEST-full-retained-alias-probe",root],{cwd:"/",env:{PATH:"/usr/bin:/bin",LANG:"C",TMPDIR:root+"/scratch"},encoding:"utf8",timeout:10000,maxBuffer:4096,stdio:["ignore","pipe","pipe",inherited]});
    assert(!alias.error && alias.status===0 && alias.signal===null && alias.stdout==="TEST-retained-alias-exposure-observed\n");
    assert(readFileSync(inherited,"utf8").startsWith("TEST-reopenable-alias"));
    const child=spawn("/usr/bin/setpriv",["--no-new-privs",process.execPath,script,"--TEST-full-proc-live-child"],{cwd:"/",env:{PATH:"/usr/bin:/bin",LANG:"C",TMPDIR:root+"/scratch"},stdio:["ignore","ignore","ignore","ipc"]});
    try {
      const [ready]=await once(child,"message",{signal:AbortSignal.timeout(5000)});assert.equal(ready,"TEST-live");assert(child.pid);
      const paths=["stat","status"].map(name=>{const path=root+"/binds/"+name;writeFileSync(path,"",{flag:"wx",mode:0o600});run("/usr/bin/mount",["--bind",`/proc/${child.pid}/${name}`,path]);run("/usr/bin/mount",["-o","remount,bind,ro",path]);return path;});
      const caps=["Inh","Prm","Eff","Bnd","Amb"].map(name=>{const value=new RegExp("^Cap"+name+":\\s+([0-9a-f]{16})$","m").exec(readFileSync(paths[1]!,"utf8"))?.[1];assert(value);return value;});
      const identity=(path:string)=>{const stat=lstatSync(path,{bigint:true});return {dev:String(stat.dev),ino:String(stat.ino)};};
      const expected:FullParentProcIdentity={pid:child.pid,startTicks:fullProcBirth(readFileSync(paths[0]!,"utf8")).startTicks,stat:identity(paths[0]!),status:identity(paths[1]!),capabilities:caps};
      assertFullParentProcFiles(paths[0]!,paths[1]!,expected);
      assert.throws(()=>assertFullParentProcFiles(paths[0]!,paths[1]!,{...expected,startTicks:String(BigInt(expected.startTicks)+1n)}));
      const copies=paths.map((path,index)=>{const copy=root+"/scratch/copy-"+index;writeFileSync(copy,readFileSync(path),{flag:"wx",mode:0o600});return copy;});
      assert.throws(()=>assertFullParentProcFiles(copies[0]!,copies[1]!,{...expected,stat:identity(copies[0]!),status:identity(copies[1]!)}));
      const exited=once(child,"exit",{signal:AbortSignal.timeout(5000)});child.send("TEST-exit");const [code,signal]=await exited;assert.equal(code,0);assert.equal(signal,null);
      assert.throws(()=>assertFullParentProcFiles(paths[0]!,paths[1]!,expected));
    }finally{if(child.connected)child.disconnect();}
  } finally {closeSync(socket);closeSync(inherited);await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
  process.stdout.write("TEST-full-kernel-interval-complete\n");
} else {
  test("retained magiclink filesystem query follows the actual namespace object",{skip:process.platform!=="linux"},()=>{
    const proc=openSync("/proc/self/stat",constants.O_RDONLY|constants.O_NOFOLLOW),namespace=openSync("/proc/self/ns/mnt",constants.O_RDONLY);
    try {
      assert.equal(fullRetainedFilesystemType(proc),0x9fa0n);
      // Querying the ambient proc directory instead of the retained target
      // would incorrectly return procMagic here, rather than real nsfs.
      assert.equal(fullRetainedFilesystemType(namespace),0x6e736673n);
    }finally{closeSync(namespace);closeSync(proc);}
    assert.throws(()=>fullRetainedFilesystemType(proc));
  });
  test("completion refuses a real new process and inherited target FD after first sample",{skip:process.platform!=="linux",timeout:15000},async()=>{
    const scratch=process.env.TMPDIR;assert(scratch && realpathSync(scratch)===scratch);
    const directory=mkdtempSync(join(scratch,"TEST-full-census-")),target=directory+"/image";writeFileSync(target,"TEST-own-image",{flag:"wx",mode:0o600});
    const roster=retainFullProcRoster(()=>{}),child=spawn(process.execPath,[script,"--TEST-full-task-view-child",target],{cwd:"/",env:{PATH:"/usr/bin:/bin",LANG:"C",TMPDIR:scratch},stdio:["ignore","ignore","ignore","ipc"]});
    let anchor:ReturnType<typeof retainFullProcProcess>|undefined,task:FullProcTaskAnchor|undefined,view:ReturnType<typeof retainFullProcTaskView>|undefined;
    try{
      const [ready]=await once(child,"message",{signal:AbortSignal.timeout(5000)});assert.equal(ready,"TEST-view-ready");assert(child.pid);
      assert.throws(()=>roster.revalidate()); // The new actual PID was absent at first inventory.
      anchor=retainFullProcProcess(child.pid,()=>{});const ownedTask=anchor.retainTask(child.pid);task=ownedTask;view=retainFullProcTaskView(ownedTask,()=>{});view.revalidate();
      const changed=once(child,"message",{signal:AbortSignal.timeout(5000)});child.send("TEST-new-target-fd");assert.equal((await changed)[0],"TEST-target-fd-open");
      assert.throws(()=>view!.revalidate()); // Real FD acquisition, not mocked input or source text.
      const exit=once(child,"exit",{signal:AbortSignal.timeout(5000)});child.send("TEST-exit");assert.equal((await exit)[0],0);
      assert.throws(()=>ownedTask.revalidate());
    }finally{view?.close();task?.close();anchor?.close();if(child.connected)child.disconnect();if(child.exitCode===null)await once(child,"exit",{signal:AbortSignal.timeout(5000)});rmSync(directory,{recursive:true});}
  });
  test("own retained proc custody exceeds 32 without hiding an unexpected or reused FD",{skip:process.platform!=="linux",timeout:15000},()=>{
    const scratch=process.env.TMPDIR;assert(scratch && realpathSync(scratch)===scratch);
    const directory=mkdtempSync(join(scratch,"TEST-full-self-census-")),image=directory+"/image";
    writeFileSync(image,"TEST-own-image",{flag:"wx",mode:0o600});const stat=lstatSync(image,{bigint:true});
    const target={image:{dev:String(stat.dev),ino:String(stat.ino)},ancestors:[],loopRdev:null,storageDevice:null};
    const owners:ReturnType<typeof retainFullProcProcess>[]=[],tasks:FullProcTaskAnchor[]=[];
    let unexpected:number|undefined,reused:number|undefined;
    try {
      // Ten actual process anchors retain forty real proc descriptors. R2's
      // ordinary self census fails its 32-join bound before classification.
      for(let i=0;i<10;i++){const owner=retainFullProcProcess(process.pid,()=>{});owners.push(owner);tasks.push(owner.retainTask(process.pid));}
      const self=tasks[0]!;const clean=sampleFullProcDescriptors(self,target,()=>{});
      assert(clean.custody>=40);assert(!clean.exposures.has(FullBackingExposure.ProcDescriptor));clean.revalidate();
      unexpected=openSync(image,constants.O_RDONLY);
      const exposed=sampleFullProcDescriptors(self,target,()=>{});
      assert(exposed.exposures.has(FullBackingExposure.ImageDescriptor));assert(exposed.joins.some(row=>row.fd===String(unexpected)));
      assert.throws(()=>clean.revalidate()); // A real new unregistered target slot.
      closeSync(unexpected);unexpected=undefined;
      const last=tasks.pop()!;const slot=Number(last.path.slice(last.path.lastIndexOf("/")+1));last.close();
      reused=openSync("/proc/self/stat",constants.O_RDONLY|constants.O_NOFOLLOW);
      assert.equal(reused,slot); // Linux allocates the just-closed lowest slot.
      const afterClose=sampleFullProcDescriptors(self,target,()=>{});
      assert(afterClose.exposures.has(FullBackingExposure.ProcDescriptor));assert(afterClose.joins.some(row=>row.fd===String(reused)));
      assert.throws(()=>clean.revalidate()); // Old ownership cannot follow reuse.
    }finally{if(reused!==undefined)closeSync(reused);if(unexpected!==undefined)closeSync(unexpected);for(const task of tasks)task.close();for(const owner of owners)owner.close();rmSync(directory,{recursive:true});}
  });
  test("actual mapped-root remount/uncover/device/control/proc aliases and live-to-dead individual binds",{skip:process.env.TEST_FULL_KERNEL_PROFILE!=="root-mapped",timeout:45000},()=>{
    assert.equal(process.platform,"linux");assert.equal(process.geteuid?.(),0);
    const scratch=process.env.TMPDIR;assert(scratch && scratch.startsWith("/srv/workers/") && realpathSync(scratch)===scratch);
    const s=lstatSync(scratch);assert(s.isDirectory() && s.uid===0 && !(s.mode&0o022));
    const directory=mkdtempSync(join(scratch,"TEST-full-interval-"));
    try {
      // Owned new mount/PID namespaces prevent host propagation. Foreground
      // subprocess and kill-child lifetime retain finite process ownership.
      const result=spawnSync("/usr/bin/unshare",["--mount","--pid","--fork","--mount-proc","--propagation=private","--kill-child=SIGKILL","--",process.execPath,script,"--TEST-full-kernel-setup",directory],{cwd:"/",env:{PATH:"/usr/bin:/bin",LANG:"C",TMPDIR:scratch},encoding:"utf8",timeout:35000,maxBuffer:8192,stdio:["ignore","pipe","pipe"]});
      assert(!result.error && result.status===0 && result.signal===null);assert.equal(result.stdout,"TEST-full-kernel-interval-complete\n");
    } finally {assert.equal(realpathSync(directory),directory);assert.equal(lstatSync(directory).dev,s.dev);rmSync(directory,{recursive:true});}
  });
}
