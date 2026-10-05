import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer, createConnection, type Socket } from "node:net";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, cpSync, existsSync, fstatSync, fsyncSync, lstatSync, openSync,
  readdirSync, readFileSync, readlinkSync, readSync, realpathSync, statfsSync, symlinkSync, writeFileSync } from "node:fs";
import { HostedInstallationActivationStore, readHostedInstallationActivation } from "../../dist/worker-codex/hosted-installation-activation.js";
import { hostedReadonlyPolicyRoot, readHostedPrivateBytes } from "../../dist/worker-codex/hosted-readonly-inputs.js";
import { completionPath, HostedReadonlyHostKernel } from "../../dist/worker-codex/hosted-readonly-host-kernel.js";
import { assertReadonlyHostOperator, readonlyIdentityName } from "../../dist/worker-codex/hosted-readonly-authority.js";
import { HostedReadonlySupervisorHost } from "../../dist/worker-codex/hosted-readonly-supervisor-host.js";
import { inspectReadonlyInputs } from "../../dist/worker-codex/hosted-readonly-custody.js";
import { runHostedRuntimeForeground } from "../../dist/worker-codex/hosted-readonly-foreground.js";
import { hostedForegroundExitCode } from "../../dist/worker-codex/hosted-foreground-result.js";
import { readCodexGoalResultSummary } from "../../dist/worker-codex/codex-goal-status-files.js";
import { collectCodexGoalStatus } from "../../dist/worker-codex/codex-goal-ops.js";
import { writeHostedTestEgressGrant } from "../../dist/worker-codex/hosted-test-egress-files.js";
import { CodexProviderEgressProfileId, verifySystemBusInfrastructure } from "../../dist/provider-codex/index.js";
import { parseSystemBusInfrastructure, SystemBusInfrastructureRole, SYSTEM_BUS_CONFIG, SYSTEM_BUS_CONFIG_PATH,
  SYSTEM_BUS_CONTROL_GROUP, SYSTEM_BUS_ENDPOINT, SYSTEM_BUS_EXECUTABLE, SYSTEM_BUS_SERVICE_FRAGMENT,
  SYSTEM_BUS_SOCKET_FRAGMENT, type SystemBusFilePin, type SystemBusInfrastructure } from "../../dist/core/index.js";
import { DependencyInstallArchitecture, DependencyLibcFamily, DependencyToolRootKind, HostedCustodyPhase, HostedCustodyReservationState, parseHostedOrdinaryStart } from "../../dist/worker-core/index.js";
import { HostedDependencyInstallerNetworkInput, hostedDependencyInstallerNetworkRoot, hostedDependencyInstallerNpmRootSha256,
  HostedDependencyInstallerRevision, hostedDependencyInstallerDropperSha256,
  type HostedDependencyInstallerProfile } from "../../dist/worker-codex/hosted-dependency-installer-recipe.js";
import { readHostedDependencyBinding } from "../../dist/provider-codex/app-server/adapters/hosted-dependency-workspace.js";
import { LocalDependencyOwnerStore } from "../../dist/store-local-file/dependency-environment/local-dependency-owner-store.js";
import { readHostedDependencyReceipt } from "../../dist/worker-codex/hosted-dependency-materialization.js";
import { fdCollectorProfilePath, FdCollectorRenderer, parseFdCollectorProfile, parseFdCollectorRows,
  type FdCollectorProfile, type FdExecutablePin, type FdFilePin } from "../../dist/core/host-infrastructure/fd-collector-profile.js";
import { assertHostedFdInternals, observeHostedFdProcess, hostedFdTable } from "../../dist/provider-codex/app-server/adapters/hosted-fd-observation.js";
import { hostedFdLaunch, hostedFdInvocationUnit, spawnHostedFdChild, HostedFdLaunchKind, HostedForegroundArtifactKind, type HostedForegroundResult } from "../../dist/provider-codex/app-server/adapters/hosted-fd-launch.js";
import { startResearchLaunch } from "../../dist/worker-codex/research-launch-owner.js";
import { assertResearchInitialRoot } from "../../dist/worker-codex/research-launch-host.js";
import { cleanEnv, command, ControlSinkPhase, digest, directory, directoryIdentity, fileDigest, installedArtifactDigest, json, node, OwnedOsScenario,
  policy, readonlyStorage, runtime, runtimeDiagnostic } from "./common.ts";

{
  const evidence: Record<string, unknown> = { schemaVersion: 1, sourceSha: process.env.TEST_SOURCE_SHA,
    qualification: process.env.TEST_OS_SCENARIO === OwnedOsScenario.Readonly ? "native_readonly_custody_synthetic_provider" : "native_fresh_hot_synthetic_provider", machineId: readFileSync("/etc/machine-id", "utf8").trim(),
    status: "failed", results: [], requiredCompanionGates: [{ workflow: "dependency-retention-linux-test.yml",
      sourceSha: process.env.TEST_SOURCE_SHA, observedInvariant: "actual npm UID/GID 65532 before normalization" }],
    unsupported: ["committed_absent_eviction_and_cold_restore", "live_account_provider_acceptance", "complete_stdio_fd_peer_provenance"],
    pendingNativeCases: ["actual_inherited_control_sink_capture", "separate_readonly_custody_foreground_consumer"] };
  try {
    assert(Object.values(OwnedOsScenario).includes(process.env.TEST_OS_SCENARIO as OwnedOsScenario));
    if (process.env.TEST_OS_SCENARIO === OwnedOsScenario.Readonly) await qualifyReadonly(evidence);
    else await qualify(evidence);
    evidence.status = "partial_pass";
  }
  catch (error) {
    evidence.failure = error instanceof Error ? error.message.slice(0, 512) : "TEST native qualification failed";
    if (error instanceof Error) evidence.failureLocations = failureLocations(error);
    process.exitCode = 1;
  } finally { json(runtime + "/guest-evidence.json", evidence, 0o644); }
}

