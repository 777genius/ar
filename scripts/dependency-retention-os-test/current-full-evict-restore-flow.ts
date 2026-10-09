/** Distinct fresh TEST lifecycle. Frozen four-entry mode stays unchanged. */
import assert from "node:assert/strict";
import { prepareCurrentHostedDependencyColdCustody, completeCurrentHostedDependencyColdCustody } from "../../dist/worker-codex/hosted-current-dependency-origin.js";
import { readHostedReadonlyHostInventory } from "../../dist/worker-codex/hosted-readonly-host-kernel.js";
import { readonlyIdentityName } from "../../dist/worker-codex/hosted-readonly-authority.js";
import { runCurrentReadonlyEntry } from "./current-full-r-entry.js";
import { existsSync } from "node:fs";
import { setTimeout as wait } from "node:timers/promises";
import { HostedActivationPhase } from "../../dist/worker-core/index.js";
import { HostedInstallationActivationStore, readHostedInstallationActivation }
  from "../../dist/worker-codex/hosted-installation-activation.js";
import { HostedDependencyTransactionOutcome } from "../../dist/worker-codex/hosted-dependency-transactions.js";
import { readHostedDependencyEvictionEnabled } from "../../dist/worker-codex/hosted-dependency-eviction-enabled-policy.js";
import { pinReferenceFile } from "../../dist/worker-codex/hosted-dependency-legacy-reference-records.js";
import { withHostedActivationFence } from "../../dist/provider-codex/app-server/adapters/hosted-process-activation.js";
import { assertCurrentConfiguredAuth, assertRootScope, readCurrentIndependentColdPolicy, type CurrentColdHotRoots } from "./current-cold-hot-root.js";
import { assertCurrentClosedEntry } from "./current-closed-entry.js";
import { mountCurrentConfiguredAuth } from "./current-configured-auth-mount.js";
import { FullEntryKind, FullRequestPhase, runCurrentOrdinaryEntry, requestCurrentNextWork,
  assertCurrentNextWorkDelivered, assertDistinctCurrentEntries } from "./current-full-entry.js";
import { editCurrentPureLinkedLeaf } from "./current-full-warm-edit.js";
import { NativeInstallerTraceState, startNativeInstallerTrace } from "./native-installer-observations.js";
import { prepareEvictRestoreSentinels, captureEvictRestoreSentinels, assertEvictRestoreSentinels } from "./current-evict-restore-sentinels.js";
import { readEvictRestoreReady, readEvictRestoreAbsent, assertPathAbsent, assertRetainedEvictionProof,
  assertSameRootFinalGateRestore, assertSameRootReadonlyFinalGateRestore } from "./current-evict-restore-readback.js";
import { command, node, runtime, directory, json } from "./common.ts";
import { FullH1Case, captureOriginalH1Checkpoint, requestOriginalH1 } from "./current-removal-h1-fixture.js";
const policyPath="/var/lib/subscription-runtime-host-policy/dependency-retention-policy.json";
export enum EvictRestorePhase { Cold="cold", Hot="hot", RootPolicyInput="root_policy_input", Evict="evict",
  Provenance="provenance_before_unlink", Remove="committed_trash_remove", Restore="same_root_final_gate_restore", Close="close" }
/** Source emits only factual request data. The exact protected v1 config must
 * be staged by the independently reviewed ROOT TEST composition. This driver
 * cannot write policy/grants, claim v2 qualification or broaden its namespace. */
