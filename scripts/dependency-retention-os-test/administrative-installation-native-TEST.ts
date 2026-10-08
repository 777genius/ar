/** Executed by original ROOT installation guest, after its real parent birth
* handshake. Tests one NEW administrative operation/target, never outer FULL. */
import assert from "node:assert/strict";
import {
  spawnSync
}
from "node:child_process";
import {
  closeSync, constants as C, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, symlinkSync, lstatSync, statSync, writeFileSync
}
from "node:fs";
import {
  readOriginalAdministrativeBirth, readOriginalPublicAdministrativeActor, retainOriginalAdministrativeProducer, submitPublicAdministrativeMaintenance
}
from "./current-administrative-installation.js";
import {
  FullBackingExposure, readOriginalAdministrativeTaskReferences, retainFullProcProcess, sampleFullProcDescriptors
}
from "./current-full-backing-collector.js";
const control="/srv/workers/public-intake/TEST-dependency-full-native-20261007-r1/control";
const actorUnit="subscription-runtime-installer-10000000-0000-4000-8000-9ca302fabd07.service";
const forgedUnit="TEST-administrative-forgery.service";
const image=control+"/TEST-native-backing.img";
const runtime="/opt/subscription-runtime-dependency-os-TEST",node=runtime+"/toolchain/bin/node";
const env={
  PATH:"/usr/bin:/bin",LANG:"C",LC_ALL:"C",HOME:control,TMPDIR:control
}
;
const deadline=process.hrtime.bigint()+120n*1000000000n;
function budget():void{
  assert(process.hrtime.bigint()<deadline);
}
function command(path:string,args:string[],notFound=false):string{
  budget();
  const r=spawnSync(path,args,{
    env,cwd:"/",encoding:"utf8",timeout:5000,maxBuffer:16384,stdio:["ignore","pipe","pipe"]
  }
  );
  assert(!r.error && (r.status===0 || (notFound && r.status===4)) && r.signal===null);
  return r.stdout;
}
function absent(path:string):void{
  assert(!existsSync(path));
}
function recursiveCgroupEmpty(path:string):boolean {
  budget();
  try {
    assert(lstatSync(path).isDirectory());
    if(readFileSync(path+"/cgroup.procs","utf8").trim()!=="")return false;
    const children=readdirSync(path,{withFileTypes:true}).filter(entry=>entry.isDirectory()).map(entry=>entry.name).sort();
    for(const name of children)if(!recursiveCgroupEmpty(path+"/"+name))return false;
    assert.deepEqual(readdirSync(path,{withFileTypes:true}).filter(entry=>entry.isDirectory()).map(entry=>entry.name).sort(),children);
    return readFileSync(path+"/cgroup.procs","utf8").trim()==="";
  } catch(error) {
    if((error as NodeJS.ErrnoException).code==="ENOENT")return true;
    throw error;
  }
}
async function terminal(unit:string):Promise<void>{
  for(;;){
    budget();
    const args=["show",unit,"--property=MainPID,ActiveState,Job,ControlGroup,LoadState"];
    const output=command("/usr/bin/systemctl",args,true),rows=output.trimEnd().split("\n");
    assert.equal(rows.length,5);
    assert.equal(new Set(rows.map(row=>row.slice(0,row.indexOf("=")))).size,5);
    const group="/system.slice/"+unit;
    assert(rows.includes("ControlGroup="+group) || rows.includes("ControlGroup="));
    if(rows.includes("MainPID=0") && rows.includes("Job=") && rows.some(row=>row==="ActiveState=inactive" || row==="ActiveState=failed")
      && recursiveCgroupEmpty("/sys/fs/cgroup"+group) && command("/usr/bin/systemctl",args,true)===output)return;
    await new Promise<void>(resolve=>setTimeout(resolve,50));
  }
}
export async function runAdministrativeInstallationRegression():Promise<Readonly<Record<string,unknown>>>{
  const sourceSha=process.env.TEST_SOURCE_SHA;
  assert(sourceSha);
  assert.equal(process.getuid?.(),0);
  // Original supervisor publishes actual child birth before releasing stdin.
  const ready=await new Promise<string>((resolve,reject)=>{
    let value="";const timer=setTimeout(()=>reject(new Error("original administrative producer handshake missing")),5000);
    process.stdin.on("data",(chunk:Buffer)=>{
      value+=chunk.toString("utf8");if(value.length>128)reject(new Error("unexpected administrative handshake"));
    }
    );
    process.stdin.once("end",()=>{
      clearTimeout(timer);resolve(value);
    }
    );process.stdin.resume();
  }
  );
  assert.equal(ready,"FIXED_ADMINISTRATIVE_PRODUCER_READY\n");
  absent(control+"/administrative-before.json");
  absent(control+"/administrative-origin.json");
  absent(control+"/administrative-ready.json");
  const denied=command("/usr/bin/systemd-run",["--collect","--wait","--pipe","--unit="+forgedUnit,"--service-type=exec","--property=User=0","--property=Group=0","--property=NoNewPrivileges=yes","--property=CapabilityBoundingSet=","--property=AmbientCapabilities=","--property=ProtectSystem=strict","--property=RuntimeMaxSec=5s","--property=WorkingDirectory=/","--",node,runtime+"/scripts/dependency-retention-os-test/administrative-forgery-native-TEST.js"]);
  assert.equal(denied,"DENIED_ACTUAL_NATIVE_ORIGIN\n");
  await terminal(forgedUnit);
  absent(control+"/administrative-before.json");
  absent(control+"/administrative-origin.json");
  absent(control+"/administrative-ready.json");
  const unloaded=command("/usr/bin/systemctl",["show",actorUnit,"--property=LoadState","--value"],true);
  assert.equal(unloaded.trim(),"not-found");
  submitPublicAdministrativeMaintenance(retainOriginalAdministrativeProducer());
  const before=readOriginalAdministrativeBirth(sourceSha);
  assert(before);
  const actorReady=JSON.parse(readFileSync(control+"/administrative-ready.json","utf8")) as Record<string,unknown>;
  assert.deepEqual(actorReady,{schemaVersion:1,pid:before.actor.pid,birth:before.actor.birth,invocationId:before.actor.invocationId});
  // Exclusive NEW target, after actual administrative admission/complete birth.
  const fd=openSync(image,C.O_RDWR|C.O_CREAT|C.O_EXCL|C.O_NOFOLLOW,0o600);
  writeFileSync(fd,"NEW_ADMINISTRATIVE_TEST_TARGET\n");
  const stat=fstatSync(fd,{
    bigint:true
  }
  );
  const target={
    image:{
      dev:String(stat.dev),ino:String(stat.ino)
    }
    ,ancestors:["/","/srv","/srv/workers","/srv/workers/public-intake","/srv/workers/public-intake/TEST-dependency-full-native-20261007-r1",control].map(path=>{
      const s=statSync(path,{
        bigint:true
      }
      );return {
        dev:String(s.dev),ino:String(s.ino)
      }
      ;
    }
    ),loopRdev:null,storageDevice:null
  }
  ;
  const parent=retainFullProcProcess(before.actor.pid,budget),anchors=parent.taskIds().map(tid=>parent.retainTask(Number(tid)));
  try{
    assert(anchors.length>0);
    // Actual byte copies of a live process are ordinary files, not a native
    // procfs anchor. Matching birth/content must never admit the copy.
    const copied=control+"/TEST-copied-proc";
    mkdirSync(copied,{mode:0o700});
    for(const name of ["stat","status","cgroup"])writeFileSync(copied+"/"+name,readFileSync(anchors[0]!.path+"/"+name),{flag:"wx",mode:0o400});
    for(const name of ["root","exe"])symlinkSync(anchors[0]!.path+"/"+name,copied+"/"+name);
    mkdirSync(copied+"/ns",{mode:0o700});
    for(const name of ["user","pid","mnt"])symlinkSync(readlinkSync(anchors[0]!.path+"/ns/"+name),copied+"/ns/"+name);
    const copiedIdentity=statSync(copied,{bigint:true});
    assert.throws(()=>readOriginalPublicAdministrativeActor({
      path:copied,birth:anchors[0]!.birth,processPid:before.actor.pid,processBirth:before.actor.birth,
      revalidate(){const fresh=statSync(copied,{bigint:true});assert.equal(fresh.dev,copiedIdentity.dev);assert.equal(fresh.ino,copiedIdentity.ino);}
    },sourceSha));
    for(const anchor of anchors){
      const disposition=readOriginalAdministrativeTaskReferences(anchor,sourceSha,before.originSha256,target,budget);
      assert.equal(disposition?.actor.pid,before.actor.pid);
      assert.equal(disposition?.actor.birth,before.actor.birth);
      assert.equal(disposition?.actor.invocationId,before.actor.invocationId);
      assert.equal(disposition?.material,false);
      assert.deepEqual(disposition.unresolved,[]);
    }
    writeFileSync(control+"/TEST-inspection-control-open","INSPECT_FIXED_PARENT_CONTROL\n",{
      flag:"wx",mode:0o400
    }
    );
    let unresolved=false;
    while(!unresolved){
      budget();
      for(const anchor of anchors){
        const result=readOriginalAdministrativeTaskReferences(anchor,sourceSha,before.originSha256,target,budget);
        assert(result);
        unresolved ||= result.unresolved.includes(FullBackingExposure.ProcDescriptor);
      }
      if(!unresolved)await new Promise<void>(resolve=>setTimeout(resolve,50));
    }
    assert(unresolved);
    // Actual fixed administrative inspection deliberately retains readonly
    // image FD. Every observed task must veto; readonly cannot waive exposure.
    writeFileSync(control+"/TEST-inspection-open","INSPECT_FIXED_IMAGE_READONLY\n",{
      flag:"wx",mode:0o400
    }
    );
    let material=false;
    while(!material){
      budget();
      for(const anchor of anchors){
        assert(readOriginalPublicAdministrativeActor(anchor,sourceSha));
        const sample=sampleFullProcDescriptors(anchor,target,budget);
        material||=sample.exposures.has(FullBackingExposure.ImageDescriptor);
        sample.revalidate();
        if(material)assert.equal(readOriginalAdministrativeTaskReferences(anchor,sourceSha,before.originSha256,target,budget)?.material,true);
      }
      if(!material)await new Promise<void>(resolve=>setTimeout(resolve,50));
    }
    assert(material);
    command("/usr/bin/systemctl",["stop",actorUnit]);
    await terminal(actorUnit);
    // A retained real proc inode is not a copied file and cannot survive exit
    // as a live birth. This also revokes the prior native origin read.
    for(const anchor of anchors)assert.throws(()=>anchor.revalidate());
    assert.throws(()=>readOriginalAdministrativeBirth(sourceSha));
    return Object.freeze({
      scope:"one_new_fixed_administrative_installation_actor",forgedJsFieldsDenied:true,sourceHeldBeforeExclusiveSubmit:true,actorBeforeNewTarget:true,actualBirthReadyBeforeNewTarget:true,readonlyImageFdVeto:true,actualProcControlRouteHeld:true,actualRecursiveTerminal:true,copiedProcDenied:true,deadOriginalProcDenied:true,fullReady:false
    }
    );
  }
  finally{
    for(const anchor of anchors)anchor.close();
    parent.close();
    closeSync(fd);
  }
}
