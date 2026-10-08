import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { DependencyReceiptState as State, DependencyUnverifiedReason as Reason, DependencyInstallProofKind as Proof,
  DependencyTreeObservationStatus as Observed, sameDependencyTree, releaseDependencyMaintenance,
  type DependencyReceipt } from "@vioxen/subscription-runtime/worker-core";
import { withHostedActivationFence } from "@vioxen/subscription-runtime/provider-codex";
import { HostedInstallationActivationStore } from "./hosted-installation-activation";
import { readHostedReadonlyHostInventory } from "./hosted-readonly-host-kernel";
import { runHostedRuntimeForeground } from "./hosted-readonly-foreground";
import { hostedForegroundExitCode } from "./hosted-foreground-result";
import { LocalDependencyOwnerStore } from "../store-local-file/dependency-environment/local-dependency-owner-store";
import { hostedDependencyOwnerRoot } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { readHostedDependencyReceipt, readHostedDependencyCommittedUnverified, readHostedDependencyCommittedReady, publishHostedDependencyReceipt,
  dependencyCoverageRevision } from "./hosted-dependency-receipts";
import { readHostedDependencyKeyInputs, assertHostedDependencyKeyInputsCurrent, hostedDependencyObservationLimits as limits } from "./hosted-dependency-materialization";
import { HostedDependencyInstallerRecipe as Recipe } from "./hosted-dependency-installer-inputs";
import { claimHostedDependencyComparisonMaintenance,
  assertHostedDependencyComparisonMaintenanceUnderFence, assertHostedDependencyComparisonQuiescent } from "./hosted-dependency-transactions";
import { prepareHostedLegacyReference, assertHostedLegacyReferenceSourcesCurrent,
  closeHostedLegacyReferencePreparation, openHostedLegacyReferenceSourceLinks } from "./hosted-dependency-legacy-reference";
import { assertDependencyLocalRegistrySelectionAbsent, observeDependencyTree, captureDependencyPhysicalTreeExposure, assertDependencySourceExposureCurrent,
  closeDependencySourceExposure, type DependencySourceExposure } from "../worker-local/dependency-environment/observe-dependency-tree";
import { openHostedDependencyManifestPlacement } from "./hosted-dependency-manifest-placement";
import { DependencyInstallProfile } from "../worker-core/dependency-environment/domain/dependency-install-key";
import { DependencyLegacyComparisonRecipe, type DependencyLegacyComparisonRecord } from "../worker-core/dependency-environment/domain/dependency-legacy-comparison";
import type { DependencyLegacyComparedReady } from "../worker-core/dependency-environment/ports/dependency-legacy-comparison";
import { assertHostedDependencyLegacyReferenceHistory, readHostedDependencyLegacyReferenceHistory } from "./hosted-dependency-legacy-reference-history";
import { assertHostedDependencyLegacyLocalReferenceInstallation, assertHostedDependencyLegacyComparedReady } from "./hosted-dependency-legacy-comparison-record";
import { readReferenceRelation, referencePath, pinReferenceFile, parseReferenceResult, writeReferenceOnce,
  encodeReference as encode, referenceFailure as fail } from "./hosted-dependency-legacy-reference-records";
import { openCapturedDependencySourceLinks, closeDependencySourceLinkSession, type DependencySourceLinkSession } from "../worker-local/dependency-environment/dependency-source-binding";
import { publishHostedDependencyLegacyLocalSourceBinding } from "./hosted-dependency-ready-source-links";
export enum HostedLegacyComparisonOutcome { AlreadyReady="already_ready", Incomplete="incomplete", Mismatch="mismatch", Compared="compared" }

/** One exact pre-enrolled candidate/reference pair, one consumed ordinary
 * reference installation. This API contains comparisons only, never paths,
 * keys, outputs, predicates, bindings or a caller Complete authority. */
