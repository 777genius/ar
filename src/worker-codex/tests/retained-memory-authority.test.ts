import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HostedActivationPhase, type HostedActivation, type HostedInstallation } from "@vioxen/subscription-runtime/worker-core";
import { parseHostedRetentionPacket, hostedRetentionTool, type HostedRetentionFunded } from "../../core/host-infrastructure/host-retention-operation";
import type { HostMemoryReference } from "../../worker-local/linux-memory-availability";
import {
  assertRetentionFundedSession, assertRetentionLiveFacts, assertRetentionOperationFacts, assertRetentionOperatorAdmission, retentionBudgetMs,
  retentionMemoryReference, retentionToolArgs, type RetentionOperationFacts,
} from "../retained-memory-authority";

// Pure authentication of the retention operator role. The IO wrappers (retention-operation-host.ts) only feed these
// functions from the existing authenticated readers and are Linux/root/systemd-only, so they are not exercised here.
// Each case is a binding test: remove the matching check and the forged or stale facts would pass instead of refusing.
const HOST = "d".repeat(32), BOOT = "11111111-1111-1111-1111-111111111111", RUNTIME = "/opt/TEST-runtime";
const OP = "22222222-2222-2222-2222-222222222222";
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const installationBytes = Buffer.from('{"installation":"TEST"}\n'), inventoryBytes = Buffer.from('{"inventory":"TEST"}\n');
const topology = { mountPoint: "/sys/fs/cgroup" as const, cgroupNamespace: { dev: "4", ino: "4026531835" }, hierarchyRoot: { dev: "30", ino: "1" } };

const packetValue = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 3, role: "retention_operator", operationId: OP, hostId: HOST, bootId: BOOT, issuedEpochMs: 1_000_000, workEndEpochMs: 1_600_000,
  cleanupEndEpochMs: 1_700_000, issuedMonotonicNs: "5000000000", node: { path: "/opt/node", sha256: "a".repeat(64) },
  bootstrap: { path: `${RUNTIME}/dist/worker-codex/retention-operation-bootstrap.js`, sha256: "b".repeat(64) }, runtimeDirectory: RUNTIME,
  runtimeSha: "1".repeat(40), runtimeManifestSha256: "2".repeat(64), installationSha256: sha(installationBytes), inventorySha256: sha(inventoryBytes),
  launch: { kind: "installation_supervisor" },
  retention: { tool: hostedRetentionTool, controllerJobId: "TEST-controller", workerJobId: "TEST-worker", permitFile: "/var/lib/TEST/permit.json",
    expectedPermitSha256: "5".repeat(64), confirmRetention: true, expectedPlanSha256: "6".repeat(64), registryRootDir: "/var/lib/TEST/registry" },
  ...over,
});
const packet = (over: Record<string, unknown> = {}) => parseHostedRetentionPacket(packetValue(over));

function facts(over: Partial<RetentionOperationFacts> = {}): RetentionOperationFacts {
  const installation: HostedInstallation = { schemaVersion: 1, installationId: "TEST-installation", hostId: HOST, runtimeDirectory: RUNTIME,
    runtimeSha: "1".repeat(40), runtimeManifestSha256: "2".repeat(64), inventorySha256: sha(inventoryBytes) };
  const activation: HostedActivation = { schemaVersion: 1, installationId: "TEST-installation", hostId: HOST, bootId: BOOT, supervisorId: "100:200", generation: 1,
    phase: HostedActivationPhase.Closed, ordinaryOriginsSha256: "3".repeat(64), exclusiveEnrollmentSha256: null, ordinaryStarts: [] };
  return { packet: packet(), installation, activation, installationBytes, inventoryBytes, liveBootId: BOOT, liveMachineId: HOST, runtimeDirectory: RUNTIME,
    nowEpochMs: 1_100_000, nowMonotonicNs: 5_000_000_000n + 100_000n * 1_000_000n, ...over };
}