async function enabledRootInput(deadline:number) {
  while(!existsSync(policyPath)) {assert(performance.now()+500<deadline,"TEST ROOT input deadline");await wait(500);}
  const selected=pinReferenceFile(policyPath,4096);
  assert.equal(readHostedDependencyEvictionEnabled(),true);
  assert.deepEqual(pinReferenceFile(policyPath,4096).reference,selected.reference);
  return selected.reference;
}
function assertPolicyCurrent(expected:Awaited<ReturnType<typeof enabledRootInput>>) {
  assert.deepEqual(pinReferenceFile(policyPath,4096).reference,expected);assert.equal(readHostedDependencyEvictionEnabled(),true);
  assert.deepEqual(pinReferenceFile(policyPath,4096).reference,expected);
}
function measuredInstall(trace:ReturnType<typeof startNativeInstallerTrace>,prior:number) {
  const result=trace.finish();assert(result.state===NativeInstallerTraceState.Measured);
  assert.equal(result.launchedInstalls,1);assert.equal(result.completedInstalls,1);assert.equal(result.excludedPriorStarts,prior);return result;
}
/** This calls genuine producers and gates, not manual Ready/Evicting/Absent or
 * owner publication. Unknown launch/effect is never retried. Failure retains
 * auth, proofs, holds and partial trash for original owned-OS teardown; earlier
 * protected provider/runtime result records are never rewritten by this test. */
