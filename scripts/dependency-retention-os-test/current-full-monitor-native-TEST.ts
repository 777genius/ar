/** Actual original FULL flow only. No synthetic administrative/setup role. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fullData, fullNativeTmpDir, readOriginalFullMonitorTask, assertRetainedCurrentFullParent, type FullParentSession } from "../../host-integration/managed-launcher/dependency-full-native-TEST.js";
import { FullBackingOwner, FullBackingExposure, retainFullProcProcess, type retainFullBackingBirth } from "./current-full-backing-collector.js";

/** This fails on the old collector: its HOST nspawn MainPID is Unknown because
 * the guest-root predicate cannot accept a HOST monitor. Existing unrelated
 * HOST refusals remain in the facts and are not converted into a FULL grant. */
export function assertOriginalFullMonitorNativeObservation(parent:FullParentSession,id:string,facts:ReturnType<ReturnType<typeof retainFullBackingBirth>["observe"]>):Readonly<{purpose:string;monitorPid:number;monitorBirth:string;invocationId:string;retainedDescriptorReferences:number}> {
  assertRetainedCurrentFullParent(parent);assert.match(id,/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  const unit="TEST-retention-os-"+id+".service";
  const show=()=>{
    const result=spawnSync("/usr/bin/systemctl",["show",unit,"--property=MainPID,InvocationID,ActiveState,SubState"],
      {cwd:"/",env:{PATH:"/usr/bin:/bin",LANG:"C",TMPDIR:fullNativeTmpDir},encoding:"utf8",timeout:2000,maxBuffer:4096});
    assert(!result.error && result.status===0 && result.signal===null);const values:Record<string,string>={};
    for(const line of result.stdout.trimEnd().split("\n")){const at=line.indexOf("=");assert(at>0 && !Object.hasOwn(values,line.slice(0,at)));values[line.slice(0,at)]=line.slice(at+1);}
    assert(Object.keys(values).sort().join(",")==="ActiveState,InvocationID,MainPID,SubState" && values.ActiveState==="active" && values.SubState==="running");
    assert.match(values.MainPID??"",/^[1-9][0-9]*$/);assert.match(values.InvocationID??"",/^[a-f0-9]{32}$/);return values;
  };
  const before=show(),processAnchor=retainFullProcProcess(Number(before.MainPID),()=>{}),task=processAnchor.retainTask(Number(before.MainPID));
  const own=retainFullProcProcess(process.pid,()=>{}),ownTask=own.retainTask(process.pid);
  try{
    const joined=readOriginalFullMonitorTask(parent,task);assert(joined && joined.invocationId===before.InvocationID);
    assert.equal(readOriginalFullMonitorTask(parent,ownTask),undefined); // Parent setup is not inherited monitor origin.
    assert.equal(readOriginalFullMonitorTask(parent,{...task,processBirth:String(BigInt(task.processBirth)+1n)}),undefined);
    assert(Array.isArray(facts.owners));const ownerRows:readonly unknown[]=facts.owners;
    const owners=ownerRows.map(value=>{
      const row=fullData(value,["pid","tid","birth","procIdentity","taskIdentity","mountNamespace","userNamespace","uidMap","uids","capabilities","noNewPrivileges","exposures","fdJoins","classification"]);
      assert(typeof row.pid==="number" && Number.isSafeInteger(row.pid) && row.pid>0 &&
        typeof row.tid==="number" && Number.isSafeInteger(row.tid) && row.tid>0);
      assert(typeof row.birth==="string" && /^[1-9][0-9]*$/.test(row.birth) && typeof row.classification==="string");
      return row;
    }).filter(row=>row.pid===joined.pid && row.tid===joined.pid);
    assert(owners.length>0);
    let references=0;
    for(const row of owners){
      assert(row.birth===joined.birth && row.classification===FullBackingOwner.OriginalTrustedSetup && Array.isArray(row.fdJoins));
      assert(Array.isArray(row.exposures) && row.exposures.includes(FullBackingExposure.PrivilegeCandidate) && row.exposures.includes(FullBackingExposure.StorageMount));
      // Original setup material refs are still reported; a class is not a
      // filter that erases native custody from final release/terminal proof.
      references+=row.fdJoins.length;
    }
    task.revalidate();assert(readOriginalFullMonitorTask(parent,task));assert.deepEqual(show(),before);assertRetainedCurrentFullParent(parent);
    return Object.freeze({purpose:"actual_FULL_original_monitor_native_regression",monitorPid:joined.pid,monitorBirth:joined.birth,invocationId:joined.invocationId,retainedDescriptorReferences:references});
  }finally{ownTask.close();own.close();task.close();processAnchor.close();}
}
