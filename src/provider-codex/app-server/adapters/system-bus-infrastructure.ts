import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readlinkSync, readSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import { parseSystemBusInfrastructure, SYSTEM_BUS_ARGUMENTS, SYSTEM_BUS_CONFIG, SYSTEM_BUS_CONFIG_PATH,
  SYSTEM_BUS_CONTROL_GROUP, SYSTEM_BUS_ENDPOINT, SYSTEM_BUS_EXECUTABLE, SYSTEM_BUS_SERVICE_FRAGMENT,
  SYSTEM_BUS_SOCKET_FRAGMENT, type SystemBusInfrastructure, type SystemBusFilePin } from "@vioxen/subscription-runtime/core";
import { assertSystemdManagerOwner, observeSystemdServiceEmptyArrays, systemdObservationBudget,
  SystemdServiceArrayKind, SystemdArrayProperty, type SystemdEmptyArrayFact, type SystemdObservationRemaining } from "./systemd-service-arrays";
import { AppServerObserverPoint as ObserverPoint, retainObserverFailure } from "../domain/app-server-observer-failure";

function invalid(): never { throw new Error("system_bus_infrastructure_unqualified"); }
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const environment = { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", SYSTEMD_COLORS: "0" };
function protectedParents(path: string, remaining: SystemdObservationRemaining): void {
  for (let current = dirname(path);; current = dirname(current)) {
    remaining(); const stat = lstatSync(current); remaining();
    if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022)) invalid();
    if (current === "/") break;
  }
}
function pinnedFile(pin: SystemBusFilePin, remaining: SystemdObservationRemaining): Buffer {
  protectedParents(pin.path, remaining);
  const fd = openSync(pin.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.uid !== 0 || before.nlink !== 1 || (before.mode & 0o022) || before.size > 32 * 1024 * 1024) invalid();
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      remaining();
      const count = readSync(fd, bytes, length, Math.min(65536, bytes.length - length), length);
      remaining();
      if (!count) break;
      length += count;
    }
    const after = fstatSync(fd), entry = lstatSync(pin.path);
    if (length !== before.size || after.size !== before.size || after.ctimeMs !== before.ctimeMs || after.mtimeMs !== before.mtimeMs ||
        after.dev !== before.dev || after.ino !== before.ino || entry.dev !== before.dev || entry.ino !== before.ino ||
        entry.isSymbolicLink() || after.uid !== 0 || after.nlink !== 1 || (after.mode & 0o022) || digest(bytes.subarray(0, length)) !== pin.sha256) invalid();
    remaining(); return bytes.subarray(0, length);
  } finally { closeSync(fd); }
}
function boundedProc(path: string, remaining: SystemdObservationRemaining, max = 1024 * 1024): string {
  remaining(); const bytes = readFileSync(path); remaining();
  if (bytes.length > max) invalid();
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { invalid(); }
}
function command(executable: string, args: string[], remaining: SystemdObservationRemaining): string {
  const result = spawnSync(executable, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    timeout: Math.min(5000, remaining()), maxBuffer: 256 * 1024, env: environment });
  remaining();
  if (result.error || result.signal || result.status !== 0 || result.stderr || typeof result.stdout !== "string") invalid();
  return result.stdout.trim();
}
const emptyArrays = [SystemdArrayProperty.ExecStartPre, SystemdArrayProperty.ExecStartPost, SystemdArrayProperty.ExecReload,
  SystemdArrayProperty.ExecStop, SystemdArrayProperty.ExecStopPost, SystemdArrayProperty.EnvironmentFiles];
