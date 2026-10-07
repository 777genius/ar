import { composeDefaultTestCodex } from "./compose-default-codex.ts";
import { readDefaultTestRequestedModel } from "./default-codex-config.ts";
import { compileIoUringFixture } from "./io-uring.ts";
/** Signed Ubuntu indexes and downloaded .deb extraction only. No dpkg install,
 * maintainer script, chroot command, or outer apt state mutation is permitted. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, cpSync, existsSync, fstatSync, fsyncSync, lstatSync, openSync,
  readdirSync, readlinkSync, readSync, realpathSync, renameSync, rmdirSync, rmSync, symlinkSync, writeFileSync, type BigIntStats } from "node:fs";
import { dirname, join } from "node:path";
import { hostedDependencySystemdRunExecutable } from "../../dist/provider-codex/app-server/adapters/hosted-dependency-systemd-command.js";
import { SYSTEM_BUS_CONFIG, SYSTEM_BUS_CONFIG_PATH, SYSTEM_BUS_EXECUTABLE, SYSTEM_BUS_SERVICE_FRAGMENT,
  SYSTEM_BUS_SOCKET_FRAGMENT } from "../../dist/core/host-infrastructure/system-bus-infrastructure.js";
import { busDiagnosticDropIn, busDiagnosticDropInPath, busDiagnosticSink, command as runCommand, directory, elfPackages, fileDigest, json, OwnedOsMode, OwnedOsScenario, readonlyStorage, runtime, type OwnedOsFixtureScenario } from "./common.ts";

export function assemble(root: string, state: string, source: string, toolchain: string, sourceSha: string, machineId: string,
  scenario: OwnedOsFixtureScenario, remainingMs: () => number): void {
  // The caller owns one monotonic deadline across both fresh roots. Every
  // existing subprocess keeps its argv and is capped by the remaining budget.
  const checkBudget = (): number => {
    const remaining = remainingMs(); assert(Number.isSafeInteger(remaining) && remaining > 0); return remaining;
  };
  const command = (file: string, args: readonly string[], timeout = 30000): string => {
    const output = runCommand(file, args, Math.min(timeout, checkBudget())); checkBudget(); return output;
  };
  checkBudget();
  assert(root.startsWith("/var/lib/subscription-runtime-os-TEST/"));
  assert(!existsSync(root)); directory(root, 0o755); directory(state);
  for (const name of ["lists/partial", "archives/partial", "etc"]) directory(join(state, name));
  const sources = join(state, "etc/sources.list");
  writeFileSync(sources, ["deb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] https://archive.ubuntu.com/ubuntu noble main universe",
    "deb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] https://archive.ubuntu.com/ubuntu noble-updates main universe",
    "deb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] https://security.ubuntu.com/ubuntu noble-security main universe", ""].join("\n"), { flag: "wx", mode: 0o600 });
  writeFileSync(join(state, "status"), "", { flag: "wx", mode: 0o600 });
  directory(state + "/log");
  const options = ["-o", `Dir::State=${state}`, "-o", `Dir::Cache=${state}`, "-o", `Dir::Log=${state}/log`,
    "-o", `Dir::State::lists=${state}/lists`, "-o", `Dir::State::status=${state}/status`,
    "-o", `Dir::Cache::archives=${state}/archives`, "-o", `Dir::Etc::sourcelist=${sources}`,
    "-o", "Dir::Etc::sourceparts=-", "-o", "Dir::Etc::parts=-", "-o", "Dir::Etc::main=-",
    "-o", "APT::Sandbox::User=root", "-o", "APT::Update::Error-Mode=any",
    "-o", "Acquire::AllowInsecureRepositories=false", "-o", "APT::Get::AllowUnauthenticated=false"];
  command("/usr/bin/apt-get", [...options, "update"], 180000);
  const releases = readdirSync(state + "/lists").filter(name => name.endsWith("_InRelease"));
  assert.equal(releases.length, 3);
  for (const name of releases) command("/usr/bin/gpgv", ["--keyring", "/usr/share/keyrings/ubuntu-archive-keyring.gpg", state + "/lists/" + name]);
  const pinnedNode = realpathSync(toolchain + "/bin/node"), pinnedSha = fileDigest(pinnedNode);
  assert.equal(pinnedNode, realpathSync(process.execPath));
  const linkage = command("/usr/bin/ldd", [pinnedNode]);
  assert(!linkage.includes("not found"));
  const requirements = [...linkage.matchAll(/^\s*([A-Za-z0-9_.+-]+)\s+=>\s+(\/[^\s]+)\s+\(/gm)]
    .map(match => ({ soname: match[1]!, resolved: realpathSync(match[2]!) }));
  const loader = /^\s*(\/[^\s]+\/ld-linux-x86-64\.so\.2)\s+\(/m.exec(linkage)?.[1]; assert(loader);
  requirements.push({ soname: "ld-linux-x86-64.so.2", resolved: realpathSync(loader) });
  assert(requirements.length > 1 && requirements.length <= 32);
  const requiredPackages = [...new Set(requirements.map(row => {
    assert(Object.hasOwn(elfPackages, row.soname), "unsupported pinned Node ELF requirement");
    assert(row.resolved.startsWith("/usr/lib/"));
    return elfPackages[row.soname as keyof typeof elfPackages];
  }))].sort();
  assert.equal(fileDigest(pinnedNode), pinnedSha);
  // --download-only never configures the extracted guest or starts runner services.
  command("/usr/bin/apt-get", [...options, "--yes", "--download-only", "--no-install-recommends", "install",
    "systemd", "systemd-container", "dbus-daemon", "dbus-bin", "iproute2=6.1.0-1ubuntu6.4", "util-linux", "bash", "coreutils", "libc-bin", "git", "ca-certificates", "tini", "python3-minimal",
    ...requiredPackages], 300000);
  for (const name of ["usr/bin", "usr/sbin", "usr/lib", "usr/lib64"]) directory(root + "/" + name, 0o755);
  for (const name of ["bin", "sbin", "lib", "lib64"]) symlinkSync("usr/" + name, root + "/" + name);
  const packages: unknown[] = [];
  const debs = readdirSync(state + "/archives").filter(name => name.endsWith(".deb")).sort();
  assert(debs.length > 10 && debs.length < 200);
  for (const name of debs) {
    checkBudget();
    const path = state + "/archives/" + name;
    const fields = command("/usr/bin/dpkg-deb", ["--field", path, "Package", "Version", "Architecture"]);
    const pkg = /^Package: (\S+)$/m.exec(fields)?.[1], version = /^Version: (\S+)$/m.exec(fields)?.[1];
    const arch = /^Architecture: (\S+)$/m.exec(fields)?.[1];
    assert(pkg && version && (arch === "amd64" || arch === "all"));
    const metadata = command("/usr/bin/apt-cache", [...options, "show", `${pkg}=${version}`]);
    const sha = fileDigest(path), size = lstatSync(path).size;
    assert(metadata.split("\n\n").some(block => new RegExp(`^SHA256: ${sha}$`, "m").test(block) &&
      new RegExp(`^Size: ${size}$`, "m").test(block)), "signed index package SHA/size mismatch");
    command("/usr/bin/dpkg-deb", ["--extract", path, root], 30000);
    packages.push({ package: pkg, version, arch, sha256: sha, size });
  }
  // Ordinary tar extraction may replace the original aliases with directories.
  // Only signed package bytes exist here; no runtime/config/job has been copied.
  const usrLayout = normalizeSignedUsrLayout(root, checkBudget);
  if (scenario === OwnedOsMode.BusDiagnostic) chmodSync(root, 0o700);
  // Independent bytes from authenticated package extraction only, before any
  // runtime/config copy. No library directory from the runner is included.
  const signedElfPins: { path: string; sha256: string }[] = []; let visited = 0, elfBytes = 0;
  const elfDeadline = process.hrtime.bigint() + 30000000000n;
  const captureElf = (path: string): void => {
    checkBudget();
    assert(++visited <= 20000 && process.hrtime.bigint() < elfDeadline);
    const stat = lstatSync(path); assert(stat.uid === 0 && (stat.isSymbolicLink() || (stat.mode & 0o022) === 0));
    if (stat.isDirectory()) { for (const name of readdirSync(path).sort()) captureElf(path + "/" + name); return; }
    if (stat.isSymbolicLink() || !stat.isFile()) return;
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const header = Buffer.alloc(20); let count: number;
    try { count = readSync(fd, header, 0, header.length, 0); } finally { closeSync(fd); }
    if (count !== 20 || header[0] !== 0x7f || header.subarray(1, 4).toString() !== "ELF") return;
    assert(stat.nlink === 1 && stat.size <= 32 * 1024 * 1024 && (elfBytes += stat.size) <= 512 * 1024 * 1024);
    assert(header[4] === 2 && header[5] === 1 && header.readUInt16LE(18) === 62);
    signedElfPins.push({ path: path.slice(root.length), sha256: fileDigest(path) });
  };
  captureElf(root + "/usr/lib");
  for (const path of [SYSTEM_BUS_EXECUTABLE, "/usr/bin/ss", "/usr/bin/setpriv", hostedDependencySystemdRunExecutable, "/usr/bin/tini", "/usr/bin/unshare", "/usr/bin/systemctl", "/usr/bin/busctl", "/usr/bin/python3.12", "/usr/bin/git"])
    captureElf(root + path);
  for (const tool of usrLayout.tools) {
    const stat = lstatSync(root + tool.path, { bigint: true });
    assert.equal(signedElfPins.find(pin => pin.path === tool.path)?.sha256, tool.sha256);
    assert.equal(String(stat.dev), tool.dev); assert.equal(String(stat.ino), tool.ino);
    assert.equal(Number(stat.mode & 0o7777n), tool.mode); assert.equal(String(stat.size), tool.bytes);
  }
  assert(signedElfPins.some(pin => pin.path === SYSTEM_BUS_EXECUTABLE));
  assert.equal(signedElfPins.filter(pin => pin.path === "/usr/bin/git").length, 1);
  directory(root + runtime, 0o755);
  assert(Buffer.byteLength(JSON.stringify(signedElfPins)) <= 128 * 1024);
  json(root + runtime + "/os-signed-elf-pins.json", { schemaVersion: 1, pins: signedElfPins });
  for (const name of scenario === OwnedOsMode.BusDiagnostic ? [] : ["dist", "packages", "node_modules", "scripts", "package.json"]) {
    checkBudget();
    cpSync(source + "/" + name, root + runtime + "/" + name, { recursive: true, dereference: false, verbatimSymlinks: true });
    checkBudget();
  }
  checkBudget();
  if (scenario !== OwnedOsMode.BusDiagnostic)
    cpSync(toolchain, root + runtime + "/toolchain", { recursive: true, dereference: false, verbatimSymlinks: true });
  checkBudget();
  if (scenario === OwnedOsScenario.Readonly) {
    // Real reviewed launcher artifacts and their finite static import closure.
    // These bytes are never replaced by a TEST launcher or generated alias.
    for (const path of ["managed-launcher/launch.mjs", "managed-launcher/payload-guard.mjs",
      "managed-launcher/profiles.mjs", "host-jobs/storage-policy.mjs"]) {
      directory(root + "/opt/subscription-runtime/" + dirname(path), 0o755);
      cpSync(source + "/host-integration/" + path, root + "/opt/subscription-runtime/" + path, { dereference: false });
      command("/usr/bin/chown", ["0:0", root + "/opt/subscription-runtime/" + path]);
      chmodSync(root + "/opt/subscription-runtime/" + path, 0o644);
    }
    directory(root + readonlyStorage, 0o700);
    directory(root + "/etc/subscription-runtime", 0o755);
    writeFileSync(root + "/etc/subscription-runtime/storage-root", readonlyStorage + "\n", { flag: "wx", mode: 0o600 });
  }
  // These are freshly extracted guest files only. Discard distro activation links
  // and use an explicit TEST-only unit search path, never mask an outer service.
  directory(root + "/etc/systemd/test-units", 0o755);
  for (const name of ["system", "user"]) {
    const path = root + "/etc/systemd/" + name;
    if (existsSync(path)) rmSync(path, { recursive: true });
  }
  writeFileSync(root + "/etc/machine-id", machineId + "\n", { mode: 0o444 });
  // Numeric privilege drop must work with no installer account in NSS.
  writeFileSync(root + "/etc/passwd", "root:x:0:0:TEST root:/root:/bin/bash\n", { mode: 0o644 });
  writeFileSync(root + "/etc/group", "root:x:0:\n", { mode: 0o644 });
  writeFileSync(root + "/etc/hosts", "127.0.0.1 localhost\n", { mode: 0o644 });
  writeFileSync(root + "/etc/nsswitch.conf", "hosts: files dns\n", { mode: 0o644 });
  writeFileSync(root + "/etc/services", "", { mode: 0o644 });
  // These finite transport files are data. Resolve aliases and read bounded
  // regular FDs; cpSync dereference can classify a source symlink as a directory.
  snapshotPublicFile("/etc/resolv.conf", root + "/etc/resolv.conf", 65536);
  directory(root + "/etc/ssl/certs", 0o755);
  snapshotPublicFile("/etc/ssl/certs/ca-certificates.crt", root + "/etc/ssl/certs/ca-certificates.crt", 1024 * 1024);
  const units = root + "/etc/systemd/test-units";
  directory(root + dirname(SYSTEM_BUS_CONFIG_PATH), 0o755);
  writeFileSync(root + SYSTEM_BUS_CONFIG_PATH, SYSTEM_BUS_CONFIG, { flag: "wx", mode: 0o600 });
  writeFileSync(units + "/dbus.service", SYSTEM_BUS_SERVICE_FRAGMENT, { flag: "wx", mode: 0o644 });
  writeFileSync(units + "/dbus.socket", SYSTEM_BUS_SOCKET_FRAGMENT, { flag: "wx", mode: 0o644 });
  if (scenario === OwnedOsMode.BusDiagnostic) {
    directory(root + "/var", 0o755); directory(root + "/var/lib", 0o755);
    directory(root + dirname(busDiagnosticSink));
    const fd = openSync(root + busDiagnosticSink, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { const stat = fstatSync(fd, { bigint: true });
      assert(stat.isFile() && stat.uid === 0n && stat.gid === 0n && stat.nlink === 1n && stat.size === 0n &&
        (stat.mode & 0o7777n) === 0o600n && stat.dev === lstatSync(root, { bigint: true }).dev); fsyncSync(fd);
    } finally { closeSync(fd); }
    directory(units + "/dbus.service.d", 0o755);
    writeFileSync(root + busDiagnosticDropInPath, busDiagnosticDropIn, { flag: "wx", mode: 0o644 });
    writeFileSync(units + "/TEST-retention-bus-diagnostic.target", "[Unit]\nDescription=Unqualified TEST daemon stderr observation\nDefaultDependencies=no\nRequires=dbus.service\nAfter=dbus.service\n", { flag: "wx", mode: 0o644 });
  } else {
  writeFileSync(units + "/TEST-retention.target", "[Unit]\nDescription=Owned dependency TEST OS\nDefaultDependencies=no\nRequires=dbus.service TEST-retention-supervisor.service\nAfter=dbus.service TEST-retention-supervisor.service\n", { mode: 0o644 });
  writeFileSync(units + "/TEST-retention-supervisor.service", `[Unit]\nDescription=Owned TEST issuer and retained supervisor\nDefaultDependencies=no\nRequires=dbus.service\nAfter=dbus.service\n[Service]\nType=exec\nSystemCallFilter=~io_uring_setup:ENOSYS io_uring_enter:ENOSYS io_uring_register:ENOSYS\nSystemCallArchitectures=native\nNoNewPrivileges=yes\nExecStart=${runtime}/toolchain/bin/node --experimental-strip-types ${runtime}/scripts/dependency-retention-os-test/common.ts supervisor\nEnvironment=TEST_SOURCE_SHA=${sourceSha}\nEnvironment=TEST_OS_SCENARIO=${scenario}\nEnvironment=PATH=/usr/local/bin:/usr/bin:/bin LANG=C LC_ALL=C\nRestart=no\nKillMode=control-group\nRuntimeMaxSec=25min\nTimeoutStopSec=20s\nStandardOutput=null\nStandardError=null\n`, { mode: 0o644 });
  }
  if (scenario !== OwnedOsMode.BusDiagnostic) directory(root + "/tmp", 0o1777);
  // Recursively copied CI checkout files become root-owned immutable artifacts.
  command("/usr/bin/chown", ["-R", "0:0", root + runtime]);
  command("/usr/bin/chmod", ["-R", "go-w", root + runtime]);
  if (scenario !== OwnedOsMode.BusDiagnostic) {
    checkBudget(); readDefaultTestRequestedModel(root); // Missing TEST expectation refuses before composition/boot.
    composeDefaultTestCodex(root); // Once in the existing owned assembler, before digest/profile/install.
    checkBudget(); compileIoUringFixture(root, state, command);
  }
  json(root + runtime + "/os-packages.json", { schemaVersion: 1, release: "ubuntu-noble",
    releases: releases.map(name => ({ name, sha256: fileDigest(state + "/lists/" + name) })), packages, usrLayout,
    pinnedNode: { sha256: pinnedSha, version: process.version, requirements: requirements.map(row => ({ soname: row.soname,
      sha256: fileDigest(row.resolved), package: elfPackages[row.soname as keyof typeof elfPackages] })), requiredPackages } });
  assert(existsSync(root + "/usr/bin/systemd-nspawn"));
  assert(existsSync(root + "/usr/lib/systemd/systemd"));
  checkBudget();
}

function normalizeSignedUsrLayout(root: string, checkBudget: () => number) {
  assert(/^\/var\/lib\/subscription-runtime-os-TEST\/[a-f0-9-]{36}\/root$/.test(root));
  const device = lstatSync(root, { bigint: true }).dev, deadline = process.hrtime.bigint() + 30000000000n;
  const manifest = createHash("sha256"); let visited = 0, moved = 0, bytes = 0n;
  const bound = () => { checkBudget(); assert(++visited <= 20000 && process.hrtime.bigint() < deadline); };
  const entry = (path: string): BigIntStats | undefined => {
    try { return lstatSync(path, { bigint: true }); }
    catch (error) { assert.equal((error as NodeJS.ErrnoException).code, "ENOENT"); return undefined; }
  };
  const protectedDirectory = (path: string): BigIntStats => {
    bound(); const stat = lstatSync(path, { bigint: true });
    assert(stat.isDirectory() && stat.uid === 0n && stat.gid === 0n && stat.dev === device && !(stat.mode & 0o022n));
    assert.equal(realpathSync(path), path); return stat;
  };
  protectedDirectory(dirname(root)); protectedDirectory(root); protectedDirectory(root + "/usr");
  const merge = (source: string, target: string): void => {
    const from = protectedDirectory(source), to = protectedDirectory(target); assert.equal(to.mode, from.mode);
    for (const name of readdirSync(source).sort()) {
      bound(); assert(Buffer.byteLength(name) <= 255 && name !== "." && name !== ".." && !/[\/\u0000-\u001f\u007f]/.test(name));
      const oldPath = source + "/" + name, newPath = target + "/" + name, stat = lstatSync(oldPath, { bigint: true });
      assert(stat.uid === 0n && stat.gid === 0n && stat.dev === device);
      const existing = entry(newPath);
      if (stat.isDirectory()) {
        protectedDirectory(oldPath);
        if (!existing) directory(newPath, Number(stat.mode & 0o7777n));
        else assert(existing.isDirectory(), "TEST usrmerge directory collision");
        merge(oldPath, newPath); continue;
      }
      assert(!existing, "TEST usrmerge leaf collision");
      assert(stat.nlink === 1n && (stat.isSymbolicLink() || stat.isFile() && !(stat.mode & 0o022n)));
      assert(stat.size <= 32n * 1024n * 1024n && (bytes += stat.size) <= 512n * 1024n * 1024n);
      const link = stat.isSymbolicLink() ? readlinkSync(oldPath) : undefined;
      if (link !== undefined) assert(Buffer.byteLength(link) <= 4096);
      const sha256 = link === undefined ? fileDigest(oldPath) : createHash("sha256").update(link).digest("hex");
      bound(); renameSync(oldPath, newPath);
      const current = lstatSync(newPath, { bigint: true });
      for (const key of ["dev", "ino", "uid", "gid", "mode", "nlink", "size", "mtimeNs"] as const) assert.equal(current[key], stat[key]);
      assert.equal(link === undefined ? fileDigest(newPath) : createHash("sha256").update(readlinkSync(newPath)).digest("hex"), sha256);
      assert.equal(entry(oldPath), undefined); ++moved;
      manifest.update(JSON.stringify([oldPath.slice(root.length), newPath.slice(root.length), String(stat.dev), String(stat.ino), String(stat.mode), sha256]) + "\n");
      bound();
    }
    const current = protectedDirectory(source); assert(current.dev === from.dev && current.ino === from.ino);
    assert.equal(readdirSync(source).length, 0); rmdirSync(source);
  };
  const aliases = ["bin", "sbin", "lib", "lib64"].map(name => {
    const source = root + "/" + name, target = root + "/usr/" + name, before = lstatSync(source, { bigint: true });
    protectedDirectory(target); const priorMoved = moved;
    if (before.isSymbolicLink()) {
      assert(before.uid === 0n && before.gid === 0n && before.dev === device && before.nlink === 1n);
      assert.equal(readlinkSync(source), "usr/" + name); assert.equal(realpathSync(source), target);
    } else { assert(before.isDirectory()); merge(source, target); symlinkSync("usr/" + name, source); }
    const after = lstatSync(source, { bigint: true });
    assert(after.isSymbolicLink() && after.uid === 0n && after.gid === 0n && after.dev === device && after.nlink === 1n);
    assert.equal(readlinkSync(source), "usr/" + name); assert.equal(realpathSync(source), target);
    return { alias: "/" + name, target: "/usr/" + name, priorKind: before.isSymbolicLink() ? "symlink" : "directory", movedEntries: moved - priorMoved };
  });
  const tools = [SYSTEM_BUS_EXECUTABLE, "/usr/bin/ss", "/usr/bin/setpriv", hostedDependencySystemdRunExecutable, "/usr/bin/tini", "/usr/bin/unshare", "/usr/bin/busctl"].map(path => {
    protectedDirectory(root + dirname(path)); const actual = root + path, stat = lstatSync(actual, { bigint: true });
    assert.equal(realpathSync(actual), actual);
    assert(stat.isFile() && stat.uid === 0n && stat.gid === 0n && stat.dev === device && stat.nlink === 1n && !(stat.mode & 0o022n) && (stat.mode & 0o111n));
    assert(stat.size > 0n && stat.size <= 32n * 1024n * 1024n);
    const sha256 = fileDigest(actual); bound();
    return { path, sha256, dev: String(stat.dev), ino: String(stat.ino), mode: Number(stat.mode & 0o7777n), bytes: String(stat.size) };
  });
  bound(); return { aliases, movedEntries: moved, movedBytes: String(bytes), movedManifestSha256: manifest.digest("hex"), tools };
}

function snapshotPublicFile(alias: string, target: string, maxBytes: number): void {
  const path = realpathSync(alias), before = lstatSync(path, { bigint: true });
  assert(before.isFile() && before.nlink === 1n && before.size > 0n && before.size <= BigInt(maxBytes));
  const input = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes: Buffer;
  try {
    const opened = fstatSync(input, { bigint: true }), buffer = Buffer.alloc(maxBytes + 1);
    const count = readSync(input, buffer, 0, buffer.length, 0);
    for (const stat of [opened, fstatSync(input, { bigint: true }), lstatSync(path, { bigint: true })])
      assert(stat.isFile() && stat.nlink === 1n && stat.dev === before.dev && stat.ino === before.ino && stat.size === before.size &&
        stat.mtimeNs === before.mtimeNs && stat.ctimeNs === before.ctimeNs);
    assert(BigInt(count) === before.size && realpathSync(alias) === path);
    bytes = buffer.subarray(0, count);
  } finally { closeSync(input); }
  assert.equal(realpathSync(dirname(target)), dirname(target));
  // Only an exact fresh guest destination is replaced. This also removes a
  // dangling extracted symlink without following its target into the runner.
  assert(target.startsWith("/var/lib/subscription-runtime-os-TEST/") && target.includes("/root/etc/"));
  rmSync(target, { force: true });
  const output = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
  try { writeFileSync(output, bytes); fsyncSync(output); } finally { closeSync(output); }
  chmodSync(target, 0o644);
}