enum RestoreConsumer { Ordinary = "ordinary", Readonly = "readonly" }
export function runCurrentFullEvictRestoreFlow(roots:CurrentColdHotRoots,progress:(phase:EvictRestorePhase)=>void,removalCase=FullH1Case.Positive) {return run(roots,progress,RestoreConsumer.Ordinary,removalCase);}
export function runCurrentFullEvictReadonlyRestoreFlow(roots:CurrentColdHotRoots,progress:(phase:EvictRestorePhase)=>void) {return run(roots,progress,RestoreConsumer.Readonly);}
async function run(roots:CurrentColdHotRoots,progress:(phase:EvictRestorePhase)=>void,consumer:RestoreConsumer,removalCase=FullH1Case.Positive) {
  assert(removalCase===FullH1Case.Positive || (removalCase===FullH1Case.ParentCrash && consumer===RestoreConsumer.Ordinary));
  assertRootScope(roots);assert.equal(readHostedInstallationActivation().activation.phase,HostedActivationPhase.Closed);
  const deadline=performance.now()+27*60*1000,store=new HostedInstallationActivationStore();
  const auth=mountCurrentConfiguredAuth(roots.jobRoot,roots.accountName);assertCurrentConfiguredAuth(roots);
  prepareEvictRestoreSentinels(roots);const initialSentinels=captureEvictRestoreSentinels(roots);
  let openTrace:ReturnType<typeof startNativeInstallerTrace>|undefined=startNativeInstallerTrace(roots.candidateJobId,27*60*1000);
  try {
    const birth=store.enrollOrdinary(roots.candidateJobId);assert.equal(birth.jobRootDir,roots.jobRoot);assert.equal(birth.workspacePath,roots.workspace);
    progress(EvictRestorePhase.Cold);store.resumeOrdinary();const cold=await runCurrentOrdinaryEntry(roots,FullEntryKind.Cold);
    store.finishClosed();withHostedActivationFence(fence=>assertCurrentClosedEntry(fence,roots.jobRoot,cold.result));
    assertEvictRestoreSentinels(roots,initialSentinels);
    const coldReady=readEvictRestoreReady(roots),warmEdit=editCurrentPureLinkedLeaf(roots,cold.result);
    assert.equal(coldReady.receipt.generation,cold.observation.attemptId);
    // The intentional original pure-link edit is complete before this retained
    // source baseline; the driver does not claim model text proves liveRevision.
    const sentinels=captureEvictRestoreSentinels(roots),hotRequest=await requestCurrentNextWork(roots,FullRequestPhase.CurrentHot);
    progress(EvictRestorePhase.Hot);store.resumeOrdinary();const hot=await runCurrentOrdinaryEntry(roots,FullEntryKind.Hot);
    const hotDelivery=await assertCurrentNextWorkDelivered(roots,hotRequest),ready=readEvictRestoreReady(roots);
    assert.deepEqual(ready,coldReady);assertEvictRestoreSentinels(roots,sentinels);
    const initialTrace=openTrace;openTrace=undefined;const initialInstaller=measuredInstall(initialTrace,0);
    progress(EvictRestorePhase.RootPolicyInput);
    const outbox="/run/TEST-evict-restore-outbox-"+roots.candidateJobId;assert(!existsSync(outbox));directory(outbox);
    json(outbox+"/request.json",{schemaVersion:1,candidateJobId:roots.candidateJobId,sourceSha:roots.sourceSha,
      runtimeManifestSha256:roots.runtimeManifestSha256,workspace:roots.workspaceIdentity,ready:ready.reference,
      requestedCase:"EVICT-COMMIT-ABSENT",supportedPolicyVersion:1},0o600);
    const policy=await enabledRootInput(deadline);assertPolicyCurrent(policy);
    assertPathAbsent(roots.workspace+"/.next"); // This slice proves no .next cleanup.
    progress(EvictRestorePhase.Evict);assert.equal(readHostedInstallationActivation().activation.phase,HostedActivationPhase.Ordinary);
    const evicted=await store.evictDependencyCandidate({jobId:roots.candidateJobId,revision:ready.receipt.revision,
      generation:ready.receipt.generation,installKey:ready.receipt.installKey});
    assert.equal(evicted.outcome,HostedDependencyTransactionOutcome.Evicted);
    progress(EvictRestorePhase.Provenance);const proof=readEvictRestoreAbsent(roots,ready);
    assert("revision" in evicted);assert.equal(evicted.revision,proof.absent.receipt.revision);assertRetainedEvictionProof(proof);
    assertEvictRestoreSentinels(roots,sentinels);assertPolicyCurrent(policy);
    // Remove while original owner is released RetiredEvicting, BEFORE new Active
    // generation. The existing global legacy-writer denial is left intact.
    progress(EvictRestorePhase.Remove);
    if(removalCase===FullH1Case.ParentCrash){captureOriginalH1Checkpoint(roots,sentinels,proof);await requestOriginalH1(roots.candidateJobId,proof.absent.receipt.revision,roots.workspaceIdentity,proof.absent.reference);}
    const removed=await store.removeDependencyCommittedTrash(roots.candidateJobId,proof.absent.receipt.revision);
    assert.equal(removalCase,FullH1Case.Positive,"TEST_H1_original_parent_not_killed_at_proven_boundary_HOLD");
    assert.equal(removed.outcome,HostedDependencyTransactionOutcome.TrashRemoved);
    assert("operationId" in removed && "removedEntries" in removed);assert.equal(removed.operationId,proof.absent.receipt.operationId);
    assert(typeof removed.removedEntries==="number" && removed.removedEntries>0);
    assertPathAbsent(proof.trash);assertPathAbsent(proof.operation+".remove.lock");assertRetainedEvictionProof(proof);
    assertEvictRestoreSentinels(roots,sentinels);assertPolicyCurrent(policy);
    const restoreRequest=await requestCurrentNextWork(roots,FullRequestPhase.ColdRestore);
    const remaining=Math.floor(deadline-performance.now());assert(remaining>0);
    openTrace=startNativeInstallerTrace(roots.candidateJobId,remaining);
    progress(EvictRestorePhase.Restore);let transferOperationId:string|undefined;
    if(consumer===RestoreConsumer.Readonly) {
      json("/run/TEST-full-flow-outbox/cold-policy-request.json",{schemaVersion:1,candidateJobId:roots.candidateJobId,readonlyJobId:roots.readonlyJobId,
        jobRoot:roots.jobRoot,workspace:roots.workspaceIdentity,runtimeSha:roots.sourceSha,runtimeManifestSha256:roots.runtimeManifestSha256,
        readonlyPaths:["packages/live","packages/packed","TEST-readonly-local-custody"].map(path=>roots.workspace+"/"+path),
        runtimeLaunch:readHostedReadonlyHostInventory().runtimeLaunch},0o600);
      const review=`/run/user/0/subscription-runtime-host-policy/codex-readonly-reviewed/${readonlyIdentityName(roots.readonlyJobId)}`;
      while(!existsSync(review)){assert(performance.now()+500<deadline,"TEST independent Absent custody review deadline");await wait(500);}
      const preparation=prepareCurrentHostedDependencyColdCustody(readCurrentIndependentColdPolicy(roots));transferOperationId=preparation.operationId;
      store.enterExclusive();const cli=runtime+"/dist/worker-codex/hosted-readonly-inputs-cli.js";
      command(node,[cli,"enroll",preparation.policyPath],120000);completeCurrentHostedDependencyColdCustody(roots.candidateJobId);
      command(node,[cli,"recover",roots.readonlyJobId],120000);store.finishExclusive();
    }
    const restored=consumer===RestoreConsumer.Readonly ? await runCurrentReadonlyEntry(roots,FullEntryKind.Restored) : await runCurrentOrdinaryEntry(roots,FullEntryKind.Restored);
    const restoreDelivery=await assertCurrentNextWorkDelivered(roots,restoreRequest);
    const restore=consumer===RestoreConsumer.Readonly ? assertSameRootReadonlyFinalGateRestore(roots,ready,proof,restored) :
      assertSameRootFinalGateRestore(roots,ready,proof,restored);assertDistinctCurrentEntries([cold,hot,restored]);
    assert(BigInt(restored.observation.epoch)>BigInt(hot.observation.epoch));
    const preserved=assertEvictRestoreSentinels(roots,sentinels),restoreTrace=openTrace;openTrace=undefined;
    const restoreInstaller=measuredInstall(restoreTrace,1);
    assert.equal(new Set([...initialInstaller.invocationIds,...restoreInstaller.invocationIds]).size,2);
    progress(EvictRestorePhase.Close);if(consumer===RestoreConsumer.Readonly)store.revokeManaged(roots.readonlyJobId);store.finishClosed();auth.close(restored.result);
    return Object.freeze({qualification:consumer===RestoreConsumer.Readonly ? "native_actual_c_cold_hot_committed_absent_first_r_restore_only" : "native_actual_c_cold_hot_committed_absent_restore_only",consumer,transferOperationId,status:"partial_pass",
      fullPlanQualification:"pending",entries:[cold,hot,restored].map(entry=>entry.observation),warmEdit,
      cases:["EVICT-COMMIT-ABSENT","COMMITTED-TRASH-PROVENANCE-REMOVE","FINAL-GATE-COLD-RESTORE"],
      remaining:["UNVERIFIED-REUSE","G1-ALL-READERS-STALE-DOWNGRADE","TRUTHFUL-WARM-AND-MUTATION-KEYS",
        "COMPRESSED-MANIFEST-QUARANTINE","MOUNT-TOCTOU-CRASH-TABLE","LEGACY-CLEAN-MUTATED-MODE-UNKNOWN-BOUNDS",
        "DERIVED-NEXT-CLEANUP","ACTIVE-EXCLUSION-UNCERTAIN-FAILURE-PRESERVATION","INDEPENDENT-REVIEW-EXACT-CI-NATIVE"],
      control:[hotDelivery,restoreDelivery],policyReference:policy,initialInstaller,restoreInstaller,cumulativeInstalls:2,
      evicted:{revision:proof.absent.receipt.revision,operationId:proof.absent.receipt.operationId,
        evicting:proof.evicting.reference,absent:proof.absent.reference,header:proof.header,renamed:proof.renamed},
      removed:{operationId:removed.operationId,removedEntries:removed.removedEntries,remainingTreeAbsent:true},restore,preserved,
      reclaimedBytes:{measurement:"unavailable",bytes:null},nativePolicyV2Qualification:"pending"});
  } finally {
    // Observation teardown only. It never authorizes lifecycle cleanup and must
    // not replace an earlier native/effect failure or alter any runtime result.
    if(openTrace) {try {openTrace.finish();} catch {process.stderr.write("TEST_installer_observation_close_unresolved\n");}}
  }
}
