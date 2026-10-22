import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { dirname } from "node:path";
import { SYSTEM_BUS_ENDPOINT, SYSTEM_BUS_QUERY_EXECUTABLE, SystemBusQueryRenderer,
  type SystemBusQueryTool } from "@vioxen/subscription-runtime/core";
import { AppServerObserverPoint as ObserverPoint, retainObserverFailure } from "../domain/app-server-observer-failure";

/** Measures a real caller's original monotonic allowance; it supplies no proof. */
export type SystemdObservationRemaining = () => number;
export enum SystemdServiceArrayKind { Infrastructure = "infrastructure", FdManaged = "fd_managed" }
export enum SystemdArrayProperty { EnvironmentFiles = "EnvironmentFiles", ExecCondition = "ExecCondition",
  ExecStartPre = "ExecStartPre", ExecStartPost = "ExecStartPost", ExecReload = "ExecReload",
  ExecStop = "ExecStop", ExecStopPost = "ExecStopPost" }
export enum SystemdArraySignature { EnvironmentFiles = "a(sb)", ExecCommandList = "a(sasbttttuii)" }
export type SystemdEmptyArrayFact = Readonly<{ property: SystemdArrayProperty; signature: SystemdArraySignature; count: 0 }>;
const environment = { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", SYSTEMD_COLORS: "0" };
const address = `--address=unix:path=${SYSTEM_BUS_ENDPOINT}`;
function invalid(): never { throw new Error("systemd_service_arrays_unqualified"); }
function left(remaining: SystemdObservationRemaining): number {
  const n = remaining();
  if (!Number.isSafeInteger(n) || n < 1) invalid();
  return n;
}
/** One sequence budget, including synchronous IO, never one deadline per child. */
export function systemdObservationBudget(outer?: SystemdObservationRemaining): SystemdObservationRemaining {
  const deadline = process.hrtime.bigint() + 5_000_000_000n;
  return () => {
    const own = Number((deadline - process.hrtime.bigint()) / 1_000_000n);
    if (own < 1) invalid();
    return outer ? Math.min(own, left(outer)) : own;
  };
}
function properties(kind: SystemdServiceArrayKind): readonly SystemdArrayProperty[] {
  const common = [SystemdArrayProperty.ExecStartPre, SystemdArrayProperty.ExecStartPost,
    SystemdArrayProperty.ExecReload, SystemdArrayProperty.ExecStop, SystemdArrayProperty.ExecStopPost,
    SystemdArrayProperty.EnvironmentFiles];
  if (kind === SystemdServiceArrayKind.Infrastructure) return common;
  if (kind === SystemdServiceArrayKind.FdManaged) return [SystemdArrayProperty.ExecCondition, ...common];
  invalid();
}
function signature(property: SystemdArrayProperty): SystemdArraySignature {
  return property === SystemdArrayProperty.EnvironmentFiles ? SystemdArraySignature.EnvironmentFiles : SystemdArraySignature.ExecCommandList;
}
/** Pure protocol facts. A decoded reply is never manager/FD/admission authority. */
export function decodeSystemdEmptyArrays(kind: SystemdServiceArrayKind, text: string): readonly SystemdEmptyArrayFact[] {
  if (Buffer.byteLength(text) > 4096) invalid();
  const rows = (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n"), names = properties(kind);
  if (rows.length !== names.length) invalid();
  return Object.freeze(names.map((property, index) => {
    const type = signature(property);
    if (rows[index] !== `${type} 0`) invalid();
    return Object.freeze({ property, signature: type, count: 0 as const });
  }));
}
export function assertPinnedSystemBusQueryTool(tool: SystemBusQueryTool, remaining: SystemdObservationRemaining): void {
  left(remaining);
  if (tool.path !== SYSTEM_BUS_QUERY_EXECUTABLE || tool.renderer !== SystemBusQueryRenderer.Systemd255Terse ||
      tool.elfClosure.length < 2 || tool.elfClosure.length > 64 ||
      new Set(tool.elfClosure.map(pin => pin.path)).size !== tool.elfClosure.length ||
      !tool.elfClosure.some(pin => pin.path === tool.path && pin.sha256 === tool.sha256) ||
      !tool.elfClosure.some(pin => /^\/usr\/lib\/[^/]+\/ld-linux-x86-64\.so\.2$/.test(pin.path))) invalid();
  let bytes = 0;
  for (const pin of tool.elfClosure) {
    left(remaining);
    for (let current = dirname(pin.path);; current = dirname(current)) {
      const stat = lstatSync(current); left(remaining);
      if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022)) invalid();
      if (current === "/") break;
    }
    const fd = openSync(pin.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = fstatSync(fd), entry = lstatSync(pin.path);
      if (!before.isFile() || before.uid !== 0 || before.nlink !== 1 || (before.mode & 0o022) ||
          before.size < 20 || before.size > 32 * 1024 * 1024 || (bytes += before.size) > 256 * 1024 * 1024 ||
          entry.dev !== before.dev || entry.ino !== before.ino ||
          (pin.path === tool.path && !(before.mode & 0o111))) invalid();
      const hash = createHash("sha256"), buffer = Buffer.alloc(65536); let position = 0;
      while (position < before.size) {
        left(remaining);
        const count = readSync(fd, buffer, 0, Math.min(buffer.length, before.size - position), position);
        if (count < 1) invalid();
        if (position === 0 && (count < 20 || buffer[0] !== 127 || buffer.subarray(1, 4).toString() !== "ELF" ||
            buffer[4] !== 2 || buffer[5] !== 1 || buffer.readUInt16LE(18) !== 62)) invalid();
        hash.update(buffer.subarray(0, count)); position += count; left(remaining);
      }
      const after = fstatSync(fd), current = lstatSync(pin.path);
      for (const stat of [after, current]) {
        if (!stat.isFile() || stat.uid !== 0 || stat.nlink !== 1 || (stat.mode & 0o022) ||
            stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size ||
            stat.ctimeMs !== before.ctimeMs || stat.mtimeMs !== before.mtimeMs || stat.mode !== before.mode) invalid();
      }
      if (hash.digest("hex") !== pin.sha256) invalid();
      left(remaining);
    } finally { closeSync(fd); }
  }
}
function command(tool: SystemBusQueryTool, args: readonly string[], remaining: SystemdObservationRemaining): string {
  const result = spawnSync(tool.path, [address, "--no-pager", "--auto-start=no", "--allow-interactive-authorization=no", ...args],
    { encoding: "utf8", env: environment, stdio: ["ignore", "pipe", "pipe"], timeout: Math.min(5000, left(remaining)), maxBuffer: 4096 });
  left(remaining);
  if (result.error || result.signal || result.status !== 0 || result.stderr || typeof result.stdout !== "string" ||
      Buffer.byteLength(result.stdout) > 4096) invalid();
  return result.stdout;
}
export function assertSystemdManagerOwner(tool: SystemBusQueryTool, remaining: SystemdObservationRemaining): void {
  const began = process.hrtime.bigint(); let point = ObserverPoint.ArrayPin;
  try {
  assertPinnedSystemBusQueryTool(tool, remaining);
  point = ObserverPoint.ManagerRead;
  const result = command(tool, ["call", "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
    "GetConnectionUnixProcessID", "s", "org.freedesktop.systemd1"], remaining);
  if (result !== "u 1" && result !== "u 1\n") invalid();
  point = ObserverPoint.ArrayFinalPin; assertPinnedSystemBusQueryTool(tool, remaining);
  } catch (error) { retainObserverFailure(error, point, Math.min(60000, Math.max(0, Number((process.hrtime.bigint() - began) / 1000000n)))); throw error; }
}
/** Factual fixed reads only. Actual callers retain provenance and final fence. */
export function observeSystemdServiceEmptyArrays(tool: SystemBusQueryTool, unit: string,
  kind: SystemdServiceArrayKind, remaining: SystemdObservationRemaining): readonly SystemdEmptyArrayFact[] {
  const began = process.hrtime.bigint(); let point = ObserverPoint.ArrayPin;
  try {
  if (kind === SystemdServiceArrayKind.Infrastructure ? unit !== "dbus.service" :
      kind !== SystemdServiceArrayKind.FdManaged ||
      !/^subscription-runtime-(?:outer|ordinary|hosted|installer|research-provider)-[a-f0-9-]{36}\.service$/.test(unit)) invalid();
  assertPinnedSystemBusQueryTool(tool, remaining);
  point = ObserverPoint.ArrayUnit;
  const path = command(tool, ["call", "org.freedesktop.systemd1", "/org/freedesktop/systemd1",
    "org.freedesktop.systemd1.Manager", "GetUnit", "s", unit], remaining);
  const match = /^o "(\/org\/freedesktop\/systemd1\/unit\/[A-Za-z0-9_]{1,2048})"\n?$/.exec(path);
  if (!match) invalid();
  point = ObserverPoint.ArrayRead;
  const facts = decodeSystemdEmptyArrays(kind, command(tool, ["get-property", "org.freedesktop.systemd1", match[1]!,
    "org.freedesktop.systemd1.Service", ...properties(kind)], remaining));
  if (kind === SystemdServiceArrayKind.FdManaged) {
    point = ObserverPoint.ArrayPolicy;
    assertSystemdIoUringPolicy(command(tool, ["get-property", "org.freedesktop.systemd1", match[1]!,
      "org.freedesktop.systemd1.Service", "SystemCallFilter", "SystemCallArchitectures", "NoNewPrivileges"], remaining));
  }
  point = ObserverPoint.ArrayFinalPin; assertPinnedSystemBusQueryTool(tool, remaining);
  return facts;
  } catch (error) { retainObserverFailure(error, point, Math.min(60000, Math.max(0, Number((process.hrtime.bigint() - began) / 1000000n)))); throw error; }
}

/** Literal v255 busctl format_cmdline: struct fields flatten, arrays carry
 * counts, booleans use true/false, strings are quoted; execute.c sorts names.
 * Decoding is data validation only, never an admission or retroactive permit. */
export function assertSystemdIoUringPolicy(text: string): void {
  if (Buffer.byteLength(text) > 4096) invalid();
  const rows = (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
  if (rows.length !== 3 || rows[0] !== '(bas) false 3 "io_uring_enter:ENOSYS" "io_uring_register:ENOSYS" "io_uring_setup:ENOSYS"' ||
      rows[1] !== 'as 1 "native"' || rows[2] !== "b true") invalid();
}
