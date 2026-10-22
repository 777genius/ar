import { describe, expect, it } from "vitest";
import {
  HostedRetentionLaunchKind, hostedRetentionRecordName, hostedRetentionTool,
  parseHostedRetentionContainerRecord, parseHostedRetentionFunded, parseHostedRetentionPacket, parseHostedRetentionRequest,
} from "../host-infrastructure/host-retention-operation";
import { parseHostedInventoryV5 } from "../host-infrastructure/host-inventory";

// The retention packet is a DISTINCT closed shape: schemaVersion 3, role retention_operator, its own record directory
// and unit prefix. These cases bind that boundary from both sides: a hosted-creator packet is not a retention packet,
// and no altered discriminator, window, launch or invocation parses.
const ID = "11111111-2222-3333-4444-555555555555";
const digest = (c: string) => c.repeat(64);
const packet = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 3, role: "retention_operator", operationId: ID, hostId: "d".repeat(32), bootId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  issuedEpochMs: 1000, workEndEpochMs: 2000, cleanupEndEpochMs: 3000, issuedMonotonicNs: "123456789",
  node: { path: "/opt/node", sha256: digest("a") }, bootstrap: { path: "/opt/rt/dist/worker-codex/retention-operation-bootstrap.js", sha256: digest("b") },
  runtimeDirectory: "/opt/rt", runtimeSha: "1".repeat(40), runtimeManifestSha256: digest("2"), installationSha256: digest("3"), inventorySha256: digest("4"),
  launch: { kind: "installation_supervisor" },
  retention: { tool: hostedRetentionTool, controllerJobId: "TEST-controller", workerJobId: "TEST-worker", permitFile: "/var/lib/x/permit.json",
    expectedPermitSha256: digest("5"), confirmRetention: false },
  ...over,
});

describe("retention operator role: closed wire contract", () => {
  it("parses the exact schemaVersion-3 retention shape and freezes it", () => {
    const parsed = parseHostedRetentionPacket(packet());
    expect(parsed).toMatchObject({ schemaVersion: 3, role: "retention_operator", launch: { kind: HostedRetentionLaunchKind.InstallationSupervisor } });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(parseHostedRetentionPacket(packet({ retention: { ...packet().retention, expectedPlanSha256: digest("6"), registryRootDir: "/var/lib/reg" } })).retention.registryRootDir).toBe("/var/lib/reg");
  });

  it.each([
    ["a hosted installation packet (schema 1) in the retention role", { schemaVersion: 1 }],
    ["a hosted funded installation packet (schema 2) in the retention role", { schemaVersion: 2 }],
    ["an altered role discriminator", { role: "hosted_creator" }],
    ["a creator row smuggled into the retention packet", { creator: { creatorId: "x" } }],
    ["a job origin smuggled into the retention packet", { jobId: "TEST-worker" }],
    ["a work window that ends before it starts", { workEndEpochMs: 500 }],
    ["a cleanup window that ends before the work window", { cleanupEndEpochMs: 1500 }],
    ["an unnamed tool", { retention: { ...packet().retention, tool: "codex_goal_project_start" } }],
    ["an extra invocation field", { retention: { ...packet().retention, replay: true } }],
    ["an unknown launch kind", { launch: { kind: "host_shell" } }],
    ["the removed external systemd-unit launch kind", { launch: { kind: "systemd_unit" } }],
    ["a docker launch without an image pin", { launch: { kind: "docker_test", image: "latest", fixtureRoot: "/srv/TEST-x", mounts: [] } }],
    ["a malformed installation pin", { installationSha256: "nothex" }],
  ])("refuses %s", (_name, over) => {
    expect(() => parseHostedRetentionPacket(packet(over))).toThrow("hosted_retention_operation_invalid");
  });

  it("is not a hosted creator inventory: the V5 parser still refuses a retention-shaped record", () => {
    expect(() => parseHostedInventoryV5(packet())).toThrow("hosted_inventory_invalid");
  });

  it("parses the funded record and refuses an altered one", () => {
    const funded = { schemaVersion: 3, role: "retention_operator", operationId: ID, packetSha256: digest("7"),
      session: { hostId: "d".repeat(32), bootId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", supervisorId: "100:200" },
      memoryTopology: { mountPoint: "/sys/fs/cgroup", cgroupNamespace: { dev: "4", ino: "4026531835" }, hierarchyRoot: { dev: "30", ino: "1" } } };
    expect(parseHostedRetentionFunded(funded).memoryTopology.hierarchyRoot).toEqual({ dev: "30", ino: "1" });
    expect(parseHostedRetentionFunded(funded).session.supervisorId).toBe("100:200");
    const { session: _session, ...withoutSession } = funded;
    for (const altered of [{ ...funded, memoryTopology: { ...funded.memoryTopology, mountPoint: "/sys/fs/cgroup/memory" } },
      { ...funded, memoryTopology: { ...funded.memoryTopology, availableBytes: 1 } }, { ...funded, role: "other" }, { ...funded, schemaVersion: 5 },
      withoutSession, { ...funded, session: { ...funded.session, supervisorId: "not-a-birth" } }, { ...funded, session: { ...funded.session, extra: 1 } }]) {
      expect(() => parseHostedRetentionFunded(altered)).toThrow("hosted_retention_operation_invalid");
    }
  });

  it("the retention request carried by the funded installation packet is closed: it DESCRIBES, it never supplies window or authority", () => {
    const request = { launch: { kind: "installation_supervisor" }, retention: packet().retention };
    expect(parseHostedRetentionRequest(request).launch.kind).toBe(HostedRetentionLaunchKind.InstallationSupervisor);
    // No caller window, host, boot, operation id, hash or pin can ride in the request: those are observed live by the supervisor.
    for (const over of [{ windowMs: 600_000 }, { cleanupMs: 60_000 }, { hostId: "d".repeat(32) }, { bootId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
      { operationId: ID }, { installationSha256: digest("3") }, { creator: { creatorId: "x" } }, { launch: { kind: "systemd_unit" } }, { launch: { kind: "host_shell" } },
      { retention: { ...packet().retention, tool: "codex_goal_project_start" } }]) {
      expect(() => parseHostedRetentionRequest({ ...request, ...over })).toThrow("hosted_retention_operation_invalid");
    }
    const { retention: _retention, ...withoutRetention } = request;
    expect(() => parseHostedRetentionRequest(withoutRetention)).toThrow("hosted_retention_operation_invalid");
  });

  it("parses the operator's container record and keeps record names disjoint from the hosted ones", () => {
    const record = { schemaVersion: 3, operationId: ID, containerId: "c".repeat(64), image: `sha256:${digest("e")}`, cgroup: "/system.slice/docker-x.scope",
      startTicks: "99", hostPid: 4242, mounts: [{ source: "/sys/fs/cgroup", target: "/sys/fs/cgroup", readonly: true }] };
    expect(parseHostedRetentionContainerRecord(record).hostPid).toBe(4242);
    expect(() => parseHostedRetentionContainerRecord({ ...record, hostPid: 0 })).toThrow("hosted_retention_operation_invalid");
    expect(hostedRetentionRecordName(ID, "packet")).toBe(`${ID}.json`);
    expect(hostedRetentionRecordName(ID, "funded")).toBe(`${ID}.funded.json`);
    expect(hostedRetentionRecordName(ID, "closed")).toBe(`${ID}/closed.json`);
    expect(() => hostedRetentionRecordName("../x", "packet")).toThrow("hosted_retention_operation_invalid");
  });
});
