import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readlinkSync, readdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { parseFdCollectorProfile, parseFdCollectorRows, readFdCollectorProfileField,
  type FdCollectorProfile, type FdFilePin, type FdCollectorProfilePin } from "@vioxen/subscription-runtime/core";
import { assertHostedActivationOperator, decodeHostedActivationBytes, readHostedActivationBytes } from "./hosted-process-activation";
import { hostedFdUnsetEnvironment } from "./hosted-fd-prelude";

export type HostedFdFact = Readonly<{ fd: number; target: string; flags: number; dev: string; ino: string; rdev: string;
  socket: boolean; pipe: boolean; character: boolean; file: boolean; directory: boolean }>;
export type HostedFdProcess = Readonly<{ pid: number; parentPid: number; birth: string; argv: readonly string[]; exe: string; group: string;
  net: string; user: string; mount: string; pidNamespace: string; uidMap: string; gidMap: string; status: string;
  descriptors: readonly HostedFdFact[] }>;
export type HostedFdUnit = Readonly<{ unit: string; invocation: string; group: string; mainPid: number; root: string }>;
const cleanEnv = { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", SYSTEMD_COLORS: "0" };
function invalid(): never { throw new Error("hosted_fd_boundary_unresolved"); }
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function protectedBytes(pin: FdFilePin, privateFile = false, prefix = ""): Buffer {
  for (let path = dirname(pin.path);; path = dirname(path)) {
    const info = lstatSync(prefix + path);
    if (!info.isDirectory() || info.uid !== 0 || (info.mode & 0o022) ||
        (privateFile && path === dirname(pin.path) && (info.mode & 0o077))) invalid();
    if (path === "/") break;
  }
  const path = prefix + pin.path, entry = lstatSync(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.uid !== 0 || before.nlink !== 1 ||
        (before.mode & (privateFile ? 0o077 : 0o022)) || before.size <= 0 ||
        before.size > (privateFile ? 64 * 1024 : 256 * 1024 * 1024)) invalid();
    const bytes = readFileSync(fd), after = fstatSync(fd), current = lstatSync(path);
    if (!before.isFile() || before.uid !== 0 || before.nlink !== 1 ||
        (before.mode & (privateFile ? 0o077 : 0o022)) || before.size > 256 * 1024 * 1024 ||
        before.dev !== entry.dev || before.ino !== entry.ino || before.dev !== current.dev || before.ino !== current.ino ||
        before.size !== after.size || before.ctimeMs !== after.ctimeMs || before.mtimeMs !== after.mtimeMs ||
        current.ctimeMs !== after.ctimeMs || current.mtimeMs !== after.mtimeMs ||
        bytes.length !== before.size || hash(bytes) !== pin.sha256) invalid();
    return bytes;
  } finally { closeSync(fd); }
}

