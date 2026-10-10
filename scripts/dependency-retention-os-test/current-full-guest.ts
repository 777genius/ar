import { closePreparedCurrentConfiguredAuth } from "./current-cold-hot-root.js";
import { assertOriginalFullBackingPreparation } from "../../dist/worker-codex/hosted-full-backing-interval.js";
import { HostedReadonlyEpochStore } from "../../dist/worker-codex/hosted-readonly-epoch-store.js";
import { readHostedDependencyBinding, hostedDependencyOwnerRoot } from "../../dist/provider-codex/app-server/adapters/hosted-dependency-workspace.js";
import { LocalDependencyOwnerStore } from "../../dist/store-local-file/dependency-environment/local-dependency-owner-store.js";
import { currentIdleClosureMatches } from "./current-closed-entry.js";
/** Separate real-provider cohort. Never dispatched by historical CLOSED route. */
import assert from "node:assert/strict";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { isDependencyCustodyObject } from "../../dist/core/dependency-environment/dependency-custody-evidence.js";
import { readHostedPrivateBytes } from "../../dist/worker-codex/hosted-readonly-inputs.js";
import { assertReadonlyHostOperator } from "../../dist/worker-codex/hosted-readonly-authority.js";
import { prepareCurrentFullColdHotRoots, assertRootScope, type CurrentColdHotRoots } from "./current-cold-hot-root.js";
import { assertConfiguredAccountName } from "./current-configured-auth-mount.js";
import { CurrentBackingGeometry, readCurrentBackingGeometry } from "./current-backing-geometry.js";
import { runCurrentFullEvictRestoreFlow, runCurrentFullEvictReadonlyRestoreFlow, EvictRestorePhase } from "./current-full-evict-restore-flow.js";
import { runCurrentFullReadonlyContinuation } from "./current-full-r-continuation.js";
import { FullFlowPhase } from "./current-full-flow.js";
import { assertDistinctCurrentEntries } from "./current-full-entry.js";
import { HostedActivationPhase, HostedCustodyPhase, HostedCustodyReservationState } from "../../dist/worker-core/index.js";
import { readHostedInstallationActivation } from "../../dist/worker-codex/hosted-installation-activation.js";
import { HostedReadonlyHostKernel, readHostedReadonlyHostInventory } from "../../dist/worker-codex/hosted-readonly-host-kernel.js";
import { createReadonlyPrivateRecord } from "../../dist/worker-codex/hosted-readonly-custody.js";
import { readHostedDependencyEvictionEnabled } from "../../dist/worker-codex/hosted-dependency-eviction-enabled-policy.js";
import { pinReferenceFile } from "../../dist/worker-codex/hosted-dependency-legacy-reference-records.js";
import { withHostedActivationFence } from "../../dist/provider-codex/app-server/adapters/hosted-process-activation.js";
import { observeRegistrationFailure } from "./registration-failure-observation.js";
import { json, runtime } from "./common.ts";
enum FullGuestRestoreConsumer { Ordinary="ordinary", Readonly="readonly" }
enum FullGuestStatus { Failed="failed", PartialPass="partial_pass" }
enum FullGuestSetup { Input="independent_input", Root="original_fresh_current_root", Policy="root_test_eviction_policy" }
const evidence:Record<string,unknown>={schemaVersion:1,sourceSha:process.env.TEST_SOURCE_SHA,
  qualification:"native_actual_c_cold_hot_committed_absent_restore_coldv2_r_entries_only",status:FullGuestStatus.Failed,results:[],
  fullPlanQualification:"pending",sourcePathDeliveryQualification:"pending",
  remaining:["UNVERIFIED-REUSE","G1-ALL-READERS-STALE-DOWNGRADE","TRUTHFUL-WARM-AND-MUTATION-KEYS",
    "COMPRESSED-MANIFEST-QUARANTINE","MOUNT-TOCTOU-CRASH-TABLE","LEGACY-CLEAN-MUTATED-MODE-UNKNOWN-BOUNDS",
    "DERIVED-NEXT-CLEANUP","ACTIVE-EXCLUSION-UNCERTAIN-FAILURE-PRESERVATION","INDEPENDENT-REVIEW-EXACT-CI-NATIVE",
    "ORIGINAL-30-SOURCE-PATH-DELIVERY"]};
