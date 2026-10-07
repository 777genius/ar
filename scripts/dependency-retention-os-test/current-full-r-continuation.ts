/** Retain existing genuine ColdV2/R first/HOT after the reviewed C restore slice. */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { setTimeout as wait } from "node:timers/promises";
import { HostedActivationPhase, HostedCustodyPhase, HostedCustodyReservationState } from "../../dist/worker-core/index.js";
import { HostedInstallationActivationStore, readHostedInstallationActivation } from "../../dist/worker-codex/hosted-installation-activation.js";
import { HostedReadonlyEpochStore } from "../../dist/worker-codex/hosted-readonly-epoch-store.js";
import { prepareCurrentHostedDependencyColdCustody, completeCurrentHostedDependencyColdCustody } from "../../dist/worker-codex/hosted-current-dependency-origin.js";
import { readonlyIdentityName } from "../../dist/worker-codex/hosted-readonly-authority.js";
import { assertCurrentConfiguredAuth, assertRootScope, readCurrentIndependentColdPolicy, type CurrentColdHotRoots } from "./current-cold-hot-root.js";
import { FullEntryKind, FullRequestPhase, requestCurrentNextWork, assertCurrentNextWorkDelivered, assertDistinctCurrentEntries } from "./current-full-entry.js";
import { FullFlowPhase } from "./current-full-flow.js";
import { runCurrentReadonlyEntry } from "./current-full-r-entry.js";
import { mountCurrentConfiguredAuth } from "./current-configured-auth-mount.js";
import { startNativeInstallerTrace, NativeInstallerTraceState } from "./native-installer-observations.js";
import { HostedReadonlyHostKernel, readHostedReadonlyHostInventory } from "../../dist/worker-codex/hosted-readonly-host-kernel.js";
import { assertReadonlyHostOperator } from "../../dist/worker-codex/hosted-readonly-authority.js";
import { readHostedOrdinaryReaderFinalFacts } from "../../dist/worker-codex/hosted-ordinary-reader-final-facts.js";
import { pinReferenceFile } from "../../dist/worker-codex/hosted-dependency-legacy-reference-records.js";
import { readHostedDependencyBinding, hostedDependencyOwnerRoot } from "../../dist/provider-codex/app-server/adapters/hosted-dependency-workspace.js";
import { LocalDependencyOwnerStore } from "../../dist/store-local-file/dependency-environment/local-dependency-owner-store.js";
import { withHostedActivationFence } from "../../dist/provider-codex/app-server/adapters/hosted-process-activation.js";
import { currentIdleClosureMatches } from "./current-closed-entry.js";
import type { runCurrentFullEvictRestoreFlow } from "./current-full-evict-restore-flow.js";
import { command, json, node, runtime } from "./common.ts";
type RestoredObservation=Awaited<ReturnType<typeof runCurrentFullEvictRestoreFlow>>["entries"][number];
/** Selectors are diagnostics only. Original operator/final reader, protected
 * owner+idle/source facts and current kernel census authorize this ROOT remount. */
function currentClosedRestore(roots:CurrentColdHotRoots,restored:RestoredObservation) {
  return withHostedActivationFence(fence=>{
    assertReadonlyHostOperator();assertRootScope(roots);assert.equal(restored.kind,FullEntryKind.Restored);
    const actual=readHostedInstallationActivation();assert.equal(actual.activation.phase,HostedActivationPhase.Closed);
    assert(actual.activation.ordinaryStarts.every(row=>row.state===HostedCustodyReservationState.Terminal));
    const final=readHostedOrdinaryReaderFinalFacts(fence,restored.startId);
    assert.equal(final.reader.startId,restored.startId);assert.equal(final.reader.creatorId,roots.candidateJobId);
    assert.equal(final.attempt.attemptId,restored.attemptId);assert.equal(String(final.attempt.epoch),restored.epoch);
    assert.deepEqual(final.preclaim,restored.preclaim);
    const binding=readHostedDependencyBinding(roots.candidateJobId);assert(binding && binding.version===2);
    const owners=LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384});
    const owner=(()=>{try {const value=owners.read(binding.workspace);assert(value && value.owner===null);return value;} finally {owners.close();}})();
    const base="/var/lib/subscription-runtime-host-policy",source=pinReferenceFile(base+"/dependency-generation-source-closures/"+restored.startId+".json",65536);
    assert.equal(source.reference.sha256,restored.sourceClosedSha256);
    const idle=pinReferenceFile(base+"/dependency-generation-idle-closures/"+binding.workspace.dev+"-"+binding.workspace.ino+"/"+owner.revision+".json",16384);
    assert(currentIdleClosureMatches(owner,binding,JSON.parse(idle.bytes.toString("utf8")),source.reference,restored.startId));
    const kernel=new HostedReadonlyHostKernel();kernel.verifyExclusiveInventory();kernel.verifyDescriptorBoundary();
    assert.deepEqual(pinReferenceFile(source.reference.path,65536).reference,source.reference);
    assert.deepEqual(pinReferenceFile(idle.reference.path,16384).reference,idle.reference);
    return Object.freeze({sourceClosed:source.reference,idleClosed:idle.reference});
  });
}
/** Uses the original reviewed-input inbox/outbox and original custody APIs.
 * No independent ColdV2 review/lease is emitted by this caller. Failure holds
 * auth and genuine unresolved production state for original owned OS teardown. */
