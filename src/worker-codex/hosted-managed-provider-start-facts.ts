import { CurrentHostedDependencyOriginKind, type assertCurrentHostedDependencyAttempt } from "./hosted-current-dependency-origin";
import type { HostedDependencyRootPreparationRecord } from "../provider-codex/app-server/adapters/hosted-dependency-root-purpose-record";
import type { LocalDependencyReceiptStore } from "../store-local-file/dependency-environment/local-dependency-receipt-store";
import { freezeFacts } from "./hosted-dependency-immutable-facts";
// Immutable serialization facts only; no context, map, admission, native child or registration.
export function formManagedDependencyProviderStartFacts(actual:ReturnType<typeof assertCurrentHostedDependencyAttempt>,
  providerStartId:string,record:HostedDependencyRootPreparationRecord,ready:ReturnType<LocalDependencyReceiptStore["getCommittedReady"]>) {
  if (actual.facts.kind !== CurrentHostedDependencyOriginKind.ManagedReadonlyLocal) throw new Error("hosted_dependency_current_origin_unresolved");
  const facts = actual.facts, epoch = facts.epoch, unit = `subscription-runtime-hosted-${providerStartId}.service`;
  return freezeFacts({version:1 as const,installationId:actual.binding.installationId,runtimeSha:actual.binding.runtimeSha,
    hostId:epoch.hostId,bootId:epoch.bootId,supervisorId:epoch.supervisorId,generation:epoch.generation,unit,providerStartId,
    parentStartId:actual.attempt.launch.startId,logicalJobId:actual.binding.jobId,executionJobId:facts.start.readonlyJobId,
    jobRootDir:actual.binding.jobRootDir,workspace:actual.binding.workspace,attempt:actual.attempt,
    custodyReference:facts.association.reference,originReference:facts.originReference,ready:ready.reference,
    readyRevision:ready.receipt.revision,qualification:record.qualification,protectedProfile:record.protectedProfile});
}
