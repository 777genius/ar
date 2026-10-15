import { DependencyGenerationContinuityKind, isDependencyConsumerOwner, isDependencyCustodyObject, parseDependencyGenerationContinuity,
  parseDependencyGenerationContinuityInvalidation, parseDependencyOwner, sameDependencyAttempt, sameDependencyProtectedReference,
  type DependencyAttempt, type DependencyOwnerRecord } from "@vioxen/subscription-runtime/core";
import { DependencyUnverifiedReason } from "@vioxen/subscription-runtime/worker-core";
import { assertHostedActivationFence, type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import type { HostedDependencyBinding } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { assertOriginalHostedDependencyPhysicalRecordAccess } from "./hosted-current-dependency-origin";
import { pinReferenceFile } from "./hosted-dependency-legacy-reference-records";
import { readHostedDependencyExistingCommittedReady, readHostedDependencyExistingCommittedUnverified } from "./hosted-dependency-receipts";
const encode=(v:unknown)=>Buffer.from(JSON.stringify(v)+"\n");
function held():never{throw new Error("hosted_dependency_retired_interval_unresolved");}
/** Consume an original fixed retirement, never synthesize one from Terminal,
 * missing files or current process absence. Native/source closure is separate. */
export function readOriginalHostedDependencyRetiredInterval(fence:HostedActivationFence,attempt:DependencyAttempt,
  binding:HostedDependencyBinding,owner:DependencyOwnerRecord,access:symbol) {
  assertOriginalHostedDependencyPhysicalRecordAccess(access);assertHostedActivationFence(fence);
  if(owner.version===1 || owner.generationContinuity?.kind!==DependencyGenerationContinuityKind.RetiredReadyV1)held();
  const pin=pinReferenceFile(`/var/lib/subscription-runtime-host-policy/dependency-generation-retired-intervals/${attempt.launch.startId}.json`,16384),
    value:unknown=JSON.parse(pin.bytes.toString("utf8"));
  if(!isDependencyCustodyObject(value,"active,attempt,binding,retiredOwner,version") || value.version!==1 || !pin.bytes.equals(encode(value)) ||
    !encode(value.attempt).equals(encode(attempt)) || !encode(value.binding).equals(encode(binding)))held();
  const previous=parseDependencyOwner(value.retiredOwner),slot=parseDependencyGenerationContinuity(value.active),retired=parseDependencyGenerationContinuityInvalidation(owner.generationContinuity);
  if(previous.version===1 || !isDependencyConsumerOwner(previous.owner) || !sameDependencyAttempt(previous.owner.attempt,attempt) ||
    !encode(previous.generationContinuity).equals(encode(retired)) || previous.epoch!==owner.epoch || owner.revision<previous.revision ||
    slot.kind!==DependencyGenerationContinuityKind.BaselineAuthenticatedV1 || retired.operationId!==attempt.attemptId ||
    retired.readyRevision!==slot.readyRevision || retired.generation!==slot.generation || !sameDependencyProtectedReference(retired.previousReady,slot.previousReady))held();
  const ready=readHostedDependencyExistingCommittedReady(fence,binding,slot.readyRevision),unverified=readHostedDependencyExistingCommittedUnverified(fence,binding,retired.unverifiedRevision);
  if(!sameDependencyProtectedReference(ready.reference,slot.previousReady) || !sameDependencyProtectedReference(unverified.reference,retired.retiredUnverified) ||
    unverified.receipt.reason!==DependencyUnverifiedReason.InputsChanged || unverified.receipt.generation!==ready.receipt.generation ||
    unverified.receipt.tree.dev!==ready.receipt.tree.dev || unverified.receipt.tree.ino!==ready.receipt.tree.ino)held();
  assertHostedActivationFence(fence);return {slot,retired,reference:pin.reference};
}
