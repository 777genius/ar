import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HostedActivationPhase } from "@vioxen/subscription-runtime/worker-core";
import { HostedRetentionLaunchKind, hostedRetentionTool, parseHostedRetentionPacket, type HostedRetentionRequest } from "../../core/host-infrastructure/host-retention-operation";
import {
  cleanupOwnedRetentionContainer, closeRetentionOperation, deriveOriginalUnitExpectation, originalUnitPending, proveOriginalUnitTerminal, runAdmittedRetentionOperation,
  type OriginalCgroupNode, type OriginalLeafObservation, type OriginalRetiredAuthority, type OriginalUnitFacts, type OriginalUnitIdentity, type OriginalUnitSample, type RetentionCloseIo, type RetentionInstallationWindow,
} from "../retention-operation-host";

// ORDERING + BINDING test of the retention role INSIDE the admitted installation supervisor. The existing kernel
// (`HostedReadonlyHostKernel.operatorSession`), the installation readers, the record store, the topology collector, the
// memory reader and the retention MCP entry are replaced by recording doubles ONLY to observe the order of effects; the
// doubles are not authority and create none (the real kernel check is existing code and needs a Linux installed host: caller
// cgroup + `collectProcessBirth(process.pid) === inventory.supervisor.birth`). The double for `operatorSession` is the
// "admitted supervisor" ONLY inside this file; a throwing double is the unadmitted external V5 caller, whose refusal is the
// real kernel's. What this binds is that the role calls the kernel admission FIRST and that a refusal leaves no packet,
// funded record, directory, topology collection or workload. `node:child_process.spawn` is blocked so nothing can start.
const HOST = "d".repeat(32), BOOT = "11111111-1111-1111-1111-111111111111", OP = "66666666-6666-6666-6666-666666666666";
const RUNTIME = fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/, "");
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const mocks = vi.hoisted(() => ({
  operatorSession: vi.fn(), createRecord: vi.fn(), ensureDirectories: vi.fn(), readRecord: vi.fn(), collectTopology: vi.fn(),
  installationActivation: vi.fn(), assertInspected: vi.fn(), activationBytes: vi.fn(), structuralOperator: vi.fn(), spawn: vi.fn(),
  observeTopology: vi.fn(), readMemory: vi.fn(), retentionTool: vi.fn(),
}));
vi.mock("../hosted-readonly-host-kernel", () => ({
  HostedReadonlyHostKernel: class { operatorSession() { return mocks.operatorSession(); } },
  readTrustedFragment: () => Buffer.from("pinned"),
}));
vi.mock("../hosted-installation-activation", () => ({ readHostedInstallationActivation: mocks.installationActivation, assertInspectedInstallation: mocks.assertInspected }));
vi.mock("../hosted-readonly-linux-collector", async importOriginal => ({ ...(await importOriginal<object>()),
  collectBootId: () => "11111111-1111-1111-1111-111111111111", collectProcessBirth: () => "100:200" }));
vi.mock("@vioxen/subscription-runtime/provider-codex", async importOriginal => ({ ...(await importOriginal<object>()),
  assertHostedActivationOperator: mocks.structuralOperator, readHostedActivationBytes: mocks.activationBytes }));
vi.mock("../retention-operation-records", async importOriginal => ({ ...(await importOriginal<object>()),
  createRetentionRecord: mocks.createRecord, ensureRetentionOperationDirectories: mocks.ensureDirectories, readRetentionRecord: mocks.readRecord }));
vi.mock("../retained-memory-topology-issuance", () => ({ collectHostedMemoryTopology: mocks.collectTopology }));
vi.mock("../../worker-local/linux-memory-availability", () => ({ observeHostMemoryTopology: mocks.observeTopology, readLinuxMemoryAvailability: mocks.readMemory }));
vi.mock("../codex-goal-mcp-project-control-retained-nonqualified", () => ({
  projectControlRetainNonqualifiedAttempt: mocks.retentionTool, readRetainedNonqualifiedPermit: vi.fn() }));
vi.mock("node:child_process", async importOriginal => ({ ...(await importOriginal<object>()), spawn: mocks.spawn }));
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual,
    readFileSync: ((path: unknown, ...rest: unknown[]) => path === "/etc/machine-id" ? `${"d".repeat(32)}\n` : (actual.readFileSync as (...a: unknown[]) => unknown)(path, ...rest)) as typeof actual.readFileSync,
    readdirSync: ((path: unknown, ...rest: unknown[]) => String(path).endsWith("/retention-operations") ? [] : (actual.readdirSync as (...a: unknown[]) => unknown)(path, ...rest)) as typeof actual.readdirSync };
});

const installationBytes = Buffer.from('{"installation":"TEST"}\n'), inventoryBytes = Buffer.from('{"inventory":"TEST"}\n');
const installation = { schemaVersion: 1, installationId: "TEST-installation", hostId: HOST, runtimeDirectory: RUNTIME, runtimeSha: "1".repeat(40),
  runtimeManifestSha256: "2".repeat(64), inventorySha256: sha(inventoryBytes) };
const activation = { schemaVersion: 1, installationId: "TEST-installation", hostId: HOST, bootId: BOOT, supervisorId: "100:200", generation: 1,
  phase: HostedActivationPhase.Closed, ordinaryOriginsSha256: "3".repeat(64), exclusiveEnrollmentSha256: null, ordinaryStarts: [] };
const admittedSession = { hostId: HOST, bootId: BOOT, supervisorId: "100:200" };
const request: HostedRetentionRequest = { launch: { kind: HostedRetentionLaunchKind.InstallationSupervisor },
  retention: { tool: hostedRetentionTool, controllerJobId: "TEST-controller", workerJobId: "TEST-worker", permitFile: "/var/lib/TEST/permit.json",
    expectedPermitSha256: "5".repeat(64), confirmRetention: false } };
const topology = { mountPoint: "/sys/fs/cgroup", cgroupNamespace: { dev: "4", ino: "4026531835" }, hierarchyRoot: { dev: "30", ino: "1" } };
const windowOf = (over: Partial<RetentionInstallationWindow> = {}): RetentionInstallationWindow => {
  const now = Date.now();
  return { operationId: OP, hostId: HOST, bootId: BOOT, issuedEpochMs: now, workEndEpochMs: now + 600_000, cleanupEndEpochMs: now + 660_000,
    issuedMonotonicNs: process.hrtime.bigint().toString(), node: { path: process.execPath, sha256: sha(Buffer.from("pinned")) },
    bootstrap: { path: `${RUNTIME}/dist/worker-codex/hosted-ordinary-installation-bootstrap.js`, sha256: "7".repeat(64) },
    runtimeDirectory: RUNTIME, runtimeSha: "1".repeat(40), runtimeManifestSha256: "2".repeat(64), ...over };
};