describe("retention operator role: installed-operation authentication", () => {
  it("accepts the admitted installation, runtime, boot, machine and an open window", () => {
    expect(() => assertRetentionOperationFacts(facts())).not.toThrow();
  });

  it.each([
    ["a re-created installation (different bytes than the packet pins)", () => facts({ installationBytes: Buffer.from("{}") }), "installation_substituted"],
    ["a substituted inventory", () => facts({ inventoryBytes: Buffer.from("{}") }), "inventory_substituted"],
    ["an installation that pins another inventory", () => { const f = facts(); return { ...f, installation: { ...f.installation, inventorySha256: "9".repeat(64) } }; }, "inventory_substituted"],
    ["another machine on the packet", () => facts({ packet: packet({ hostId: "e".repeat(32) }) }), "machine_mismatch"],
    ["another live machine", () => facts({ liveMachineId: "e".repeat(32) }), "machine_mismatch"],
    ["another runtime on the packet", () => facts({ packet: packet({ runtimeDirectory: "/opt/other" }) }), "runtime_mismatch"],
    ["another live runtime", () => facts({ runtimeDirectory: "/opt/other" }), "runtime_mismatch"],
    ["another runtime artifact pin", () => facts({ packet: packet({ runtimeSha: "9".repeat(40) }) }), "runtime_mismatch"],
    ["an activation of another installation", () => { const f = facts(); return { ...f, activation: { ...f.activation, installationId: "TEST-other" } }; }, "activation_installation_mismatch"],
    ["an installation not re-sessioned in this boot (reboot without the normal reactivation)", () => { const f = facts(); return { ...f, activation: { ...f.activation, bootId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" } }; }, "boot_mismatch"],
    ["another live boot", () => facts({ liveBootId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }), "boot_mismatch"],
    ["a window that already ended", () => facts({ nowEpochMs: 1_600_000 }), "window_ended"],
    ["a clock before the packet was issued", () => facts({ nowEpochMs: 999_000 }), "clock_or_window_invalid"],
    ["a monotonic clock that contradicts the wall clock", () => facts({ nowMonotonicNs: 5_000_000_000n + 590_000n * 1_000_000n }), "clock_or_window_invalid"],
  ])("holds %s", (_name, build, reason) => {
    expect(() => assertRetentionOperationFacts(build())).toThrow(`hosted_retention_operation_held:${reason}`);
  });

  it("applies the live-facts subset the TEST container can check (no installation files inside)", () => {
    const { packet: p, liveBootId, liveMachineId, runtimeDirectory, nowEpochMs, nowMonotonicNs } = facts();
    expect(() => assertRetentionLiveFacts({ packet: p, liveBootId, liveMachineId, runtimeDirectory, nowEpochMs, nowMonotonicNs })).not.toThrow();
    expect(() => assertRetentionLiveFacts({ packet: p, liveBootId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", liveMachineId, runtimeDirectory, nowEpochMs, nowMonotonicNs }))
      .toThrow("hosted_retention_operation_held:boot_mismatch");
  });

  it("budgets the finite window from the tighter of the wall and monotonic clocks", () => {
    const p = packet();
    expect(retentionBudgetMs(p, false, 1_100_000, 5_000_000_000n + 100_000n * 1_000_000n)).toBe(500_000);
    expect(retentionBudgetMs(p, true, 1_100_000, 5_000_000_000n + 100_000n * 1_000_000n)).toBe(600_000);
    expect(() => retentionBudgetMs(p, false, 1_700_000, 5_000_000_000n + 700_000n * 1_000_000n)).toThrow("window_ended");
  });
});

describe("retention operator role: admission by the existing kernel operator session", () => {
  // `session` is exactly the value HostedReadonlyHostKernel.operatorSession() returns. These cases bind how it is compared with
  // the stored activation and the packet; the kernel's own caller-cgroup/birth/live-supervisor checks are existing code, and the
  // ordering "admit before any publication" is bound in retention-operation-host.admission.test.ts.
  const session = { hostId: HOST, bootId: BOOT, supervisorId: "100:200" };
  const { packet: p, activation } = facts();
  it("admits the session the stored activation belongs to, for the packet's boot and machine", () => {
    expect(() => assertRetentionOperatorAdmission({ packet: p, activation, session })).not.toThrow();
  });
  it.each([
    ["a stale activation of another supervisor session", { ...session, supervisorId: "300:400" }, "operator_session_activation_mismatch"],
    ["a replaced supervisor birth", { ...session, supervisorId: "100:201" }, "operator_session_activation_mismatch"],
    ["an activation of another boot", { ...session, bootId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }, "operator_session_activation_mismatch"],
    ["an activation of another machine", { ...session, hostId: "e".repeat(32) }, "operator_session_activation_mismatch"],
  ])("holds %s", (_name, other, reason) => {
    expect(() => assertRetentionOperatorAdmission({ packet: p, activation, session: other })).toThrow(`hosted_retention_operation_held:${reason}`);
  });
  it("holds a session whose boot or machine is not the one the packet names, even when the activation matches it", () => {
    const otherBoot = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    expect(() => assertRetentionOperatorAdmission({ packet: p, activation: { ...activation, bootId: otherBoot }, session: { ...session, bootId: otherBoot } }))
      .toThrow("hosted_retention_operation_held:operator_session_packet_mismatch");
  });
  it("lets the supervised child continue only for the exact session recorded at funding", () => {
    expect(() => assertRetentionFundedSession({ session }, activation)).not.toThrow();
    for (const stale of [{ ...session, supervisorId: "300:400" }, { ...session, bootId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }, { ...session, hostId: "e".repeat(32) }]) {
      expect(() => assertRetentionFundedSession({ session: stale }, activation)).toThrow("hosted_retention_operation_held:funded_session_stale");
    }
  });
});

describe("retention operator role: funded memory reference", () => {
  const packetBytes = Buffer.from(JSON.stringify(packetValue()));
  const funded = (over: Partial<HostedRetentionFunded> = {}): HostedRetentionFunded =>
    ({ schemaVersion: 3, role: "retention_operator", operationId: OP, packetSha256: sha(packetBytes),
      session: { hostId: HOST, bootId: BOOT, supervisorId: "100:200" }, memoryTopology: topology, ...over });
  const live = (over: Partial<HostMemoryReference> = {}): HostMemoryReference => ({ bootId: BOOT, machineId: HOST, topology, ...over });
  const build = (f: HostedRetentionFunded, l: HostMemoryReference) => retentionMemoryReference({ packet: packet(), packetBytes, funded: f, live: l });

  it("returns the funded identities only when the live observation is identical", () => {
    expect(build(funded(), live())).toEqual({ bootId: BOOT, machineId: HOST, topology });
  });

  it.each([
    ["a funded record for another operation", () => build(funded({ operationId: "33333333-3333-3333-3333-333333333333" }), live()), "host_reference_not_funded"],
    ["a funded record pinning a substituted packet (digest)", () => build(funded({ packetSha256: "9".repeat(64) }), live()), "host_reference_not_funded"],
    ["another live boot", () => build(funded(), live({ bootId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" })), "host_reference_stale_boot"],
    ["another live machine", () => build(funded(), live({ machineId: "e".repeat(32) })), "host_reference_machine_mismatch"],
    ["a private namespace handle (self-observed topology differs from the funded one)",
      () => build(funded(), live({ topology: { ...topology, cgroupNamespace: { dev: "4", ino: "4026532999" } } })), "host_reference_hierarchy_mismatch"],
    ["a replaced hierarchy root", () => build(funded(), live({ topology: { ...topology, hierarchyRoot: { dev: "30", ino: "7" } } })), "host_reference_hierarchy_mismatch"],
    ["a forged funded topology the live host does not have",
      () => build(funded({ memoryTopology: { ...topology, hierarchyRoot: { dev: "31", ino: "1" } } }), live()), "host_reference_hierarchy_mismatch"],
  ])("refuses %s", (_name, run, reason) => {
    expect(run).toThrow(`linux_memory_unknown:${reason}`);
  });
});

describe("retention operator role: the single closed invocation", () => {
  it("maps only the named tool arguments to the real retention MCP entry and carries no job, origin or creator", () => {
    const args = retentionToolArgs(packet());
    expect(args).toEqual({ controllerJobId: "TEST-controller", workerJobId: "TEST-worker", permitFile: "/var/lib/TEST/permit.json",
      expectedPermitSha256: "5".repeat(64), confirmRetention: true, expectedPlanSha256: "6".repeat(64), registryRootDir: "/var/lib/TEST/registry" });
    expect(Object.keys(args)).not.toEqual(expect.arrayContaining(["creator", "origin", "launch", "env"]));
  });
  it("omits optional values that the packet did not name", () => {
    const bare = packetValue({ retention: { tool: hostedRetentionTool, controllerJobId: "TEST-controller", workerJobId: "TEST-worker",
      permitFile: "/var/lib/TEST/permit.json", expectedPermitSha256: "5".repeat(64), confirmRetention: false } });
    expect(Object.keys(retentionToolArgs(parseHostedRetentionPacket(bare))).sort()).toEqual(["confirmRetention", "controllerJobId", "expectedPermitSha256", "permitFile", "workerJobId"]);
  });
});
