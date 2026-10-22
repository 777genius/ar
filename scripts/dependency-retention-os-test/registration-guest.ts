import { observeAdministrativeImageFdTestProgress, observeAdministrativeForgedRpcReason, observeAdministrativeForgedCommandResult, observeAdministrativeInstallationTestPhase, runAdministrativeInstallationRegression } from "./administrative-installation-native-TEST.js";
/** One owned OS, one ORIGINAL CLOSED C/reference registration. No consumer,
 * baseline install, comparison, R adoption, account or provider is invoked. */
import assert from "node:assert/strict";
import { CurrentBackingGeometry, CurrentGeometryQualification, readCurrentBackingGeometry, observeInitialCurrentBacking } from "./current-backing-geometry.js";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { HostedActivationPhase } from "../../dist/worker-core/index.js";
import { HostedInstallationActivationStore, readHostedInstallationActivation } from "../../dist/worker-codex/hosted-installation-activation.js";
import { HostedReadonlyHostKernel } from "../../dist/worker-codex/hosted-readonly-host-kernel.js";
import { assertReadonlyHostOperator } from "../../dist/worker-codex/hosted-readonly-authority.js";
import { readHostedDependencyBinding, hostedDependencyJobRoot } from "../../dist/provider-codex/app-server/adapters/hosted-dependency-workspace.js";
import { hostedDependencyReceiptHistoryRoot } from "../../dist/worker-codex/hosted-dependency-receipts.js";
import { readHostedDependencyInstallerProfile } from "../../dist/worker-codex/hosted-dependency-installer-recipe.js";
import { SYSTEM_BUS_CONTROL_GROUP } from "../../dist/core/host-infrastructure/system-bus-infrastructure.js";
import { issueActualSystemBusInfrastructure, issueNativeFdProfile, actualToolchainProfile } from "./native-registration-profile.js";
import { enrollReferenceAndAssert, ReferenceEnrollmentPublication } from "./reference-enrollment-assertions.js";
import { prepareCurrentLocalInputs, registerCurrentTools, currentNativeRecipe } from "./current-tools-fixture.ts";
import { publishDefaultTestCodexConfig } from "./default-codex-config.ts";
import { sealAdministrativeRpcDiagnostic, observeRegistrationFailure, RegistrationInputStep } from "./registration-failure-observation.js";
import { command, digest, directory, directoryIdentity, fileDigest, installedArtifactDigest, json, node, OwnedOsScenario, policy, runtime } from "./common.ts";

enum RegistrationStatus { Failed = "failed", PartialPass = "partial_pass" }
enum RegistrationPhase { Bus = "actual_system_bus", Inputs = "initial_test_inputs", Profile = "actual_native_profiles", Git = "signed_root_git", Install = "original_closed_installation", Candidate = "original_current_candidate", Reference = "original_local_reference", Readback = "protected_readback" }
const geometry = readCurrentBackingGeometry();
const evidence: Record<string, unknown> = { schemaVersion: 1, sourceSha: process.env.TEST_SOURCE_SHA,
  qualification: geometry === CurrentBackingGeometry.Adoptable ? CurrentGeometryQualification.ClosedOnly : "native_current_reference_closed_registration_only", status: RegistrationStatus.Failed,
  machineId: readFileSync("/etc/machine-id", "utf8").trim(), results: [],
  unsupported: ["legacy_local_comparison", "same_C_readonly_adoption", "ordinary_provider_factory_FDA_use",
    "live_account_model_availability", "hot_install_count_one", "committed_absent_cold_restore",
    "uncertain_creator_successor_drain", "full_N3_N5_qualification"] };

let inputStep = RegistrationInputStep.None;
try { await register(); evidence.status = RegistrationStatus.PartialPass; }
catch (error: unknown) {
  evidence.failure = "TEST_original_closed_registration_failed";
  evidence.failureObservation = { inputStep, ...observeRegistrationFailure(error) };
  const forgedCommand = observeAdministrativeForgedCommandResult();
  const imageFd = observeAdministrativeImageFdTestProgress();
  evidence.administrativeTestFailureObservation = { phase: observeAdministrativeInstallationTestPhase(),
    ...(imageFd === undefined ? {} : { imageFd }),
    ...(forgedCommand === undefined ? {} : { forgedCommand }) };
  // Exact failed first-call scope only. No reason wording enters finite evidence.
  if (observeAdministrativeInstallationTestPhase() === "forged_application_launch") {
    try {
      const reason = observeAdministrativeForgedRpcReason();
      assert(reason && typeof evidence.sourceSha === "string" && typeof evidence.machineId === "string");
      assert.match(evidence.sourceSha, /^[a-f0-9]{40}$/); assert.match(evidence.machineId, /^[a-f0-9]{32}$/);
      json(runtime + "/TEST-fixed-forged-rpc-diagnostic.json",
        sealAdministrativeRpcDiagnostic(reason, evidence.sourceSha, evidence.machineId), 0o600);
    } catch { evidence.privateRpcDiagnosticUnavailable = true; }
  }
  process.exitCode = 1;
}
finally {
  assert(Buffer.byteLength(JSON.stringify(evidence)) <= 256 * 1024);
  json(runtime + "/guest-evidence.json", evidence, 0o644);
}

