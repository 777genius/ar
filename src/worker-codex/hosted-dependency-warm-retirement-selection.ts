import { DependencyGenerationContinuityKind, DependencyOwnerPhase, isDependencyConsumerOwner, parseDependencyGenerationContinuityInvalidation, sameDependencyAttempt, sameDependencyTree } from "@vioxen/subscription-runtime/core";
import { DependencyReceiptState, DependencyUnverifiedReason } from "@vioxen/subscription-runtime/worker-core";
import type { HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { CurrentHostedDependencyOriginKind, assertCurrentHostedDependencyAttempt, findOriginalHostedDependencyGenerationEntry,
  readOriginalHostedDependencyRetirementOwner, type CurrentHostedDependencyOrigin } from "./hosted-current-dependency-origin";
import { HostedDependencyWarmRetirementPhase } from "./hosted-dependency-warm-retirement-state";
import { readHostedDependencyEstablishedReceipt, readHostedDependencyExistingCommittedReady } from "./hosted-dependency-receipts";
import { readOriginalHostedDependencyWarmBaseline } from "./hosted-dependency-generation-baseline-reader";
import { assertHostedDependencyKeyInputsCurrent } from "./hosted-dependency-materialization-context";
import { readHostedDependencyRootDirectoryPin } from "./hosted-dependency-root-physical-facts";
import { freezeFacts } from "./hosted-dependency-immutable-facts";
const encode=(v:unknown)=>Buffer.from(JSON.stringify(v)+"\n");
function held():never{throw new Error("hosted_dependency_current_origin_unresolved");}
/** Captures facts only inside the existing original map. Missing Active and
 * actual changed input closure are distinct reasons; no reason DTO is accepted. */
export function captureOriginalHostedDependencyWarmRetirementFacts(context:CurrentHostedDependencyOrigin,fence:HostedActivationFence,access:symbol) {
  const retained=findOriginalHostedDependencyGenerationEntry(context,access);
  if(retained.warmRetirement)return retained.warmRetirement;
  const actual=assertCurrentHostedDependencyAttempt(context,fence,DependencyOwnerPhase.ExclusiveMutation),{binding,attempt}=actual;
  if(binding.version!==2 || retained.cold || retained.rootPurpose || actual.facts.kind===CurrentHostedDependencyOriginKind.Ordinary && !retained.ordinaryAdmitted)held();
  const owner=readOriginalHostedDependencyRetirementOwner(binding,access);
  if(owner.version===1 || !isDependencyConsumerOwner(owner.owner) || !sameDependencyAttempt(owner.owner.attempt,attempt))held();
  const receipt=readHostedDependencyEstablishedReceipt(binding);if(!receipt || receipt.state!==DependencyReceiptState.Ready)held();
  let reason:DependencyUnverifiedReason.BaselineMissing|DependencyUnverifiedReason.InputsChanged=DependencyUnverifiedReason.BaselineMissing;
  if(owner.generationContinuity?.kind===DependencyGenerationContinuityKind.BaselineAuthenticatedV1) {
    const baseline=readOriginalHostedDependencyWarmBaseline(context,fence,access),inputs=retained.generation?.inputs;
    if(!baseline || !inputs)held();assertHostedDependencyKeyInputsCurrent(binding,inputs);
    if(inputs.key.installKey===baseline.ready.receipt.installKey && inputs.capture.closureDigest===baseline.pins.baseline.inputClosureDigest)held();
    reason=DependencyUnverifiedReason.InputsChanged;
  } else if(owner.generationContinuity) {
    const slot=parseDependencyGenerationContinuityInvalidation(owner.generationContinuity);if(slot.readyRevision>=receipt.revision)held();
  }
  const ready=readHostedDependencyExistingCommittedReady(fence,binding,receipt.revision),tree=readHostedDependencyRootDirectoryPin(binding.workspace.canonicalPath+"/node_modules");
  if(!encode(ready.receipt).equals(encode(receipt)) || !sameDependencyTree(tree,receipt.tree))held();
  const after=assertCurrentHostedDependencyAttempt(context,fence,DependencyOwnerPhase.ExclusiveMutation);
  if(!sameDependencyAttempt(after.attempt,attempt) || !encode(readOriginalHostedDependencyRetirementOwner(binding,access)).equals(encode(owner)))held();
  return retained.warmRetirement={phase:HostedDependencyWarmRetirementPhase.Captured,binding,attempt:freezeFacts(attempt),owner:freezeFacts(owner),ready:freezeFacts(ready),reason};
}
