import { lstatSync } from "node:fs";
import { withHostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { openCommittedDependencyTrashRemoval, openCommittedDependencyTrashAbsence, type DependencyCommittedTrashRemovalProgress } from "../worker-local/dependency-environment/dependency-tree-effects";
import { closeDependencySourceLinkSession } from "../worker-local/dependency-environment/dependency-source-binding";
import { assertOriginalHostedDependencyPhysicalRecordAccess } from "./hosted-current-dependency-origin";
import { readOriginalHostedDependencyRemoverAuthority, readOriginalHostedDependencyRemoverEffectState, readOriginalHostedDependencyRemoverScope, hostedDependencyRemovalRecordPath } from "./hosted-dependency-removal-context";
import { openHostedDependencyManifestPlacement } from "./hosted-dependency-manifest-placement";
import { openHostedDependencyReadySourceLinks } from "./hosted-dependency-ready-source-links";
import { pinReferenceFile, writeReferenceOnce } from "./hosted-dependency-legacy-reference-records";
import { readHostedDependencyEvictionEnabled } from "./hosted-dependency-eviction-enabled-policy";
import { assertHostedDependencyReferenceVeto, DependencyReferenceEffect } from "./hosted-dependency-reference-veto";
import { readOriginalHostedDependencyOperatorNativeCensus } from "./hosted-dependency-generation-native-census";
import { readHostedReadonlyHostInventory } from "./hosted-readonly-host-kernel";
import { HostedReadonlyEpochStore } from "./hosted-readonly-epoch-store";
import { HostedActivationPhase } from "@vioxen/subscription-runtime/worker-core";
import { hostedDependencyObservationLimits } from "./hosted-dependency-materialization";
import { HostedDependencyRemovalRecordKind } from "./hosted-dependency-removal-records";

export enum HostedDependencyRemovalDisposition { Removed = "removed", RecoveredAbsent = "recovered_absent", Partial = "partial" }
function held(): never { throw new Error("hosted_dependency_removal_effect_held"); }
/** Physical adapter is driven only by the original actor's current association.
 * Authority, native census, own actual anchors and one synchronous step share
 * the SAME activation fence; no await separates final checks from unlink/fsync. */
export async function runOriginalHostedDependencyRemovalEffects(access: symbol): Promise<void> {
  assertOriginalHostedDependencyPhysicalRecordAccess(access);
  const state = readOriginalHostedDependencyRemoverEffectState(access), claim = state.selected.claim, proof = claim.absent.receipt.evictionCommit,
    header = JSON.parse(pinReferenceFile(claim.header.path, 32768).bytes.toString("utf8")), operationId = state.actor.actor.unit.slice("subscription-runtime-dependency-remove-".length, -".service".length);
  let placement: Awaited<ReturnType<typeof openHostedDependencyManifestPlacement>> | undefined,
    operation: Awaited<ReturnType<typeof openCommittedDependencyTrashRemoval>> | Awaited<ReturnType<typeof openCommittedDependencyTrashAbsence>> | undefined,
    progress: DependencyCommittedTrashRemovalProgress | undefined, disposition = HostedDependencyRemovalDisposition.Partial, closed = false;
  const assert = () => withHostedActivationFence(fence => {
    const actual = readOriginalHostedDependencyRemoverAuthority(fence, claim.binding.jobId, access);
    if (!actual || !readHostedDependencyEvictionEnabled()) held(); return actual;
  });
  try {
    assert(); placement = await openHostedDependencyManifestPlacement(); const bytes = await placement.get(proof.manifestDigest);
    withHostedActivationFence(fence => { placement!.assertCurrent(fence); if(!readOriginalHostedDependencyRemoverAuthority(fence, claim.binding.jobId, access))held(); });
    await placement.close(); placement = undefined;
    const sourceLinks = openHostedDependencyReadySourceLinks(header.ready, { workspace: proof.trash.destinationParent, name: proof.trash.destinationName, reference: claim.header });
    if (sourceLinks) state.sourceLinks = sourceLinks;
    const input = { workspace: claim.binding.workspace, trash: proof.trash, manifestCanonicalBytes: bytes, manifestDigest: proof.manifestDigest,
      limits: hostedDependencyObservationLimits, commit: claim.absent.reference, ...(sourceLinks ? { sourceLinkSession: sourceLinks } : {}) };
    const destination = proof.trash.destinationParent.canonicalPath + "/" + proof.trash.destinationName;
    let absent = false; try { lstatSync(destination); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; absent = true; }
    if (absent) {
      if (!claim.previousClaim || !claim.previousRetirement) held();
      const negative = await openCommittedDependencyTrashAbsence(input); operation = negative; state.session = negative.referenceSession;
      withHostedActivationFence(fence => { final(fence, access, destination); negative.confirmAbsence(); });
      disposition = HostedDependencyRemovalDisposition.RecoveredAbsent;
    } else {
      const remover = await openCommittedDependencyTrashRemoval({ ...input, maxRemovals: 10000 }); operation = remover;
      const steps = await remover.prepareSynchronousRemoval(); state.session = steps.referenceSession; progress = steps.progress();
      while (progress.remainingEntries) progress = withHostedActivationFence(fence => { final(fence, access, destination); return steps.removeNext(); });
      disposition = HostedDependencyRemovalDisposition.Removed;
    }
  } finally {
    if (placement) await placement.close();
    if (operation) {
      const result = await operation.close(); delete state.session; if (result.closeFailures) held();
      if (state.sourceLinks) { closeDependencySourceLinkSession(state.sourceLinks); delete state.sourceLinks; }
      closed = true;
    }
    // Closure disposition is truthful local fact, never parent discharge.
    // No marker/release is published after uncertain descriptor close.
    if (closed) withHostedActivationFence(fence => {
      if (!readOriginalHostedDependencyRemoverAuthority(fence, claim.binding.jobId, access) || !readOriginalHostedDependencyRemoverScope(fence, access)) held();
      writeReferenceOnce(hostedDependencyRemovalRecordPath(operationId, "session-closed"), { version: 1, kind: HostedDependencyRemovalRecordKind.SessionClosed, claim: state.selected.reference,
        actor: state.actorReference, disposition, removedEntries: disposition === HostedDependencyRemovalDisposition.Removed ? progress?.removedEntries ?? null : null });
    });
  }
}
function final(fence: import("../provider-codex/app-server/adapters/hosted-process-activation").HostedActivationFence, access: symbol, destination: string): void {
  const state = readOriginalHostedDependencyRemoverEffectState(access), actual = readOriginalHostedDependencyRemoverAuthority(fence, state.selected.claim.binding.jobId, access);
  if (!actual || !state.session || !readHostedDependencyEvictionEnabled() || !readOriginalHostedDependencyRemoverScope(fence, access) ||
      !readOriginalHostedDependencyOperatorNativeCensus(fence, access)) held();
  const groups = new Set(readHostedReadonlyHostInventory().units.map(row => row.controlGroup)); groups.add(state.actor.actor.controlGroup);
  for (const row of actual.activation.ordinaryStarts) groups.add(`/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/${row.unit}`);
  if (actual.activation.phase === HostedActivationPhase.Exclusive) {
    const epoch = new HostedReadonlyEpochStore().readEpoch();
    for (const row of [...epoch.reservations, ...(epoch.outerRuntime ? [epoch.outerRuntime] : [])]) groups.add(`/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/${row.unit}`);
  }
  assertHostedDependencyReferenceVeto(actual.binding.workspace, destination, [...groups], DependencyReferenceEffect.TrashRemoval,
    { session: state.session, operationId: state.selected.claim.absent.receipt.operationId });
  // Rejoin revocation/owner/self/parent/Invocation after the full native scan.
  if(!readOriginalHostedDependencyRemoverScope(fence, access) || !readOriginalHostedDependencyRemoverAuthority(fence,state.selected.claim.binding.jobId,access))held();
}
