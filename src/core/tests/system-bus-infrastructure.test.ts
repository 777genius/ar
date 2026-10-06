import { describe, expect, it } from "vitest";
import { parseSystemBusInfrastructure, readSystemBusInfrastructureField, SystemBusInfrastructureRole,
  SystemBusQueryRenderer } from "../host-infrastructure/system-bus-infrastructure";

// Regression boundary: unknown infrastructure, an ignored revision downgrade,
// or a socket granted as a process cgroup must fail before OS admission.
function descriptor() {
  return { version: 1, role: SystemBusInfrastructureRole.SystemBus,
    service: { name: "dbus.service", controlGroup: "/system.slice/dbus.service", fragmentPath: "/etc/systemd/test-units/dbus.service", fragmentSha256: "a".repeat(64) },
    socket: { name: "dbus.socket", endpoint: "/run/dbus/system_bus_socket", fragmentPath: "/etc/systemd/test-units/dbus.socket", fragmentSha256: "b".repeat(64) },
    config: { path: "/etc/subscription-runtime/system-bus/bus.conf", sha256: "c".repeat(64) },
    executable: { path: "/usr/bin/dbus-daemon", sha256: "d".repeat(64) },
    elfClosure: [{ path: "/usr/bin/dbus-daemon", sha256: "d".repeat(64) },
      { path: "/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2", sha256: "e".repeat(64) }] };
}
function currentDescriptor() {
  return { ...descriptor(), version: 2, queryTool: { renderer: SystemBusQueryRenderer.Systemd255Terse,
    path: "/usr/bin/busctl", sha256: "f".repeat(64), elfClosure: [
      { path: "/usr/bin/busctl", sha256: "f".repeat(64) },
      { path: "/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2", sha256: "e".repeat(64) }] } };
}
describe("closed system-bus infrastructure wire contract", () => {
  it("parses the explicit role immutably without granting OS authority", () => {
    const parsed = parseSystemBusInfrastructure(descriptor());
    expect(parsed.service.name).toBe("dbus.service");
    expect(Object.isFrozen(parsed.elfClosure)).toBe(true);
    expect(Object.isFrozen(parsed.socket)).toBe(true);
  });
  it("requires the role in revisions 3 and 4 and rejects legacy field smuggling and unknown revisions", () => {
    for (const schemaVersion of [1, 2]) {
      expect(readSystemBusInfrastructureField({ schemaVersion })).toBeUndefined();
      expect(() => readSystemBusInfrastructureField({ schemaVersion, systemBusInfrastructure: descriptor() })).toThrow("infrastructure_invalid");
    }
    for (const schemaVersion of [3, 4]) {
      expect(() => readSystemBusInfrastructureField({ schemaVersion })).toThrow("infrastructure_invalid");
      expect(readSystemBusInfrastructureField({ schemaVersion, systemBusInfrastructure: descriptor() })?.role).toBe(SystemBusInfrastructureRole.SystemBus);
    }
    for (const schemaVersion of [0, 5, "4"]) {
      expect(() => readSystemBusInfrastructureField({ schemaVersion })).toThrow("infrastructure_invalid");
      expect(() => readSystemBusInfrastructureField({ schemaVersion, systemBusInfrastructure: descriptor() })).toThrow("infrastructure_invalid");
    }
  });
  it("detaches the v2 query closure without adding it to daemon maps or upgrading history", () => {
    const source = currentDescriptor(), parsed = parseSystemBusInfrastructure(source);
    source.queryTool.elfClosure[0]!.sha256 = "0".repeat(64);
    source.queryTool.elfClosure.push({ path: "/usr/lib/foreign.so", sha256: "1".repeat(64) });
    expect(parsed.version).toBe(2);
    if (parsed.version !== 2) throw new Error("TEST expected v2");
    expect(parsed.queryTool.elfClosure).toHaveLength(2);
    expect(parsed.queryTool.elfClosure[0]!.sha256).toBe("f".repeat(64));
    expect(Object.isFrozen(parsed.queryTool.elfClosure[0])).toBe(true);
    expect(parsed.elfClosure.map(pin => pin.path)).not.toContain("/usr/bin/busctl");
    expect(parseSystemBusInfrastructure(descriptor()).version).toBe(1);
  });
  it.each(["missing-tool", "wrong-renderer", "other-tool", "unbound-tool", "missing-query-loader", "duplicate-query-pin", "conflicting-shared-pin", "v1-smuggling"])(
    "rejects %s rather than minting query provenance", fault => {
      const value = currentDescriptor();
      if (fault === "missing-tool") Reflect.deleteProperty(value, "queryTool");
      if (fault === "wrong-renderer") Object.assign(value.queryTool, { renderer: "systemd-unknown" });
      if (fault === "other-tool") value.queryTool.path = "/usr/bin/foreign";
      if (fault === "unbound-tool") value.queryTool.elfClosure[0]!.sha256 = "0".repeat(64);
      if (fault === "missing-query-loader") value.queryTool.elfClosure[1]!.path = "/usr/lib/foreign.so";
      if (fault === "duplicate-query-pin") value.queryTool.elfClosure.push(value.queryTool.elfClosure[0]!);
      if (fault === "conflicting-shared-pin") value.queryTool.elfClosure[1]!.sha256 = "0".repeat(64);
      if (fault === "v1-smuggling") value.version = 1;
      expect(() => parseSystemBusInfrastructure(value)).toThrow("infrastructure_invalid");
    });
  it.each(["unknown-role", "unknown-field", "socket-cgroup", "other-socket", "other-config", "dot-path", "unbound-executable", "missing-loader", "duplicate-closure"])(
    "rejects %s rather than widening the closed role", fault => {
      const value = descriptor();
      if (fault === "unknown-role") Object.assign(value, { role: "timer" });
      if (fault === "unknown-field") Object.assign(value, { authorized: true });
      if (fault === "socket-cgroup") value.service.controlGroup = "/system.slice/dbus.socket";
      if (fault === "other-socket") value.socket.name = "provider.socket";
      if (fault === "other-config") value.config.path = "/etc/dbus-1/system.conf";
      if (fault === "dot-path") value.service.fragmentPath = "/etc/systemd/../dbus.service";
      if (fault === "unbound-executable") value.elfClosure[0]!.sha256 = "0".repeat(64);
      if (fault === "missing-loader") value.elfClosure[1]!.path = "/usr/lib/libforeign.so";
      if (fault === "duplicate-closure") value.elfClosure.push(value.elfClosure[0]!);
      expect(() => parseSystemBusInfrastructure(value)).toThrow("infrastructure_invalid");
    });
});
