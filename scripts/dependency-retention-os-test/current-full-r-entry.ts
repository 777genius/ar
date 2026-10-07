/** Real R foreground/recovery, then current sealed DATA readback. No grant. */
import assert from "node:assert/strict";
import { HostedActivationPhase, HostedCustodyPhase, HostedCustodyReservationState, HostedCustodySupervisor } from "../../dist/worker-core/index.js";
import { assertHostedForegroundResult, readHostedForegroundLaunchObservation } from "../../dist/provider-codex/app-server/adapters/hosted-fd-launch.js";
import { withHostedActivationFence } from "../../dist/provider-codex/app-server/adapters/hosted-process-activation.js";
import { hostedDependencyOwnerRoot, readHostedDependencyBinding } from "../../dist/provider-codex/app-server/adapters/hosted-dependency-workspace.js";
import { isDependencyCustodyObject, isDependencyProtectedReference, sameDependencyProtectedReference } from "../../dist/core/dependency-environment/dependency-custody-evidence.js";
import { LocalDependencyOwnerStore } from "../../dist/store-local-file/dependency-environment/local-dependency-owner-store.js";
import { readHostedInstallationActivation } from "../../dist/worker-codex/hosted-installation-activation.js";
import { HostedReadonlySupervisorHost } from "../../dist/worker-codex/hosted-readonly-supervisor-host.js";
import { readHostedReadonlyHostInventory } from "../../dist/worker-codex/hosted-readonly-host-kernel.js";
import { runHostedRuntimeForeground } from "../../dist/worker-codex/hosted-readonly-foreground.js";
import { readHostedForegroundResultRecord } from "../../dist/worker-codex/hosted-foreground-result.js";
import { pinReferenceFile } from "../../dist/worker-codex/hosted-dependency-legacy-reference-records.js";
import { currentIdleClosureMatches } from "./current-closed-entry.js";
import { EntryObservationState, readCurrentEntryContentObservation } from "./current-entry-observations.js";
import { assertRootScope, type CurrentColdHotRoots } from "./current-cold-hot-root.js";
import { FullEntryKind } from "./current-full-entry.js";
import { currentFullEnvironment } from "./current-full-env.js";
const root="/var/lib/subscription-runtime-host-policy",encode=(v:unknown)=>Buffer.from(JSON.stringify(v)+"\n");
/** Every completed R closes custody. The SAME real supervisor must rotate,
 * fence, drain, authenticate material/FDs and release this source before Ready.
 * CLI recover is EnteringExclusive-only and is deliberately not used here. */