async function qualify(evidence: Record<string, unknown>): Promise<void> {
  assert.equal(process.argv[2], "qualify"); assertReadonlyHostOperator();
  assert.match(process.env.TEST_SOURCE_SHA ?? "", /^[a-f0-9]{40}$/);
  evidence.kernelGatePhase = "actual_system_bus_infrastructure";
  const systemBusInfrastructure = await issueActualSystemBusInfrastructure(evidence);
  assert(!existsSync(policy)); directory(policy);
  for (const name of ["ordinary-origins", "ordinary-starts", "ordinary-completed", "codex-readonly-custody", "codex-readonly-revoked", "codex-readonly-inputs"])
    directory(policy + "/" + name);
  const results = evidence.results as unknown[];
  evidence.kernel = command("/usr/bin/uname", ["--release"]).trim();
  const guestNamespaces = { user: readlinkSync("/proc/self/ns/user"), mnt: readlinkSync("/proc/self/ns/mnt"), pid: readlinkSync("/proc/self/ns/pid") };
  evidence.namespaces = { ...guestNamespaces, cgroup: readlinkSync("/proc/self/ns/cgroup") };
  evidence.uidMap = readFileSync("/proc/self/uid_map", "utf8").trim();
  evidence.bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  evidence.runtimeManifestSha256 = installedArtifactDigest();
  const actualPackage = lstatSync(runtime + "/package.json");
  assert(actualPackage.isFile() && !actualPackage.isSymbolicLink() && actualPackage.uid === 0 && actualPackage.nlink === 1 && !(actualPackage.mode & 0o022));
  evidence.installedRuntimeRootPackage = { path: runtime + "/package.json", sha256: fileDigest(runtime + "/package.json"),
    bytes: actualPackage.size, source: "actual copied runtime-root artifact, no substitute metadata" };
  evidence.runtimeDirectory = directoryIdentity(runtime);
  evidence.systemdVersion = command("/usr/bin/systemctl", ["--version"]).split("\n")[0];
  evidence.cgroupControllers = readFileSync("/sys/fs/cgroup/cgroup.controllers", "utf8").trim();
  assert(!readFileSync("/etc/passwd", "utf8").split("\n").some(line => line.split(":")[2] === "65532"));
  assert(!readFileSync("/etc/group", "utf8").split("\n").some(line => line.split(":")[2] === "65532"));
  evidence.installerNssIdentityAbsent = true;
  assert.match(String(evidence.cgroupControllers), /\bcpu\b/); assert.match(String(evidence.cgroupControllers), /\bmemory\b/);
  assert.match(String(evidence.cgroupControllers), /\bpids\b/);
  const jobId = "TEST-os-" + randomUUID(), root = policy + "/dependency-test-jobs/jobs/" + jobId;
  directory(root); const workspace = root + "/workspace"; directory(workspace);
  const inputs = await publicInputs();
  writeFileSync(workspace + "/package.json", inputs.packageBytes, { flag: "wx", mode: 0o600 });
  writeFileSync(workspace + "/package-lock.json", inputs.lockBytes, { flag: "wx", mode: 0o600 });
  writeFileSync(workspace + "/source-sentinel", "TEST source original\n", { flag: "wx", mode: 0o600 });
  writeFileSync(workspace + "/.gitignore", ".needed-ignored\nTEST-provider-probe-*.json\nnode_modules/\n", { flag: "wx", mode: 0o600 });
  command("/usr/bin/git", ["init", "--initial-branch=main", workspace]);
  command("/usr/bin/git", ["config", "user.name", "iliya"], 30000, workspace);
  command("/usr/bin/git", ["config", "user.email", "iliyazelenkog@gmail.com"], 30000, workspace);
  command("/usr/bin/git", ["add", "package.json", "package-lock.json", ".gitignore", "source-sentinel"], 30000, workspace);
  const author = command("/usr/bin/git", ["var", "GIT_AUTHOR_IDENT"], 30000, workspace);
  const committer = command("/usr/bin/git", ["var", "GIT_COMMITTER_IDENT"], 30000, workspace);
  assert(author.startsWith("iliya <iliyazelenkog@gmail.com> ")); assert(committer.startsWith("iliya <iliyazelenkog@gmail.com> "));
  command("/usr/bin/git", ["commit", "-m", "test: initialize disposable dependency fixture"], 30000, workspace);
  const sentinels = [workspace + "/source-sentinel", workspace + "/.git/config", workspace + "/.needed-ignored",
    root + "/key-sentinel", root + "/state-sentinel", root + "/output-sentinel", policy + "/privileged-sibling-sentinel"];
  for (const path of sentinels.slice(2)) writeFileSync(path, "TEST private original\n", { flag: "wx", mode: 0o600 });
  const before = sentinels.map(path => ({ path, sha256: fileDigest(path), ino: String(lstatSync(path).ino) }));
  const gitBefore = command("/usr/bin/git", ["rev-parse", "HEAD"], 30000, workspace).trim();
  directory(root + "/auth/TEST-account");
  json(root + "/auth/TEST-account/auth.json", { auth_mode: "chatgpt", tokens: { refresh_token: "TEST-NOT-A-CREDENTIAL" }, last_refresh: new Date().toISOString() });
  writeFileSync(root + "/prompt", "Execute the fixed dependency-reading TEST probe. This is a synthetic provider protocol fixture.\n", { flag: "wx", mode: 0o600 });
  directory(root + "/state");
  const resultPath = root + "/state/TEST-result.json";
  directory(runtime + "/codex/bin", 0o755);
  cpSync(runtime + "/scripts/dependency-retention-os-test/provider.ts", runtime + "/codex/bin/provider.ts");
  chmodSync(runtime + "/codex/bin/provider.ts", 0o755);
  json(runtime + "/codex/package.json", { name: "@openai/codex", type: "module", private: true }, 0o644);
  json(runtime + "/codex/TEST-probe.json", { workspace, guestNamespaces }, 0o644);
  const args = [runtime + "/dist/worker-codex/codex-goal-cli.js", "run", "--task-id", jobId, "--job-id", jobId,
    "--job-root", root, "--workspace", workspace, "--prompt", root + "/prompt", "--accounts", "TEST-account", "--auth-root", root + "/auth",
    "--codex-binary", runtime + "/codex/bin/provider.ts", "--model", "TEST-synthetic-model", "--effort", "low",
    "--timeout", "5m", "--max-goal-turns", "1", "--max-attempts", "1", "--continuation-mode", "disabled",
    "--registry-root", root + "/state/registry", "--output", resultPath, "--worker-report-mode", "structured-output"];
  const launch = { command: node, args, cwd: workspace };
  const supervisorUnit = "TEST-retention-supervisor.service";
  // v255 list-unit-files exits ENOENT for a zero-row filtered list. Enable only
  // the already-required, inventoried TEST supervisor through an actual guest
  // runtime wants link; no extra unit, reload or process is introduced.
  const runtimeUnits = "/run/systemd/system", wants = runtimeUnits + "/TEST-retention.target.wants";
  directory(runtimeUnits, 0o755); assert(!existsSync(wants)); directory(wants, 0o755);
  const link = wants + "/" + supervisorUnit, fragment = "/etc/systemd/test-units/" + supervisorUnit;
  symlinkSync(fragment, link);
  const linkStat = lstatSync(link); assert(linkStat.isSymbolicLink() && linkStat.uid === 0 && linkStat.nlink === 1);
  assert.equal(readlinkSync(link), fragment); assert.equal(realpathSync(link), fragment);
  const enabled = command("/usr/bin/systemctl", ["list-unit-files", "--type=service,socket,timer",
    "--state=enabled,enabled-runtime,linked,linked-runtime,alias", "--no-legend", "--no-pager"])
    .split("\n").filter(line => line.trim()).map(line => line.trim().split(/\s+/));
  assert.equal(enabled.length, 1); assert.equal(enabled[0]?.[0], supervisorUnit); assert.equal(enabled[0]?.[1], "enabled-runtime");
  evidence.runtimeSupervisorEnablement = { unit: supervisorUnit, actualState: enabled[0]![1],
    linkRootOwned: true, linkTargetMatches: true, fragmentSha256: fileDigest(fragment) };
  const controlGroup = command("/usr/bin/systemctl", ["show", supervisorUnit, "--property=ControlGroup", "--value"]).trim();
  evidence.kernelGatePhase = "native_fd_collector_qualification";
  const collectorProfile = await issueNativeFdProfile(evidence);
  json(policy + "/readonly-inventory.json", { schemaVersion: 4, hostId: evidence.machineId, supervisorUnit, systemBusInfrastructure, collectorProfile,
    units: [{ name: supervisorUnit, controlGroup, fragmentSha256: fileDigest("/etc/systemd/test-units/" + supervisorUnit) },
      { name: "dbus.service", controlGroup: SYSTEM_BUS_CONTROL_GROUP, fragmentSha256: systemBusInfrastructure.service.fragmentSha256 }],
    ordinaryCreators: [{ creatorId: jobId, jobId, jobRootDir: root, workspacePath: workspace, launch }],
    disabledCreators: [], runtimeLaunch: launch });
  const stage = "/run/user/0/subscription-runtime-host-policy/codex-readonly-stages"; directory(stage);
  json(stage + "/" + digest(runtime) + ".json", { schemaVersion: 1, runtimeDirectory: runtime,
    runtimeSha: process.env.TEST_SOURCE_SHA, runtimeManifestSha256: evidence.runtimeManifestSha256 });
  const installerProfile = actualToolchainProfile();
  evidence.installerProfile = installerProfile;
  json(policy + "/dependency-installer-profile.json", installerProfile);
  evidence.kernelGatePhase = "exclusive_inventory";
  try { new HostedReadonlyHostKernel().verifyExclusiveInventory(); }
  catch (error) {
    try { evidence.kernelInventoryObservation = observeKernelInventory(supervisorUnit, controlGroup); }
    catch { evidence.kernelInventoryObservation = { purpose: "TEST_kernel_predicate_observation_only", unavailable: true }; }
    throw error;
  }
  evidence.kernelGatePhase = "cold_installation";
  const store = new HostedInstallationActivationStore();
  try { store.install(); }
  catch (error) {
    try { evidence.kernelInventoryObservation = observeKernelInventory(supervisorUnit, controlGroup); }
    catch { evidence.kernelInventoryObservation = { purpose: "TEST_kernel_predicate_observation_only", unavailable: true }; }
    throw error;
  }
  results.push({ scenario: "unchanged_cold_host_installation", result: "qualified_actual_finite_inventory", controlGroup });
  evidence.kernelGatePhase = "research_shared_host_early_denial";
  assertResearchInitialRoot(true);
  const activationBeforeResearch = fileDigest(policy + "/host-installation.json");
  const authorityBeforeResearch = existsSync("/run/user/subscription-runtime-research-v1");
  const unitsBeforeResearch = command("/usr/bin/systemctl", ["list-jobs", "--no-legend", "--no-pager"]);
  const transientSnapshot = () => ({ present: existsSync("/run/systemd/transient"),
    entries: existsSync("/run/systemd/transient") ? readdirSync("/run/systemd/transient").sort() : [] });
  const transientBeforeResearch = transientSnapshot();
  assert.throws(() => startResearchLaunch(root + "/TEST-nonexistent-research-request.json", "0".repeat(64)),
    (error: unknown) => error instanceof Error && error.message === "hosted_research_launch_denied");
  assert.equal(fileDigest(policy + "/host-installation.json"), activationBeforeResearch);
  assert.equal(existsSync("/run/user/subscription-runtime-research-v1"), authorityBeforeResearch);
  assert.equal(command("/usr/bin/systemctl", ["list-jobs", "--no-legend", "--no-pager"]), unitsBeforeResearch);
  assert.deepEqual(transientSnapshot(), transientBeforeResearch);
  results.push({ scenario: "research_shared_host_early_denial", result: "denied_before_request_read_or_unit_launch" });
  evidence.kernelGatePhase = "private_policy_namespace_setup";
  // The strict private reader recognizes only a missing leaf beneath existing
  // trusted ancestry. An absent parent is invalid, never managed-policy absence.
  assert(!existsSync(hostedReadonlyPolicyRoot)); directory(hostedReadonlyPolicyRoot);
  const parents = ["/", "/run", "/run/user", "/run/user/0", "/run/user/0/subscription-runtime-host-policy", hostedReadonlyPolicyRoot];
  const ancestry = parents.map((path, index) => {
    const stat = lstatSync(path); assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === 0 && (stat.mode & 0o022) === 0);
    if (path === hostedReadonlyPolicyRoot) assert.equal(stat.mode & 0o777, 0o700);
    return { component: index, uid: stat.uid, mode: stat.mode & 0o777, dev: String(stat.dev), ino: String(stat.ino) };
  });
  assert.equal(readdirSync(hostedReadonlyPolicyRoot).length, 0);
  assert.equal(readHostedPrivateBytes(hostedReadonlyPolicyRoot + "/" + digest(jobId) + ".json", 64 * 1024), null);
  evidence.privatePolicyNamespace = { ancestry, entries: 0, unchangedReaderMissingLeaf: true };
  evidence.kernelGatePhase = "write_test_egress_grant";
  await writeHostedTestEgressGrant({ schemaVersion: 1, jobId, jobRootDir: root, workspacePath: workspace,
    profileId: CodexProviderEgressProfileId.TestNpmQualification });
  evidence.kernelGatePhase = "enroll_ordinary"; store.enrollOrdinary(jobId);
  evidence.kernelGatePhase = "resume_ordinary"; store.resumeOrdinary();
  evidence.kernelGatePhase = "read_dependency_binding";
  const binding = readHostedDependencyBinding(jobId); assert(binding);
  const env = { ...cleanEnv, SUBSCRIPTION_RUNTIME_SANDBOX_KIND: "hosted-codex-job" };
  let readyDigest: string | undefined;
  evidence.guestBusPaths = ["/run/systemd/private", "/run/dbus/system_bus_socket"].map((path, slot) => {
    try { const stat = lstatSync(path); return { slot, present: true, socket: stat.isSocket(), symlink: stat.isSymbolicLink(),
      uid: stat.uid, mode: stat.mode & 0o777, dev: String(stat.dev), ino: String(stat.ino) }; }
    catch (error) { return { slot, present: false, missing: (error as NodeJS.ErrnoException).code === "ENOENT" }; }
  });
  for (const mode of ["fresh", "hot"] as const) {
    evidence.kernelGatePhase = mode + "_real_cli";
    const foreground = await runHostedRuntimeForeground(node, args, workspace, env), cliStatus = hostedForegroundExitCode(foreground);
    if (cliStatus !== 0) {
      try { evidence.cliFailureObservation = observeOwnedCliFailure(jobId, root, workspace, cliStatus); }
      catch { evidence.cliFailureObservation = { purpose: "TEST_owned_cli_failure_only", status: cliStatus, unavailable: true }; }
    }
    assert.equal(cliStatus, 0, `actual ${mode} CLI failed`);
    assert(typeof foreground !== "number", "TEST governed foreground must return authenticated output refs");
    const retrieved = await readCodexGoalResultSummary(resultPath); assert(retrieved.foregroundOutput);
    assert.equal(retrieved.foregroundOutput.unit, foreground.unit);
    assert.equal(retrieved.foregroundOutput.exitCode, 0);
    assert(Buffer.byteLength(retrieved.foregroundOutput.stdout) + Buffer.byteLength(retrieved.foregroundOutput.stderr) > 0);
    const outputEvidence = { unit: foreground.unit, exitCode: retrieved.foregroundOutput.exitCode, artifacts: foreground.artifacts,
      retrievedStdoutBytes: Buffer.byteLength(retrieved.foregroundOutput.stdout), retrievedStderrBytes: Buffer.byteLength(retrieved.foregroundOutput.stderr) };
    evidence.kernelGatePhase = mode + "_receipt_owner_probe";
    const receipt = readHostedDependencyReceipt(binding); assert(receipt);
    const owner = LocalDependencyOwnerStore.open({ rootPath: policy + "/dependency-owners", maxRecordBytes: 16384 });
    try { assert.equal(owner.read(binding.workspace)?.owner, null, "actual creator/drain release unresolved"); }
    finally { owner.close(); }
    const probes = readdirSync(workspace).filter(name => /^TEST-provider-probe-[12]\.json$/.test(name)).sort();
    assert.equal(probes.length, mode === "fresh" ? 1 : 2);
    const probePath = workspace + "/" + probes.at(-1)!;
    const probeStat = lstatSync(probePath); assert(probeStat.isFile() && probeStat.nlink === 1 && probeStat.uid === 0 && probeStat.size < 4096);
    const observed = JSON.parse(readFileSync(probePath, "utf8")) as Record<string, unknown>;
    assert(typeof observed.uidMap === "string" && /^65532\s+0\s+1$/.test(observed.uidMap));
    assert(typeof observed.gidMap === "string" && /^65532\s+0\s+1$/.test(observed.gidMap));
    assert(observed.namespaces && typeof observed.namespaces === "object" && !Array.isArray(observed.namespaces));
    const namespaces = observed.namespaces as Record<string, unknown>;
    assert.equal(Object.keys(namespaces).sort().join(","), "mnt,pid,user");
    for (const kind of ["user", "mnt", "pid"] as const) {
      assert(typeof namespaces[kind] === "string" && new RegExp(`^${kind}:\\[\\d+\\]$`).test(namespaces[kind]));
      assert.notEqual(namespaces[kind], guestNamespaces[kind], `actual provider ${kind} namespace must differ from guest`);
    }
    assert.deepEqual(observed, { schemaVersion: 1, result: "dependency_read_and_actual_enclosure_denial_passed",
      ids: { uid: 65532, euid: 65532, gid: 65532, egid: 65532 }, uidMap: observed.uidMap, gidMap: observed.gidMap,
      namespaces, noNewPrivs: 1, capabilities: "zero" });
    const installs = readdirSync(policy + "/dependency-installers").filter(name => /^[a-f0-9-]{36}$/.test(name));
    assert.equal(installs.length, 1, "hot reuse must not reinstall");
    const currentReady = digest(JSON.stringify(receipt));
    if (mode === "hot") assert.equal(currentReady, readyDigest); else readyDigest = currentReady;
    results.push({ scenario: mode + "_real_cli_provider_and_drain", result: "passed", installCount: installs.length,
      receiptSha256: currentReady, probe: observed, output: outputEvidence });
  }
  evidence.kernelGatePhase = "actual_inherited_relay_control_sink";
  results.push(await qualifyRelayControlSink(systemBusInfrastructure, workspace, resultPath));
  const afterSink = readHostedDependencyReceipt(binding); assert(afterSink);
  assert.equal(digest(JSON.stringify(afterSink)), readyDigest);
  const afterSinkOwner = LocalDependencyOwnerStore.open({ rootPath: policy + "/dependency-owners", maxRecordBytes: 16384 });
  try { assert.equal(afterSinkOwner.read(binding.workspace)?.owner, null); } finally { afterSinkOwner.close(); }
  evidence.pendingNativeCases = ["direct_daemon_socket_sent_byte_capture", "noop_and_stale_same_inode_result", "unauthorized_destination_no_preread"];
  evidence.kernelGatePhase = "actual_final_release_deadline_denial";
  results.push(await qualifyLateRelease(node, args, workspace, env));
  const afterLateReceipt = readHostedDependencyReceipt(binding); assert(afterLateReceipt);
  assert.equal(digest(JSON.stringify(afterLateReceipt)), readyDigest);
  assert.equal(readdirSync(policy + "/dependency-installers").filter(name => /^[a-f0-9-]{36}$/.test(name)).length, 1);
  assert.deepEqual(before, sentinels.map(path => ({ path, sha256: fileDigest(path), ino: String(lstatSync(path).ino) })));
  assert.equal(command("/usr/bin/git", ["rev-parse", "HEAD"], 30000, workspace).trim(), gitBefore);
  results.push({ scenario: "source_git_ignored_key_state_output_sentinels", result: "unchanged" });
}

/** Captures bytes SENT to the inherited first-hop TEST relay. Incoming bus
 * replies, final manager state and Socket.bytesWritten are not send evidence.
 * This deliberately does not claim capture on a directly inherited daemon FD. */
