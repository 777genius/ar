import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sdkRecipe } from "./hosted-dependency-sdk-recipe.fixture";
import { HostedManifestLimitsRevision, issueFreshHostedManifestPlacement } from "../hosted-dependency-manifest-placement";
// Source admission regression: original protected planner and placement issuer
// run unchanged. Kernel census and immutable private byte reads are substituted.
// The retained-record gate deliberately stops before native mount/publication IO.
const state=vi.hoisted(()=>({snapshots:new Map<string,Buffer>(),inventory:{} as unknown,fence:Object.freeze({held:true})}));
// Both worker facades and the shared backing-stage adapter now read through
// this canonical physical-input leaf. Substitute bytes at that existing seam;
// keep the real stage decoder, planner and retained-record refusal unchanged.
vi.mock("../../provider-codex/app-server/adapters/hosted-private-physical-inputs",async original=>({...await original<typeof import("../../provider-codex/app-server/adapters/hosted-private-physical-inputs")>(),readHostedPrivateBytes:(path:string)=>state.snapshots.get(path)}));
// Source modules resolve a src CLI; the production modules resolve dist. Only
// that installation path is substituted, preserving the actual planner/builder.
vi.mock("../application/codex-goal-launch-input",async original=>{
 const actual=await original<typeof import("../application/codex-goal-launch-input")>();
 return {...actual,goalLaunchInputFromRecord:(...args:Parameters<typeof actual.goalLaunchInputFromRecord>)=>{
  const launch=actual.goalLaunchInputFromRecord(...args);return {...launch,cliCommand:[launch.cliCommand[0]!,runtime+"/dist/worker-codex/codex-goal-cli.js"]};}};
});
vi.mock("../hosted-readonly-host-kernel",()=>({readHostedReadonlyHostInventory:()=>state.inventory,
  HostedReadonlyHostKernel:class {operatorSession(){return {hostId:"a".repeat(32),bootId:"11111111-1111-1111-1111-111111111111",supervisorId:"100:200"};}
    verifyExclusiveInventory(){} verifyDescriptorBoundary(){}}}));
vi.mock("../../provider-codex/app-server/adapters/hosted-process-activation",()=>({
  assertHostedActivationFence:(value:unknown)=>{if(value!==state.fence)throw new Error("TEST unheld fence");},assertHostedActivationOperator(){}}));
const root="/var/lib/subscription-runtime-host-policy",job=root+"/dependency-test-jobs/jobs/TEST-parent";
const runtime=fileURLToPath(new URL("../../../",import.meta.url)).replace(/\/$/,"");
const hash=(bytes:Buffer)=>createHash("sha256").update(bytes).digest("hex"),encode=(value:unknown)=>Buffer.from(JSON.stringify(value)+"\n");
function candidate(launch:ReturnType<typeof sdkRecipe>){
 state.inventory={schemaVersion:5,hostId:"a".repeat(32),ordinaryCreators:[{creatorId:"original",jobId:"TEST-parent",jobRootDir:job,
   workspacePath:job+"/workspace",launch}],runtimeLaunch:launch};
 const bytes=encode(state.inventory);state.snapshots.set(root+"/readonly-inventory.json",bytes);
 return {schemaVersion:1 as const,installationId:"22222222-2222-2222-2222-222222222222",hostId:"a".repeat(32),runtimeDirectory:runtime,
   runtimeSha:"b".repeat(40),runtimeManifestSha256:"c".repeat(64),inventorySha256:hash(bytes)};
}
function prepare(launch:ReturnType<typeof sdkRecipe>){
 const selected=candidate(launch);
 state.snapshots.set(root+"/dependency-manifest-storage-policy.json",encode({version:1,scratchRoot:{canonicalPath:"/mnt/TEST-sdk-scratch",dev:"1",ino:"2",mountId:"3"},
   bootId:"11111111-1111-1111-1111-111111111111",limitsRevision:HostedManifestLimitsRevision.TestUnqualifiedV1}));
 state.snapshots.set("/run/user/0/subscription-runtime-host-policy/codex-readonly-stages/"+hash(Buffer.from(runtime))+".json",
   encode({schemaVersion:1,runtimeDirectory:runtime,runtimeSha:selected.runtimeSha,runtimeManifestSha256:selected.runtimeManifestSha256}));
 state.snapshots.set(root+"/host-installation.json",Buffer.from("retained TEST evidence"));return selected;
}
beforeEach(()=>state.snapshots.clear());
describe("original SDK creator at manifest placement publication",()=>{
 it("authenticates the bound SDK recipe before retaining the original physical-state veto, without rewriting inventory",()=>{
  const launch=sdkRecipe(state.snapshots,job);launch.args[0]=runtime+"/dist/worker-codex/codex-goal-cli.js";
  const before=JSON.stringify(launch),selected=prepare(launch);
  expect(()=>issueFreshHostedManifestPlacement(state.fence,selected)).toThrow("dependency_manifest_placement:retained");
  expect(JSON.stringify(launch)).toBe(before);expect(hash(state.snapshots.get(root+"/readonly-inventory.json")!)).toBe(selected.inventorySha256);
 });
 it("rejects changed protected SDK manifests before the retained-state gate",()=>{
  const launch=sdkRecipe(state.snapshots,job);launch.args[0]=runtime+"/dist/worker-codex/codex-goal-cli.js";const selected=prepare(launch);
  const path=job+"/state/registry/TEST-parent/job.json",manifest=JSON.parse(state.snapshots.get(path)!.toString()) as Record<string,unknown>;
  state.snapshots.set(path,Buffer.from(JSON.stringify({...manifest,model:"changed-model"})));
  expect(()=>issueFreshHostedManifestPlacement(state.fence,selected)).toThrow("hosted_stored_project_start_binding_invalid");
 });
 it("rejects a foreign SDK command before the retained-state gate",()=>{
  const launch=sdkRecipe(state.snapshots,job);launch.args[0]=runtime+"/dist/worker-codex/codex-goal-cli.js";launch.args[2]="foreign_start";
  const selected=prepare(launch);expect(()=>issueFreshHostedManifestPlacement(state.fence,selected)).toThrow("hosted_original_usable_parent_recipe_unsupported");
 });
 it("keeps the original direct run placement behavior",()=>{
  const selected=prepare({command:process.execPath,args:[runtime+"/dist/worker-codex/codex-goal-cli.js","run"],cwd:job+"/workspace"});
  expect(()=>issueFreshHostedManifestPlacement(state.fence,selected)).toThrow("dependency_manifest_placement:retained");
 });
});
