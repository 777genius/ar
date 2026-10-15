/** Native TEST scenario only; called with fresh genuinely registered legacy C/reference
 * births and independently reviewed R custody. Never fabricates a baseline/receipt. */
import assert from "node:assert/strict";
import { existsSync, lstatSync } from "node:fs";
import { HostedCustodyPhase, HostedActivationPhase, HostedCustodyReservationState, DependencyReceiptState, DependencyGenerationContinuityKind } from "../../dist/worker-core/index.js";
import { HostedInstallationActivationStore, readHostedInstallationActivation } from "../../dist/worker-codex/hosted-installation-activation.js";
import { prepareHostedReadonlyDependencyAdoption, completeHostedReadonlyDependencyAdoption } from "../../dist/worker-codex/hosted-readonly-dependency-adoption.js";
import { HostedReadonlySupervisorHost } from "../../dist/worker-codex/hosted-readonly-supervisor-host.js";
import { readHostedReadonlyHostInventory } from "../../dist/worker-codex/hosted-readonly-host-kernel.js";
import { readHostedForegroundResultRecord } from "../../dist/worker-codex/hosted-foreground-result.js";
import { runHostedRuntimeForeground } from "../../dist/worker-codex/hosted-readonly-foreground.js";
import { assertHostedForegroundResult, readHostedForegroundLaunchObservation } from "../../dist/provider-codex/app-server/adapters/hosted-fd-launch.js";
import { HostedCustodySupervisor } from "../../dist/worker-core/index.js";
import { withHostedActivationFence } from "../../dist/provider-codex/app-server/adapters/hosted-process-activation.js";
import { readHostedDependencyBinding, hostedDependencyOwnerRoot } from "../../dist/provider-codex/app-server/adapters/hosted-dependency-workspace.js";
import { readHostedDependencyEstablishedReceipt, readHostedDependencyCommittedUnverified } from "../../dist/worker-codex/hosted-dependency-receipts.js";
import { LocalDependencyOwnerStore } from "../../dist/store-local-file/dependency-environment/local-dependency-owner-store.js";
import { pinReferenceFile } from "../../dist/worker-codex/hosted-dependency-legacy-reference-records.js";
import { dependencyToolQualificationRecordName } from "../../dist/core/dependency-environment/dependency-tool-profile.js";
import { parseDependencyToolAdmissionQualification } from "../../dist/core/dependency-environment/dependency-tool-execution.js";
import { DependencyToolExecutionBasis } from "../../dist/core/dependency-environment/dependency-tool-execution.js";
import { assertRootScope, assertCurrentConfiguredAuth, readCurrentIndependentColdPolicy, retainPreparedCurrentAuthCompletion, type CurrentColdHotRoots } from "./current-cold-hot-root.js";
import { LegacyRegisteredExpectation, assertRegisteredLegacyComparison } from "./legacy-registered-comparison.js";
import { currentFullEnvironment } from "./current-full-env.js";
import { FullRequestPhase, requestCurrentNextWork, assertCurrentNextWorkDelivered } from "./current-full-entry.js";
import { startNativeInstallerTrace, NativeInstallerTraceState } from "./native-installer-observations.js";
import { prepareEvictRestoreSentinels, captureEvictRestoreSentinels, assertEvictRestoreSentinels } from "./current-evict-restore-sentinels.js";
import { assertCurrentUnverifiedClosedEntry } from "./current-closed-entry.js";
import { readonlyIdentityName } from "../../dist/worker-codex/hosted-readonly-authority.js";
import { command, json, node, runtime } from "./common.ts";
const root="/var/lib/subscription-runtime-host-policy";
/** Original FULL invokes this only for its separately reviewed finite legacy
 * fixture case. Compilation or configuration never qualifies Native. */