/** Finite ROOT TEST fixture config, never native-v2 qualification or a grant.
 * The existing managed FULL producer must independently qualify the NEW exact
 * compiled guest/source/catalog including this fixture effect before launch.
 * reviewReference text/schema alone does not authorize or prove that review. */
function prepareCurrentTestEvictionPolicy(roots:CurrentColdHotRoots,inputReference:ReturnType<typeof pinReferenceFile>["reference"]) {
  return withHostedActivationFence(()=>{
    assertReadonlyHostOperator();assertRootScope(roots);
    assert.deepEqual(pinReferenceFile("/run/TEST-full-flow-input/input.json",4096).reference,inputReference);
    const actual=readHostedInstallationActivation();assert.equal(actual.activation.phase,HostedActivationPhase.Closed);
    assert.equal(actual.installation.runtimeSha,roots.sourceSha);assert.equal(actual.activation.ordinaryStarts.length,0);
    const creators=readHostedReadonlyHostInventory().ordinaryCreators;assert.equal(creators.length,1);
    assert.equal(creators[0]!.jobId,roots.candidateJobId);assert.equal(creators[0]!.workspacePath,roots.workspace);
    new HostedReadonlyHostKernel().verifyExclusiveInventory();
    const path="/var/lib/subscription-runtime-host-policy/dependency-retention-policy.json";
    const parent=lstatSync("/var/lib/subscription-runtime-host-policy");
    assert(parent.isDirectory() && !parent.isSymbolicLink() && parent.uid===0 && parent.gid===0 && (parent.mode&0o7777)===0o700);
    assert(!existsSync(path));
    createReadonlyPrivateRecord(path,Buffer.from(JSON.stringify({version:1,managedReadyRequired:true,evictionEnabled:true})+"\n"));
    const selected=pinReferenceFile(path,4096);assert.equal(readHostedDependencyEvictionEnabled(),true);
    assert.deepEqual(pinReferenceFile("/run/TEST-full-flow-input/input.json",4096).reference,inputReference);
    return Object.freeze({purpose:"ROOT_TEST_v1_fixture_configuration_only",reference:selected.reference,nativePolicyV2Qualification:"pending"});
  });
}
import { FullH1Case, originalH1Case } from "./current-removal-h1-fixture.js";
try {
  assertReadonlyHostOperator();assert.equal(process.argv[2],"qualify");
  const removalCase=process.argv.length===4 && process.argv[3]==="--parent-crash-h1" ? originalH1Case() : FullH1Case.Positive;assert.equal(process.argv.length,removalCase===FullH1Case.ParentCrash?4:3);
  assert.equal(readCurrentBackingGeometry(),CurrentBackingGeometry.Adoptable);
  assert.match(process.env.TEST_SOURCE_SHA??"",/^[a-f0-9]{40}$/);
  const consumer=process.env.TEST_FULL_RESTORE_CONSUMER??FullGuestRestoreConsumer.Ordinary;
  assert(consumer===FullGuestRestoreConsumer.Ordinary || consumer===FullGuestRestoreConsumer.Readonly);evidence.restoreConsumer=consumer;
  if(consumer===FullGuestRestoreConsumer.Readonly)evidence.qualification="native_actual_c_cold_hot_committed_absent_first_r_restore_only";
  const fullDeadline=performance.now()+27*60*1000;
  evidence.phase=FullGuestSetup.Input;
  const bytes=readHostedPrivateBytes("/run/TEST-full-flow-input/input.json",4096);assert(bytes);
  const inputPin=pinReferenceFile("/run/TEST-full-flow-input/input.json",4096);assert(inputPin.bytes.equals(bytes));
  const input:unknown=JSON.parse(bytes.toString("utf8"));
  assert(isDependencyCustodyObject(input,"accountName,reviewReference,schemaVersion,sourceSha") && input.schemaVersion===1);
  assert(Buffer.from(JSON.stringify(input)+"\n").equals(bytes));assert.equal(input.sourceSha,process.env.TEST_SOURCE_SHA);
  assert(typeof input.accountName==="string");assertConfiguredAccountName(input.accountName);
  assert(typeof input.reviewReference==="string" && /^[A-Za-z0-9][A-Za-z0-9_.:/#-]{0,255}$/.test(input.reviewReference));
  assert(!readFileSync("/etc/passwd","utf8").split("\n").some(line=>line.split(":")[2]==="65532"));
  assert(!readFileSync("/etc/group","utf8").split("\n").some(line=>line.split(":")[2]==="65532"));
  evidence.machineId=readFileSync("/etc/machine-id","utf8").trim();evidence.phase=FullGuestSetup.Root;
  const roots=await prepareCurrentFullColdHotRoots(evidence,input.accountName);
  evidence.freshCohort={candidateJobId:roots.candidateJobId,readonlyJobId:roots.readonlyJobId,workspace:roots.workspaceIdentity,
    sourceSha:roots.sourceSha,runtimeManifestSha256:roots.runtimeManifestSha256,independentInputReview:input.reviewReference};
  // Factual setup request. Only the ORIGINAL parent can publish its once-only
  // backing qualification; this child cannot turn request bytes into authority.
  json("/run/TEST-full-flow-outbox/current-full-interval-request.json",{schemaVersion:1,sourceSha:roots.sourceSha,runtimeManifestSha256:roots.runtimeManifestSha256});
  const qualifiedPath="/var/lib/subscription-runtime-full-parent-live/seals/current-full-backing.json";
  // No-overwrite publication links the already-fsynced pending file, then
  // drops that temporary name. Wait for its single-link protected read boundary.
  while(true){
    if(existsSync(qualifiedPath)){const stat=lstatSync(qualifiedPath);assert(stat.isFile() && !stat.isSymbolicLink() && stat.uid===0 && stat.gid===0 && (stat.mode&0o7777)===0o600 && [1,2].includes(stat.nlink));if(stat.nlink===1){assert(readHostedPrivateBytes(qualifiedPath,16384));break;}}
    assertOriginalFullBackingPreparation();assert(performance.now()<fullDeadline);await new Promise(resolve=>setTimeout(resolve,100));
  }
  evidence.phase=FullGuestSetup.Policy;evidence.testEvictionPolicy=prepareCurrentTestEvictionPolicy(roots,inputPin.reference);
  assert(removalCase!==FullH1Case.ParentCrash || consumer===FullGuestRestoreConsumer.Ordinary);
  const progress=(phase:EvictRestorePhase)=>{evidence.phase={flow:"evict_restore",phase};};
  const evictRestore=await (consumer===FullGuestRestoreConsumer.Readonly ? runCurrentFullEvictReadonlyRestoreFlow(roots,progress) : runCurrentFullEvictRestoreFlow(roots,progress,removalCase));
  // Preserve observed C slice if later independent review/R continuation fails.
  evidence.evictRestore=evictRestore;
  const restored=evictRestore.entries.at(-1);assert(restored);
  const readonlyContinuation=consumer===FullGuestRestoreConsumer.Readonly ? undefined : await runCurrentFullReadonlyContinuation(roots,restored,Math.floor(fullDeadline-performance.now()),
    (phase:FullFlowPhase)=>{evidence.phase={flow:"readonly_continuation",phase};});
  const entries=[...evictRestore.entries,...(readonlyContinuation?.entries??[])];
  assertDistinctCurrentEntries(entries.map(observation=>({observation})));
  evidence.flow=Object.freeze({evictRestore,readonlyContinuation,entries,cumulativeInstalls:2});
  // Original store/flow already performed drain and recovery. Reobserve the
  // actual protected terminal sources under its original serialized fence.
  withHostedActivationFence(()=>{
    assertOriginalFullBackingPreparation();assertRootScope(roots);
    const actual=readHostedInstallationActivation();assert.equal(actual.activation.phase,HostedActivationPhase.Closed);
    assert(actual.activation.ordinaryStarts.every(row=>row.state===HostedCustodyReservationState.Terminal));
    const epoch=new HostedReadonlyEpochStore().readEpoch();assert.equal(epoch.phase,HostedCustodyPhase.Closed);assert.equal(epoch.revoked,true);
    assert(epoch.reservations.every(row=>row.state===HostedCustodyReservationState.Terminal));assert(epoch.outerRuntime===null || epoch.outerRuntime.state===HostedCustodyReservationState.Terminal);
    const binding=readHostedDependencyBinding(roots.candidateJobId);assert(binding && binding.version===2);
    const owners=LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384});
    const owner=(()=>{try{const value=owners.read(binding.workspace);assert(value && value.owner===null);return value;}finally{owners.close();}})();
    const base="/var/lib/subscription-runtime-host-policy",idle=pinReferenceFile(base+"/dependency-generation-idle-closures/"+binding.workspace.dev+"-"+binding.workspace.ino+"/"+owner.revision+".json",16384),value:unknown=JSON.parse(idle.bytes.toString("utf8"));
    assert(isDependencyCustodyObject(value,"attempt,binding,previousOwnerSha256,releasedOwner,releasedOwnerSha256,sourceClosed,version") && value.version===1);
    assert(isDependencyCustodyObject(value.attempt,"attemptId,epoch,launch") && value.attempt.launch && typeof value.attempt.launch==="object" && "startId" in value.attempt.launch && typeof value.attempt.launch.startId==="string");
    assert(value.sourceClosed && typeof value.sourceClosed==="object" && "path" in value.sourceClosed && typeof value.sourceClosed.path==="string" && /^\/var\/lib\/subscription-runtime-host-policy\/dependency-generation-source-closures\/[0-9a-f-]{36}\.json$/.test(value.sourceClosed.path));
    const source=pinReferenceFile(value.sourceClosed.path,65536);assert(currentIdleClosureMatches(owner,binding,value,source.reference,value.attempt.launch.startId));
    for(const directory of [base+"/dependency-transactions",hostedDependencyOwnerRoot]){const stat=lstatSync(directory);assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid===0 && stat.gid===0 && (stat.mode&0o7777)===0o700);assert(!readdirSync(directory).some(name=>/\.remove\.lock$|\.close-unresolved\.json$|\.lock$|^\.pending-/.test(name)));}
    new HostedReadonlyHostKernel().verifyExclusiveInventory();new HostedReadonlyHostKernel().verifyDescriptorBoundary();
    const pair=pinReferenceFile("/var/lib/subscription-runtime-full-parent-live/seals/current-full-pair.json",16384),invocation=pinReferenceFile("/var/lib/subscription-runtime-full-parent-live/seals/current-full-pair-invocation.json",4096);
    assert.deepEqual(pinReferenceFile(source.reference.path,65536).reference,source.reference);assert.deepEqual(pinReferenceFile(idle.reference.path,16384).reference,idle.reference);
    // Factual terminal observer, not a release grant. Parent additionally proves
    // recursive whole-guest drain and queued-job absence before dropping holds.
    createReadonlyPrivateRecord(base+"/current-full-terminal.json",Buffer.from(JSON.stringify({schemaVersion:1,sourceSha:roots.sourceSha,pairSha256:pair.reference.sha256,invocationSealSha256:invocation.reference.sha256,activationGeneration:actual.activation.generation,epochGeneration:epoch.generation,workspace:binding.workspace,sourceClosed:source.reference,idleClosed:idle.reference})+"\n"));
  });
  closePreparedCurrentConfiguredAuth(roots); // No further job admission after static role release.
  evidence.status=FullGuestStatus.PartialPass;
} catch(error:unknown) {
  evidence.failure="TEST_actual_full_retention_slice_failed";evidence.failureObservation=observeRegistrationFailure(error);process.exitCode=1;
} finally {
  // Never serialize error/message, provider output, auth, HOME or arbitrary data.
  assert(Buffer.byteLength(JSON.stringify(evidence))<=256*1024);json(runtime+"/guest-evidence.json",evidence,0o644);
}
