/** Fixed TEST composition DATA. This does not enroll, launch or grant custody. */
import assert from "node:assert/strict";
export enum PositiveAcceptanceRole {
  PrimaryLegacy = "primary_legacy", PrimaryReference = "primary_reference",
  AuxiliaryLegacyC = "auxiliary_legacy_c", AuxiliaryReference = "auxiliary_reference",
}
export type PositiveAcceptanceMember = Readonly<{role:PositiveAcceptanceRole;jobId:string;jobRoot:string;workspace:string}>;
export type PositiveAcceptanceCreator = Readonly<{creatorId:string;jobId:string;jobRootDir:string;workspacePath:string;
  launch:Readonly<{command:string;args:readonly string[];cwd:string}>;authAttachment?:unknown}>;
const roles = Object.freeze([PositiveAcceptanceRole.PrimaryLegacy, PositiveAcceptanceRole.PrimaryReference,
  PositiveAcceptanceRole.AuxiliaryLegacyC, PositiveAcceptanceRole.AuxiliaryReference]);
/** Exact four roles, no count option and no synthetic readonly identity for C.
 * Callers still need original protected inventory, bindings and lexical auth. */
export function assertPositiveAcceptanceRoster(members:readonly PositiveAcceptanceMember[],creators:readonly PositiveAcceptanceCreator[],
    primaryLaunch:PositiveAcceptanceCreator["launch"]) {
  assert.equal(members.length,4);assert.equal(creators.length,4);
  assert.deepEqual(members.map(row=>row.role),roles);
  for(const field of ["jobId","jobRoot","workspace"] as const)assert.equal(new Set(members.map(row=>row[field])).size,4);
  const selected=members.map(member=>{
    assert(/^TEST-os-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(member.jobId));
    assert.equal(member.jobRoot,"/var/lib/subscription-runtime-host-policy/dependency-test-jobs/jobs/"+member.jobId);
    assert.equal(member.workspace,member.jobRoot+"/workspace");
    const rows=creators.filter(row=>row.creatorId===member.jobId && row.jobId===member.jobId);assert.equal(rows.length,1);
    const row=rows[0]!;assert.equal(row.jobRootDir,member.jobRoot);assert.equal(row.workspacePath,member.workspace);assert.equal(row.launch.cwd,member.workspace);
    assert.equal(row.authAttachment!==undefined,member.role===PositiveAcceptanceRole.PrimaryLegacy || member.role===PositiveAcceptanceRole.AuxiliaryLegacyC);
    return row;
  });
  assert.deepEqual(primaryLaunch,selected[0]!.launch);
  return Object.freeze(members.map(member=>Object.freeze({...member})));
}
/** Uses the existing guest's absolute monotonic end. This never extends it. */
export function positiveAcceptanceRemaining(deadline:number,now=performance.now()):number {
  assert(Number.isFinite(deadline) && Number.isFinite(now));const remaining=Math.floor(deadline-now);
  assert(remaining>0 && remaining<=27*60*1000,"TEST positive composite original deadline");return remaining;
}

const retainedPositive = new WeakMap<import("./current-cold-hot-root.js").CurrentColdHotRoots,Readonly<{
  auxiliary:import("./current-cold-hot-root.js").CurrentOrdinaryRoots;
  owner:unknown;ready:unknown;outputs:readonly Awaited<ReturnType<typeof import("./current-explicit-preservation.js").captureCurrentCompletedOutputData>>[];references:readonly import("../../dist/core/index.js").DependencyProtectedReference[]
}>>();
/** The fixed inventoried CLI recipe allows five minutes per genuine entry.
 * Refuse BEFORE admission if that existing window no longer fits the one end. */
export function positiveAcceptanceAdmissionRemaining(deadline:number,now=performance.now()):number {
  const remaining=positiveAcceptanceRemaining(deadline,now);assert(remaining>=5*60*1000,"TEST positive original entry window no longer fits");return remaining;
}
/** ONE genuine C-only auxiliary sequence, before the sole primary R sequence.
 * Imports are deferred so the roster's portable DATA tests execute no producer. */
