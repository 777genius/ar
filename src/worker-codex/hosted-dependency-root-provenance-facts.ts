import { DependencyToolExecutionBasis, type DependencyToolAdmissionQualification } from "../core/dependency-environment/dependency-tool-execution";
import { DependencyReceiptState } from "../worker-core/dependency-environment/domain/dependency-receipt";
import { decodeHostedActivationBytes } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { dirname } from "node:path";
import { sameDependencyWorkspace, sameDependencyAttempt, sameDependencyProtectedReference, type DependencyProtectedReference, type DependencyAttempt } from "@vioxen/subscription-runtime/core";
import type { HostedDependencyBinding } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import type { HostedDependencyRootPreparationRecord, HostedDependencyRootDirectoryPin } from "../provider-codex/app-server/adapters/hosted-dependency-root-purpose-record";
import { DependencyToolReadyProvenanceKind, matchesDependencyToolReadyIdentity } from "../core/dependency-environment/dependency-tool-ready-reader";
import type { LocalDependencyReceiptStore } from "../store-local-file/dependency-environment/local-dependency-receipt-store";
import { readHostedDependencyRootDirectoryPin } from "./hosted-dependency-root-physical-facts";
const encode = (value:unknown) => Buffer.from(JSON.stringify(value)+"\n");
function invalid():never { throw new Error("hosted_dependency_current_origin_unresolved"); }
function assertDirectory(pin:HostedDependencyRootDirectoryPin):void {
  if (!pin || Object.keys(pin).sort().join(",") !== "canonicalPath,dev,ino,mountId" ||
      !encode(readHostedDependencyRootDirectoryPin(pin.canonicalPath)).equals(encode(pin))) invalid();
}
// Validators return no root authority and own no context, resource or producer registration.
export function assertRootQualificationFacts(record:HostedDependencyRootPreparationRecord,binding:HostedDependencyBinding,
  attempt:DependencyAttempt,q:DependencyToolAdmissionQualification,ready:ReturnType<LocalDependencyReceiptStore["getCommittedReady"]>["receipt"]|ReturnType<LocalDependencyReceiptStore["getCommittedUnverified"]>["receipt"]):void {
  if(record.version===4 || record.version===5) {
    if(q.version!==2 || ready.state!==DependencyReceiptState.Unverified || q.execution.basis!==DependencyToolExecutionBasis.UsableUnverified ||
      !encode(q.execution).equals(encode(record.execution)) || q.execution.receiptRevision!==record.unverifiedRevision ||
      ready.revision!==record.unverifiedRevision || !sameDependencyProtectedReference(q.execution.receipt,record.unverified) ||
      q.execution.installationId!==binding.installationId || q.execution.runtimeSha!==binding.runtimeSha || q.execution.grantDigest!==binding.grantDigest ||
      q.execution.attemptId!==attempt.attemptId || q.execution.startId!==attempt.launch.startId || q.execution.epoch!==attempt.epoch ||
      !sameDependencyWorkspace(q.execution.workspace,binding.workspace) || ready.tree.dev!==q.execution.tree.dev || ready.tree.ino!==q.execution.tree.ino ||
      record.generatedRoots[0]?.dev!==q.execution.tree.dev || record.generatedRoots[0]?.ino!==q.execution.tree.ino ||
      record.authoredRoots[0]?.canonicalPath!==binding.workspace.canonicalPath ||
      !encode(q.execution.sourceRoots.map(source=>({canonicalPath:source.canonicalPath,dev:source.identity.dev,ino:source.identity.ino}))).equals(
        encode(record.authoredRoots.slice(1).map(pin=>({canonicalPath:pin.canonicalPath,dev:pin.dev,ino:pin.ino})))) ||
      !encode(q.execution.sourceLookupAncestors).equals(encode(record.sourceLookupAncestors.map(pin=>({canonicalPath:pin.canonicalPath,identity:{dev:pin.dev,ino:pin.ino}})))))invalid();
    return;
  }
  if(q.version!==1 || ready.state!==DependencyReceiptState.Ready)invalid();
  if (q.attemptId !== attempt.attemptId || q.epoch !== attempt.epoch || q.startId !== attempt.launch.startId || q.readyRevision !== record.readyRevision ||
      !sameDependencyWorkspace(q.workspace,binding.workspace) || q.tree.dev !== record.generatedRoots[0]!.dev || q.tree.ino !== record.generatedRoots[0]!.ino) invalid();
  const providerReady = record.providerReady;
  if (!matchesDependencyToolReadyIdentity({workspace:ready.workspace,coverageRevision:ready.coverageRevision,revision:ready.revision,
      installKey:ready.installKey,tree:ready.tree,manifestDigest:ready.manifestDigest},providerReady) ||
      record.authoredRoots[0]?.canonicalPath !== binding.workspace.canonicalPath) invalid();
  switch (providerReady.provenance.kind) {
    case DependencyToolReadyProvenanceKind.RegistryCompleted:
      if (record.version !== 3 || record.authoredRoots.length !== 1) invalid(); break;
    case DependencyToolReadyProvenanceKind.LocalCompleted:
    case DependencyToolReadyProvenanceKind.LocalCompared:
      if (!encode(providerReady.provenance.readonlySources.map(source => ({canonicalPath:source.canonicalPath,
        dev:source.identity.dev,ino:source.identity.ino}))).equals(encode(record.authoredRoots.slice(1).map(pin => ({canonicalPath:pin.canonicalPath,dev:pin.dev,ino:pin.ino}))))) invalid(); break;
    default: invalid();
  }
}
export function assertRootConfigAncestorFacts(record:HostedDependencyRootPreparationRecord,binding:HostedDependencyBinding):void {
  if (!Array.isArray(record.configAncestors) || record.configAncestors.length < 2 || record.configAncestors.length > 128) invalid();
  let parent = `${binding.workspace.canonicalPath}/.git`;
  for (const pin of record.configAncestors) { if (pin.canonicalPath !== parent) invalid(); assertDirectory(pin); parent = dirname(parent); }
  if (record.configAncestors.at(-1)?.canonicalPath !== "/") invalid();
}