async function qualifyRelayControlSink(bus: SystemBusInfrastructure, workspace: string, resultPath: string) {
  verifySystemBusInfrastructure(bus);
  const endpointBefore = lstatSync(SYSTEM_BUS_ENDPOINT), name = "/run/TEST-control-relay-" + randomUUID();
  const server = createServer(), connection = once(server, "connection");
  let source: Socket | undefined, receiver: Socket | undefined, upstream: Socket | undefined;
  let child: ReturnType<typeof spawn> | undefined, birth: string | undefined, sentBytes = 0, prePayloadBytes = -1;
  let outputPaths: string[] = [], observed = false, drained = false;
  const previousStarts = new Set(readHostedInstallationActivation().activation.ordinaryStarts.map(row => row.startId));
  const countProbes = () => readdirSync(workspace).filter(value => /^TEST-provider-probe-[123]\.json$/.test(value)).length;
  assert.equal(countProbes(), 2);
  try {
    await boundedWait(new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(name, resolve); }), 2000);
    chmodSync(name, 0o600); const relay = lstatSync(name); assert(relay.isSocket() && relay.uid === 0 && (relay.mode & 0o777) === 0o600);
    source = createConnection(name); await boundedWait(once(source, "connect"), 2000);
    [receiver] = await boundedWait(connection, 2000) as [Socket];
    upstream = createConnection(SYSTEM_BUS_ENDPOINT); await boundedWait(once(upstream, "connect"), 2000);
    const actualUpstream = upstream;
    // Record counts only. Never persist payload, credential or bus reply bytes.
    receiver.on("data", (chunk: Buffer) => {
      sentBytes += chunk.length;
      if (sentBytes > 4 * 1024 * 1024) { receiver!.destroy(); actualUpstream.destroy(); return; }
      if (!actualUpstream.write(chunk)) { receiver!.pause(); actualUpstream.once("drain", () => receiver!.resume()); }
    });
    upstream.on("data", () => {}); upstream.on("error", () => {}); source.on("error", () => {}); receiver.on("error", () => {});
    const receiverEnd = once(receiver, "end");
    child = spawn(node, ["--experimental-strip-types", runtime + "/scripts/dependency-retention-os-test/common.ts", "control-sink"],
      { env: cleanEnv, stdio: ["pipe", source, source, "ipc"] });
    assert(child.pid); birth = observeHostedFdProcess(child.pid).birth;
    const actual = observeHostedFdProcess(child.pid);
    assert.equal(actual.group, boundedProc("/proc/self/cgroup", 4096).trim());
    const stdio = actual.descriptors.filter(row => row.fd === 1 || row.fd === 2);
    assert(stdio.length === 2 && stdio.every(row => row.socket) && stdio[0]!.target === stdio[1]!.target);
    const closed = once(child, "close"); child.stdin!.on("error", () => {}); child.stdin!.end();
    let rejectMessage: (error: unknown) => void = () => {};
    const messageFailure = new Promise<never>((_resolve, reject) => { rejectMessage = reject; });
    void messageFailure.catch(() => {});
    child.on("message", (value: unknown) => { try {
      assert(value && typeof value === "object" && !Array.isArray(value));
      const message = value as Record<string, unknown>;
      assert.equal(Object.keys(message).sort().join(","), "outputPaths,phase");
      assert(Array.isArray(message.outputPaths) && message.outputPaths.length === 2 && message.outputPaths.every(path => typeof path === "string"));
      if (message.phase === ControlSinkPhase.Observed) {
        assert(!observed); observed = true; outputPaths = message.outputPaths as string[];
        const added = readHostedInstallationActivation().activation.ordinaryStarts.filter(row => !previousStarts.has(row.startId));
        assert.equal(added.length, 1); const reserved = added[0]!; assert.equal(reserved.state, HostedCustodyReservationState.Reserved);
        const startBytes = readHostedPrivateBytes(policy + "/ordinary-starts/" + reserved.startId + ".json", 16384); assert(startBytes);
        const start = parseHostedOrdinaryStart(JSON.parse(startBytes.toString("utf8")));
        assert.equal(start.creatorPidBirth, birth); assert.equal(start.workspacePath, workspace);
        assert.equal(start.unit, reserved.unit); assert.equal(start.activationGeneration, reserved.generation);
        assert.deepEqual(outputPaths, [policy + "/foreground-output/" + reserved.unit + ".stdout", policy + "/foreground-output/" + reserved.unit + ".stderr"]);
        verifySystemBusInfrastructure(bus); assert.equal(countProbes(), 2); prePayloadBytes = sentBytes; assert.equal(prePayloadBytes, 0);
        for (const path of outputPaths) { const stat = lstatSync(path); assert(stat.isFile() && stat.uid === 0 && stat.nlink === 1 && (stat.mode & 0o777) === 0o600 && stat.size === 0); }
        child!.send({ phase: ControlSinkPhase.Release });
      } else {
        assert.equal(message.phase, ControlSinkPhase.Drained); assert(observed && !drained); drained = true;
        assert.deepEqual(message.outputPaths, outputPaths);
      }
    } catch (error) { rejectMessage(error); }
    });
    const [code, signal] = await boundedWait(Promise.race([closed, messageFailure]), 6 * 60000); assert.equal(code, 0); assert.equal(signal, null); assert(observed && drained);
    source.end(); await boundedWait(receiverEnd, 2000); assert.equal(sentBytes, 0); assert.equal(countProbes(), 3);
    verifySystemBusInfrastructure(bus); const endpointAfter = lstatSync(SYSTEM_BUS_ENDPOINT);
    assert(endpointBefore.dev === endpointAfter.dev && endpointBefore.ino === endpointAfter.ino);
    const added = readHostedInstallationActivation().activation.ordinaryStarts.filter(row => !previousStarts.has(row.startId));
    assert.equal(added.length, 1); const row = added[0]!; assert.equal(row.state, HostedCustodyReservationState.Terminal);
    assert.deepEqual(outputPaths, [policy + "/foreground-output/" + row.unit + ".stdout", policy + "/foreground-output/" + row.unit + ".stderr"]);
    const logs = outputPaths.map(path => { const stat = lstatSync(path); assert(stat.isFile() && stat.uid === 0 && stat.nlink === 1 && !(stat.mode & 0o077));
      return { path, dev: String(stat.dev), ino: String(stat.ino), bytes: stat.size }; });
    assert(logs.reduce((sum, log) => sum + log.bytes, 0) > 0, "TEST successful payload did not exercise protected output");
    const result = await readCodexGoalResultSummary(resultPath); assert(result.foregroundOutput);
    assert.equal(result.foregroundOutput.unit, row.unit);
    assert.equal(result.foregroundOutput.exitCode, 0);
    assert.equal(Buffer.byteLength(result.foregroundOutput.stdout), logs[0]!.bytes);
    assert.equal(Buffer.byteLength(result.foregroundOutput.stderr), logs[1]!.bytes);
    return { scenario: "actual_inherited_control_relay", outcome: "protected_output_replacement_and_real_drain", inheritedStdio: stdio.map(row => ({ fd: row.fd, target: row.target })),
      relayEndpoint: name, upstreamEndpoint: SYSTEM_BUS_ENDPOINT, upstreamManagerPid: 1, producerPidBirth: birth, prePayloadSentBytes: prePayloadBytes,
      finalSentBytes: sentBytes, actualStartId: row.startId, unit: row.unit, logs,
      limitation: "first-hop relay capture; direct daemon inherited FD sent-byte capture remains pending" };
  } finally {
    if (child?.pid && birth && child.exitCode === null && observeHostedFdProcess(child.pid).birth === birth) child.kill("SIGTERM");
    source?.destroy(); receiver?.destroy(); upstream?.destroy();
    if (server.listening) await boundedWait(new Promise<void>(resolve => server.close(() => resolve())), 2000);
  }
}

/** Separate authentic installation, never a managed flag on the dependency
 * inventory. All readiness and terminal facts come from existing operator APIs. */
