import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";

export const runtime = "/opt/subscription-runtime-dependency-os-TEST";
export const policy = "/var/lib/subscription-runtime-host-policy";
export const node = runtime + "/toolchain/bin/node";
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
    "hosted_activation_evidence_invalid", "hosted_activation_authority_required", "hosted_process_admission_required",
    "hosted_process_activation_invalid", "dependency_cleanup_unresolved", "dependency_profile_unsupported", "dependency_environment_busy",
    "dependency_needs_install", "dependency_tree_unsafe", "TEST_provider_protocol_or_probe_failed", "TEST_provider_deadline"];
  const sourceFiles = ["hosted-readonly-host-launch-cli", "hosted-readonly-foreground", "hosted-installation-activation",
    "hosted-readonly-host-kernel", "hosted-readonly-inputs", "hosted-dependency-admission", "hosted-dependency-materialization",
    "hosted-dependency-installer", "hosted-dependency-installer-recipe", "hosted-process-activation", "codex-goal-cli"];
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
if (process.argv[2] === "supervisor" && process.argv[1] === runtime + "/scripts/dependency-retention-os-test/common.ts") {
  json(runtime + "/guest-started.json", { schemaVersion: 1, purpose: "TEST_bootstrap_observation_only",
    sourceSha: process.env.TEST_SOURCE_SHA, machineId: readFileSync("/etc/machine-id", "utf8").trim(), pid: process.pid });
  const child = spawn(node, ["--experimental-strip-types", runtime + "/scripts/dependency-retention-os-test/guest.ts", "qualify"],
    { env: { ...cleanEnv, TEST_SOURCE_SHA: process.env.TEST_SOURCE_SHA }, stdio: ["pipe", "pipe", "pipe"] });
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
