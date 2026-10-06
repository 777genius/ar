/** Closed TEST qualification only; no production command or permit surface. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, cpSync, lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { assertPinnedSystemBusQueryTool, assertSystemdManagerOwner, assertSystemdIoUringPolicy }
  from "../../dist/provider-codex/app-server/adapters/systemd-service-arrays.js";
import { verifySystemBusInfrastructure } from "../../dist/provider-codex/app-server/adapters/system-bus-infrastructure.js";
import type { SystemBusInfrastructure } from "../../dist/core/index.js";
import { cleanEnv, digest, fileDigest, json, node, runtime } from "./common.ts";
const fixture = runtime + "/scripts/dependency-retention-os-test/io-uring-probe.c";
const binary = runtime + "/TEST-io-uring-probe";
const manifest = runtime + "/TEST-io-uring-probe.json";
type Pin = { path: string; sha256: string };
type ProbeManifest = { schemaVersion: 1; source: Pin; compiler: Pin & { version: string };
  elf: Pin; loaderClosure: Pin[] };
function pin(path: string): Pin {
  assert.equal(realpathSync(path), path);
  for (let parent = dirname(path);; parent = dirname(parent)) {
    const stat = lstatSync(parent); assert(stat.isDirectory() && stat.uid === 0 && !(stat.mode & 0o022));
    if (parent === "/") break;
  }
  const before = lstatSync(path);
  assert(before.isFile() && before.uid === 0 && before.nlink === 1 && !(before.mode & 0o022) &&
    before.size > 0 && before.size <= 32 * 1024 * 1024);
  const sha256 = fileDigest(path), after = lstatSync(path);
  assert(before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
    before.ctimeMs === after.ctimeMs && before.mtimeMs === after.mtimeMs && before.mode === after.mode);
  return { path, sha256 };
}
function elf(path: string): Pin {
  const result = pin(path), bytes = readFileSync(path);
  assert(bytes.length >= 64 && bytes.subarray(0, 7).equals(Buffer.from([127, 69, 76, 70, 2, 1, 1])) &&
    bytes.readUInt16LE(18) === 62 && (lstatSync(path).mode & 0o111));
  assert.equal(pin(path).sha256, result.sha256); return result;
}
function readManifest(root = ""): ProbeManifest {
  const before = pin(root + manifest), bytes = readFileSync(root + manifest);
  assert(bytes.length < 16384); const value = JSON.parse(bytes.toString("utf8")) as ProbeManifest;
  assert.equal(pin(root + manifest).sha256, before.sha256);
  assert(value.schemaVersion === 1 && value.source.path === fixture && value.elf.path === binary &&
    value.compiler.path.startsWith("/usr/bin/") && /^[a-f0-9]{64}$/.test(value.compiler.sha256) &&
    value.compiler.version.length > 0 && value.compiler.version.length <= 4096 && value.loaderClosure.length === 2);
  assert.equal(pin(root + fixture).sha256, value.source.sha256);
  assert.equal(elf(root + binary).sha256, value.elf.sha256);
  assert.equal(new Set(value.loaderClosure.map(row => row.path)).size, 2);
  for (const row of value.loaderClosure) {
    assert(/^\/usr\/lib\/x86_64-linux-gnu\/(?:libc\.so\.6|ld-linux-x86-64\.so\.2)$/.test(row.path));
    assert.equal(elf(root + row.path).sha256, row.sha256);
  }
  return value;
}
export function compileIoUringFixture(root: string, state: string,
  command: (path: string, args: readonly string[], timeout?: number) => string): void {
  // The pre-existing outer CI compiler is never installed or copied into guest.
  const compiler = realpathSync("/usr/bin/cc"), compilerPin = elf(compiler), source = pin(root + fixture);
  const version = command(compiler, ["--version"]).trim(); assert(version.length > 0 && version.length <= 4096);
  const output = state + "/TEST-io-uring-probe";
  command(compiler, ["-O2", "-Wall", "-Wextra", "-Werror", "-std=c11", root + fixture, "-o", output]);
  assert.deepEqual(pin(root + fixture), source); assert.deepEqual(elf(compiler), compilerPin);
  elf(output); cpSync(output, root + binary, { errorOnExist: true, force: false }); chmodSync(root + binary, 0o755);
  const linkage = command("/usr/bin/ldd", [root + binary]);
  const paths = [...linkage.matchAll(/(?:=>\s+|^\s*)(\/[^\s]+)\s+\(/gm)].map(row => realpathSync(row[1]!));
  assert.equal(paths.length, 2);
  const signed = JSON.parse(readFileSync(root + runtime + "/os-signed-elf-pins.json", "utf8")) as { pins: Pin[] };
  const loaderClosure = paths.map(path => {
    assert(/^\/usr\/lib\/x86_64-linux-gnu\/(?:libc\.so\.6|ld-linux-x86-64\.so\.2)$/.test(path));
    const current = elf(root + path); assert.equal(current.sha256, signed.pins.find(row => row.path === path)?.sha256);
    return { path, sha256: current.sha256 };
  });
  json(root + manifest, { schemaVersion: 1, source: { path: fixture, sha256: source.sha256 },
    compiler: { ...compilerPin, version }, elf: { path: binary, sha256: elf(root + binary).sha256 }, loaderClosure });
  readManifest(root);
}
export function assertOuterIoUringPins(root: string): ProbeManifest {
  const value = readManifest(root); assert.deepEqual(elf(value.compiler.path), { path: value.compiler.path, sha256: value.compiler.sha256 });
  return value;
}
export function controlIoUringFixture(root: string, remaining: () => number): ProbeManifest {
  const value = assertOuterIoUringPins(root);
  const result = spawnSync("/usr/sbin/chroot", [root, binary, "control"], { env: cleanEnv, cwd: "/", encoding: "utf8",
    timeout: Math.min(5000, remaining()), maxBuffer: 1024, stdio: ["ignore", "pipe", "pipe"] });
  remaining(); assert(!result.error && result.signal === null && result.status === 0 && result.stderr === "" &&
    result.stdout === "TEST_uring_control\n", "TEST io_uring unfiltered control unavailable");
  assert.deepEqual(assertOuterIoUringPins(root), value); return value;
}
export async function qualifyIoUringEffects(bus: SystemBusInfrastructure, remaining: () => number) {
  const before = readManifest(), fragment = "/etc/systemd/test-units/TEST-retention-supervisor.service", fragmentPin = pin(fragment);
  const recipe = readFileSync(fragment, "utf8");
  for (const property of ["SystemCallFilter=~io_uring_setup:ENOSYS io_uring_enter:ENOSYS io_uring_register:ENOSYS",
    "SystemCallArchitectures=native", "NoNewPrivileges=yes"]) assert.equal(recipe.split("\n").filter(row => row === property).length, 1);
  assert(bus.version === 2);
  const parent = /^PPid:\s+([1-9][0-9]*)$/m.exec(readFileSync("/proc/self/status", "utf8"))?.[1]; assert(parent);
  const birth = () => { const stat = readFileSync(`/proc/${parent}/stat`, "utf8");
    const tick = stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/)[19]; assert(tick && /^[1-9][0-9]*$/.test(tick)); return tick; };
  const retainedBirth = birth();
  const policy = () => {
    verifySystemBusInfrastructure(bus, remaining); assertSystemdManagerOwner(bus.queryTool, remaining);
    const result = spawnSync(bus.queryTool.path, ["--address=unix:path=/run/dbus/system_bus_socket", "--no-pager",
      "--auto-start=no", "--allow-interactive-authorization=no", "get-property", "org.freedesktop.systemd1",
      "/org/freedesktop/systemd1/unit/TEST_2dretention_2dsupervisor_2eservice", "org.freedesktop.systemd1.Service",
      "SystemCallFilter", "SystemCallArchitectures", "NoNewPrivileges"], { env: cleanEnv, encoding: "utf8",
      timeout: Math.min(5000, remaining()), maxBuffer: 4096, stdio: ["ignore", "pipe", "pipe"] });
    remaining(); assert(!result.error && !result.signal && result.status === 0 && !result.stderr);
    assertSystemdIoUringPolicy(result.stdout); assertPinnedSystemBusQueryTool(bus.queryTool, remaining);
    const main = spawnSync(bus.queryTool.path, ["--address=unix:path=/run/dbus/system_bus_socket", "--no-pager",
      "--auto-start=no", "--allow-interactive-authorization=no", "get-property", "org.freedesktop.systemd1",
      "/org/freedesktop/systemd1/unit/TEST_2dretention_2dsupervisor_2eservice", "org.freedesktop.systemd1.Service", "MainPID"],
      { env: cleanEnv, encoding: "utf8", timeout: Math.min(5000, remaining()), maxBuffer: 1024, stdio: ["ignore", "pipe", "pipe"] });
    remaining(); assert(!main.error && !main.signal && main.status === 0 && !main.stderr && main.stdout === `u ${parent}\n`);
    assert.equal(birth(), retainedBirth); assert.equal(readlinkSync(`/proc/${parent}/exe`), node);
    assert.equal(readFileSync(`/proc/${parent}/cmdline`, "utf8"), [node, "--experimental-strip-types",
      runtime + "/scripts/dependency-retention-os-test/common.ts", "supervisor", ""].join("\0"));
    assert.equal(readFileSync(`/proc/${parent}/cgroup`, "utf8"), readFileSync("/proc/self/cgroup", "utf8"));
    assertPinnedSystemBusQueryTool(bus.queryTool, remaining);
    assert.match(readFileSync("/proc/self/status", "utf8"), /^NoNewPrivs:\s+1$/m);
    assert.match(readFileSync("/proc/self/status", "utf8"), /^Seccomp:\s+2$/m);
  };
  policy(); const observations: { uid: number; firstAndSecondAndForkExec: true }[] = [];
  for (const uid of [0, 65532] as const) {
    remaining(); assert.deepEqual(readManifest(), before);
    const child = uid === 0 ? spawn(binary, ["deny"], { env: cleanEnv, stdio: ["pipe", "pipe", "pipe"] }) :
      spawn("/usr/bin/setpriv", ["--reuid=65532", "--regid=65532", "--clear-groups", "--inh-caps=-all", "--ambient-caps=-all",
        "--bounding-set=-all", "--no-new-privs", binary, "deny"], { env: cleanEnv, stdio: ["pipe", "pipe", "pipe"] });
    const closed = once(child, "close"); let out = "", err = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), Math.min(5000, remaining()));
    child.stderr.on("data", chunk => { err += String(chunk); if (err.length > 1024) child.kill("SIGTERM"); });
    child.stdin.on("error", () => {});
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject); child.once("exit", () => reject(new Error("TEST syscall probe exited early")));
        child.stdout.on("data", chunk => { out += String(chunk);
          if (out === "TEST_uring_denied\n") resolve();
          else if (out.length > 256) reject(new Error("TEST syscall probe output exceeded bound")); });
      });
      assert(child.pid); const status = readFileSync(`/proc/${child.pid}/status`, "utf8");
      assert.match(status, /^NoNewPrivs:\s+1$/m); assert.match(status, /^Seccomp:\s+2$/m);
      assert.match(status, new RegExp(`^Uid:\\s+${uid}\\s+${uid}\\s+${uid}\\s+${uid}$`, "m"));
      remaining(); assert.deepEqual(readManifest(), before); child.stdin.end("x");
      const [code, signal] = await closed; assert.equal(code, 0); assert.equal(signal, null);
      assert.equal(err, ""); assert.equal(out, "TEST_uring_denied\nTEST_uring_denied\nTEST_uring_exec_denied\n");
      remaining(); assert.deepEqual(readManifest(), before); observations.push({ uid, firstAndSecondAndForkExec: true });
    } finally { clearTimeout(timer); child.stdin.end(); }
  }
  policy(); assert.deepEqual(pin(fragment), fragmentPin); assert.deepEqual(readManifest(), before);
  return { sourceSha256: before.source.sha256, elfSha256: before.elf.sha256,
    manifestSha256: digest(readFileSync(manifest)), compiler: before.compiler, observations };
}