async function qualifyReadonly(evidence: Record<string, unknown>): Promise<void> {
  assert.equal(process.argv[2], "qualify"); assertReadonlyHostOperator();
  const systemBusInfrastructure = await issueActualSystemBusInfrastructure(evidence);
  assert(!existsSync(policy)); directory(policy);
  for (const name of ["ordinary-origins", "ordinary-starts", "ordinary-completed", "codex-readonly-custody", "codex-readonly-revoked", "codex-readonly-services"])
    directory(policy + "/" + name);
  const capacity = statfsSync(readonlyStorage, { bigint: true }), storage = directoryIdentity(readonlyStorage);
  assert.notEqual(storage.dev, String(lstatSync("/").dev));
  assert(capacity.bavail * capacity.bsize >= 5n * 1024n ** 3n && capacity.ffree >= 50000n);
  assert.equal(readFileSync("/etc/subscription-runtime/storage-root", "utf8"), readonlyStorage + "\n");
  evidence.readonlyStorage = { ...storage, availableBytes: String(capacity.bavail * capacity.bsize), availableInodes: String(capacity.ffree),
    mountNamespace: readlinkSync("/proc/self/ns/mnt"), mountInfoSha256: digest(boundedProc("/proc/self/mountinfo", 1024 * 1024)) };
  const namespaces = { user: readlinkSync("/proc/self/ns/user"), mnt: readlinkSync("/proc/self/ns/mnt"), pid: readlinkSync("/proc/self/ns/pid") };
  evidence.runtimeManifestSha256 = installedArtifactDigest();
  evidence.installedRuntimeRootPackage = { path: runtime + "/package.json", sha256: fileDigest(runtime + "/package.json"),
    bytes: lstatSync(runtime + "/package.json").size, source: "actual copied runtime-root artifact, no substitute metadata" };
  const jobId = "TEST-readonly-" + randomUUID(), root = readonlyStorage + "/jobs/" + jobId, workspace = root + "/workspace";
  directory(root); directory(workspace); directory(workspace + "/reviewed");
  const input = "TEST independently reviewed readonly bytes\n", inputPath = workspace + "/reviewed/input.txt";
  writeFileSync(inputPath, input, { flag: "wx", mode: 0o644 });
  json(workspace + "/package.json", { name: "test-readonly-native", version: "1.0.0", private: true }, 0o644);
  writeFileSync(workspace + "/.gitignore", "TEST-readonly*-probe.json\n", { flag: "wx", mode: 0o644 });
  command("/usr/bin/git", ["init", "--initial-branch=main", workspace]);
  command("/usr/bin/git", ["config", "user.name", "iliya"], 30000, workspace);
  command("/usr/bin/git", ["config", "user.email", "iliyazelenkog@gmail.com"], 30000, workspace);
  assert(command("/usr/bin/git", ["var", "GIT_AUTHOR_IDENT"], 30000, workspace).startsWith("iliya <iliyazelenkog@gmail.com> "));
  assert(command("/usr/bin/git", ["var", "GIT_COMMITTER_IDENT"], 30000, workspace).startsWith("iliya <iliyazelenkog@gmail.com> "));
  command("/usr/bin/git", ["add", "reviewed/input.txt", "package.json", ".gitignore"], 30000, workspace);
  command("/usr/bin/git", ["commit", "-m", "test: initialize disposable readonly fixture"], 30000, workspace);
  const gitBefore = command("/usr/bin/git", ["rev-parse", "HEAD"], 30000, workspace).trim();
  directory(root + "/auth/TEST-account");
  json(root + "/auth/TEST-account/auth.json", { auth_mode: "chatgpt", tokens: { refresh_token: "TEST-NOT-A-CREDENTIAL" }, last_refresh: new Date().toISOString() });
  writeFileSync(root + "/prompt", "Execute the fixed readonly TEST probe.\n", { flag: "wx", mode: 0o600 });
  directory(root + "/state"); const resultPath = root + "/state/TEST-result.json";
  directory(runtime + "/codex/bin", 0o755);
  cpSync(runtime + "/scripts/dependency-retention-os-test/provider.ts", runtime + "/codex/bin/provider.ts");
  chmodSync(runtime + "/codex/bin/provider.ts", 0o755);
  json(runtime + "/codex/package.json", { name: "@openai/codex", type: "module", private: true }, 0o644);
  json(runtime + "/codex/TEST-probe.json", { scenario: OwnedOsScenario.Readonly, failSecondReadonlyTurn: true,
    workspace, guestNamespaces: namespaces, inputSha256: digest(input) }, 0o644);
  const args = [runtime + "/dist/worker-codex/codex-goal-cli.js", "run", "--task-id", jobId, "--job-id", jobId,
    "--job-root", root, "--workspace", workspace, "--prompt", root + "/prompt", "--accounts", "TEST-account", "--auth-root", root + "/auth",
    "--codex-binary", runtime + "/codex/bin/provider.ts", "--model", "TEST-synthetic-model", "--effort", "low",
    "--timeout", "5m", "--max-goal-turns", "1", "--max-attempts", "1", "--continuation-mode", "disabled",
    "--registry-root", root + "/state/registry", "--output", resultPath, "--worker-report-mode", "structured-output"];
  const supervisorUnit = "TEST-retention-supervisor.service", fragment = "/etc/systemd/test-units/" + supervisorUnit;
  directory("/run/systemd/system", 0o755); directory("/run/systemd/system/TEST-retention.target.wants", 0o755);
  symlinkSync(fragment, "/run/systemd/system/TEST-retention.target.wants/" + supervisorUnit);
  const collectorProfile = await issueNativeFdProfile(evidence);
  const launch = { command: node, args, cwd: workspace };
  json(policy + "/readonly-inventory.json", { schemaVersion: 4, hostId: evidence.machineId, supervisorUnit, systemBusInfrastructure, collectorProfile,
    units: [{ name: supervisorUnit, controlGroup: command("/usr/bin/systemctl", ["show", supervisorUnit, "--property=ControlGroup", "--value"]).trim(), fragmentSha256: fileDigest(fragment) },
      { name: "dbus.service", controlGroup: SYSTEM_BUS_CONTROL_GROUP, fragmentSha256: systemBusInfrastructure.service.fragmentSha256 }],
    ordinaryCreators: [], disabledCreators: [], runtimeLaunch: launch });
  const authorityRoot = "/run/user/0/subscription-runtime-host-policy";
  for (const name of ["codex-readonly", "codex-readonly-stages", "codex-readonly-reviewed"]) directory(authorityRoot + "/" + name);
  json(authorityRoot + "/codex-readonly-stages/" + digest(runtime) + ".json", { schemaVersion: 1, runtimeDirectory: runtime,
    runtimeSha: process.env.TEST_SOURCE_SHA, runtimeManifestSha256: evidence.runtimeManifestSha256 });
  evidence.kernelGatePhase = "readonly_cold_installation";
  const store = new HostedInstallationActivationStore(); store.install(); store.enterExclusive();
  await writeHostedTestEgressGrant({ schemaVersion: 1, jobId, jobRootDir: root, workspacePath: workspace,
    profileId: CodexProviderEgressProfileId.TestManagedQualification });
  const projection = { schemaVersion: 1 as const, jobId, jobRootDir: root, workspacePath: workspace, runtimeSha: process.env.TEST_SOURCE_SHA!,
    runtimeManifestSha256: String(evidence.runtimeManifestSha256), issuerDeploymentDigest: digest(JSON.stringify({ sourceSha: process.env.TEST_SOURCE_SHA,
      artifact: evidence.runtimeManifestSha256, inputSha256: digest(input), providerSha256: fileDigest(runtime + "/codex/bin/provider.ts") })),
    readonlyPaths: [workspace + "/reviewed"] };
  // Trusted TEST issuer verifies the full finite input independently, then
  // publishes review input. It never writes lease/epoch/Ready or completion.
  assert.equal(readFileSync(inputPath, "utf8"), input); inspectReadonlyInputs(projection, null);
  json(authorityRoot + "/codex-readonly-reviewed/" + readonlyIdentityName(jobId), { schemaVersion: 1, policy: projection, corepackShim: null,
    reviewReference: "TEST exact-source native fixture projection " + process.env.TEST_SOURCE_SHA,
    custodyReference: "TEST finite input SHA256 " + digest(input) });
  const policyInput = root + "/TEST-readonly-policy.json"; json(policyInput, projection);
  const operator = (operation: string, operand?: string) => command(node,
    [runtime + "/dist/worker-codex/hosted-readonly-inputs-cli.js", operation, ...(operand ? [operand] : [])], 60000);
  evidence.kernelGatePhase = "readonly_real_enrollment_and_recovery";
  operator("enroll", policyInput); operator("recover", jobId); operator("finish-exclusive");
  const host = new HostedReadonlySupervisorHost(), enrolled = host.readEpoch();
  assert.equal(enrolled.identity.jobId, jobId); assert.equal(enrolled.phase, HostedCustodyPhase.Ready);
  host.verifyReadonlyMaterial(enrolled.identity);
  evidence.kernelGatePhase = "readonly_real_cli_provider_and_drain";
  const foreground = await runHostedRuntimeForeground(node, args, workspace, { ...cleanEnv, SUBSCRIPTION_RUNTIME_SANDBOX_KIND: "hosted-codex-job" });
  assert.equal(hostedForegroundExitCode(foreground), 0); assert(typeof foreground !== "number");
  const retrieved = await readCodexGoalResultSummary(resultPath); assert(retrieved.foregroundOutput);
  assert.equal(retrieved.foregroundOutput.unit, foreground.unit);
  assert.equal(retrieved.foregroundOutput.exitCode, 0);
  assert(Buffer.byteLength(retrieved.foregroundOutput.stdout) + Buffer.byteLength(retrieved.foregroundOutput.stderr) > 0);
  const terminal = host.readEpoch(); assert(terminal.outerRuntime && terminal.outerRuntime.state === HostedCustodyReservationState.Terminal);
  assert(terminal.reservations.length === 1 && terminal.reservations.every(row => row.state === HostedCustodyReservationState.Terminal));
  const probePath = workspace + "/TEST-readonly-probe.json", probeStat = lstatSync(probePath);
  assert(probeStat.isFile() && !probeStat.isSymbolicLink() && probeStat.uid === 0 && probeStat.nlink === 1 && probeStat.size < 4096);
  const probe = JSON.parse(readFileSync(probePath, "utf8")) as Record<string, unknown>;
  assert(typeof probe.uidMap === "string" && /^65532\s+0\s+1$/.test(probe.uidMap));
  assert(typeof probe.gidMap === "string" && /^65532\s+0\s+1$/.test(probe.gidMap));
  assert(probe.namespaces && typeof probe.namespaces === "object" && !Array.isArray(probe.namespaces));
  const observedNamespaces = probe.namespaces as Record<string, unknown>;
  assert.equal(Object.keys(observedNamespaces).sort().join(","), "mnt,pid,user");
  for (const kind of ["user", "mnt", "pid"] as const) {
    assert(typeof observedNamespaces[kind] === "string" && new RegExp(`^${kind}:\\[\\d+\\]$`).test(observedNamespaces[kind]));
    assert.notEqual(observedNamespaces[kind], namespaces[kind]);
  }
  assert.deepEqual(probe, { schemaVersion: 1, result: "actual_readonly_mount_and_bus_denial_passed", ids: { uid: 65532, euid: 65532, gid: 65532, egid: 65532 },
    uidMap: probe.uidMap, gidMap: probe.gidMap, namespaces: observedNamespaces, noNewPrivs: 1, capabilities: "zero" });
  assert.equal(digest(readFileSync(inputPath)), digest(input)); assert.equal(command("/usr/bin/git", ["rev-parse", "HEAD"], 30000, workspace).trim(), gitBefore);
  (evidence.results as unknown[]).push({ scenario: "separate_readonly_custody_real_cli_provider_and_drain", result: "passed", probe,
    outer: terminal.outerRuntime, provider: terminal.reservations[0], projectionSha256: digest(JSON.stringify(projection)), inputSha256: digest(input),
    output: { unit: foreground.unit, exitCode: retrieved.foregroundOutput.exitCode, artifacts: foreground.artifacts, retrievedStdoutBytes: Buffer.byteLength(retrieved.foregroundOutput.stdout),
      retrievedStderrBytes: Buffer.byteLength(retrieved.foregroundOutput.stderr) } });
  evidence.kernelGatePhase = "readonly_next_generation_recovery";
  // These are the existing product transitions. Each must prove real terminal
  // units and preserved custody; no epoch or generation is written by TEST.
  operator("leave-exclusive"); operator("finish-closed"); operator("enter-exclusive");
  operator("recover", jobId); operator("finish-exclusive");
  const recovered = host.readEpoch(); assert.equal(recovered.phase, HostedCustodyPhase.Ready);
  assert(recovered.generation > terminal.generation && recovered.identity.jobId === jobId);
  const priorOutput = lstatSync(resultPath), priorSha256 = fileDigest(resultPath);
  const priorProbeSha256 = fileDigest(probePath);
  evidence.kernelGatePhase = "readonly_historical_output_before_next_frame";
  const next = runHostedRuntimeForeground(node, args, workspace, { ...cleanEnv, SUBSCRIPTION_RUNTIME_SANDBOX_KIND: "hosted-codex-job" });
  void next.catch(() => {});
  let historical: Awaited<ReturnType<typeof readCodexGoalResultSummary>> | undefined, historicalFailure: unknown;
  let nextStartId: string | undefined;
  try {
    const reserved = host.readEpoch(); assert(reserved.outerRuntime);
    assert.equal(reserved.outerRuntime.state, HostedCustodyReservationState.Reserved);
    assert.notEqual(reserved.outerRuntime.startId, terminal.outerRuntime.startId);
    assert(reserved.generation > terminal.generation); nextStartId = reserved.outerRuntime.startId;
    assert.equal(fileDigest(resultPath), priorSha256);
    const current = lstatSync(resultPath); assert(current.dev === priorOutput.dev && current.ino === priorOutput.ino);
    assert(!existsSync(workspace + "/TEST-readonly-failed-probe.json"));
    // Both public reader and real reservation creation execute synchronously
    // before the promise continuation can release the next observed FD frame.
    // The same actual runtime remains retained and is awaited even on failure.
    const selected = readCodexGoalResultSummary(resultPath);
    historical = await selected;
    assert(historical.foregroundOutput);
    assert.equal(historical.status, retrieved.status);
    assert.equal(historical.foregroundOutput.unit, retrieved.foregroundOutput.unit);
    assert.equal(historical.foregroundOutput.exitCode, 0);
    assert.equal(digest(historical.foregroundOutput.stdout), digest(retrieved.foregroundOutput.stdout));
    assert.equal(digest(historical.foregroundOutput.stderr), digest(retrieved.foregroundOutput.stderr));
  } catch (error) { historicalFailure = error; }
  evidence.kernelGatePhase = "readonly_real_nonzero_cli_and_output_drain";
  let failedForeground: Awaited<ReturnType<typeof runHostedRuntimeForeground>>;
  try { failedForeground = await boundedWait(next, 6 * 60000); }
  catch (error) {
    try { host.stopRuntime(enrolled.identity); } catch { /* Real retained uncertainty is not completion. */ }
    try { await boundedWait(next, 15000); } catch { /* Exact owned OS cleanup remains mandatory. */ }
    throw error;
  }
  if (historicalFailure) throw historicalFailure;
  assert(historical?.foregroundOutput && nextStartId);
  assert.equal(hostedForegroundExitCode(failedForeground), 1, "TEST terminal goal failure must preserve its actual CLI exit");
  assert(typeof failedForeground !== "number", "TEST nonzero foreground lost authenticated output refs");
  const failedSummary = await readCodexGoalResultSummary(resultPath); assert(failedSummary.foregroundOutput);
  assert(["failed", "partial"].includes(failedSummary.status ?? ""));
  assert.equal(failedSummary.foregroundOutput.unit, failedForeground.unit);
  assert.equal(failedSummary.foregroundOutput.exitCode, 1);
  assert(Buffer.byteLength(failedSummary.foregroundOutput.stdout) + Buffer.byteLength(failedSummary.foregroundOutput.stderr) > 0);
  const status = await collectCodexGoalStatus({ taskId: jobId, jobRootDir: root, resultPath });
  assert.equal(status.resultStatus, failedSummary.status); assert(status.foregroundOutput);
  assert.equal(status.progressAttemptCount, 1, "TEST terminal failure must not cause another attempt");
  assert.equal(status.foregroundOutput.unit, failedForeground.unit); assert.equal(status.foregroundOutput.exitCode, 1);
  assert.equal(digest(status.foregroundOutput.stdout), digest(failedSummary.foregroundOutput.stdout));
  assert.equal(digest(status.foregroundOutput.stderr), digest(failedSummary.foregroundOutput.stderr));
  assert.equal(failedForeground.artifacts.length, 2);
  for (const [kind, suffix, bytes] of [[HostedForegroundArtifactKind.Stdout, "stdout", failedSummary.foregroundOutput.stdout],
    [HostedForegroundArtifactKind.Stderr, "stderr", failedSummary.foregroundOutput.stderr]] as const) {
    const refs: HostedForegroundResult["artifacts"] = failedForeground.artifacts.filter(ref => ref.kind === kind); assert.equal(refs.length, 1);
    const ref = refs[0]!; assert.equal(ref.path, policy + "/foreground-output/" + failedForeground.unit + "." + suffix);
    const stat = lstatSync(ref.path); assert(stat.isFile() && !stat.isSymbolicLink() && stat.uid === 0 && stat.nlink === 1 && (stat.mode & 0o777) === 0o600);
    assert.equal(String(stat.dev), ref.dev); assert.equal(String(stat.ino), ref.ino);
    assert.equal(stat.size, ref.byteLength); assert.equal(Buffer.byteLength(bytes), ref.byteLength); assert.equal(digest(bytes), ref.sha256);
  }
  const final = host.readEpoch(); assert(final.outerRuntime && final.outerRuntime.startId === nextStartId);
  assert.equal(final.outerRuntime.state, HostedCustodyReservationState.Reserved);
  assert.equal(final.phase, HostedCustodyPhase.Closed);
  assert.equal(readHostedPrivateBytes(completionPath(final.outerRuntime), 4096), null, "TEST failure acquired a success receipt");
  const failedProbePath = workspace + "/TEST-readonly-failed-probe.json", failedProbeStat = lstatSync(failedProbePath);
  assert(failedProbeStat.isFile() && !failedProbeStat.isSymbolicLink() && failedProbeStat.uid === 0 && failedProbeStat.nlink === 1 && failedProbeStat.size < 4096);
  const failedProbe = JSON.parse(readFileSync(failedProbePath, "utf8")) as Record<string, unknown>;
  assert(failedProbe.namespaces && typeof failedProbe.namespaces === "object" && !Array.isArray(failedProbe.namespaces));
  const failedNamespaces = failedProbe.namespaces as Record<string, unknown>;
  assert.equal(Object.keys(failedNamespaces).sort().join(","), "mnt,pid,user");
  for (const kind of ["user", "mnt", "pid"] as const) {
    assert(typeof failedNamespaces[kind] === "string" && new RegExp(`^${kind}:\\[\\d+\\]$`).test(failedNamespaces[kind]));
    assert.notEqual(failedNamespaces[kind], namespaces[kind]);
  }
  assert.deepEqual(failedProbe, { ...probe, namespaces: failedNamespaces });
  assert.equal(fileDigest(probePath), priorProbeSha256);
  const newOutput = lstatSync(resultPath); assert(newOutput.dev !== priorOutput.dev || newOutput.ino !== priorOutput.ino);
  assert.equal(digest(readFileSync(inputPath)), digest(input));
  assert.equal(command("/usr/bin/git", ["rev-parse", "HEAD"], 30000, workspace).trim(), gitBefore);
  (evidence.results as unknown[]).push({ scenario: "readonly_canonical_history_after_actual_next_outer", result: "passed",
    oldUnit: historical.foregroundOutput.unit, exitCode: historical.foregroundOutput.exitCode, nextStartId, priorSha256,
    priorDev: String(priorOutput.dev), priorIno: String(priorOutput.ino) },
  { scenario: "readonly_real_nonzero_cli_status_and_drain", result: "passed", exitCode: 1, status: failedSummary.status,
    outer: final.outerRuntime, attemptCount: status.progressAttemptCount, successCompletionPresent: false, probe: failedProbe,
    output: { unit: failedForeground.unit, artifacts: failedForeground.artifacts,
      retrievedStdoutBytes: Buffer.byteLength(failedSummary.foregroundOutput.stdout),
      retrievedStderrBytes: Buffer.byteLength(failedSummary.foregroundOutput.stderr) } });
  evidence.pendingNativeCases = ["direct_daemon_socket_sent_byte_capture", "noop_and_stale_same_inode_result", "unauthorized_destination_no_preread"];
}