const stored = new Map<string, Buffer>();
beforeEach(() => {
  vi.clearAllMocks();
  stored.clear();
  mocks.installationActivation.mockReturnValue({ installation, activation });
  mocks.activationBytes.mockImplementation((name: string) => name === "host-installation.json" ? installationBytes : inventoryBytes);
  mocks.collectTopology.mockReturnValue(topology);
  mocks.observeTopology.mockReturnValue({ bootId: BOOT, machineId: HOST, topology });
  mocks.spawn.mockImplementation(() => { throw new Error("TEST_spawn_blocked"); });
  mocks.operatorSession.mockReturnValue(admittedSession);
  mocks.createRecord.mockImplementation((id: string, record: string, value: unknown) => {
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`); stored.set(`${id}/${record}`, bytes); return bytes;
  });
  mocks.readRecord.mockImplementation((id: string, record: string) => stored.get(`${id}/${record}`) ?? null);
  mocks.retentionTool.mockResolvedValue({ content: [{ type: "text", text: "retained" }], structuredContent: { ok: true } });
});
const nothingPublished = () => {
  expect(mocks.createRecord).not.toHaveBeenCalled();
  expect(mocks.ensureDirectories).not.toHaveBeenCalled();
  expect(mocks.collectTopology).not.toHaveBeenCalled();
  expect(mocks.retentionTool).not.toHaveBeenCalled();
  expect(mocks.spawn).not.toHaveBeenCalled();
};
const recordNames = () => mocks.createRecord.mock.calls.map(call => call[1] as string);

describe("retention role inside the admitted installation supervisor: kernel admission precedes every effect", () => {
  it("an unadmitted external V5 caller (the kernel refuses) is refused before anything is read, published, funded or run", async () => {
    mocks.operatorSession.mockImplementation(() => { throw new Error("hosted_custody_kernel_evidence_invalid"); });
    await expect(runAdmittedRetentionOperation(windowOf(), request)).rejects.toThrow("hosted_custody_kernel_evidence_invalid");
    expect(mocks.structuralOperator).toHaveBeenCalled(); // the structural check ran and was not enough
    expect(mocks.installationActivation).not.toHaveBeenCalled();
    nothingPublished();
  });

  it("a stale activation (another supervisor session than the admitted one) refuses before the packet or its directory exists", async () => {
    mocks.installationActivation.mockReturnValue({ installation, activation: { ...activation, supervisorId: "300:400" } });
    await expect(runAdmittedRetentionOperation(windowOf(), request)).rejects.toThrow("hosted_retention_operation_held:operator_session_activation_mismatch");
    nothingPublished();
  });

  it("a lookalike installation (inventory of another digest) refuses before publication", async () => {
    mocks.installationActivation.mockReturnValue({ installation: { ...installation, inventorySha256: "9".repeat(64) }, activation });
    await expect(runAdmittedRetentionOperation(windowOf(), request)).rejects.toThrow("hosted_retention_operation_held:inventory_substituted");
    nothingPublished();
  });

  it.each([
    ["another boot", { bootId: "22222222-2222-2222-2222-222222222222" }, "operator_session_packet_mismatch"],
    ["another machine", { hostId: "e".repeat(32) }, "operator_session_packet_mismatch"],
    ["another runtime directory", { runtimeDirectory: "/opt/other-runtime" }, "runtime_mismatch"],
    ["another runtime sha", { runtimeSha: "8".repeat(40) }, "runtime_mismatch"],
    ["an ended work window", { issuedEpochMs: Date.now() - 700_000, workEndEpochMs: Date.now() - 100_000, cleanupEndEpochMs: Date.now() + 60_000 }, "window_ended"],
  ] as const)("a window bound to %s refuses before any publication", async (_name, over, reason) => {
    await expect(runAdmittedRetentionOperation(windowOf(over), request)).rejects.toThrow(`hosted_retention_operation_held:${reason}`);
    nothingPublished();
  });

  it("a node pin that is not the executing process refuses before publication", async () => {
    await expect(runAdmittedRetentionOperation(windowOf({ node: { path: "/opt/other/node", sha256: sha(Buffer.from("pinned")) } }), request))
      .rejects.toThrow("hosted_retention_operation_held:node_path_mismatch");
    nothingPublished();
  });

  it("the admitted role reaches the real retention entry: packet and funded records first (recording the admitted session), the memory port only after", async () => {
    await expect(runAdmittedRetentionOperation(windowOf(), request)).resolves.toEqual({ ok: true });
    expect(recordNames()).toEqual(["packet", "funded", "supervisor", "result", "closed"]);
    expect(mocks.createRecord.mock.calls[1]![2]).toMatchObject({ operationId: OP, session: admittedSession, memoryTopology: topology });
    const order = (fn: { mock: { invocationCallOrder: number[] } }) => fn.mock.invocationCallOrder[0]!;
    expect(order(mocks.operatorSession)).toBeLessThan(order(mocks.collectTopology));
    expect(order(mocks.collectTopology)).toBeLessThan(order(mocks.createRecord));
    expect(order(mocks.createRecord)).toBeLessThan(order(mocks.retentionTool));
    expect(mocks.operatorSession.mock.calls.length).toBeGreaterThanOrEqual(2); // re-admitted immediately before the first effect
    // The very invocation named by the request, with a port (a function), and nothing else.
    expect(mocks.retentionTool).toHaveBeenCalledTimes(1);
    expect(mocks.retentionTool.mock.calls[0]![0]).toMatchObject({ controllerJobId: "TEST-controller", workerJobId: "TEST-worker", permitFile: "/var/lib/TEST/permit.json" });
    expect(typeof mocks.retentionTool.mock.calls[0]![1]).toBe("function");
    expect(mocks.spawn).not.toHaveBeenCalled(); // no unit, no container, no job
  });

  it("creates no historical-job origin, creator or enrollment: the records carry the retention role only", async () => {
    await runAdmittedRetentionOperation(windowOf(), request);
    const packet = mocks.createRecord.mock.calls[0]![2] as Record<string, unknown>;
    expect(packet).toMatchObject({ schemaVersion: 3, role: "retention_operator", operationId: OP, hostId: HOST, bootId: BOOT, runtimeDirectory: RUNTIME });
    expect(Object.keys(packet)).not.toEqual(expect.arrayContaining(["creator", "origin", "jobId"]));
    // This composition reads the installation/activation (read-only) and holds no store: it has no enroll/resume/launch call
    // to make, and the only workload it can reach is the one closed retention tool (asserted above and in the core parser tests).
    expect(recordNames()).not.toContain("origin");
  });

  it("a retention that does not succeed is retained as a closed NOT-ok operation (never as success), and a thrown tool is retained the same way", async () => {
    mocks.retentionTool.mockResolvedValueOnce({ content: [{ type: "text", text: "refused" }], structuredContent: { ok: false } });
    await expect(runAdmittedRetentionOperation(windowOf(), request)).resolves.toEqual({ ok: false });
    expect(JSON.parse(stored.get(`${OP}/closed`)!.toString())).toMatchObject({ exitCode: 1, ok: false });
    stored.clear(); vi.clearAllMocks();
    mocks.retentionTool.mockRejectedValueOnce(new Error("linux_memory_unknown:host_reference_hierarchy_mismatch"));
    await expect(runAdmittedRetentionOperation(windowOf(), request)).resolves.toEqual({ ok: false });
    expect(JSON.parse(stored.get(`${OP}/result`)!.toString())).toMatchObject({ ok: false, output: "linux_memory_unknown:host_reference_hierarchy_mismatch" });
  });

  it("a stale topology at run time (the live hierarchy differs from the funded one) never reaches the retention entry and stays HELD", async () => {
    mocks.observeTopology.mockReturnValue({ bootId: BOOT, machineId: HOST, topology: { ...topology, hierarchyRoot: { dev: "30", ino: "2" } } });
    await expect(runAdmittedRetentionOperation(windowOf(), request)).rejects.toThrow("linux_memory_unknown:host_reference_hierarchy_mismatch");
    expect(mocks.retentionTool).not.toHaveBeenCalled();
    expect(recordNames()).toEqual(["packet", "funded", "held"]);
  });

  it("a session that changed between funding and the first effect is HELD, not run", async () => {
    mocks.operatorSession.mockReturnValueOnce(admittedSession).mockReturnValueOnce({ ...admittedSession, supervisorId: "100:201" });
    await expect(runAdmittedRetentionOperation(windowOf(), request)).rejects.toThrow("hosted_retention_operation_held:operator_session_changed");
    expect(mocks.retentionTool).not.toHaveBeenCalled();
    expect(recordNames()).toEqual(["packet", "funded", "held"]);
  });

  it("a partial publication (the supervisor record cannot be created) is HELD and the retention entry is never run", async () => {
    mocks.createRecord.mockImplementation((id: string, record: string, value: unknown) => {
      if (record === "supervisor") throw new Error("TEST_record_publication_failed");
      const bytes = Buffer.from(`${JSON.stringify(value)}\n`); stored.set(`${id}/${record}`, bytes); return bytes;
    });
    await expect(runAdmittedRetentionOperation(windowOf(), request)).rejects.toThrow("TEST_record_publication_failed");
    expect(mocks.retentionTool).not.toHaveBeenCalled();
    expect(recordNames()).toEqual(["packet", "funded", "supervisor", "held"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// a10 F1 (outside cleanup needs terminal custody of the ORIGINAL unit) and F7 (the work deadline is sampled after every IO of the
// closing step). BINDING tests: each one fails when its guard is removed (mutation: delete the named line, assert the edit
// applied, observe the failure, restore). The Docker side of F1 (no ownership read / Docker call before the proof) is bound in
// `retention-operation-test-launcher.test.ts`; the real systemctl/cgroup observer (`observeOriginalUnit`) needs the Linux
// installed geometry and is NOT exercised here: the fakes below prove the DECISION, not the observation.
const GROUP = `/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/subscription-runtime-installation-${OP}.service`;
const INVOCATION = "a".repeat(32);
// Facts are a BRACKET: a unit sample, the leaf observation (with the held parent ancestry), the same unit sample again. `facts(over)`
// applies a unit override to BOTH samples (a stable observation); drift tests change only the second one.
const sampleOf = (over: Partial<OriginalUnitSample> = {}): OriginalUnitSample =>
  ({ bootId: BOOT, loadState: "loaded", activeState: "inactive", mainPid: "0", jobPresent: false, controlGroup: GROUP, invocationId: INVOCATION, ...over });
// The retained LIVE ancestry (the issuer's `original-leaf-chain.json`): the three slices below the cgroup2 root, as in Root's
// runtime-systemd-loadstate-a2-actual.json (all `dev` 29, root-owned). The numbers are TEST data; the shape is what is bound.
const SLICES = ["/subscription.slice", "/subscription.slice/subscription-runtime.slice", "/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice"];
const parentsOf = (): OriginalCgroupNode[] => SLICES.map((path, at) => ({ path, dev: 29, ino: 7_663_801 + at * 79 }));
const facts = (over: Partial<OriginalUnitSample> = {}, leaf: OriginalLeafObservation = "empty", parents: readonly OriginalCgroupNode[] = parentsOf()): OriginalUnitFacts =>
  ({ before: sampleOf(over), leaf, parents, after: sampleOf(over) });
const terminalFacts = facts();
const expectedUnit = { controlGroup: GROUP, invocationId: INVOCATION, bootId: BOOT, authority: { parents: parentsOf() } as OriginalRetiredAuthority | null };
// Physically observed shapes (Root receipt runtime-systemd-loadstate-a2-actual.json, isolated TEST units, `Type=exec --wait`, no
// CollectMode): a normally exited or STOPPED unit is `not-found`/`inactive`/PID 0/no job/empty ControlGroup/EMPTY InvocationID and its
// ORIGINAL live leaf is gone under stable root-owned parents; a NEVER-created unit prints exactly the same show; a FAILED unit stays
// `loaded`/`failed` with its original invocation and an empty ControlGroup, leaf gone. These fixtures reproduce those shapes only.
const RETIRED = { loadState: "not-found", controlGroup: "", invocationId: "" } as const;
const retiredNormal = facts(RETIRED, "absent_proved");
const loadedFailed = facts({ controlGroup: "", activeState: "failed" }, "absent_proved");

describe("F1: original installation unit custody is proved terminal from positive facts only", () => {
  it("accepts only the conjunction of terminal ActiveState, MainPID 0, no job and an empty control group (failed counts as terminal)", () => {
    expect(originalUnitPending(terminalFacts, expectedUnit)).toBeNull();
    expect(originalUnitPending(facts({ activeState: "failed" }), expectedUnit)).toBeNull();
  });

  it.each([
    ["an active unit", { activeState: "active" }, "unit_not_terminal:active"],
    ["a deactivating unit (stop requested, not finished)", { activeState: "deactivating" }, "unit_not_terminal:deactivating"],
    ["a unit state that was never observed", { activeState: "" }, "unit_not_terminal:"],
    ["a live MainPID", { mainPid: "4242" }, "main_pid_alive"],
    ["an unreadable MainPID", { mainPid: "" }, "main_pid_alive"],
    ["a queued job", { jobPresent: true }, "job_present"],
    ["a collected (not-found) unit that still reports a group and an invocation is inconsistent", { loadState: "not-found" }, "retired_unit_reports_identity"],
    ["a masked unit", { loadState: "masked" }, "unit_not_known:masked"],
  ])("%s keeps the unit pending", (_name, over, pending) => {
    expect(originalUnitPending(facts(over), expectedUnit)).toBe(pending);
  });

  it("a control group that is not proved empty (populated, absent-without-proof or unreadable) keeps the unit pending", () => {
    expect(originalUnitPending(facts({}, "not_proved"), expectedUnit)).toBe("group_not_empty");
    expect(originalUnitPending(facts({ controlGroup: "", invocationId: "" }, "not_proved"), expectedUnit)).toBe("group_not_empty");
  });

  it.each([
    ["another control group", { controlGroup: "/somewhere-else.service" }, "original_unit_replaced:control_group"],
    ["another invocation (the unit was restarted or replaced)", { invocationId: "b".repeat(32) }, "original_unit_replaced:invocation"],
    ["another boot", { bootId: "22222222-2222-2222-2222-222222222222" }, "original_unit_replaced:boot"],
  ])("%s is a replaced unit: HELD, not something to wait for", (_name, over, reason) => {
    expect(() => originalUnitPending(facts(over), expectedUnit)).toThrow(`hosted_retention_operation_held:${reason}`);
    expect(() => originalUnitPending(facts(over, "absent_proved"), expectedUnit)).toThrow(`hosted_retention_operation_held:${reason}`);
  });

  it("an issuer that never bound the supervisor has no invocation to compare, and every other fact is still required", () => {
    const unbound = { controlGroup: GROUP, invocationId: null, bootId: BOOT, authority: null };
    expect(originalUnitPending(facts({ invocationId: "c".repeat(32) }), unbound)).toBeNull();
    expect(originalUnitPending(facts({ mainPid: "7" }), unbound)).toBe("main_pid_alive");
  });
});

// BINDING tests for the three DISTINCT accepting shapes (existing-empty leaf is covered above; loaded + bound-absent; authenticated-
// retired `not-found`). Each rejecting case fails when the named guard in `originalUnitPending` is removed. They drive the PURE
// predicate (the decision); the filesystem/systemd observation that feeds it is NOT exercised by any test here.
describe("F1: a normally disposed terminal unit is accepted only on the retained, authenticated original identity", () => {
  it.each(["normal", "stop"])("AUTHENTICATED-RETIRED %s: not-found/inactive/PID 0, empty group and invocation, original leaf gone under the retained parents, is accepted", () => {
    expect(originalUnitPending(retiredNormal, expectedUnit)).toBeNull();
  });

  it("LOADED + BOUND-ABSENT: a failed unit keeps its record and invocation; with the leaf gone under the retained parents it is accepted", () => {
    expect(originalUnitPending(loadedFailed, expectedUnit)).toBeNull();
  });

  it("a LOADED unit with an empty invocation is not authority (only a collected unit may have none): pending", () => {
    expect(originalUnitPending(facts({ controlGroup: "", invocationId: "" }, "absent_proved"), expectedUnit)).toBe("invocation_empty_for_loaded_unit");
    expect(originalUnitPending(facts({ controlGroup: "", invocationId: "", activeState: "failed" }, "absent_proved"), expectedUnit)).toBe("invocation_empty_for_loaded_unit");
  });

  it("the empty ControlGroup/InvocationID are never absence by themselves: without a bound leaf observation the unit stays pending", () => {
    expect(originalUnitPending(facts(RETIRED, "not_proved"), expectedUnit)).toBe("group_not_empty");
    expect(originalUnitPending(facts({ controlGroup: "", invocationId: "" }, "not_proved"), expectedUnit)).toBe("group_not_empty");
  });

  it("an absent leaf while systemd still reports a group is inconsistent: pending, not accepted", () => {
    expect(originalUnitPending(facts({ invocationId: "" }, "absent_proved"), expectedUnit)).toBe("control_group_reported_for_absent_leaf");
  });

  it.each([
    ["the issuer never bound the supervisor (nothing was ever launched: a never-created unit prints the same show)", { ...expectedUnit, invocationId: null, authority: null }],
    ["the bound record is not authenticated by the supervisor's own record, or the live leaf chain was never retained", { ...expectedUnit, authority: null }],
    ["a retained live chain exists but no invocation was retained", { ...expectedUnit, invocationId: null }],
  ])("a collected (not-found) unit is HELD at once when %s", (_name, expected) => {
    expect(() => originalUnitPending(retiredNormal, expected)).toThrow("hosted_retention_operation_held:original_unit_unauthenticated");
  });

  it("a loaded bound-absent unit is HELD at once without retained authority too (waiting cannot create the missing custody)", () => {
    expect(() => originalUnitPending(loadedFailed, { ...expectedUnit, authority: null })).toThrow("hosted_retention_operation_held:original_unit_unauthenticated");
    expect(() => originalUnitPending(loadedFailed, { ...expectedUnit, invocationId: null })).toThrow("hosted_retention_operation_held:original_unit_unauthenticated");
  });

  it("PARENTS must be exactly the ones that held the genuine live leaf: a recreated, missing, extra, reordered or unobserved parent is HELD", () => {
    const base = parentsOf();
    const variants: [string, OriginalCgroupNode[]][] = [
      ["a parent with another inode (deleted and recreated)", base.map((node, at) => at === 1 ? { ...node, ino: node.ino + 1 } : node)],
      ["a parent on another device", base.map((node, at) => at === 2 ? { ...node, dev: 30 } : node)],
      ["a missing (unbound) parent", base.slice(0, 2)],
      ["an extra parent", [...base, { path: `${SLICES[2]}/x.slice`, dev: 29, ino: 1 }]],
      ["a renamed parent path", base.map((node, at) => at === 0 ? { ...node, path: "/other.slice" } : node)],
      ["reordered parents", [...base].reverse()],
      ["no observed parents at all", []],
    ];
    for (const [, observed] of variants) {
      expect(() => originalUnitPending(facts(RETIRED, "absent_proved", observed), expectedUnit)).toThrow("hosted_retention_operation_held:original_leaf_parents_unbound");
      expect(() => originalUnitPending(facts({ controlGroup: "", activeState: "failed" }, "absent_proved", observed), expectedUnit)).toThrow("original_leaf_parents_unbound");
    }
    // an authority that retained no parents cannot bind anything
    expect(() => originalUnitPending(retiredNormal, { ...expectedUnit, authority: { parents: [] } })).toThrow("original_leaf_parents_unbound");
  });

  it("a NON-empty changed invocation is a replacement and is never substituted, even with a proved-absent leaf (loaded or collected)", () => {
    expect(() => originalUnitPending(facts({ controlGroup: "", invocationId: "d".repeat(32) }, "absent_proved"), expectedUnit)).toThrow("original_unit_replaced:invocation");
    expect(() => originalUnitPending(facts({ ...RETIRED, invocationId: "d".repeat(32) }, "absent_proved"), expectedUnit)).toThrow("original_unit_replaced:invocation");
  });

  it.each([
    ["a live MainPID", { mainPid: "4242" }, "main_pid_alive"],
    ["a pending job", { jobPresent: true }, "job_present"],
    ["a still active unit", { activeState: "active" }, "unit_not_terminal:active"],
    ["a deactivating unit", { activeState: "deactivating" }, "unit_not_terminal:deactivating"],
    ["a collected unit reporting `failed`", { activeState: "failed" }, "retired_unit_not_inactive:failed"],
    ["a collected unit that still reports a group", { controlGroup: GROUP }, "retired_unit_reports_identity"],
    ["a collected unit that still reports the retained invocation", { invocationId: INVOCATION }, "retired_unit_reports_identity"],
  ])("%s is refused for a collected unit even though the leaf is gone and the retained authority is genuine", (_name, over, pending) => {
    expect(originalUnitPending(facts({ ...RETIRED, ...over }, "absent_proved"), expectedUnit)).toBe(pending);
  });

  it("a collected unit whose original leaf EXISTS contradicts itself and is never accepted", () => {
    expect(originalUnitPending(facts(RETIRED, "empty"), expectedUnit)).toBe("retired_unit_with_live_leaf");
  });

  it("OTHER LoadState values are not custody: masked/error never reach the absence branch", () => {
    expect(originalUnitPending(facts({ ...RETIRED, loadState: "masked" }, "absent_proved"), expectedUnit)).toBe("unit_not_known:masked");
    expect(originalUnitPending(facts({ ...RETIRED, loadState: "error" }, "absent_proved"), expectedUnit)).toBe("unit_not_known:error");
  });

  it("OBSERVATION DRIFT: any change between the sample before and the sample after the leaf observation is not proof", () => {
    for (const change of [{ invocationId: "" }, { mainPid: "4242" }, { jobPresent: true }, { activeState: "active" }, { loadState: "not-found" }, { controlGroup: "" }] as const) {
      const drift: OriginalUnitFacts = { before: sampleOf(), leaf: "empty", parents: parentsOf(), after: sampleOf(change) };
      expect(originalUnitPending(drift, expectedUnit)).toBe("observation_drift");
    }
    // a collected unit that appears loaded again (re-created) between the samples drifts as well
    expect(originalUnitPending({ ...retiredNormal, after: sampleOf({ ...RETIRED, loadState: "loaded" }) }, expectedUnit)).toBe("observation_drift");
    // an unchanged pair of terminal-retired samples is NOT drift
    expect(originalUnitPending({ ...retiredNormal, before: retiredNormal.before, after: retiredNormal.after }, expectedUnit)).toBeNull();
  });

  it("a drift that crosses to ANOTHER boot or invocation is a replacement, not a retry", () => {
    expect(() => originalUnitPending({ ...facts(), after: sampleOf({ invocationId: "e".repeat(32) }) }, expectedUnit)).toThrow("original_unit_replaced:invocation");
    expect(() => originalUnitPending({ ...retiredNormal, after: sampleOf({ bootId: "33333333-3333-3333-3333-333333333333" }) }, expectedUnit)).toThrow("original_unit_replaced:boot");
    // a collected unit judged against another boot than the funded one is stale, not terminal
    expect(() => originalUnitPending(facts({ ...RETIRED, bootId: "22222222-2222-2222-2222-222222222222" }, "absent_proved"), expectedUnit)).toThrow("original_unit_replaced:boot");
  });

  it("an EXISTING leaf keeps the current binding: systemd must still name the original group and a retained invocation", () => {
    expect(originalUnitPending(facts({ controlGroup: "" }, "empty"), expectedUnit)).toBe("control_group_unbound_for_live_leaf");
    expect(originalUnitPending(facts({ invocationId: "" }, "empty"), expectedUnit)).toBe("invocation_unretained_for_live_leaf");
    // the existing-empty shape needs neither retained parents nor retained authority beyond a comparable invocation (unchanged)
    expect(originalUnitPending(facts({}, "empty", []), { ...expectedUnit, authority: null })).toBeNull();
  });
});

// BINDING tests of the AUTHORITY DERIVATION (`deriveOriginalUnitExpectation`), the code both the outside cleanup gate and the issuer's
// final closure (`runFundedInstallationSupervisor`) feed with the raw bytes of the three records. The fixtures use the exact writer
// schemas: `original-supervisor.json` and `<id>.supervisor.json` {operationId, unit, bootId, birth, invocationId, controlGroup} and
// `original-leaf-chain.json` {operationId, unit, bootId, controlGroup, parents:[{path,dev,ino}...], leaf:{dev,ino}}. They are the
// bytes a private reader would return; this is NOT the reader's custody (owner/mode/held-FD checks) and NOT the live supervisor, which
// stay physical gates. Every rejecting case asserts its OWN field-specific reason, and mutates ONLY that field in a way no other
// check would catch (e.g. the issuer's record and the supervisor's record are mutated together for the issuer-side cases), so it
// fails when exactly that check is removed instead of passing on an unrelated error.
const UNIT = `subscription-runtime-installation-${OP}.service`;
const BIRTH = "4242:900100";
const OTHER_OP = "77777777-7777-7777-7777-777777777777", OTHER_BOOT = "22222222-2222-2222-2222-222222222222";
const supervisorRecord = (over: Record<string, unknown> = {}) => ({ operationId: OP, unit: UNIT, bootId: BOOT, birth: BIRTH, invocationId: INVOCATION, controlGroup: GROUP, ...over });
const chainRecord = (over: Record<string, unknown> = {}) =>
  ({ operationId: OP, unit: UNIT, bootId: BOOT, controlGroup: GROUP, parents: parentsOf(), leaf: { dev: 29, ino: 7_664_816 }, ...over });
const asBytes = (value: unknown) => Buffer.from(`${JSON.stringify(value)}\n`);
const recordsOf = (over: Partial<Record<"bound" | "self" | "chain", Uint8Array | null>> = {}) =>
  ({ bound: asBytes(supervisorRecord()), self: asBytes(supervisorRecord()), chain: asBytes(chainRecord()), ...over });
const identityOf = (over: Partial<OriginalUnitIdentity> = {}): OriginalUnitIdentity =>
  ({ operationId: OP, unit: UNIT, controlGroup: GROUP, hostId: HOST, bootId: BOOT, liveHostId: HOST, liveBootId: BOOT, ...over });

describe("authority derivation: the three already-authenticated records plus the funded identity", () => {
  it("POSITIVE: genuine issuer + supervisor + live-chain bytes for this operation, machine and boot derive the retained identity and authority", () => {
    const expected = deriveOriginalUnitExpectation(identityOf(), recordsOf());
    expect(expected).toEqual({ controlGroup: GROUP, invocationId: INVOCATION, bootId: BOOT, authority: { parents: parentsOf() } });
    // end to end through the SAME predicate: a collected normal/stop unit and a loaded failed unit are accepted on exactly this authority
    expect(originalUnitPending(retiredNormal, expected)).toBeNull();
    expect(originalUnitPending(loadedFailed, expected)).toBeNull();
  });

  it.each([
    ["no bound record at all (nothing was ever bound: a never-created unit)", { bound: null }, "no_bound"],
    ["no supervisor self-record (the bound record is not confirmed)", { self: null }, "bound_only"],
    ["no retained live chain", { chain: null }, "bound_only"],
  ])("MISSING AUTHORITY: %s yields authority null, and a collected unit is then HELD", (_name, over, shape) => {
    const expected = deriveOriginalUnitExpectation(identityOf(), recordsOf(over));
    expect(expected.authority).toBeNull();
    expect(expected.invocationId).toBe(shape === "no_bound" ? null : INVOCATION);
    expect(() => originalUnitPending(retiredNormal, expected)).toThrow("hosted_retention_operation_held:original_unit_unauthenticated");
    expect(() => originalUnitPending(loadedFailed, expected)).toThrow("hosted_retention_operation_held:original_unit_unauthenticated");
  });

  // Issuer side: the bound AND the self-record are mutated together, so the only check that can refuse is the issuer-vs-identity one.
  it.each([
    ["foreign operation", { operationId: OTHER_OP }, "operationId"],
    ["foreign unit", { unit: `subscription-runtime-installation-${OTHER_OP}.service` }, "unit"],
    ["wrong original control group", { controlGroup: "/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/other.service" }, "controlGroup"],
    ["stale/foreign boot in the record", { bootId: OTHER_BOOT }, "bootId"],
  ])("ISSUER: a bound record with a %s is HELD even when the supervisor's record agrees with it", (_name, over, field) => {
    expect(() => deriveOriginalUnitExpectation(identityOf(), recordsOf({ bound: asBytes(supervisorRecord(over)), self: asBytes(supervisorRecord(over)) })))
      .toThrow(`hosted_retention_operation_held:bound_record_mismatch:${field}`);
  });

  it.each([
    ["not 32 lowercase hex", "A".repeat(32)],
    ["too short", "a".repeat(31)],
    ["not a string", 7],
  ])("ISSUER: a retained invocation that is %s is HELD even when both writers agree on it", (_name, invocationId) => {
    expect(() => deriveOriginalUnitExpectation(identityOf(), recordsOf({ bound: asBytes(supervisorRecord({ invocationId })), self: asBytes(supervisorRecord({ invocationId })) })))
      .toThrow("hosted_retention_operation_held:bound_invocation_invalid");
  });

  it("ISSUER: an empty retained birth is HELD even when both writers agree on it", () => {
    expect(() => deriveOriginalUnitExpectation(identityOf(), recordsOf({ bound: asBytes(supervisorRecord({ birth: "" })), self: asBytes(supervisorRecord({ birth: "" })) })))
      .toThrow("hosted_retention_operation_held:bound_birth_invalid");
  });

  // Birth / generation side: only the supervisor's own record differs from the issuer's bound record.
  it.each([
    ["REUSED/changed admitted BIRTH (another process incarnation)", { birth: "4243:900100" }, "birth"],
    ["reused birth start ticks", { birth: "4242:900101" }, "birth"],
    ["INVOCATION mismatch (the unit was started again)", { invocationId: "b".repeat(32) }, "invocationId"],
    ["another operation", { operationId: OTHER_OP }, "operationId"],
    ["another unit", { unit: `subscription-runtime-installation-${OTHER_OP}.service` }, "unit"],
    ["another boot (a mixed generation)", { bootId: OTHER_BOOT }, "bootId"],
    ["another control group", { controlGroup: `${GROUP}x` }, "controlGroup"],
  ])("SUPERVISOR BIRTH: a self-record with a %s is HELD against the issuer's bound record", (_name, over, field) => {
    expect(() => deriveOriginalUnitExpectation(identityOf(), recordsOf({ self: asBytes(supervisorRecord(over)) })))
      .toThrow(`hosted_retention_operation_held:supervisor_record_mismatch:${field}`);
  });

  it.each([
    ["stale machine (another host's records)", { liveHostId: "e".repeat(32) }, "machine_mismatch"],
    ["stale boot (the host rebooted since the funded operation)", { liveBootId: OTHER_BOOT }, "boot_stale"],
  ])("MACHINE+BOOT: a %s is HELD before any record is believed, even with genuine records", (_name, over, reason) => {
    expect(() => deriveOriginalUnitExpectation(identityOf(over), recordsOf())).toThrow(`hosted_retention_operation_held:${reason}`);
    expect(() => deriveOriginalUnitExpectation(identityOf(over), recordsOf({ bound: null }))).toThrow(`hosted_retention_operation_held:${reason}`);
  });

  it.each([
    ["foreign operation", { operationId: OTHER_OP }, "operationId"],
    ["foreign unit", { unit: `subscription-runtime-installation-${OTHER_OP}.service` }, "unit"],
    ["mixed generation (another boot)", { bootId: OTHER_BOOT }, "bootId"],
    ["another control group", { controlGroup: `${GROUP}x` }, "controlGroup"],
  ])("LIVE CHAIN: a retained chain of a %s is HELD, not trusted as this unit's ancestry", (_name, over, field) => {
    expect(() => deriveOriginalUnitExpectation(identityOf(), recordsOf({ chain: asBytes(chainRecord(over)) })))
      .toThrow(`hosted_retention_operation_held:leaf_chain_mismatch:${field}`);
  });

  it.each([
    ["a wrong parent path", () => parentsOf().map((node, at) => at === 1 ? { ...node, path: "/subscription.slice/other.slice" } : node)],
    ["a missing (unbound) parent", () => parentsOf().slice(0, 2)],
    ["an extra parent", () => [...parentsOf(), { path: `${SLICES[2]}/x.slice`, dev: 29, ino: 9 }]],
    ["reordered parents", () => [...parentsOf()].reverse()],
    ["a negative device", () => parentsOf().map((node, at) => at === 0 ? { ...node, dev: -1 } : node)],
    ["a zero inode", () => parentsOf().map((node, at) => at === 2 ? { ...node, ino: 0 } : node)],
    ["a non-integer inode", () => parentsOf().map((node, at) => at === 2 ? { ...node, ino: 1.5 } : node)],
    ["a parent row with an extra field", () => parentsOf().map((node, at) => at === 0 ? { ...node, extra: 1 } : node)],
  ])("LIVE CHAIN: %s in the retained ancestry is HELD", (_name, parents) => {
    expect(() => deriveOriginalUnitExpectation(identityOf(), recordsOf({ chain: asBytes(chainRecord({ parents: parents() })) })))
      .toThrow("hosted_retention_operation_held:leaf_chain_parents_invalid");
  });

  it.each([
    ["a missing leaf identity", null],
    ["a leaf without an inode", { dev: 29 }],
    ["a leaf with a zero inode", { dev: 29, ino: 0 }],
    ["a leaf with an extra field", { dev: 29, ino: 5, extra: true }],
  ])("LIVE CHAIN: %s is HELD", (_name, leaf) => {
    expect(() => deriveOriginalUnitExpectation(identityOf(), recordsOf({ chain: asBytes(chainRecord({ leaf })) })))
      .toThrow("hosted_retention_operation_held:leaf_chain_leaf_invalid");
  });

  it("RECORD SHAPE: malformed JSON, a foreign extra key or a missing key in any of the three records is HELD, never read as absent", () => {
    const withExtra = (value: Record<string, unknown>) => asBytes({ ...value, extra: 1 });
    const { birth: _birth, ...withoutBirth } = supervisorRecord();
    expect(() => deriveOriginalUnitExpectation(identityOf(), recordsOf({ bound: Buffer.from("{not json") }))).toThrow("hosted_retention_operation_held:record_not_json");
    expect(() => deriveOriginalUnitExpectation(identityOf(), recordsOf({ bound: withExtra(supervisorRecord()) }))).toThrow("hosted_retention_operation_held:bound_record_shape");
    expect(() => deriveOriginalUnitExpectation(identityOf(), recordsOf({ bound: asBytes(withoutBirth), self: asBytes(withoutBirth) }))).toThrow("hosted_retention_operation_held:bound_record_shape");
    expect(() => deriveOriginalUnitExpectation(identityOf(), recordsOf({ self: withExtra(supervisorRecord()) }))).toThrow("hosted_retention_operation_held:supervisor_self_record_shape");
    expect(() => deriveOriginalUnitExpectation(identityOf(), recordsOf({ chain: withExtra(chainRecord()) }))).toThrow("hosted_retention_operation_held:leaf_chain_record_shape");
    expect(() => deriveOriginalUnitExpectation(identityOf(), recordsOf({ chain: asBytes([chainRecord()]) }))).toThrow("hosted_retention_operation_held:leaf_chain_record_shape");
  });

  it("IDENTITY: a control group that is not a slice path ending in the unit is HELD before any record is read", () => {
    expect(() => deriveOriginalUnitExpectation(identityOf({ controlGroup: `/${UNIT}` }), recordsOf())).toThrow("hosted_retention_operation_held:identity_group_invalid");
    expect(() => deriveOriginalUnitExpectation(identityOf({ controlGroup: "/subscription.slice/other.service" }), recordsOf())).toThrow("hosted_retention_operation_held:identity_group_invalid");
  });

  it("MIXED GENERATION: genuine records of ANOTHER bind (parents with other inodes) derive an authority the live observation no longer matches", () => {
    const stale = deriveOriginalUnitExpectation(identityOf(), recordsOf({ chain: asBytes(chainRecord({ parents: parentsOf().map((node, at) => at === 2 ? { ...node, ino: node.ino + 1 } : node) })) }));
    expect(stale.authority).not.toBeNull(); // well-formed and consistent with the records, so derivation accepts it ...
    expect(() => originalUnitPending(retiredNormal, stale)).toThrow("hosted_retention_operation_held:original_leaf_parents_unbound"); // ... and the live ancestry refuses it
  });
});

describe("authority derivation drives the SAME gate decision for cleanup: a failed derivation is HELD and causes no ownership effect", () => {
  // The composition the bootstrap performs (`proveOriginalUnitTerminalCustody`): derive from the record bytes, then the bounded proof
  // against the observation. Only the bytes reader and the live observation are replaced; the derivation and the predicate are the
  // real exported code. The issuer's final closure calls the same bootstrap function, so it consumes the same derivation.
  const gateFrom = (identity: OriginalUnitIdentity, records: ReturnType<typeof recordsOf>, observed: OriginalUnitFacts) => {
    let now = 0;
    const window = { remainingMs: () => 1000 - now, sleep: async (ms: number) => { now += ms; } };
    return { remainingMs: () => 1000, proveOriginalTerminal: () => proveOriginalUnitTerminal(deriveOriginalUnitExpectation(identity, records), () => observed, window) };
  };

  it("genuine records + a genuine collected unit reach the ownership read", async () => {
    await expect(cleanupOwnedRetentionContainer(OP, gateFrom(identityOf(), recordsOf(), retiredNormal))).resolves.toEqual({ ok: true, outcome: "no_container", containerId: null });
    expect(mocks.readRecord).toHaveBeenCalledWith(OP, "packet");
  });

  it.each([
    ["a foreign issuer record", identityOf(), recordsOf({ bound: asBytes(supervisorRecord({ operationId: OTHER_OP })), self: asBytes(supervisorRecord({ operationId: OTHER_OP })) }), "bound_record_mismatch:operationId"],
    ["a reused birth", identityOf(), recordsOf({ self: asBytes(supervisorRecord({ birth: "9:9" })) }), "supervisor_record_mismatch:birth"],
    ["an invocation mismatch", identityOf(), recordsOf({ self: asBytes(supervisorRecord({ invocationId: "c".repeat(32) })) }), "supervisor_record_mismatch:invocationId"],
    ["a stale boot", identityOf({ liveBootId: OTHER_BOOT }), recordsOf(), "boot_stale"],
    ["a stale machine", identityOf({ liveHostId: "f".repeat(32) }), recordsOf(), "machine_mismatch"],
    ["a foreign leaf chain", identityOf(), recordsOf({ chain: asBytes(chainRecord({ unit: `subscription-runtime-installation-${OTHER_OP}.service` })) }), "leaf_chain_mismatch:unit"],
    ["a broken parent chain", identityOf(), recordsOf({ chain: asBytes(chainRecord({ parents: parentsOf().slice(1) })) }), "leaf_chain_parents_invalid"],
  ])("%s is HELD with its own reason; no packet read, no Docker, no receipt", async (_name, identity, records, reason) => {
    const result = await cleanupOwnedRetentionContainer(OP, gateFrom(identity, records, retiredNormal));
    expect(result).toMatchObject({ ok: false, outcome: "cleanup_unproved", containerId: null });
    expect(result.reason).toContain(reason);
    expect(mocks.readRecord).not.toHaveBeenCalled();
    expect(mocks.createRecord).not.toHaveBeenCalled();
  });

  it.each([
    ["no records at all (never created)", recordsOf({ bound: null, self: null, chain: null })],
    ["a bound record without the supervisor's confirmation", recordsOf({ self: null })],
    ["a bound record without the retained live chain", recordsOf({ chain: null })],
  ])("UNKNOWN stays HELD: %s never lets a collected unit reach the ownership read", async (_name, records) => {
    const result = await cleanupOwnedRetentionContainer(OP, gateFrom(identityOf(), records, retiredNormal));
    expect(result).toMatchObject({ ok: false, outcome: "cleanup_unproved", containerId: null });
    expect(result.reason).toContain("original_unit_unauthenticated");
    expect(mocks.readRecord).not.toHaveBeenCalled();
    expect(mocks.createRecord).not.toHaveBeenCalled();
  });

  // DISCLOSURE (clause 3): the `proveOriginalUnitTerminalCustody` composition itself (the private-file reads of the three records, the
  // /etc/machine-id and boot reads, `observeOriginalUnit`) is Linux-only and is not driven here; what is bound is the derivation and the
  // decision it feeds. Reader custody and the live supervisor/cgroup checks are physical gates this suite cannot replace.
});

describe("F1: the bounded proof polls an asynchronous stop, and a window that ends first leaves the attempt HELD", () => {
  function clock(window: number) {
    let now = 0, sleeps = 0;
    return { remainingMs: () => window - now, sleep: async (ms: number) => { sleeps += 1; now += ms; }, tick: (ms: number) => { now += ms; }, sleeps: () => sleeps };
  }

  it("a unit that is still stopping becomes terminal on a later poll; the proof resolves only then", async () => {
    const c = clock(10_000), sequence: OriginalUnitFacts[] = [facts({ mainPid: "4242", activeState: "deactivating" }), facts({}, "not_proved"), terminalFacts];
    let calls = 0;
    await expect(proveOriginalUnitTerminal(expectedUnit, () => sequence[Math.min(calls++, sequence.length - 1)]!, c)).resolves.toBeUndefined();
    expect(calls).toBe(3);
    expect(c.sleeps()).toBe(2);
  });

  it("a unit that never becomes terminal is HELD with the still-pending fact, after a BOUNDED number of polls", async () => {
    const c = clock(1000);
    await expect(proveOriginalUnitTerminal(expectedUnit, () => facts({}, "not_proved"), c))
      .rejects.toThrow("hosted_retention_operation_held:original_unit_not_terminal:group_not_empty");
    expect(c.sleeps()).toBeLessThanOrEqual(5);
  });

  it("a replaced unit is HELD on the first observation without waiting", async () => {
    const c = clock(10_000);
    await expect(proveOriginalUnitTerminal(expectedUnit, () => facts({ invocationId: "b".repeat(32) }), c)).rejects.toThrow("original_unit_replaced:invocation");
    expect(c.sleeps()).toBe(0);
  });

  it("an observation that keeps failing is HELD with its reason, never read as terminal", async () => {
    const c = clock(1000);
    await expect(proveOriginalUnitTerminal(expectedUnit, () => { throw new Error("hosted_ordinary_collector_failed"); }, c))
      .rejects.toThrow("original_unit_not_terminal:observation_failed:hosted_ordinary_collector_failed");
  });

  it("DELAYED FINAL IO: a terminal observation that returns after the window ended is not proof", async () => {
    const c = clock(1000);
    await expect(proveOriginalUnitTerminal(expectedUnit, () => { c.tick(1000); return terminalFacts; }, c))
      .rejects.toThrow("original_unit_not_terminal:window_ended_after_observation");
    // Boundary: the same observation 1 ms inside the window is accepted.
    const inside = clock(1000);
    await expect(proveOriginalUnitTerminal(expectedUnit, () => { inside.tick(999); return terminalFacts; }, inside)).resolves.toBeUndefined();
  });
});

describe("F1: cleanupOwnedRetentionContainer proves terminal custody BEFORE it reads the packet", () => {
  it("a failing proof returns HELD without reading a single operation record (a missing packet no longer means 'nothing was created')", async () => {
    const gate = { remainingMs: () => 1000, proveOriginalTerminal: async () => { throw new Error("hosted_retention_operation_held:original_unit_not_terminal:main_pid_alive"); } };
    const result = await cleanupOwnedRetentionContainer(OP, gate);
    expect(result).toMatchObject({ ok: false, outcome: "cleanup_unproved", containerId: null });
    expect(result.reason).toContain("main_pid_alive");
    expect(mocks.readRecord).not.toHaveBeenCalled();
    expect(mocks.createRecord).not.toHaveBeenCalled();
  });

  // The real gate composition: the bounded proof over the PURE predicate, with the observation replaced by a fixed bracket.
  const gateOver = (expected: Parameters<typeof proveOriginalUnitTerminal>[0], observed: OriginalUnitFacts) => {
    let now = 0; // a still-pending fact is polled on a virtual clock until the 1000 ms window ends, then HELD
    const window = { remainingMs: () => 1000 - now, sleep: async (ms: number) => { now += ms; } };
    return { remainingMs: () => 1000, proveOriginalTerminal: () => proveOriginalUnitTerminal(expected, () => observed, window) };
  };

  it.each([
    ["an authenticated-retired normal/stop unit (not-found, empty group and invocation, original leaf gone)", retiredNormal],
    ["a loaded failed unit with its retained invocation and the original leaf gone", loadedFailed],
  ])("%s reaches the ownership read", async (_name, observed) => {
    await expect(cleanupOwnedRetentionContainer(OP, gateOver(expectedUnit, observed))).resolves.toEqual({ ok: true, outcome: "no_container", containerId: null });
    expect(mocks.readRecord).toHaveBeenCalledWith(OP, "packet");
  });

  // The `not-found` normal/stop show is byte-identical to a NEVER-created unit, so the ONLY thing that separates them is the retained,
  // authenticated authority. Every case below must refuse BEFORE the packet / custody records are read (no Docker call, no receipt).
  it.each([
    ["a never-created unit: the issuer never bound a supervisor, so there is no authority", { ...expectedUnit, invocationId: null, authority: null }, retiredNormal, "original_unit_unauthenticated"],
    ["a synthetic/unauthenticated snapshot: bound record not confirmed by the supervisor's own record or no retained live chain", { ...expectedUnit, authority: null }, retiredNormal, "original_unit_unauthenticated"],
    ["no retained invocation", { ...expectedUnit, invocationId: null }, retiredNormal, "original_unit_unauthenticated"],
    ["parents that are not the retained live ones (recreated)", expectedUnit, facts(RETIRED, "absent_proved", parentsOf().map((node, at) => at === 2 ? { ...node, ino: node.ino + 7 } : node)), "original_leaf_parents_unbound"],
    ["an unbound (missing) parent", expectedUnit, facts(RETIRED, "absent_proved", parentsOf().slice(0, 2)), "original_leaf_parents_unbound"],
    ["a different invocation (the unit was reused or restarted)", expectedUnit, facts({ controlGroup: "", invocationId: "f".repeat(32) }, "absent_proved"), "original_unit_replaced:invocation"],
    ["a stale boot", { ...expectedUnit, bootId: "22222222-2222-2222-2222-222222222222" }, retiredNormal, "original_unit_replaced:boot"],
    ["a live MainPID on a collected unit", expectedUnit, facts({ ...RETIRED, mainPid: "4242" }, "absent_proved"), "main_pid_alive"],
    ["a pending job", expectedUnit, facts({ ...RETIRED, jobPresent: true }, "absent_proved"), "job_present"],
    ["observation drift between the bracketing samples", expectedUnit, { ...retiredNormal, after: sampleOf({ ...RETIRED, mainPid: "4242" }) }, "observation_drift"],
    ["a collected unit whose leaf could not be proved absent", expectedUnit, facts(RETIRED, "not_proved"), "group_not_empty"],
  ])("%s is refused before any ownership read", async (_name, expected, observed, reason) => {
    const result = await cleanupOwnedRetentionContainer(OP, gateOver(expected, observed));
    expect(result).toMatchObject({ ok: false, outcome: "cleanup_unproved", containerId: null });
    expect(result.reason).toContain(reason);
    expect(mocks.readRecord).not.toHaveBeenCalled(); // no ownership read, no Docker call, no receipt
    expect(mocks.createRecord).not.toHaveBeenCalled();
  });

  // DISCLOSURE: the issuer's final closure (`runFundedInstallationSupervisor`) calls the SAME `proveOriginalUnitTerminalCustody` and
  // therefore this same predicate, but it spawns systemd-run and reads /proc and cgroupfs, so it is not driven by any test here. What
  // is bound above is the decision it shares; the wiring and the live observation are Linux qualification.

  it("after a successful proof an operation without a packet is closed as no_container (the supervisor can no longer publish one)", async () => {
    const proofs: string[] = [];
    const gate = { remainingMs: () => 1000, proveOriginalTerminal: async () => { proofs.push("proof"); } };
    await expect(cleanupOwnedRetentionContainer(OP, gate)).resolves.toEqual({ ok: true, outcome: "no_container", containerId: null });
    expect(proofs).toEqual(["proof"]);
    expect(mocks.readRecord).toHaveBeenCalledWith(OP, "packet"); // read only after the proof
  });
});

describe("F7: closeRetentionOperation samples the WORK deadline after every IO and immediately before the claim", () => {
  const IMAGE = `sha256:${"e".repeat(64)}`;
  const packetOf = (docker: boolean) => parseHostedRetentionPacket({
    schemaVersion: 3, role: "retention_operator", operationId: OP, hostId: HOST, bootId: BOOT, issuedEpochMs: 1000, workEndEpochMs: 2000, cleanupEndEpochMs: 3000,
    issuedMonotonicNs: "1", node: { path: "/usr/local/bin/node", sha256: "a".repeat(64) }, bootstrap: { path: `${RUNTIME}/dist/worker-codex/retention-operation-bootstrap.js`, sha256: "b".repeat(64) },
    runtimeDirectory: RUNTIME, runtimeSha: "1".repeat(40), runtimeManifestSha256: "2".repeat(64), installationSha256: "3".repeat(64), inventorySha256: "4".repeat(64),
    launch: docker ? { kind: HostedRetentionLaunchKind.DockerTest, image: IMAGE, fixtureRoot: "/srv/workers/.tmp-retention-TEST/fixture", mounts: [] } : { kind: HostedRetentionLaunchKind.InstallationSupervisor },
    retention: { tool: hostedRetentionTool, controllerJobId: "TEST-controller", workerJobId: "TEST-worker", permitFile: "/var/lib/TEST/permit.json", expectedPermitSha256: "5".repeat(64), confirmRetention: false },
  });
  const container = { schemaVersion: 3, operationId: OP, containerId: "c".repeat(64), image: IMAGE, cgroup: "/system.slice/docker-abc.scope", startTicks: "9001", hostPid: 4242, mounts: [] };
  type Stage = "supervisor" | "result" | "container" | "events";
  /** A clock the fake IO advances: `delay[stage]` ms pass INSIDE that stage's IO call. The window is 1000 ms. */
  function closeIo(delay: Partial<Record<Stage, number>> = {}, events = "populated 0\n") {
    let now = 0;
    const order: string[] = [], created: unknown[] = [];
    const io: RetentionCloseIo = {
      read: (_id, record) => {
        order.push(`read:${record}`); now += delay[record] ?? 0;
        return Buffer.from(record === "supervisor" ? "supervisor" : JSON.stringify(record === "result" ? { operationId: OP, ok: true } : container));
      },
      readCgroupEvents: () => { order.push("read:events"); now += delay.events ?? 0; return events; },
      create: (_id, record, value) => { order.push(`create:${record}`); created.push(value); return Buffer.from("closed"); },
      assertInWindow: () => { order.push("assert"); if (1000 - now < 1) throw new Error("hosted_retention_operation_held:window_ended"); },
    };
    return { io, order, created };
  }

  it("samples the deadline directly after each read and once more immediately before creating `closed` (container route)", () => {
    const h = closeIo();
    expect(closeRetentionOperation(packetOf(true), 0, h.io)).toEqual({ ok: true });
    expect(h.order).toEqual(["read:supervisor", "assert", "read:result", "assert", "read:container", "assert", "read:events", "assert", "assert", "create:closed"]);
    expect(closeRetentionOperation(packetOf(false), 0, closeIo().io)).toEqual({ ok: true });
    const resident = closeIo();
    closeRetentionOperation(packetOf(false), 0, resident.io);
    expect(resident.order).toEqual(["read:supervisor", "assert", "read:result", "assert", "assert", "create:closed"]);
  });

  it.each(["supervisor", "result", "container", "events"] as const)("DELAYED FINAL IO: a `%s` read that began inside the window and returned after it never reaches `closed`", stage => {
    const h = closeIo({ [stage]: 1000 });
    expect(() => closeRetentionOperation(packetOf(true), 0, h.io)).toThrow("hosted_retention_operation_held:window_ended");
    expect(h.created).toEqual([]);
    expect(h.order).not.toContain("create:closed");
  });

  it("defines the boundary: the last read returning 1 ms before the work end closes, exactly at it does not", () => {
    const inside = closeIo({ events: 999 });
    expect(closeRetentionOperation(packetOf(true), 0, inside.io)).toEqual({ ok: true });
    expect(inside.created).toHaveLength(1);
    const late = closeIo({ events: 1000 });
    expect(() => closeRetentionOperation(packetOf(true), 0, late.io)).toThrow("window_ended");
    expect(late.created).toEqual([]);
  });

  it("a populated container group, a contradicting exit code and a missing record still refuse (no closing from absence of evidence)", () => {
    expect(() => closeRetentionOperation(packetOf(true), 0, closeIo({}, "populated 1\n").io)).toThrow("container_group_populated");
    expect(() => closeRetentionOperation(packetOf(true), 1, closeIo().io)).toThrow("exit_code_contradicts_result");
    const missing = closeIo();
    expect(() => closeRetentionOperation(packetOf(true), 0, { ...missing.io, read: (_id, record) => record === "container" ? null : missing.io.read(_id, record) })).toThrow("container_record_missing");
    expect(missing.created).toEqual([]);
  });
});
