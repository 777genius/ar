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
  const classifications = new Set<string>(), libraryNames = new Set<string>(); let tail = "";
  child.stderr.on("data", (chunk: Buffer) => {
    tail = (tail + chunk.toString("utf8")).slice(-4096);
    const diagnostic = setupDiagnostic(tail);
    diagnostic.classifications.forEach(value => classifications.add(value)); diagnostic.libraryNames.forEach(value => libraryNames.add(value));
  });
  child.stdin.on("error", () => {}); child.stdin.end(); child.stdout.resume();
  const timeout = setTimeout(() => child.kill("SIGTERM"), 21 * 60 * 1000);
  const failed = (reason: "spawn_failed" | "child_exited_without_evidence", code: number | null, signal: string | null) => {
    clearTimeout(timeout); tail = "";
    if (!existsSync(runtime + "/guest-evidence.json") && !existsSync(runtime + "/guest-child-exit.json"))
      json(runtime + "/guest-child-exit.json", { schemaVersion: 1, purpose: "TEST_child_failure_observation_only",
        sourceSha: process.env.TEST_SOURCE_SHA, reason, code, signal, classifications: [...classifications].sort(), libraryNames: [...libraryNames].sort() });
  };
  child.once("exit", (code, signal) => failed("child_exited_without_evidence", code, signal));
  child.once("error", () => failed("spawn_failed", null, null));
  setInterval(() => {}, 60000);
}