async function qualifyLateRelease(commandPath: string, args: readonly string[], workspace: string, env: Record<string, string>) {
  const store = new HostedInstallationActivationStore();
  const previousStarts = new Set(readHostedInstallationActivation().activation.ordinaryStarts.map(row => row.startId));
  const previousProbes = readdirSync(workspace).filter(name => /^TEST-provider-probe-[123]\.json$/.test(name)).sort();
  const child = store.runOrdinaryRuntimeLaunch(commandPath, args, workspace, launch =>
    spawnHostedFdChild(launch.command, launch.args, { cwd: workspace }, hostedFdInvocationUnit(launch.args), HostedFdLaunchKind.Foreground));
  const closed = once(child, "close"), guard = hostedFdLaunch(child);
  child.stdin?.on("error", () => {});
  let pausedMs = 0, requestedMs = 0, denied = false;
  try {
    await guard.observe(); // Actual peer/unit/birth proof outside the fence.
    try {
      store.releaseOrdinaryRuntimeFrame((fence, revalidateOwner) => {
        guard.release(fence, Buffer.from(JSON.stringify({ schemaVersion: 1, env })), true, () => {
          revalidateOwner();
          requestedMs = guard.remainingSetupMs() + 5;
          assert(requestedMs <= 60005);
          const began = process.hrtime.bigint();
          // Real monotonic time expires while the same synchronous fence is
          // held. No fake clock, thenable or fabricated authority is supplied.
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, requestedMs);
          pausedMs = Number(process.hrtime.bigint() - began) / 1_000_000;
        });
      });
    } catch (error) { assert(error instanceof Error && error.message === "hosted_fd_boundary_unresolved"); denied = true; }
    assert(requestedMs > 0 && pausedMs >= requestedMs - 1, "TEST final-release clock boundary was not exercised");
    assert(denied, "TEST expired frame crossed actual final release");
  } finally {
    // Cleanup is the existing exact owned reservation path, never a completion
    // claim or blanket manager/process operation. Uncertainty remains retained.
    guard.invalidate();
    assert(store.requestOrdinaryDependencyCleanup());
    const [code, signal] = await boundedWait(closed, 15000);
    assert(code !== 0 || signal !== null, "TEST pre-payload deadline launch unexpectedly completed successfully");
  }
  assert.deepEqual(readdirSync(workspace).filter(name => /^TEST-provider-probe-[123]\.json$/.test(name)).sort(), previousProbes);
  const current = readHostedInstallationActivation(), added = current.activation.ordinaryStarts.filter(row => !previousStarts.has(row.startId));
  assert.equal(added.length, 1); const row = added[0]!;
  assert.equal(row.state, HostedCustodyReservationState.Reserved);
  assert.equal(readHostedPrivateBytes(policy + "/ordinary-completed/" + row.startId + ".json", 4096), null);
  const stdout = guard.outputPaths[0]; assert(stdout); assert.equal(stdout, policy + "/foreground-output/" + row.unit + ".stdout");
  const stat = lstatSync(stdout); assert(stat.isFile() && stat.uid === 0 && stat.nlink === 1 && !(stat.mode & 0o077));
  assert.equal(stat.size, 0, "TEST late release forwarded payload bytes");
  return { scenario: "actual_final_release_deadline", outcome: "denied_before_enqueue_and_payload",
    requestedMs, pausedMs, startId: row.startId, unit: row.unit, reservationState: row.state,
    completionPresent: false, stdoutBytes: stat.size };
}

/** Native trusted TEST issuance, before any managed start exists. Parsed profile
 * bytes alone never qualify a binary: live retained endpoints and observations
 * below must succeed before create-only publication. Real routes reprove peers. */
