import { assertOriginalFullBackingPreparation, FullBackingInstallationContract } from "../../dist/worker-codex/hosted-full-backing-interval.js";
/** Owned TEST preparation. Inventory is configuration; ORIGINAL install grants custody. */
import assert from "node:assert/strict";
import { assertConfiguredAccountName } from "./current-configured-auth-mount.js";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { HostedActivationPhase } from "../../dist/worker-core/index.js";
import { HostedInstallationActivationStore, readHostedInstallationActivation } from "../../dist/worker-codex/hosted-installation-activation.js";
import { HostedReadonlyHostKernel, readHostedReadonlyHostInventory } from "../../dist/worker-codex/hosted-readonly-host-kernel.js";
import { assertReadonlyHostOperator, readReadonlyReview, readonlyIdentityName } from "../../dist/worker-codex/hosted-readonly-authority.js";
import { parseHostedReadonlyPolicy, readHostedPrivateBytes } from "../../dist/worker-codex/hosted-readonly-inputs.js";
import { hostedDependencyJobRoot, readHostedDependencyBinding } from "../../dist/provider-codex/app-server/adapters/hosted-dependency-workspace.js";
import { SYSTEM_BUS_CONTROL_GROUP } from "../../dist/core/host-infrastructure/system-bus-infrastructure.js";
import { isDependencyCustodyObject } from "../../dist/core/dependency-environment/dependency-custody-evidence.js";
import { issueActualSystemBusInfrastructure, issueNativeFdProfile, actualToolchainProfile } from "./native-registration-profile.js";
import { CurrentBackingGeometry, readCurrentBackingGeometry, observeInitialCurrentBacking } from "./current-backing-geometry.js";
import { prepareCurrentLocalInputs, registerCurrentTools, currentNativeRecipe } from "./current-tools-fixture.ts";
import { assertCurrentRealCodexInputs } from "./current-real-codex-input.ts";
import { command, directory, directoryIdentity, digest, fileDigest, installedArtifactDigest, json, node, policy, runtime } from "./common.ts";
export enum ColdHotPrerequisite { ConfiguredAuth = "configured_auth", IndependentPolicy = "independent_policy" }
export type CurrentColdHotRoots = Readonly<{ candidateJobId: string; readonlyJobId: string; jobRoot: string; workspace: string;
  accountName: string; workspaceIdentity: ReturnType<typeof directoryIdentity>; sourceSha: string; runtimeManifestSha256: string }>;
/** New OS only. No installed creator row is removed; legacy cohort remains separate. */
export function prepareCurrentColdHotRoots(evidence: Record<string, unknown>, accountName: string): Promise<CurrentColdHotRoots> {
  return prepareRoots(evidence, accountName);
}
/** Distinct actual FULL producer. Requiredness is fixed by this inspected
 * entrypoint and physical original parent, never by a JSON/env boolean. */