export async function compareHostedLegacyDependency(input: { readonly candidateJobId:string; readonly referenceJobId:string;
  readonly expectedRevision:number|null }) {
  if (input.expectedRevision!==null && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision<1)) fail();
  const selected=withHostedActivationFence(fence => {
    const authority=new HostedInstallationActivationStore(),candidate=authority.dependencyMaintenanceAuthority(fence,input.candidateJobId),
      reference=authority.dependencyMaintenanceAuthority(fence,input.referenceJobId),prior=readHostedDependencyReceipt(candidate.binding);
    if (candidate.binding.version===3 || reference.binding.version!==3 || (prior?.revision??null)!==input.expectedRevision ||
        prior && prior.state!==State.Unverified && prior.state!==State.Ready ||
        candidate.binding.workspace.canonicalPath===reference.binding.workspace.canonicalPath) fail();
    return {candidate,reference,prior,operationId:reference.binding.reference.operationId};
  });
  const op=selected.operationId,cm=claimHostedDependencyComparisonMaintenance(input.candidateJobId,op),
    staging=claimHostedDependencyComparisonMaintenance(input.referenceJobId,op);
  assertHostedDependencyComparisonQuiescent(input.candidateJobId,cm);assertHostedDependencyComparisonQuiescent(input.referenceJobId,staging);
  // Root identity is a comparison fact only. The genuine exposure walker owns
  // the complete physical baseline BEFORE any manifest/input walk or wait;
  // later observations cannot reset it after an intervening mutation.
  const originalTree=withHostedActivationFence(fence => {
    assertHostedDependencyComparisonMaintenanceUnderFence(fence,input.candidateJobId,cm);
    const tree=lstatSync(selected.candidate.binding.workspace.canonicalPath+"/node_modules",{bigint:true});
    if (!tree.isDirectory()) fail();return {dev:String(tree.dev),ino:String(tree.ino)};
  });
  const capturedCandidate=await captureDependencyPhysicalTreeExposure({workspace:selected.candidate.binding.workspace,expectedTree:originalTree,limits});
  if (capturedCandidate.status!==Observed.Complete) return {outcome:HostedLegacyComparisonOutcome.Incomplete,reason:capturedCandidate.reason,held:true};
  const candidateBaseline=capturedCandidate.exposure;
  let referenceBaseline:DependencySourceExposure|undefined;
  let candidateSession:DependencySourceLinkSession|undefined,referenceSession:DependencySourceLinkSession|undefined;
  try {
  const originalInputs=await readHostedDependencyKeyInputs(selected.candidate.binding);
  assertDependencySourceExposureCurrent(candidateBaseline);
  if (originalInputs.recipe===Recipe.NpmLocalNoLifecycleV1) candidateSession=openCapturedDependencySourceLinks(originalInputs.capture);
  assertDependencySourceExposureCurrent(candidateBaseline);
  const candidateAbsent=()=>{if (candidateSession) assertDependencyLocalRegistrySelectionAbsent(candidateBaseline,candidateSession,selected.candidate.binding.workspace,originalTree);};
  candidateAbsent();
  const initial=await observeDependencyTree({workspacePath:selected.candidate.binding.workspace.canonicalPath,treeName:"node_modules",
    expectedWorkspace:selected.candidate.binding.workspace,expectedTree:originalTree,...(candidateSession?{sourceLinkSession:candidateSession}:{}),limits});
  assertDependencySourceExposureCurrent(candidateBaseline);assertHostedDependencyKeyInputsCurrent(selected.candidate.binding,originalInputs);
  if (initial.status!==Observed.Complete) return {outcome:HostedLegacyComparisonOutcome.Incomplete,reason:initial.reason,held:true};
  assertDependencySourceExposureCurrent(candidateBaseline);
  if (selected.prior?.state===State.Ready && selected.prior.installKey===originalInputs.key.installKey &&
      selected.prior.manifestDigest===initial.digest && sameDependencyTree(selected.prior.tree,initial.tree)) {
    return withHostedActivationFence(fence => {
      assertHostedDependencyComparisonMaintenanceUnderFence(fence,input.candidateJobId,cm);assertHostedDependencyComparisonMaintenanceUnderFence(fence,input.referenceJobId,staging);
      assertHostedDependencyKeyInputsCurrent(selected.candidate.binding,originalInputs);
      assertDependencySourceExposureCurrent(candidateBaseline);candidateAbsent();
      if (!encode(readHostedDependencyReceipt(selected.candidate.binding)).equals(encode(selected.prior))) fail();
      const store=LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384});
      try {releaseDependencyMaintenance(store,selected.candidate.binding.workspace,cm);releaseDependencyMaintenance(store,selected.reference.binding.workspace,staging);} finally {store.close();}
      return {outcome:HostedLegacyComparisonOutcome.AlreadyReady};
    });
  }
  let unverified:Extract<DependencyReceipt,{state:State.Unverified}>;
  if (selected.prior?.state===State.Unverified) {
    if (!sameDependencyTree(selected.prior.tree,initial.tree)) fail();unverified=selected.prior;
  } else {
    const prior=selected.prior;
    unverified={version:1,revision:(prior?.revision??0)+1,generation:prior?.generation??randomUUID(),workspace:selected.candidate.binding.workspace,
      coverageRevision:dependencyCoverageRevision(selected.candidate.binding),state:State.Unverified,tree:initial.tree,
      reason:prior ? !sameDependencyTree(prior.tree,initial.tree) || prior.manifestDigest!==initial.digest ? Reason.TreeChanged : Reason.InputsChanged : Reason.BaselineMissing};
    // Classification is factual, never a generated pristine baseline. Existing
    // candidate bytes/modes/source/state are not normalized or overwritten.
    withHostedActivationFence(fence => {
      assertHostedDependencyComparisonMaintenanceUnderFence(fence,input.candidateJobId,cm);
      assertHostedDependencyKeyInputsCurrent(selected.candidate.binding,originalInputs);
      assertDependencySourceExposureCurrent(candidateBaseline);
      publishHostedDependencyReceipt(selected.candidate.binding,prior?.revision??null,unverified);
    });
  }
  const original=readHostedDependencyCommittedUnverified(selected.candidate.binding,unverified.revision);
  const relationRef=await prepareHostedLegacyReference(input.candidateJobId,input.referenceJobId,op,candidateBaseline);
  assertDependencySourceExposureCurrent(candidateBaseline);
  assertHostedDependencyKeyInputsCurrent(selected.candidate.binding,originalInputs);
  const relation=readReferenceRelation(op);
  if (!encode(relation.value.candidate.original).equals(encode(original))) fail();
  const creators=readHostedReadonlyHostInventory().ordinaryCreators.filter(row=>row.jobId===input.referenceJobId);
  const creator=creators[0];if (creators.length!==1 || !creator) fail();const launch=creator.launch;
  const completed=await runHostedRuntimeForeground(launch.command,launch.args,launch.cwd,{PATH:"/usr/bin:/bin",LANG:"C",LC_ALL:"C"});
  assertDependencySourceExposureCurrent(candidateBaseline);
  assertHostedDependencyKeyInputsCurrent(selected.candidate.binding,originalInputs);
  withHostedActivationFence(fence=>assertHostedLegacyReferenceSourcesCurrent(fence,op));
  if (hostedForegroundExitCode(completed)!==0) fail();
  // A zero CLI outcome is not release authority. Require the real supervisor
  // release leaf, then re-claim an actual new reference Maintenance epoch.
  const release=pinReferenceFile(referencePath(op,"reference-release")),rm=claimHostedDependencyComparisonMaintenance(input.referenceJobId,op);
  assertHostedDependencyComparisonQuiescent(input.candidateJobId,cm);assertHostedDependencyComparisonQuiescent(input.referenceJobId,rm);
  const resultPin=pinReferenceFile(referencePath(op,"reference-result")),result=parseReferenceResult(JSON.parse(resultPin.bytes.toString("utf8")));
  const referenceBinding=selected.reference.binding;
  if (result.version===2) assertHostedDependencyLegacyLocalReferenceInstallation(op);
  const referenceOriginal=withHostedActivationFence(fence=>{
    assertHostedDependencyComparisonMaintenanceUnderFence(fence,input.referenceJobId,rm);
    const ready=readHostedDependencyReceipt(referenceBinding);
    if (ready?.state!==State.Ready || (result.version===2?ready.provenance.kind!==Proof.CompletedLocalInstallV1:ready.provenance.kind!==Proof.CompletedInstall) ||
        ready.generation!==result.reference.generation || ready.coverageRevision!==result.reference.coverageRevision ||
        ready.installKey!==result.installKey || ready.manifestDigest!==result.reference.manifestDigest || !sameDependencyTree(ready.tree,result.reference.tree)) fail();
    const committed=readHostedDependencyCommittedReady(referenceBinding,ready.revision);
    if (!encode(committed.reference).equals(encode(result.reference.output))) fail();return committed;
  });
  const capturedReference=await captureDependencyPhysicalTreeExposure({workspace:referenceBinding.workspace,expectedTree:result.reference.tree,limits});
  if (capturedReference.status===Observed.Complete) referenceBaseline=capturedReference.exposure;
  assertDependencySourceExposureCurrent(candidateBaseline);assertHostedDependencyKeyInputsCurrent(selected.candidate.binding,originalInputs);
  if (capturedReference.status!==Observed.Complete) return {outcome:HostedLegacyComparisonOutcome.Incomplete,reason:capturedReference.reason,held:true};
  const currentReferenceBaseline=capturedReference.exposure;
  if (originalInputs.recipe===Recipe.NpmLocalNoLifecycleV1) referenceSession=openHostedLegacyReferenceSourceLinks(op);
  const bothAbsent=()=>{candidateAbsent();if (referenceSession) assertDependencyLocalRegistrySelectionAbsent(currentReferenceBaseline,referenceSession,referenceBinding.workspace,result.reference.tree);};
  bothAbsent();
  const current=(fence?:Parameters<typeof assertHostedLegacyReferenceSourcesCurrent>[0])=>{bothAbsent();assertDependencySourceExposureCurrent(candidateBaseline);assertDependencySourceExposureCurrent(currentReferenceBaseline);
    assertHostedDependencyKeyInputsCurrent(selected.candidate.binding,originalInputs);if (fence) assertHostedLegacyReferenceSourcesCurrent(fence,op);else withHostedActivationFence(fence=>assertHostedLegacyReferenceSourcesCurrent(fence,op));};
  assertDependencySourceExposureCurrent(candidateBaseline);assertDependencySourceExposureCurrent(currentReferenceBaseline);
  const candidate=await observeDependencyTree({workspacePath:selected.candidate.binding.workspace.canonicalPath,treeName:"node_modules",
    expectedWorkspace:selected.candidate.binding.workspace,expectedTree:unverified.tree,...(candidateSession?{sourceLinkSession:candidateSession}:{}),limits});
  current();
  const reference=await observeDependencyTree({workspacePath:referenceBinding.workspace.canonicalPath,treeName:"node_modules",
    expectedWorkspace:referenceBinding.workspace,expectedTree:result.reference.tree,...(referenceSession?{sourceLinkSession:referenceSession}:{}),limits});
  current();
  if (candidate.status!==Observed.Complete || reference.status!==Observed.Complete) return {outcome:HostedLegacyComparisonOutcome.Incomplete,
    reason:candidate.status!==Observed.Complete?candidate.reason:reference.status!==Observed.Complete?reference.reason:fail(),held:true};
  current();
  if (candidate.digest!==initial.digest || reference.digest!==result.reference.manifestDigest ||
      candidate.workspace.canonicalPath!==selected.candidate.binding.workspace.canonicalPath ||
      unverified.coverageRevision!==dependencyCoverageRevision(selected.candidate.binding) ||
      result.reference.coverageRevision!==dependencyCoverageRevision(referenceBinding) ||
      !Buffer.from(candidate.canonicalBytes).equals(Buffer.from(initial.canonicalBytes))) fail();
  const originalCurrent=()=>assertHostedDependencyKeyInputsCurrent(selected.candidate.binding,originalInputs);
    const placement=await openHostedDependencyManifestPlacement();
    try { current();const candidateDigest=await placement.put(candidate.canonicalBytes);current();if (candidateDigest!==candidate.digest) fail();
      const referenceDigest=await placement.put(reference.canonicalBytes);current();if (referenceDigest!==reference.digest) fail(); }
    finally {await placement.close();current();}
    assertDependencySourceExposureCurrent(candidateBaseline);assertDependencySourceExposureCurrent(currentReferenceBaseline);
    assertHostedDependencyComparisonQuiescent(input.candidateJobId,cm);assertHostedDependencyComparisonQuiescent(input.referenceJobId,rm);
    return withHostedActivationFence(fence => {
      assertHostedDependencyComparisonMaintenanceUnderFence(fence,input.candidateJobId,cm);assertHostedDependencyComparisonMaintenanceUnderFence(fence,input.referenceJobId,rm);
      originalCurrent();assertHostedLegacyReferenceSourcesCurrent(fence,op);
      assertDependencySourceExposureCurrent(candidateBaseline);assertDependencySourceExposureCurrent(currentReferenceBaseline);bothAbsent();placement.assertCurrent(fence);
      if (!encode(readHostedDependencyReceipt(selected.candidate.binding)).equals(encode(unverified)) ||
          !encode(readHostedDependencyCommittedUnverified(selected.candidate.binding,unverified.revision)).equals(encode(original))) fail();
      const currentReference=readHostedDependencyReceipt(referenceBinding);
      if (currentReference?.state!==State.Ready || (originalInputs.recipe===Recipe.NpmLocalNoLifecycleV1?currentReference.provenance.kind!==Proof.CompletedLocalInstallV1:currentReference.provenance.kind!==Proof.CompletedInstall) ||
          currentReference.generation!==result.reference.generation || currentReference.manifestDigest!==reference.digest ||
          currentReference.installKey!==originalInputs.key.installKey || !encode(currentReference).equals(encode(referenceOriginal.receipt)) ||
          !encode(readHostedDependencyCommittedReady(referenceBinding,currentReference.revision)).equals(encode(referenceOriginal))) fail();
      if (result.version===2) assertHostedDependencyLegacyLocalReferenceInstallation(op);
      const history=readHostedDependencyLegacyReferenceHistory(op);
      if (!encode(history.result).equals(encode(result)) || !encode(history.refs.referenceRelease).equals(encode(release.reference))) fail();
      if (candidate.digest!==reference.digest || !Buffer.from(candidate.canonicalBytes).equals(Buffer.from(reference.canonicalBytes))) {
        // Known complete inequality grants no Ready. Actual proof/current
        // fences authorize releasing only these two stable exclusions; unknown
        // or partial/uncertain paths above retain owners for reconciliation.
        const store=LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384});
        try {releaseDependencyMaintenance(store,candidate.workspace,cm);releaseDependencyMaintenance(store,reference.workspace,rm);} finally {store.close();}
        closeHostedLegacyReferencePreparation(op);
        return {outcome:HostedLegacyComparisonOutcome.Mismatch,originalEntries:candidate.entries.length,referenceEntries:reference.entries.length,
          originalManifestDigest:candidate.digest,referenceManifestDigest:reference.digest,held:false};
      }
      const proofBinding={generation:unverified.generation,workspace:unverified.workspace,coverageRevision:unverified.coverageRevision,
        installKey:originalInputs.key.installKey,tree:candidate.tree,manifestDigest:candidate.digest};
      const common={operationId:op,comparisonEvidenceId:op,referenceInstallationId:result.reference.installationId,
        original,installKey:originalInputs.key.installKey,inputSha256:relation.value.inputs.inputSha256,profileSha256:relation.value.inputs.profileSha256,
        originalManifestDigest:candidate.digest,referenceManifestDigest:reference.digest,relation:relationRef,
        referenceStart:pinReferenceFile(referencePath(op,"reference-start")).reference,referenceEntry:pinReferenceFile(referencePath(op,"reference-entry")).reference,
        referenceResult:resultPin.reference,referenceRelease:release.reference};
      let evidence:DependencyLegacyComparisonRecord;
      if (originalInputs.recipe===Recipe.NpmLocalNoLifecycleV1) {
        if (result.version!==2 || relation.value.version!==2 || !candidateSession || originalInputs.capture.closureDigest!==result.closureDigest ||
            originalInputs.profileSha256!==result.profileSha256 || originalInputs.key.installKey!==result.installKey) fail();
        const candidateSourceBinding=publishHostedDependencyLegacyLocalSourceBinding({capture:originalInputs.capture,sourceSession:candidateSession,
          candidate:proofBinding,operationId:op,original,referenceOutput:result.reference.output});
        current(fence);
        evidence={...common,version:2,recipe:DependencyLegacyComparisonRecipe.NpmLocalNoLifecycleV1,profile:DependencyInstallProfile.TestNpmLocalNoLifecycleV1,
          closureDigest:originalInputs.capture.closureDigest,candidateSourceBinding,reference:result.reference};
      } else {
        if (result.version!==1 || relation.value.version!==1) fail();
        evidence={...common,version:1,recipe:DependencyLegacyComparisonRecipe.NpmRegistryNoScriptsV1,profile:DependencyInstallProfile.TestNpmQualification,reference:result.reference};
      }
      assertHostedDependencyLegacyReferenceHistory(evidence);
      writeReferenceOnce(referencePath(op,"comparison"),evidence);
      const ready:DependencyLegacyComparedReady={version:1,revision:unverified.revision+1,state:State.Ready,...proofBinding,
        treeMeasurement:candidate.measurement,provenance:{...proofBinding,kind:Proof.LegacyCompared,comparisonEvidenceId:op,referenceInstallationId:evidence.referenceInstallationId}};
      originalCurrent();assertHostedLegacyReferenceSourcesCurrent(fence,op);
      assertDependencySourceExposureCurrent(candidateBaseline);assertDependencySourceExposureCurrent(currentReferenceBaseline);bothAbsent();placement.assertCurrent(fence);
      publishHostedDependencyReceipt(selected.candidate.binding,unverified.revision,ready);
      const committed=readHostedDependencyReceipt(selected.candidate.binding);if (!encode(committed).equals(encode(ready))) fail();
      assertHostedDependencyLegacyComparedReady(ready);current(fence);
      const store=LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384});
      try {releaseDependencyMaintenance(store,candidate.workspace,cm);releaseDependencyMaintenance(store,reference.workspace,rm);} finally {store.close();}
      closeHostedLegacyReferencePreparation(op);
      return {outcome:HostedLegacyComparisonOutcome.Compared,revision:ready.revision,comparisonEvidenceId:op};
    });
  } finally {
    try {if (referenceSession) closeDependencySourceLinkSession(referenceSession);}
    finally {try {if (candidateSession) closeDependencySourceLinkSession(candidateSession);}
      finally {try {if (referenceBaseline) closeDependencySourceExposure(referenceBaseline);}
        finally {try {closeDependencySourceExposure(candidateBaseline);} finally {closeHostedLegacyReferencePreparation(op);}}}}

  }
}