async function issueNativeFdProfile(evidence: Record<string, unknown>): Promise<{ path: typeof fdCollectorProfilePath; sha256: string }> {
  const observerStatus = boundedProc("/proc/self/status", 16384);
  const capabilitySets = Object.fromEntries(["Inh", "Prm", "Eff", "Bnd", "Amb"].map(name => {
    const value = new RegExp(`^Cap${name}:\\s+([a-f0-9]{1,16})$`, "m").exec(observerStatus)?.[1]; assert(value);
    assert(BigInt("0x" + value) <= (1n << 41n) - 1n); return [name, value];
  })) as Record<string, string>;
  assert(BigInt("0x" + capabilitySets.Eff!) & (1n << 19n), "TEST root observer requires actual cross-UID ptrace access");
  assert.equal(BigInt("0x" + capabilitySets.Amb!), 0n);
  let lsm: string | undefined;
  try { const value = boundedProc("/proc/self/attr/current", 4096).trim();
    lsm = value === "unconfined" ? "unconfined" : "other_" + digest(value); }
  catch (error) { assert(["ENOENT", "EINVAL"].includes((error as NodeJS.ErrnoException).code ?? "")); }
  evidence.rootFdObserver = { uid: process.getuid!(), gid: process.getgid!(), capabilitySets, lsm: lsm ?? "unavailable",
    namespaces: { user: readlinkSync("/proc/self/ns/user"), pid: readlinkSync("/proc/self/ns/pid"), mount: readlinkSync("/proc/self/ns/mnt") },
    scope: "trusted root observer in private owned TEST OS proc; no runner proc or consumer privilege" };
  const qualificationBegan = performance.now();
  const signedBytes = boundedProc(runtime + "/os-signed-elf-pins.json", 256 * 1024);
  const signedValue = JSON.parse(signedBytes) as { schemaVersion: number; pins: FdFilePin[] };
  assert.equal(signedValue.schemaVersion, 1); assert(Array.isArray(signedValue.pins) && signedValue.pins.length <= 1024);
  const signed = new Map(signedValue.pins.map(pin => [pin.path, pin.sha256])); assert.equal(signed.size, signedValue.pins.length);
  const packageFacts = JSON.parse(boundedProc(runtime + "/os-packages.json", 256 * 1024)) as {
    packages: { package: string; version: string; arch: string; sha256: string }[]; pinnedNode: { sha256: string } };
  const ssPackages = packageFacts.packages.filter(row => row.package === "iproute2");
  assert.equal(ssPackages.length, 1); assert.equal(ssPackages[0]!.version, "6.1.0-1ubuntu6.4");
  assert.equal(ssPackages[0]!.arch, "amd64"); assert.match(ssPackages[0]!.sha256, /^[a-f0-9]{64}$/);
  evidence.fdCandidateNode = { bytes: lstatSync(node).size, version: process.version, artifactSha256: packageFacts.pinnedNode.sha256 };
  const pin = (path: string): FdFilePin => {
    assert.equal(realpathSync(path), path);
    for (let parent = dirname(path);; parent = dirname(parent)) {
      const stat = lstatSync(parent); assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === 0 && !(stat.mode & 0o022));
      if (parent === "/") break;
    }
    const before = lstatSync(path); assert(before.isFile() && before.uid === 0 && before.nlink === 1 &&
      !(before.mode & 0o022) && before.size > 0 && before.size <= 256 * 1024 * 1024);
    const sha256 = fileDigest(path), after = lstatSync(path);
    assert(before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
      before.ctimeMs === after.ctimeMs && before.mtimeMs === after.mtimeMs);
    return { path, sha256 };
  };
  const executable = (path: string): FdExecutablePin => {
    const first = pin(path);
    assert.equal(first.sha256, path === node ? packageFacts.pinnedNode.sha256 : signed.get(path));
    // Hash/immutable ancestry before invoking the trusted OS linkage tool.
    const libraries = actualLibraries(path).map(row => {
      const current = pin(row.path); assert.equal(current.sha256, signed.get(row.path)); return current;
    });
    assert.equal(pin(path).sha256, first.sha256);
    return { ...first, elfFiles: [first, ...libraries] };
  };
  const ss = executable("/usr/bin/ss"), nodePin = executable(node);
  const wrappers = ["/usr/bin/setpriv", "/usr/bin/systemd-run", "/usr/bin/tini", "/usr/bin/unshare"].map(executable);
  assert.equal(command(ss.path, ["--version"]).trim(), "ss utility, iproute2-6.1.0");
  const bootstraps = ["provider-codex/app-server/adapters/hosted-app-server-launcher.js",
    "worker-codex/hosted-dependency-installer-bootstrap.js", "worker-codex/hosted-readonly-host-launch-cli.js",
    "worker-codex/hosted-readonly-runtime-bootstrap.js", "worker-codex/hosted-readonly-foreground.js"]
    .map(path => pin(runtime + "/dist/" + path));
  if (process.env.TEST_OS_SCENARIO === OwnedOsScenario.Readonly) {
    for (const path of ["managed-launcher/launch.mjs", "managed-launcher/payload-guard.mjs", "managed-launcher/profiles.mjs", "host-jobs/storage-policy.mjs"])
      bootstraps.push(pin("/opt/subscription-runtime/" + path));
  }
  const measured = { setupMs: 0, collectorMs: 0, outputBytes: 0, rows: 0, eventPoll: 0, eventFd: 0, pipes: 0, devNull: 0 };
  const query = (): ReadonlyMap<string, string> => {
    const began = performance.now();
    const result = spawnSync(ss.path, ["-H", "-n", "-A", "unix_stream", "state", "established", "src", "unix:"],
      { env: cleanEnv, encoding: "utf8", timeout: 5000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    assert(!result.error && result.signal === null && result.status === 0 && result.stderr === "");
    const rows = parseFdCollectorRows(result.stdout, 65536);
    measured.collectorMs = Math.max(measured.collectorMs, Math.ceil(performance.now() - began));
    measured.outputBytes = Math.max(measured.outputBytes, Buffer.byteLength(result.stdout)); measured.rows = Math.max(measured.rows, rows.size);
    assert.equal(pin(ss.path).sha256, ss.sha256); return rows;
  };
  const sock = (target: string): string => {
    const match = /^socket:\[([1-9][0-9]*)\]$/.exec(target); assert(match && BigInt(match[1]!) <= 4294967295n); return match[1]!;
  };
  const observations: unknown[] = [], snapshots: ReturnType<typeof observeHostedFdProcess>[] = [];
  for (const uid of [0, 65532]) {
    const began = performance.now(), before = new Set(hostedFdTable(process.pid).filter(row => row.socket).map(row => sock(row.target)));
    const args = ["--experimental-strip-types", runtime + "/scripts/dependency-retention-os-test/common.ts", "fd-qualification"];
    const child = uid === 0 ? spawn(node, args, { env: cleanEnv, stdio: ["pipe", "pipe", "pipe"] }) :
      spawn("/usr/bin/setpriv", ["--reuid=65532", "--regid=65532", "--clear-groups", "--inh-caps=-all", "--ambient-caps=-all",
        "--bounding-set=-all", "--no-new-privs", node, ...args], { env: cleanEnv, stdio: ["pipe", "pipe", "pipe"] });
    const exited = once(child, "close"); let birth: string | undefined;
    child.stdin.on("error", () => {}); child.stderr.resume();
    try {
      await boundedWait(new Promise<void>((resolve, reject) => {
        let ready = "";
        child.stdout.on("data", (chunk: Buffer) => { ready += chunk.toString("ascii");
          if (ready.length > 64 || !"TEST_fd_waiting\n".startsWith(ready)) reject(new Error("TEST fd waiting marker invalid"));
          else if (ready === "TEST_fd_waiting\n") resolve(); });
        child.once("error", reject); child.once("exit", () => reject(new Error("TEST fd child exited before observation")));
      }), 10000);
      assert(child.pid); const actual = observeHostedFdProcess(child.pid); birth = actual.birth;
      const status = boundedProc("/proc/" + child.pid + "/status", 16384);
      assert.match(status, new RegExp(`^Uid:\\s+${uid}\\s+${uid}\\s+${uid}\\s+${uid}$`, "m"));
      assert.match(status, new RegExp(`^Gid:\\s+${uid}\\s+${uid}\\s+${uid}\\s+${uid}$`, "m"));
      if (uid === 65532) {
        for (const kind of ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"]) assert.match(status, new RegExp(`^${kind}:\\s+0+$`, "m"));
        assert.match(status, /^NoNewPrivs:\s+1$/m);
        assert.match(status, /^Groups:\s*$/m);
      } else {
        for (const [set, value] of Object.entries(capabilitySets)) assert.match(status, new RegExp(`^Cap${set}:\\s+${value}$`, "m"));
      }
      const namespaces = { user: readlinkSync(`/proc/${child.pid}/ns/user`), mnt: readlinkSync(`/proc/${child.pid}/ns/mnt`),
        pid: readlinkSync(`/proc/${child.pid}/ns/pid`), net: actual.net };
      for (const kind of ["user", "mnt", "pid", "net"] as const) assert.equal(namespaces[kind], readlinkSync("/proc/self/ns/" + kind));
      assert.equal(actual.exe, node); assert.equal(actual.net, readlinkSync("/proc/self/ns/net"));
      assert.equal(actual.group, boundedProc("/proc/self/cgroup", 4096).trim());
      const peerRows = query(), parent = hostedFdTable(process.pid), pairs: { fd: number; parent: string; child: string }[] = [];
      for (const fd of [0, 1, 2]) {
        const target = actual.descriptors.find(row => row.fd === fd); assert(target?.socket);
        const remote = sock(target.target), local = peerRows.get(remote); assert(local && !before.has(local));
        assert.equal(peerRows.get(local), remote);
        assert.equal(parent.filter(row => row.socket && sock(row.target) === local).length, 1); pairs.push({ fd, parent: local, child: remote });
      }
      assert.equal(new Set(pairs.flatMap(row => [row.parent, row.child])).size, 6);
      const count = (test: (target: string, character: boolean, pipe: boolean) => boolean) => actual.descriptors.filter(row => row.fd > 2 && test(row.target, row.character, row.pipe)).length;
      measured.eventPoll = Math.max(measured.eventPoll, count(target => target === "anon_inode:[eventpoll]"));
      measured.eventFd = Math.max(measured.eventFd, count(target => target === "anon_inode:[eventfd]"));
      measured.pipes = Math.max(measured.pipes, count((_target, _char, pipe) => pipe));
      measured.devNull = Math.max(measured.devNull, count((_target, character) => character));
      measured.setupMs = Math.max(measured.setupMs, Math.ceil(performance.now() - began));
      const next = observeHostedFdProcess(child.pid); assert.equal(next.birth, birth);
      assert.deepEqual(next.descriptors, actual.descriptors);
      const nextRows = query(); for (const pair of pairs) { assert.equal(nextRows.get(pair.parent), pair.child); assert.equal(nextRows.get(pair.child), pair.parent); }
      observations.push({ uid, pid: child.pid, birth, namespaces, group: actual.group, pairs,
        droppedCapabilitiesAndNoNewPrivsObserved: uid === 65532,
        descriptors: actual.descriptors.map(row => ({ fd: row.fd, target: row.target, flags: row.flags, rdev: row.rdev })) });
      snapshots.push(actual);
      await qualifyNamedSockets(query, pairs[0]!.parent, pairs[0]!.child, sock);
    } finally {
      child.stdin.end();
      try { const [code, signal] = await boundedWait(exited, 2000); assert.equal(code, 0); assert.equal(signal, null); }
      catch (error) {
        // Exact retained child only. Unobservable identity stays unresolved and
        // the outer owned service performs its normal final cleanup.
        if (child.pid && birth && child.exitCode === null && observeHostedFdProcess(child.pid).birth === birth) child.kill("SIGTERM");
        throw error;
      }
    }
  }
  // Include actual immutable toolchain discovery and both native observations,
  // rather than projecting a complete manager setup from one cheap Node spawn.
  measured.setupMs = Math.max(measured.setupMs, Math.ceil(performance.now() - qualificationBegan));
  const headroom = (value: number, maximum: number, floor = 1): number => {
    assert(value <= maximum && floor <= maximum, "TEST measured fd profile exceeds closed bounds");
    return Math.min(maximum, Math.max(floor, value * 4 + 2));
  };
  const collectorTimeoutMs = headroom(measured.collectorMs, 5000, 250);
  const profile = parseFdCollectorProfile({ schemaVersion: 1, renderer: FdCollectorRenderer.SsV61Signed, ss, node: nodePin, wrappers, bootstraps,
    limits: { setupTimeoutMs: Math.max(collectorTimeoutMs, headroom(measured.setupMs, 60000, 1000)), collectorTimeoutMs,
      maxOutputBytes: headroom(measured.outputBytes, 4 * 1024 * 1024, 4096), maxRows: headroom(measured.rows, 65536, 16),
      maxBufferedInputBytes: headroom(Buffer.byteLength(JSON.stringify({ schemaVersion: 1, env: cleanEnv })), 4 * 1024 * 1024, 4096),
      maxEventPoll: headroom(measured.eventPoll, 8), maxEventFd: headroom(measured.eventFd, 8),
      maxPipeEndpoints: headroom(measured.pipes, 32), maxDevNullReserves: headroom(measured.devNull, 8) } });
  for (const snapshot of snapshots) {
    // Positive classification uses the real production contract, not a copied
    // fixture decision. Processes have drained, so retain their actual snapshots.
    assertHostedFdInternals(snapshot, profile);
  }
  const extraDescriptorDenial = await qualifyExtraSocketDenial(profile);
  const directBusDescriptorDenial = await qualifyExtraSocketDenial(profile, SYSTEM_BUS_ENDPOINT);
  for (const executable of [ss, nodePin, ...wrappers]) for (const file of executable.elfFiles) assert.equal(pin(file.path).sha256, file.sha256);
  assert(!existsSync(fdCollectorProfilePath)); json(fdCollectorProfilePath, profile);
  const profilePin = { path: fdCollectorProfilePath, sha256: fileDigest(fdCollectorProfilePath) };
  evidence.fdCollectorQualification = { package: ssPackages[0], profilePin, profile, measured, observations, extraDescriptorDenial, directBusDescriptorDenial,
    observer: { net: readlinkSync("/proc/self/ns/net"), user: readlinkSync("/proc/self/ns/user"),
      effectiveCapabilities: /^CapEff:\s+([a-f0-9]+)$/m.exec(boundedProc("/proc/self/status", 16384))?.[1] },
    scope: "actual retained native pairs and cross UID proc access; each production route must reprove before payload" };
  return profilePin;
}

async function qualifyExtraSocketDenial(profile: FdCollectorProfile, directEndpoint?: typeof SYSTEM_BUS_ENDPOINT) {
  const socketPath = "/run/TEST-fd-extra-" + randomUUID(), server = createServer();
  let client: Socket | undefined, accepted: Socket | undefined;
  try {
    if (directEndpoint) {
      const stat = lstatSync(directEndpoint); assert(stat.isSocket() && stat.uid === 0 && (stat.mode & 0o777) === 0o600);
      client = createConnection(directEndpoint); client.on("error", () => {}); client.on("data", () => {});
    } else {
      server.listen(socketPath); await boundedWait(once(server, "listening"), 2000);
      const connection = once(server, "connection"); client = createConnection(socketPath);
      const [socket] = await boundedWait(connection, 2000); accepted = socket as Socket;
    }
    await boundedWait(client.readyState === "open" ? Promise.resolve() : once(client, "connect").then(() => {}), 2000);
    const child = spawn("/usr/bin/setpriv", ["--reuid=65532", "--regid=65532", "--clear-groups", "--inh-caps=-all", "--ambient-caps=-all",
      "--bounding-set=-all", "--no-new-privs", node, "--experimental-strip-types", runtime + "/scripts/dependency-retention-os-test/common.ts", "fd-qualification"],
      { env: cleanEnv, stdio: ["pipe", "pipe", "pipe", client] });
    assert(child.stdin && child.stdout && child.stderr);
    const exited = once(child, "close"); let output = "", birth: string | undefined;
    child.stdin.on("error", () => {}); child.stderr.resume();
    child.stdout.on("data", (bytes: Buffer) => { output += bytes.toString("ascii"); assert(output.length <= 128); });
    try {
      await boundedWait(new Promise<void>((resolve, reject) => {
        child.stdout!.on("data", () => { if (output === "TEST_fd_waiting\n") resolve(); });
        child.once("error", reject); child.once("exit", () => reject(new Error("TEST extra fd child exited")));
      }), 10000);
      assert(child.pid); const actual = observeHostedFdProcess(child.pid); birth = actual.birth;
      assert.match(boundedProc("/proc/" + child.pid + "/status", 16384), /^Uid:\s+65532\s+65532\s+65532\s+65532$/m);
      const inherited = actual.descriptors.find(fd => fd.fd === 3); assert(inherited?.socket);
      assert.equal(inherited.flags & 0o2000000, 0, "TEST must actually clear inherited CLOEXEC");
      let denied = false;
      try { assertHostedFdInternals(actual, profile); }
      catch (error) { assert(error instanceof Error && error.message === "hosted_fd_boundary_unresolved"); denied = true; }
      // If the boundary regresses, the real waiting child gets data and executes
      // its bounded TEST marker. No mock descriptor or fake permit is involved.
      if (!denied) child.stdin.write("TEST_fd_release\n");
      child.stdin.end(); const [code, signal] = await boundedWait(exited, 2000);
      assert.equal(code, 0); assert.equal(signal, null); assert(denied, "TEST inherited socket reached payload release");
      assert.equal(output, "TEST_fd_waiting\n", "TEST extra descriptor denial failed before payload");
      return { uid: 65532, pid: child.pid, birth, fd: 3, target: inherited.target, flags: inherited.flags,
        endpoint: directEndpoint ?? socketPath, outcome: "production_internal_boundary_denied_before_TEST_payload",
        limitation: directEndpoint ? "actual direct guest daemon FD3 denial; no daemon sent-byte trace or managed-positive claim" : "plain waiting TEST internal-boundary denial" };
    } finally {
      child.stdin.end();
      if (child.pid && birth && child.exitCode === null && observeHostedFdProcess(child.pid).birth === birth) child.kill("SIGTERM");
      if (child.exitCode === null) await boundedWait(exited, 2000);
    }
  } finally {
    client?.destroy(); accepted?.destroy();
    if (server.listening) await boundedWait(new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())), 2000);
  }
}

async function boundedWait<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("TEST owned fd observation deadline")), milliseconds);
  })]); } finally { clearTimeout(timer); }
}

async function qualifyNamedSockets(query: () => ReadonlyMap<string, string>, local: string, peer: string, sock: (target: string) => string): Promise<void> {
  const directoryPath = "/run/TEST-fd-" + randomUUID(); directory(directoryPath);
  for (const name of [directoryPath + "/named\n0 0 * " + local + " * " + peer,
    "\0TEST-fd-" + randomUUID() + "\n0 0 * " + local + " * " + peer, directoryPath + "/*"]) {
    const server = createServer(); let accepted: Socket | undefined, client: Socket | undefined;
    try {
      server.listen(name); await boundedWait(once(server, "listening"), 2000);
      const previous = new Set(hostedFdTable(process.pid).filter(row => row.socket).map(row => sock(row.target)));
      const connection = once(server, "connection"); client = createConnection(name);
      const [socket] = await boundedWait(connection, 2000); accepted = socket as Socket;
      await boundedWait(client.readyState === "open" ? Promise.resolve() : once(client, "connect").then(() => {}), 2000);
      const created = hostedFdTable(process.pid).filter(row => row.socket && !previous.has(sock(row.target))).map(row => sock(row.target));
      assert.equal(created.length, 2);
      const rows = query(); assert.equal(rows.get(local), peer); assert.equal(rows.get(peer), local);
      assert(created.some(inode => !rows.has(inode)), "TEST named local socket bypassed empty-address filter");
      assert(!created.some(inode => rows.get(rows.get(inode) ?? "") === inode), "TEST named peer gained reciprocal authority");
    } finally {
      client?.destroy(); accepted?.destroy();
      if (server.listening) await boundedWait(new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())), 2000);
    }
  }
}

