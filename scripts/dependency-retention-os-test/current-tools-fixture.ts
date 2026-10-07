/** Owned TEST source preparation and genuine registration only. Planned recipe
 * data never grants factory/home/use, model availability or R association. */
import assert from "node:assert/strict";
import { lstatSync, writeFileSync } from "node:fs";
import { CodexProviderEgressProfileId } from "../../dist/provider-codex/index.js";
import { dependencyToolPins, DependencyToolTransformCache, parseDependencyToolRegistration }
  from "../../dist/core/dependency-environment/dependency-tool-profile.js";
import { assertHostedDependencyParentRecipe } from "../../dist/provider-codex/app-server/adapters/hosted-dependency-parent-recipe.js";
import { assertHostedDependencyPhysicalWorkspace, hostedDependencyJobRoot, readHostedDependencyBinding }
  from "../../dist/provider-codex/app-server/adapters/hosted-dependency-workspace.js";
import { writeHostedTestEgressGrant } from "../../dist/worker-codex/hosted-test-egress-files.js";
import { withHostedActivationFence } from "../../dist/provider-codex/app-server/adapters/hosted-process-activation.js";
import { HostedDependencyReferenceKind } from "../../dist/provider-codex/app-server/adapters/hosted-dependency-workspace.js";
import { HostedInstallationActivationStore } from "../../dist/worker-codex/hosted-installation-activation.js";
import { readHostedDependencyEstablishedReceipt } from "../../dist/worker-codex/hosted-dependency-receipts.js";
import { assertHostedDependencyLegacyComparedReady } from "../../dist/worker-codex/hosted-dependency-legacy-comparison-record.js";
import { DependencyInstallProofKind, DependencyReceiptState } from "../../dist/worker-core/index.js";
import { prepareHostedReadonlyDependencyAdoption, completeHostedReadonlyDependencyAdoption }
  from "../../dist/worker-codex/hosted-readonly-dependency-adoption.js";
import { parseHostedReadonlyPolicy, readHostedPrivateBytes } from "../../dist/worker-codex/hosted-readonly-inputs.js";
import { HostedReadonlySupervisorHost } from "../../dist/worker-codex/hosted-readonly-supervisor-host.js";
import { readHostedReadonlyDependencyMaterial } from "../../dist/worker-codex/hosted-readonly-dependency-records.js";
import { readDefaultTestRequestedModel } from "./default-codex-config.ts";
import { command, directory, fileDigest, json, node, runtime } from "./common.ts";
const testFile = "TEST-current-local.test.ts";
function ownWorkspace(jobId: string): string {
  assert.equal(process.platform,"linux"); assert.equal(process.getuid!(),0); assert.equal(process.geteuid!(),0);
  assert(typeof jobId === "string" && /^TEST-os-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.exec(jobId)?.[0] === jobId);
  const root = hostedDependencyJobRoot(jobId), workspace = root + "/workspace";
  for (const path of [root,workspace]) {
    const stat = lstatSync(path); assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid===0 && stat.gid===0 && !(stat.mode & 0o077));
  }
  return workspace;
}
/** Initial fixture input writer only; no node_modules, receipt or binding is
 * authored. Actual lock selection uses the SAME fixed installed npm CLI. */
