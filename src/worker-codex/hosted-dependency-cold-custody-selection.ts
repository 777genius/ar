import { assertOriginalHostedDependencyFullBackingInterval } from "./hosted-full-backing-interval";
import { readOriginalHostedDependencyMaintenanceIdle } from "./hosted-dependency-active-maintenance";
import { hostedDependencyInstallerRoot } from "./hosted-dependency-installer-recipe";
import { createHash } from "node:crypto";
import { assertHostedDependencyInstallerAttemptDrained } from "./hosted-dependency-installer";
import { readHostedPrivateBytes } from "./hosted-readonly-inputs";
import { DependencyGenerationContinuityKind, sameDependencyProtectedReference,
  isDependencyCustodyObject, isDependencyConsumerOwner, parseDependencyOwner,
  type DependencyReadonlyColdBaselineAdoptionEvidence } from "@vioxen/subscription-runtime/core";
import { DependencyInstallProofKind, DependencyOwnerKind, DependencyOwnerPhase, HostedActivationPhase } from "@vioxen/subscription-runtime/worker-core";
import { assertHostedActivationFence, assertHostedActivationOperator, type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { assertHostedProcessDescriptors } from "../provider-codex/app-server/adapters/hosted-process-descriptors";
import { readHostedDependencyBinding, hostedDependencyBindingName } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { assertOriginalHostedDependencyPhysicalRecordAccess } from "./hosted-current-dependency-origin";
import { readOriginalHostedDependencyCIdleGeneration } from "./hosted-dependency-generation-source-closure";
import { readOriginalHostedDependencyOperatorPriorCSourceClosure } from "./hosted-dependency-generation-prior-closure";
import { readHostedDependencyActiveActorFacts } from "./hosted-dependency-active-actor-facts";
import { readOriginalHostedDependencyOperatorNativeCensus } from "./hosted-dependency-generation-native-census";
import { readHostedDependencyCommittedReady, readHostedDependencyEstablishedReceipt, openHostedDependencySourceLinks } from "./hosted-dependency-receipts";
import { closeDependencySourceLinkSession } from "../worker-local/dependency-environment/dependency-source-binding";
import { readHostedInstallationActivation } from "./hosted-installation-origin-facts";
import { pinReferenceFile } from "./hosted-dependency-legacy-reference-records";
import { parseScopedOrdinaryReaderFinalReceipt } from "@vioxen/subscription-runtime/core";
const root="/var/lib/subscription-runtime-host-policy",encode=(value:unknown)=>Buffer.from(JSON.stringify(value)+"\n");
function held():never {throw new Error("hosted_dependency_cold_custody_held");}
type Candidate=DependencyReadonlyColdBaselineAdoptionEvidence["candidate"];
function boundary(fence:HostedActivationFence,access:symbol):void {
  assertOriginalHostedDependencyPhysicalRecordAccess(access);assertHostedActivationFence(fence);assertHostedActivationOperator();assertHostedProcessDescriptors();
  assertOriginalHostedDependencyFullBackingInterval(fence,access);assertHostedProcessDescriptors();
}
/** Protected original cold evidence only. Historical content is not reobserved
 * or promoted: the actual final observation's published baseline remains fixed. */
function coldReady(fence:HostedActivationFence,candidate:Candidate,access:symbol) {
  boundary(fence,access);const binding=readHostedDependencyBinding(candidate.jobId),slot=candidate.generationBaseline;
  if(!binding || binding.version!==2 || slot.kind!==DependencyGenerationContinuityKind.BaselineAuthenticatedV1)held();
  const bindingPin=pinReferenceFile(`${root}/${hostedDependencyBindingName(binding.jobId)}`,16384);
  if(!sameDependencyProtectedReference(bindingPin.reference,candidate.binding) || !bindingPin.bytes.equals(encode(binding)))held();
  const baseline=pinReferenceFile(`${root}/dependency-generation-baselines/${slot.operationId}.json`,65536),v:unknown=JSON.parse(baseline.bytes.toString("utf8")),
    ready=readHostedDependencyCommittedReady(binding,slot.readyRevision);
  if(!isDependencyCustodyObject(v,"actors,attempt,barrier,binding,inputClosureDigest,installerMappingSha256,ready,readyReference,version") || v.version!==1 ||
      !baseline.bytes.equals(encode(v)) || !sameDependencyProtectedReference(baseline.reference,slot.baseline) ||
      !encode(v.binding).equals(encode(binding)) || !encode(v.ready).equals(encode(ready.receipt)) ||
      !encode(readHostedDependencyEstablishedReceipt(binding)).equals(encode(ready.receipt)) ||
      !encode(v.readyReference).equals(encode(ready.reference)) || !encode(v.barrier).equals(encode(slot.writerBarrier)) ||
      !sameDependencyProtectedReference(ready.reference,slot.previousReady) || ready.receipt.generation!==slot.generation ||
      ready.receipt.provenance.kind!==DependencyInstallProofKind.CompletedLocalInstallV1 ||
      !sameDependencyProtectedReference(candidate.sourceMapping,ready.receipt.provenance.sourceBinding))held();
  if(!isDependencyCustodyObject(v.attempt,"attemptId,epoch,launch") || v.attempt.attemptId!==slot.operationId)held();
  const parsed=parseDependencyOwner({version:2,workspace:binding.workspace,revision:1,epoch:v.attempt.epoch,
    owner:{kind:DependencyOwnerKind.Consumer,phase:DependencyOwnerPhase.ExclusiveMutation,attempt:v.attempt}});
  if(!parsed.owner || !isDependencyConsumerOwner(parsed.owner))held();
  const mappingPath=`${hostedDependencyInstallerRoot}/attempt-${slot.operationId}.json`,mappingBytes=readHostedPrivateBytes(mappingPath,4096);
  if(!mappingBytes || createHash("sha256").update(mappingBytes).digest("hex")!==v.installerMappingSha256)held();
  const mapped:unknown=JSON.parse(mappingBytes.toString("utf8"));
  if(!isDependencyCustodyObject(mapped,"attempt,schemaVersion,startId,unit") || mapped.schemaVersion!==1 ||
      typeof mapped.startId!=="string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(mapped.startId) ||
      mapped.unit!==`subscription-runtime-installer-${mapped.startId}.service` || !encode(mapped.attempt).equals(encode(parsed.owner.attempt)) || !mappingBytes.equals(encode(mapped)))held();
  assertHostedDependencyInstallerAttemptDrained(parsed.owner.attempt);
  if(!readHostedPrivateBytes(mappingPath,4096)?.equals(mappingBytes))held();
  const source=openHostedDependencySourceLinks({...ready.receipt,provenance:ready.receipt.provenance});
  try { // The existing verifier rejoins actual source/config/output pins.
    const mapping=pinReferenceFile(candidate.sourceMapping.path,262144);
    if(!sameDependencyProtectedReference(mapping.reference,candidate.sourceMapping))held();
  }finally{closeDependencySourceLinkSession(source);}
  const barrier=pinReferenceFile(`${root}/dependency-generation-barriers/${slot.operationId}.json`,16384);
  if(!sameDependencyProtectedReference(barrier.reference,slot.writerBarrier))held();
  const actors=readHostedDependencyActiveActorFacts(fence,access);
  if(!actors || !encode(actors).equals(encode(v.actors)) || !readOriginalHostedDependencyOperatorNativeCensus(fence,access))held();
  boundary(fence,access);return {binding,ready,baseline};
}
/** Fixed operator selection BEFORE enterExclusive. No policy/reference DTO can
 * select a historical attempt instead of the actual currently released C. */
export function selectOriginalHostedDependencyColdCustodyCandidate(fence:HostedActivationFence,jobId:string,access:symbol) {
  boundary(fence,access);
  if(readHostedInstallationActivation().activation.phase!==HostedActivationPhase.Ordinary)held();
  const binding=readHostedDependencyBinding(jobId);if(!binding || binding.version!==2)held();
  const idle=readOriginalHostedDependencyMaintenanceIdle(fence,binding.workspace,access) ?? readOriginalHostedDependencyCIdleGeneration(fence,jobId,access),slot=idle.previous.generationContinuity;
  if(idle.previous.version!==2 || idle.previous.owner || slot?.kind!==DependencyGenerationContinuityKind.BaselineAuthenticatedV1)held();
  const match=/\/dependency-generation-source-closures\/([a-f0-9-]{36})\.json$/.exec(idle.sourceClosed.path);if(!match)held();
  const ready=readHostedDependencyCommittedReady(idle.binding,slot.readyRevision);
  if(ready.receipt.provenance.kind!==DependencyInstallProofKind.CompletedLocalInstallV1)held();
  const candidate:Candidate={jobId:idle.binding.jobId,binding:pinReferenceFile(`${root}/${hostedDependencyBindingName(idle.binding.jobId)}`,16384).reference,
    closedStartId:match[1]!,generationBaseline:slot,sourceClosed:idle.sourceClosed,idle:idle.idle,
    sourceMapping:ready.receipt.provenance.sourceBinding};
  const selected=coldReady(fence,candidate,access);
  return {...selected,candidate,previous:idle.previous};
}
/** During actual enrollment the live C classifier must remain vetoed. Rejoin
 * the independent historical native chain, rather than forgiving its phase or
 * borrowing a stale Consumer. Current owner transitions are checked separately. */
export function reassertOriginalHostedDependencyColdCustodyCandidate(fence:HostedActivationFence,candidate:Candidate,access:symbol) {
  boundary(fence,access);const selected=coldReady(fence,candidate,access),unit=`subscription-runtime-ordinary-${candidate.closedStartId}.service`;
  const closed=pinReferenceFile(`${root}/dependency-generation-source-closures/${candidate.closedStartId}.json`,65536),v:unknown=JSON.parse(closed.bytes.toString("utf8"));
  if(!sameDependencyProtectedReference(closed.reference,candidate.sourceClosed) || !isDependencyCustodyObject(v,"attempt,barrier,baseline,binding,final,pending,retirement,version") ||
      v.version!==1 || !closed.bytes.equals(encode(v)) || !encode(v.binding).equals(encode(selected.binding)) ||
      !encode(v.baseline).equals(encode(candidate.generationBaseline.baseline)) || !encode(v.barrier).equals(encode(candidate.generationBaseline.writerBarrier)))held();
  const final=parseScopedOrdinaryReaderFinalReceipt(v.final);
  if(final.reader.startId!==candidate.closedStartId || final.reader.unit!==unit ||
      !readOriginalHostedDependencyOperatorPriorCSourceClosure(fence,unit,access)?.includes(unit))held();
  const idle=pinReferenceFile(candidate.idle.path,16384);
  if(!sameDependencyProtectedReference(idle.reference,candidate.idle))held();
  boundary(fence,access);return selected;
}
