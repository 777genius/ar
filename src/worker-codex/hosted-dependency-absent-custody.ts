import { DependencyGenerationContinuityKind, DependencyOwnerKind, isDependencyCustodyObject, isDependencyProtectedReference,
  parseDependencyOwner, sameDependencyProtectedReference, type DependencyProtectedReference, type DependencyReadonlyColdBaselineAdoptionEvidence } from "@vioxen/subscription-runtime/core";
import { assertHostedActivationFence, assertHostedActivationOperator, type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { assertHostedProcessDescriptors } from "../provider-codex/app-server/adapters/hosted-process-descriptors";
import { readHostedDependencyBinding, hostedDependencyBindingName } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { assertOriginalHostedDependencyPhysicalRecordAccess } from "./hosted-current-dependency-origin";
import { readOriginalHostedDependencyRemovalIdle, readOriginalHostedDependencyRemovalRelease } from "./hosted-dependency-removal-history";
import { readHostedReadonlyColdCandidateHistory } from "./hosted-readonly-cold-custody-history";
import { readOriginalHostedDependencyOperatorPriorCSourceClosure } from "./hosted-dependency-generation-prior-closure";
import { readOriginalHostedDependencyOperatorNativeCensus } from "./hosted-dependency-generation-native-census";
import { readHostedDependencyActiveActorFacts } from "./hosted-dependency-active-actor-facts";
import { pinReferenceFile, encodeReference as encode } from "./hosted-dependency-legacy-reference-records";
import { readHostedDependencyCommittedReady } from "./hosted-dependency-receipts";
import { DependencyInstallProofKind } from "@vioxen/subscription-runtime/worker-core";
const root="/var/lib/subscription-runtime-host-policy";
function held():never{throw new Error("hosted_dependency_absent_custody_held");}
function same(a:unknown,b:unknown):boolean{return encode(a).equals(encode(b));}
function boundary(fence:HostedActivationFence,access:symbol) {assertOriginalHostedDependencyPhysicalRecordAccess(access);assertHostedActivationFence(fence);assertHostedActivationOperator();assertHostedProcessDescriptors();}
/** Candidate retains the PRE-EVICTION Baseline and idle. Removal release stays
 * a separate current admission proof; Retired is never relabeled Baseline. */
export function readOriginalHostedDependencyAbsentCandidate(fence:HostedActivationFence,release:DependencyProtectedReference,access:symbol) {
  boundary(fence,access);const removal=readOriginalHostedDependencyRemovalRelease(fence,release,access),claim=removal.claim,
    binding=readHostedDependencyBinding(claim.binding.jobId);if(!binding || !same(binding,claim.binding) || binding.version!==2)held();
  const releasePin=pinReferenceFile(claim.originalIdle.path,16384),idle:unknown=JSON.parse(releasePin.bytes.toString("utf8"));
  if(!sameDependencyProtectedReference(releasePin.reference,claim.originalIdle) || !isDependencyCustodyObject(idle,"fenced,operation,released,version") || idle.version!==1 ||
    !releasePin.bytes.equals(encode(idle)) || !isDependencyProtectedReference(idle.operation))held();
  const operation=pinReferenceFile(`${root}/dependency-generation-maintenance/${claim.absent.receipt.operationId}.json`,65536),o:unknown=JSON.parse(operation.bytes.toString("utf8"));
  if(!sameDependencyProtectedReference(operation.reference,idle.operation) || !isDependencyCustodyObject(o,"binding,claimed,idle,previous,sourceClosed,version") || o.version!==1 ||
    !operation.bytes.equals(encode(o)) || !same(o.binding,binding) || !same(o.sourceClosed,claim.sourceClosed) || !isDependencyProtectedReference(o.idle))held();
  const previous=parseDependencyOwner(o.previous),claimed=parseDependencyOwner(o.claimed);if(previous.version!==2)held();const slot=previous.generationContinuity;
  if(previous.version!==2 || previous.owner || slot?.kind!==DependencyGenerationContinuityKind.BaselineAuthenticatedV1 ||
    claimed.owner?.kind!==DependencyOwnerKind.Maintenance || claimed.owner.attempt.operationId!==claim.absent.receipt.operationId ||
    !same(claimed.workspace,binding.workspace))held();
  const match=/\/dependency-generation-source-closures\/([a-f0-9-]{36})\.json$/.exec(claim.sourceClosed.path);if(!match)held();
  const ready=readHostedDependencyCommittedReady(binding,slot.readyRevision);
  if(ready.receipt.provenance.kind!==DependencyInstallProofKind.CompletedLocalInstallV1)held();
  const candidate:DependencyReadonlyColdBaselineAdoptionEvidence["candidate"]={jobId:binding.jobId,binding:pinReferenceFile(`${root}/${hostedDependencyBindingName(binding.jobId)}`,16384).reference,
    closedStartId:match[1]!,generationBaseline:slot,idle:o.idle,sourceClosed:claim.sourceClosed,sourceMapping:ready.receipt.provenance.sourceBinding};
  readHostedReadonlyColdCandidateHistory(fence,binding,candidate);
  if(!readOriginalHostedDependencyOperatorPriorCSourceClosure(fence,`subscription-runtime-ordinary-${candidate.closedStartId}.service`,access) ||
    !readHostedDependencyActiveActorFacts(fence,access) || !readOriginalHostedDependencyOperatorNativeCensus(fence,access))held();
  boundary(fence,access);return {binding,ready,candidate,previous:removal.previous,removalRelease:removal.idle,priorAbsent:removal.priorAbsent};
}
export function selectOriginalHostedDependencyAbsentCustodyCandidate(fence:HostedActivationFence,jobId:string,access:symbol) {
  boundary(fence,access);const binding=readHostedDependencyBinding(jobId);if(!binding || binding.version!==2)held();
  const removal=readOriginalHostedDependencyRemovalIdle(fence,binding.workspace,access);if(!removal)held();
  return readOriginalHostedDependencyAbsentCandidate(fence,removal.idle,access);
}
