import { readHostedDependencyPendingPreservations } from "./hosted-dependency-preservation-handoff";
import { lstatSync } from "node:fs";
import { DependencyOwnerPhase, isDependencyConsumerOwner, sameDependencyAttempt, sameDependencyWorkspace,
  sameDependencyProtectedReference, parseDependencyGenerationContinuityInvalidation } from "@vioxen/subscription-runtime/core";
import { DependencyReceiptState, DependencyUnverifiedReason } from "@vioxen/subscription-runtime/worker-core";
import { LocalDependencyOwnerStore } from "../store-local-file/dependency-environment/local-dependency-owner-store";
import { LocalDependencyReceiptStore } from "../store-local-file/dependency-environment/local-dependency-receipt-store";
import { hostedDependencyReceiptHistoryRoot } from "../provider-codex/app-server/adapters/hosted-dependency-history-path";
import { hostedDependencyOwnerRoot } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import type { HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { assertCurrentHostedDependencyAttempt, type CurrentHostedDependencyOrigin } from "./hosted-current-dependency-origin";
import { readHostedDependencyEstablishedReceipt } from "./hosted-dependency-receipts";
import { readHostedDependencyRootDirectoryPin } from "./hosted-dependency-root-physical-facts";
const encode=(value:unknown)=>Buffer.from(JSON.stringify(value)+"\n");
function invalid():never {throw new Error("hosted_dependency_usable_receipt_unresolved");}
/** Read only, under the genuine current origin/fence. History and RetiredReady
 * are historical provenance; none of these facts attests current NM contents.
 * No store is initialized and every temporary FD closes before the final census.
 */
export function readHostedDependencyUsableReceipt(context:CurrentHostedDependencyOrigin,fence:HostedActivationFence,
  phase:DependencyOwnerPhase.ExclusiveMutation|DependencyOwnerPhase.Running) {
  const actual=assertCurrentHostedDependencyAttempt(context,fence,phase),{binding,attempt}=actual;
  if(binding.version!==2 || readHostedDependencyPendingPreservations(fence,binding).length)invalid();
  const current=readHostedDependencyEstablishedReceipt(binding);
  if(!current || current.state!==DependencyReceiptState.Unverified || !current.tree || current.reason===DependencyUnverifiedReason.ExplicitOperatorReinstallation)invalid();
  const owners=LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384});
  let owner:ReturnType<LocalDependencyOwnerStore["read"]>;
  try {owner=owners.read(binding.workspace);} finally {owners.close();}
  if(!owner || owner.version===1 || !isDependencyConsumerOwner(owner.owner) || owner.owner.phase!==phase ||
    !sameDependencyAttempt(owner.owner.attempt,attempt))invalid();
  const store=LocalDependencyReceiptStore.open({rootPath:hostedDependencyReceiptHistoryRoot,maxRecordBytes:16384,maxHistorySteps:2048});
  let committed:ReturnType<LocalDependencyReceiptStore["getCommittedUnverified"]>;
  try {
    committed=store.getCommittedUnverified(binding.workspace,current.revision);
    if(!encode(committed.receipt).equals(encode(current)))invalid();
    if(owner.generationContinuity) {
      const slot=parseDependencyGenerationContinuityInvalidation(owner.generationContinuity);
      // A preserved retired slot may originate in a fully drained prior attempt;
      // current ownership is independently exact above. It is never Active.
      if(slot.unverifiedRevision!==current.revision || slot.generation!==current.generation ||
        !sameDependencyProtectedReference(slot.retiredUnverified,committed.reference))invalid();
      const previous=store.getCommittedReady(binding.workspace,slot.readyRevision);
      if(previous.receipt.generation!==current.generation || !sameDependencyWorkspace(previous.receipt.workspace,binding.workspace) ||
        !sameDependencyProtectedReference(previous.reference,slot.previousReady))invalid();
      if(current.reason===DependencyUnverifiedReason.BaselineMissing &&
        (previous.receipt.tree.dev!==current.tree.dev || previous.receipt.tree.ino!==current.tree.ino))invalid();
    } else if(current.reason!==DependencyUnverifiedReason.BaselineMissing && current.reason!==DependencyUnverifiedReason.TreeChanged &&
      current.reason!==DependencyUnverifiedReason.InputsChanged)invalid();
    // No continuity slot means no historical Ready requirement. Only this
    // authenticated CURRENT Unverified is reusable as-is, never eviction proof.
  } finally {store.close();}
  const tree=readHostedDependencyRootDirectoryPin(binding.workspace.canonicalPath+"/node_modules"),stat=lstatSync(tree.canonicalPath);
  if(tree.dev!==current.tree.dev || tree.ino!==current.tree.ino || stat.uid!==0 || stat.gid!==0 || (stat.mode&0o700)!==0o700)invalid();
  const after=assertCurrentHostedDependencyAttempt(context,fence,phase);
  const latest=LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384});
  try {if(!encode(latest.read(binding.workspace)).equals(encode(owner)))invalid();} finally {latest.close();}
  if(!sameDependencyAttempt(after.attempt,attempt) || !encode(readHostedDependencyEstablishedReceipt(binding)).equals(encode(current)) ||
    !encode(readHostedDependencyRootDirectoryPin(tree.canonicalPath)).equals(encode(tree)))invalid();
  assertCurrentHostedDependencyAttempt(context,fence,phase);
  return {binding,attempt,receipt:committed,tree};
}
