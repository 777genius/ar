import { readOriginalHostedDependencyGenerationNativeCensus } from "./hosted-dependency-generation-native-census";
import { createHash } from "node:crypto";
import { DependencyOwnerPhase, sameDependencyAttempt, sameDependencyProtectedReference, DependencyGenerationContinuityKind,
  parseDependencyGenerationContinuity, isDependencyConsumerOwner, sameDependencyTree } from "@vioxen/subscription-runtime/core";
import { markDependencyConsumerRunning } from "@vioxen/subscription-runtime/worker-core";
import { assertCurrentHostedDependencyAttempt, findOriginalHostedDependencyGenerationState, findOriginalHostedDependencyGenerationEntry,
  readOriginalHostedDependencyColdInstallerState, type CurrentHostedDependencyOrigin } from "./hosted-current-dependency-origin";
import { HostedDependencyGenerationBarrierPhase as BarrierPhase, HostedDependencySourceUsePhase } from "./hosted-dependency-generation-state";
import { HostedDependencyColdPhase, HostedDependencyColdInstallerPhase } from "./hosted-dependency-cold-materialization-state";
import { readHostedDependencyActiveActorFacts } from "./hosted-dependency-active-actor-facts";
import { assertHostedDependencyInstallerAttemptDrained } from "./hosted-dependency-installer";
import { readHostedDependencyRootDirectoryPin } from "./hosted-dependency-root-physical-facts";
import { createReadonlyPrivateRecord } from "./hosted-readonly-custody";
import { ensureHostedDependencyDirectory } from "./hosted-dependency-receipts";
import { pinReferenceFile } from "./hosted-dependency-legacy-reference-records";
import { assertHostedActivationFence, type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { readHostedDependencyCommittedReady } from "./hosted-dependency-receipts";
import { hostedDependencyOwnerRoot } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { LocalDependencyOwnerStore } from "../store-local-file/dependency-environment/local-dependency-owner-store";
import { assertHostedDependencyKeyInputsCurrent } from "./hosted-dependency-materialization-context";
import { assertDependencySourceExposureCurrent } from "../worker-local/dependency-environment/observe-dependency-tree";

const root="/var/lib/subscription-runtime-host-policy/dependency-generation-barriers";
const encode=(value:unknown)=>Buffer.from(JSON.stringify(value)+"\n");
function invalid():never {throw new Error("hosted_dependency_generation_barrier_unresolved");}
/** Every dispatch first resolves the existing original map with its lexical
 * access. No raw barrier/state/coverage setter, supplied callback or FD exists. */
export function beginOriginalHostedDependencyGenerationBarrier(context:CurrentHostedDependencyOrigin,fence:HostedActivationFence,access:symbol):void {
  const retained=findOriginalHostedDependencyGenerationEntry(context,access),actual=assertCurrentHostedDependencyAttempt(context,fence,DependencyOwnerPhase.ExclusiveMutation);
  if(!retained || retained.rootPurpose)invalid();
  if(retained.generation){assertOriginalHostedDependencyGenerationBarrier(context,fence,access);return;}
  retained.generation={phase:BarrierPhase.Pending,binding:actual.binding,attempt:actual.attempt,ownerPhase:DependencyOwnerPhase.ExclusiveMutation,
    sourceUse:{phase:HostedDependencySourceUsePhase.Capturing}};
  armOriginalHostedDependencyGenerationBarrier(context,fence,access);
}
export function armOriginalHostedDependencyGenerationBarrier(context:CurrentHostedDependencyOrigin,fence:HostedActivationFence,access:symbol):void {
  const state=findOriginalHostedDependencyGenerationState(context,access);if(!state || state.phase!==BarrierPhase.Pending || state.actors)invalid();
  const actual=assertCurrentHostedDependencyAttempt(context,fence,DependencyOwnerPhase.ExclusiveMutation);
  if(!sameDependencyAttempt(actual.attempt,state.attempt) || !encode(actual.binding).equals(encode(state.binding)))invalid();
  try {
    const actors=readHostedDependencyActiveActorFacts(fence,access);
    const after=assertCurrentHostedDependencyAttempt(context,fence,DependencyOwnerPhase.ExclusiveMutation);
    if(findOriginalHostedDependencyGenerationState(context,access)!==state || !sameDependencyAttempt(after.attempt,state.attempt) ||
        !encode(readHostedDependencyActiveActorFacts(fence,access)).equals(encode(actors)))invalid();
    if (!actors || !readOriginalHostedDependencyGenerationNativeCensus(context,fence,access)) { state.phase=BarrierPhase.Unavailable;return; }
    state.actors=actors;
    // The durable pending leaf is a denial marker for unclassified writers,
    // joined to this actual held owner. It is not a baseline/execution permit.
    const pendingRoot=root+"/pending",pendingPath=`${pendingRoot}/${state.attempt.attemptId}.json`,
      pendingBytes=encode({version:1,attempt:state.attempt,bindingSha256:createHash("sha256").update(encode(state.binding)).digest("hex"),actors});
    if(pendingBytes.length>16384)invalid();ensureHostedDependencyDirectory(pendingRoot);createReadonlyPrivateRecord(pendingPath,pendingBytes);
    const pending=pinReferenceFile(pendingPath,16384);if(!pending.bytes.equals(pendingBytes))invalid();state.pending=pending.reference;
    assertOriginalHostedDependencyGenerationBarrier(context,fence,access);
    // Pending is armed before any initial input/source capture; it is not a
    // statement that an observation or a durable baseline already exists.
    state.sourceUse.phase=HostedDependencySourceUsePhase.Capturing;
  }catch(error){state.phase=BarrierPhase.Held;state.sourceUse.phase=HostedDependencySourceUsePhase.Held;throw error;}
}
export function assertOriginalHostedDependencyGenerationBarrier(context:CurrentHostedDependencyOrigin,fence:HostedActivationFence,access:symbol):void {
  const state=findOriginalHostedDependencyGenerationState(context,access);
  if(!state || ![BarrierPhase.Pending,BarrierPhase.Unavailable,BarrierPhase.Observing,BarrierPhase.Published].includes(state.phase))invalid();
  const actual=assertCurrentHostedDependencyAttempt(context,fence,state.ownerPhase);
  if(!sameDependencyAttempt(actual.attempt,state.attempt) || !encode(actual.binding).equals(encode(state.binding)) )invalid();
  if(state.phase===BarrierPhase.Unavailable)return;
  if(!state.actors || !encode(readHostedDependencyActiveActorFacts(fence,access)).equals(encode(state.actors)))invalid();
  if(!readOriginalHostedDependencyGenerationNativeCensus(context,fence,access))invalid();
  if(!state.pending || !sameDependencyProtectedReference(pinReferenceFile(`${root}/pending/${state.attempt.attemptId}.json`,16384).reference,state.pending))invalid();
  if(state.barrier) {
    const pin=pinReferenceFile(barrierPath(state.attempt.attemptId),16384);
    if(!sameDependencyProtectedReference(pin.reference,state.barrier))invalid();
  }
  assertHostedActivationFence(fence);
  if(findOriginalHostedDependencyGenerationState(context,access)!==state)invalid();
}
/** Called after the fixed staged publication/installer drain and BEFORE its
 * final qualifying content observation. The selected physical tree is read
 * here, never supplied by an observer DTO or promoted from an old Ready. */
export function startOriginalHostedDependencyFinalObservation(context:CurrentHostedDependencyOrigin,fence:HostedActivationFence,access:symbol):void {
  const state=findOriginalHostedDependencyGenerationState(context,access);if(!state)invalid();
  assertOriginalHostedDependencyGenerationBarrier(context,fence,access);
  if(state.phase===BarrierPhase.Unavailable)return;
  if(state.phase!==BarrierPhase.Pending || state.barrier)invalid();
  const cold=readOriginalHostedDependencyColdInstallerState(context,access);
  if(cold.phase!==HostedDependencyColdPhase.Producing || cold.result || cold.installerPhase!==HostedDependencyColdInstallerPhase.Waited ||
      !cold.installerFrame || !sameDependencyAttempt(cold.attempt,state.attempt))invalid();
  assertHostedDependencyInstallerAttemptDrained(state.attempt);
  const workspace=readHostedDependencyRootDirectoryPin(state.binding.workspace.canonicalPath),
    tree=readHostedDependencyRootDirectoryPin(state.binding.workspace.canonicalPath+"/node_modules");
  if(workspace.dev!==state.binding.workspace.dev || workspace.ino!==state.binding.workspace.ino || tree.mountId!==workspace.mountId || tree.dev!==workspace.dev)invalid();
  const record={version:1,pending:state.pending,attempt:state.attempt,bindingSha256:createHash("sha256").update(encode(state.binding)).digest("hex"),
    actors:state.actors,workspace,tree};
  const bytes=encode(record);if(bytes.length>16384)invalid();
  try {
    ensureHostedDependencyDirectory(root);createReadonlyPrivateRecord(barrierPath(state.attempt.attemptId),bytes);
    const pin=pinReferenceFile(barrierPath(state.attempt.attemptId),16384);
    if(!pin.bytes.equals(bytes))invalid();state.barrier=pin.reference;
    // Temporary directory/record descriptors have all closed before the final
    // current-origin/actor/installer census. No census runs under store FDs.
    assertOriginalHostedDependencyGenerationBarrier(context,fence,access);
    assertHostedDependencyInstallerAttemptDrained(state.attempt);
    if(!encode(readHostedDependencyRootDirectoryPin(tree.canonicalPath)).equals(encode(tree)) ||
        !encode(readHostedDependencyRootDirectoryPin(workspace.canonicalPath)).equals(encode(workspace)))invalid();
    state.phase=BarrierPhase.Observing;
  }catch(error){state.phase=BarrierPhase.Held;state.sourceUse.phase=HostedDependencySourceUsePhase.Held;throw error;}
}
function barrierPath(attemptId:string):string {
  if(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.exec(attemptId)?.[0]!==attemptId)invalid();return `${root}/${attemptId}.json`;
}

/** Sole newly observed baseline publication. This selects the privately
 * retained cold result itself; no old Ready/observer/owner/proof DTO enters. */
export function publishOriginalHostedDependencyGenerationBaseline(context:CurrentHostedDependencyOrigin,fence:HostedActivationFence,access:symbol):void {
  const state=findOriginalHostedDependencyGenerationState(context,access);if(!state)invalid();
  assertOriginalHostedDependencyGenerationBarrier(context,fence,access);
  if(state.phase===BarrierPhase.Unavailable)return;
  const cold=readOriginalHostedDependencyColdInstallerState(context,access),result=cold.result;
  if(state.phase!==BarrierPhase.Observing || !state.barrier || state.baseline || !result ||
      cold.phase!==HostedDependencyColdPhase.Producing || state.sourceUse.phase!==HostedDependencySourceUsePhase.Live ||
      state.sourceUse.exposure!==result.exposure || !sameDependencyAttempt(cold.attempt,state.attempt))invalid();
  assertHostedDependencyKeyInputsCurrent(state.binding,result.inputs);
  assertDependencySourceExposureCurrent(result.exposure);
  assertHostedDependencyInstallerAttemptDrained(state.attempt);
  const committed=readHostedDependencyCommittedReady(state.binding,result.ready.revision),
    barrier=pinReferenceFile(barrierPath(state.attempt.attemptId),16384);
  const physical=readHostedDependencyRootDirectoryPin(state.binding.workspace.canonicalPath+"/node_modules");
  const recorded:unknown=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(barrier.bytes));
  if(!recorded || typeof recorded!=="object" || !("tree" in recorded) ||
      !sameDependencyProtectedReference(barrier.reference,state.barrier) ||
      !encode(recorded.tree).equals(encode(physical)) || !sameDependencyTree(physical,result.ready.tree) ||
      !sameDependencyProtectedReference(committed.reference,result.reference) || !encode(committed.receipt).equals(encode(result.ready)) ||
      result.observed.digest!==result.ready.manifestDigest || !sameDependencyTree(result.observed.tree,result.ready.tree) ||
      !encode(result.observed.measurement).equals(encode(result.ready.treeMeasurement)))invalid();
  const baselineRoot="/var/lib/subscription-runtime-host-policy/dependency-generation-baselines",
    baselinePath=`${baselineRoot}/${state.attempt.attemptId}.json`;
  const bytes=encode({version:1,attempt:state.attempt,actors:state.actors,binding:state.binding,
    barrier:state.barrier,ready:result.ready,readyReference:result.reference,
    installerMappingSha256:createHash("sha256").update(result.installerMapping).digest("hex"),
    inputClosureDigest:result.inputs.capture.closureDigest});
  if(bytes.length>65536)invalid();
  let store:LocalDependencyOwnerStore|undefined;
  try {
    ensureHostedDependencyDirectory(baselineRoot);createReadonlyPrivateRecord(baselinePath,bytes);
    const baselinePin=pinReferenceFile(baselinePath,65536);if(!baselinePin.bytes.equals(bytes))invalid();
    const slot=parseDependencyGenerationContinuity({version:1,kind:DependencyGenerationContinuityKind.BaselineAuthenticatedV1,
      operationId:state.attempt.attemptId,generation:result.ready.generation,readyRevision:result.ready.revision,
      previousReady:result.reference,baseline:baselinePin.reference,writerBarrier:state.barrier});
    if(slot.kind!==DependencyGenerationContinuityKind.BaselineAuthenticatedV1)invalid();
    const reader=LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384});
    let previous:ReturnType<LocalDependencyOwnerStore["read"]>;
    try{previous=reader.read(state.binding.workspace);}finally{reader.close();}
    if(!previous || previous.version===1 || !isDependencyConsumerOwner(previous.owner) ||
        previous.owner.phase!==DependencyOwnerPhase.ExclusiveMutation || !sameDependencyAttempt(previous.owner.attempt,state.attempt))invalid();
    const expected={...previous,revision:previous.revision+1,generationContinuity:slot};
    // All temporary descriptors have closed. Capture physical proof before
    // the owner store mutex; its verifier only compares its own predecessor.
    assertOriginalHostedDependencyGenerationBarrier(context,fence,access);
    assertHostedDependencyInstallerAttemptDrained(state.attempt);
    assertDependencySourceExposureCurrent(result.exposure);
    assertHostedDependencyKeyInputsCurrent(state.binding,result.inputs);
    store=LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384,generationBaselineVerifier:{
      assertGenerationBaselineTransition({previousOwner,proposedOwner}) {
        assertHostedActivationFence(fence);
        if(findOriginalHostedDependencyGenerationState(context,access)!==state ||
            readOriginalHostedDependencyColdInstallerState(context,access)!==cold || cold.result!==result ||
            state.phase!==BarrierPhase.Observing || state.sourceUse.exposure!==result.exposure ||
            !encode(previousOwner).equals(encode(previous)) || !encode(proposedOwner).equals(encode(expected)))invalid();
      },
    }});
    const written=store.compareAndSwap(state.binding.workspace,previous.revision,expected);
    if(!encode(store.read(state.binding.workspace)).equals(encode(written)))invalid();
    store.close();store=undefined;
    assertOriginalHostedDependencyGenerationBarrier(context,fence,access);
    assertHostedDependencyInstallerAttemptDrained(state.attempt);
    assertDependencySourceExposureCurrent(result.exposure);
    if(!sameDependencyProtectedReference(pinReferenceFile(baselinePath,65536).reference,baselinePin.reference))invalid();
    state.baseline=slot;state.phase=BarrierPhase.Published;
  }catch(error){state.phase=BarrierPhase.Held;state.sourceUse.phase=HostedDependencySourceUsePhase.Held;throw error;}
  finally{store?.close();}
}