async function register(): Promise<void> {
  assert.equal(process.argv[2], "qualify"); assertReadonlyHostOperator();
  assert.equal(process.env.TEST_OS_SCENARIO, OwnedOsScenario.CurrentDependency);
  assert.match(process.env.TEST_SOURCE_SHA ?? "", /^[a-f0-9]{40}$/);
  assert.equal(process.getuid!(), 0); assert.equal(process.geteuid!(), 0);
  evidence.administrativeInstallation = await runAdministrativeInstallationRegression();
  evidence.phase = RegistrationPhase.Bus;
  const bus = await issueActualSystemBusInfrastructure(evidence);
  assert(!existsSync(policy)); directory(policy);
  for (const name of ["ordinary-origins", "ordinary-starts", "ordinary-completed", "scoped-terminating", "codex-readonly-custody", "codex-readonly-revoked", "codex-readonly-inputs"])
    directory(policy + "/" + name);
  const namespaces = { user: readlinkSync("/proc/self/ns/user"), mnt: readlinkSync("/proc/self/ns/mnt"), pid: readlinkSync("/proc/self/ns/pid") };
  evidence.namespaces = { ...namespaces, cgroup: readlinkSync("/proc/self/ns/cgroup") };
  evidence.uidMap = readFileSync("/proc/self/uid_map", "utf8").trim();
  evidence.bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  assert(!readFileSync("/etc/passwd", "utf8").split("\n").some(line => line.split(":")[2] === "65532"));
  assert(!readFileSync("/etc/group", "utf8").split("\n").some(line => line.split(":")[2] === "65532"));
  const controllers = readFileSync("/sys/fs/cgroup/cgroup.controllers", "utf8");
  for (const controller of ["cpu", "memory", "pids"]) assert(new RegExp(`\\b${controller}\\b`).test(controllers));
  evidence.installerNssIdentityAbsent = true;
  const candidateJobId = "TEST-os-" + randomUUID(), referenceJobId = "TEST-os-" + randomUUID();
  const candidateRoot = hostedDependencyJobRoot(candidateJobId), referenceRoot = hostedDependencyJobRoot(referenceJobId);
  const candidateWorkspace = candidateRoot + "/workspace", referenceWorkspace = referenceRoot + "/workspace";
  for (const path of [candidateRoot, candidateWorkspace, referenceRoot, referenceWorkspace]) directory(path);
  if (geometry === CurrentBackingGeometry.Adoptable)
    evidence.initialBacking = observeInitialCurrentBacking(candidateWorkspace, referenceWorkspace);
  assert.notEqual(candidateWorkspace, referenceWorkspace);
  assert.notDeepEqual(directoryIdentity(candidateWorkspace), directoryIdentity(referenceWorkspace));
  evidence.phase = RegistrationPhase.Inputs;
  inputStep = RegistrationInputStep.Prepare;
  prepareCurrentLocalInputs(candidateJobId, (observation, frame, publicFrame) => { evidence.lockSelectionObservation = observation; evidence.lockFrameObservation = frame; evidence.lockPublicFrameObservation = publicFrame; });
  inputStep = RegistrationInputStep.Sentinel;
  writeFileSync(candidateWorkspace + "/source-sentinel", "TEST initial owned C source\n", { flag: "wx", mode: 0o600 });
  inputStep = RegistrationInputStep.GitIgnore;
  writeFileSync(candidateWorkspace + "/.gitignore", "node_modules/\n", { flag: "wx", mode: 0o600 });
  inputStep = RegistrationInputStep.Config;
  evidence.defaultCommandFixture = publishDefaultTestCodexConfig({ workspace: candidateWorkspace, guestNamespaces: namespaces });
  inputStep = RegistrationInputStep.Digest;
  evidence.runtimeManifestSha256 = installedArtifactDigest();
  inputStep = RegistrationInputStep.RuntimePins;
  const runtimePackage = lstatSync(runtime + "/package.json");
  assert(runtimePackage.isFile() && !runtimePackage.isSymbolicLink() && runtimePackage.uid === 0 && runtimePackage.gid === 0 && runtimePackage.nlink === 1 && !(runtimePackage.mode & 0o022));
  evidence.installedRuntimeRootPackage = { sha256: fileDigest(runtime + "/package.json"), bytes: runtimePackage.size };
  evidence.runtimeDirectory = directoryIdentity(runtime);
  inputStep = RegistrationInputStep.None;
  evidence.phase = RegistrationPhase.Profile;
  const { collectorProfile, rootGit } = await issueNativeFdProfile(evidence, bus);
  // The actual signed Git executable/ELF/descriptor profile precedes FIRST Git.
  evidence.phase = RegistrationPhase.Git;
  for (const workspace of [candidateWorkspace, referenceWorkspace]) {
    command("/usr/bin/git", ["init", "--initial-branch=main", workspace]);
    command("/usr/bin/git", ["config", "user.name", "iliya"], 30000, workspace);
    command("/usr/bin/git", ["config", "user.email", "iliyazelenkog@gmail.com"], 30000, workspace);
    assert(command("/usr/bin/git", ["var", "GIT_AUTHOR_IDENT"], 30000, workspace).startsWith("iliya <iliyazelenkog@gmail.com> "));
    assert(command("/usr/bin/git", ["var", "GIT_COMMITTER_IDENT"], 30000, workspace).startsWith("iliya <iliyazelenkog@gmail.com> "));
    if (workspace === candidateWorkspace) {
      command("/usr/bin/git", ["add", "package.json", "package-lock.json", ".gitignore", "source-sentinel", "packages", "TEST-current-local.test.ts", "TEST-readonly-local-custody"], 30000, workspace);
      command("/usr/bin/git", ["commit", "-m", "test: initialize disposable current registration fixture"], 30000, workspace);
    } else command("/usr/bin/git", ["commit", "--allow-empty", "-m", "test: initialize disposable reference fixture"], 30000, workspace);
  }
  assert.deepEqual(readdirSync(referenceWorkspace), [".git"]);
  const sentinels = [candidateWorkspace + "/package.json", candidateWorkspace + "/package-lock.json", candidateWorkspace + "/packages/live/index.ts",
    candidateWorkspace + "/source-sentinel", candidateWorkspace + "/.git/config", referenceWorkspace + "/.git/config"];
  const before = sentinels.map(path => ({ path, sha256: fileDigest(path), dev: String(lstatSync(path).dev), ino: String(lstatSync(path).ino) }));
  const supervisorUnit = "TEST-retention-supervisor.service", fragment = "/etc/systemd/test-units/" + supervisorUnit;
  const runtimeUnits = "/run/systemd/system", wants = runtimeUnits + "/TEST-retention.target.wants";
  directory(runtimeUnits, 0o755); assert(!existsSync(wants)); directory(wants, 0o755);
  const link = wants + "/" + supervisorUnit; symlinkSync(fragment, link);
  const linkStat = lstatSync(link); assert(linkStat.isSymbolicLink() && linkStat.uid === 0 && linkStat.gid === 0 && linkStat.nlink === 1);
  assert.equal(readlinkSync(link), fragment); assert.equal(realpathSync(link), fragment);
  const enabled = command("/usr/bin/systemctl", ["list-unit-files", "--type=service,socket,timer", "--state=enabled,enabled-runtime,linked,linked-runtime,alias", "--no-legend", "--no-pager"])
    .split("\n").filter(line => line.trim()).map(line => line.trim().split(/\s+/));
  assert.equal(enabled.length, 1); assert.equal(enabled[0]?.[0], supervisorUnit); assert.equal(enabled[0]?.[1], "enabled-runtime");
  const controlGroup = command("/usr/bin/systemctl", ["show", supervisorUnit, "--property=ControlGroup", "--value"]).trim();
  const candidateLaunch = { command: node, args: currentNativeRecipe(candidateJobId), cwd: candidateWorkspace };
  const referenceLaunch = { command: node, args: currentNativeRecipe(referenceJobId), cwd: referenceWorkspace };
  json(policy + "/readonly-inventory.json", { schemaVersion: 4, hostId: evidence.machineId, supervisorUnit, systemBusInfrastructure: bus, collectorProfile,
    units: [{ name: supervisorUnit, controlGroup, fragmentSha256: fileDigest(fragment) },
      { name: "dbus.service", controlGroup: SYSTEM_BUS_CONTROL_GROUP, fragmentSha256: bus.service.fragmentSha256 }],
    ordinaryCreators: [{ creatorId: candidateJobId, jobId: candidateJobId, jobRootDir: candidateRoot, workspacePath: candidateWorkspace, launch: candidateLaunch },
      { creatorId: referenceJobId, jobId: referenceJobId, jobRootDir: referenceRoot, workspacePath: referenceWorkspace, launch: referenceLaunch }],
    disabledCreators: [], runtimeLaunch: candidateLaunch });
  const stages = "/run/user/0/subscription-runtime-host-policy/codex-readonly-stages"; directory(stages);
  json(stages + "/" + digest(runtime) + ".json", { schemaVersion: 1, runtimeDirectory: runtime, runtimeSha: process.env.TEST_SOURCE_SHA,
    runtimeManifestSha256: evidence.runtimeManifestSha256 });
  const installerProfile = actualToolchainProfile(rootGit);
  json(policy + "/dependency-installer-profile.json", installerProfile);
  assert.deepEqual(readHostedDependencyInstallerProfile(), installerProfile);
  evidence.phase = RegistrationPhase.Install;
  const kernel = new HostedReadonlyHostKernel(); kernel.verifyExclusiveInventory();
  const store = new HostedInstallationActivationStore(); store.install();
  const installed = readHostedInstallationActivation();
  assert.equal(installed.activation.phase, HostedActivationPhase.Closed); assert.equal(installed.activation.ordinaryStarts.length, 0);
  assert.equal(installed.installation.runtimeSha, process.env.TEST_SOURCE_SHA);
  evidence.phase = RegistrationPhase.Candidate;
  evidence.candidateRegistration = await registerCurrentTools(candidateJobId);
  const candidate = readHostedDependencyBinding(candidateJobId); assert(candidate && candidate.version === 2);
  assertNoReceiptHistory(candidate.workspace);
  evidence.phase = RegistrationPhase.Reference;
  await enrollReferenceAndAssert(candidateJobId, referenceJobId, ReferenceEnrollmentPublication.Complete);
  evidence.phase = RegistrationPhase.Readback;
  const reference = readHostedDependencyBinding(referenceJobId); assert(reference && reference.version === 3);
  assertNoReceiptHistory(reference.workspace);
  assert.deepEqual(readHostedInstallationActivation(), installed);
  assert.deepEqual(sentinels.map(path => ({ path, sha256: fileDigest(path), dev: String(lstatSync(path).dev), ino: String(lstatSync(path).ino) })), before);
  assert.deepEqual(readdirSync(referenceWorkspace), [".git"]);
  for (const workspace of [candidateWorkspace, referenceWorkspace])
    assert.throws(() => lstatSync(workspace + "/node_modules"), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
  evidence.results = [{ scenario: "actual_owned_closed_installation", result: "passed", installationId: installed.installation.installationId,
    inventorySha256: installed.installation.inventorySha256, runtimeManifestSha256: installed.installation.runtimeManifestSha256 },
    { scenario: "original_current_candidate_and_distinct_reference_registration", result: "passed", candidateJobId, referenceJobId,
      candidateVersion: candidate.version, referenceVersion: reference.version, referenceKind: reference.reference.kind,
      referenceOperationId: reference.reference.operationId, workspace: candidate.workspace, referenceWorkspace: reference.workspace,
      bindingAbsenceGrantReadback: "original_protected_records", duplicateAndUnpreparedReferenceRefused: true,
      activationPhase: installed.activation.phase, ordinaryStarts: installed.activation.ordinaryStarts.length,
      modelOrAccountProof: "none", baselineOrReadyProof: "none" }];
}

/** A fresh registered fixture has no history. Do not initialize/migrate a
 * receipt store merely to ask whether Ready exists, or synthesize a receipt. */
function assertNoReceiptHistory(workspace: { dev: string; ino: string }): void {
  for (const path of [hostedDependencyReceiptHistoryRoot,
    `/var/lib/subscription-runtime-host-policy/dependency-receipts/${workspace.dev}-${workspace.ino}`])
    assert.throws(() => lstatSync(path), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
}
