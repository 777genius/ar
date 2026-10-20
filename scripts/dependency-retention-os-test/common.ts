import { originalFullGuestNativeSourcePaths } from "../../dist/provider-codex/app-server/adapters/hosted-full-guest-source-inventory.js";
import { mkdtemp, open, readFile, rename, rm } from "node:fs/promises";
import { once } from "node:events";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";

export const runtime = "/opt/subscription-runtime-dependency-os-TEST";
// Exact load-only static closure of the CurrentDependency backing collector.
// This runtime-relative catalog is separate from the installed launcher profile.
export const currentBackingRuntimeModules = Object.freeze([
  ...originalFullGuestNativeSourcePaths,
  "src/worker-codex/hosted-full-backing-proc.js",
]);
export const policy = "/var/lib/subscription-runtime-host-policy";
export const node = runtime + "/toolchain/bin/node";
// Closed TEST modes use erasable syntax supported by the existing pinned runner.
export const OwnedOsScenario = { Dependency: "dependency", Readonly: "readonly", CurrentDependency: "current-dependency" } as const;
export type OwnedOsScenario = typeof OwnedOsScenario[keyof typeof OwnedOsScenario];
export const OwnedOsMode = { Qualification: "qualification", BusDiagnostic: "bus-startup-diagnostic", ReadonlyLauncher: "readonly-launcher-closure" } as const;
export type OwnedOsMode = typeof OwnedOsMode[keyof typeof OwnedOsMode];
/** Selects TEST scenarios only; it supplies no kernel or launch authority. */
export function ownedOsScenarios(mode: OwnedOsMode): readonly OwnedOsFixtureScenario[] {
  switch (mode) {
    case OwnedOsMode.Qualification: return Object.freeze([OwnedOsScenario.Dependency, OwnedOsScenario.Readonly]);
    case OwnedOsMode.ReadonlyLauncher: return Object.freeze([OwnedOsScenario.Readonly]);
    case OwnedOsMode.BusDiagnostic: return Object.freeze([OwnedOsMode.BusDiagnostic]);
    default: throw new Error("unknown owned OS TEST mode");
  }
}
export type OwnedOsFixtureScenario = OwnedOsScenario | typeof OwnedOsMode.BusDiagnostic;
export const busDiagnosticSink = "/var/lib/subscription-runtime-TEST-observation/dbus-startup.stderr";
export const busDiagnosticDropInPath = "/etc/systemd/test-units/dbus.service.d/TEST-stderr.conf";
export const busDiagnosticDropIn = `[Unit]\nStartLimitBurst=1\nStartLimitIntervalSec=infinity\n[Service]\nStandardError=append:${busDiagnosticSink}\nLimitFSIZE=65536\nLimitCORE=0\n`;
export const readonlyStorage = "/mnt/TEST-retention-readonly-storage";
export const ControlSinkPhase = { Observed: "observed", Release: "release", Drained: "drained" } as const;
export const cleanEnv = { PATH: runtime + "/toolchain/bin:/usr/bin:/bin", LANG: "C", LC_ALL: "C", SYSTEMD_COLORS: "0" };
// Fixed diagnostic/package set. Unknown ELF requirements remain unsupported;
// data from subprocesses never becomes an arbitrary package or executable name.
export const elfPackages = {
  "libstdc++.so.6": "libstdc++6", "libgcc_s.so.1": "libgcc-s1", "libc.so.6": "libc6", "libm.so.6": "libc6",
  "libpthread.so.0": "libc6", "libdl.so.2": "libc6", "librt.so.1": "libc6", "ld-linux-x86-64.so.2": "libc6",
  "libatomic.so.1": "libatomic1", "libz.so.1": "zlib1g",
} as const;
export function setupDiagnostic(text: string) {
  const classes = ["error while loading shared libraries", "cannot open shared object file", "No such file or directory",
    "Failed to execute", "Failed at step", "Permission denied", "Operation not permitted", "Cannot assign requested address",
    "Failed to create cgroup", "Failed to mount", "Failed to connect to bus", "Failed to start",
    "ERR_MODULE_NOT_FOUND", "ERR_UNKNOWN_FILE_EXTENSION", "SyntaxError", "ReferenceError", "AssertionError"];
  return { classifications: classes.filter(value => text.includes(value)),
    libraryNames: Object.keys(elfPackages).filter(value => text.includes(value)) };
}
export function runtimeDiagnostic(text: string) {
  const reasons = ["hosted_custody_launch_denied", "hosted_custody_launch_failed", "hosted_custody_runtime_reconciliation_required",
    "hosted_custody_runtime_bootstrap_denied", "hosted_custody_kernel_evidence_invalid", "hosted_readonly_policy_invalid",
    "hosted_activation_evidence_invalid", "hosted_activation_authority_required", "system_bus_infrastructure_invalid", "system_bus_infrastructure_unqualified", "hosted_process_admission_required",
    "hosted_process_activation_invalid", "dependency_cleanup_unresolved", "dependency_profile_unsupported", "dependency_environment_busy",
    "dependency_needs_install", "dependency_tree_unsafe", "dependency_installer_unresolved", "hosted_fd_profile_invalid", "hosted_fd_boundary_unresolved",
    "hosted_fd_launch_invalidated", "hosted_fd_input_overflow", "TEST_provider_protocol_or_probe_failed", "TEST_provider_deadline",
    "hosted_readonly_operator_action_failed", "hosted_readonly_host_operator_required", "hosted_readonly_authority_invalid",
    "hosted_readonly_managed_grant_required", "hosted_readonly_independent_review_required", "hosted_readonly_verified_stage_required",
    "hosted_readonly_revoked", "hosted_custody_enrollment_mismatch", "hosted_custody_durable_authority_required",
    "hosted_custody_creator_not_fenced", "hosted_activation_publication_recovery_required", "hosted_test_egress_custody_invalid"];
  const sourceFiles = ["hosted-readonly-host-launch-cli", "hosted-readonly-foreground", "hosted-installation-activation",
    "hosted-readonly-host-kernel", "hosted-readonly-inputs", "hosted-dependency-admission", "hosted-dependency-materialization",
    "hosted-dependency-installer", "hosted-dependency-installer-recipe", "hosted-process-activation", "codex-goal-cli", "system-bus-infrastructure",
    "hosted-fd-observation", "hosted-fd-launch", "hosted-fd-fence", "hosted-readonly-inputs-cli", "hosted-readonly-authority",
    "hosted-readonly-custody", "hosted-readonly-epoch-store", "hosted-readonly-supervisor-host",
    "hosted-readonly-linux-collector", "hosted-readonly-observations", "hosted-test-egress-files", "fd-collector-profile"];
  return { ...setupDiagnostic(text), reasons: reasons.filter(reason => new RegExp(`(?:^|[^A-Za-z0-9_])${reason}(?:$|[^A-Za-z0-9_])`).test(text)),
    unitSetup: ["Failed to start transient service unit", "Failed to create bus connection", "Failed to connect to bus",
      "Failed to execute", "Failed at step", "Unit subscription-runtime-hosted.slice not found"].filter(value => text.includes(value)),
    locations: text.split("\n").slice(-32).flatMap(line => sourceFiles.flatMap(file => {
      const match = new RegExp(`/(${file}\\.js):(\\d+):(\\d+)\\)?$`).exec(line.trim());
      return match ? [{ file: match[1]!, line: Number(match[2]), column: Number(match[3]) }] : [];
    })).slice(0, 16) };
}
export const digest = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
type CommandFailure = { status: number | null; signal: NodeJS.Signals | null; diagnostic: ReturnType<typeof runtimeDiagnostic> };
// Position 5 is either a TMPDIR override (CurrentDependency callers) or a
// failure observer (readonly launcher callers); the union preserves both APIs.
export function command(file: string, args: readonly string[], timeout = 30000, cwd = "/",
  fifth?: string | ((failure: CommandFailure) => void), tmpdir?: string): string {
  const onFailure = typeof fifth === "function" ? fifth : undefined;
  const temporary = typeof fifth === "string" ? fifth : tmpdir;
  const result = spawnSync(file, [...args], { cwd, env: temporary === undefined ? cleanEnv : { ...cleanEnv, TMPDIR: temporary }, encoding: "utf8", timeout,
    maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  if (result.error || result.status !== 0 || result.signal !== null) {
    onFailure?.({ status: result.status, signal: result.signal, diagnostic: runtimeDiagnostic((result.stdout ?? "") + "\n" + (result.stderr ?? "")) });
  }
  assert(!result.error && result.status === 0 && result.signal === null,
    `TEST command failed: ${file}, status=${result.status}, signal=${result.signal}`);
  return result.stdout;
}
export function directory(path: string, mode = 0o700): void {
  mkdirSync(path, { recursive: true, mode });
  assert.equal(realpathSync(path), path);
  const stat = lstatSync(path); assert.equal(stat.uid, 0); assert.equal(stat.mode & 0o7777, mode);
}
export function json(path: string, value: unknown, mode = 0o600): void {
  const temporary = path + "." + randomUUID() + ".tmp";
  writeFileSync(temporary, JSON.stringify(value) + "\n", { flag: "wx", mode });
  linkSync(temporary, path); unlinkSync(temporary);
}
export function fileDigest(path: string): string { return digest(readFileSync(path)); }
export function directoryIdentity(path: string) {
  const stat = lstatSync(path, { bigint: true }); assert(stat.isDirectory() && !stat.isSymbolicLink());
  return { canonicalPath: path, dev: String(stat.dev), ino: String(stat.ino) };
}
// Existing current/registration callers retain the full inventory; CLOSED
// dependency/readonly guests select their actual composed scenario explicitly.
export function installedArtifactDigest(scenario: OwnedOsScenario = OwnedOsScenario.CurrentDependency): string {
  const entries: unknown[] = []; let count = 0, size = 0; const deadline = Date.now() + 30000;
  function walk(path: string): void {
    assert(++count <= 200000 && Date.now() < deadline);
    const stat = lstatSync(path); assert.equal(stat.uid, 0);
    assert(stat.isSymbolicLink() || (stat.mode & 0o022) === 0);
    const relative = path.slice(runtime.length + 1);
    if (stat.isDirectory()) {
      entries.push([relative, "directory", stat.mode & 0o7777]);
      for (const name of readdirSync(path).sort()) walk(path + "/" + name);
    } else if (stat.isSymbolicLink()) {
      assert(realpathSync(path).startsWith(runtime + "/"));
      entries.push([relative, "symlink", readlinkSync(path)]);
    } else {
      assert(stat.isFile() && stat.nlink === 1 && (size += stat.size) <= 2 * 1024 * 1024 * 1024);
      entries.push([relative, "file", stat.mode & 0o7777, stat.size, fileDigest(path)]);
    }
  }
  for (const name of ["dist", "packages", "node_modules", "scripts", "package.json", "toolchain"]) walk(runtime + "/" + name);
  if (scenario === OwnedOsScenario.CurrentDependency)
    for (const relative of currentBackingRuntimeModules) walk(runtime + "/" + relative);
  return digest(JSON.stringify(entries));
}

// Only the fixed guest service invokes this builtin-only bootstrap. Production
// module imports belong to the child so even an import/ELF failure is observable.
if (process.argv[2] === "control-sink" && process.argv[1] === runtime + "/scripts/dependency-retention-os-test/common.ts") {
  // Closed-fact TEST diagnostics only: one stage token and one classified exit
  // code. No payload, path or raw error text is ever recorded, and these facts
  // have no authority or effect on production gates.
  let stage = "argv_identity", requestFdCountBefore = -1, requestFdCountAfter = -1;
  const diagnostic = (exitClass: string) => {
    try { writeFileSync("/run/TEST-control-sink-diagnostic.json", JSON.stringify({ schemaVersion: 1, stage, exitClass,
      requestFdCountBefore, requestFdCountAfter }) + "\n", { mode: 0o600 }); }
    catch { /* TEST-only diagnostic. */ }
  };
  const classifyExit = (error: unknown): string => {
    if (error instanceof Error && (error as { code?: unknown }).code === "ERR_ASSERTION") return "assertion";
    const known: Record<string, string> = {
      hosted_foreground_result_unresolved: "request_unresolved", hosted_fd_launch_invalidated: "launch_invalidated",
      hosted_fd_input_overflow: "input_overflow", child_invocation_consumed: "invocation_consumed",
      hosted_readonly_host_operator_required: "operator_required", hosted_readonly_authority_invalid: "authority_invalid",
      hosted_activation_invalid: "activation_invalid", hosted_activation_evidence_invalid: "activation_evidence_invalid",
      hosted_activation_publication_recovery_required: "publication_recovery_required",
      hosted_activation_stop_incomplete: "activation_stop_incomplete", hosted_activation_authority_required: "activation_authority_required",
      hosted_ordinary_owned_unresolved: "owned_unresolved", hosted_custody_inherited_handle_denied: "descriptor_denied",
      hosted_custody_stdio_pipe_required: "stdio_pipe_required", hosted_custody_descriptor_invalid: "descriptor_invalid",
      hosted_custody_launch_frame_invalid: "frame_invalid", hosted_custody_creator_not_fenced: "creator_not_fenced",
      hosted_custody_stop_incomplete: "custody_stop_incomplete", hosted_fd_boundary_unresolved: "fd_boundary_unresolved"
    };
    const code = error instanceof Error ? error.message : "";
    return code in known ? known[code]! : error instanceof Error ? "unclassified" : "non_error_throw";
  };
  try {
    assert.equal(process.argv.length, 3); assert.equal(process.execPath, node); assert(process.send && process.connected);
    stage = "imports";
    const { readHostedReadonlyHostInventory } = await import("../../dist/worker-codex/hosted-readonly-host-kernel.js");
    const { HostedInstallationActivationStore } = await import("../../dist/worker-codex/hosted-installation-activation.js");
    const { hostedFdLaunch, hostedFdInvocationUnit, HostedFdLaunchKind, spawnHostedFdChild } =
      await import("../../dist/provider-codex/app-server/adapters/hosted-fd-launch.js");
    const { retryHostedFenceAcquisition } = await import("../../dist/provider-codex/app-server/adapters/hosted-fd-fence.js");
    const { requireHostedForegroundRequest, publishHostedForegroundResult, hostedForegroundExitCode } =
      await import("../../dist/worker-codex/hosted-foreground-result.js");
    stage = "inventory";
    const store = new HostedInstallationActivationStore(), launch = readHostedReadonlyHostInventory().runtimeLaunch;
    stage = "foreground_request";
    requestFdCountBefore = readdirSync("/proc/self/fd").length;
    const request = requireHostedForegroundRequest(launch.args, launch.cwd);
    requestFdCountAfter = readdirSync("/proc/self/fd").length;
    stage = "ordinary_launch";
    const child = store.runOrdinaryRuntimeLaunch(launch.command, launch.args, launch.cwd, actual => {
      stage = "spawn_submit";
      const submitted = spawnHostedFdChild(actual.command, actual.args, { cwd: launch.cwd }, hostedFdInvocationUnit(actual.args), HostedFdLaunchKind.Foreground);
      stage = "spawn_returned";
      return submitted;
    });
    stage = "guard";
    const closed = new Promise<void>((resolve, reject) => {
      child.once("error", reject); child.once("close", (code, signal) => code === 0 && signal === null ? resolve() : reject(new Error("TEST control-sink child failed")));
    });
    void closed.catch(() => {});
    const guard = hostedFdLaunch(child); child.stdin!.on("error", () => {});
    const timeout = setTimeout(() => { guard.invalidate(); child.kill("SIGTERM"); }, 6 * 60000);
    try {
      stage = "observe";
      await guard.observe();
      // This IPC barrier delays TEST observation only. It supplies no fence,
      // owner/Ready/peer facts, and the product revalidates after the acknowledgment.
      stage = "observed_ipc";
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("TEST control-sink observation timeout")), 5000);
        const receive = (value: unknown) => {
          assert.deepEqual(value, { phase: ControlSinkPhase.Release });
          clearTimeout(timeout); process.off("message", receive); resolve();
        };
        process.on("message", receive);
        process.send!({ phase: ControlSinkPhase.Observed, outputPaths: guard.outputPaths });
      });
      stage = "release";
      await retryHostedFenceAcquisition(() => store.releaseOrdinaryRuntimeFrame((fence, revalidate) =>
        guard.release(fence, Buffer.from(JSON.stringify({ schemaVersion: 1,
          env: { ...cleanEnv, SUBSCRIPTION_RUNTIME_SANDBOX_KIND: "hosted-codex-job" } })), true, revalidate)), guard.remainingSetupMs());
      stage = "wait_completion";
      await closed; store.recordOrdinaryRuntimeWaitCompletion();
      stage = "foreground_result";
      const facts = guard.foregroundResult();
      stage = "publish";
      const result = store.withOrdinaryForegroundTerminal(facts, owner =>
        publishHostedForegroundResult(request, facts, owner));
      stage = "consumer_release";
      assert.equal(hostedForegroundExitCode(result), 0); assert(store.releaseOrdinaryDependencyConsumer());
      stage = "drained_ipc";
      process.send!({ phase: ControlSinkPhase.Drained, outputPaths: guard.outputPaths });
      stage = "disconnect";
      process.disconnect();
    } catch {
      guard.invalidate(); try { store.requestOrdinaryDependencyCleanup(); } catch { /* Retained uncertainty survives. */ }
      process.exitCode = 70; process.disconnect();
    } finally { clearTimeout(timeout); }
    diagnostic(process.exitCode ? "inner_guard_failure" : "clean");
  } catch (error) { diagnostic(classifyExit(error)); throw error; }
}
if (process.argv[2] === "fd-io-child" && process.argv[1] === runtime + "/scripts/dependency-retention-os-test/common.ts") {
  assert.equal(process.argv.length, 3); assert.equal(realpathSync(process.execPath), node);
  let input = ""; const timer = setTimeout(() => process.exit(70), 5000);
  process.stdin.setEncoding("utf8"); process.stdin.on("data", chunk => {
    input += String(chunk); if (input.length > 32) process.exit(70);
  });
  process.stdin.once("end", () => { assert.equal(input, "TEST_pipe_fallback\n");
    process.stdout.end(input, () => clearTimeout(timer)); });
}
if (process.argv[2] === "fd-qualification" && process.argv[1] === runtime + "/scripts/dependency-retention-os-test/common.ts") {
  assert.equal(process.argv.length, 3); assert.equal(realpathSync(process.execPath), node);
  // Genuine async FS/threadpool and pipe/child IO under the pre-exec recipe.
  // Only newly owned TEST data; fixed pinned child, no job/account/dependency.
  const ioTimer = setTimeout(() => process.exit(70), 10000);
  const scratch = await mkdtemp("/tmp/TEST-fd-io-");
  try {
    const file = await open(scratch + "/before", "wx", 0o600);
    try { await file.writeFile("TEST_async_fsync_rename_readback\n"); await file.sync(); }
    finally { await file.close(); }
    await rename(scratch + "/before", scratch + "/after");
    assert.equal(await readFile(scratch + "/after", "utf8"), "TEST_async_fsync_rename_readback\n");
    const child = spawn(node, ["--experimental-strip-types", runtime + "/scripts/dependency-retention-os-test/common.ts", "fd-io-child"],
      { env: cleanEnv, stdio: ["pipe", "pipe", "pipe"] });
    const closed = once(child, "close"); let output = "", errors = "";
    child.stdout.on("data", chunk => { output += String(chunk); assert(output.length <= 32); });
    child.stderr.on("data", chunk => { errors += String(chunk); assert(errors.length <= 1024); });
    child.stdin.end("TEST_pipe_fallback\n");
    const [code, signal] = await closed; assert.equal(code, 0); assert.equal(signal, null);
    assert.equal(errors, ""); assert.equal(output, "TEST_pipe_fallback\n");
  } finally { await rm(scratch, { recursive: true }); clearTimeout(ioTimer); }
  // The unchanged waiting marker now follows measured fallback effects. Real
  // retained stdio endpoints qualify collection before profile issuance.
  process.stdin.on("error", () => process.exit(70));
  process.stdout.on("error", () => process.exit(70));
  process.stdin.once("data", () => process.stdout.write("TEST_fd_payload_executed\n"));
  process.stdin.resume(); process.stdin.once("end", () => process.exit(0));
  process.stdout.write("TEST_fd_waiting\n");
  setTimeout(() => process.exit(70), 15000);
}
if (process.argv[2] === "supervisor" && process.argv[1] === runtime + "/scripts/dependency-retention-os-test/common.ts") {
  json(runtime + "/guest-started.json", { schemaVersion: 1, purpose: "TEST_bootstrap_observation_only",
    sourceSha: process.env.TEST_SOURCE_SHA, machineId: readFileSync("/etc/machine-id", "utf8").trim(), pid: process.pid });
  const guest = process.env.TEST_OS_SCENARIO === OwnedOsScenario.CurrentDependency ? "registration-guest.js" : "guest.ts";
  const administrativeSpawn = guest === "registration-guest.js" ? (await import("./current-administrative-installation.js")).retainOriginalAdministrativeGuestSpawn() : undefined;
  const child = spawn(node, ["--experimental-strip-types", runtime + "/scripts/dependency-retention-os-test/" + guest, "qualify"],
    { env: { ...cleanEnv, TEST_SOURCE_SHA: process.env.TEST_SOURCE_SHA,
      TEST_OS_SCENARIO: process.env.TEST_OS_SCENARIO }, stdio: ["pipe", "pipe", "pipe"] });
  const classifications = new Set<string>(), libraryNames = new Set<string>(), reasons = new Set<string>(), unitSetup = new Set<string>();
  const locations = new Map<string, { file: string; line: number; column: number }>();
  const tails = { stdout: "", stderr: "" }, observedBytes = { stdout: 0, stderr: 0 };
  const collect = (stream: "stdout" | "stderr", chunk: Buffer) => {
    observedBytes[stream] += chunk.length; tails[stream] = (tails[stream] + chunk.toString("utf8")).slice(-4096);
    const diagnostic = runtimeDiagnostic(tails[stream]);
    diagnostic.classifications.forEach(value => classifications.add(value)); diagnostic.libraryNames.forEach(value => libraryNames.add(value));
    diagnostic.reasons.forEach(value => reasons.add(value)); diagnostic.unitSetup.forEach(value => unitSetup.add(value));
    diagnostic.locations.forEach(value => { if (locations.size < 16) locations.set(JSON.stringify(value), value); });
  };
  child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk));
  child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk));
  child.stdin.on("error", () => {});
  if(administrativeSpawn){assert(child.pid);administrativeSpawn.sealChild(child.pid);child.stdin.end("FIXED_ADMINISTRATIVE_PRODUCER_READY\n");}
  else child.stdin.end();
  const timeout = setTimeout(() => child.kill("SIGTERM"), 21 * 60 * 1000);
  const failed = (reason: "spawn_failed" | "child_exited_without_evidence", code: number | null, signal: string | null) => {
    clearTimeout(timeout); tails.stdout = ""; tails.stderr = "";
    if (!existsSync(runtime + "/guest-output-observation.json")) json(runtime + "/guest-output-observation.json", {
      schemaVersion: 1, purpose: "TEST_output_classification_only", sourceSha: process.env.TEST_SOURCE_SHA, observedBytes,
      code, signal, classifications: [...classifications].sort(), libraryNames: [...libraryNames].sort(),
      reasons: [...reasons].sort(), unitSetup: [...unitSetup].sort(), locations: [...locations.values()] });
    if (!existsSync(runtime + "/guest-evidence.json") && !existsSync(runtime + "/guest-child-exit.json"))
      json(runtime + "/guest-child-exit.json", { schemaVersion: 1, purpose: "TEST_child_failure_observation_only",
        sourceSha: process.env.TEST_SOURCE_SHA, reason, code, signal, classifications: [...classifications].sort(), libraryNames: [...libraryNames].sort() });
  };
  child.once("close", (code, signal) => failed("child_exited_without_evidence", code, signal));
  child.once("error", () => failed("spawn_failed", null, null));
  setInterval(() => {}, 60000);
}
