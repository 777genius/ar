import { describe, expect, it } from "vitest";
import { decodeHostedInventoryBytes, HostedInventoryCategory, parseHostedInventoryV5, type HostedInventoryV5 } from "../host-infrastructure/host-inventory";
function fixture(count = 129): HostedInventoryV5 {
  const units = Array.from({ length: count }, (_, i) => ({ category: i === 0 ? HostedInventoryCategory.Supervisor : HostedInventoryCategory.Borrowed,
    name: `fixture-${i}.service`, aliases: [], controlGroup: `/fixture-${i}.service`, fragmentPath: `/fixture/fixture-${i}.service`,
    fragmentSha256: "a".repeat(64), dropIns: [{ path: `/fixture/fixture-${i}.service.d/ordered.conf`, sha256: "b".repeat(64) }],
    loadState: "loaded", activeState: i === 0 ? "active" : "inactive", unitFileState: "static", invocationId: i === 0 ? "c".repeat(32) : "",
    mainPidBirth: i === 0 ? "100:200" : null, job: "", delegate: false as const }));
  const launch = { command: "/fixture/node", args: ["/fixture/codex-goal-cli.js", "tool", "codex_goal_project_start", "--args-json", "{}", "--json"], cwd: "/fixture/jobs/TEST-codec/workspace" };
  return { schemaVersion: 5, hostId: "d".repeat(32), bootId: "11111111-1111-1111-1111-111111111111", supervisorUnit: units[0]!.name, units,
    cgroups: [{ path: "", parent: null, ownerUnit: null, dev: "1", ino: "1", members: [] }, ...units.map((u, i) => ({ path: u.controlGroup, parent: "", ownerUnit: u.name,
      dev: "1", ino: String(i + 2), members: i === 0 ? [{ birth: "100:200", controlGroup: u.controlGroup }] : [] }))],
    activators: [], supervisor: { birth: "100:200", executable: { path: "/fixture/node", sha256: "e".repeat(64) }, bootstrap: { path: "/fixture/bootstrap.js", sha256: "f".repeat(64) },
      operationId: "11111111-1111-1111-1111-111111111111", workEndEpochMs: 1000, cleanupEndEpochMs: 2000 },
    ordinaryCreators: [{ creatorId: "fixture-creator", jobId: "TEST-codec", jobRootDir: "/fixture/jobs/TEST-codec", workspacePath: launch.cwd, launch }],
    disabledCreators: [], runtimeLaunch: launch, collectorProfile: { path: "/var/lib/subscription-runtime-host-policy/fd-collector-profile.v1.json", sha256: "a".repeat(64) },
    systemBusInfrastructure: {} };
}
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
describe("ordinary installation fixed inventory DATA codec", () => {
  it("admits >128 finite rows with ordered drop-ins and freezes every owned structural row", () => {
    const original = fixture(300), encoded = bytes(original);
    expect(encoded.length).toBeGreaterThan(64 * 1024);
    const decoded = decodeHostedInventoryBytes(encoded) as HostedInventoryV5;
    expect(decoded.units).toHaveLength(300);
    expect(decoded.units[299]!.dropIns[0]!.path).toBe("/fixture/fixture-299.service.d/ordered.conf");
    expect(Object.isFrozen(decoded.units[299]!.dropIns[0])).toBe(true);
    expect(Object.isFrozen(decoded.cgroups[1]!.members[0])).toBe(true);
    expect(() => decodeHostedInventoryBytes(bytes({ ...original, schemaVersion: 4 }))).toThrow("hosted_inventory_invalid");
  });
  it("admits a borrowed active unit without a live MainPID only with its empty associated group", () => {
    const original = fixture(2);
    const completed = { ...original, units: original.units.map((u, i) => i === 1 ? { ...u, activeState: "active", invocationId: "b".repeat(32) } : u) };
    expect(parseHostedInventoryV5(completed).units[1]!.mainPidBirth).toBeNull();
    expect(() => parseHostedInventoryV5({ ...completed, cgroups: completed.cgroups.map((c, i) => i === 2 ? {
      ...c, members: [{ birth: "101:201", controlGroup: c.path }],
    } : c) })).toThrow("hosted_inventory_invalid");
  });
  it("refuses category aliases, duplicate physical nodes, unknown targets and mutable roots", () => {
    const original = fixture();
    expect(() => parseHostedInventoryV5({ ...original, units: original.units.map((u, i) => i === 1 ? { ...u, category: HostedInventoryCategory.Supervisor } : u) })).toThrow();
    expect(() => parseHostedInventoryV5({ ...original, units: original.units.map((u, i) => i === 1 ? { ...u, aliases: [original.supervisorUnit] } : u) })).toThrow();
    expect(() => parseHostedInventoryV5({ ...original, cgroups: original.cgroups.map((c, i) => i === 1 ? { ...c, ino: "1" } : c) })).toThrow();
    expect(() => parseHostedInventoryV5({ ...original, cgroups: original.cgroups.map((c, i) => i === 0 ? { ...c, members: [{ birth: "101:201", controlGroup: "" }] } : c) })).toThrow();
    expect(() => parseHostedInventoryV5({ ...original, activators: [{ name: "fixture.timer", aliases: [], targets: ["unknown.service"], controlGroup: null, delegate: null, fragmentPath: "/fixture/timer", fragmentSha256: "a".repeat(64),
      dropIns: [], loadState: "loaded", activeState: "active", unitFileState: "enabled", invocationId: "b".repeat(32), job: "" }] })).toThrow();
  });
  it("retains socket group/delegation facts and distinguishes timer properties", () => {
    const original = fixture(2), configuration = original.units[1]!;
    const socket = { name: "fixture.socket", aliases: [], targets: [configuration.name], controlGroup: configuration.controlGroup, delegate: false,
      fragmentPath: "/fixture/socket", fragmentSha256: "a".repeat(64), dropIns: [], loadState: "loaded", activeState: "active",
      unitFileState: "enabled", invocationId: "b".repeat(32), job: "" };
    expect(parseHostedInventoryV5({ ...original, activators: [socket] }).activators[0]!.controlGroup).toBe(configuration.controlGroup);
    expect(() => parseHostedInventoryV5({ ...original, activators: [{ ...socket, delegate: null }] })).toThrow();
    expect(() => parseHostedInventoryV5({ ...original, activators: [{ ...socket, name: "fixture.timer", delegate: null }] })).toThrow();
    expect(parseHostedInventoryV5({ ...original, activators: [{ ...socket, name: "fixture.timer", controlGroup: null, delegate: null }] }).activators[0]!.controlGroup).toBeNull();
  });
  it("requires the actual borrowed scope row for init.scope and retains all of its members", () => {
    const original = fixture(2), controlGroup = "/init.scope";
    const group = { path: controlGroup, parent: "", ownerUnit: "init.scope", dev: "1", ino: "90", members: [{ birth: "1:10", controlGroup }] };
    expect(() => parseHostedInventoryV5({ ...original, cgroups: [...original.cgroups, group] })).toThrow();
    const scope = { ...original.units[1]!, name: "init.scope", controlGroup, activeState: "active", mainPidBirth: null,
      fragmentPath: null, fragmentSha256: null, dropIns: [], unitFileState: "", invocationId: "" };
    const graph = { ...group, members: [...group.members, { birth: "102:202", controlGroup }] };
    const parsed = parseHostedInventoryV5({ ...original, units: [...original.units, scope], cgroups: [...original.cgroups, graph] });
    expect(parsed.cgroups.at(-1)!.members.map(member => member.birth)).toEqual(["1:10", "102:202"]);
    expect(parsed.units.at(-1)!.fragmentSha256).toBeNull();
    expect(() => parseHostedInventoryV5({ ...original, units: original.units.map((u, i) => i === 1 ? {
      ...u, fragmentPath: null, fragmentSha256: null,
    } : u) })).toThrow();
  });
  it("bounds new rows/drop-ins/bytes while old small record decoding retains its shape", () => {
    expect(() => parseHostedInventoryV5(fixture(1025))).toThrow();
    const original = fixture();
    expect(() => parseHostedInventoryV5({ ...original, units: original.units.map((u, i) => i === 1 ? { ...u, dropIns: Array.from({ length: 17 }, (_, n) => ({ path: `/fixture/${n}.conf`, sha256: "a".repeat(64) })) } : u) })).toThrow();
    expect(() => decodeHostedInventoryBytes(new Uint8Array(4 * 1024 * 1024 + 1))).toThrow();
    expect(decodeHostedInventoryBytes(bytes({ schemaVersion: 4, fixture: true }))).toEqual({ schemaVersion: 4, fixture: true });
    expect(() => parseHostedInventoryV5({ ...original, ignoredAuthority: true })).toThrow();
  });
  it("keeps V5 strictly closed: memory topology is never an inventory field (it belongs to the retention operation record)", () => {
    const topology = { schemaVersion: 1, mountPoint: "/sys/fs/cgroup", cgroupNamespace: { dev: "4", ino: "4026531835" }, hierarchyRoot: { dev: "1", ino: "1" } };
    expect(() => parseHostedInventoryV5({ ...fixture(2), memoryTopology: topology })).toThrow("hosted_inventory_invalid");
    expect(() => decodeHostedInventoryBytes(bytes({ ...fixture(2), memoryTopology: topology }))).toThrow("hosted_inventory_invalid");
    expect(parseHostedInventoryV5(fixture(2)).schemaVersion).toBe(5);
  });
});
