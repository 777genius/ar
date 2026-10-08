import { createHash } from "node:crypto";
import { DependencyOwnerKind, DependencyOwnerPhase, DependencyGenerationContinuityKind, isDependencyCustodyObject,
  isDependencyProtectedReference, parseDependencyOwner, parseScopedOrdinaryReaderFinalReceipt, sameDependencyProtectedReference,
  type DependencyReadonlyColdBaselineAdoptionEvidence } from "@vioxen/subscription-runtime/core";
import { DependencyInstallProofKind } from "@vioxen/subscription-runtime/worker-core";
import { assertHostedActivationFence, type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { hostedDependencyBindingName, type HostedDependencyBinding } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { pinReferenceFile, encodeReference as encode } from "./hosted-dependency-legacy-reference-records";
import { readHostedDependencyCommittedReady } from "./hosted-dependency-receipts";
const root="/var/lib/subscription-runtime-host-policy";
function held():never{throw new Error("hosted_readonly_dependency_custody_unresolved");}
/** Historical cold provenance only. This deliberately does not compare the
 * old NM inode with current output after a legitimate Absent/cold restore.
 * Current execution must separately consume its own original-map admission. */
export function readHostedReadonlyColdCustodyHistory(fence:HostedActivationFence,binding:HostedDependencyBinding,
  evidence:DependencyReadonlyColdBaselineAdoptionEvidence) {
  return readHostedReadonlyColdCandidateHistory(fence,binding,evidence.candidate);
}
/** The immutable pre-eviction candidate is history, independently of a current
 * V2 enrollment. It cannot authorize the current Retired owner by itself. */
export function readHostedReadonlyColdCandidateHistory(fence:HostedActivationFence,binding:HostedDependencyBinding,
  c:DependencyReadonlyColdBaselineAdoptionEvidence["candidate"]) {
  assertHostedActivationFence(fence);const slot=c.generationBaseline;
  if(binding.version!==2 || c.jobId!==binding.jobId || slot.kind!==DependencyGenerationContinuityKind.BaselineAuthenticatedV1)held();
  const pins:ReturnType<typeof pinReferenceFile>[]=[];
  const reference=(expected:unknown,path:string,maximum=16384)=>{
    if(!isDependencyProtectedReference(expected) || expected.path!==path)held();
    const pin=pinReferenceFile(path,maximum);if(!sameDependencyProtectedReference(pin.reference,expected))held();pins.push(pin);return pin;
  };
  const bindingPin=reference(c.binding,`${root}/${hostedDependencyBindingName(binding.jobId)}`);
  if(!bindingPin.bytes.equals(encode(binding)))held();
  const baseline=reference(slot.baseline,`${root}/dependency-generation-baselines/${slot.operationId}.json`,65536),v:unknown=JSON.parse(baseline.bytes.toString("utf8")),
    committed=readHostedDependencyCommittedReady(binding,slot.readyRevision),ready=committed.receipt;
  if(!isDependencyCustodyObject(v,"actors,attempt,barrier,binding,inputClosureDigest,installerMappingSha256,ready,readyReference,version") ||
      v.version!==1 || !baseline.bytes.equals(encode(v)) || !encode(v.binding).equals(encode(binding)) || !encode(v.ready).equals(encode(ready)) ||
      !encode(v.readyReference).equals(encode(committed.reference)) || !sameDependencyProtectedReference(committed.reference,slot.previousReady) ||
      ready.generation!==slot.generation || ready.provenance.kind!==DependencyInstallProofKind.CompletedLocalInstallV1 ||
      !sameDependencyProtectedReference(ready.provenance.sourceBinding,c.sourceMapping))held();
  reference(slot.writerBarrier,`${root}/dependency-generation-barriers/${slot.operationId}.json`);
  if(!encode(v.barrier).equals(encode(slot.writerBarrier)))held();
  reference(c.sourceMapping,ready.provenance.sourceBinding.path,262144);
  const closure=reference(c.sourceClosed,`${root}/dependency-generation-source-closures/${c.closedStartId}.json`,65536),closed:unknown=JSON.parse(closure.bytes.toString("utf8"));
  if(!isDependencyCustodyObject(closed,"attempt,barrier,baseline,binding,final,pending,retirement,version") || closed.version!==1 ||
      !closure.bytes.equals(encode(closed)) || !encode(closed.binding).equals(encode(binding)) ||
      !encode(closed.baseline).equals(encode(slot.baseline)) || !encode(closed.barrier).equals(encode(slot.writerBarrier)))held();
  const final=parseScopedOrdinaryReaderFinalReceipt(closed.final);
  if(final.reader.startId!==c.closedStartId || final.reader.unit!==`subscription-runtime-ordinary-${c.closedStartId}.service` ||
      !isDependencyCustodyObject(closed.attempt,"attemptId,epoch,launch") || closed.attempt.attemptId!==final.attempt.attemptId ||
      closed.attempt.epoch!==final.attempt.epoch)held();
  if(!isDependencyProtectedReference(c.idle))held();
  const consumerPath=`${root}/dependency-generation-idle-closures/${binding.workspace.dev}-${binding.workspace.ino}/`,
    maintenancePath=`${root}/dependency-generation-maintenance/${binding.workspace.dev}-${binding.workspace.ino}-`;
  if(!c.idle.path.startsWith(consumerPath) && !c.idle.path.startsWith(maintenancePath))held();
  const idlePin=reference(c.idle,c.idle.path),idle:unknown=JSON.parse(idlePin.bytes.toString("utf8"));
  if(isDependencyCustodyObject(idle,"attempt,binding,previousOwnerSha256,releasedOwner,releasedOwnerSha256,sourceClosed,version")) {
    if(idle.version!==1 || !idlePin.bytes.equals(encode(idle)) || !encode(idle.binding).equals(encode(binding)) || !encode(idle.attempt).equals(encode(closed.attempt)) ||
        !encode(idle.sourceClosed).equals(encode(c.sourceClosed)))held();
    const owner=parseDependencyOwner(idle.releasedOwner);
    if(owner.version!==2 || owner.owner || owner.epoch!==final.attempt.epoch || !encode(owner.workspace).equals(encode(binding.workspace)) ||
        !encode(owner.generationContinuity).equals(encode(slot)) || c.idle.path!==`${consumerPath}${owner.revision}.json` ||
        idle.releasedOwnerSha256!==createHash("sha256").update(encode(owner)).digest("hex"))held();
  }else if(isDependencyCustodyObject(idle,"fenced,operation,released,version")) {
    if(idle.version!==1 || !idlePin.bytes.equals(encode(idle)))held();const owner=parseDependencyOwner(idle.released),fenced=parseDependencyOwner(idle.fenced);
    if(owner.version!==2 || owner.owner || fenced.version!==2 || fenced.owner?.kind!==DependencyOwnerKind.Maintenance || fenced.owner.phase!==DependencyOwnerPhase.Fenced ||
        !encode(owner).equals(encode(parseDependencyOwner({...fenced,revision:fenced.revision+1,owner:null}))) ||
        !encode(owner.workspace).equals(encode(binding.workspace)) || !encode(owner.generationContinuity).equals(encode(slot)) ||
        c.idle.path!==`${maintenancePath}${owner.revision}.idle.json`)held();
    const operation=reference(idle.operation,`${root}/dependency-generation-maintenance/${fenced.owner.attempt.operationId}.json`,65536),o:unknown=JSON.parse(operation.bytes.toString("utf8"));
    if(!isDependencyCustodyObject(o,"binding,claimed,idle,previous,sourceClosed,version") || o.version!==1 || !operation.bytes.equals(encode(o)) ||
        !encode(o.binding).equals(encode(binding)) || !encode(o.sourceClosed).equals(encode(c.sourceClosed)))held();
    const previous=parseDependencyOwner(o.previous),claimed=parseDependencyOwner(o.claimed);
    if(previous.version!==2 || previous.owner || claimed.version!==2 || claimed.owner?.kind!==DependencyOwnerKind.Maintenance ||
        claimed.owner.phase!==DependencyOwnerPhase.ExclusiveMutation || !encode(claimed.owner.attempt).equals(encode(fenced.owner.attempt)) ||
        !encode(claimed).equals(encode(parseDependencyOwner({...previous,revision:previous.revision+1,epoch:previous.epoch+1,owner:claimed.owner}))) ||
        !encode(fenced).equals(encode(parseDependencyOwner({...claimed,revision:claimed.revision+1,owner:{...claimed.owner,phase:DependencyOwnerPhase.Fenced}}))) ||
        !encode(previous.generationContinuity).equals(encode(slot)))held();
  }else held();
  for(const pin of pins)if(!sameDependencyProtectedReference(pinReferenceFile(pin.reference.path,pin.bytes.length).reference,pin.reference))held();
  assertHostedActivationFence(fence);return committed;
}