/** Fixed same-map phase publication. The whole physical proof is acquired with
 * no owner-store descriptors open. Inside the mutex only its captured previous
 * and expected successor are compared against this private synchronous use. */
export function markOriginalHostedDependencyGenerationRunning(context:CurrentHostedDependencyOrigin,fence:HostedActivationFence,access:symbol):void {
  const state=findOriginalHostedDependencyGenerationState(context,access);if(!state)invalid();
  assertOriginalHostedDependencyGenerationBarrier(context,fence,access);
  const reader=LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384});
  let previous:ReturnType<LocalDependencyOwnerStore["read"]>;
  try{previous=reader.read(state.binding.workspace);}finally{reader.close();}
  if(!previous || !isDependencyConsumerOwner(previous.owner) || previous.owner.phase!==DependencyOwnerPhase.ExclusiveMutation ||
      !sameDependencyAttempt(previous.owner.attempt,state.attempt))invalid();
  if(previous.version!==1 && previous.generationContinuity?.kind===DependencyGenerationContinuityKind.BaselineAuthenticatedV1 &&
      (state.phase!==BarrierPhase.Published || !encode(previous.generationContinuity).equals(encode(state.baseline)) ||
       state.sourceUse.phase!==HostedDependencySourceUsePhase.Live || !state.sourceUse.exposure))invalid();
  assertOriginalHostedDependencyGenerationBarrier(context,fence,access);
  if(state.sourceUse.exposure)assertDependencySourceExposureCurrent(state.sourceUse.exposure);
  const store=LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384,generationBaselineVerifier:{
    assertGenerationBaselineTransition({previousOwner,proposedOwner}) {
      assertHostedActivationFence(fence);
      if(findOriginalHostedDependencyGenerationState(context,access)!==state ||
          !encode(previousOwner).equals(encode(previous)) || !isDependencyConsumerOwner(proposedOwner.owner) ||
          proposedOwner.owner.phase!==DependencyOwnerPhase.Running || !sameDependencyAttempt(proposedOwner.owner.attempt,state.attempt) ||
          !encode(proposedOwner).equals(encode({...previous,revision:previous.revision+1,owner:{...previous.owner,phase:DependencyOwnerPhase.Running},activity:proposedOwner.activity})))invalid();
    },
  }});
  try{markDependencyConsumerRunning(store,state.binding.workspace,state.attempt,String(Date.now()));}finally{store.close();}
  assertCurrentHostedDependencyAttempt(context,fence,DependencyOwnerPhase.Running);state.ownerPhase=DependencyOwnerPhase.Running;
  if(findOriginalHostedDependencyGenerationState(context,access)!==state ||
      (state.phase!==BarrierPhase.Unavailable && !readOriginalHostedDependencyGenerationNativeCensus(context,fence,access)))invalid();
}
