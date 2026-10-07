import { HostedCustodyReservationState } from "../worker-core/hosted-custody/domain/hosted-custody-epoch";
import { CurrentHostedDependencyOriginKind, type assertCurrentHostedDependencyAttempt } from "./hosted-current-dependency-origin";
import { HostedDependencyRootOriginKind, type HostedDependencyRootPreparationRecord, type HostedDependencyManagedProviderFacts } from "../provider-codex/app-server/adapters/hosted-dependency-root-purpose-record";
import type { LocalDependencyReceiptStore } from "../store-local-file/dependency-environment/local-dependency-receipt-store";
import { freezeFacts } from "./hosted-dependency-immutable-facts";
// Immutable serialization facts only; no context, map, admission, native child or registration.
export function formManagedDependencyProviderStartFacts(actual:ReturnType<typeof assertCurrentHostedDependencyAttempt>,
  providerStartId:string,record:HostedDependencyRootPreparationRecord,committed:ReturnType<LocalDependencyReceiptStore["getCommittedReady"]>|ReturnType<LocalDependencyReceiptStore["getCommittedUnverified"]>) {
  if (actual.facts.kind !== CurrentHostedDependencyOriginKind.ManagedReadonlyLocal) throw new Error("hosted_dependency_current_origin_unresolved");
  const facts = actual.facts, epoch = facts.epoch, unit = `subscription-runtime-hosted-${providerStartId}.service`;
  const reservation = epoch.reservations.find(row => row.unit === unit);
  if (!reservation || reservation.startId !== providerStartId || reservation.creatorId !== providerStartId ||
      reservation.state !== HostedCustodyReservationState.Reserved || epoch.generation !== facts.start.generation ||
      epoch.identity.jobId !== facts.start.readonlyJobId || epoch.identity.workspacePath !== actual.binding.workspace.canonicalPath ||
      epoch.identity.jobRootDir !== actual.binding.jobRootDir) throw new Error("hosted_dependency_current_origin_unresolved");
  if(record.version!==2 && record.version!==4)throw new Error("hosted_dependency_current_origin_unresolved");
  if(JSON.stringify(committed.reference)!==JSON.stringify(record.version===2?record.ready:record.unverified))throw new Error("hosted_dependency_current_origin_unresolved");
  const common={installationId:actual.binding.installationId,runtimeSha:actual.binding.runtimeSha,
    hostId:epoch.hostId,bootId:epoch.bootId,supervisorId:epoch.supervisorId,generation:epoch.generation,unit,providerStartId,
    parentStartId:actual.attempt.launch.startId,logicalJobId:actual.binding.jobId,executionJobId:facts.start.readonlyJobId,
    jobRootDir:actual.binding.jobRootDir,workspace:actual.binding.workspace,attempt:actual.attempt,
    custodyReference:facts.association.reference,originReference:facts.originReference};
  const tail={qualification:record.qualification,protectedProfile:record.protectedProfile};
  if(record.version===2)return freezeFacts({version:1 as const,...common,ready:record.ready,readyRevision:record.readyRevision,...tail});
  return freezeFacts({version:3 as const,...common,execution:record.execution,unverified:record.unverified,unverifiedRevision:record.unverifiedRevision,...tail});
}

/** Closed C serialization facts only. Actual original-map caller authenticated
 * each selected reference/row/relation before invoking this pure projection. */
export function formOrdinaryDependencyProviderStartFacts(actual:ReturnType<typeof assertCurrentHostedDependencyAttempt>,
  selected:ReturnType<typeof import("../provider-codex/app-server/adapters/hosted-process-activation").readHostedOrdinaryProviderFacts>,
  ordinaryProviderReference:import("@vioxen/subscription-runtime/core").DependencyProtectedReference,
  record:Extract<HostedDependencyRootPreparationRecord,{version:3|5}>,committed:ReturnType<LocalDependencyReceiptStore["getCommittedReady"]>|ReturnType<LocalDependencyReceiptStore["getCommittedUnverified"]>):Extract<HostedDependencyManagedProviderFacts,{version:2|4}> {
  if (actual.facts.kind!==CurrentHostedDependencyOriginKind.Ordinary || !selected.relation) throw new Error("hosted_dependency_current_origin_unresolved");
  const {ordinary}=actual.facts;
  if(JSON.stringify(committed.reference)!==JSON.stringify(record.version===3?record.ready:record.unverified))throw new Error("hosted_dependency_current_origin_unresolved");
  const common={originKind:HostedDependencyRootOriginKind.OrdinaryDependencyReaderV1 as const,
    installationId:actual.binding.installationId,runtimeSha:actual.binding.runtimeSha,
    hostId:String(ordinary.activation.hostId),bootId:String(ordinary.activation.bootId),supervisorId:String(ordinary.activation.supervisorId),
    generation:Number(selected.reservation.generation),parentGeneration:Number(ordinary.reservation.generation),unit:selected.unit,providerStartId:selected.startId,
    parentStartId:actual.attempt.launch.startId,logicalJobId:actual.binding.jobId,executionJobId:actual.binding.jobId,
    jobRootDir:actual.binding.jobRootDir,workspace:actual.binding.workspace,attempt:actual.attempt,
    originReference:record.originReference,ordinaryProviderReference,readerProducer:record.readerProducer,readerEntry:record.readerEntry,
    ordinaryRelation:{version:1 as const,parentStartId:actual.attempt.launch.startId,attemptId:actual.attempt.attemptId,epoch:actual.attempt.epoch,
      providerStartId:selected.startId,startDigest:selected.startSha256,unit:selected.unit}};
  const tail={qualification:record.qualification,protectedProfile:record.protectedProfile};
  if(record.version===3)return freezeFacts({version:2 as const,...common,ready:record.ready,readyRevision:record.readyRevision,...tail});
  return freezeFacts({version:4 as const,...common,execution:record.execution,unverified:record.unverified,unverifiedRevision:record.unverifiedRevision,...tail});
}
