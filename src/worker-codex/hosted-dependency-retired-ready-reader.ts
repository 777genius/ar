import { DependencyToolReadyReadStatus } from "../core/dependency-environment/dependency-tool-ready-reader";
import { DependencyReceiptState } from "@vioxen/subscription-runtime/worker-core";
import { DependencyOwnerPhase, sameDependencyAttempt, sameDependencyProtectedReference, parseDependencyGenerationContinuityInvalidation } from "@vioxen/subscription-runtime/core";
import { LocalDependencyReceiptStore } from "../store-local-file/dependency-environment/local-dependency-receipt-store";
import { hostedDependencyReceiptHistoryRoot } from "../provider-codex/app-server/adapters/hosted-dependency-history-path";
import type { HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import type { HostedDependencyRootScope } from "../provider-codex/app-server/adapters/hosted-dependency-root-purpose-record";
import { assertCurrentHostedDependencyAttempt, readOriginalHostedDependencySourceCleanupScope, readOriginalHostedDependencyRetirementOwner, type HostedDependencyRootPurposeContext } from "./hosted-current-dependency-origin";
import { assertHostedDependencyRetirementOwnerFacts } from "./hosted-dependency-retirement-facts";
const encode=(value:unknown)=>Buffer.from(JSON.stringify(value)+"\n");
function invalid():never{throw new Error("hosted_dependency_current_origin_unresolved");}
export function assertOriginalHostedDependencyRetiredReady(context:HostedDependencyRootPurposeContext,fence:HostedActivationFence,access:symbol):HostedDependencyRootScope {
  const held=readOriginalHostedDependencySourceCleanupScope(context,fence,access);
  if(held.state.admission!==DependencyToolReadyReadStatus.Ready)invalid();
  assertHostedDependencyRetirementOwnerFacts(held.state.record,held.owner);
  if (held.owner.version === 1 || !held.owner.generationContinuity) invalid();
  const slot = parseDependencyGenerationContinuityInvalidation(held.owner.generationContinuity), ready = held.state.ready;
  const store = LocalDependencyReceiptStore.open({rootPath:hostedDependencyReceiptHistoryRoot,maxRecordBytes:16384,maxHistorySteps:2048});
  try {
    const current = store.read(held.actual.binding.workspace);
    if (!current || current.state !== DependencyReceiptState.Unverified || current.revision !== ready.receipt.revision+1 || current.generation !== ready.receipt.generation ||
        slot.operationId !== held.actual.attempt.attemptId || slot.readyRevision !== ready.receipt.revision || slot.unverifiedRevision !== current.revision ||
        slot.generation !== ready.receipt.generation || !sameDependencyProtectedReference(slot.previousReady,ready.reference)) invalid();
    const previous = store.getCommittedReady(held.actual.binding.workspace,ready.receipt.revision), retired = store.getCommittedUnverified(held.actual.binding.workspace,current.revision);
    if (!encode(previous).equals(encode(ready)) || !encode(retired.receipt).equals(encode(current)) || !sameDependencyProtectedReference(retired.reference,slot.retiredUnverified)) invalid();
  } finally { store.close(); }
  const after = assertCurrentHostedDependencyAttempt(held.origin,fence,DependencyOwnerPhase.ExclusiveMutation);
  if (!sameDependencyAttempt(after.attempt,held.actual.attempt) || !encode(readOriginalHostedDependencyRetirementOwner(after.binding,access)).equals(encode(held.owner))) invalid();
  return held.scope;
}