export function prepareCurrentFullColdHotRoots(evidence: Record<string, unknown>, accountName: string): Promise<CurrentColdHotRoots> {
  assertOriginalFullBackingPreparation();
  return prepareRoots(evidence, accountName, FullBackingInstallationContract.OriginalParentProcV1);
}
async function prepareRoots(evidence: Record<string, unknown>, accountName: string, full?: FullBackingInstallationContract): Promise<CurrentColdHotRoots> {
  assertReadonlyHostOperator(); assertConfiguredAccountName(accountName); assert.equal(readCurrentBackingGeometry(), CurrentBackingGeometry.Adoptable);
  const sourceSha = process.env.TEST_SOURCE_SHA; assert(sourceSha && /^[a-f0-9]{40}$/.test(sourceSha));
  const bus = await issueActualSystemBusInfrastructure(evidence);
  assert(!existsSync(policy)); directory(policy);
  for (const name of ["ordinary-origins", "ordinary-starts", "ordinary-completed", "codex-readonly-custody", "codex-readonly-revoked", "codex-readonly-inputs"])
    directory(policy + "/" + name);
  const candidateJobId = "TEST-os-" + randomUUID(), readonlyJobId = "TEST-os-" + randomUUID();
  const jobRoot = hostedDependencyJobRoot(candidateJobId), workspace = jobRoot + "/workspace";
  // The second empty directory is a geometry probe, NEVER an installed reference creator.
  const probeWorkspace = hostedDependencyJobRoot("TEST-geometry-" + randomUUID()) + "/workspace";
  for (const path of [jobRoot, workspace, probeWorkspace]) directory(path);
  evidence.initialBacking = observeInitialCurrentBacking(workspace, probeWorkspace);
  prepareCurrentLocalInputs(candidateJobId);
  writeFileSync(workspace + "/source-sentinel", "TEST fresh cold/hot source\n", { flag: "wx", mode: 0o600 });
  writeFileSync(workspace + "/.gitignore", "node_modules/\n", { flag: "wx", mode: 0o600 });
  // Data requested by this new signed task; no mock runtime, factory or completion.
  writeFileSync(jobRoot + "/prompt", "Inspect the disposable TEST project and report its state. Do not access credentials or external services.\n", { flag: "wx", mode: 0o600 });
  directory(jobRoot + "/state"); directory(jobRoot + "/state/registry");
  // Separate real toolchain input; the historical synthetic default is untouched.
  evidence.realCodexInput = assertCurrentRealCodexInputs(sourceSha);
  const runtimeManifestSha256 = installedArtifactDigest();
  const { collectorProfile, rootGit } = await issueNativeFdProfile(evidence, bus);
  command("/usr/bin/git", ["init", "--initial-branch=main", workspace]);
  command("/usr/bin/git", ["config", "user.name", "iliya"], 30000, workspace);
  command("/usr/bin/git", ["config", "user.email", "iliyazelenkog@gmail.com"], 30000, workspace);
  assert(command("/usr/bin/git", ["var", "GIT_AUTHOR_IDENT"], 30000, workspace).startsWith("iliya <iliyazelenkog@gmail.com> "));
  assert(command("/usr/bin/git", ["var", "GIT_COMMITTER_IDENT"], 30000, workspace).startsWith("iliya <iliyazelenkog@gmail.com> "));
  command("/usr/bin/git", ["add", "package.json", "package-lock.json", ".gitignore", "source-sentinel", "packages", "TEST-current-local.test.ts", "TEST-readonly-local-custody"], 30000, workspace);
  command("/usr/bin/git", ["commit", "-m", "test: initialize disposable cold hot fixture"], 30000, workspace);
  const supervisorUnit = "TEST-retention-supervisor.service", fragment = "/etc/systemd/test-units/" + supervisorUnit;
  const units = "/run/systemd/system", wants = units + "/TEST-retention.target.wants";
  directory(units, 0o755); assert(!existsSync(wants)); directory(wants, 0o755);
  const link = wants + "/" + supervisorUnit; symlinkSync(fragment, link);
  const stat = lstatSync(link); assert(stat.isSymbolicLink() && stat.uid === 0 && stat.gid === 0 && stat.nlink === 1);
  assert.equal(readlinkSync(link), fragment); assert.equal(realpathSync(link), fragment);
  const enabled = command("/usr/bin/systemctl", ["list-unit-files", "--type=service,socket,timer", "--state=enabled,enabled-runtime,linked,linked-runtime,alias", "--no-legend", "--no-pager"])
    .split("\n").filter(line => line.trim()).map(line => line.trim().split(/\s+/));
  assert.equal(enabled.length, 1); assert.equal(enabled[0]?.[0], supervisorUnit); assert.equal(enabled[0]?.[1], "enabled-runtime");
  const controlGroup = command("/usr/bin/systemctl", ["show", supervisorUnit, "--property=ControlGroup", "--value"]).trim();
  const args = [...currentNativeRecipe(candidateJobId)], accountAt = args.indexOf("--accounts");
  assert(accountAt >= 0 && args[accountAt + 1] === "TEST-account"); args[accountAt + 1] = accountName;
  assert.equal(args[args.indexOf("--service-tier") + 1], "default");
  const launch = { command: node, args, cwd: workspace };
  json(policy + "/readonly-inventory.json", { schemaVersion: 4, hostId: readFileSync("/etc/machine-id", "utf8").trim(),
    supervisorUnit, systemBusInfrastructure: bus, collectorProfile,
    units: [{ name: supervisorUnit, controlGroup, fragmentSha256: fileDigest(fragment) },
      { name: "dbus.service", controlGroup: SYSTEM_BUS_CONTROL_GROUP, fragmentSha256: bus.service.fragmentSha256 }],
    ordinaryCreators: [{ creatorId: candidateJobId, jobId: candidateJobId, jobRootDir: jobRoot, workspacePath: workspace, launch }],
    disabledCreators: [], runtimeLaunch: launch });
  const stages = "/run/user/0/subscription-runtime-host-policy/codex-readonly-stages"; directory(stages);
  if (full) assertOriginalFullBackingPreparation();
  json(stages + "/" + digest(runtime) + ".json", full
    ? { schemaVersion: 2, runtimeDirectory: runtime, runtimeSha: sourceSha, runtimeManifestSha256, backingInterval: full }
    : { schemaVersion: 1, runtimeDirectory: runtime, runtimeSha: sourceSha, runtimeManifestSha256 });
  json(policy + "/dependency-installer-profile.json", actualToolchainProfile(rootGit));
  const kernel = new HostedReadonlyHostKernel(); kernel.verifyExclusiveInventory();
  new HostedInstallationActivationStore().install();
  const installed = readHostedInstallationActivation(); assert.equal(installed.activation.phase, HostedActivationPhase.Closed);
  assert.equal(installed.activation.ordinaryStarts.length, 0); assert.equal(installed.installation.runtimeSha, sourceSha);
  assert.equal(readHostedReadonlyHostInventory().ordinaryCreators.length, 1);
  await registerCurrentTools(candidateJobId);
  const roots = Object.freeze({ candidateJobId, readonlyJobId, jobRoot, workspace, accountName, workspaceIdentity: directoryIdentity(workspace), sourceSha, runtimeManifestSha256 });
  // Factual review request only. No reviewReference, issuer digest, lease or Ready.
  json(jobRoot + "/TEST-cold-policy-review-request.json", { schemaVersion: 1, candidateJobId, readonlyJobId,
    jobRoot, workspace: roots.workspaceIdentity, runtimeSha: sourceSha, runtimeManifestSha256,
    readonlyPaths: ["packages/live", "packages/packed", "TEST-readonly-local-custody"].map(p => workspace + "/" + p),
    runtimeLaunch: readHostedReadonlyHostInventory().runtimeLaunch });
  return roots;
}
export function assertRootScope(roots: CurrentColdHotRoots): void {
  assert(/^TEST-os-[a-f0-9-]{36}$/.test(roots.candidateJobId) && /^TEST-os-[a-f0-9-]{36}$/.test(roots.readonlyJobId));
  assert.notEqual(roots.candidateJobId, roots.readonlyJobId);
  assert.equal(roots.jobRoot, hostedDependencyJobRoot(roots.candidateJobId)); assert.equal(roots.workspace, roots.jobRoot + "/workspace");
  assert.deepEqual(directoryIdentity(roots.workspace), roots.workspaceIdentity);
  const binding = readHostedDependencyBinding(roots.candidateJobId); assert(binding && binding.version === 2);
  assert.equal(binding.jobRootDir, roots.jobRoot); assert.deepEqual(binding.workspace, roots.workspaceIdentity);
  assertConfiguredAccountName(roots.accountName);
  const row = readHostedReadonlyHostInventory().ordinaryCreators.find(row => row.jobId === roots.candidateJobId); assert(row);
  assert.equal(row.launch.args[row.launch.args.indexOf("--accounts") + 1], roots.accountName);
}
/** Metadata only. Seed bytes are supplied by the authorized runtime, then read ONLY by
 * its actual FileBackendCodexSessionSeeder; this harness never copies or parses auth. */
