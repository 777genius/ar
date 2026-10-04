import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, cpSync, existsSync, fstatSync, fsyncSync, lstatSync, openSync,
  readdirSync, readFileSync, readlinkSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { HostedInstallationActivationStore } from "../../dist/worker-codex/hosted-installation-activation.js";
import { HostedReadonlyHostKernel } from "../../dist/worker-codex/hosted-readonly-host-kernel.js";
import { assertReadonlyHostOperator } from "../../dist/worker-codex/hosted-readonly-authority.js";
import { runHostedRuntimeForeground } from "../../dist/worker-codex/hosted-readonly-foreground.js";
import { writeHostedTestEgressGrant } from "../../dist/worker-codex/hosted-test-egress-files.js";
import { CodexProviderEgressProfileId } from "../../dist/provider-codex/index.js";
import { DependencyInstallArchitecture, DependencyLibcFamily, DependencyToolRootKind } from "../../dist/worker-core/index.js";
import { HostedDependencyInstallerNetworkInput, hostedDependencyInstallerNetworkRoot, hostedDependencyInstallerNpmRootSha256,
  HostedDependencyInstallerRevision, hostedDependencyInstallerDropperSha256,
  type HostedDependencyInstallerProfile } from "../../dist/worker-codex/hosted-dependency-installer-recipe.js";
import { readHostedDependencyBinding } from "../../dist/provider-codex/app-server/adapters/hosted-dependency-workspace.js";
import { LocalDependencyOwnerStore } from "../../dist/store-local-file/dependency-environment/local-dependency-owner-store.js";
import { readHostedDependencyReceipt } from "../../dist/worker-codex/hosted-dependency-materialization.js";
import { cleanEnv, command, digest, directory, directoryIdentity, fileDigest, installedArtifactDigest, json, node, policy, runtime } from "./common.ts";

{
  const evidence: Record<string, unknown> = { schemaVersion: 1, sourceSha: process.env.TEST_SOURCE_SHA,
    qualification: "native_fresh_hot_synthetic_provider", machineId: readFileSync("/etc/machine-id", "utf8").trim(),
    status: "failed", results: [], requiredCompanionGates: [{ workflow: "dependency-retention-linux-test.yml",
      sourceSha: process.env.TEST_SOURCE_SHA, observedInvariant: "actual npm UID/GID 65532 before normalization" }],
    unsupported: ["committed_absent_eviction_and_cold_restore", "live_account_provider_acceptance"] };
  try { await qualify(evidence); evidence.status = "partial_pass"; }
  catch (error) {
    evidence.failure = error instanceof Error ? error.message.slice(0, 512) : "TEST native qualification failed";
    if (error instanceof Error) evidence.kernelFailureLocations = kernelFailureLocations(error);
    process.exitCode = 1;
  } finally { json(runtime + "/guest-evidence.json", evidence, 0o644); }
}

async function qualify(evidence: Record<string, unknown>): Promise<void> {
  assert.equal(process.argv[2], "qualify"); assertReadonlyHostOperator();
  assert.match(process.env.TEST_SOURCE_SHA ?? "", /^[a-f0-9]{40}$/);
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
  directory(runtime + "/codex/bin", 0o755);
  cpSync(runtime + "/scripts/dependency-retention-os-test/provider.ts", runtime + "/codex/bin/provider.ts");
  chmodSync(runtime + "/codex/bin/provider.ts", 0o755);
  json(runtime + "/codex/package.json", { name: "@openai/codex", type: "module", private: true }, 0o644);
  json(runtime + "/codex/TEST-probe.json", { workspace, guestNamespaces }, 0o644);
  const args = [runtime + "/dist/worker-codex/codex-goal-cli.js", "run", "--task-id", jobId, "--job-id", jobId,
    "--job-root", root, "--workspace", workspace, "--prompt", root + "/prompt", "--accounts", "TEST-account", "--auth-root", root + "/auth",
    "--codex-binary", runtime + "/codex/bin/provider.ts", "--model", "TEST-synthetic-model", "--effort", "low",
    "--timeout", "5m", "--max-goal-turns", "1", "--max-attempts", "1", "--continuation-mode", "disabled",
    "--registry-root", root + "/state/registry", "--worker-report-mode", "structured-output"];
  const launch = { command: node, args, cwd: workspace };
  const supervisorUnit = "TEST-retention-supervisor.service";
  const controlGroup = command("/usr/bin/systemctl", ["show", supervisorUnit, "--property=ControlGroup", "--value"]).trim();
  json(policy + "/readonly-inventory.json", { schemaVersion: 2, hostId: evidence.machineId, supervisorUnit,
    units: [{ name: supervisorUnit, controlGroup, fragmentSha256: fileDigest("/etc/systemd/test-units/" + supervisorUnit) }],
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
  await writeHostedTestEgressGrant({ schemaVersion: 1, jobId, jobRootDir: root, workspacePath: workspace,
    profileId: CodexProviderEgressProfileId.TestNpmQualification });
  store.enrollOrdinary(jobId); store.resumeOrdinary();
  const binding = readHostedDependencyBinding(jobId); assert(binding);
  const env = { ...cleanEnv, SUBSCRIPTION_RUNTIME_SANDBOX_KIND: "hosted-codex-job" };
  let readyDigest: string | undefined;
  for (const mode of ["fresh", "hot"] as const) {
    assert.equal(await runHostedRuntimeForeground(node, args, workspace, env), 0, `actual ${mode} CLI failed`);
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
      receiptSha256: currentReady, probe: observed });
  }
  assert.deepEqual(before, sentinels.map(path => ({ path, sha256: fileDigest(path), ino: String(lstatSync(path).ino) })));
  assert.equal(command("/usr/bin/git", ["rev-parse", "HEAD"], 30000, workspace).trim(), gitBefore);
  results.push({ scenario: "source_git_ignored_key_state_output_sentinels", result: "unchanged" });
}

function kernelFailureLocations(error: Error) {
  // Fixed production source locations only, never raw stack paths or names.
  const files = ["hosted-readonly-host-kernel", "hosted-readonly-linux-collector", "hosted-readonly-observations"];
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
  const inventoryRows = (rows: string[], allowInit: boolean) => ({ count: rows.length,
    unknownCount: rows.filter(row => { const name = row.trim().split(/\s+/)[0]; return name !== supervisor && !(allowInit && name === "init.scope"); }).length,
    unknownNameDigests: rows.flatMap(row => { const name = row.trim().split(/\s+/)[0]!;
      return name !== supervisor && !(allowInit && name === "init.scope") ? [digest(name)] : []; }).slice(0, 32) });
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
    if (pids.length && relative !== expectedGroup && !(relative === "/init.scope" && pids.length === 1 && pids[0] === "1")) {
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
