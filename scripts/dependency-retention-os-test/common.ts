import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";

export const runtime = "/opt/subscription-runtime-dependency-os-TEST";
export const policy = "/var/lib/subscription-runtime-host-policy";
export const node = runtime + "/toolchain/bin/node";
// Closed TEST modes use erasable syntax supported by the existing pinned runner.
export const OwnedOsScenario = { Dependency: "dependency", Readonly: "readonly" } as const;
export type OwnedOsScenario = typeof OwnedOsScenario[keyof typeof OwnedOsScenario];
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
    "dependency_needs_install", "dependency_tree_unsafe", "hosted_fd_profile_invalid", "hosted_fd_boundary_unresolved",
    "hosted_fd_launch_invalidated", "hosted_fd_input_overflow", "TEST_provider_protocol_or_probe_failed", "TEST_provider_deadline"];
  const sourceFiles = ["hosted-readonly-host-launch-cli", "hosted-readonly-foreground", "hosted-installation-activation",
    "hosted-readonly-host-kernel", "hosted-readonly-inputs", "hosted-dependency-admission", "hosted-dependency-materialization",
    "hosted-dependency-installer", "hosted-dependency-installer-recipe", "hosted-process-activation", "codex-goal-cli", "system-bus-infrastructure",
    "hosted-fd-observation", "hosted-fd-launch", "hosted-fd-fence"];
  return { ...setupDiagnostic(text), reasons: reasons.filter(reason => new RegExp(`(?:^|[^A-Za-z0-9_])${reason}(?:$|[^A-Za-z0-9_])`).test(text)),
    unitSetup: ["Failed to start transient service unit", "Failed to create bus connection", "Failed to connect to bus",
      "Failed to execute", "Failed at step", "Unit subscription-runtime-hosted.slice not found"].filter(value => text.includes(value)),
    locations: text.split("\n").slice(-32).flatMap(line => sourceFiles.flatMap(file => {
      const match = new RegExp(`/(${file}\\.js):(\\d+):(\\d+)\\)?$`).exec(line.trim());
      return match ? [{ file: match[1]!, line: Number(match[2]), column: Number(match[3]) }] : [];
    })).slice(0, 16) };
}
export const digest = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
export function command(file: string, args: readonly string[], timeout = 30000, cwd = "/"): string {
  const result = spawnSync(file, [...args], { cwd, env: cleanEnv, encoding: "utf8", timeout,
    maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  assert(!result.error && result.status === 0 && result.signal === null,
    `TEST command failed: ${file}, status=${result.status}, signal=${result.signal}`);
  return result.stdout;
}
export function directory(path: string, mode = 0o700): void {
  mkdirSync(path, { recursive: true, mode });
  assert.equal(realpathSync(path), path);
  const stat = lstatSync(path); assert.equal(stat.uid, 0); assert.equal(stat.mode & 0o777, mode);
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
export function installedArtifactDigest(): string {
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
  return digest(JSON.stringify(entries));
}

// Only the fixed guest service invokes this builtin-only bootstrap. Production
// module imports belong to the child so even an import/ELF failure is observable.
if (process.argv[2] === "control-sink" && process.argv[1] === runtime + "/scripts/dependency-retention-os-test/common.ts") {
  assert.equal(process.argv.length, 3); assert.equal(process.execPath, node); assert(process.send && process.connected);
  const { readHostedReadonlyHostInventory } = await import("../../dist/worker-codex/hosted-readonly-host-kernel.js");
  const { HostedInstallationActivationStore } = await import("../../dist/worker-codex/hosted-installation-activation.js");
  const { hostedFdLaunch, hostedFdInvocationUnit, HostedFdLaunchKind, spawnHostedFdChild } =
    await import("../../dist/provider-codex/app-server/adapters/hosted-fd-launch.js");
  const { retryHostedFenceAcquisition } = await import("../../dist/provider-codex/app-server/adapters/hosted-fd-fence.js");
  const { requireHostedForegroundRequest, publishHostedForegroundResult, hostedForegroundExitCode } =
    await import("../../dist/worker-codex/hosted-foreground-result.js");
  const store = new HostedInstallationActivationStore(), launch = readHostedReadonlyHostInventory().runtimeLaunch;
  const request = requireHostedForegroundRequest(launch.args, launch.cwd);
  const child = store.runOrdinaryRuntimeLaunch(launch.command, launch.args, launch.cwd, actual =>
    spawnHostedFdChild(actual.command, actual.args, { cwd: launch.cwd }, hostedFdInvocationUnit(actual.args), HostedFdLaunchKind.Foreground));
  const closed = new Promise<void>((resolve, reject) => {
    child.once("error", reject); child.once("close", (code, signal) => code === 0 && signal === null ? resolve() : reject(new Error("TEST control-sink child failed")));
  });
  void closed.catch(() => {});
  const guard = hostedFdLaunch(child); child.stdin!.on("error", () => {});
  const timeout = setTimeout(() => { guard.invalidate(); child.kill("SIGTERM"); }, 6 * 60000);
  try {
    await guard.observe();
    // This IPC barrier delays TEST observation only. It supplies no fence,
    // owner/Ready/peer facts, and the product revalidates after the acknowledgment.
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("TEST control-sink observation timeout")), 5000);
      const receive = (value: unknown) => {
        assert.deepEqual(value, { phase: ControlSinkPhase.Release });
        clearTimeout(timeout); process.off("message", receive); resolve();
      };
      process.on("message", receive);
      process.send!({ phase: ControlSinkPhase.Observed, outputPaths: guard.outputPaths });
    });
    await retryHostedFenceAcquisition(() => store.releaseOrdinaryRuntimeFrame((fence, revalidate) =>
      guard.release(fence, Buffer.from(JSON.stringify({ schemaVersion: 1,
        env: { ...cleanEnv, SUBSCRIPTION_RUNTIME_SANDBOX_KIND: "hosted-codex-job" } })), true, revalidate)), guard.remainingSetupMs());
    await closed; store.recordOrdinaryRuntimeWaitCompletion();
    const facts = guard.foregroundResult();
    const result = store.withOrdinaryForegroundTerminal(facts, owner =>
      publishHostedForegroundResult(request, facts, owner));
    assert.equal(hostedForegroundExitCode(result), 0); assert(store.releaseOrdinaryDependencyConsumer());
    process.send!({ phase: ControlSinkPhase.Drained, outputPaths: guard.outputPaths });
    process.disconnect();
  } catch {
    guard.invalidate(); try { store.requestOrdinaryDependencyCleanup(); } catch { /* Retained uncertainty survives. */ }
    process.exitCode = 70; process.disconnect();
  } finally { clearTimeout(timeout); }
}
if (process.argv[2] === "fd-qualification" && process.argv[1] === runtime + "/scripts/dependency-retention-os-test/common.ts") {
  // Waiting fixture only: no job, provider, authority import or payload. Its real
  // retained stdio endpoints qualify kernel collection before profile issuance.
  assert.equal(process.argv.length, 3); assert.equal(realpathSync(process.execPath), node);
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
  const child = spawn(node, ["--experimental-strip-types", runtime + "/scripts/dependency-retention-os-test/guest.ts", "qualify"],
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
  child.stdin.on("error", () => {}); child.stdin.end();
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
