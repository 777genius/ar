import { describe, expect, it } from "vitest";
import { parseSystemBusInfrastructure, readSystemBusInfrastructureField, SystemBusInfrastructureRole } from "../host-infrastructure/system-bus-infrastructure";

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
describe("closed system-bus infrastructure wire contract", () => {
  it("parses the explicit role immutably without granting OS authority", () => {
    const parsed = parseSystemBusInfrastructure(descriptor());
    expect(parsed.service.name).toBe("dbus.service");
    expect(Object.isFrozen(parsed.elfClosure)).toBe(true);
    expect(Object.isFrozen(parsed.socket)).toBe(true);
  });
  it("requires the role in revision 3 and rejects it in older revisions", () => {
    expect(readSystemBusInfrastructureField({ schemaVersion: 2 })).toBeUndefined();
    expect(readSystemBusInfrastructureField({ schemaVersion: 1 })).toBeUndefined();
    expect(() => readSystemBusInfrastructureField({ schemaVersion: 3 })).toThrow("infrastructure_invalid");
    for (const schemaVersion of [1, 2, 4]) expect(() => readSystemBusInfrastructureField({ schemaVersion, systemBusInfrastructure: descriptor() })).toThrow();
    expect(readSystemBusInfrastructureField({ schemaVersion: 3, systemBusInfrastructure: descriptor() })?.role).toBe(SystemBusInfrastructureRole.SystemBus);
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
