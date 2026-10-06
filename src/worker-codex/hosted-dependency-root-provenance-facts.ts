import { decodeHostedActivationBytes } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { dirname } from "node:path";
import { sameDependencyWorkspace, sameDependencyAttempt, sameDependencyProtectedReference, type DependencyProtectedReference, type DependencyAttempt } from "@vioxen/subscription-runtime/core";
import type { HostedDependencyBinding } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import type { HostedDependencyRootPreparationRecord, HostedDependencyRootDirectoryPin } from "../provider-codex/app-server/adapters/hosted-dependency-root-purpose-record";
import type { DependencyToolQualification } from "../core/dependency-environment/dependency-tool-profile";
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
  attempt:DependencyAttempt,q:DependencyToolQualification,ready:ReturnType<LocalDependencyReceiptStore["getCommittedReady"]>["receipt"]):void {
  if (q.attemptId !== attempt.attemptId || q.epoch !== attempt.epoch || q.startId !== attempt.launch.startId || q.readyRevision !== record.readyRevision ||
      !sameDependencyWorkspace(q.workspace,binding.workspace) || q.tree.dev !== record.generatedRoots[0]!.dev || q.tree.ino !== record.generatedRoots[0]!.ino) invalid();
  const providerReady = record.providerReady;
  if (!matchesDependencyToolReadyIdentity({workspace:ready.workspace,coverageRevision:ready.coverageRevision,revision:ready.revision,
      installKey:ready.installKey,tree:ready.tree,manifestDigest:ready.manifestDigest},providerReady) ||
      providerReady.provenance.kind === DependencyToolReadyProvenanceKind.RegistryCompleted ||
      !encode(providerReady.provenance.readonlySources.map(source => ({canonicalPath:source.canonicalPath,
        dev:source.identity.dev,ino:source.identity.ino}))).equals(encode(record.authoredRoots.slice(1).map(pin => ({canonicalPath:pin.canonicalPath,dev:pin.dev,ino:pin.ino}))))) invalid();
}
export function assertRootConfigAncestorFacts(record:HostedDependencyRootPreparationRecord,binding:HostedDependencyBinding):void {
  if (!Array.isArray(record.configAncestors) || record.configAncestors.length < 2 || record.configAncestors.length > 128) invalid();
  let parent = `${binding.workspace.canonicalPath}/.git`;
  for (const pin of record.configAncestors) { if (pin.canonicalPath !== parent) invalid(); assertDirectory(pin); parent = dirname(parent); }
  if (record.configAncestors.at(-1)?.canonicalPath !== "/") invalid();
}

export function parseRootPreparationFacts(bytes:Buffer,attempt:DependencyAttempt,custody:DependencyProtectedReference):HostedDependencyRootPreparationRecord {
  const record = decodeHostedActivationBytes(bytes) as HostedDependencyRootPreparationRecord;
  if (!record || Object.keys(record).sort().join(",") !== "attempt,authoredRoots,config,configAncestors,custodyReference,durableHandoffRoot,generatedRoots,protectedProfile,providerReady,qualification,ready,readyRevision,scratchParent,sourceLookupAncestors,version" ||
      record.version !== 2 || !encode(record).equals(bytes) || !sameDependencyAttempt(record.attempt,attempt) ||
      !sameDependencyProtectedReference(record.custodyReference,custody)) invalid(); return record;
}
