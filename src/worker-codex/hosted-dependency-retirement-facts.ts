import { sameDependencyProtectedReference, type DependencyOwnerRecord, type DependencyGenerationContinuityInvalidation } from "@vioxen/subscription-runtime/core";
import type { HostedDependencyRootPreparationRecord } from "../provider-codex/app-server/adapters/hosted-dependency-root-purpose-record";
import type { DependencyCommittedReadyReceipt } from "../worker-core/dependency-environment/ports/dependency-receipt-store";
const encode=(value:unknown)=>JSON.stringify(value);
function invalid():never { throw new Error("hosted_dependency_current_origin_unresolved"); }
/** Pure consistency only. The sole original-map producer independently holds
 * its current context/fence and compares the stores' captured actual owner. */
export function assertHostedDependencyRetirementOwnerFacts(record:HostedDependencyRootPreparationRecord,owner:DependencyOwnerRecord):void {
  if (record.version===2 || record.version===6) {
    if (owner.version!==3 || !sameDependencyProtectedReference(owner.custodyBinding,record.custodyReference)) invalid();
  } else if ((record.version!==3 && record.version!==7) || owner.version!==2) invalid();
}
export function assertHostedDependencyRetirementSuccessorFacts(record:HostedDependencyRootPreparationRecord,
  previousOwner:Extract<DependencyOwnerRecord,{version:2|3}>,proposedOwner:Extract<DependencyOwnerRecord,{version:2|3}>,
  invalidation:DependencyGenerationContinuityInvalidation,attemptId:string,ready:DependencyCommittedReadyReceipt):void {
  assertHostedDependencyRetirementOwnerFacts(record,previousOwner); assertHostedDependencyRetirementOwnerFacts(record,proposedOwner);
  if (proposedOwner.version!==previousOwner.version || proposedOwner.revision!==previousOwner.revision+1 ||
      encode(proposedOwner.owner)!==encode(previousOwner.owner) || proposedOwner.epoch!==previousOwner.epoch ||
      invalidation.operationId!==attemptId || invalidation.readyRevision!==ready.receipt.revision ||
      invalidation.unverifiedRevision!==ready.receipt.revision+1 || invalidation.generation!==ready.receipt.generation ||
      !sameDependencyProtectedReference(invalidation.previousReady,ready.reference)) invalid();
}
