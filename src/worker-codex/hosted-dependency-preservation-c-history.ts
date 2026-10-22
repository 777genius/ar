import type { CurrentHostedDependencyOrigin } from "./hosted-current-dependency-origin";
import { DependencyGenerationContinuityKind as Continuity, DependencyUnverifiedReason, DependencyReceiptState as State,
  HostedCustodyReservationState, sameDependencyProtectedReference, type DependencyOwnerRecord } from "@vioxen/subscription-runtime/worker-core";
import { assertHostedActivationFence, type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { assertOriginalHostedDependencyPhysicalRecordAccess } from "./hosted-current-dependency-origin";
import { readOriginalHostedOrdinaryReaderFinalFacts, readOriginalHostedConsumerReaderFinalFacts } from "./hosted-ordinary-reader-final-facts";
import { readOriginalHostedOrdinaryReaderParentCompletion, readOriginalHostedConsumerReaderParentCompletion } from "./hosted-ordinary-reader-parent-completion";
import { readHostedInstallationActivation } from "./hosted-installation-origin-facts";
import { pinReferenceFile, encodeReference as encode } from "./hosted-dependency-legacy-reference-records";
import { parseOrdinaryRootPreparationFacts } from "./hosted-dependency-root-provenance-facts";
import { readHostedDependencyRecoveryAdmissionFacts } from "./hosted-dependency-recovery-admission-facts";
import { HostedDependencyPreservationLineageKind as Kind, type HostedDependencyPreservationSelection } from "./hosted-dependency-preservation-selection";
import type { HostedDependencyBinding } from "./hosted-dependency-workspace";
import { readHostedDependencyEstablishedReceipt, readHostedDependencyExistingCommittedReady,
  readHostedDependencyExistingCommittedUnverified } from "./hosted-dependency-receipts";
const root="/var/lib/subscription-runtime-host-policy";
function held():never {throw new Error("hosted_dependency_preservation_c_history_held");}
/** Reuses original parent/provider FDA, qualification and queue/recursive
 * discharge readers. Epoch equality is required only at initial idle capture;
 * later fixed history is selected by its activated immutable request. */
function facts(fence:HostedActivationFence,binding:HostedDependencyBinding,startId:string,access:symbol,context?:CurrentHostedDependencyOrigin) {
  assertOriginalHostedDependencyPhysicalRecordAccess(access);assertHostedActivationFence(fence);
  const start=pinReferenceFile(`${root}/ordinary-starts/${startId}.json`,16384),
    parent=context?readOriginalHostedConsumerReaderParentCompletion(context,fence,startId,start.reference.sha256,access):readOriginalHostedOrdinaryReaderParentCompletion(fence,startId,start.reference.sha256,access),
    final=context?readOriginalHostedConsumerReaderFinalFacts(context,fence,startId,access):readOriginalHostedOrdinaryReaderFinalFacts(fence,startId,access);
  if(parent.row.state!==HostedCustodyReservationState.Terminal || !encode(parent.binding).equals(encode(binding)))held();
  const entry=pinReferenceFile(`${root}/dependency-reader-entries/${startId}.json`,4096);
  if(!entry.bytes.equals(encode({version:1,producer:parent.producer.reference,attempt:parent.attempt})))held();
  const preparation=pinReferenceFile(`${root}/dependency-root-preparations/${startId}.json`,65536),
    prepared=parseOrdinaryRootPreparationFacts(preparation.bytes,parent.attempt,{origin:start.reference,producer:parent.producer.reference,entry:entry.reference}),
    qualification=pinReferenceFile(prepared.qualification.path,16384);
  if(!sameDependencyProtectedReference(qualification.reference,prepared.qualification))held();
  const admission=readHostedDependencyRecoveryAdmissionFacts(fence,binding,parent.attempt,prepared,qualification.bytes);
  const units=Object.freeze([parent.row.unit,...final.providers.map(v=>v.member.unit)]);
  for(const p of [start,entry,preparation,qualification])if(!sameDependencyProtectedReference(pinReferenceFile(p.reference.path,p.bytes.length).reference,p.reference))held();
  return {parent,admission,units,start:start.reference,final:parent.completion};
}
export function captureOriginalHostedUnverifiedCPreservationIdle(fence:HostedActivationFence,binding:HostedDependencyBinding,previous:DependencyOwnerRecord,access:symbol) {
  assertOriginalHostedDependencyPhysicalRecordAccess(access);assertHostedActivationFence(fence);
  if(previous.version!==2 || previous.owner || previous.generationContinuity && previous.generationContinuity.kind!==Continuity.RetiredReadyV1)held();
  const initial=readHostedInstallationActivation(),matches=[];
  for(const row of initial.activation.ordinaryStarts) {
    if(row.unit!==`subscription-runtime-ordinary-${row.startId}.service` || row.state!==HostedCustodyReservationState.Terminal)continue;
    const start=pinReferenceFile(`${root}/ordinary-starts/${row.startId}.json`,16384),v:unknown=JSON.parse(start.bytes.toString("utf8"));
    if(!v || typeof v!=="object" || !("jobId" in v) || v.jobId!==binding.jobId)continue;
    const current=facts(fence,binding,row.startId,access);if(current.parent.attempt.epoch===previous.epoch)matches.push(current);
  }
  if(matches.length!==1 || !encode(readHostedInstallationActivation()).equals(encode(initial)))held();
  const receipt=readHostedDependencyEstablishedReceipt(binding);if(!receipt || receipt.state!==State.Ready && receipt.state!==State.Unverified)held();
  if(receipt.state===State.Unverified && receipt.reason!==DependencyUnverifiedReason.BaselineMissing)held();
  const committed=receipt.state===State.Ready?readHostedDependencyExistingCommittedReady(fence,binding,receipt.revision):readHostedDependencyExistingCommittedUnverified(fence,binding,receipt.revision),admission=matches[0]!.admission;
  if(receipt.state===State.Unverified ? admission.version!==2 || !sameDependencyProtectedReference(admission.unverified,committed.reference) :
      admission.version===2 || !sameDependencyProtectedReference(admission.version===1?admission.ready:admission.baselineReady,committed.reference))held();
  return {binding,previous,...matches[0]!};
}
export function readOriginalHostedUnverifiedCPreservationHistory(fence:HostedActivationFence,selection:HostedDependencyPreservationSelection,access:symbol,context?:CurrentHostedDependencyOrigin) {
  assertOriginalHostedDependencyPhysicalRecordAccess(access);const l=selection.lineage;if(l.kind!==Kind.OrdinaryUnverified)held();
  const match=/\/ordinary-starts\/([a-f0-9-]{36})\.json$/.exec(l.start.path);if(!match)held();
  const result=facts(fence,selection.binding,match[1]!,access,context),prior=selection.prior.owner,receipt=selection.prior.receipt;
  if(prior.version!==2 || prior.owner || result.parent.attempt.epoch!==prior.epoch ||
      !sameDependencyProtectedReference(result.start,l.start) || !sameDependencyProtectedReference(result.final,l.final))held();
  // A factual Usable/no-Active admission is positive original evidence. A
  // missing former-Active closure never turns an InputsChanged retirement into
  // that branch; genuine retired intervals use the SourceClosed lineage.
  if(receipt.receipt.state===State.Unverified && receipt.receipt.reason!==DependencyUnverifiedReason.BaselineMissing)held();
  if(receipt.receipt.state===State.Unverified ? result.admission.version!==2 || !sameDependencyProtectedReference(result.admission.unverified,receipt.reference) :
      result.admission.version===2 || !sameDependencyProtectedReference(result.admission.version===1?result.admission.ready:result.admission.baselineReady,receipt.reference))held();
  return result;
}
