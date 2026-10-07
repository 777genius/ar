/** Disposable TEST primitives. This is deliberately not an end-to-end managed
 * consumer certificate: no account, auth seed, provider or production host is used.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync,
  readSync, realpathSync, writeFileSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { assertReadonlyHostOperator } from "../../dist/worker-codex/hosted-readonly-authority.js";
import { createHostedDependencyInstallerPlan, hostedDependencyInstallerNpmRootSha256,
  hostedDependencyInstallerProperties, hostedDependencyInstallerNetworkRoot, HostedDependencyInstallerNetworkInput,
  HostedDependencyInstallerRevision, hostedDependencyInstallerBootstrapCommand, hostedDependencyInstallerDropperSha256, readHostedDependencyInstallerProfile,
  type HostedDependencyInstallerPlan, type HostedDependencyInstallerProfile } from "../../dist/worker-codex/hosted-dependency-installer-recipe.js";
import { qualifyHostedDependencyInstallerInputs } from "../../dist/worker-codex/hosted-dependency-installer-inputs.js";
import { TrustedCustodyLaunchRole, trustedCustodySystemdLaunch } from "../../dist/worker-codex/trusted-custody-systemd-launch.js";
import { assertInstallerTerminalUnit } from "../../dist/worker-codex/hosted-dependency-installer-unit.js";
import { hostedDependencyInstallerUid } from "../../dist/worker-codex/hosted-dependency-installer-identity.js";
import { collectJobs, collectProcessBirth, collectProcessCgroup, collectUnitNotFound } from "../../dist/worker-codex/hosted-readonly-linux-collector.js";
import { parseScopedManagerJobs } from "../../dist/worker-codex/hosted-readonly-observations.js";
import { observeInstallerCgroupEmpty } from "../../dist/worker-codex/hosted-dependency-installer-cgroup.js";
import { observeDependencyTree } from "../../dist/worker-local/dependency-environment/observe-dependency-tree.js";
import { openDependencyTreeRename, DependencyTreeEffectError, DependencyTreeEffectFailure } from "../../dist/worker-local/dependency-environment/dependency-tree-effects.js";
import { DependencyInstallArchitecture, DependencyLibcFamily, DependencyToolRootKind,
  DependencyTreeObservationStatus, DependencyTreeObservationFailure } from "../../dist/worker-core/index.js";
import { dependencyTestNpmConfig, dependencyTestNpmEnvironment } from "../../dist/worker-core/dependency-environment/domain/dependency-install-key.js";
import { admitHostedDependencyConsumer } from "../../dist/worker-codex/hosted-dependency-admission.js";
import type { CodexGoalRunConfig } from "../../dist/worker-codex/codex-goal-runner.js";

const artifact = "/usr/local/lib/subscription-runtime-dependency-TEST";
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
// Finite, erasable TEST labels: this harness runs with Node type stripping.
const bindCanaryStages = ["fixture_identity", "mount_namespace", "user_namespace", "baseline_inventory",
  "same_device", "make_private", "bind_mount", "mounted_inventory", "rename_veto", "sentinels", "unmount"] as const;
type BindCanaryStage = typeof bindCanaryStages[number];
const bindCanaryCodes = ["EACCES", "EPERM", "ENOENT", "EINVAL", "EBUSY", "ERR_ASSERTION", "TEST_COMMAND", "OTHER"] as const;
function bindCanaryDiagnostics(text: string): unknown[] {
  const records: unknown[] = [];
  for (const match of text.matchAll(/^dependency_bind_canary_v1 (.{1,512})$/gm)) {
    if (records.length === 2) break;
    try {
      const value = JSON.parse(match[1] ?? "");
      if (!value || typeof value !== "object" || Array.isArray(value) ||
          Object.keys(value).sort().join(",") !== "code,commandStatus,operationNotPermitted,permissionDenied,stage" ||
          !bindCanaryStages.some(stage => stage === value.stage) || !bindCanaryCodes.some(code => code === value.code) ||
          !(value.commandStatus === null || (Number.isInteger(value.commandStatus) && value.commandStatus >= 0 && value.commandStatus <= 255)) ||
          typeof value.permissionDenied !== "boolean" || typeof value.operationNotPermitted !== "boolean") continue;
      records.push({ stage: value.stage, code: value.code, commandStatus: value.commandStatus,
        permissionDenied: value.permissionDenied, operationNotPermitted: value.operationNotPermitted });
    } catch { /* No raw or malformed child output enters evidence. */ }
  }
  return records;
}
async function bindCanaryStep<T>(stage: BindCanaryStage, operation: () => T | Promise<T>): Promise<T> {
  try { return await operation(); } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    const fixedCode = bindCanaryCodes.find(known => known === code) ?? (error instanceof TestCommandFailure ? "TEST_COMMAND" : "OTHER");
    const classes = error instanceof TestCommandFailure ? error.runtime.classifications : [];
    writeSync(2, "dependency_bind_canary_v1 " + JSON.stringify({ stage, code: fixedCode,
      commandStatus: error instanceof TestCommandFailure ? error.status : null,
      permissionDenied: classes.includes("Permission denied"), operationNotPermitted: classes.includes("Operation not permitted") }) + "\n");
    throw error;
  }
}
function runtimeExecDiagnostics(text: string) {
  // Public fixed ELF names only. Never retain raw subprocess lines or paths.
  const names = ["libc.so.6", "libcap-ng.so.0", "libstdc++.so.6", "libgcc_s.so.1", "libm.so.6", "libdl.so.2",
    "libpthread.so.0", "librt.so.1", "ld-linux-x86-64.so.2"];
  const classes = ["error while loading shared libraries", "cannot open shared object file", "symbol lookup error",
    "error while loading shared library", "bad ELF interpreter", "Exec format error", "failed to execute",
    "No such file or directory", "Permission denied", "Operation not permitted", "OpenSSL configuration error"];
  // Exact util-linux 2.39.3 failure sites; stage labels are diagnostics only.
  const stages = ["disallow granting new privileges failed", "keep process capabilities failed", "activate capabilities",
    "reactivate capabilities", "getresuid failed", "setresuid failed", "getresgid failed", "setresgid failed",
    "setgroups failed", "apply bounding set", "apply capabilities"];
  const missing = [...text.matchAll(/(?:error while loading shared libraries|error while loading shared library): ([A-Za-z0-9_.+-]{1,128}):/g)]
    .map(match => match[1]).filter((name): name is string => name !== undefined);
  return { classifications: classes.filter(message => text.includes(message)),
    bindCanary: bindCanaryDiagnostics(text),
    unshareFailures: ["unshare failed", "cannot change root filesystem propagation", "setgroups failed", "setgid failed", "setuid failed",
      "fork failed", "waitpid failed", "child exit failed"].filter(stage => text.includes("unshare: " + stage + ":")),
    bootstrapPreflight: bootstrapPreflightDiagnostic(text),
    privilegeDropFailures: stages.filter(stage => new RegExp(`(?:^|\\n)setpriv: ${stage}:`).test(text)),
    missingLibraries: names.filter(name => missing.includes(name)), unlistedMissingLibrary: missing.some(name => !names.includes(name)),
    glibcVersionMissing: /version [`']GLIBC_[0-9.]+['`] not found/.test(text),
    glibcxxVersionMissing: /version [`']GLIBCXX_[0-9.]+['`] not found/.test(text) };
}
function bootstrapPreflightDiagnostic(text: string): unknown {
  const marker = /^dependency_installer_preflight_v1 (.{1,512})$/m.exec(text)?.[1]; if (!marker) return null;
  try {
    const value = JSON.parse(marker);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    if (value.stage === "runtime_identity" && Object.keys(value).sort().join(",") === "abiMatch,archMatch,platformMatch,stage" &&
        [value.abiMatch, value.archMatch, value.platformMatch].every(v => typeof v === "boolean"))
      return { stage: "runtime_identity", abiMatch: value.abiMatch, archMatch: value.archMatch, platformMatch: value.platformMatch };
    const status = (v: unknown) => v === null || (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 255);
    if (value.stage === "tool_versions" && Object.keys(value).sort().join(",") === "duplicateConfig,nodeStatus,nodeVersionMatch,npmStatus,npmVersionMatch,stage" &&
        status(value.nodeStatus) && status(value.npmStatus) && [value.nodeVersionMatch, value.npmVersionMatch, value.duplicateConfig].every(v => typeof v === "boolean"))
      return { stage: "tool_versions", nodeStatus: value.nodeStatus, npmStatus: value.npmStatus,
        nodeVersionMatch: value.nodeVersionMatch, npmVersionMatch: value.npmVersionMatch, duplicateConfig: value.duplicateConfig };
  } catch { /* Malformed markers never become retained raw output. */ }
  return null;
}
class TestCommandFailure extends Error {
  readonly runtime: ReturnType<typeof runtimeExecDiagnostics>;
  readonly status: number | null;
  readonly completed: boolean;
  constructor(executable: string, status: number | null, completed: boolean, signal: NodeJS.Signals | null, output: string) {
    super(`TEST command failed: ${executable}, status=${status}, signal=${signal}`);
    this.status = status; this.completed = completed;
    this.runtime = runtimeExecDiagnostics(output.slice(0, 8192));
  }
}
function command(executable: string, args: readonly string[], timeout = 30000): string {
  const result = spawnSync(executable, [...args], { env: cleanEnvironment, cwd: "/",
    encoding: "utf8", timeout, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  // Errors do not print subprocess output, environment or an arbitrary payload.
  if (result.error || result.signal !== null || result.status !== 0)
    throw new TestCommandFailure(executable, result.status, !result.error && result.signal === null && result.status !== null, result.signal, result.stderr ?? "");
  return result.stdout;
}
function failedInstallerDiagnostics(unit: string, error: unknown): unknown {
  assert.match(unit, /^subscription-runtime-installer-[a-f0-9-]{36}\.service$/);
  const properties = ["LoadState", "ActiveState", "SubState", "Result", "ExecMainCode", "ExecMainStatus", "User", "Group"];
  const show = spawnSync("/usr/bin/systemctl", ["show", unit, ...properties.map(p => "--property=" + p)],
    { env: cleanEnvironment, cwd: "/", encoding: "utf8", timeout: 5000, maxBuffer: 8192 });
  const journal = spawnSync("/usr/bin/journalctl", ["--unit=" + unit, "--no-pager", "--lines=24", "--output=cat"],
    { env: cleanEnvironment, cwd: "/", encoding: "utf8", timeout: 5000, maxBuffer: 8192 });
  const lookup = spawnSync("/usr/bin/getent", ["passwd", String(hostedDependencyInstallerUid)],
    { env: cleanEnvironment, cwd: "/", timeout: 5000, stdio: "ignore" });
  // Record only fixed setup classifications and whitelisted unit properties.
  // Neither passwd records, payload output nor raw journal/stderr is retained.
  const states = Object.fromEntries((show.stdout ?? "").split("\n").flatMap(line => {
    const match = /^([A-Za-z]+)=([A-Za-z0-9_-]*)$/.exec(line);
    const name = match?.[1], value = match?.[2];
    return name !== undefined && value !== undefined && properties.includes(name) ? [[name, value]] : [];
  }));
  const setup = ["Failed to determine user credentials", "Failed to change UID", "Failed to send user credentials to PID1",
    "Failed to set up user namespacing", "Failed at step USER", "Failed to determine group credentials"];
  const text = journal.stdout ?? "";
  return { unit, fixedUid: hostedDependencyInstallerUid, states, showStatus: show.status, journalStatus: journal.status,
    runtimeExec: { ownedUnitJournal: runtimeExecDiagnostics(text),
      ownedRunPipe: error instanceof TestCommandFailure ? error.runtime : null },
    userLookupStatus: lookup.status, setupFailures: setup.filter(message => text.includes(message)),
    setupErrnos: ["No such process", "Operation not permitted", "Permission denied"].filter(message => text.includes(message)),
    observationsFailed: Boolean(show.error || journal.error || lookup.error) };
}
function diagnosticUnitDrained(unit: string, status: 0 | 127) {
  assert.match(unit, /^subscription-runtime-installer-[a-f0-9-]{36}\.service$/);
  const absent = () => assert(!parseScopedManagerJobs(collectJobs()).some(job => job.unit === unit)); absent();
  const names = ["Id", "LoadState", "ActiveState", "SubState", "MainPID", "ControlGroup", "DropInPaths", "ExecMainStatus", "User", "Group",
    "CapabilityBoundingSet", "NoNewPrivileges", "PrivateUsers", "SecureBits"];
  const show = spawnSync("/usr/bin/systemctl", ["show", unit, ...names.map(name => "--property=" + name)],
    { env: cleanEnvironment, cwd: "/", encoding: "utf8", timeout: 5000, maxBuffer: 8192 });
  assert(!show.error && show.signal === null && (show.status === 0 || show.status === 4));
  const output = show.stdout;
  const row: Record<string, string> = {};
  for (const line of output.trimEnd().split("\n")) {
    const i = line.indexOf("="), name = line.slice(0, i);
    assert(i > 0 && names.includes(name) && !Object.hasOwn(row, name)); row[name] = line.slice(i + 1);
  }
  const group = "/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/" + unit;
  assert.equal(row.Id, unit);
  if (status === 0 && row.LoadState === "not-found") {
    assert(collectUnitNotFound(unit)); const digest = observeInstallerCgroupEmpty("/sys/fs/cgroup" + group); absent();
    return { digest, properties: { state: "positive_not_found" } };
  }
  assert.equal(show.status, 0); assert.equal(Object.keys(row).length, names.length); assert.equal(row.LoadState, "loaded");
  assert.equal(row.ActiveState, status === 0 ? "inactive" : "failed"); assert.equal(row.SubState, status === 0 ? "dead" : "failed");
  assert.equal(row.MainPID, "0"); assert.equal(row.ExecMainStatus, String(status)); assert.equal(row.DropInPaths, "");
  assert.equal(row.User, "0"); assert.equal(row.Group, "0");
  assert(row.ControlGroup === "" || row.ControlGroup === group);
  const digest = observeInstallerCgroupEmpty("/sys/fs/cgroup" + group); absent();
  const known = ["cap_setuid", "cap_setgid", "cap_setpcap"], tokens = (row.CapabilityBoundingSet ?? "").split(" ").filter(Boolean);
  assert(row.NoNewPrivileges === "yes" || row.NoNewPrivileges === "no"); assert(row.PrivateUsers === "yes" || row.PrivateUsers === "no");
  assert.match(row.SecureBits ?? "", /^[0-9]{1,10}$/);
  return { digest, properties: { bounding: known.filter(cap => tokens.includes(cap)), unknownCapability: tokens.some(cap => !known.includes(cap)),
    noNewPrivileges: row.NoNewPrivileges, privateUsers: row.PrivateUsers, secureBits: row.SecureBits } };
}
function retainDiagnosticJson(path: string, value: unknown): void {
  privateJson(path, value); const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
  const parentFd = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(parentFd); } finally { closeSync(parentFd); }
}
function capabilityDiagnostic(plan: HostedDependencyInstallerPlan, originalUnit: string, error: unknown): unknown {
  if (!(error instanceof TestCommandFailure) || !error.completed || error.status !== 127) return { status: "original_result_uncertain_no_launch" };
  const originalDrain = diagnosticUnitDrained(originalUnit, 127), startId = randomUUID();
  const unit = `subscription-runtime-installer-${startId}.service`, registration = plan.directory + "/TEST-dropper-diagnostic.json";
  const record = { schemaVersion: 1, purpose: "TEST_native_dropper_boundary_diagnostic", unit, startId, originalUnit, originalDrain,
    bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(), sourceSha: process.env.TEST_SOURCE_SHA,
    planStartId: plan.startId, planSha256: hash(JSON.stringify(plan)), executableSha256: plan.profile.privilegeDropper.sha256 };
  retainDiagnosticJson(registration, record);
  // v2.39.3 returns from dump before NNP/keepcaps/ID changes or target exec.
  // This separate PID is boundary diagnostics, never failing-PID authority.
  const result = spawnSync("/usr/bin/systemd-run", ["--quiet", "--wait", "--pipe", `--unit=${unit}`, "--service-type=exec", "--expand-environment=no",
    "--working-directory=/", "--property=Slice=subscription-runtime-hosted.slice", "--property=KillMode=control-group",
    "--property=SendSIGKILL=yes", "--property=Delegate=no", ...hostedDependencyInstallerProperties(plan).map(p => "--property=" + p),
    "--", plan.profile.privilegeDropper.path, "-ddd"],
  { env: cleanEnvironment, cwd: "/", encoding: "utf8", timeout: 10000, maxBuffer: 8192, stdio: ["ignore", "pipe", "pipe"] });
  if (result.error || result.signal || result.status !== 0) return { unit, status: "diagnostic_result_uncertain_held",
    runtimeExec: runtimeExecDiagnostics((result.stderr ?? "").slice(0, 8192)) };
  const drained = diagnosticUnitDrained(unit, 0), text = result.stdout;
  const ids = Object.fromEntries(["uid", "euid", "suid", "gid", "egid", "sgid"].map(name => {
    const value = new RegExp(`^${name}: ([0-9]{1,10})$`, "m").exec(text)?.[1]; assert(value); return [name, value];
  }));
  const known = ["setuid", "setgid", "setpcap"];
  const caps = Object.fromEntries(["Effective", "Permitted", "Inheritable", "Ambient", "Capability bounding set"].map(name => {
    const label = name === "Capability bounding set" ? "Capability bounding set" : name + " capabilities";
    const value = new RegExp(`^${label}: ([^\\n]*)$`, "m").exec(text)?.[1]; assert(value !== undefined);
    const tokens = value === "[none]" ? [] : value.split(",");
    return [name, { known: known.filter(cap => tokens.includes(cap)), unknownCapability: tokens.some(cap => !known.includes(cap)) }];
  }));
  const secure = /^Securebits: ([^\n]*)$/m.exec(text)?.[1]; assert(secure !== undefined);
  const bits = ["noroot", "noroot_locked", "no_setuid_fixup", "no_setuid_fixup_locked", "keep_caps_locked"];
  const tokens = secure === "[none]" ? [] : secure.split(",");
  const nnp = /^no_new_privs: ([01])$/m.exec(text)?.[1]; assert(nnp !== undefined);
  retainDiagnosticJson(plan.directory + "/TEST-dropper-diagnostic-completion.json", { unit, status: 0, drained });
  return { unit, status: "separate_native_boundary_observed", originalDrain, drained, ids, caps,
    noNewPrivileges: nnp === "1", securebits: bits.filter(bit => tokens.includes(bit)), unknownSecurebit: tokens.some(bit => !bits.includes(bit)) };
}
function actualProbeCredentials(unit: string, planRoot: string, nodePath: string) {
  const pid = command("/usr/bin/systemctl", ["show", unit, "--property=MainPID", "--value"], 5000).trim();
  assert.match(pid, /^[1-9][0-9]{0,9}$/);
  const birth = collectProcessBirth(pid), group = collectProcessCgroup(pid), prefix = "/proc/" + pid;
  assert.equal(group, "0::/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/" + unit);
  assert.equal(realpathSync(prefix + "/exe"), nodePath);
  const expectedRootFd = openSync(planRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let actualRootFd: number | undefined;
  try {
    // Proc root is a kernel magic link; its readlink text may be '/' in the
    // target mount namespace. Follow the exact birth-bound PID link to its object.
    actualRootFd = openSync(prefix + "/root", constants.O_RDONLY | constants.O_DIRECTORY);
    const expectedRoot = fstatSync(expectedRootFd, { bigint: true }), actualRoot = fstatSync(actualRootFd, { bigint: true });
    assert(expectedRoot.isDirectory() && actualRoot.isDirectory());
    assert.equal(actualRoot.dev, expectedRoot.dev); assert.equal(actualRoot.ino, expectedRoot.ino);
    const status = readFileSync(prefix + "/status", "utf8"); assert(status.length <= 8192);
    for (const kind of ["Uid", "Gid"]) assert(new RegExp(`^${kind}:[ \\t]+65532[ \\t]+65532[ \\t]+65532[ \\t]+65532[ \\t]*$`, "m").test(status));
    assert(/^Groups:[ \t]*$/m.test(status)); assert(/^NoNewPrivs:[ \t]+1$/m.test(status));
    for (const kind of ["Inh", "Prm", "Eff", "Bnd", "Amb"]) assert(new RegExp(`^Cap${kind}:[ \\t]+0{16}$`, "m").test(status));
    assert.notEqual(readlinkSync(prefix + "/ns/mnt"), readlinkSync("/proc/self/ns/mnt"));
    assert.equal(readlinkSync(prefix + "/ns/user"), readlinkSync("/proc/self/ns/user"));
    const freshRootFd = openSync(prefix + "/root", constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      const freshRoot = fstatSync(freshRootFd, { bigint: true }), freshExpected = lstatSync(planRoot, { bigint: true });
      assert(freshExpected.isDirectory() && !freshExpected.isSymbolicLink());
      for (const stat of [freshRoot, freshExpected]) {
        assert.equal(stat.dev, expectedRoot.dev); assert.equal(stat.ino, expectedRoot.ino);
      }
    } finally { closeSync(freshRootFd); }
    assert.equal(collectProcessBirth(pid), birth); assert.equal(collectProcessCgroup(pid), group);
    return { pid, birth, uidColumns: [65532, 65532, 65532, 65532], gidColumns: [65532, 65532, 65532, 65532],
      rootIdentity: { dev: String(actualRoot.dev), ino: String(actualRoot.ino) },
      supplementaryGroups: [], capabilitySets: "all_zero", noNewPrivileges: 1, privateMountNamespace: true, initialUserNamespace: true };
  } finally { if (actualRootFd !== undefined) closeSync(actualRootFd); closeSync(expectedRootFd); }
}
async function runObservedProbe(args: readonly string[], unit: string, planRoot: string, nodePath: string) {
  return new Promise<{ output: string; credentials: ReturnType<typeof actualProbeCredentials> }>((resolve, reject) => {
    const child = spawn("/usr/bin/systemd-run", [...args], { env: cleanEnvironment, cwd: "/", stdio: ["pipe", "pipe", "ignore"] });
    let output = "", ready = false, credentials: ReturnType<typeof actualProbeCredentials> | undefined;
    const timer = setTimeout(() => reject(new Error("TEST owned probe observation timeout")), 30000);
    child.once("error", () => { clearTimeout(timer); reject(new Error("TEST owned probe creator failed")); });
    child.stdout.on("data", bytes => {
      try {
        output += bytes.toString("utf8"); assert(output.length <= 8192);
        const end = output.indexOf("\n");
        if (!ready && end !== -1) {
          assert.deepEqual(JSON.parse(output.slice(0, end)), { schemaVersion: 1, scenario: "typed_installer_root_probe_ready" });
          // Read the unit's actual PID, never an untrusted marker's claimed PID.
          credentials = actualProbeCredentials(unit, planRoot, nodePath); ready = true; output = output.slice(end + 1);
          child.stdin.end("observed\n");
        }
      } catch (error) { reject(error); }
    });
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      if (status !== 0 || signal !== null || !credentials) reject(new Error("TEST owned probe did not complete actual observation"));
      else resolve({ output, credentials });
    });
  });
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

function initialBindCanaryNamespaces(): { mount: string; user: string } {
  assert.equal(process.getuid?.(), 0); assert.equal(process.geteuid?.(), 0);
  const mount = readlinkSync("/proc/self/ns/mnt"), user = readlinkSync("/proc/self/ns/user");
  assert.match(mount, /^mnt:\[[0-9]{1,20}\]$/); assert.match(user, /^user:\[[0-9]{1,20}\]$/);
  assert.equal(mount, readlinkSync("/proc/1/ns/mnt")); assert.equal(user, readlinkSync("/proc/1/ns/user"));
  return { mount, user };
}
async function sameDeviceBindVeto(root: string, initialMount: string, initialUser: string): Promise<void> {
  // Only this fresh mount namespace may mount these fresh fixture directories.
  await bindCanaryStep("fixture_identity", () => {
    assert.equal(process.argv.length, 6);
    assert.equal(process.argv[2], "mount-veto");
    assert(root.startsWith(policy + "/dependency-test-jobs/jobs/TEST-native-"));
    assert.match(initialMount, /^mnt:\[[0-9]{1,20}\]$/); assert.match(initialUser, /^user:\[[0-9]{1,20}\]$/);
  });
  // PID 1's namespace links require authority in its initial user namespace.
  // These exact kernel facts were captured by our trusted parent before unshare.
  await bindCanaryStep("mount_namespace", () => assert.notEqual(readlinkSync("/proc/self/ns/mnt"), initialMount));
  await bindCanaryStep("user_namespace", () => assert.notEqual(readlinkSync("/proc/self/ns/user"), initialUser));
  const workspace = root + "/mount-workspace", external = root + "/mount-external", trash = root + "/mount-trash";
  const baseline = await bindCanaryStep("baseline_inventory", async () => {
    const observed = await observeDependencyTree({ workspacePath: workspace, treeName: "node_modules", limits });
    assert.equal(observed.status, DependencyTreeObservationStatus.Complete); return observed;
  });
  if (baseline.status !== DependencyTreeObservationStatus.Complete) throw new Error("TEST baseline incomplete");
  await bindCanaryStep("same_device", () => assert.equal(lstatSync(external).dev, lstatSync(workspace).dev));
  await bindCanaryStep("make_private", () => command("/usr/bin/mount", ["--make-rprivate", "/"]));
  await bindCanaryStep("bind_mount", () => command("/usr/bin/mount", ["--bind", external, workspace + "/node_modules/mounted"]));
  try {
    await bindCanaryStep("mounted_inventory", async () => {
      const mounted = await observeDependencyTree({ workspacePath: workspace, treeName: "node_modules", limits });
      assert.equal(mounted.status, DependencyTreeObservationStatus.Incomplete);
      if (mounted.status !== DependencyTreeObservationStatus.Incomplete) throw new Error("TEST mount inventory unexpectedly complete");
      assert.equal(mounted.reason, DependencyTreeObservationFailure.MountCrossing);
    });
    const operationId = randomUUID();
    await bindCanaryStep("rename_veto", () => assert.rejects(openDependencyTreeRename({ workspace: identity(workspace),
      trash: { operationId, originalTree: baseline.tree, destinationName: `dependency-${operationId}`,
        destinationParent: identity(trash) }, manifestCanonicalBytes: baseline.canonicalBytes,
      manifestDigest: baseline.digest, limits }),
      (error: unknown) => error instanceof DependencyTreeEffectError && error.reason === DependencyTreeEffectFailure.ManifestMismatch,
      "mount must veto before rename"));
    await bindCanaryStep("sentinels", () => {
      assert(!existsSync(trash + `/dependency-${operationId}`));
      assert.equal(readFileSync(external + "/sentinel", "utf8"), "external TEST original\n");
      assert(existsSync(workspace + "/node_modules/original"));
      assert.equal(lstatSync(trash).isDirectory(), true);
    });
  } finally {
    await bindCanaryStep("unmount", () => command("/usr/bin/umount", ["--", workspace + "/node_modules/mounted"]));
  }
}

function issueActualToolchainProfile(): HostedDependencyInstallerProfile {
  const nodePath = realpathSync(process.execPath), npmRootPath = artifact + "/toolchain/lib/node_modules/npm";
  const npmCliPath = npmRootPath + "/bin/npm-cli.js";
  // Root trust includes every ancestor, not just the copied TEST artifact.
  // Preserve actual metadata on failure; never repair runner directories.
  for (let parent = dirname(npmCliPath);; parent = dirname(parent)) {
    const stat = lstatSync(parent);
    const facts = { path: parent, uid: stat.uid, gid: stat.gid, mode: (stat.mode & 0o7777).toString(8),
      directory: stat.isDirectory(), symlink: stat.isSymbolicLink() };
    assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === 0 && !(stat.mode & 0o022),
      `TEST unsafe toolchain ancestor: ${JSON.stringify(facts)}`);
    if (parent === "/") break;
  }
  assert(nodePath.startsWith(artifact + "/toolchain/"));
  const toolRoots = actualLibraries(nodePath);
  const helper = "/usr/bin/setpriv", helperSha256 = hostedDependencyInstallerDropperSha256();
  assert.equal(realpathSync(helper), helper);
  assert.equal(command(helper, ["--version"]).trim(), "setpriv from util-linux 2.39.3");
  const privilegeDropper: HostedDependencyInstallerProfile["privilegeDropper"] = { path: helper, version: "2.39.3",
    sha256: helperSha256, libraries: actualLibraries(helper) };
  assert.equal(hostedDependencyInstallerDropperSha256(), helperSha256);
  const libc = toolRoots.find(row => /\/libc\.so\.[0-9]+$/.test(row.path));
  assert(libc, "TEST requires concrete glibc in Node's actual dynamic closure");
  const libcVersion = /^glibc\s+([0-9]+\.[0-9]+)\s*$/.exec(command("/usr/bin/getconf", ["GNU_LIBC_VERSION"]))?.[1];
  assert(libcVersion);
  return { schemaVersion: 1, platform: "linux", arch: DependencyInstallArchitecture.X64,
    nodePath, nodeSha256: hash(readFileSync(nodePath)), nodeVersion: process.version,
    nodeAbi: process.versions.modules, npmCliPath, npmSha256: hash(readFileSync(npmCliPath)),
    npmVersion: command(nodePath, [npmCliPath, "--version"]).trim(), npmRootPath,
    npmRootSha256: hostedDependencyInstallerNpmRootSha256(npmRootPath), toolRoots, networkInputs: issueNetworkInputs(), privilegeDropper,
    recipeRevision: HostedDependencyInstallerRevision.NumericUidDropV2,
    libc: { family: DependencyLibcFamily.Glibc, version: libcVersion, path: libc.path, sha256: libc.sha256 } };
}
function actualLibraries(executable: string): HostedDependencyInstallerProfile["toolRoots"] {
  const ldd = command("/usr/bin/ldd", [executable]);
  const paths = [...new Set([...ldd.matchAll(/(?:=>\s+)?(\/[A-Za-z0-9_./+-]+)\s+\(/g)].map(match => {
    const path = match[1]; assert(path); return realpathSync(path);
  }))].sort(); assert(paths.length > 0 && paths.length <= 32);
  return paths.map(path => { assert(path.startsWith("/usr/lib/"));
    return { path, kind: DependencyToolRootKind.File, sha256: hash(readFileSync(path)) }; });
}
function issueNetworkInputs(): HostedDependencyInstallerProfile["networkInputs"] {
  privateDirectory(hostedDependencyInstallerNetworkRoot);
  const capture = (name: HostedDependencyInstallerNetworkInput): string => {
    // OS resolver data is transport input, never executable or operator authority.
    const alias = "/etc/" + name, link = lstatSync(alias, { bigint: true }), path = realpathSync(alias), before = lstatSync(path, { bigint: true });
    assert(before.isFile() && before.nlink === 1n && before.size > 0n && before.size <= 65536n);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytes: Buffer;
    try {
      const opened = fstatSync(fd, { bigint: true }), buffer = Buffer.alloc(65537), count = readSync(fd, buffer, 0, buffer.length, 0);
      const after = fstatSync(fd, { bigint: true }), fresh = lstatSync(path, { bigint: true }), freshLink = lstatSync(alias, { bigint: true });
      for (const stat of [opened, after, fresh]) assert(stat.isFile() && stat.nlink === 1n && stat.dev === before.dev && stat.ino === before.ino &&
        stat.size === before.size && stat.mtimeNs === before.mtimeNs && stat.ctimeNs === before.ctimeNs);
      assert(BigInt(count) === before.size && realpathSync(alias) === path && freshLink.dev === link.dev && freshLink.ino === link.ino &&
        freshLink.mtimeNs === link.mtimeNs && freshLink.ctimeNs === link.ctimeNs);
      bytes = buffer.subarray(0, count);
    } finally { closeSync(fd); }
    const target = hostedDependencyInstallerNetworkRoot + "/" + name;
    const out = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(out, bytes); fsyncSync(out); } finally { closeSync(out); }
    return hash(bytes);
  };
  const pins = { [HostedDependencyInstallerNetworkInput.Hosts]: capture(HostedDependencyInstallerNetworkInput.Hosts),
    [HostedDependencyInstallerNetworkInput.Resolver]: capture(HostedDependencyInstallerNetworkInput.Resolver),
    [HostedDependencyInstallerNetworkInput.NameService]: capture(HostedDependencyInstallerNetworkInput.NameService) };
  const fd = openSync(hostedDependencyInstallerNetworkRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
  return pins;
}
function networkPreflight(): unknown[] {
  return [...Object.values(HostedDependencyInstallerNetworkInput).map(name => "/etc/" + name),
    artifact + "/dist/worker-codex/hosted-dependency-installer-bootstrap.js"].map(source => {
    const path = realpathSync(source), stat = lstatSync(path);
    let unsafeAncestor: unknown = null;
    for (let parent = dirname(path);; parent = dirname(parent)) {
      const s = lstatSync(parent);
      if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== 0 || (s.mode & 0o022)) {
        unsafeAncestor = { path: parent, uid: s.uid, gid: s.gid, mode: (s.mode & 0o7777).toString(8) }; break;
      }
      if (parent === "/") break;
    }
    return { source, resolved: path, regular: stat.isFile(), uid: stat.uid, gid: stat.gid,
      mode: (stat.mode & 0o7777).toString(8), nlink: stat.nlink, dev: String(stat.dev), ino: String(stat.ino), unsafeAncestor };
  });
}
function syntheticCaPreflight(plan: HostedDependencyInstallerPlan) {
  return ["/", "/etc", "/etc/ssl", "/etc/ssl/certs"].map(relative => {
    const stat = lstatSync(plan.rootDirectory + (relative === "/" ? "" : relative));
    const facts = { relative, uid: stat.uid, gid: stat.gid, mode: (stat.mode & 0o7777).toString(8),
      dev: String(stat.dev), ino: String(stat.ino), directory: stat.isDirectory(), symlink: stat.isSymbolicLink() };
    assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === 0 && (stat.mode & 0o7777) === 0o755,
      "TEST synthetic CA ancestry must be traversable before unprivileged launch");
    return facts;
  });
}
function npmConfigPreflight(plan: HostedDependencyInstallerPlan) {
  const profile = JSON.parse(readFileSync(plan.rootDirectory + "/runtime/profile.json", "utf8"));
  assert.deepEqual(profile.environment, dependencyTestNpmEnvironment);
  const paths = [profile.environment.npm_config_userconfig, profile.environment.npm_config_globalconfig];
  assert.deepEqual(paths, ["/runtime/npmrc", "/runtime/global-npmrc"]);
  const facts = paths.map((relative: string) => {
    const path = plan.rootDirectory + relative, stat = lstatSync(path), digest = hash(readFileSync(path));
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.uid === 0 && stat.nlink === 1 && (stat.mode & 0o7777) === 0o644);
    assert.equal(digest, hash(dependencyTestNpmConfig));
    return { relative, dev: String(stat.dev), ino: String(stat.ino), uid: stat.uid, mode: "644", sha256: digest };
  });
  assert.notEqual(facts[0]?.dev + ":" + facts[0]?.ino, facts[1]?.dev + ":" + facts[1]?.ino);
  return facts;
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
  assert.equal(script, artifact + "/scripts/dependency-retention-test/run.node-test.ts");
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
    facts.networkInputPreflight = networkPreflight(); // Metadata only, never record contents.
    privateJson(policy + "/dependency-installer-profile.json", issueActualToolchainProfile());
    const resolverSnapshot = hostedDependencyInstallerNetworkRoot + "/" + HostedDependencyInstallerNetworkInput.Resolver;
    const snapshotBytes = readFileSync(resolverSnapshot);
    chmodSync(resolverSnapshot, 0o640); assert.throws(readHostedDependencyInstallerProfile, /recipe_unsupported/); chmodSync(resolverSnapshot, 0o600);
    writeFileSync(resolverSnapshot, Buffer.concat([snapshotBytes, Buffer.from("\n")]));
    assert.throws(readHostedDependencyInstallerProfile, /recipe_unsupported/); writeFileSync(resolverSnapshot, snapshotBytes);
    readHostedDependencyInstallerProfile();
    results.push({ scenario: "private_network_snapshot_permissions_and_digest", result: "unsafe_and_stale_refused" });
    const inputs = await publicRegistryInputs();
    writeFileSync(workspace + "/package.json", inputs.packageBytes, { flag: "wx", mode: 0o600 });
    writeFileSync(workspace + "/package-lock.json", inputs.lockBytes, { flag: "wx", mode: 0o600 });
    const startId = randomUUID(), plan = createHostedDependencyInstallerPlan(startId,
      qualifyHostedDependencyInstallerInputs(inputs.packageBytes, inputs.lockBytes));
    facts.syntheticCaPreflight = syntheticCaPreflight(plan); // Fixed paths and metadata only.
    facts.npmConfigPreflight = npmConfigPreflight(plan); // Actual distinct immutable config files, never their contents.
    const launch = trustedCustodySystemdLaunch(TrustedCustodyLaunchRole.Installer, startId, plan.stagingDirectory, plan);
    const unit = `subscription-runtime-installer-${startId}.service`;
    try { command(launch.command, launch.args, 12 * 60 * 1000); }
    catch (error) {
      facts.installerFailureDiagnostics = failedInstallerDiagnostics(unit, error);
      try { facts.dropperBoundaryDiagnostic = capabilityDiagnostic(plan, unit, error); }
      catch { facts.dropperBoundaryDiagnostic = { status: "boundary_unresolved_held" }; }
      throw error;
    }
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
    const probeCommand = hostedDependencyInstallerBootstrapCommand(plan);
    const probe = await runObservedProbe(["--quiet", "--wait", "--pipe", `--unit=${probeUnit}`, "--service-type=exec", "--working-directory=/",
      "--property=Slice=subscription-runtime-hosted.slice", "--property=KillMode=control-group",
      ...hostedDependencyInstallerProperties(plan).map(p => "--property=" + p),
      `--property=BindReadOnlyPaths=${artifact}/scripts/dependency-retention-test/probe.ts:/runtime/test-probe.ts:norbind`,
      "--", ...probeCommand.slice(0, -2), plan.profile.nodePath, "--experimental-strip-types", "/runtime/test-probe.ts",
      plan.stagingDirectory, JSON.stringify(sentinels)], probeUnit, plan.rootDirectory, plan.profile.nodePath);
    const probeEvidence: unknown = JSON.parse(probe.output.trim());
    assert.deepEqual(probeEvidence, { schemaVersion: 1, scenario: "typed_installer_root_probe",
      observedIds: { uid: 65532, euid: 65532, gid: 65532, egid: 65532 }, dependencyRead: "passed", sentinelDenial: "passed" });
    assertInstallerTerminalUnit(probeUnit);
    observeInstallerCgroupEmpty("/sys/fs/cgroup/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/" + probeUnit);
    results.push({ scenario: "installer_root_dependency_read_and_sentinel_denial", result: "passed", unit: probeUnit, probeEvidence,
      actualCredentials: probe.credentials });
    for (const relative of ["mount-workspace/node_modules/mounted", "mount-external", "mount-trash"]) privateDirectory(root + "/" + relative);
    writeFileSync(root + "/mount-workspace/node_modules/original", "original TEST tree\n", { flag: "wx", mode: 0o600 });
    writeFileSync(root + "/mount-external/sentinel", "external TEST original\n", { flag: "wx", mode: 0o600 });
    const initialNamespaces = initialBindCanaryNamespaces(); // Kernel facts, never a caller-supplied authority flag.
    facts.bindCanaryInitialNamespaces = initialNamespaces;
    try {
      command("/usr/bin/unshare", ["--user", "--map-root-user", "--mount", "--fork", "--",
        process.execPath, "--experimental-strip-types", script, "mount-veto", root, initialNamespaces.mount, initialNamespaces.user]);
    } catch (error) {
      facts.bindCanaryFailure = error instanceof TestCommandFailure ? { status: error.status, completed: error.completed,
        diagnostics: error.runtime } : { status: null, completed: false };
      throw error;
    }
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
  try { await sameDeviceBindVeto(process.argv[3] ?? "", process.argv[4] ?? "", process.argv[5] ?? ""); }
  catch { process.exitCode = 1; }
} else {
  await run();
}
