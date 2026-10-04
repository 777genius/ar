/** Disposable TEST primitives. This is deliberately not an end-to-end managed
 * consumer certificate: no account, auth seed, provider or production host is used.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync,
  realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertReadonlyHostOperator } from "../../dist/worker-codex/hosted-readonly-authority.js";
import { createHostedDependencyInstallerPlan, hostedDependencyInstallerNpmRootSha256,
  hostedDependencyInstallerProperties, type HostedDependencyInstallerProfile } from "../../dist/worker-codex/hosted-dependency-installer-recipe.js";
import { qualifyHostedDependencyInstallerInputs } from "../../dist/worker-codex/hosted-dependency-installer-inputs.js";
import { TrustedCustodyLaunchRole, trustedCustodySystemdLaunch } from "../../dist/worker-codex/trusted-custody-systemd-launch.js";
import { assertInstallerTerminalUnit } from "../../dist/worker-codex/hosted-dependency-installer-unit.js";
import { observeInstallerCgroupEmpty } from "../../dist/worker-codex/hosted-dependency-installer-cgroup.js";
import { observeDependencyTree } from "../../dist/worker-local/dependency-environment/observe-dependency-tree.js";
import { openDependencyTreeRename, DependencyTreeEffectError, DependencyTreeEffectFailure } from "../../dist/worker-local/dependency-environment/dependency-tree-effects.js";
import { DependencyInstallArchitecture, DependencyLibcFamily, DependencyToolRootKind,
  DependencyTreeObservationStatus, DependencyTreeObservationFailure } from "../../dist/worker-core/index.js";
import { admitHostedDependencyConsumer } from "../../dist/worker-codex/hosted-dependency-admission.js";
import type { CodexGoalRunConfig } from "../../dist/worker-codex/codex-goal-runner.js";

const artifact = "/opt/subscription-runtime-dependency-TEST";
const policy = "/var/lib/subscription-runtime-host-policy";
const evidencePath = artifact + "/evidence.json";
const script = fileURLToPath(import.meta.url);
const limits = { maxEntries: 100000, maxTotalBytes: 64 * 1024 * 1024,
  maxManifestBytes: 16 * 1024 * 1024, maxDurationMs: 30000 };
const cleanEnvironment = { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", SYSTEMD_COLORS: "0" };
const hash = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");
const identity = (path: string) => {
  const s = lstatSync(path, { bigint: true });
  assert(s.isDirectory() && !s.isSymbolicLink());
  return { canonicalPath: path, dev: String(s.dev), ino: String(s.ino) };
};
function command(executable: string, args: readonly string[], timeout = 30000): string {
  const result = spawnSync(executable, [...args], { env: cleanEnvironment, cwd: "/",
    encoding: "utf8", timeout, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  // Errors do not print subprocess output, environment or an arbitrary payload.
  assert(!result.error && result.signal === null && result.status === 0,
    `TEST command failed: ${executable}, status=${result.status}, signal=${result.signal}`);
  return result.stdout;
}
function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  assert.equal(realpathSync(path), path);
  assert.equal(lstatSync(path).uid, 0);
  assert.equal(lstatSync(path).mode & 0o777, 0o700);
}
function privateJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value) + "\n", { flag: "wx", mode: 0o600 });
}

async function sameDeviceBindVeto(root: string): Promise<void> {
  // Only this fresh mount namespace may mount these fresh fixture directories.
  assert.equal(process.argv[2], "mount-veto");
  assert(root.startsWith(policy + "/dependency-test-jobs/jobs/TEST-native-"));
  assert.notEqual(readlinkSync("/proc/self/ns/mnt"), readlinkSync("/proc/1/ns/mnt"));
  assert.notEqual(readlinkSync("/proc/self/ns/user"), readlinkSync("/proc/1/ns/user"));
  const workspace = root + "/mount-workspace", external = root + "/mount-external", trash = root + "/mount-trash";
  const baseline = await observeDependencyTree({ workspacePath: workspace, treeName: "node_modules", limits });
  assert.equal(baseline.status, DependencyTreeObservationStatus.Complete);
  if (baseline.status !== DependencyTreeObservationStatus.Complete) throw new Error("TEST baseline incomplete");
  assert.equal(lstatSync(external).dev, lstatSync(workspace).dev);
  command("/usr/bin/mount", ["--make-rprivate", "/"]);
  command("/usr/bin/mount", ["--bind", external, workspace + "/node_modules/mounted"]);
  try {
    const mounted = await observeDependencyTree({ workspacePath: workspace, treeName: "node_modules", limits });
    assert.equal(mounted.status, DependencyTreeObservationStatus.Incomplete);
    if (mounted.status !== DependencyTreeObservationStatus.Incomplete) throw new Error("TEST mount inventory unexpectedly complete");
    assert.equal(mounted.reason, DependencyTreeObservationFailure.MountCrossing);
    const operationId = randomUUID();
    await assert.rejects(openDependencyTreeRename({ workspace: identity(workspace),
      trash: { operationId, originalTree: baseline.tree, destinationName: `dependency-${operationId}`,
        destinationParent: identity(trash) }, manifestCanonicalBytes: baseline.canonicalBytes,
      manifestDigest: baseline.digest, limits }),
      (error: unknown) => error instanceof DependencyTreeEffectError && error.reason === DependencyTreeEffectFailure.ManifestMismatch,
      "mount must veto before rename");
    assert(!existsSync(trash + `/dependency-${operationId}`));
    assert.equal(readFileSync(external + "/sentinel", "utf8"), "external TEST original\n");
    assert(existsSync(workspace + "/node_modules/original"));
    assert.equal(lstatSync(trash).isDirectory(), true);
  } finally {
    command("/usr/bin/umount", ["--", workspace + "/node_modules/mounted"]);
  }
}

function issueActualToolchainProfile(): HostedDependencyInstallerProfile {
  const nodePath = realpathSync(process.execPath), npmRootPath = artifact + "/toolchain/lib/node_modules/npm";
  const npmCliPath = npmRootPath + "/bin/npm-cli.js";
  assert(nodePath.startsWith(artifact + "/toolchain/"));
  const ldd = command("/usr/bin/ldd", [nodePath]);
  const libraryPaths = [...new Set([...ldd.matchAll(/(?:=>\s+)?(\/[A-Za-z0-9_./+-]+)\s+\(/g)]
    .map(match => realpathSync(match[1]!)))].sort();
  assert(libraryPaths.length > 0 && libraryPaths.length <= 32);
  const toolRoots = libraryPaths.map(path => {
    assert(path.startsWith("/usr/lib/"));
    return { path, kind: DependencyToolRootKind.File as const, sha256: hash(readFileSync(path)) };
  });
  const libc = toolRoots.find(row => /\/libc\.so\.[0-9]+$/.test(row.path));
  assert(libc, "TEST requires concrete glibc in Node's actual dynamic closure");
  const libcVersion = /^glibc\s+([0-9]+\.[0-9]+)\s*$/.exec(command("/usr/bin/getconf", ["GNU_LIBC_VERSION"]))?.[1];
  assert(libcVersion);
  return { schemaVersion: 1, platform: "linux", arch: DependencyInstallArchitecture.X64,
    nodePath, nodeSha256: hash(readFileSync(nodePath)), nodeVersion: process.version,
    nodeAbi: process.versions.modules, npmCliPath, npmSha256: hash(readFileSync(npmCliPath)),
    npmVersion: command(nodePath, [npmCliPath, "--version"]).trim(), npmRootPath,
    npmRootSha256: hostedDependencyInstallerNpmRootSha256(npmRootPath), toolRoots,
    libc: { family: DependencyLibcFamily.Glibc, version: libcVersion, path: libc.path, sha256: libc.sha256 } };
}

async function publicRegistryInputs(): Promise<{ packageBytes: Buffer; lockBytes: Buffer }> {
  // This is a TEST dependency, not a new dependency of the repository/tooling.
  const response = await fetch("https://registry.npmjs.org/is-number/7.0.0", { signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 200);
  assert(response.body);
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      length += chunk.value.byteLength; assert(length <= 128 * 1024);
      chunks.push(chunk.value);
    }
  } finally { await reader.cancel(); }
  const metadata = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { name?: string; version?: string; scripts?: unknown;
    dependencies?: unknown; dist?: { tarball?: string; integrity?: string } };
  assert.equal(metadata.name, "is-number"); assert.equal(metadata.version, "7.0.0");
  assert(metadata.dependencies === undefined || Object.keys(metadata.dependencies as object).length === 0);
  // npm lifecycle execution is disabled by the fixed recipe regardless of registry scripts.
  assert.equal(metadata.dist?.tarball, "https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz");
  assert.match(metadata.dist?.integrity ?? "", /^sha512-[A-Za-z0-9+/]{86}==$/);
  const pkg = { name: "dependency-retention-test-native", version: "1.0.0", private: true, dependencies: { "is-number": "7.0.0" } };
  const lock = { name: pkg.name, version: pkg.version, lockfileVersion: 3, requires: true, packages: {
    "": { name: pkg.name, version: pkg.version, dependencies: pkg.dependencies },
    "node_modules/is-number": { version: "7.0.0", resolved: metadata.dist!.tarball, integrity: metadata.dist!.integrity },
  } };
  return { packageBytes: Buffer.from(JSON.stringify(pkg) + "\n"), lockBytes: Buffer.from(JSON.stringify(lock) + "\n") };
}

async function run(): Promise<void> {
  assertReadonlyHostOperator(); assert.equal(process.arch, "x64");
  assert.equal(script, artifact + "/scripts/dependency-retention-test/run.ts");
  assert.match(process.env.TEST_SOURCE_SHA ?? "", /^[a-f0-9]{40}$/);
  assert(!existsSync(policy), "TEST fixture refuses an existing host policy namespace");
  assert(existsSync("/run/systemd/system"));
  command("/usr/bin/systemctl", ["show", "--property=Version", "--value"]);
  privateDirectory(policy);
  const root = policy + "/dependency-test-jobs/jobs/TEST-native-" + randomUUID();
  privateDirectory(root); const workspace = root + "/workspace"; privateDirectory(workspace);
  const sentinels = [workspace + "/source", workspace + "/.git/config", workspace + "/.needed-ignored",
    root + "/key-sentinel", root + "/state-sentinel", root + "/output-sentinel", policy + "/privileged-sibling-sentinel"];
  privateDirectory(workspace + "/.git");
  for (const [index, path] of sentinels.entries()) writeFileSync(path, `TEST original ${index}\n`, { flag: "wx", mode: 0o600 });
  const before = sentinels.map(path => ({ path, sha256: hash(readFileSync(path)), ino: String(lstatSync(path).ino) }));
  const facts: Record<string, unknown> = { schemaVersion: 1, sourceSha: process.env.TEST_SOURCE_SHA,
    qualification: "native_test_primitives_only", machineId: readFileSync("/etc/machine-id", "utf8").trim(),
    bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(), results: [] };
  const results = facts.results as unknown[];
  privateJson(root + "/fixture-registration.json", { schemaVersion: 1, purpose: "dependency_retention_native_TEST",
    jobId: root.split("/").at(-1), workspace: identity(workspace), bootId: facts.bootId,
    sourceSha: facts.sourceSha, permissions: "disposable_test_issuer_only", managedConsumerCoverage: false });
  try {
    // A protected-looking path and request do not create ordinary origin authority.
    await assert.rejects(admitHostedDependencyConsumer({ workspacePath: workspace } as CodexGoalRunConfig),
      /dependency_admission:unsupported/);
    assert(!existsSync(policy + "/dependency-owners"));
    assert(!existsSync(workspace + "/node_modules"));
    results.push({ scenario: "unadmitted_root_consumer", result: "denied_before_effect" });
    privateJson(policy + "/dependency-installer-profile.json", issueActualToolchainProfile());
    const inputs = await publicRegistryInputs();
    writeFileSync(workspace + "/package.json", inputs.packageBytes, { flag: "wx", mode: 0o600 });
    writeFileSync(workspace + "/package-lock.json", inputs.lockBytes, { flag: "wx", mode: 0o600 });
    const startId = randomUUID(), plan = createHostedDependencyInstallerPlan(startId,
      qualifyHostedDependencyInstallerInputs(inputs.packageBytes, inputs.lockBytes));
    const launch = trustedCustodySystemdLaunch(TrustedCustodyLaunchRole.Installer, startId, plan.stagingDirectory, plan);
    command(launch.command, launch.args, 12 * 60 * 1000);
    const unit = `subscription-runtime-installer-${startId}.service`;
    assertInstallerTerminalUnit(unit);
    const drainDigest = observeInstallerCgroupEmpty("/sys/fs/cgroup/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/" + unit);
    const installed = await observeDependencyTree({ workspacePath: plan.stagingDirectory, treeName: "node_modules", limits });
    assert.equal(installed.status, DependencyTreeObservationStatus.Complete);
    assert(existsSync(plan.stagingDirectory + "/node_modules/is-number/index.js"));
    const installedOwnership = ["node_modules", "node_modules/is-number", "node_modules/is-number/index.js"].map(relative => {
      const stat = lstatSync(plan.stagingDirectory + "/" + relative);
      assert.equal(stat.uid, 65532); assert.equal(stat.gid, 65532);
      return { relative, uid: stat.uid, gid: stat.gid };
    });
    results.push({ scenario: "fixed_installer_recipe", result: "installed_and_actual_unit_drained", unit, drainDigest,
      installedOwnership,
      inputSha256: plan.inputSha256, toolchainSha256: hash(JSON.stringify(plan.profile)),
      manifestDigest: installed.status === DependencyTreeObservationStatus.Complete ? installed.digest : null });
    // A dependency-reading process uses the production installer's exact finite
    // RootDirectory mount properties. It is not the production provider enclosure.
    const probeUnit = `subscription-runtime-installer-${randomUUID()}.service`;
    // The only addition to the production recipe is this trusted, typed TEST
    // reader file. It does not broaden a directory or policy-state grant.
    writeFileSync(plan.rootDirectory + "/runtime/test-probe.ts", "", { flag: "wx", mode: 0o644 });
    const probeOutput = command("/usr/bin/systemd-run", ["--quiet", "--wait", "--pipe", `--unit=${probeUnit}`, "--service-type=exec",
      "--property=Slice=subscription-runtime-hosted.slice", "--property=KillMode=control-group",
      ...hostedDependencyInstallerProperties(plan).map(p => "--property=" + p),
      `--property=BindReadOnlyPaths=${artifact}/scripts/dependency-retention-test/probe.ts:/runtime/test-probe.ts:norbind`,
      "--", plan.profile.nodePath, "--experimental-strip-types", "/runtime/test-probe.ts",
      plan.stagingDirectory, JSON.stringify(sentinels)]);
    const probeEvidence: unknown = JSON.parse(probeOutput.trim());
    assert.deepEqual(probeEvidence, { schemaVersion: 1, scenario: "typed_installer_root_probe",
      observedIds: { uid: 65532, euid: 65532, gid: 65532, egid: 65532 }, dependencyRead: "passed", sentinelDenial: "passed" });
    assertInstallerTerminalUnit(probeUnit);
    observeInstallerCgroupEmpty("/sys/fs/cgroup/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/" + probeUnit);
    results.push({ scenario: "installer_root_dependency_read_and_sentinel_denial", result: "passed", unit: probeUnit, probeEvidence });
    for (const relative of ["mount-workspace/node_modules/mounted", "mount-external", "mount-trash"]) privateDirectory(root + "/" + relative);
    writeFileSync(root + "/mount-workspace/node_modules/original", "original TEST tree\n", { flag: "wx", mode: 0o600 });
    writeFileSync(root + "/mount-external/sentinel", "external TEST original\n", { flag: "wx", mode: 0o600 });
    command("/usr/bin/unshare", ["--user", "--map-root-user", "--mount", "--fork", "--",
      process.execPath, "--experimental-strip-types", script, "mount-veto", root]);
    results.push({ scenario: "fresh_user_mount_namespace_same_device_bind", result: "veto_before_rename_external_sentinel_unchanged" });
    assert.deepEqual(before, sentinels.map(path => ({ path, sha256: hash(readFileSync(path)), ino: String(lstatSync(path).ino) })));
    results.push({ scenario: "source_git_ignored_key_state_output_sentinels", result: "unchanged_bytes_and_inodes" });
    facts.unsupported = ["positive_final_ordinary_consumer_admission", "production_provider_enclosure", "hot_reuse_install_count_one",
      "committed_absent_cold_restore", "duplicate_late_enqueue_and_uncertain_creator_hold", "full_provider_acceptance"];
    facts.status = "partial_pass";
  } catch (error) {
    facts.status = "failed";
    facts.failure = error instanceof Error ? error.message.slice(0, 512) : "TEST primitive failure";
    throw error;
  } finally {
    privateJson(evidencePath, facts);
    chmodSync(evidencePath, 0o644);
  }
}

if (process.argv[2] === "mount-veto") {
  const root = process.argv[3]; assert(root); await sameDeviceBindVeto(root);
} else {
  await run();
}
