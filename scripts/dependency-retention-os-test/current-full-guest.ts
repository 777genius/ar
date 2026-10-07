/** Separate real-provider cohort. Never dispatched by historical CLOSED route. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isDependencyCustodyObject } from "../../dist/core/dependency-environment/dependency-custody-evidence.js";
import { readHostedPrivateBytes } from "../../dist/worker-codex/hosted-readonly-inputs.js";
import { assertReadonlyHostOperator } from "../../dist/worker-codex/hosted-readonly-authority.js";
import { prepareCurrentColdHotRoots } from "./current-cold-hot-root.js";
import { assertConfiguredAccountName } from "./current-configured-auth-mount.js";
import { CurrentBackingGeometry, readCurrentBackingGeometry } from "./current-backing-geometry.js";
import { runCurrentFullFlow, FullFlowPhase } from "./current-full-flow.js";
import { observeRegistrationFailure } from "./registration-failure-observation.js";
import { json, runtime } from "./common.ts";
enum FullGuestStatus { Failed="failed", PartialPass="partial_pass" }
enum FullGuestSetup { Input="independent_input", Root="original_fresh_current_root" }
const evidence:Record<string,unknown>={schemaVersion:1,sourceSha:process.env.TEST_SOURCE_SHA,
  qualification:"native_actual_c_cold_hot_coldv2_r_entries_only",status:FullGuestStatus.Failed,results:[],
  fullPlanQualification:"pending",remaining:["committed_absent_cold_restore","dangerous_or_incompatible_mutations",
    "derived_next_cleanup","active_exclusion_and_contained_remover","uncertain_failure_preservation","full_30_scenario_partition"]};
try {
  assert.equal(process.argv.length,3);assert.equal(process.argv[2],"qualify");assertReadonlyHostOperator();
  assert.equal(readCurrentBackingGeometry(),CurrentBackingGeometry.Adoptable);
  assert.match(process.env.TEST_SOURCE_SHA??"",/^[a-f0-9]{40}$/);
  evidence.phase=FullGuestSetup.Input;
  const bytes=readHostedPrivateBytes("/run/TEST-full-flow-input/input.json",4096);assert(bytes);
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
  evidence.flow=await runCurrentFullFlow(roots,(phase:FullFlowPhase)=>{evidence.phase=phase;});
  evidence.status=FullGuestStatus.PartialPass;
} catch(error:unknown) {
  evidence.failure="TEST_actual_current_cold_hot_flow_failed";evidence.failureObservation=observeRegistrationFailure(error);process.exitCode=1;
} finally {
  // Never serialize error/message, provider output, auth, HOME or arbitrary data.
  assert(Buffer.byteLength(JSON.stringify(evidence))<=256*1024);json(runtime+"/guest-evidence.json",evidence,0o644);
}