export async function runCurrentReadonlyEntry(roots:CurrentColdHotRoots) {
  assertRootScope(roots);assert.equal(readHostedInstallationActivation().activation.phase,HostedActivationPhase.Exclusive);
  const host=new HostedReadonlySupervisorHost(),before=host.readEpoch();
  assert.equal(before.identity.jobId,roots.readonlyJobId);assert.equal(before.identity.jobRootDir,roots.jobRoot);
  assert.equal(before.phase,HostedCustodyPhase.Ready);assert.equal(before.revoked,false);
  const launch=readHostedReadonlyHostInventory().runtimeLaunch;assert.equal(launch.cwd,roots.workspace);
  // Logical C argv/root is immutable. Genuine custody supplies actual R identity.
  const result=await runHostedRuntimeForeground(launch.command,launch.args,launch.cwd,currentFullEnvironment());
  assert(typeof result!=="number","TEST actual retained R FDA result required");assertHostedForegroundResult(result);assert.equal(result.exitCode,0);
  const native=readHostedForegroundLaunchObservation(result);assert.equal(native.closeStatus,0);
  const published=readHostedForegroundResultRecord(roots.jobRoot+"/state/TEST-result.json");
  assert.equal(published.value.status,"done");assert.equal(published.output.exitCode,0);assert.equal(published.output.unit,native.unit);
  const closed=host.readEpoch();assert.equal(closed.phase,HostedCustodyPhase.Closed);assert.equal(closed.identity.jobId,roots.readonlyJobId);
  assert.equal(closed.outerRuntime?.startId,native.startId);
  new HostedCustodySupervisor(host).recover(host.readEpoch().identity);
  const ready=host.readEpoch();assert.equal(ready.phase,HostedCustodyPhase.Ready);assert.equal(ready.revoked,false);
  assert(ready.generation>closed.generation);assert.equal(ready.outerRuntime?.startId,native.startId);
  assert.equal(ready.outerRuntime?.state,HostedCustodyReservationState.Terminal);
  assert(ready.reservations.every(row=>row.state===HostedCustodyReservationState.Terminal));
  const content=readCurrentEntryContentObservation(roots.candidateJobId,result);
  assert(content.state===EntryObservationState.Measured);assert.equal(content.startId,native.startId);assert.equal(content.invocationId,native.invocationId);
  assert.equal(content.attempted,0);assert.equal(content.completed,0);assert.equal(content.finalRoot,0);
  const providers=withHostedActivationFence(fence=>{
    // This current-revision join is measurement only; it cannot authorize IO.
    const binding=readHostedDependencyBinding(roots.candidateJobId);assert(binding && binding.version===2);
    const owners=LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384});
    let owner:ReturnType<typeof owners.read>;try{owner=owners.read(binding.workspace);}finally{owners.close();}assert(owner && owner.owner===null);
    const closure=pinReferenceFile(`${root}/dependency-generation-source-closures/${native.startId}.json`,65536),v:unknown=JSON.parse(closure.bytes.toString("utf8"));
    assert(isDependencyCustodyObject(v,"attempt,barrier,baseline,binding,identity,outer,parent,pending,providers,retirement,version") && v.version===2 && encode(v).equals(closure.bytes));
    assert(encode(v.binding).equals(encode(binding)));assert(encode(v.identity).equals(encode(ready.identity)));
    const idle=pinReferenceFile(`${root}/dependency-generation-idle-closures/${binding.workspace.dev}-${binding.workspace.ino}/${owner.revision}.json`,16384),i:unknown=JSON.parse(idle.bytes.toString("utf8"));
    assert(encode(i).equals(idle.bytes));assert(currentIdleClosureMatches(owner,binding,i,closure.reference,native.startId));
    assert(isDependencyCustodyObject(i,"attempt,binding,previousOwnerSha256,releasedOwner,releasedOwnerSha256,sourceClosed,version"));assert(encode(i.attempt).equals(encode(v.attempt)));
    assert(isDependencyCustodyObject(v.attempt,"attemptId,epoch,launch"));assert.equal(v.attempt.attemptId,content.attemptId);assert.equal(String(v.attempt.epoch),content.epoch);
    assert.equal(closure.reference.sha256,content.sourceClosedSha256);assert(Array.isArray(v.providers) && v.providers.length>0 && v.providers.length<=128);
    const selected=v.providers.map((p:unknown)=>{
      assert(isDependencyCustodyObject(p,"attempt,birth,completion,entry,material,parent,preclaim,preparation,profile,qualification,receipt,row"));
      assert(isDependencyCustodyObject(p.row,"creatorId,startId,state,unit"));assert.equal(p.row.state,HostedCustodyReservationState.Terminal);
      assert(typeof p.row.startId==="string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(p.row.startId));
      assert(encode(p.attempt).equals(encode(v.attempt)));assert(ready.reservations.some(row=>encode(row).equals(encode(p.row))));
      for(const key of ["birth","completion"] as const){const reference:unknown=p[key];assert(isDependencyProtectedReference(reference));
        const path:string=`${root}/dependency-managed-provider-${key==="birth"?"starts":"completions"}/${p.row.startId}.json`;
        assert.equal(reference.path,path);assert(sameDependencyProtectedReference(pinReferenceFile(path,16384).reference,reference));}
      assert(isDependencyProtectedReference(p.birth) && isDependencyProtectedReference(p.completion));
      return Object.freeze({startId:p.row.startId,completionSha256:p.completion.sha256,relationSha256:p.birth.sha256});
    });
    assert(encode(host.readEpoch()).equals(encode(ready)));
    assert(pinReferenceFile(closure.reference.path,65536).bytes.equals(closure.bytes));assert(pinReferenceFile(idle.reference.path,16384).bytes.equals(idle.bytes));
    return selected;
  });
  return Object.freeze({result,observation:Object.freeze({kind:FullEntryKind.Hot,startId:native.startId,attemptId:content.attemptId,
    invocationId:native.invocationId,scopeSha256:content.scopeSha256,sourceClosedSha256:content.sourceClosedSha256,
    attempted:content.attempted,completed:content.completed,finalRoot:content.finalRoot,providers:Object.freeze(providers)})});
}