export async function assertLegacyUnverifiedReadonlyContinuation(roots:CurrentColdHotRoots,referenceJobId:string,maximumMs:number) {
  assertRootScope(roots);assertCurrentConfiguredAuth(roots);
  assert(Number.isSafeInteger(maximumMs) && maximumMs>0 && maximumMs<=27*60*1000);
  const deadline=performance.now()+maximumMs,remaining=()=>{const ms=Math.floor(deadline-performance.now());assert(ms>0);return ms;};
  prepareEvictRestoreSentinels(roots);
  const store=new HostedInstallationActivationStore();store.resumeOrdinary();
  assert.equal(readHostedInstallationActivation().activation.phase,HostedActivationPhase.Ordinary);
  const comparison=await assertRegisteredLegacyComparison(roots.candidateJobId,referenceJobId,LegacyRegisteredExpectation.Compared);
  json("/run/TEST-full-flow-outbox/cold-policy-request.json",{schemaVersion:1,candidateJobId:roots.candidateJobId,readonlyJobId:roots.readonlyJobId,jobRoot:roots.jobRoot,workspace:roots.workspaceIdentity,runtimeSha:roots.sourceSha,runtimeManifestSha256:roots.runtimeManifestSha256,
    readonlyPaths:["packages/live","packages/packed","TEST-readonly-local-custody"].map(path=>roots.workspace+"/"+path),runtimeLaunch:readHostedReadonlyHostInventory().runtimeLaunch},0o600);
  const reviewed="/run/user/0/subscription-runtime-host-policy/codex-readonly-reviewed/"+readonlyIdentityName(roots.readonlyJobId);
  while(!existsSync(reviewed)){remaining();await new Promise(resolve=>setTimeout(resolve,100));}
  const initialTree=lstatSync(roots.workspace+"/node_modules",{bigint:true}),sentinels=captureEvictRestoreSentinels(roots),
    policy=readCurrentIndependentColdPolicy(roots);
  store.enterExclusive();assert.equal(readHostedInstallationActivation().activation.phase,HostedActivationPhase.EnteringExclusive);
  const preparation=prepareHostedReadonlyDependencyAdoption(policy),cli=runtime+"/dist/worker-codex/hosted-readonly-inputs-cli.js";
  command(node,[cli,"enroll",preparation.policyPath],120000);
  completeHostedReadonlyDependencyAdoption(roots.candidateJobId);
  command(node,[cli,"recover",roots.readonlyJobId],120000);store.finishExclusive();
  withHostedActivationFence(()=>{
    const binding=readHostedDependencyBinding(roots.candidateJobId);assert(binding&&binding.version===2);
    const owners=LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384});
    try{const owner=owners.read(binding.workspace);assert(owner&&owner.version===3&&owner.owner===null);assert.equal(owner.generationContinuity,undefined);}finally{owners.close();}
  });
  const host=new HostedReadonlySupervisorHost(),trace=startNativeInstallerTrace(roots.candidateJobId,remaining());
  let finished=false,finalResult:Awaited<ReturnType<typeof runHostedRuntimeForeground>>|undefined;
  try {
    const entries=[];
    for(const phase of [FullRequestPhase.ReadonlyFirst,FullRequestPhase.ReadonlyHot]) {
      remaining();const before=host.readEpoch();const request=await requestCurrentNextWork(roots,phase),launch=readHostedReadonlyHostInventory().runtimeLaunch;
      assert.equal(host.readEpoch().phase,HostedCustodyPhase.Ready);
      const result=await runHostedRuntimeForeground(launch.command,launch.args,launch.cwd,currentFullEnvironment());
      remaining();assert(typeof result!=="number");finalResult=result;assertHostedForegroundResult(result);assert.equal(result.exitCode,0);
      const native=readHostedForegroundLaunchObservation(result);assert.equal(native.closeStatus,0);
      const published=readHostedForegroundResultRecord(roots.jobRoot+"/state/TEST-result.json");
      assert.equal(published.value.status,"done");assert.equal(published.output.unit,native.unit);assert.equal(published.output.exitCode,0);
      const closed=host.readEpoch();assert.equal(closed.phase,HostedCustodyPhase.Closed);assert(closed.generation>=before.generation);
      assert(closed.reservations.every(row=>row.state===HostedCustodyReservationState.Terminal));assert(closed.outerRuntime?.state===HostedCustodyReservationState.Terminal);
      new HostedCustodySupervisor(host).recover(closed.identity);
      assert.equal(host.readEpoch().phase,HostedCustodyPhase.Ready);assert(host.readEpoch().generation>closed.generation);
      // Actual recovery above runs the unchanged Ready publication gate.
      withHostedActivationFence(fence=>{
        const binding=readHostedDependencyBinding(roots.candidateJobId);assert(binding&&binding.version===2);
        const owners=LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384});
        try {const owner=owners.read(binding.workspace);assert(owner&&owner.version===3&&owner.owner===null);
          assert(owner.generationContinuity===undefined||owner.generationContinuity.kind===DependencyGenerationContinuityKind.RetiredReadyV1);}finally{owners.close();}
        const receipt=readHostedDependencyEstablishedReceipt(binding);assert(receipt&&receipt.state===DependencyReceiptState.Unverified);
        const committed=readHostedDependencyCommittedUnverified(binding,receipt.revision);assert.deepEqual(committed.receipt,receipt);
        const qualification=pinReferenceFile(root+"/"+dependencyToolQualificationRecordName(native.startId),16384),
          q=parseDependencyToolAdmissionQualification(JSON.parse(qualification.bytes.toString("utf8")));
        assert(q.version===2&&q.execution.basis===DependencyToolExecutionBasis.UsableUnverified);
        const release=pinReferenceFile(root+"/dependency-unverified-r-releases/"+native.startId+".json",65536),
          value:unknown=JSON.parse(release.bytes.toString("utf8"));
        assert(value&&typeof value==="object"&&"identity" in value&&"releasedOwner" in value);
        assert.equal((value.identity as {outer:{startId:string}}).outer.startId,native.startId);
        const actual=lstatSync(roots.workspace+"/node_modules",{bigint:true});assert.equal(actual.dev,initialTree.dev);assert.equal(actual.ino,initialTree.ino);
      });
      assertEvictRestoreSentinels(roots,sentinels);
      entries.push({startId:native.startId,invocationId:native.invocationId,control:await assertCurrentNextWorkDelivered(roots,request)});
    }
    assert.notEqual(entries[0]!.startId,entries[1]!.startId);assert.notEqual(entries[0]!.invocationId,entries[1]!.invocationId);
    const installer=trace.finish();finished=true;assert.equal(installer.state,NativeInstallerTraceState.Measured);
    assert.equal(installer.launchedInstalls,0);assert.equal(installer.completedInstalls,0);
    assert(finalResult && typeof finalResult!=="number");const completed=finalResult;store.revokeManaged(roots.readonlyJobId);store.finishClosed();
    const terminal=withHostedActivationFence(fence=>assertCurrentUnverifiedClosedEntry(fence,roots.jobRoot,completed));
    retainPreparedCurrentAuthCompletion(roots,completed);
    return {terminal,qualification:"native_legacy_compared_adoption_unverified_r_first_hot_only",comparison,entries,installer};
  } finally {if(!finished){try{trace.finish();}catch{process.stderr.write("TEST unverified R observer close unresolved\n");}}}
}