async function issueActualSystemBusInfrastructure(evidence: Record<string, unknown>): Promise<SystemBusInfrastructure> {
  const pinPath = runtime + "/os-signed-elf-pins.json", beforePins = lstatSync(pinPath);
  assert(beforePins.isFile() && !beforePins.isSymbolicLink() && beforePins.uid === 0 && beforePins.nlink === 1 && (beforePins.mode & 0o777) === 0o600);
  const pinBytes = Buffer.from(boundedProc(pinPath, 256 * 1024));
  const afterPins = lstatSync(pinPath);
  assert(beforePins.dev === afterPins.dev && beforePins.ino === afterPins.ino && beforePins.size === afterPins.size &&
    beforePins.ctimeMs === afterPins.ctimeMs && beforePins.mtimeMs === afterPins.mtimeMs && pinBytes.length === beforePins.size);
  const extraction = JSON.parse(pinBytes.toString("utf8")) as { schemaVersion: number; pins: SystemBusFilePin[] };
  assert.equal(extraction.schemaVersion, 1); assert(Array.isArray(extraction.pins) && extraction.pins.length <= 1024);
  const signed = new Map(extraction.pins.map(pin => {
    assert(([SYSTEM_BUS_EXECUTABLE, "/usr/bin/ss", "/usr/bin/setpriv", "/usr/bin/systemd-run", "/usr/bin/tini", "/usr/bin/unshare", "/usr/bin/systemctl"].includes(pin.path) || pin.path.startsWith("/usr/lib/")) && /^[a-f0-9]{64}$/.test(pin.sha256));
    return [pin.path, pin.sha256] as const;
  }));
  assert.equal(signed.size, extraction.pins.length);
  const deadline = Date.now() + 20000; let registered = false;
  // PID1 must own the actual manager name on the genuine socket-activated bus.
  // Bounded reads can retry name registration; no launch or state is retried.
  while (Date.now() < deadline) {
    const read = spawnSync("/usr/bin/busctl", ["--system", "call", "org.freedesktop.DBus", "/org/freedesktop/DBus",
      "org.freedesktop.DBus", "GetConnectionUnixProcessID", "s", "org.freedesktop.systemd1"],
      { env: cleanEnv, encoding: "utf8", timeout: 2000, maxBuffer: 4096, stdio: ["ignore", "pipe", "pipe"] });
    if (!read.error && read.status === 0 && read.stdout.trim() === "u 1") { registered = true; break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(registered, "TEST genuine PID1 system bus registration unavailable");
  const pid = command("/usr/bin/systemctl", ["show", "--property=MainPID", "--value", "--", "dbus.service"]).trim();
  assert(/^[1-9][0-9]{0,9}$/.test(pid));
  const processBirth = () => {
    const stat = boundedProc("/proc/" + pid + "/stat", 4096), at = stat.lastIndexOf(") ");
    assert(stat.startsWith(pid + " (") && at > 0);
    const fields = stat.slice(at + 2).trim().split(/\s+/); assert.equal(fields[1], "1"); assert(/^[1-9][0-9]*$/.test(fields[19]!));
    return pid + ":" + fields[19];
  };
  const birth = processBirth(); assert.equal(readlinkSync("/proc/" + pid + "/exe"), SYSTEM_BUS_EXECUTABLE);
  assert.equal(boundedProc("/proc/" + pid + "/cgroup", 4096).trim(), "0::" + SYSTEM_BUS_CONTROL_GROUP);
  const mapped = new Set<string>();
  for (const line of boundedProc("/proc/" + pid + "/maps", 2 * 1024 * 1024).trim().split("\n")) {
    const row = /^[a-f0-9]+-[a-f0-9]+\s+[rwxps-]{4}\s+[a-f0-9]+\s+[a-f0-9]+:[a-f0-9]+\s+[0-9]+(?:\s+(.*))?$/.exec(line); assert(row);
    const path = row[1]; if (!path?.startsWith("/")) continue;
    assert(mapped.size < 64 || mapped.has(path)); assert.equal(realpathSync(path), path); assert(signed.has(path)); mapped.add(path);
  }
  const elfClosure = [...mapped].sort().map(path => {
    const stat = lstatSync(path); assert(stat.isFile() && !stat.isSymbolicLink() && stat.uid === 0 && stat.nlink === 1 && (stat.mode & 0o022) === 0 && stat.size <= 32 * 1024 * 1024);
    const sha256 = fileDigest(path); assert.equal(sha256, signed.get(path)); return { path, sha256 };
  });
  assert.equal(readFileSync(SYSTEM_BUS_CONFIG_PATH, "utf8"), SYSTEM_BUS_CONFIG);
  const serviceFragment = "/etc/systemd/test-units/dbus.service", socketFragment = "/etc/systemd/test-units/dbus.socket";
  assert.equal(readFileSync(serviceFragment, "utf8"), SYSTEM_BUS_SERVICE_FRAGMENT);
  assert.equal(readFileSync(socketFragment, "utf8"), SYSTEM_BUS_SOCKET_FRAGMENT);
  const descriptor = parseSystemBusInfrastructure({ version: 1, role: SystemBusInfrastructureRole.SystemBus,
    service: { name: "dbus.service", controlGroup: SYSTEM_BUS_CONTROL_GROUP, fragmentPath: serviceFragment, fragmentSha256: fileDigest(serviceFragment) },
    socket: { name: "dbus.socket", endpoint: SYSTEM_BUS_ENDPOINT, fragmentPath: socketFragment, fragmentSha256: fileDigest(socketFragment) },
    config: { path: SYSTEM_BUS_CONFIG_PATH, sha256: fileDigest(SYSTEM_BUS_CONFIG_PATH) },
    executable: { path: SYSTEM_BUS_EXECUTABLE, sha256: signed.get(SYSTEM_BUS_EXECUTABLE) }, elfClosure });
  const endpoint = lstatSync(SYSTEM_BUS_ENDPOINT); assert(endpoint.isSocket() && endpoint.uid === 0 && (endpoint.mode & 0o777) === 0o600);
  const socketInodes = (processId: string) => {
    const entries = readdirSync("/proc/" + processId + "/fd"); assert(entries.length <= 4096);
    const inodes = new Set<string>();
    for (const name of entries) { assert(/^[0-9]+$/.test(name));
      try { const match = /^socket:\[([1-9][0-9]*)\]$/.exec(readlinkSync("/proc/" + processId + "/fd/" + name));
        if (match) inodes.add(match[1]!); }
      catch (error) { assert.equal((error as NodeJS.ErrnoException).code, "ENOENT"); } }
    return inodes;
  };
  const managerInodes = socketInodes("1"), daemonInodes = socketInodes(pid);
  const listenerRows = boundedProc("/proc/net/unix", 2 * 1024 * 1024).trim().split("\n").slice(1).map(row => row.trim().split(/\s+/))
    .filter(row => /^[a-f0-9]{8}$/.test(row[3] ?? "") && (parseInt(row[3]!, 16) & 0x10000) !== 0 && daemonInodes.has(row[6]!));
  assert.equal(listenerRows.length, 1); const listenerRow = listenerRows[0]!, listener = listenerRow[6]!;
  assert.equal(listenerRow[7], SYSTEM_BUS_ENDPOINT); assert.equal(listenerRow[4], "0001");
  assert.equal(listenerRow[3], "00010000"); assert.equal(listenerRow[5], "01");
  assert(/^[1-9][0-9]*$/.test(listener) && managerInodes.has(listener));
  evidence.systemBus = { descriptor, daemonPidBirth: birth, endpoint: { dev: String(endpoint.dev), ino: String(endpoint.ino), uid: endpoint.uid,
    mode: endpoint.mode & 0o777, listenerInode: listener }, observedManagerPid: 1, extractionPinsSha256: digest(pinBytes) };
  // Execute the real production verifier before issuing any inventory. Its
  // return is not serialized as authority; every later gate verifies again.
  verifySystemBusInfrastructure(descriptor); assert.equal(processBirth(), birth);
  return descriptor;
}
function boundedProc(path: string, max: number): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { const buffer = Buffer.alloc(max + 1); let length = 0;
    while (length < buffer.length) { const count = readSync(fd, buffer, length, buffer.length - length, null); if (!count) break; length += count; }
    assert(length <= max); return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)); }
  finally { closeSync(fd); }
}

function observeOwnedCliFailure(jobId: string, root: string, workspace: string, status: number) {
  const observation: Record<string, unknown> = { purpose: "TEST_owned_cli_failure_only", status };
  const { installation, activation } = readHostedInstallationActivation();
  assert(activation.ordinaryStarts.length <= 32);
  const rows = activation.ordinaryStarts.flatMap(row => {
    assert(/^[a-f0-9-]{36}$/.test(row.startId));
    const bytes = readHostedPrivateBytes(policy + "/ordinary-starts/" + row.startId + ".json", 65536); assert(bytes);
    const start = parseHostedOrdinaryStart(JSON.parse(bytes.toString("utf8")));
    if (start.jobId !== jobId) return [];
    assert.equal(start.jobRootDir, root); assert.equal(start.workspacePath, workspace);
    assert.equal(start.unit, row.unit); assert.equal(start.creatorId, row.creatorId); assert.equal(start.activationGeneration, row.generation);
    assert.equal(start.installationId, installation.installationId); assert.equal(start.bootId, activation.bootId);
    assert.equal(start.supervisorId, activation.supervisorId); assert.equal(start.originSha256, row.originSha256);
    assert.equal(start.controlGroup, "/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/" + row.unit);
    assert([`subscription-runtime-ordinary-${row.startId}.service`, `subscription-runtime-hosted-${row.startId}.service`].includes(row.unit));
    const shown = spawnSync("/usr/bin/systemctl", ["show", "--property=LoadState,ActiveState,SubState,Result,ExecMainCode,ExecMainStatus", "--", row.unit],
      { env: cleanEnv, encoding: "utf8", timeout: 5000, maxBuffer: 16384, stdio: ["ignore", "pipe", "pipe"] });
    const fields: Record<string, string> = {};
    if (!shown.error && shown.status === 0) for (const line of shown.stdout.trim().split("\n")) {
      const [key, value, ...extra] = line.split("=");
      assert(key && value !== undefined && extra.length === 0 && /^[A-Za-z0-9_-]{0,80}$/.test(value));
      assert(["LoadState", "ActiveState", "SubState", "Result", "ExecMainCode", "ExecMainStatus"].includes(key)); fields[key] = value;
    }
    const journal = spawnSync("/usr/bin/journalctl", ["--unit", row.unit, "--no-pager", "--output=cat", "--lines=40"],
      { env: cleanEnv, encoding: "utf8", timeout: 5000, maxBuffer: 32768, stdio: ["ignore", "pipe", "pipe"] });
    const completion = readHostedPrivateBytes(policy + "/ordinary-completed/" + row.startId + ".json", 4096);
    const foregroundLogs = ["stdout", "stderr"].map((stream, slot) => {
      const path = policy + "/foreground-output/" + row.unit + "." + stream;
      try {
        const parent = lstatSync(dirname(path)); assert(parent.isDirectory() && !parent.isSymbolicLink() && parent.uid === 0 && !(parent.mode & 0o077));
        const before = lstatSync(path); assert(before.isFile() && !before.isSymbolicLink() && before.uid === 0 && before.nlink === 1 && !(before.mode & 0o077));
        const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const opened = fstatSync(fd); assert.equal(opened.dev, before.dev); assert.equal(opened.ino, before.ino);
          const tail = Buffer.alloc(Math.min(opened.size, 32768)); const count = readSync(fd, tail, 0, tail.length, Math.max(0, opened.size - tail.length));
          const current = lstatSync(path); assert.equal(current.dev, before.dev); assert.equal(current.ino, before.ino);
          return { slot, present: true, bytes: opened.size, dev: String(opened.dev), ino: String(opened.ino),
            diagnostic: runtimeDiagnostic(tail.subarray(0, count).toString("utf8")) };
        } finally { closeSync(fd); }
      } catch (error) { return { slot, present: false, unavailable: (error as NodeJS.ErrnoException).code !== "ENOENT" }; }
    });
    return [{ startId: row.startId, reservationState: row.state, startSha256: digest(bytes), completionPresent: completion !== null,
      completionSha256: completion ? digest(completion) : null, showStatus: shown.status, showFailed: !!shown.error, states: fields,
      journalStatus: journal.status, journalFailed: !!journal.error, journalDiagnostic: runtimeDiagnostic(journal.stdout ?? ""), foregroundLogs }];
  });
  observation.starts = rows;
  const files = [root + "/state/registry/" + jobId + "/job.json", root + "/" + jobId + ".latest-result.json", root + "/" + jobId + ".log"];
  observation.jobOutputs = files.map((path, index) => {
    try { const stat = lstatSync(path); assert(stat.isFile() && !stat.isSymbolicLink() && stat.uid === 0 && stat.nlink === 1);
      // No artifact/auth payload is copied or hashed. Inspect only bounded
      // exact TEST log/result bytes for fixed reason/source classifications.
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try { const buffer = Buffer.alloc(Math.min(stat.size, 32768)); const count = readSync(fd, buffer, 0, buffer.length, Math.max(0, stat.size - buffer.length));
        return { slot: index, present: true, bytes: stat.size, diagnostic: runtimeDiagnostic(buffer.subarray(0, count).toString("utf8")) }; }
      finally { closeSync(fd); }
    } catch (error) { return { slot: index, present: false, unavailable: (error as NodeJS.ErrnoException).code !== "ENOENT" }; }
  });
  return observation;
}

