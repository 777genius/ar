/** One genuine cold -> natural C HOT -> ColdV2 -> two R uses. TEST only. */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { setTimeout as wait } from "node:timers/promises";
import { HostedActivationPhase, HostedCustodyPhase } from "../../dist/worker-core/index.js";
import { HostedInstallationActivationStore, readHostedInstallationActivation } from "../../dist/worker-codex/hosted-installation-activation.js";
import { readHostedReadonlyHostInventory } from "../../dist/worker-codex/hosted-readonly-host-kernel.js";
import { HostedReadonlyEpochStore } from "../../dist/worker-codex/hosted-readonly-epoch-store.js";
import { prepareCurrentHostedDependencyColdCustody, completeCurrentHostedDependencyColdCustody } from "../../dist/worker-codex/hosted-current-dependency-origin.js";
import { readonlyIdentityName } from "../../dist/worker-codex/hosted-readonly-authority.js";
import { assertCurrentConfiguredAuth, assertRootScope, readCurrentIndependentColdPolicy, type CurrentColdHotRoots } from "./current-cold-hot-root.js";
import { FullEntryKind, FullRequestPhase, runCurrentOrdinaryEntry, requestCurrentNextWork, assertCurrentNextWorkDelivered, assertDistinctCurrentEntries } from "./current-full-entry.js";
import { runCurrentReadonlyEntry } from "./current-full-r-entry.js";
import { editCurrentPureLinkedLeaf } from "./current-full-warm-edit.js";
import { mountCurrentConfiguredAuth } from "./current-configured-auth-mount.js";
import { startNativeInstallerTrace, NativeInstallerTraceState } from "./native-installer-observations.js";
import { command, json, node, runtime } from "./common.ts";
export enum FullFlowPhase { Cold="cold", CurrentHot="current_hot", IndependentReview="independent_review", ColdTransfer="cold_transfer", ReadonlyFirst="readonly_first", ReadonlyHot="readonly_hot", FinalClose="final_close", Observed="observed" }
export type FullFlowProgress=(phase:FullFlowPhase)=>void;
/** The independent ROOT input may be installed while C work runs. Absence is
 * bounded waiting before preparation; malformed/present input is not retried.
 * No source-generated positive REVIEW, grant, policy or assumed stage exists. */
async function independentPolicy(roots:CurrentColdHotRoots,deadline:number) {
  const path="/run/user/0/subscription-runtime-host-policy/codex-readonly-reviewed/"+readonlyIdentityName(roots.readonlyJobId);
  while(!existsSync(path)) { assert(performance.now()+500<deadline,"TEST independent policy input deadline");await wait(500); }
  return readCurrentIndependentColdPolicy(roots);
}
/** All effects use existing actual issuers/runtime/host composition. The result
 * remains a four-entry measured slice, not full8 acceptance. Failure retains
 * own auth attachment and unresolved production state for OS-owned teardown. */
export async function runCurrentFullFlow(roots:CurrentColdHotRoots,progress:FullFlowProgress) {
  assertRootScope(roots);const deadline=performance.now()+27*60*1000;
  const auth=mountCurrentConfiguredAuth(roots.jobRoot,roots.accountName);assertCurrentConfiguredAuth(roots);
  // Only factual request bytes are shared. The independently installed REVIEW
  // has its distinct protected producer/input path and is never emitted here.
  json("/run/TEST-full-flow-outbox/cold-policy-request.json",{schemaVersion:1,candidateJobId:roots.candidateJobId,readonlyJobId:roots.readonlyJobId,
    jobRoot:roots.jobRoot,workspace:roots.workspaceIdentity,runtimeSha:roots.sourceSha,runtimeManifestSha256:roots.runtimeManifestSha256,
    readonlyPaths:["packages/live","packages/packed","TEST-readonly-local-custody"].map(p=>roots.workspace+"/"+p),
    runtimeLaunch:readHostedReadonlyHostInventory().runtimeLaunch},0o600);
  const trace=startNativeInstallerTrace(roots.candidateJobId,27*60*1000),store=new HostedInstallationActivationStore();let traceClosed=false;
  try {
    // Genuine original birth/catalog while Closed precedes the first C use.
    const birth=store.enrollOrdinary(roots.candidateJobId);
    assert.equal(birth.jobId,roots.candidateJobId);assert.equal(birth.jobRootDir,roots.jobRoot);assert.equal(birth.workspacePath,roots.workspace);
    progress(FullFlowPhase.Cold);store.resumeOrdinary();const cold=await runCurrentOrdinaryEntry(roots,FullEntryKind.Cold);
    store.finishClosed();const warmEdit=editCurrentPureLinkedLeaf(roots,cold.result);
    const cRequest=await requestCurrentNextWork(roots,FullRequestPhase.CurrentHot);
    progress(FullFlowPhase.CurrentHot);store.resumeOrdinary();const currentHot=await runCurrentOrdinaryEntry(roots,FullEntryKind.Hot);
    const cDelivery=await assertCurrentNextWorkDelivered(roots,cRequest);
    progress(FullFlowPhase.IndependentReview);const policy=await independentPolicy(roots,deadline);
    assert.equal(readHostedInstallationActivation().activation.phase,HostedActivationPhase.Ordinary);
    progress(FullFlowPhase.ColdTransfer);const preparation=prepareCurrentHostedDependencyColdCustody(policy);
    store.enterExclusive();const cli=runtime+"/dist/worker-codex/hosted-readonly-inputs-cli.js";
    command(node,[cli,"enroll",preparation.policyPath],120000);
    completeCurrentHostedDependencyColdCustody(roots.candidateJobId);
    // Initial recover is EnteringExclusive. Later per-use recovery is real host.
    command(node,[cli,"recover",roots.readonlyJobId],120000);store.finishExclusive();
    const epoch=new HostedReadonlyEpochStore().readEpoch();assert.equal(epoch.phase,HostedCustodyPhase.Ready);assert.equal(epoch.identity.jobId,roots.readonlyJobId);
    const rRequest=await requestCurrentNextWork(roots,FullRequestPhase.ReadonlyFirst);
    progress(FullFlowPhase.ReadonlyFirst);const readonlyFirst=await runCurrentReadonlyEntry(roots),rDelivery=await assertCurrentNextWorkDelivered(roots,rRequest);
    const hRequest=await requestCurrentNextWork(roots,FullRequestPhase.ReadonlyHot);
    progress(FullFlowPhase.ReadonlyHot);const readonlyHot=await runCurrentReadonlyEntry(roots),hDelivery=await assertCurrentNextWorkDelivered(roots,hRequest);
    const entries=[cold,currentHot,readonlyFirst,readonlyHot];assertDistinctCurrentEntries(entries);
    progress(FullFlowPhase.FinalClose);store.revokeManaged(roots.readonlyJobId);store.finishClosed();auth.close(readonlyHot.result);
    const installer=trace.finish();traceClosed=true;assert.equal(installer.state,NativeInstallerTraceState.Measured);
    assert.equal(installer.launchedInstalls,1);assert.equal(installer.completedInstalls,1);
    progress(FullFlowPhase.Observed);
    return Object.freeze({entries:entries.map(entry=>entry.observation),installer,warmEdit,control:[cDelivery,rDelivery,hDelivery],
      transferOperationId:preparation.operationId,qualification:"native_actual_c_cold_hot_coldv2_r_entries_only"});
  } finally { if(!traceClosed)trace.finish(); }
}