export function prepareCurrentLocalInputs(jobId: string): void {
  const workspace = ownWorkspace(jobId), npm = runtime + "/toolchain/lib/node_modules/npm/bin/npm-cli.js";
  const cache = hostedDependencyJobRoot(jobId) + "/TEST-npm-input-cache"; directory(cache);
  const userConfig = hostedDependencyJobRoot(jobId) + "/TEST-npm-user.rc", globalConfig = hostedDependencyJobRoot(jobId) + "/TEST-npm-global.rc";
  for (const path of [userConfig,globalConfig]) writeFileSync(path,"",{flag:"wx",mode:0o600});
  const fixedConfig = ["--userconfig=" + userConfig,"--globalconfig=" + globalConfig,"--cache=" + cache];
  try { assert.equal(command(node,[npm,"--version",...fixedConfig]).trim(),"10.9.9"); }
  catch { throw new Error("TEST_current_input_npm_version_failed"); }
  for (const path of ["packages/live","packages/pack-input","packages/packed","TEST-readonly-local-custody"])
    directory(workspace + "/" + path,0o755);
  json(workspace + "/packages/live/package.json",{name:"test-native-live",version:"1.0.0",type:"module",exports:"./index.ts"},0o644);
  writeFileSync(workspace + "/packages/live/index.ts","export const liveValue = 6;\n",{flag:"wx",mode:0o644});
  json(workspace + "/packages/pack-input/package.json",{name:"test-native-packed",version:"1.0.0",type:"module",exports:"./index.ts",files:["index.ts"]},0o644);
  writeFileSync(workspace + "/packages/pack-input/index.ts","export const packedValue = 7;\n",{flag:"wx",mode:0o644});
  try { command(node,[npm,"pack","--ignore-scripts","--json",...fixedConfig,"--pack-destination",workspace + "/packages/packed"],30000,workspace + "/packages/pack-input"); }
  catch { throw new Error("TEST_current_input_pack_failed"); }
  const packed = workspace + "/packages/packed/test-native-packed-1.0.0.tgz", stat = lstatSync(packed);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.uid===0 && stat.nlink===1 && stat.size>0 && stat.size<=65536);
  json(workspace + "/package.json",{name:"test-current-native-local",version:"1.0.0",private:true,dependencies:{
    "is-number":"7.0.0",vite:dependencyToolPins.vite,vitest:dependencyToolPins.vitest,
    "test-native-live":"file:packages/live","test-native-packed":"file:packages/packed/test-native-packed-1.0.0.tgz"}},0o644);
  try { command(node,[npm,"install","--package-lock-only","--ignore-scripts","--no-audit","--no-fund",...fixedConfig,
    "--install-strategy=hoisted","--install-links=true","--include=dev","--include=optional","--include=peer",
    "--strict-peer-deps=false","--legacy-peer-deps=false","--workspaces=false"],120000,workspace); }
  catch { throw new Error("TEST_current_input_lock_selection_failed"); }
  assert.throws(() => lstatSync(workspace + "/node_modules"),(error:unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
  const lock = lstatSync(workspace + "/package-lock.json");
  assert(lock.isFile() && !lock.isSymbolicLink() && lock.uid===0 && lock.nlink===1 && lock.size>0 && lock.size<=8*1024*1024);
  writeFileSync(workspace + "/" + testFile,
    "import { expect, test } from 'vitest';\nimport { liveValue } from 'test-native-live';\nimport { packedValue } from 'test-native-packed';\ntest('real live and packed inputs', () => { expect(liveValue).toBe(6); expect(packedValue).toBe(7); });\n",{flag:"wx",mode:0o644});
  writeFileSync(workspace + "/TEST-readonly-local-custody/input.txt","TEST actual same-workspace readonly local input\n",{flag:"wx",mode:0o644});
}
/** The ORIGINAL grant-tools writer authenticates the actual fresh CLOSED
 * installation, physical workspace, profile files and private backing. */
export async function registerCurrentTools(jobId: string) {
  const workspace = ownWorkspace(jobId), root = hostedDependencyJobRoot(jobId);
  assert.equal(readHostedDependencyBinding(jobId),null);
  const registration = parseDependencyToolRegistration({testFiles:[testFile],optimizerDependencies:["test-native-live"],
    transformCache:DependencyToolTransformCache.Persisted});
  await writeHostedTestEgressGrant({schemaVersion:1,jobId,jobRootDir:root,workspacePath:workspace,
    profileId:CodexProviderEgressProfileId.TestNpmQualification},registration);
  const binding = readHostedDependencyBinding(jobId); assert(binding && binding.version===2);
  assertHostedDependencyPhysicalWorkspace(binding);
  assert.equal(binding.workspace.canonicalPath,workspace);
  assert.deepEqual(binding.toolProfile.testFiles,registration.testFiles);
  assert.deepEqual(binding.toolProfile.optimizerDependencies,registration.optimizerDependencies);
  assert.equal(binding.toolProfile.transformCache,registration.transformCache);
  return {version:binding.version,workspace:binding.workspace,profileId:binding.toolProfile.profileId,
    packageSha256:fileDigest(workspace + "/package.json"),lockSha256:fileDigest(workspace + "/package-lock.json"),
    packedSha256:fileDigest(workspace + "/packages/packed/test-native-packed-1.0.0.tgz"),modelOrAccountProof:"none"} as const;
}
/** Closed planned CLI recipe only. The actual inventory/original producer
 * independently validates this tuple and current account/factory/use. */
export function currentNativeRecipe(jobId: string): readonly string[] {
  const workspace = ownWorkspace(jobId), root = hostedDependencyJobRoot(jobId), model = readDefaultTestRequestedModel();
  const args = [runtime + "/dist/worker-codex/codex-goal-cli.js","run","--task-id",jobId,"--job-id",jobId,
    "--job-root",root,"--workspace",workspace,"--prompt",root + "/prompt","--accounts","TEST-account","--auth-root",root + "/auth",
    "--codex-binary","codex","--model",model,"--effort","low","--service-tier","default","--execution-engine","app-server-goal",
    "--model-backend","openai-chatgpt","--state-root",root + "/state","--timeout","5m","--max-goal-turns","1","--max-attempts","1",
    "--continuation-mode","disabled","--registry-root",root + "/state/registry","--output",root + "/state/TEST-result.json","--worker-report-mode","structured-output"];
  assertHostedDependencyParentRecipe(args,root,workspace); return Object.freeze(args);
}

/** Only an EXISTING original v3 local-reference binding can select comparison.
 * This harness has no reference binding writer/issuer. Absence refuses before
 * maintenance effects; the real producer captures baselines and launches its
 * sealed reference CLI itself, never through a TEST submit callback. */
export async function compareCurrentRegisteredLocalReference(candidateJobId: string, referenceJobId: string) {
  const workspace = ownWorkspace(candidateJobId); ownWorkspace(referenceJobId);
  assert.notEqual(candidateJobId,referenceJobId);
  const selected = withHostedActivationFence(() => {
    const candidate = readHostedDependencyBinding(candidateJobId), reference = readHostedDependencyBinding(referenceJobId);
    assert(candidate && candidate.version===2);
    assert(reference && reference.version===3,"TEST original v3 local reference enrollment issuer required");
    assert.equal(reference.reference.kind,HostedDependencyReferenceKind.LegacyLocalNoLifecycleV1);
    assertHostedDependencyPhysicalWorkspace(candidate); assertHostedDependencyPhysicalWorkspace(reference);
    const prior = readHostedDependencyEstablishedReceipt(candidate);
    if (prior?.state===DependencyReceiptState.Ready) {
      assert.equal(prior.provenance.kind,DependencyInstallProofKind.LegacyCompared,
        "TEST completed local cold Ready is not a legacy-comparison precursor");
    }
    return {expectedRevision:prior?.revision ?? null};
  });
  const result = await new HostedInstallationActivationStore().compareLegacyDependency({candidateJobId,referenceJobId,
    expectedRevision:selected.expectedRevision});
  // A returned status, including AlreadyReady, never stands in for this original
  // protected local comparison proof. Actual v2 LegacyCompared is required.
  const actual = comparedCandidate(candidateJobId);
  assert.equal(actual.binding.workspace.canonicalPath,workspace);
  return {outcome:result.outcome,readyRevision:actual.ready.revision,comparisonVersion:actual.comparison.version} as const;
}
function comparedCandidate(candidateJobId: string) {
  ownWorkspace(candidateJobId);
  return withHostedActivationFence(() => {
    const binding = readHostedDependencyBinding(candidateJobId); assert(binding && binding.version===2);
    assertHostedDependencyPhysicalWorkspace(binding);
    const ready = readHostedDependencyEstablishedReceipt(binding);
    assert(ready && ready.state===DependencyReceiptState.Ready && ready.provenance.kind===DependencyInstallProofKind.LegacyCompared);
    const comparison = assertHostedDependencyLegacyComparedReady({...ready,provenance:ready.provenance});
    assert.equal(comparison.version,2); return {binding,ready,comparison};
  });
}
/** Closed SAME-C-root policy data consumed from the owned issuer's existing
 * protected file. This parser/config is not the review, association or permit;
 * the original producer independently verifies the real immutable review. */
export function prepareCurrentReadonlyFromProtectedInputs(candidateJobId: string) {
  const actual = comparedCandidate(candidateJobId), path = actual.binding.jobRootDir + "/TEST-current-readonly-policy.json";
  const bytes = readHostedPrivateBytes(path,16384);
  assert(bytes,"TEST independently reviewed same-C-root R policy required");
  const policy = parseHostedReadonlyPolicy(JSON.parse(bytes.toString("utf8")));
  assert.equal(policy.jobRootDir,actual.binding.jobRootDir);
  assert.equal(policy.workspacePath,actual.binding.workspace.canonicalPath);
  assert.equal(policy.runtimeSha,actual.binding.runtimeSha);
  assert(/^TEST-current-readonly-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.exec(policy.jobId)?.[0] === policy.jobId);
  assert.notEqual(policy.jobId,candidateJobId);
  assert.deepEqual([...policy.readonlyPaths].sort(),["packages/live","packages/packed","TEST-readonly-local-custody"]
    .map(name=>actual.binding.workspace.canonicalPath + "/" + name).sort());
  return prepareHostedReadonlyDependencyAdoption(policy);
}
/** After ORIGINAL real enroll/admit obtained CLOSED epoch/lease. No test writes
 * epoch, maintenance, association, Ready or completion and no R identity DTO is
 * accepted. The actual protected material readback joins the same C workspace. */
export function completeCurrentReadonlyFromProtectedInputs(candidateJobId: string) {
  const before = comparedCandidate(candidateJobId);
  completeHostedReadonlyDependencyAdoption(candidateJobId);
  return withHostedActivationFence(fence => {
    const epoch = new HostedReadonlySupervisorHost().readEpoch();
    const material = readHostedReadonlyDependencyMaterial(fence,epoch.identity).evidence;
    assert.equal(material.candidate.jobId,candidateJobId);
    assert.equal(material.readonlyCustody.jobRootDir,before.binding.jobRootDir);
    assert.equal(material.readonlyCustody.workspacePath,before.binding.workspace.canonicalPath);
    assert.notEqual(material.readonlyCustody.jobId,candidateJobId);
    return {candidateJobId,readonlyJobId:material.readonlyCustody.jobId,workspace:before.binding.workspace,
      comparisonSha256:material.candidate.comparison.sha256,sourceMappingSha256:material.candidate.sourceMapping.sha256} as const;
  });
}