export function parseRootPreparationFacts(bytes:Buffer,attempt:DependencyAttempt,custody:DependencyProtectedReference):Extract<HostedDependencyRootPreparationRecord,{version:2|4}> {
  const record=decodeHostedActivationBytes(bytes) as Extract<HostedDependencyRootPreparationRecord,{version:2|4}>;
  const common="attempt,authoredRoots,config,configAncestors,custodyReference,durableHandoffRoot,generatedRoots,protectedProfile,qualification,scratchParent,sourceLookupAncestors,version";
  if(!record || (record.version!==2 && record.version!==4) || !encode(record).equals(bytes) ||
    Object.keys(record).sort().join(",")!==[...common.split(","),...(record.version===2?["providerReady","ready","readyRevision"]:["execution","unverified","unverifiedRevision"])].sort().join(",") ||
    !sameDependencyAttempt(record.attempt,attempt) || !sameDependencyProtectedReference(record.custodyReference,custody))invalid();
  return record;
}
/** Genuine C lineage remains distinct from permanent R custody. */
export function parseOrdinaryRootPreparationFacts(bytes:Buffer,attempt:DependencyAttempt,
  expected:Readonly<{origin:DependencyProtectedReference;producer:DependencyProtectedReference;entry:DependencyProtectedReference}>):Extract<HostedDependencyRootPreparationRecord,{version:3|5}> {
  const record=decodeHostedActivationBytes(bytes) as Extract<HostedDependencyRootPreparationRecord,{version:3|5}>;
  const common="attempt,authoredRoots,config,configAncestors,durableHandoffRoot,generatedRoots,originReference,protectedProfile,qualification,readerEntry,readerProducer,scratchParent,sourceLookupAncestors,version";
  if(!record || (record.version!==3 && record.version!==5) || !encode(record).equals(bytes) ||
    Object.keys(record).sort().join(",")!==[...common.split(","),...(record.version===3?["providerReady","ready","readyRevision"]:["execution","unverified","unverifiedRevision"])].sort().join(",") ||
    !sameDependencyAttempt(record.attempt,attempt) || !sameDependencyProtectedReference(record.originReference,expected.origin) ||
    !sameDependencyProtectedReference(record.readerProducer,expected.producer) || !sameDependencyProtectedReference(record.readerEntry,expected.entry))invalid();
  return record;
}