export async function runCurrentPositiveAcceptanceC(primary:import("./current-cold-hot-root.js").CurrentColdHotRoots,deadline:number) {
  const {currentPositiveAuxiliaryRoots,assertRootScope,retainPreparedCurrentAuthCompletion}=await import("./current-cold-hot-root.js");
  const roots=currentPositiveAuxiliaryRoots(primary);assertRootScope(roots);assert(roots.referenceJobId);
  const remaining=()=>positiveAcceptanceRemaining(deadline);
  const {HostedInstallationActivationStore,readHostedInstallationActivation}=await import("../../dist/worker-codex/hosted-installation-activation.js");
  const {HostedActivationPhase,DependencyGenerationContinuityKind,DependencyInstallProofKind}=await import("../../dist/worker-core/index.js");
  const {withHostedActivationFence}=await import("../../dist/provider-codex/app-server/adapters/hosted-process-activation.js");
  const {LocalDependencyOwnerStore}=await import("../../dist/store-local-file/dependency-environment/local-dependency-owner-store.js");
  const {readHostedDependencyBinding,hostedDependencyOwnerRoot}=await import("../../dist/provider-codex/app-server/adapters/hosted-dependency-workspace.js");
  const {pinReferenceFile}=await import("../../dist/worker-codex/hosted-dependency-legacy-reference-records.js");
  const {runCurrentPositiveEvictionPrelockRecovery}=await import("./current-eviction-prelock-io-TEST.js");
  const {HostedDependencyTransactionOutcome}=await import("../../dist/worker-codex/hosted-dependency-transactions.js");
  const {readHostedDependencyEvictionEnabled}=await import("../../dist/worker-codex/hosted-dependency-eviction-enabled-policy.js");
  const {assertCurrentClosedEntry}=await import("./current-closed-entry.js");
  const {assertRegisteredLegacyComparison,LegacyRegisteredExpectation}=await import("./legacy-registered-comparison.js");
  const {FullEntryKind,FullRequestPhase,runCurrentOrdinaryEntry,requestCurrentNextWork,assertCurrentNextWorkDelivered,assertDistinctCurrentEntries}=await import("./current-full-entry.js");
  const {readEvictRestoreReady,readLegacyEvictRestoreAbsent,assertRetainedEvictionProof,assertPathAbsent,assertSameRootFinalGateRestore}=await import("./current-evict-restore-readback.js");
  const {prepareEvictRestoreSentinels,captureEvictRestoreSentinels,assertEvictRestoreSentinels}=await import("./current-evict-restore-sentinels.js");
  const {editCurrentPureLinkedLeaf}=await import("./current-full-warm-edit.js");
  const {runCurrentPositivePreservationC,captureCurrentCompletedOutputData,assertCurrentCompletedOutputData,assertCurrentCompletedOutputLogsData}=await import("./current-explicit-preservation.js");
  const {NativeInstallerTraceState,startNativeInstallerTrace}=await import("./native-installer-observations.js");
  const policyPath="/var/lib/subscription-runtime-host-policy/dependency-retention-policy.json",policy=pinReferenceFile(policyPath,4096);
  const policyCurrent=()=>{remaining();assert.equal(readHostedDependencyEvictionEnabled(),true);assert.deepEqual(pinReferenceFile(policyPath,4096).reference,policy.reference);};
  policyCurrent();prepareEvictRestoreSentinels(roots);const sentinels=captureEvictRestoreSentinels(roots);
  const store=new HostedInstallationActivationStore();assert.equal(readHostedInstallationActivation().activation.phase,HostedActivationPhase.Closed);
  const birth=store.enrollOrdinary(roots.candidateJobId);assert.equal(birth.jobRootDir,roots.jobRoot);assert.equal(birth.workspacePath,roots.workspace);
  let trace:ReturnType<typeof startNativeInstallerTrace>|undefined=startNativeInstallerTrace(roots.candidateJobId,remaining());
  const measured=(count:number,prior:number)=>{assert(trace);const held=trace;trace=undefined;const value=held.finish();assert.equal(value.state,NativeInstallerTraceState.Measured);
    assert(value.state===NativeInstallerTraceState.Measured);assert.equal(value.launchedInstalls,count);assert.equal(value.completedInstalls,count);assert.equal(value.excludedPriorStarts,prior);return value;};
  try{
    store.resumeOrdinary();remaining();
    const comparison=await assertRegisteredLegacyComparison(roots.candidateJobId,roots.referenceJobId,LegacyRegisteredExpectation.Compared);
    const ready=readEvictRestoreReady(roots);assert.equal(ready.receipt.provenance.kind,DependencyInstallProofKind.LegacyCompared);
    // Fresh worker work performs its real cold content observations (3), while
    // actual installer launch telemetry independently proves reuse installs0.
    positiveAcceptanceAdmissionRemaining(deadline);const reuse=await runCurrentOrdinaryEntry(roots,FullEntryKind.ComparedReuse);remaining();store.finishClosed();
    const closed=withHostedActivationFence(fence=>{
      const closed=assertCurrentClosedEntry(fence,roots.jobRoot,reuse.result),binding=readHostedDependencyBinding(roots.candidateJobId);assert(binding && binding.version===2);
      const owners=LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384});
      try{const owner=owners.read(binding.workspace);assert(owner && owner.version!==1 && owner.owner===null);
        const slot=owner.generationContinuity;assert(slot && slot.kind===DependencyGenerationContinuityKind.BaselineAuthenticatedV1);
        assert.deepEqual(slot.previousReady,ready.reference);assert.equal(slot.generation,ready.receipt.generation);assert.equal(slot.readyRevision,ready.receipt.revision);
        const baseline=pinReferenceFile(slot.baseline.path,65536);assert.deepEqual(baseline.reference,slot.baseline);
        const barrier=pinReferenceFile(slot.writerBarrier.path,65536);assert.deepEqual(barrier.reference,slot.writerBarrier);
        return {...closed,baseline:baseline.reference,writerBarrier:barrier.reference};
      }finally{owners.close();}
    });
    assert.deepEqual(readEvictRestoreReady(roots),ready);const reuseOutput=await captureCurrentCompletedOutputData(roots,reuse.result);const reuseInstaller=measured(0,0);assertEvictRestoreSentinels(roots,sentinels);policyCurrent();
    // No private Ready/owner/history is synthesized. The original store retires
    // this genuine baseline and original remover authenticates RetiredEvicting.
    const {evicted,recovery}=await runCurrentPositiveEvictionPrelockRecovery(roots,reuse,deadline);
    assert.equal(evicted.outcome,HostedDependencyTransactionOutcome.Evicted);remaining();const proof=readLegacyEvictRestoreAbsent(roots,ready);assertRetainedEvictionProof(proof);policyCurrent();
    const removed=await store.removeDependencyCommittedTrash(roots.candidateJobId,proof.absent.receipt.revision);remaining();
    assert.equal(removed.outcome,HostedDependencyTransactionOutcome.TrashRemoved);assert("operationId" in removed && "removedEntries" in removed);
    assert.equal(removed.operationId,proof.absent.receipt.operationId);assert(removed.removedEntries>0);assertPathAbsent(proof.trash);assertPathAbsent(proof.operation+".remove.lock");assertRetainedEvictionProof(proof);
    assertEvictRestoreSentinels(roots,sentinels);policyCurrent();
    assertCurrentCompletedOutputData(reuseOutput);
    const restoreRequest=await requestCurrentNextWork(roots,FullRequestPhase.LegacyReclaimRestore);trace=startNativeInstallerTrace(roots.candidateJobId,remaining());
    positiveAcceptanceAdmissionRemaining(deadline);const restored=await runCurrentOrdinaryEntry(roots,FullEntryKind.Restored);remaining();const restoreDelivery=await assertCurrentNextWorkDelivered(roots,restoreRequest);
    const restore=assertSameRootFinalGateRestore(roots,ready,proof,restored),restoreInstaller=measured(1,0);store.finishClosed();
    withHostedActivationFence(fence=>assertCurrentClosedEntry(fence,roots.jobRoot,restored.result));
    const restoreOutput=await captureCurrentCompletedOutputData(roots,restored.result);
    const restoredReady=readEvictRestoreReady(roots),warmEdit=editCurrentPureLinkedLeaf(roots,restored.result),warmSentinels=captureEvictRestoreSentinels(roots);
    const hotRequest=await requestCurrentNextWork(roots,FullRequestPhase.LegacyReclaimHot);trace=startNativeInstallerTrace(roots.candidateJobId,remaining());store.resumeOrdinary();
    positiveAcceptanceAdmissionRemaining(deadline);const hot=await runCurrentOrdinaryEntry(roots,FullEntryKind.Hot);remaining();const hotDelivery=await assertCurrentNextWorkDelivered(roots,hotRequest),hotInstaller=measured(0,1);
    assert.deepEqual(readEvictRestoreReady(roots),restoredReady);assertEvictRestoreSentinels(roots,warmSentinels);store.finishClosed();
    withHostedActivationFence(fence=>assertCurrentClosedEntry(fence,roots.jobRoot,hot.result));retainPreparedCurrentAuthCompletion(roots,hot.result);
    const hotOutput=await captureCurrentCompletedOutputData(roots,hot.result);assertCurrentCompletedOutputLogsData(reuseOutput);assertCurrentCompletedOutputLogsData(restoreOutput);
    policyCurrent();const preservation=await runCurrentPositivePreservationC(roots,hot,deadline);remaining();policyCurrent();
    assertDistinctCurrentEntries([reuse,restored,hot,...preservation.entries.map(observation=>({observation}))]);
    assert.equal(new Set([restoreDelivery.signalId,hotDelivery.signalId,...preservation.control.map(row=>row.signalId)]).size,4);
    assert.equal(new Set([...restoreInstaller.invocationIds,...preservation.installer.restore.invocationIds]).size,2);
    const terminalReady=readEvictRestoreReady(roots);
    withHostedActivationFence(()=>{
      const binding=readHostedDependencyBinding(roots.candidateJobId);assert(binding && binding.version===2);
      const owners=LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384});
      try{const owner=owners.read(binding.workspace);assert(owner && owner.owner===null);
        const finalEntry=preservation.entries.at(-1);assert(finalEntry);
        const source=pinReferenceFile("/var/lib/subscription-runtime-host-policy/dependency-generation-source-closures/"+finalEntry.startId+".json",65536);
        assert.equal(source.reference.sha256,finalEntry.sourceClosedSha256);
        const idle=pinReferenceFile("/var/lib/subscription-runtime-host-policy/dependency-generation-idle-closures/"+binding.workspace.dev+"-"+binding.workspace.ino+"/"+owner.revision+".json",16384);
        retainedPositive.set(primary,{auxiliary:roots,owner,ready:terminalReady,outputs:[reuseOutput,restoreOutput,hotOutput],references:[source.reference,idle.reference,policy.reference]});
      }finally{owners.close();}
    });
    return Object.freeze({qualification:"native_auxiliary_legacy_clean_reclaim_restore_preserve_restore_hot_only",status:"partial_pass",fullPlanQualification:"pending",
      candidateJobId:roots.candidateJobId,referenceJobId:roots.referenceJobId,workspace:roots.workspaceIdentity,comparison,closed,policyReference:policy.reference,
      entries:[reuse.observation,restored.observation,hot.observation,...preservation.entries],installer:{reuse:reuseInstaller,restore:restoreInstaller,hot:hotInstaller},
      completedOutputs:[reuseOutput,restoreOutput,hotOutput],candidateManagedInstallCount:2,legacyCandidateBirthAccounting:"separate_ROOT_TEST_precursor_before_managed_counter",referenceInstallAccounting:"separate_original_comparison_proof_not_candidate_counter",warmEdit,restore,control:[restoreDelivery,hotDelivery],preservation,
      eviction:{recovery,evicting:proof.evicting.reference,absent:proof.absent.reference,header:proof.header,renamed:proof.renamed,removedEntries:removed.removedEntries},
      bytes:{logicalRemoved:null,allocatedRemoved:null,statfsDelta:null,measurement:"unavailable_no_capacity_claim"},remainingMs:remaining()});
  }finally{if(trace){try{trace.finish();}catch{process.stderr.write("TEST_positive_composite_observation_unresolved\n");}}}
}

