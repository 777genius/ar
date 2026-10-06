import { describe, expect, it } from "vitest";
import { fdCollectorProfilePath, SystemBusInfrastructureRole } from "@vioxen/subscription-runtime/core";
import { parseHostedReadonlyHostInventory } from "../hosted-readonly-inventory";

const sha = "a".repeat(64);
const units = [{ name: "test-supervisor.service", controlGroup: "/system.slice/test-supervisor.service", fragmentSha256: sha },
  { name: "dbus.service", controlGroup: "/system.slice/dbus.service", fragmentSha256: sha }];
const launch = { command: "/usr/bin/node", args: ["/runtime/goal.js","--job-id","TEST-C"], cwd: "/TEST-C/workspace" };
const creator = { creatorId: "TEST-creator", jobId: "TEST-C", jobRootDir: "/TEST-C", workspacePath: launch.cwd, launch };
const bus = { version: 1, role: SystemBusInfrastructureRole.SystemBus,
  service: { name: "dbus.service", controlGroup: "/system.slice/dbus.service", fragmentPath: "/etc/systemd/test-units/dbus.service", fragmentSha256: sha },
  socket: { name: "dbus.socket", endpoint: "/run/dbus/system_bus_socket", fragmentPath: "/etc/systemd/test-units/dbus.socket", fragmentSha256: sha },
  config: { path: "/etc/subscription-runtime/system-bus/bus.conf", sha256: sha },
  executable: { path: "/usr/bin/dbus-daemon", sha256: sha }, elfClosure: [
    { path: "/usr/bin/dbus-daemon", sha256: sha }, { path: "/usr/lib/ld-linux-x86-64.so.2", sha256: sha }] };
function wire(version: number) {
  return { schemaVersion: version, hostId: "b".repeat(32), supervisorUnit: units[0]?.name, units, runtimeLaunch: launch,
    ...(version >= 2 ? { ordinaryCreators: [creator], disabledCreators: ["test-timer.timer"] } : {}),
    ...(version >= 3 ? { systemBusInfrastructure: bus } : {}),
    ...(version === 4 ? { collectorProfile: { path: fdCollectorProfilePath, sha256: sha } } : {}) };
}

// Pure exact wire regression only: these fixture pins/history descriptors are
// NOT signed/runtime authority. Actual adapters still check files/kernel facts.
describe("shared readonly inventory wire extraction", () => {
  it.each([1,2,3,4])("retains original revision%s shape and detached frozen launch data", version => {
    const input = wire(version), before = JSON.stringify(input), parsed = parseHostedReadonlyHostInventory(input);
    expect(JSON.stringify(input)).toBe(before); expect(parsed.schemaVersion).toBe(version);
    expect(parsed.runtimeLaunch).toEqual(launch); expect(Object.isFrozen(parsed.runtimeLaunch.args)).toBe(true);
    expect(parsed.ordinaryCreators).toHaveLength(version === 1 ? 0 : 1);
    expect(parsed.disabledCreators).toEqual(version === 1 ? [] : ["test-timer.timer"]);
    expect(parsed.systemBusInfrastructure?.role).toBe(version >= 3 ? SystemBusInfrastructureRole.SystemBus : undefined);
    expect(parsed.collectorProfile?.path).toBe(version === 4 ? fdCollectorProfilePath : undefined);
    expect(parsed.runtimeLaunch.args).not.toBe(input.runtimeLaunch.args);
  });
  it("keeps legacy field refusal, exact modern prerequisites and unknown revision denial", () => {
    for (const bad of [{ ...wire(1), ordinaryCreators: [] }, { ...wire(2), systemBusInfrastructure: bus },
      { ...wire(3), collectorProfile: { path: fdCollectorProfilePath, sha256: sha } }, { ...wire(2), approved: true }, wire(5)]) {
      expect(() => parseHostedReadonlyHostInventory(bad)).toThrow();
    }
    const absentBus = wire(3), absentProfile = wire(4);
    Reflect.deleteProperty(absentBus,"systemBusInfrastructure"); Reflect.deleteProperty(absentProfile,"collectorProfile");
    expect(() => parseHostedReadonlyHostInventory(absentBus)).toThrow();
    expect(() => parseHostedReadonlyHostInventory(absentProfile)).toThrow();
  });
  it("preserves actual creator alias/slot uniqueness and supervisor/disabled closure", () => {
    for (const bad of [{ ...wire(2), units: [units[0],units[0]] }, { ...wire(2), supervisorUnit: "missing.service" },
      { ...wire(2), disabledCreators: ["test-supervisor.service"] },
      { ...wire(2), ordinaryCreators: [creator,{ ...creator, creatorId: "other", jobId: "other" }] },
      { ...wire(2), ordinaryCreators: [{ ...creator, childSlotSha256: sha },{ ...creator, creatorId: "other", childSlotSha256: sha }] },
      { ...wire(2), runtimeLaunch: { ...launch, cwd: "/TEST-C/../workspace" } }]) {
      expect(() => parseHostedReadonlyHostInventory(bad)).toThrow("hosted_custody_kernel_evidence_invalid");
    }
  });
});