export async function runCurrentFullReadonlyContinuation(roots:CurrentColdHotRoots,restored:RestoredObservation,maximumMs:number,progress:(phase:FullFlowPhase)=>void) {
  assertRootScope(roots);assert.equal(readHostedInstallationActivation().activation.phase,HostedActivationPhase.Closed);
  assert(Number.isSafeInteger(maximumMs) && maximumMs>0 && maximumMs<=27*60*1000);
  const deadline=performance.now()+maximumMs,store=new HostedInstallationActivationStore(),closedRestore=currentClosedRestore(roots,restored);
  const remaining=()=>{const ms=Math.floor(deadline-performance.now());assert(ms>0,"TEST shared FULL work budget");return ms;};
  const auth=mountCurrentConfiguredAuth(roots.jobRoot,roots.accountName);assertCurrentConfiguredAuth(roots);
  currentClosedRestore(roots,restored);
  json("/run/TEST-full-flow-outbox/cold-policy-request.json",{schemaVersion:1,candidateJobId:roots.candidateJobId,readonlyJobId:roots.readonlyJobId,
    jobRoot:roots.jobRoot,workspace:roots.workspaceIdentity,runtimeSha:roots.sourceSha,runtimeManifestSha256:roots.runtimeManifestSha256,
    readonlyPaths:["packages/live","packages/packed","TEST-readonly-local-custody"].map(path=>roots.workspace+"/"+path),
    runtimeLaunch:readHostedReadonlyHostInventory().runtimeLaunch},0o600);
  const trace=startNativeInstallerTrace(roots.candidateJobId,remaining());
  let traceClosed=false,managedEnrolled=false,revocationAttempted=false;
  try {
    store.resumeOrdinary();progress(FullFlowPhase.IndependentReview);
    const input="/run/user/0/subscription-runtime-host-policy/codex-readonly-reviewed/"+readonlyIdentityName(roots.readonlyJobId);
    while(!existsSync(input)) {assert(performance.now()+500<deadline,"TEST independent ColdV2 input deadline");await wait(500);}
    const policy=readCurrentIndependentColdPolicy(roots);
    progress(FullFlowPhase.ColdTransfer);const preparation=prepareCurrentHostedDependencyColdCustody(policy);
    store.enterExclusive();const cli=runtime+"/dist/worker-codex/hosted-readonly-inputs-cli.js";
    command(node,[cli,"enroll",preparation.policyPath],Math.min(120000,remaining()));
    const enrolled=new HostedReadonlyEpochStore().readEpoch();assert.equal(enrolled.identity.jobId,roots.readonlyJobId);
    assert.equal(enrolled.identity.jobRootDir,roots.jobRoot);assert.equal(enrolled.identity.workspacePath,roots.workspace);
    assert.equal(enrolled.identity.runtimeSha,roots.sourceSha);assert.equal(enrolled.identity.runtimeManifestSha256,roots.runtimeManifestSha256);managedEnrolled=true;
    completeCurrentHostedDependencyColdCustody(roots.candidateJobId);
    command(node,[cli,"recover",roots.readonlyJobId],Math.min(120000,remaining()));store.finishExclusive();
    const epoch=new HostedReadonlyEpochStore().readEpoch();assert.equal(epoch.phase,HostedCustodyPhase.Ready);assert.equal(epoch.identity.jobId,roots.readonlyJobId);
    const firstRequest=await requestCurrentNextWork(roots,FullRequestPhase.ReadonlyFirst);
    progress(FullFlowPhase.ReadonlyFirst);remaining();const first=await runCurrentReadonlyEntry(roots),firstDelivery=await assertCurrentNextWorkDelivered(roots,firstRequest);remaining();
    const hotRequest=await requestCurrentNextWork(roots,FullRequestPhase.ReadonlyHot);
    progress(FullFlowPhase.ReadonlyHot);remaining();const hot=await runCurrentReadonlyEntry(roots),hotDelivery=await assertCurrentNextWorkDelivered(roots,hotRequest);remaining();
    assert.equal(first.observation.kind,FullEntryKind.Hot);assert.equal(hot.observation.kind,FullEntryKind.Hot);assertDistinctCurrentEntries([first,hot]);
    progress(FullFlowPhase.FinalClose);revocationAttempted=true;store.revokeManaged(roots.readonlyJobId);store.finishClosed();auth.close(hot.result);
    traceClosed=true;const installer=trace.finish();assert(installer.state===NativeInstallerTraceState.Measured);
    assert.equal(installer.launchedInstalls,0);assert.equal(installer.completedInstalls,0);assert.equal(installer.excludedPriorStarts,2);
    progress(FullFlowPhase.Observed);
    return Object.freeze({qualification:"native_actual_coldv2_r_first_hot_after_same_root_restore_only",entries:[first.observation,hot.observation],
      control:[firstDelivery,hotDelivery],installer,transferOperationId:preparation.operationId,closedRestore});
  } catch(error) {
    // Only genuine readback of this exact completed enrollment selects revoke.
    // Unknown partial enrollment is retained. Stop/closure failure never becomes
    // terminal proof and never authorizes auth.close or replaces primary error.
    if(managedEnrolled && !revocationAttempted) {
      revocationAttempted=true;try {store.revokeManaged(roots.readonlyJobId);} catch {process.stderr.write("TEST_R_revoke_unresolved\n");}
    }
    throw error;
  } finally {if(!traceClosed) {try {trace.finish();} catch {process.stderr.write("TEST_R_installer_observation_close_unresolved\n");}}}
}