/** Rejoin fixed auxiliary historical closure after primary R, without claiming
 * auxiliary auth.close against the different primary readonly epoch. */
export async function assertCurrentPositiveAcceptanceRetained(primary:import("./current-cold-hot-root.js").CurrentColdHotRoots) {
  const held=retainedPositive.get(primary);assert(held);
  const {currentPositiveAuxiliaryRoots,assertPreparedCurrentConfiguredAuth}=await import("./current-cold-hot-root.js");
  assert.equal(currentPositiveAuxiliaryRoots(primary),held.auxiliary);assertPreparedCurrentConfiguredAuth(held.auxiliary);
  const {pinReferenceFile}=await import("../../dist/worker-codex/hosted-dependency-legacy-reference-records.js");
  const {withHostedActivationFence}=await import("../../dist/provider-codex/app-server/adapters/hosted-process-activation.js");
  const {LocalDependencyOwnerStore}=await import("../../dist/store-local-file/dependency-environment/local-dependency-owner-store.js");
  const {readHostedDependencyBinding,hostedDependencyOwnerRoot}=await import("../../dist/provider-codex/app-server/adapters/hosted-dependency-workspace.js");
  const {readEvictRestoreReady}=await import("./current-evict-restore-readback.js");
  withHostedActivationFence(()=>{
    const binding=readHostedDependencyBinding(held.auxiliary.candidateJobId);assert(binding && binding.version===2);
    const owners=LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384});
    try{assert.deepEqual(owners.read(binding.workspace),held.owner);}finally{owners.close();}
    for(const reference of held.references)assert.deepEqual(pinReferenceFile(reference.path,65536).reference,reference);
  });
  assert.deepEqual(readEvictRestoreReady(held.auxiliary),held.ready);
  const {assertCurrentCompletedOutputLogsData,assertCurrentPositiveOpaquePreservationRetained}=await import("./current-explicit-preservation.js");for(const output of held.outputs)assertCurrentCompletedOutputLogsData(output);
  const opaque=assertCurrentPositiveOpaquePreservationRetained(held.auxiliary);
  return Object.freeze({auxiliaryAuth:"retained_mounted_for_original_whole_guest_teardown",auxiliaryAuthClosed:false,
    retainedReferences:held.references,opaque,sourceClosureAndOwnerUnchanged:true});
}
