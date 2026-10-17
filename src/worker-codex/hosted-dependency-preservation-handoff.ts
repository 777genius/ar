import { createHash } from "node:crypto";
import { DependencyInstallProofKind, DependencyGenerationContinuityKind, DependencyUnverifiedReason, DependencyOwnerKind, DependencyOwnerPhase, DependencyPreservationKind, DependencyReceiptState as State,
  parseDependencyOwner, sameDependencyProtectedReference, type DependencyOwnerRecord } from "@vioxen/subscription-runtime/worker-core";
import { isDependencyCustodyObject, isDependencyProtectedReference } from "@vioxen/subscription-runtime/core";
import type { HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { pinReferenceFile, encodeReference as encode } from "./hosted-dependency-legacy-reference-records";
import { LocalDependencyOwnerStore } from "../store-local-file/dependency-environment/local-dependency-owner-store";
import { LocalDependencyReceiptStore } from "../store-local-file/dependency-environment/local-dependency-receipt-store";
import { hostedDependencyOwnerRoot, type HostedDependencyBinding } from "./hosted-dependency-workspace";
import { dependencyCoverageRevision, hostedDependencyReceiptHistoryRoot, readHostedDependencyEstablishedReceipt,
  readHostedDependencyExistingCommittedReady, readHostedDependencyExistingCommittedUnverified } from "./hosted-dependency-receipts";
import { readHostedDependencyCommittedPreservation, readHostedDependencyPreservationMapping } from "./hosted-dependency-preservation";
import { hostedDependencyPreservationSelectionPath, readHostedDependencyPreservationSelections,
  type HostedDependencyPreservationSelection as Selection } from "./hosted-dependency-preservation-selection";
const equal=(a:unknown,b:unknown)=>encode(a).equals(encode(b));
const hash=(v:Uint8Array)=>createHash("sha256").update(v).digest("hex");
function held():never {throw new Error("hosted_dependency_preservation_handoff_held");}
export function readHostedDependencyPreservationRetiredHistory(fence:HostedActivationFence,s:Selection) {
  const old=s.prior.receipt;
  const prior=old.receipt.state===State.Ready?readHostedDependencyExistingCommittedReady(fence,s.binding,old.receipt.revision):readHostedDependencyExistingCommittedUnverified(fence,s.binding,old.receipt.revision);
  if(!equal(prior,old))held();
  const retired=readHostedDependencyExistingCommittedUnverified(fence,s.binding,old.receipt.revision+1);
  if(!equal(retired.receipt,{version:1,revision:old.receipt.revision+1,generation:old.receipt.generation,workspace:old.receipt.workspace,coverageRevision:old.receipt.coverageRevision,state:State.Unverified,tree:s.sourceTree,reason:DependencyUnverifiedReason.ExplicitOperatorReinstallation}))held();return retired;
}
export function readHostedDependencyPreservationRelease(fence:HostedActivationFence,s:Selection) {
  const path=hostedDependencyPreservationSelectionPath(s.operationId)+".release.json",pin=pinReferenceFile(path,32768),v:unknown=JSON.parse(pin.bytes.toString("utf8"));
  if(!isDependencyCustodyObject(v,"fenced,previous,released,selection,version") || v.version!==1 || !isDependencyProtectedReference(v.selection) ||
      !pin.bytes.equals(encode(v)))held();
  const selection=readHostedDependencyPreservationSelections(s.binding).find(v=>v.header.operationId===s.operationId);
  if(!selection || !sameDependencyProtectedReference(selection.reference,v.selection))held();
  const previous=parseDependencyOwner(v.previous),fenced=parseDependencyOwner(v.fenced),released=parseDependencyOwner(v.released);
  const retired=readHostedDependencyPreservationRetiredHistory(fence,s),claimed=s.claimedOwner;
  let expected=claimed;
  if(s.prior.receipt.receipt.state===State.Ready)expected=parseDependencyOwner({...claimed,revision:claimed.revision+1,generationContinuity:{version:1,kind:DependencyGenerationContinuityKind.RetiredReadyV1,
    operationId:s.operationId,generation:retired.receipt.generation,readyRevision:s.prior.receipt.receipt.revision,unverifiedRevision:retired.receipt.revision,
    previousReady:s.prior.receipt.reference,retiredUnverified:retired.reference}});
  if(!equal(previous,expected) || previous.owner?.kind!==DependencyOwnerKind.Maintenance || previous.owner.attempt.operationId!==s.operationId ||
    !equal(fenced,parseDependencyOwner({...previous,revision:previous.revision+1,owner:{...previous.owner,phase:DependencyOwnerPhase.Fenced}})) ||
    !equal(released,parseDependencyOwner({...fenced,revision:fenced.revision+1,owner:null})))held();
  const mapping=readHostedDependencyPreservationMapping(s.binding,retired.receipt);
  if(!mapping || claimed.owner?.kind!==DependencyOwnerKind.Maintenance || !equal(mapping.prepared.header.attempt,claimed.owner.attempt) ||
    !equal(mapping.prepared.header.trash.destinationParent,s.destinationParent) || !equal(mapping.prepared.header.trash.originalTree,s.sourceTree) ||
    !equal(mapping.prepared.header.previous,retired))held();
  return {previous,fenced,released,reference:pin.reference,retired,mapping};
}
function completed(fence:HostedActivationFence,s:Selection) {
  const old=s.prior.receipt.receipt,retiredRevision=old.revision+1,current=readHostedDependencyEstablishedReceipt(s.binding);
  if(!current || current.revision<retiredRevision+2)return undefined;
  const release=readHostedDependencyPreservationRelease(fence,s),consumer=readHostedDependencyPreservationConsumer(s),
    store=LocalDependencyReceiptStore.open({rootPath:hostedDependencyReceiptHistoryRoot,maxRecordBytes:16384,maxHistorySteps:2048});
  let installing;try{installing=store.getCommittedInstalling(s.binding.workspace,retiredRevision+1);}finally{store.close();}
  const ready=readHostedDependencyExistingCommittedReady(fence,s.binding,retiredRevision+2),attempt=consumer.claimed.owner;
  if(attempt?.kind!==DependencyOwnerKind.Consumer || !equal(consumer.previous,release.released) ||
      !equal(consumer.claimed,parseDependencyOwner({...release.released,revision:release.released.revision+1,epoch:release.released.epoch+1,
        owner:{kind:DependencyOwnerKind.Consumer,phase:DependencyOwnerPhase.ExclusiveMutation,attempt:attempt.attempt}})))held();
  const p=installing.receipt.preservation,m=release.mapping;
  const expected={kind:DependencyPreservationKind.CommittedPreservation,generation:attempt.attempt.attemptId,workspace:s.binding.workspace,
    coverageRevision:dependencyCoverageRevision(s.binding),operationId:attempt.attempt.attemptId,originalTree:release.retired.receipt.tree,
    preservedTree:release.retired.receipt.tree,destinationParent:s.destinationParent,destinationName:`dependency-${s.operationId}`,
    mappingDigest:hash(encode(m.prepared.header)),commitEvidenceId:m.committed.reference.sha256};
  if(!equal(p,expected) || installing.receipt.generation!==attempt.attempt.attemptId || installing.receipt.operationId!==attempt.attempt.attemptId ||
      installing.receipt.generation===old.generation || installing.receipt.coverageRevision!==dependencyCoverageRevision(s.binding) || ready.receipt.coverageRevision!==installing.receipt.coverageRevision ||
      ready.receipt.provenance.kind===DependencyInstallProofKind.LegacyCompared || ready.receipt.provenance.operationId!==installing.receipt.operationId ||
      ready.receipt.generation!==installing.receipt.generation || ready.receipt.installKey!==installing.receipt.requestedKey ||
      !sameDependencyProtectedReference(consumer.release,release.reference))held();
  return Object.freeze({selection:s,release,consumer,installing,ready});
}
/** Fixed completed history only. This factual reader selects its own activated
 * operation and authenticates original adjacent install records; native source
 * closure remains mandatory in the defining historical consumer. */
export function readHostedDependencyCompletedPreservation(fence:HostedActivationFence,binding:HostedDependencyBinding,operationId:string) {
  const selected=readHostedDependencyPreservationSelections(binding).find(v=>v.header.operationId===operationId);
  if(!selected)held();return completed(fence,selected.header);
}
/** Every indexed selection is checked before receipt-state/warm fallbacks.
 * Only authenticated adjacent Installing+Ready closes a historical index. */
export function readHostedDependencyPendingPreservations(fence:HostedActivationFence,binding:HostedDependencyBinding) {
  return readHostedDependencyPreservationSelections(binding).filter(v=>!completed(fence,v.header));
}
export function readHostedDependencyPreservationConsumer(s:Selection) {
  const pin=pinReferenceFile(hostedDependencyPreservationSelectionPath(s.operationId)+".consumer.json",32768),v:unknown=JSON.parse(pin.bytes.toString("utf8"));
  if(!isDependencyCustodyObject(v,"claimed,previous,release,selection,version") || v.version!==1 || !pin.bytes.equals(encode(v)) ||
      !isDependencyProtectedReference(v.release) || !isDependencyProtectedReference(v.selection))held();
  const selected=readHostedDependencyPreservationSelections(s.binding).find(v=>v.header.operationId===s.operationId);if(!selected || !sameDependencyProtectedReference(selected.reference,v.selection))held();
  const previous=parseDependencyOwner(v.previous),claimed=parseDependencyOwner(v.claimed);
  if(previous.owner || claimed.owner?.kind!==DependencyOwnerKind.Consumer || claimed.owner.phase!==DependencyOwnerPhase.ExclusiveMutation ||
      !equal(claimed,parseDependencyOwner({...previous,revision:previous.revision+1,epoch:previous.epoch+1,owner:claimed.owner})))held();
  return {previous,claimed,release:v.release,reference:pin.reference};
}
/** Admission requires actual current owner + fixed original handoff, and the
 * committed mapping's physical readback. Missing tree alone never passes. */
export function assertHostedDependencyPreservationAdmission(fence:HostedActivationFence,binding:HostedDependencyBinding):void {
  const pending=readHostedDependencyPendingPreservations(fence,binding);if(!pending.length)return;if(pending.length!==1)held();
  const s=pending[0]!.header,release=readHostedDependencyPreservationRelease(fence,s),consumer=readHostedDependencyPreservationConsumer(s),store=LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384});
  let actual:DependencyOwnerRecord|null;try{actual=store.read(binding.workspace);}finally{store.close();}
  if(!equal(actual,consumer.claimed) || !equal(consumer.previous,release.released) || !sameDependencyProtectedReference(consumer.release,release.reference) ||
      consumer.claimed.owner?.kind!==DependencyOwnerKind.Consumer || !readHostedDependencyCommittedPreservation(binding,release.retired.receipt,consumer.claimed.owner.attempt.attemptId))held();
}
