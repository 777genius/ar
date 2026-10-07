import { DependencyOwnerPhase, isDependencyConsumerOwner, sameDependencyAttempt, sameDependencyProtectedReference } from "@vioxen/subscription-runtime/core";
import { HostedDependencyRootOriginKind, type HostedDependencyRootScope, type HostedDependencyRootPreparationRecord } from "../provider-codex/app-server/adapters/hosted-dependency-root-purpose-record";
import { CurrentHostedDependencyOriginKind, type assertCurrentHostedDependencyAttempt } from "./hosted-current-dependency-origin";
import type { parseDependencyOwner } from "@vioxen/subscription-runtime/core";
import type { readHostedOrdinaryDependencyReaderEntry } from "./hosted-ordinary-dependency-reader";
import { freezeFacts } from "./hosted-dependency-immutable-facts";
function invalid():never { throw new Error("hosted_dependency_current_origin_unresolved"); }
/** Pure factual projection only; original map independently resolves actual
 * owner/preparation/entry before/after. This value is not a purpose or permit. */
export function formHostedDependencyRootScopeFacts(actual:ReturnType<typeof assertCurrentHostedDependencyAttempt>,
  owner:ReturnType<typeof parseDependencyOwner>,record:HostedDependencyRootPreparationRecord,phase:DependencyOwnerPhase,
  identity:Readonly<{logicalTaskId:string;executionJobId:string}>,entry?:ReturnType<typeof readHostedOrdinaryDependencyReaderEntry>):HostedDependencyRootScope {
  const {binding,attempt,facts}=actual;
  if (!isDependencyConsumerOwner(owner.owner) || !sameDependencyAttempt(owner.owner.attempt,attempt) || owner.owner.phase!==phase || !sameDependencyAttempt(attempt,record.attempt)) invalid();
  const common={logicalJobId:binding.jobId,logicalTaskId:identity.logicalTaskId,executionJobId:identity.executionJobId,
    jobRootDir:binding.jobRootDir,workspace:binding.workspace,attempt,ownerRevision:owner.revision};
  if (facts.kind===CurrentHostedDependencyOriginKind.ManagedReadonlyLocal) {
    if (owner.version!==3 || (record.version!==2 && record.version!==4) || !sameDependencyProtectedReference(owner.custodyBinding,record.custodyReference)) invalid();
    return freezeFacts({...common,originKind:HostedDependencyRootOriginKind.ManagedReadonlyLocalV1,custodyReference:owner.custodyBinding});
  }
  if (owner.version!==2 || (record.version!==3 && record.version!==5) || !entry || !sameDependencyProtectedReference(entry.origin,record.originReference) ||
      !sameDependencyProtectedReference(entry.producer,record.readerProducer) || !sameDependencyProtectedReference(entry.entry,record.readerEntry)) invalid();
  return freezeFacts({...common,originKind:HostedDependencyRootOriginKind.OrdinaryDependencyReaderV1,originReference:entry.origin,readerProducer:entry.producer,readerEntry:entry.entry});
}
