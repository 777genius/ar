import { retireOriginalHostedDependencyActiveInputs } from "./hosted-dependency-active-input-retirement";
import { HostedDependencyWarmRetirementPhase } from "./hosted-dependency-warm-retirement-state";
import { captureOriginalHostedDependencyWarmRetirement, readOriginalHostedDependencyWarmRetirement, assertCurrentHostedDependencyAttempt, type CurrentHostedDependencyOrigin } from "./hosted-current-dependency-origin";
import { DependencyGenerationContinuityKind, parseDependencyGenerationContinuityInvalidation, sameDependencyAttempt, isDependencyConsumerOwner } from "@vioxen/subscription-runtime/core";
import { readHostedDependencyEstablishedReceipt } from "./hosted-dependency-receipts";
import { DependencyUnverifiedReason, DependencyReceiptState } from "@vioxen/subscription-runtime/worker-core";
import { DependencyOwnerPhase, sameDependencyProtectedReference, sameDependencyWorkspace } from "@vioxen/subscription-runtime/core";
import { LocalDependencyReceiptStore } from "../store-local-file/dependency-environment/local-dependency-receipt-store";
import { LocalDependencyOwnerStore } from "../store-local-file/dependency-environment/local-dependency-owner-store";
import { invalidateDependencyGeneration } from "../worker-core/dependency-environment/application/invalidate-dependency-generation";
import { assertHostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { withHostedActivationFence } from "./hosted-dependency-activation";
import { hostedDependencyReceiptHistoryRoot } from "../provider-codex/app-server/adapters/hosted-dependency-history-path";
import { assertHostedDependencyRetirementOwnerFacts, assertHostedDependencyRetirementSuccessorFacts } from "./hosted-dependency-retirement-facts";
import { readOriginalHostedDependencySourceCleanupAssociation, readOriginalHostedDependencySourceCleanupScope,
  readOriginalHostedDependencyRetirementOwner, assertCurrentHostedDependencyRetiredReady, type HostedDependencyRootPurposeContext } from "./hosted-current-dependency-origin";
import { readOriginalHostedDependencyRootReady as currentRootReady } from "./hosted-dependency-root-physical-selection";
const root="/var/lib/subscription-runtime-host-policy";
const encode=(value:unknown)=>Buffer.from(JSON.stringify(value)+"\n");
function invalid():never {throw new Error("hosted_dependency_current_origin_unresolved");}
/** Fixed retirement only. All access resolves the SAME original context through
 * an unexposed lexical symbol; no data/owner/callback grants are admitted. */
export function retireOriginalHostedDependencySourceCleanup(context: HostedDependencyRootPurposeContext, reason: DependencyUnverifiedReason.TreeChanged | DependencyUnverifiedReason.InputsChanged,access:symbol): void {
  readOriginalHostedDependencySourceCleanupAssociation(context,access);
  withHostedActivationFence(fence => {
    const held = readOriginalHostedDependencySourceCleanupScope(context,fence,access);
    if(held.owner.version!==1 && held.owner.generationContinuity?.kind===DependencyGenerationContinuityKind.BaselineAuthenticatedV1)invalid();
    assertHostedDependencyRetirementOwnerFacts(held.state.record,held.owner);
    if ((reason !== DependencyUnverifiedReason.TreeChanged && reason !== DependencyUnverifiedReason.InputsChanged) ||
        !encode(currentRootReady(held.origin,fence,DependencyOwnerPhase.ExclusiveMutation)).equals(encode(held.state.ready))) invalid();
    // No collectors run with store FDs open. The same genuine fence brackets publication/readback; owner verifier uses its own CAS predecessor.
    const assertRetained = () => {
      assertHostedActivationFence(fence);
      const resolved = readOriginalHostedDependencySourceCleanupAssociation(context,access);
      if (resolved.origin !== held.origin || resolved.state !== held.state) invalid();
    };
    const receipts = LocalDependencyReceiptStore.open({rootPath:hostedDependencyReceiptHistoryRoot,maxRecordBytes:16384,maxHistorySteps:2048,
      generationReceiptVerifier:{
        assertReadyRetirement({previousReady,previousReference,proposedUnverified}) {
          assertRetained(); const owner = readOriginalHostedDependencyRetirementOwner(held.actual.binding,access);
          if (!encode(owner).equals(encode(held.owner)) || !encode(previousReady).equals(encode(held.state.ready.receipt)) ||
              !sameDependencyProtectedReference(previousReference,held.state.ready.reference) || proposedUnverified.revision !== previousReady.revision+1 ||
              proposedUnverified.generation !== previousReady.generation || proposedUnverified.reason !== reason ||
              !sameDependencyWorkspace(proposedUnverified.workspace,held.actual.binding.workspace)) invalid();
        },
        assertFactualUnverified() { invalid(); },
      }});
    let owners: LocalDependencyOwnerStore | undefined;
    try {
      owners = LocalDependencyOwnerStore.open({rootPath:root+"/dependency-owners",maxRecordBytes:16384,
        generationRetirementVerifier:{assertGenerationRetirement({previousOwner,proposedOwner,invalidation}) {
          assertRetained();
          if (!encode(previousOwner).equals(encode(held.owner))) invalid();
          assertHostedDependencyRetirementSuccessorFacts(held.state.record,previousOwner,proposedOwner,invalidation,
            held.actual.attempt.attemptId,held.state.ready);
          const current = receipts.read(held.actual.binding.workspace);
          if (!current || current.state !== DependencyReceiptState.Unverified || current.revision !== invalidation.unverifiedRevision ||
              current.generation !== invalidation.generation || current.reason !== reason) invalid();
          const committed = receipts.getCommittedUnverified(held.actual.binding.workspace,current.revision);
          if (!encode(committed.receipt).equals(encode(current)) || !sameDependencyProtectedReference(committed.reference,invalidation.retiredUnverified)) invalid();
        }}});
      invalidateDependencyGeneration({owners,receipts,workspace:held.actual.binding.workspace,expectedOwnerRevision:held.owner.revision,
        expectedReceiptRevision:held.state.ready.receipt.revision,reason});
    } finally { try { owners?.close(); } finally { receipts.close(); } }
    assertCurrentHostedDependencyRetiredReady(context,fence);
  });
}

/** Retires an already genuine historical Ready when no authenticated Active
 * baseline exists. BaselineMissing asserts no byte difference, never changes
 * the physical tree and creates no execution capability. Admission wiring to
 * a fresh Usable qualifier is a separate mandatory checkpoint. */
export function retireOriginalHostedDependencyWarmReady(context:CurrentHostedDependencyOrigin,access:symbol):void {
  readOriginalHostedDependencyWarmRetirement(context,access);
  withHostedActivationFence(fence=>{
    const state=captureOriginalHostedDependencyWarmRetirement(context,fence,access);
    if(state.owner.generationContinuity?.kind===DependencyGenerationContinuityKind.BaselineAuthenticatedV1) {
      retireOriginalHostedDependencyActiveInputs(context,fence,access);return;
    }
    const assertRetained=()=>{assertHostedActivationFence(fence);if(readOriginalHostedDependencyWarmRetirement(context,access)!==state)invalid();};
    const assertReadback=()=>{
      assertRetained();const actual=assertCurrentHostedDependencyAttempt(context,fence,DependencyOwnerPhase.ExclusiveMutation);
      if(!sameDependencyAttempt(actual.attempt,state.attempt))invalid();
      const owner=readOriginalHostedDependencyRetirementOwner(state.binding,access);
      if(owner.version===1 || !owner.generationContinuity || !isDependencyConsumerOwner(owner.owner) || !sameDependencyAttempt(owner.owner.attempt,state.attempt))invalid();
      const slot=parseDependencyGenerationContinuityInvalidation(owner.generationContinuity);
      if(slot.operationId!==state.attempt.attemptId || slot.generation!==state.ready.receipt.generation || slot.readyRevision!==state.ready.receipt.revision ||
        slot.unverifiedRevision!==state.ready.receipt.revision+1 || !sameDependencyProtectedReference(slot.previousReady,state.ready.reference))invalid();
      const current=readHostedDependencyEstablishedReceipt(state.binding);
      const store=LocalDependencyReceiptStore.open({rootPath:hostedDependencyReceiptHistoryRoot,maxRecordBytes:16384,maxHistorySteps:2048});
      try {const retired=store.getCommittedUnverified(state.binding.workspace,slot.unverifiedRevision),previous=store.getCommittedReady(state.binding.workspace,slot.readyRevision);
        if(!current || !encode(current).equals(encode(retired.receipt)) || !encode(previous).equals(encode(state.ready)) ||
          retired.receipt.reason!==DependencyUnverifiedReason.BaselineMissing || !sameDependencyProtectedReference(retired.reference,slot.retiredUnverified) ||
          state.retired && !encode(state.retired).equals(encode(retired)))invalid();
        state.retired=retired;
      }finally{store.close();}
      const after=assertCurrentHostedDependencyAttempt(context,fence,DependencyOwnerPhase.ExclusiveMutation);
      if(!sameDependencyAttempt(after.attempt,state.attempt) || !encode(readOriginalHostedDependencyRetirementOwner(state.binding,access)).equals(encode(owner)))invalid();
    };
    if(state.phase===HostedDependencyWarmRetirementPhase.Retired){assertReadback();return;}
    if(state.phase!==HostedDependencyWarmRetirementPhase.Captured)invalid();
    const receipts=LocalDependencyReceiptStore.open({rootPath:hostedDependencyReceiptHistoryRoot,maxRecordBytes:16384,maxHistorySteps:2048,
      generationReceiptVerifier:{assertFactualUnverified(){invalid();},assertReadyRetirement({previousReady,previousReference,proposedUnverified}){
        assertRetained();
        if(!encode(readOriginalHostedDependencyRetirementOwner(state.binding,access)).equals(encode(state.owner)) ||
          !encode(previousReady).equals(encode(state.ready.receipt)) || !sameDependencyProtectedReference(previousReference,state.ready.reference) ||
          proposedUnverified.reason!==DependencyUnverifiedReason.BaselineMissing || proposedUnverified.revision!==previousReady.revision+1 ||
          proposedUnverified.generation!==previousReady.generation || !sameDependencyWorkspace(proposedUnverified.workspace,state.binding.workspace) ||
          proposedUnverified.tree.dev!==previousReady.tree.dev || proposedUnverified.tree.ino!==previousReady.tree.ino)invalid();
      }}});
    let owners:LocalDependencyOwnerStore|undefined;
    try{
      owners=LocalDependencyOwnerStore.open({rootPath:root+"/dependency-owners",maxRecordBytes:16384,generationRetirementVerifier:{assertGenerationRetirement({previousOwner,proposedOwner,invalidation}){
        assertRetained();
        if(!encode(previousOwner).equals(encode(state.owner)) || proposedOwner.version!==previousOwner.version ||
          proposedOwner.revision!==previousOwner.revision+1 || !encode(proposedOwner.owner).equals(encode(previousOwner.owner)) || proposedOwner.epoch!==previousOwner.epoch ||
          invalidation.operationId!==state.attempt.attemptId || invalidation.readyRevision!==state.ready.receipt.revision ||
          invalidation.unverifiedRevision!==state.ready.receipt.revision+1 || invalidation.generation!==state.ready.receipt.generation ||
          !sameDependencyProtectedReference(invalidation.previousReady,state.ready.reference))invalid();
        const retired=receipts.getCommittedUnverified(state.binding.workspace,invalidation.unverifiedRevision);
        if(retired.receipt.reason!==DependencyUnverifiedReason.BaselineMissing || !sameDependencyProtectedReference(retired.reference,invalidation.retiredUnverified))invalid();
      }}});
      invalidateDependencyGeneration({owners,receipts,workspace:state.binding.workspace,expectedOwnerRevision:state.owner.revision,
        expectedReceiptRevision:state.ready.receipt.revision,reason:DependencyUnverifiedReason.BaselineMissing});
    }catch(error){state.phase=HostedDependencyWarmRetirementPhase.Held;throw error;}
    finally{try{owners?.close();}finally{receipts.close();}}
    try{assertReadback();state.phase=HostedDependencyWarmRetirementPhase.Retired;}
    catch(error){state.phase=HostedDependencyWarmRetirementPhase.Held;throw error;}
  });
}
