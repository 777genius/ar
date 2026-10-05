import { createHash } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSystemBusInfrastructure, SYSTEM_BUS_ARGUMENTS, SYSTEM_BUS_CONFIG, SYSTEM_BUS_SERVICE_FRAGMENT,
  SYSTEM_BUS_SOCKET_FRAGMENT, type SystemBusInfrastructure } from "@vioxen/subscription-runtime/core";
import { verifySystemBusInfrastructure } from "../app-server/adapters/system-bus-infrastructure";

// Regression boundary: matching JSON pins alone cannot qualify a bus. All OS
// observations are synthetic; no manager, host file, socket or provider runs.
const os = vi.hoisted(() => ({ files: new Map<string, Buffer>(), links: new Map<string, string>(),
  opened: new Map<number, string>(), nextFd: 100, service: {} as Record<string, string>, socket: {} as Record<string, string>,
  unsafePath: "", busOwner: "u 1", secondBirth: false, birthReads: 0 }));
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
vi.mock("node:fs", () => ({
  constants: { O_RDONLY: 0, O_NOFOLLOW: 1, O_NONBLOCK: 2 },
  openSync: (path: string) => { if (!os.files.has(path)) throw new Error("synthetic absent pin"); const fd = os.nextFd++; os.opened.set(fd, path); return fd; },
  closeSync: (fd: number) => os.opened.delete(fd),
  fstatSync: (fd: number) => stat(os.opened.get(fd)!),
  lstatSync: (path: string) => stat(path),
  readSync: (fd: number, output: Buffer, offset: number, length: number, position: number) => {
    const bytes = os.files.get(os.opened.get(fd)!)!, count = Math.min(length, bytes.length - position);
    if (count > 0) bytes.copy(output, offset, position, position + count);
    return Math.max(0, count);
  },
  readFileSync: (path: string) => {
    if (path === "/proc/42/stat" && os.secondBirth && ++os.birthReads > 1) return Buffer.from("42 (replacement) S 1 " + [...Array(17).fill("0"), "999"].join(" "));
    const value = os.files.get(path); if (!value) throw new Error("synthetic absent observation"); return value;
  },
  readlinkSync: (path: string) => { const value = os.links.get(path); if (!value) throw new Error("synthetic absent link"); return value; },
  readdirSync: (path: string) => [...os.links.keys()].filter(link => link.startsWith(path + "/")).map(link => link.slice(path.length + 1)),
}));
function stat(path: string) {
  const file = os.files.has(path) && !path.startsWith("/proc/") && !path.startsWith("/sys/");
  return { isFile: () => file, isDirectory: () => !file && path !== "/run/dbus/system_bus_socket",
    isSocket: () => path === "/run/dbus/system_bus_socket", isSymbolicLink: () => false,
    uid: 0, nlink: 1, mode: path === os.unsafePath ? 0o777 : path === "/run/dbus/system_bus_socket" ? 0o600 : 0o755,
    size: os.files.get(path)?.length ?? 0, dev: 1, ino: 500, ctimeMs: 1, mtimeMs: 1 };
}
vi.mock("node:child_process", () => ({ spawnSync: (executable: string, args: string[]) => {
  if (executable === "/usr/bin/busctl") return { status: 0, stdout: os.busOwner };
  if (executable !== "/usr/bin/systemctl" || args[0] !== "show") throw new Error("unplanned synthetic command");
  const source = args.at(-1) === "dbus.service" ? os.service : os.socket;
  const keys = args[1]!.slice("--property=".length).split(",");
  return { status: 0, stdout: keys.map(key => `${key}=${source[key] ?? ""}`).join("\n") };
} }));
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
let input: SystemBusInfrastructure;
beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "linux" });
  vi.spyOn(process, "getuid").mockReturnValue(0);
  os.files.clear(); os.links.clear(); os.opened.clear(); os.nextFd = 100;
  os.unsafePath = ""; os.busOwner = "u 1"; os.secondBirth = false; os.birthReads = 0;
  const elf = Buffer.alloc(32); elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]); elf.writeUInt16LE(62, 18);
  const executable = "/usr/bin/dbus-daemon", loader = "/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2";
  os.files.set(executable, elf); os.files.set(loader, elf);
  const servicePath = "/etc/systemd/test-units/dbus.service", socketPath = "/etc/systemd/test-units/dbus.socket";
  os.files.set(servicePath, Buffer.from(SYSTEM_BUS_SERVICE_FRAGMENT)); os.files.set(socketPath, Buffer.from(SYSTEM_BUS_SOCKET_FRAGMENT));
  os.files.set("/etc/subscription-runtime/system-bus/bus.conf", Buffer.from(SYSTEM_BUS_CONFIG));
  input = parseSystemBusInfrastructure({ version: 1, role: "system-bus",
    service: { name: "dbus.service", controlGroup: "/system.slice/dbus.service", fragmentPath: servicePath, fragmentSha256: hash(SYSTEM_BUS_SERVICE_FRAGMENT) },
    socket: { name: "dbus.socket", endpoint: "/run/dbus/system_bus_socket", fragmentPath: socketPath, fragmentSha256: hash(SYSTEM_BUS_SOCKET_FRAGMENT) },
    config: { path: "/etc/subscription-runtime/system-bus/bus.conf", sha256: hash(SYSTEM_BUS_CONFIG) }, executable: { path: executable, sha256: hash(elf) },
    elfClosure: [{ path: executable, sha256: hash(elf) }, { path: loader, sha256: hash(elf) }] });
  const common = { LoadState: "loaded", ActiveState: "active", SubState: "running", DropInPaths: "", Job: "" };
  os.service = { ...common, Id: "dbus.service", Names: "dbus.service", FragmentPath: servicePath, ControlGroup: "/system.slice/dbus.service", MainPID: "42",
    ExecStart: `{ path=${executable} ; argv[]=${[executable, ...SYSTEM_BUS_ARGUMENTS].join(" ")} ; ignore_errors=no ; pid=42 ; code=(null) ; status=0/0 }`,
    Restart: "no", Type: "notify", TriggeredBy: "dbus.socket" };
  os.socket = { ...common, Id: "dbus.socket", Names: "dbus.socket", FragmentPath: socketPath, Listen: "/run/dbus/system_bus_socket (Stream)",
    Accept: "no", Triggers: "dbus.service", SocketMode: "0600", DirectoryMode: "0755", RemoveOnStop: "yes" };
  for (const namespace of ["user", "mnt", "pid", "net"]) {
    os.links.set(`/proc/self/ns/${namespace}`, `${namespace}:[1]`); os.links.set(`/proc/1/ns/${namespace}`, `${namespace}:[1]`);
  }
  os.links.set("/proc/42/exe", executable); os.links.set("/proc/42/fd/3", "socket:[900]"); os.links.set("/proc/1/fd/3", "socket:[900]");
  for (const [path, bytes] of [
    ["/proc/self/uid_map", "0 0 4294967295\n"], ["/proc/42/stat", "42 (daemon with spaces) S 1 " + [...Array(17).fill("0"), "123"].join(" ")],
    ["/proc/42/cgroup", "0::/system.slice/dbus.service\n"], ["/proc/42/cmdline", [executable, ...SYSTEM_BUS_ARGUMENTS, ""].join("\0")],
    ["/sys/fs/cgroup/system.slice/dbus.service/cgroup.procs", "42\n"],
    ["/proc/42/maps", `1000-2000 r-xp 0000 01:01 1 ${executable}\n3000-4000 r-xp 0000 01:01 2 ${loader}\n5000-6000 r-xp 0000 00:00 0 [vdso]\n`],
    ["/proc/net/unix", "Num RefCount Protocol Flags Type St Inode Path\n0000: 00000002 00000000 00010000 0001 01 900 /run/dbus/system_bus_socket\n"],
  ]) os.files.set(path!, Buffer.from(bytes!));
});
afterAll(() => { vi.restoreAllMocks(); Object.defineProperty(process, "platform", platform); });
describe("actual finite system-bus admission observations", () => {
  it("accepts the pinned fixed units plus actual ELF process, shared listener and registered PID1", () => {
    expect(() => verifySystemBusInfrastructure(input)).not.toThrow();
  });
  it("accepts its owned bus alongside a foreign same-path listener in the shared network namespace", () => {
    os.files.set("/proc/net/unix", Buffer.concat([os.files.get("/proc/net/unix")!,
      Buffer.from("0001: 00000002 00000000 00010000 0001 01 901 /run/dbus/system_bus_socket\n")]));
    expect(() => verifySystemBusInfrastructure(input)).not.toThrow();
  });
  it.each(["ambiguous-owned-endpoint", "other-owned-path", "unnamed-owned-listener", "other-owned-type"])(
    "rejects %s instead of accepting extra daemon control surfaces", fault => {
      os.links.set("/proc/42/fd/4", "socket:[901]");
      if (fault === "ambiguous-owned-endpoint") os.links.set("/proc/1/fd/4", "socket:[901]");
      const endpoint = fault === "ambiguous-owned-endpoint" ? " /run/dbus/system_bus_socket" :
        fault === "other-owned-path" ? " /run/foreign-control" : "";
      const type = fault === "other-owned-type" ? "0005" : "0001";
      os.files.set("/proc/net/unix", Buffer.concat([os.files.get("/proc/net/unix")!,
        Buffer.from(`0001: 00000002 00000000 00010000 ${type} 01 901${endpoint}\n`)]));
      expect(() => verifySystemBusInfrastructure(input)).toThrow("infrastructure_unqualified");
    });
  it("rejects an activation-enabled config even when its new bytes match the inventory pin", () => {
    const bytes = Buffer.from(SYSTEM_BUS_CONFIG + "<servicedir>/tmp</servicedir>\n");
    os.files.set(input.config.path, bytes);
    input = parseSystemBusInfrastructure({ ...input, config: { ...input.config, sha256: hash(bytes) } });
    expect(() => verifySystemBusInfrastructure(input)).toThrow("infrastructure_unqualified");
  });
  it.each(["config-activation", "changed-elf", "untrusted-parent", "extra-command", "socket-alias", "queued-job", "foreign-cgroup", "extra-mapping", "missing-daemon-listener", "missing-pid1-listener", "unregistered-pid1", "reused-pid", "extra-process", "other-namespace"])(
    "keeps infrastructure closed on %s despite matching inventory identity", fault => {
      if (fault === "config-activation") os.files.set(input.config.path, Buffer.from(SYSTEM_BUS_CONFIG + "<servicedir>/tmp</servicedir>\n"));
      if (fault === "changed-elf") os.files.set(input.executable.path, Buffer.from("untrusted executable"));
      if (fault === "untrusted-parent") os.unsafePath = "/etc/subscription-runtime/system-bus";
      if (fault === "extra-command") os.service.ExecStartPre = "/usr/bin/helper";
      if (fault === "socket-alias") os.socket.Names = "dbus.socket provider.socket";
      if (fault === "queued-job") os.socket.Job = "7 /org/freedesktop/systemd1/job/7";
      if (fault === "foreign-cgroup") os.files.set("/proc/42/cgroup", Buffer.from("0::/system.slice/foreign.service"));
      if (fault === "extra-mapping") os.files.set("/proc/42/maps", Buffer.concat([os.files.get("/proc/42/maps")!, Buffer.from("7000-8000 r-xp 0000 01:01 3 /usr/lib/foreign.so\n")]));
      if (fault === "missing-daemon-listener") os.links.set("/proc/42/fd/3", "socket:[901]");
      if (fault === "missing-pid1-listener") os.links.set("/proc/1/fd/3", "socket:[901]");
      if (fault === "unregistered-pid1") os.busOwner = "u 43";
      if (fault === "reused-pid") os.secondBirth = true;
      if (fault === "extra-process") os.files.set("/sys/fs/cgroup/system.slice/dbus.service/cgroup.procs", Buffer.from("42\n43\n"));
      if (fault === "other-namespace") os.links.set("/proc/self/ns/net", "net:[2]");
      expect(() => verifySystemBusInfrastructure(input)).toThrow("infrastructure_unqualified");
    });
});