export function readHostedFdProfile(): FdCollectorProfile | undefined {
  try { lstatSync("/var/lib/subscription-runtime-host-policy/readonly-inventory.json"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  assertHostedActivationOperator();
  const inventoryBytes = readHostedActivationBytes("readonly-inventory.json");
  if (!inventoryBytes) invalid();
  const inventory = decodeHostedActivationBytes(inventoryBytes) as Record<string, unknown>;
  const pin = readFdCollectorProfileField(inventory);
  if (!pin) return undefined;
  if (Object.keys(inventory).sort().join(",") !==
      "collectorProfile,disabledCreators,hostId,ordinaryCreators,runtimeLaunch,schemaVersion,supervisorUnit,systemBusInfrastructure,units") invalid();
  const installationBytes = readHostedActivationBytes("host-installation.json");
  if (!installationBytes) invalid();
  const installation = decodeHostedActivationBytes(installationBytes) as Record<string, unknown>;
  if (installation.inventorySha256 !== hash(inventoryBytes)) invalid();
  return verifyPinnedFdCollectorProfile(pin);
}

/** Cold inventory inspection may precede publication of host-installation.
 * These are actual facts about the fixed authenticated inventory input, never
 * admission or a profile chosen by a workload. Runtime still binds installation. */
export function verifyPinnedFdCollectorProfile(input: FdCollectorProfilePin): FdCollectorProfile {
  assertHostedActivationOperator();
  const pin = readFdCollectorProfileField({ schemaVersion: 4, collectorProfile: input });
  if (!pin) invalid();
  const bytes = protectedBytes(pin, true);
  const profile = parseFdCollectorProfile(decodeHostedActivationBytes(bytes));
  const environment = spawnSync("/usr/bin/systemctl", ["show-environment"], { env: cleanEnv, encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"], timeout: 5000, maxBuffer: 1024 * 1024 });
  if (environment.error || environment.signal || environment.status !== 0 || environment.stderr) invalid();
  for (const line of environment.stdout.trim().split("\n").filter(Boolean)) {
    const key = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line)?.[1];
    // Values are opaque, never logged/persisted or copied into a service.
    if (!key || /^(?:LD_|DYLD_|NODE_)/.test(key) ||
        ["GCONV_PATH", "LOCPATH", "GLIBC_TUNABLES", "OPENSSL_CONF", "OPENSSL_MODULES"].includes(key)) invalid();
  }
  for (const executable of [profile.ss, profile.node, ...profile.wrappers]) {
    for (const file of executable.elfFiles) {
      const elf = protectedBytes(file);
      if (elf.length < 64 || !elf.subarray(0, 7).equals(Buffer.from([127, 69, 76, 70, 2, 1, 1])) ||
          elf.readUInt16LE(18) !== 62) invalid();
    }
  }
  for (const file of profile.bootstraps) protectedBytes(file);
  if (!protectedBytes(pin, true).equals(bytes)) invalid();
  return profile;
}

export function hostedFdTable(pid: number): readonly HostedFdFact[] {
  if (!Number.isSafeInteger(pid) || pid < 1) invalid();
  const directory = `/proc/${pid}/fd`, names = readdirSync(directory).sort((a, b) => Number(a) - Number(b));
  if (names.length > 256) invalid();
  const facts: HostedFdFact[] = [];
  for (const name of names) {
    if (!/^(?:0|[1-9][0-9]{0,5})$/.test(name)) invalid();
    const fd = Number(name), path = `${directory}/${name}`;
    try {
      const target = readlinkSync(path), info = readFileSync(`/proc/${pid}/fdinfo/${name}`, "utf8");
      const flags = /^flags:\s+([0-7]{1,12})$/m.exec(info);
      const actual = readFileSync(`/proc/${pid}/fdinfo/${name}`, "utf8");
      if (!flags || /^flags:\s+([0-7]{1,12})$/m.exec(actual)?.[1] !== flags[1] || target !== readlinkSync(path)) invalid();
      // No proc FD is opened for IO, including O_PATH handles to directories.
      const s = pid === process.pid ? fstatSync(fd, { bigint: true }) : statSync(path, { bigint: true });
      facts.push(Object.freeze({ fd, target, flags: Number.parseInt(flags[1]!, 8), dev: String(s.dev), ino: String(s.ino),
        rdev: String(s.rdev), socket: s.isSocket(), pipe: s.isFIFO(), character: s.isCharacterDevice(),
        file: s.isFile(), directory: s.isDirectory() }));
    } catch (error) {
      // Only our already-closed enumeration descriptor can vanish from self.
      if (pid === process.pid && ["ENOENT", "EBADF"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        try { fstatSync(fd); }
        catch (closed) { if ((closed as NodeJS.ErrnoException).code === "EBADF") continue; }
      }
      throw error;
    }
  }
  return Object.freeze(facts);
}

export function observeHostedFdProcess(pid: number): HostedFdProcess {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8"), at = stat.lastIndexOf(") ");
  if (!stat.startsWith(`${pid} (`) || at < 0) invalid();
  const tick = stat.slice(at + 2).trim().split(/\s+/)[19];
  if (!tick || !/^[1-9][0-9]*$/.test(tick)) invalid();
  const argv = readFileSync(`/proc/${pid}/cmdline`).toString("utf8").split("\0");
  if (argv.pop() !== "" || !argv.length || argv.some(s => !s || s.length > 4096)) invalid();
  const parentPid = Number(stat.slice(at + 2).trim().split(/\s+/)[1]);
  if (!Number.isSafeInteger(parentPid) || parentPid < 0) invalid();
  const observed = Object.freeze({ pid, parentPid, birth: `${pid}:${tick}`, argv: Object.freeze(argv), exe: readlinkSync(`/proc/${pid}/exe`),
    group: readFileSync(`/proc/${pid}/cgroup`, "utf8").trim(), net: readlinkSync(`/proc/${pid}/ns/net`),
    user: readlinkSync(`/proc/${pid}/ns/user`), mount: readlinkSync(`/proc/${pid}/ns/mnt`), pidNamespace: readlinkSync(`/proc/${pid}/ns/pid`),
    uidMap: readFileSync(`/proc/${pid}/uid_map`, "utf8").trim().replace(/\s+/g, " "),
    gidMap: readFileSync(`/proc/${pid}/gid_map`, "utf8").trim().replace(/\s+/g, " "),
    status: readFileSync(`/proc/${pid}/status`, "utf8"), descriptors: hostedFdTable(pid) });
  if (readFileSync(`/proc/${pid}/stat`, "utf8") !== stat) {
    // CPU counters may change; compare only the immutable start tick.
    const after = readFileSync(`/proc/${pid}/stat`, "utf8");
    if (after.slice(after.lastIndexOf(") ") + 2).trim().split(/\s+/)[19] !== tick) invalid();
  }
  return observed;
}

export function observeHostedFdUnit(unit: string, expectedArgv: readonly string[]): HostedFdUnit {
  if (!/^subscription-runtime-(?:outer|ordinary|hosted|installer|research-provider)-[a-f0-9-]{36}\.service$/.test(unit)) invalid();
  const result = spawnSync("/usr/bin/systemctl", ["show", "--property=Id,InvocationID,ControlGroup,MainPID,ActiveState,FileDescriptorStoreMax,NFileDescriptorStore,TriggeredBy,UnsetEnvironment,PassEnvironment,EnvironmentFiles,ExecStart,ExecCondition,ExecStartPre,ExecStartPost,ExecReload,ExecStop,ExecStopPost,RootDirectory", "--", unit],
    { env: cleanEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000, maxBuffer: 65536 });
  if (result.error || result.signal || result.status !== 0 || result.stderr) invalid();
  const rows = new Map<string, string>();
  for (const line of result.stdout.trim().split("\n")) {
    const at = line.indexOf("=");
    if (at < 1 || rows.has(line.slice(0, at))) invalid();
    rows.set(line.slice(0, at), line.slice(at + 1));
  }
  if (rows.size !== 19 || rows.get("Id") !== unit || !/^[a-f0-9]{32}$/.test(rows.get("InvocationID") ?? "") ||
      rows.get("ActiveState") !== "active" || rows.get("FileDescriptorStoreMax") !== "0" ||
      rows.get("NFileDescriptorStore") !== "0" || rows.get("TriggeredBy") !== "" || rows.get("PassEnvironment") !== "" ||
      rows.get("EnvironmentFiles") !== "" || hostedFdUnsetEnvironment.split(" ").some(key =>
        !(rows.get("UnsetEnvironment") ?? "").split(" ").includes(key)) ||
      !/^[1-9][0-9]*$/.test(rows.get("MainPID") ?? "")) invalid();
  const exec = rows.get("ExecStart") ?? "";
  const start = /^\{ path=([^ ;]+) ; argv\[\]=([^;]+) ; ignore_errors=no ;/.exec(exec);
  if (!start || start[1] !== expectedArgv[0] || start[2]!.trim() !== expectedArgv.join(" ") ||
      ["ExecCondition", "ExecStartPre", "ExecStartPost", "ExecReload", "ExecStop", "ExecStopPost"].some(key => rows.get(key) !== "")) invalid();
  const group = rows.get("ControlGroup")!;
  if (group !== `/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/${unit}` &&
      group !== `/system.slice/${unit}`) invalid();
  return Object.freeze({ unit, invocation: rows.get("InvocationID")!, group, mainPid: Number(rows.get("MainPID")), root: rows.get("RootDirectory")! });
}

export function collectHostedFdPeers(profile: FdCollectorProfile): ReadonlyMap<string, string> {
  const pin = profile.ss;
  for (const file of pin.elfFiles) protectedBytes(file);
  const result = spawnSync(pin.path, ["-H", "-n", "-A", "unix_stream", "state", "established", "src", "unix:"],
    { env: cleanEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      timeout: profile.limits.collectorTimeoutMs, maxBuffer: profile.limits.maxOutputBytes });
  if (result.error || result.signal || result.status !== 0 || result.stderr ||
      Buffer.byteLength(result.stdout) > profile.limits.maxOutputBytes) invalid();
  const rows = parseFdCollectorRows(result.stdout, profile.limits.maxRows);
  for (const file of pin.elfFiles) protectedBytes(file);
  return rows;
}

export function assertHostedFdInternals(process: HostedFdProcess, profile: FdCollectorProfile): void {
  const count = { eventPoll: 0, eventFd: 0, pipe: 0, devNull: 0 };
  for (const fd of process.descriptors.filter(fd => fd.fd > 2)) {
    if (!(fd.flags & 0o2000000) || fd.flags & 0o10000000) invalid(); // CLOEXEC / O_PATH
    if (fd.target === "anon_inode:[eventpoll]" && !fd.socket && !fd.file && !fd.directory) count.eventPoll++;
    else if (fd.target === "anon_inode:[eventfd]" && !fd.socket && !fd.file && !fd.directory) count.eventFd++;
    else if (fd.pipe && /^pipe:\[[1-9][0-9]*\]$/.test(fd.target)) count.pipe++;
    else if (fd.character && fd.rdev === "259" && (fd.flags & 3) === 0) count.devNull++;
    else invalid();
  }
  if (count.eventPoll > profile.limits.maxEventPoll || count.eventFd > profile.limits.maxEventFd ||
      count.pipe > profile.limits.maxPipeEndpoints || count.devNull > profile.limits.maxDevNullReserves) invalid();
}

export function assertHostedFdBootstrap(process: HostedFdProcess, profile: FdCollectorProfile): void {
  const installer = process.argv[1] === "/runtime/bootstrap.js";
  const script = profile.bootstraps.find(pin => installer ?
    pin.path.endsWith("/hosted-dependency-installer-bootstrap.js") : pin.path === process.argv[1]);
  if (process.exe !== profile.node.path || process.argv[0] !== profile.node.path ||
      !script ||
      !(process.argv.length === 2 || (process.argv.length === 3 &&
        (process.argv[2] === "ordinary-bootstrap" || process.argv[2] === "--research-ready-v1" || process.argv[2] === "--fd-ready-v1"))) ||
      process.net !== readlinkSync("/proc/self/ns/net")) invalid();
  for (const pin of profile.node.elfFiles) protectedBytes(pin, false, `/proc/${process.pid}/root`);
  protectedBytes(installer ? { ...script, path: "/runtime/bootstrap.js" } : script, false, `/proc/${process.pid}/root`);
  assertHostedFdNodeMaps(process, profile);
  assertHostedFdInternals(process, profile);
}

function assertHostedFdNodeMaps(process: HostedFdProcess, profile: FdCollectorProfile): void {
  const maps = readFileSync(`/proc/${process.pid}/maps`, "utf8"), mapped = new Set<string>();
  for (const line of maps.trim().split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 6 && parts[5]!.startsWith("/")) {
      if (parts.length !== 6 || !profile.node.elfFiles.some(pin => pin.path === parts[5])) invalid();
      mapped.add(parts[5]!);
    }
  }
  if (!mapped.has(profile.node.path)) invalid();
}

export function assertHostedFdManagedGuard(process: HostedFdProcess, profile: FdCollectorProfile, jobId: string): void {
  const path = "/opt/subscription-runtime/managed-launcher/payload-guard.mjs";
  const pin = profile.bootstraps.find(pin => pin.path === path);
  if (!pin || process.exe !== profile.node.path || process.argv.length !== 8 || process.argv[0] !== profile.node.path ||
      process.argv[1] !== path || process.argv[2] !== "--job-id" || process.argv[3] !== jobId || process.argv[4] !== "--" ||
      process.argv[5] !== profile.node.path || !process.argv[6]?.endsWith("/hosted-app-server-launcher.js") ||
      process.argv[7] !== "--fd-ready-v1" || process.net !== readlinkSync("/proc/self/ns/net")) invalid();
  protectedBytes(pin, false, `/proc/${process.pid}/root`);
  for (const file of profile.node.elfFiles) protectedBytes(file, false, `/proc/${process.pid}/root`);
  assertHostedFdNodeMaps(process, profile);
  assertHostedFdInternals(process, profile);
}

/** Actual kernel namespaces/privileges are checked against the closed fixed
 * recipe, not a role value or namespace-local caller claim. */
export function assertHostedFdConfinement(child: HostedFdProcess, serviceArgv: readonly string[], root: string): void {
  const host = observeHostedFdProcess(process.pid);
  if (child.net !== host.net) invalid();
  const provider = serviceArgv[0] === "/usr/bin/unshare", installer = serviceArgv[0] === "/usr/bin/setpriv";
  const status = (name: string) => new RegExp(`^${name}:[\\t ]*([^\\n]*)$`, "m").exec(child.status)?.[1]?.trim().replace(/\s+/g, " ");
  if (provider || installer) {
    if (status("NoNewPrivs") !== "1" || ["Inh", "Prm", "Eff", "Bnd", "Amb"].some(set =>
      !/^0+$/.test(status("Cap" + set) ?? ""))) invalid();
  }
  if (provider) {
    if (child.user === host.user || child.pidNamespace === host.pidNamespace || child.mount === host.mount ||
        child.uidMap !== "65532 0 1" || child.gidMap !== "65532 0 1" ||
        status("Uid") !== "0 0 0 0" || status("Gid") !== "0 0 0 0") invalid();
  } else if (installer) {
    if (child.user !== host.user || child.pidNamespace !== host.pidNamespace || child.mount === host.mount ||
        status("Uid") !== "65532 65532 65532 65532" || status("Gid") !== "65532 65532 65532 65532" ||
        status("Groups") !== "") invalid();
  } else if (serviceArgv[0] !== child.exe || child.user !== host.user || child.pidNamespace !== host.pidNamespace ||
      child.mount !== host.mount || status("Uid") !== "0 0 0 0" || status("Gid") !== "0 0 0 0") invalid();
  const expected = lstatSync(root || "/", { bigint: true }), actual = statSync(`/proc/${child.pid}/root`, { bigint: true });
  if (!expected.isDirectory() || expected.uid !== 0n || (expected.mode & 0o022n) ||
      expected.dev !== actual.dev || expected.ino !== actual.ino) invalid();
}

export function hostedFdGroupPids(group: string): readonly number[] {
  let directories = 0;
  const pids = new Set<number>();
  const visit = (path: string): void => {
    if (++directories > 64) invalid();
    for (const text of readFileSync(`${path}/cgroup.procs`, "utf8").trim().split("\n").filter(Boolean)) {
      if (!/^[1-9][0-9]*$/.test(text)) invalid(); pids.add(Number(text));
    }
    for (const entry of readdirSync(path, { withFileTypes: true })) if (entry.isDirectory()) visit(`${path}/${entry.name}`);
  };
  visit("/sys/fs/cgroup" + group);
  if (!pids.size || pids.size > 8) invalid();
  return [...pids];
}
