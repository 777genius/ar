/** Separate real-provider cohort. Never dispatched by historical CLOSED route. */
import assert from "node:assert/strict";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isDependencyCustodyObject } from "../../dist/core/dependency-environment/dependency-custody-evidence.js";
import { readHostedPrivateBytes } from "../../dist/worker-codex/hosted-readonly-inputs.js";
import { assertReadonlyHostOperator } from "../../dist/worker-codex/hosted-readonly-authority.js";
import { prepareCurrentColdHotRoots, assertRootScope, type CurrentColdHotRoots } from "./current-cold-hot-root.js";
import { assertConfiguredAccountName } from "./current-configured-auth-mount.js";
import { CurrentBackingGeometry, readCurrentBackingGeometry } from "./current-backing-geometry.js";
import { runCurrentFullEvictRestoreFlow, EvictRestorePhase } from "./current-full-evict-restore-flow.js";
import { runCurrentFullReadonlyContinuation } from "./current-full-r-continuation.js";
import { FullFlowPhase } from "./current-full-flow.js";
import { assertDistinctCurrentEntries } from "./current-full-entry.js";
import { HostedActivationPhase } from "../../dist/worker-core/index.js";
import { readHostedInstallationActivation } from "../../dist/worker-codex/hosted-installation-activation.js";
import { HostedReadonlyHostKernel, readHostedReadonlyHostInventory } from "../../dist/worker-codex/hosted-readonly-host-kernel.js";
import { createReadonlyPrivateRecord } from "../../dist/worker-codex/hosted-readonly-custody.js";
import { readHostedDependencyEvictionEnabled } from "../../dist/worker-codex/hosted-dependency-eviction-enabled-policy.js";
import { pinReferenceFile } from "../../dist/worker-codex/hosted-dependency-legacy-reference-records.js";
import { withHostedActivationFence } from "../../dist/provider-codex/app-server/adapters/hosted-process-activation.js";
import { observeRegistrationFailure } from "./registration-failure-observation.js";
import { json, runtime } from "./common.ts";
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
try {
  assert.equal(process.argv.length,3);assert.equal(process.argv[2],"qualify");assertReadonlyHostOperator();
  assert.equal(readCurrentBackingGeometry(),CurrentBackingGeometry.Adoptable);
  assert.match(process.env.TEST_SOURCE_SHA??"",/^[a-f0-9]{40}$/);
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
  const roots=await prepareCurrentColdHotRoots(evidence,input.accountName);
  evidence.freshCohort={candidateJobId:roots.candidateJobId,readonlyJobId:roots.readonlyJobId,workspace:roots.workspaceIdentity,
    sourceSha:roots.sourceSha,runtimeManifestSha256:roots.runtimeManifestSha256,independentInputReview:input.reviewReference};
  evidence.phase=FullGuestSetup.Policy;evidence.testEvictionPolicy=prepareCurrentTestEvictionPolicy(roots,inputPin.reference);
  const evictRestore=await runCurrentFullEvictRestoreFlow(roots,(phase:EvictRestorePhase)=>{evidence.phase={flow:"evict_restore",phase};});
  // Preserve observed C slice if later independent review/R continuation fails.
  evidence.evictRestore=evictRestore;
  const restored=evictRestore.entries.at(-1);assert(restored);
  const readonlyContinuation=await runCurrentFullReadonlyContinuation(roots,restored,Math.floor(fullDeadline-performance.now()),
    (phase:FullFlowPhase)=>{evidence.phase={flow:"readonly_continuation",phase};});
  const entries=[...evictRestore.entries,...readonlyContinuation.entries];
  assertDistinctCurrentEntries(entries.map(observation=>({observation})));
  evidence.flow=Object.freeze({evictRestore,readonlyContinuation,entries,cumulativeInstalls:2});
  evidence.status=FullGuestStatus.PartialPass;
} catch(error:unknown) {
  evidence.failure="TEST_actual_full_retention_slice_failed";evidence.failureObservation=observeRegistrationFailure(error);process.exitCode=1;
} finally {
  // Never serialize error/message, provider output, auth, HOME or arbitrary data.
  assert(Buffer.byteLength(JSON.stringify(evidence))<=256*1024);json(runtime+"/guest-evidence.json",evidence,0o644);
}
