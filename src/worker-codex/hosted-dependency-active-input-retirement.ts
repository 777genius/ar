import { createReadonlyPrivateRecord } from "./hosted-readonly-custody";
import { ensureHostedDependencyDirectory } from "./hosted-dependency-receipts";
import { pinReferenceFile } from "./hosted-dependency-legacy-reference-records";
import { DependencyGenerationContinuityKind, DependencyOwnerPhase, isDependencyConsumerOwner, parseDependencyOwner,
  parseDependencyGenerationContinuityInvalidation, sameDependencyAttempt, sameDependencyProtectedReference, sameDependencyTree } from "@vioxen/subscription-runtime/core";
import { DependencyReceiptState, DependencyUnverifiedReason } from "@vioxen/subscription-runtime/worker-core";
import { assertHostedActivationFence, type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { hostedDependencyOwnerRoot } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { hostedDependencyReceiptHistoryRoot } from "../provider-codex/app-server/adapters/hosted-dependency-history-path";
import { LocalDependencyReceiptStore } from "../store-local-file/dependency-environment/local-dependency-receipt-store";
import { LocalDependencyOwnerStore } from "../store-local-file/dependency-environment/local-dependency-owner-store";
import { findOriginalHostedDependencyGenerationEntry, assertCurrentHostedDependencyAttempt, readOriginalHostedDependencyRetirementOwner,
  type CurrentHostedDependencyOrigin } from "./hosted-current-dependency-origin";
import { assertOriginalHostedDependencyGenerationBarrier } from "./hosted-dependency-generation-controller";
import { assertHostedDependencyKeyInputsCurrent } from "./hosted-dependency-materialization-context";
import { HostedDependencyWarmRetirementPhase } from "./hosted-dependency-warm-retirement-state";
import { HostedDependencyGenerationBarrierPhase } from "./hosted-dependency-generation-state";
import { readHostedDependencyRootDirectoryPin } from "./hosted-dependency-root-physical-facts";
import { readHostedDependencyExistingCommittedReady, readHostedDependencyExistingCommittedUnverified, readHostedDependencyEstablishedReceipt } from "./hosted-dependency-receipts";
const encode=(v:unknown)=>Buffer.from(JSON.stringify(v)+"\n");
function held():never{throw new Error("hosted_dependency_active_input_retirement_held");}
/** Factual current-input revocation before qualification. Only the actual
 * original context's fixed capture establishes InputsChanged. Historical tree
 * bytes are retained as history, never observed, installed or attested again.
 * A partial two-store publication is Held, not retried as a different reason. */
export function retireOriginalHostedDependencyActiveInputs(context:CurrentHostedDependencyOrigin,fence:HostedActivationFence,access:symbol):void {
  const selected=findOriginalHostedDependencyGenerationEntry(context,access),state=selected.warmRetirement,generation=selected.generation;
  if(!state || !generation || !generation.inputs || state.reason!==DependencyUnverifiedReason.InputsChanged ||
      state.phase!==HostedDependencyWarmRetirementPhase.Captured || state.owner.generationContinuity?.kind!==DependencyGenerationContinuityKind.BaselineAuthenticatedV1)held();
  const before=state.owner,slot=before.generationContinuity,inputs=generation.inputs;
  if(!slot || slot.kind!==DependencyGenerationContinuityKind.BaselineAuthenticatedV1)held();
  if(!sameDependencyProtectedReference(state.ready.reference,slot.previousReady) || state.ready.receipt.revision!==slot.readyRevision)held();
  const retained=()=>{
    assertHostedActivationFence(fence);const now=findOriginalHostedDependencyGenerationEntry(context,access);
    if(now!==selected || now.warmRetirement!==state || now.generation!==generation || generation.inputs!==inputs || now.rootPurpose || now.cold)held();
  };
  const physical=()=>{
    retained();const actual=assertCurrentHostedDependencyAttempt(context,fence,DependencyOwnerPhase.ExclusiveMutation);
    if(!sameDependencyAttempt(actual.attempt,state.attempt) || !encode(actual.binding).equals(encode(state.binding)))held();
    assertOriginalHostedDependencyGenerationBarrier(context,fence,access);
    assertHostedDependencyKeyInputsCurrent(state.binding,inputs);
    if(!sameDependencyTree(readHostedDependencyRootDirectoryPin(state.binding.workspace.canonicalPath+"/node_modules"),state.ready.receipt.tree))held();
  };
  physical();if(!encode(readOriginalHostedDependencyRetirementOwner(state.binding,access)).equals(encode(before)) ||
      !encode(readHostedDependencyExistingCommittedReady(fence,state.binding,state.ready.receipt.revision)).equals(encode(state.ready)))held();
  try {
    const receipts=LocalDependencyReceiptStore.open({rootPath:hostedDependencyReceiptHistoryRoot,maxRecordBytes:16384,maxHistorySteps:2048,
      generationReceiptVerifier:{assertFactualUnverified(){held();},assertReadyRetirement({previousReady,previousReference,proposedUnverified}){
        retained();if(!encode(previousReady).equals(encode(state.ready.receipt)) || !sameDependencyProtectedReference(previousReference,state.ready.reference) ||
          !encode(proposedUnverified).equals(encode({version:1,revision:previousReady.revision+1,workspace:previousReady.workspace,
            generation:previousReady.generation,coverageRevision:previousReady.coverageRevision,state:DependencyReceiptState.Unverified,
            tree:previousReady.tree,reason:DependencyUnverifiedReason.InputsChanged})))held();
      }}});
    let retired:ReturnType<LocalDependencyReceiptStore["getCommittedUnverified"]>;
    try {
      retired=receipts.retireReady(state.binding.workspace,state.ready.receipt.revision,state.ready.reference,{version:1,
        revision:state.ready.receipt.revision+1,workspace:state.ready.receipt.workspace,generation:state.ready.receipt.generation,
        coverageRevision:state.ready.receipt.coverageRevision,state:DependencyReceiptState.Unverified,tree:state.ready.receipt.tree,
        reason:DependencyUnverifiedReason.InputsChanged});
      if(!encode(receipts.read(state.binding.workspace)).equals(encode(retired.receipt)))held();
    }finally{receipts.close();}
    physical();if(!encode(readOriginalHostedDependencyRetirementOwner(state.binding,access)).equals(encode(before)) ||
      !encode(readHostedDependencyExistingCommittedUnverified(fence,state.binding,retired.receipt.revision)).equals(encode(retired)))held();
    const invalidation=parseDependencyGenerationContinuityInvalidation({version:1,kind:DependencyGenerationContinuityKind.RetiredReadyV1,
      operationId:state.attempt.attemptId,generation:state.ready.receipt.generation,readyRevision:state.ready.receipt.revision,
      unverifiedRevision:retired.receipt.revision,previousReady:state.ready.reference,retiredUnverified:retired.reference});
    const expected=parseDependencyOwner({...before,revision:before.revision+1,generationContinuity:invalidation});
    // Retain the exact retired interval BEFORE owner publication. The later
    // source/native discharge must consume this historical baseline + own
    // successor; RetiredReady itself is not evidence that exposure closed.
    const intervalRoot="/var/lib/subscription-runtime-host-policy/dependency-generation-retired-intervals",
      intervalPath=`${intervalRoot}/${state.attempt.launch.startId}.json`,
      intervalBytes=encode({version:1,attempt:state.attempt,binding:state.binding,active:slot,retiredOwner:expected});
    if(intervalBytes.length>16384)held();ensureHostedDependencyDirectory(intervalRoot);
    createReadonlyPrivateRecord(intervalPath,intervalBytes);
    const interval=pinReferenceFile(intervalPath,16384);if(!interval.bytes.equals(intervalBytes))held();
    physical();if(!encode(readOriginalHostedDependencyRetirementOwner(state.binding,access)).equals(encode(before)))held();
    // No physical census or nested owner/receipt read under the owner mutex.
    // Its captured predecessor and successor must be exactly this fixed proof.
    const owners=LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384,generationBaselineVerifier:{
      assertGenerationBaselineTransition({previousOwner,proposedOwner}){
        retained();if(!encode(previousOwner).equals(encode(before)) || !encode(proposedOwner).equals(encode(expected)))held();
      }}});
    try {const written=owners.compareAndSwap(state.binding.workspace,before.revision,expected);
      if(!encode(written).equals(encode(expected)) || !encode(owners.read(state.binding.workspace)).equals(encode(expected)))held();
    }finally{owners.close();}
    physical();const owner=readOriginalHostedDependencyRetirementOwner(state.binding,access);
    if(!encode(owner).equals(encode(expected)) || !isDependencyConsumerOwner(owner.owner) || !sameDependencyAttempt(owner.owner.attempt,state.attempt) ||
      !encode(readHostedDependencyExistingCommittedReady(fence,state.binding,state.ready.receipt.revision)).equals(encode(state.ready)) ||
      !encode(readHostedDependencyExistingCommittedUnverified(fence,state.binding,retired.receipt.revision)).equals(encode(retired)) ||
      !encode(readHostedDependencyEstablishedReceipt(state.binding)).equals(encode(retired.receipt)))held();
    state.retired=retired;state.phase=HostedDependencyWarmRetirementPhase.Retired;
    // Retirement cannot issue another Active interval. Fresh Usable qualification
    // rechecks current inputs/capabilities and uses the existing tree as-is.
    generation.phase=HostedDependencyGenerationBarrierPhase.Unavailable;
  }catch(error){state.phase=HostedDependencyWarmRetirementPhase.Held;throw error;}
}