export function assertCurrentConfiguredAuth(roots: CurrentColdHotRoots): void {
  assertReadonlyHostOperator(); assertRootScope(roots);
  for (const path of [roots.jobRoot + "/auth", roots.jobRoot + "/auth/" + roots.accountName]) {
    const s = lstatSync(path); assert(s.isDirectory() && !s.isSymbolicLink() && s.uid === 0 && s.gid === 0 && (s.mode & 0o7777) === 0o700);
  }
  const s = lstatSync(roots.jobRoot + "/auth/" + roots.accountName + "/auth.json");
  assert(s.isFile() && !s.isSymbolicLink() && s.uid === 0 && s.gid === 0 && s.nlink === 1 && (s.mode & 0o7777) === 0o600 && s.size > 0 && s.size <= 65536);
}
/** Separately attested ROOT review is an input. No source-generated REVIEW or lease. */
export function readCurrentIndependentColdPolicy(roots: CurrentColdHotRoots) {
  assertReadonlyHostOperator(); assertRootScope(roots);
  const name = readonlyIdentityName(roots.readonlyJobId), bytes = readHostedPrivateBytes("/run/user/0/subscription-runtime-host-policy/codex-readonly-reviewed/" + name, 65536);
  assert(bytes, "TEST independent exact cold policy review required");
  const v: unknown = JSON.parse(bytes.toString("utf8"));
  assert(isDependencyCustodyObject(v, "corepackShim,custodyReference,policy,reviewReference,schemaVersion") && v.schemaVersion === 1);
  assert(Buffer.from(JSON.stringify(v) + "\n").equals(bytes));
  const selected = parseHostedReadonlyPolicy(v.policy), binding = readHostedDependencyBinding(roots.candidateJobId);
  assert(binding && binding.version === 2); assert.equal(selected.jobId, roots.readonlyJobId);
  assert.equal(selected.jobRootDir, roots.jobRoot); assert.equal(selected.workspacePath, roots.workspace);
  assert.equal(selected.runtimeSha, roots.sourceSha); assert.equal(selected.runtimeManifestSha256, roots.runtimeManifestSha256);
  assert.deepEqual([...selected.readonlyPaths].sort(), ["packages/live", "packages/packed", "TEST-readonly-local-custody"].map(p => roots.workspace + "/" + p).sort());
  readReadonlyReview(selected); return selected;
}