function failureLocations(error: Error) {
  // Fixed production source locations only, never raw stack paths or names.
  const files = ["hosted-readonly-host-kernel", "hosted-readonly-linux-collector", "hosted-readonly-observations",
    "hosted-readonly-inputs", "hosted-installation-activation", "hosted-test-egress-files", "system-bus-infrastructure"];
  return (error.stack ?? "").split("\n").slice(0, 16).flatMap(line => files.flatMap(file => {
    const match = new RegExp(`/(${file}\\.js):(\\d+):(\\d+)\\)?$`).exec(line.trim());
    return match ? [{ file: match[1], line: Number(match[2]), column: Number(match[3]) }] : [];
  }));
}
function observeKernelInventory(supervisor: string, expectedGroup: string) {
  // Read-only TEST diagnostics have no authority or effect on production gates.
  const observation: Record<string, unknown> = { purpose: "TEST_kernel_predicate_observation_only",
    selfGroupMatches: readFileSync("/proc/self/cgroup", "utf8").trim() === "0::" + expectedGroup };
  const observe = (args: string[], summarize: (rows: string[]) => unknown) => {
    const result = spawnSync("/usr/bin/systemctl", args, { env: cleanEnv, encoding: "utf8", timeout: 5000,
      maxBuffer: 256 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    return { status: result.status, signal: result.signal, failed: !!result.error,
      facts: result.status === 0 && !result.error ? summarize(result.stdout.split("\n").filter(line => line.trim())) : null };
  };
  observation.supervisor = observe(["show", "--property=Id,FragmentPath,DropInPaths,ControlGroup,MainPID", "--", supervisor], rows => {
    const fields = new Map(rows.map(row => { const at = row.indexOf("="); return [row.slice(0, at), row.slice(at + 1)]; }));
    return { exactFiveKeys: rows.length === 5 && [...fields.keys()].sort().join(",") === "ControlGroup,DropInPaths,FragmentPath,Id,MainPID",
      idMatches: fields.get("Id") === supervisor, groupMatches: fields.get("ControlGroup") === expectedGroup,
      fragmentMatches: fields.get("FragmentPath") === "/etc/systemd/test-units/" + supervisor,
      dropInsEmpty: fields.get("DropInPaths") === "", mainPidValid: /^[1-9]\d*$/.test(fields.get("MainPID") ?? "") };
  });
  const known = (name: string | undefined, allowInit: boolean) => name === supervisor || name === "dbus.service" ||
    (!allowInit && name === "dbus.socket") || (allowInit && name === "init.scope");
  const inventoryRows = (rows: string[], allowInit: boolean) => ({ count: rows.length,
    unknownCount: rows.filter(row => !known(row.trim().split(/\s+/)[0], allowInit)).length,
    unknownNameDigests: rows.flatMap(row => { const name = row.trim().split(/\s+/)[0]!;
      return !known(name, allowInit) ? [digest(name)] : []; }).slice(0, 32) });
  observation.activeUnits = observe(["list-units", "--all", "--type=service,scope", "--state=active,activating,reloading,deactivating,failed",
    "--no-legend", "--plain", "--no-pager"], rows => inventoryRows(rows, true));
  observation.futureUnits = observe(["list-unit-files", "--type=service,socket,timer", "--state=enabled,enabled-runtime,linked,linked-runtime,alias",
    "--no-legend", "--no-pager"], rows => inventoryRows(rows, false));
  observation.activeTriggers = observe(["list-units", "--all", "--type=socket,timer", "--state=active,activating,reloading,deactivating",
    "--no-legend", "--plain", "--no-pager"], rows => ({ count: rows.length }));
  observation.managerJobs = observe(["list-jobs", "--all", "--no-legend", "--plain", "--no-pager"], rows => ({ count: rows.length,
    malformedRows: rows.filter(row => { const fields = row.trim().split(/\s+/); return fields.length < 4 || !/^\d+$/.test(fields[0]!); }).length,
    supervisorJobs: rows.filter(row => row.trim().split(/\s+/)[1] === supervisor).length,
    ownedTargetJobs: rows.filter(row => row.trim().split(/\s+/)[1] === "TEST-retention.target").length,
    otherNameDigests: rows.flatMap(row => { const name = row.trim().split(/\s+/)[1];
      return name && name !== supervisor && name !== "TEST-retention.target" ? [digest(name)] : []; }).slice(0, 32) }));
  let count = 0, zeroPids = 0, malformedPidGroups = 0, foreignPopulatedGroups = 0;
  const end = Date.now() + 5000, foreignGroupDigests: string[] = [];
  const walk = (relative: string): void => {
    assert(++count <= 4096 && Date.now() < end);
    assert(/^(?:\/[A-Za-z0-9_.@+-]+)*$/.test(relative) && !relative.split("/").some(part => part === "." || part === ".."));
    const absolute = "/sys/fs/cgroup" + relative, stat = lstatSync(absolute); assert(stat.isDirectory() && !stat.isSymbolicLink());
    const fd = openSync(absolute + "/cgroup.procs", constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let pidText: string;
    try { const bytes = Buffer.alloc(65537); let length = 0;
      for (;;) { assert(Date.now() < end && length < bytes.length);
        const read = readSync(fd, bytes, length, bytes.length - length, null); if (read === 0) break; length += read; }
      assert(length <= 65536); pidText = bytes.subarray(0, length).toString("utf8"); }
    finally { closeSync(fd); }
    const pids = pidText.split("\n").filter(line => line.trim());
    zeroPids += pids.filter(pid => pid === "0").length;
    if (pids.some(pid => !/^[1-9]\d*$/.test(pid))) malformedPidGroups++;
    if (pids.length && relative !== expectedGroup && relative !== SYSTEM_BUS_CONTROL_GROUP && !(relative === "/init.scope" && pids.length === 1 && pids[0] === "1")) {
      foreignPopulatedGroups++; if (foreignGroupDigests.length < 32) foreignGroupDigests.push(digest(relative));
    }
    for (const child of readdirSync(absolute, { withFileTypes: true })) if (child.isDirectory()) walk(relative + "/" + child.name);
  };
  try { walk(""); observation.cgroups = { completed: true, count, zeroPids, malformedPidGroups, foreignPopulatedGroups, foreignGroupDigests }; }
  catch { observation.cgroups = { completed: false, count, zeroPids, malformedPidGroups, foreignPopulatedGroups, foreignGroupDigests }; }
  return observation;
}

function actualToolchainProfile(): HostedDependencyInstallerProfile {
  assert.equal(realpathSync(process.execPath), node);
  const npmRootPath = runtime + "/toolchain/lib/node_modules/npm", npmCliPath = npmRootPath + "/bin/npm-cli.js";
  const toolRoots = actualLibraries(node);
  // Production validates canonical root ownership and bytes BEFORE execution.
  const helperSha256 = hostedDependencyInstallerDropperSha256();
  assert.equal(command("/usr/bin/setpriv", ["--version"]).trim(), "setpriv from util-linux 2.39.3");
  const privilegeDropper: HostedDependencyInstallerProfile["privilegeDropper"] = { path: "/usr/bin/setpriv", version: "2.39.3",
    sha256: helperSha256, libraries: actualLibraries("/usr/bin/setpriv") };
  assert.equal(hostedDependencyInstallerDropperSha256(), helperSha256);
  const libc = toolRoots.find(row => /\/libc\.so\.[0-9]+$/.test(row.path)); assert(libc);
  const version = /^glibc\s+([0-9]+\.[0-9]+)\s*$/.exec(command("/usr/bin/getconf", ["GNU_LIBC_VERSION"]))?.[1]; assert(version);
  return { schemaVersion: 1, platform: "linux", arch: DependencyInstallArchitecture.X64, nodePath: node,
    nodeSha256: fileDigest(node), nodeVersion: process.version, nodeAbi: process.versions.modules,
    npmCliPath, npmSha256: fileDigest(npmCliPath), npmVersion: command(node, [npmCliPath, "--version"]).trim(), npmRootPath,
    npmRootSha256: hostedDependencyInstallerNpmRootSha256(npmRootPath), toolRoots, networkInputs: issueOwnedNetworkInputs(), privilegeDropper,
    recipeRevision: HostedDependencyInstallerRevision.NumericUidDropV2,
    libc: { family: DependencyLibcFamily.Glibc, version, path: libc.path, sha256: libc.sha256 } };
}
function actualLibraries(executable: string): HostedDependencyInstallerProfile["toolRoots"] {
  const output = command("/usr/bin/ldd", [executable]); assert(!output.includes("not found"));
  const paths = [...new Set([...output.matchAll(/(?:=>\s+)?(\/[A-Za-z0-9_./+-]+)\s+\(/g)].map(m => realpathSync(m[1]!)))].sort();
  assert(paths.length > 0 && paths.length <= 32);
  return paths.map(path => { assert(path.startsWith("/usr/lib/")); return { path, kind: DependencyToolRootKind.File as const, sha256: fileDigest(path) }; });
}
function issueOwnedNetworkInputs(): HostedDependencyInstallerProfile["networkInputs"] {
  directory(hostedDependencyInstallerNetworkRoot);
  const capture = (name: HostedDependencyInstallerNetworkInput): string => {
    // Assembly owns these exact regular files. No alias/OS service mutation is
    // required; data is read through a bounded stable FD, never as authority.
    const path = "/etc/" + name; assert.equal(realpathSync(path), path);
    const before = lstatSync(path, { bigint: true });
    assert(before.isFile() && before.uid === 0n && before.nlink === 1n && before.size > 0n && before.size <= 65536n);
    const input = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytes: Buffer;
    try {
      const buffer = Buffer.alloc(65537), opened = fstatSync(input, { bigint: true });
      const count = readSync(input, buffer, 0, buffer.length, 0);
      for (const stat of [opened, fstatSync(input, { bigint: true }), lstatSync(path, { bigint: true })])
        assert(stat.isFile() && stat.nlink === 1n && stat.dev === before.dev && stat.ino === before.ino && stat.size === before.size &&
          stat.mtimeNs === before.mtimeNs && stat.ctimeNs === before.ctimeNs);
      assert.equal(BigInt(count), before.size); bytes = buffer.subarray(0, count);
    } finally { closeSync(input); }
    const output = openSync(hostedDependencyInstallerNetworkRoot + "/" + name,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(output, bytes); fsyncSync(output); } finally { closeSync(output); }
    return digest(bytes);
  };
  const pins = { [HostedDependencyInstallerNetworkInput.Hosts]: capture(HostedDependencyInstallerNetworkInput.Hosts),
    [HostedDependencyInstallerNetworkInput.Resolver]: capture(HostedDependencyInstallerNetworkInput.Resolver),
    [HostedDependencyInstallerNetworkInput.NameService]: capture(HostedDependencyInstallerNetworkInput.NameService) };
  const parent = openSync(hostedDependencyInstallerNetworkRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(parent); } finally { closeSync(parent); }
  return pins;
}
async function publicInputs() {
  const response = await fetch("https://registry.npmjs.org/is-number/7.0.0", { signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 200); assert(response.body);
  const chunks: Uint8Array[] = []; let total = 0; const reader = response.body.getReader();
  try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; total += chunk.value.length;
    assert(total <= 128 * 1024); chunks.push(chunk.value); } } finally { await reader.cancel(); }
  const metadata = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { name: string; version: string; dependencies?: object; dist: { tarball: string; integrity: string } };
  assert.equal(metadata.name, "is-number"); assert.equal(metadata.version, "7.0.0");
  assert(!metadata.dependencies || Object.keys(metadata.dependencies).length === 0);
  assert.equal(metadata.dist.tarball, "https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz");
  assert.match(metadata.dist.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
  const pkg = { name: "owned-os-dependency-test", version: "1.0.0", private: true, dependencies: { "is-number": "7.0.0" } };
  return { packageBytes: Buffer.from(JSON.stringify(pkg) + "\n"), lockBytes: Buffer.from(JSON.stringify({ name: pkg.name,
    version: pkg.version, lockfileVersion: 3, requires: true, packages: { "": { name: pkg.name, version: pkg.version, dependencies: pkg.dependencies },
      "node_modules/is-number": { version: "7.0.0", resolved: metadata.dist.tarball, integrity: metadata.dist.integrity } } }) + "\n") };
}