function show(name: "dbus.service" | "dbus.socket", properties: string, remaining: SystemdObservationRemaining): Record<string, string> {
  const result: Record<string, string> = {};
  const expected = properties.split(","), unresolved = name === "dbus.service" ? emptyArrays : [];
  for (const line of command("/usr/bin/systemctl", ["show", "--all", `--property=${properties}`, "--", name], remaining).split("\n")) {
    const at = line.indexOf("="), key = line.slice(0, at);
    if (at < 1 || key in result || !expected.includes(key)) invalid();
    result[key] = line.slice(at + 1);
    if (unresolved.some(name => name === key) && result[key] !== "") invalid();
  }
  if (expected.some(key => !unresolved.some(name => name === key) && !(key in result)) ||
      result.Id !== name || result.Names !== name || result.LoadState !== "loaded" || result.ActiveState !== "active" ||
      result.SubState !== "running" || result.DropInPaths !== "" || result.Job !== "") invalid();
  return result;
}
function birth(pid: string, remaining: SystemdObservationRemaining): string {
  const value = boundedProc(`/proc/${pid}/stat`, remaining, 4096), at = value.lastIndexOf(") ");
  if (!value.startsWith(pid + " (") || at < 0) invalid();
  const fields = value.slice(at + 2).trim().split(/\s+/);
  if (fields[1] !== "1" || !/^[1-9][0-9]{0,19}$/.test(fields[19] ?? "")) invalid();
  return pid + ":" + fields[19];
}
function socketInodes(pid: string, remaining: SystemdObservationRemaining): Set<string> {
  remaining(); const entries = readdirSync(`/proc/${pid}/fd`); remaining();
  if (entries.length > 4096) invalid();
  const result = new Set<string>();
  for (const name of entries) {
    remaining();
    if (!/^[0-9]+$/.test(name)) invalid();
    try {
      const match = /^socket:\[([1-9][0-9]*)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${name}`));
      if (match) result.add(match[1]!);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return result;
}
function processClosure(pid: string, pins: readonly SystemBusFilePin[], remaining: SystemdObservationRemaining): void {
  const observed = new Set<string>();
  for (const line of boundedProc(`/proc/${pid}/maps`, remaining, 2 * 1024 * 1024).trim().split("\n")) {
    remaining();
    const match = /^[a-f0-9]+-[a-f0-9]+\s+([rwxps-]{4})\s+[a-f0-9]+\s+[a-f0-9]+:[a-f0-9]+\s+[0-9]+(?:\s+(.*))?$/.exec(line);
    if (!match) invalid();
    const path = match[2];
    if (path?.startsWith("/")) {
      if (!pins.some(pin => pin.path === path)) invalid();
      observed.add(path);
    } else if (match[1]!.includes("x") && path !== "[vdso]" && path !== "[vsyscall]") invalid();
  }
  if (pins.some(pin => !observed.has(pin.path))) invalid();
}

/** Actual initial-namespace facts. Final admission callers hold their existing
 * fence; cold/provisional reads never admit. Signed package staging belongs
 * to the trusted issuer; every admission rechecks the pinned installed bytes,
 * effective manager state, live ELF closure and listener/daemon/PID1 linkage. */
export function verifySystemBusInfrastructure(input: SystemBusInfrastructure, remaining?: SystemdObservationRemaining): void {
  const began = process.hrtime.bigint(); let point = ObserverPoint.BusInitial;
  try { observeInfrastructure(input, systemdObservationBudget(remaining), undefined, value => { point = value; }); }
  catch (error) { const wrapped = new Error("system_bus_infrastructure_unqualified"); retainObserverFailure(error, point, Math.min(60000, Math.max(0, Number((process.hrtime.bigint() - began) / 1000000n))), wrapped); throw wrapped; }
}
/** Same actual bus bracket around the seven finite managed-unit reads. Facts,
 * not admission: the FDA owner retains its final fence and lifetime checks. */
export function observeSystemBusFdEmptyArrays(input: SystemBusInfrastructure, unit: string,
  remaining: SystemdObservationRemaining): readonly SystemdEmptyArrayFact[] {
  const began = process.hrtime.bigint(); let point = ObserverPoint.BusInitial;
  try { return observeInfrastructure(input, systemdObservationBudget(remaining), unit, value => { point = value; }); }
  catch (error) { const wrapped = new Error("system_bus_infrastructure_unqualified"); retainObserverFailure(error, point, Math.min(60000, Math.max(0, Number((process.hrtime.bigint() - began) / 1000000n))), wrapped); throw wrapped; }
}
/** The legacy root row supplies no membership authority; the unified row must
 * identify this exact bus group. Check every row without trimming its bytes. */
function matchesSystemBusCgroup(text: string): boolean {
  const rows = (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
  if (rows.length > 2) return false;
  let unified = 0, legacy = 0;
  for (const row of rows) {
    if (row === `0::${SYSTEM_BUS_CONTROL_GROUP}`) unified++;
    else if (row === "1:name=systemd:/") legacy++;
    else return false;
  }
  return unified === 1 && legacy <= 1;
}
function observeInfrastructure(input: SystemBusInfrastructure, remaining: SystemdObservationRemaining,
  managedUnit: string | undefined, mark: (point: ObserverPoint) => void): readonly SystemdEmptyArrayFact[] {
  remaining();
  if (process.platform !== "linux" || process.getuid?.() !== 0 ||
      !/^0\s+0\s+4294967295$/.test(boundedProc("/proc/self/uid_map", remaining, 4096).trim())) invalid();
  for (const namespace of ["user", "mnt", "pid", "net"]) {
    if (readlinkSync(`/proc/self/ns/${namespace}`) !== readlinkSync(`/proc/1/ns/${namespace}`)) invalid();
  }
  const descriptor = parseSystemBusInfrastructure(input);
  // v1 remains history data; no active query runs without enrolled tool pins.
  if (descriptor.version !== 2) invalid();
  const files: SystemBusFilePin[] = [
    { path: descriptor.service.fragmentPath, sha256: descriptor.service.fragmentSha256 },
    { path: descriptor.socket.fragmentPath, sha256: descriptor.socket.fragmentSha256 }, descriptor.config, ...descriptor.elfClosure,
  ];
  const verifyPins = () => {
    for (const pin of files) {
      const bytes = pinnedFile(pin, remaining);
      const expected = pin.path === descriptor.service.fragmentPath ? SYSTEM_BUS_SERVICE_FRAGMENT :
        pin.path === descriptor.socket.fragmentPath ? SYSTEM_BUS_SOCKET_FRAGMENT : pin.path === SYSTEM_BUS_CONFIG_PATH ? SYSTEM_BUS_CONFIG : undefined;
      if (expected !== undefined ? !bytes.equals(Buffer.from(expected)) :
          bytes.length < 20 || bytes[0] !== 0x7f || bytes.subarray(1, 4).toString() !== "ELF" ||
          bytes[4] !== 2 || bytes[5] !== 1 || bytes.readUInt16LE(18) !== 62) invalid();
    }
  };
  mark(ObserverPoint.BusPins); verifyPins();
  const common = "Id,Names,LoadState,ActiveState,SubState,FragmentPath,DropInPaths,Job";
  const serviceProperties = common + ",ControlGroup,MainPID,ExecStart,ExecStartPre,ExecStartPost,ExecReload,ExecStop,ExecStopPost,Environment,EnvironmentFiles,User,Group,Restart,Type,TriggeredBy";
  mark(ObserverPoint.BusService);
  const service = show("dbus.service", serviceProperties, remaining);
  const expectedCommand = [SYSTEM_BUS_EXECUTABLE, ...SYSTEM_BUS_ARGUMENTS].join(" ");
  const exec = /^\{ path=([^;]+) ; argv\[\]=(.*?) ; ignore_errors=no ; [^{}]*\}$/.exec(service.ExecStart ?? "");
  if (service.FragmentPath !== descriptor.service.fragmentPath || service.ControlGroup !== SYSTEM_BUS_CONTROL_GROUP ||
      !/^[1-9][0-9]{0,9}$/.test(service.MainPID ?? "") || service.User !== "" || service.Group !== "" ||
      service.Restart !== "no" || service.Type !== "notify" || service.TriggeredBy !== "dbus.socket" ||
      !exec || exec[1] !== SYSTEM_BUS_EXECUTABLE || exec[2] !== expectedCommand ||
      service.Environment !== "") invalid();
  const socketProperties = common + ",Listen,Accept,Triggers,SocketMode,DirectoryMode,RemoveOnStop";
  mark(ObserverPoint.BusSocket);
  const socket = show("dbus.socket", socketProperties, remaining);
  if (socket.FragmentPath !== descriptor.socket.fragmentPath || socket.Listen !== `${SYSTEM_BUS_ENDPOINT} (Stream)` ||
      socket.Accept !== "no" || socket.Triggers !== "dbus.service" || socket.SocketMode !== "0600" ||
      socket.DirectoryMode !== "0755" || socket.RemoveOnStop !== "yes") invalid();
  mark(ObserverPoint.BusProcess);
  const pid = service.MainPID!, initialBirth = birth(pid, remaining);
  const verifyProcess = () => {
    if (birth(pid, remaining) !== initialBirth || readlinkSync(`/proc/${pid}/exe`) !== SYSTEM_BUS_EXECUTABLE ||
        !matchesSystemBusCgroup(boundedProc(`/proc/${pid}/cgroup`, remaining, 4096)) ||
        boundedProc(`/proc/${pid}/cmdline`, remaining, 8192) !== [SYSTEM_BUS_EXECUTABLE, ...SYSTEM_BUS_ARGUMENTS, ""].join("\0") ||
        boundedProc(`/sys/fs/cgroup${SYSTEM_BUS_CONTROL_GROUP}/cgroup.procs`, remaining, 4096).trim() !== pid) invalid();
    processClosure(pid, descriptor.elfClosure, remaining);
  };
  verifyProcess();
  mark(ObserverPoint.BusEndpoint);
  protectedParents(SYSTEM_BUS_ENDPOINT, remaining);
  const endpoint = lstatSync(SYSTEM_BUS_ENDPOINT);
  if (!endpoint.isSocket() || endpoint.uid !== 0 || (endpoint.mode & 0o777) !== 0o600) invalid();
  const verifyListener = (): string => {
    const entries = boundedProc("/proc/net/unix", remaining, 2 * 1024 * 1024).trim().split("\n").slice(1).map(line => line.trim().split(/\s+/));
    const managerInodes = socketInodes("1", remaining), daemonInodes = socketInodes(pid, remaining);
    // Network namespaces can be shared across mount namespaces. A foreign host
    // listener with the same pathname supplies no authority for this guest bus.
    const listeners = entries.filter(fields => fields[7] === SYSTEM_BUS_ENDPOINT && fields[3] === "00010000" && fields[4] === "0001" && fields[5] === "01" &&
      managerInodes.has(fields[6]!) && daemonInodes.has(fields[6]!));
    if (listeners.length !== 1 || !/^[1-9][0-9]*$/.test(listeners[0]![6] ?? "")) invalid();
    const inode = listeners[0]![6]!;
    const ownedListeners = entries.filter(fields => daemonInodes.has(fields[6]!) &&
      /^[a-f0-9]{8}$/.test(fields[3] ?? "") && (parseInt(fields[3]!, 16) & 0x10000) !== 0);
    if (ownedListeners.length !== 1 || ownedListeners[0]![6] !== inode) invalid();
    return inode;
  };
  mark(ObserverPoint.BusListener);
  const listenerInode = verifyListener();
  // PID1's actual registered connection, not a successfully created child bus
  // or a reachable /run/systemd/private manager socket, supplies --wait/--pipe.
  mark(ObserverPoint.BusManager);
  assertSystemdManagerOwner(descriptor.queryTool, remaining);
  mark(ObserverPoint.BusArrays);
  const arrays = observeSystemdServiceEmptyArrays(descriptor.queryTool, "dbus.service", SystemdServiceArrayKind.Infrastructure, remaining);
  for (const fact of arrays) {
    if (fact.property in service && service[fact.property] !== "") invalid();
    service[fact.property] = "";
  }
  if (Object.keys(service).sort().join(",") !== serviceProperties.split(",").sort().join(",") ||
      emptyArrays.some(key => service[key] !== "")) invalid();
  mark(ObserverPoint.BusManagedArrays);
  const requested = managedUnit === undefined ? arrays : observeSystemdServiceEmptyArrays(descriptor.queryTool,
    managedUnit, SystemdServiceArrayKind.FdManaged, remaining);
  mark(ObserverPoint.BusRecheck);
  const freshService = show("dbus.service", serviceProperties, remaining), freshSocket = show("dbus.socket", socketProperties, remaining);
  if (serviceProperties.split(",").some(key => !emptyArrays.some(name => name === key) && freshService[key] !== service[key]) ||
      socketProperties.split(",").some(key => freshSocket[key] !== socket[key])) invalid();
  mark(ObserverPoint.BusFinalManager); assertSystemdManagerOwner(descriptor.queryTool, remaining);
  mark(ObserverPoint.BusFinalProcess); verifyProcess();
  mark(ObserverPoint.BusFinalPins); verifyPins();
  mark(ObserverPoint.BusFinalListener);
  if (verifyListener() !== listenerInode) invalid();
  const after = lstatSync(SYSTEM_BUS_ENDPOINT);
  if (after.dev !== endpoint.dev || after.ino !== endpoint.ino || !after.isSocket() || after.uid !== 0 || (after.mode & 0o777) !== 0o600) invalid();
  remaining(); return requested;
}
