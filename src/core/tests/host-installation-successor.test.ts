import { describe, expect, it } from "vitest";
import { parseHostedInventoryV5 } from "../host-infrastructure/host-inventory";
import {
  SUCCESSOR_BOOT as BOOT, SUCCESSOR_NEW_OPERATION as NEW_OP, SUCCESSOR_OLD_OPERATION as OLD_OP,
  candidateInventory as candidate, predecessorInventory as predecessor, successorDigest as digest, successorInventory as inventory,
} from "./host-successor-fixture";
import {
  admittingSupervisorGeneration, assertHostedInventorySuccessorCongruent, hostedFundedInstallationVersions, hostedSelectedFileName, hostedSelectionRecordName,
  hostedSupervisorGeneration, hostedSupervisorGenerationMap, parseHostedInstallationSelection, parseHostedSuccessorRequest,
  type HostedOrdinaryStartAdmission,
} from "../host-infrastructure/host-installation-successor";

// Pure contract of the installation SUCCESSOR of an already-installed V5 host: the closed request pins, the content-addressed
// selection record and the census congruence between the predecessor and the candidate collected by the fresh supervisor.
// Every case parses real V5 inventories through the real parser. The live admission, the fence and the publication are Host
// concerns tested beside them (`hosted-installation-successor.test.ts`); nothing here claims an installed host.
describe("installation successor: closed wire contract", () => {
  it("the funded installation versions are exactly the normal, retention and successor ones", () => {
    expect(hostedFundedInstallationVersions).toEqual([2, 3, 4]);
  });

  it("the successor request carries only the committed predecessor pins", () => {
    const request = { installationId: "TEST-installation", installationSha256: digest("1"), inventorySha256: digest("2"), activationSha256: digest("3"), activationGeneration: 7 };
    expect(parseHostedSuccessorRequest(request).activationGeneration).toBe(7);
    // Nothing derived from the NEW supervisor (birth, unit, boot, hashes of the candidate) can ride in the request.
    for (const over of [{ bootId: BOOT }, { supervisorBirth: "300:400" }, { candidateSha256: digest("4") }, { activationGeneration: 0 }, { activationGeneration: 1.5 }, { installationSha256: "nothex" }, { inventorySha256: undefined }]) {
      expect(() => parseHostedSuccessorRequest({ ...request, ...over })).toThrow("hosted_installation_successor_invalid");
    }
  });

  it("the selection record is closed, chained and content-addressed by name", () => {
    const record = { schemaVersion: 1, installationId: "TEST-installation", generation: 1, operationId: NEW_OP, bootId: BOOT, supervisorBirth: "300:400",
      predecessor: { selectionSha256: null, installationSha256: digest("1"), inventorySha256: digest("2"), activationSha256: digest("3"), activationGeneration: 7 },
      installationSha256: digest("5"), inventorySha256: digest("6") };
    expect(parseHostedInstallationSelection(record).predecessor.selectionSha256).toBeNull();
    expect(parseHostedInstallationSelection({ ...record, generation: 2, predecessor: { ...record.predecessor, selectionSha256: digest("9") } }).generation).toBe(2);
    for (const over of [{ schemaVersion: 2 }, { generation: 0 }, { supervisorBirth: "not-a-birth" }, { extra: true }, { predecessor: { ...record.predecessor, extra: 1 } }, { inventorySha256: "short" }]) {
      expect(() => parseHostedInstallationSelection({ ...record, ...over })).toThrow("hosted_installation_successor_invalid");
    }
    expect(hostedSelectionRecordName(digest("a"))).toBe(`installation-successors/${digest("a")}.json`);
    expect(hostedSelectedFileName(digest("a"), "readonly-inventory.json")).toBe(`installation-successors/${digest("a")}/readonly-inventory.json`);
    expect(() => hostedSelectionRecordName("../x")).toThrow("hosted_installation_successor_invalid");
  });
});

describe("installation successor: candidate census must be congruent to the predecessor except for the supervisor", () => {
  it("accepts the same host described by a fresh supervisor, with or without the old supervisor row lingering process-less", () => {
    expect(() => assertHostedInventorySuccessorCongruent(predecessor(), candidate())).not.toThrow();
    const lingering = candidate({ borrowed: ["fixture-1.service", "fixture-2.service", "subscription-runtime-installation-old.service"] });
    expect(() => assertHostedInventorySuccessorCongruent(predecessor(), lingering)).not.toThrow();
  });

  it.each([
    ["the old supervisor unit relabeled as the new one", () => inventory({ supervisorUnit: "subscription-runtime-installation-old.service", birth: "300:400", operationId: NEW_OP })],
    ["the old process birth reused", () => candidate({ birth: "100:200" })],
    ["the old operation id reused", () => inventory({ supervisorUnit: "subscription-runtime-installation-new.service", birth: "300:400", operationId: OLD_OP })],
    ["another boot (a reboot never qualifies)", () => candidate({ bootId: "33333333-3333-3333-3333-333333333333" })],
    ["another machine", () => candidate({ hostId: "e".repeat(32) })],
    ["a borrowed unit that restarted (new invocation)", () => candidate({ tamper: units => units.map((u, i) => i === 1 ? { ...u, activeState: "active", invocationId: "b".repeat(32), mainPidBirth: null } : u) })],
    ["a borrowed unit with changed configuration", () => candidate({ tamper: units => units.map((u, i) => i === 2 ? { ...u, fragmentSha256: digest("b") } : u) })],
    ["an extra live unit on the host", () => candidate({ borrowed: ["fixture-1.service", "fixture-2.service", "fixture-3.service"] })],
    ["a missing unit", () => candidate({ borrowed: ["fixture-1.service"] })],
    ["a different creator job (another installation identity)", () => candidate({ creator: { jobId: "TEST-other" } })],
    ["a changed child slot", () => candidate({ creator: { childSlotSha256: digest("7") } })],
    ["another creator id", () => candidate({ creator: { creatorId: "fixture-creator-2" } })],
    ["the same job under another job root (and so another workspace)", () => candidate({ creator: { rootBase: "/fixture-other" } })],
    ["another set of disabled legacy creators", () => candidate({ disabledCreators: ["legacy-creator.service"] })],
    // a10 F3: the creator LAUNCH is part of the identity that is carried over. Binding: delete the `launchSemantics` comparison in
    // `assertHostedInventorySuccessorCongruent` (assert the edit applied) and every case below stops refusing.
    ["a changed project-start payload (`--args-json`)", () => candidate({ launchTamper: l => ({ ...l, args: l.args.map((a, i) => i === 4 ? '{"goal":"another"}' : a) }) })],
    ["another tool in the creator launch", () => candidate({ launchTamper: l => ({ ...l, args: l.args.map((a, i) => i === 2 ? "codex_goal_other_tool" : a) }) })],
    ["an extra creator argument", () => candidate({ launchTamper: l => ({ ...l, args: [...l.args, "--extra"] }) })],
    ["a dropped creator argument", () => candidate({ launchTamper: l => ({ ...l, args: l.args.slice(0, -1) }) })],
    ["a creator that does not run the runtime CLI under its own artifact", () => candidate({ launchTamper: l => ({ ...l, args: l.args.map((a, i) => i === 0 ? "/fixture/runtime-new/other.js" : a) }) })],
  ])("refuses %s", (_name, build) => {
    expect(() => assertHostedInventorySuccessorCongruent(predecessor(), build())).toThrow("hosted_installation_successor_invalid");
  });

  it("a new artifact legitimately has another runtime directory and another pinned node, and the launch semantics still match", () => {
    const old = predecessor(), next = candidate();
    expect(old.ordinaryCreators[0]!.launch.args[0]).not.toBe(next.ordinaryCreators[0]!.launch.args[0]); // the runtime-dependent argument differs
    expect(() => assertHostedInventorySuccessorCongruent(old, next)).not.toThrow();
    const otherNode = candidate({ launchTamper: l => ({ ...l, command: "/fixture/node-26" }) });
    expect(() => assertHostedInventorySuccessorCongruent(old, otherNode)).not.toThrow(); // the node pin is verified against the candidate's own packet
    // The creator launch of the predecessor is also required to run the runtime CLI: a predecessor that does not is not carried over.
    const odd = predecessor({ launchTamper: l => ({ ...l, args: l.args.map((a, i) => i === 0 ? "/fixture/runtime-old/other.js" : a) }) });
    expect(() => assertHostedInventorySuccessorCongruent(odd, next)).toThrow("hosted_installation_successor_invalid");
  });

  it("refuses a process that appeared in a kept node and an activator that appeared on the host", () => {
    const base = candidate();
    const withMember = parseHostedInventoryV5({ ...base, units: base.units.map((u, i) => i === 1 ? { ...u, activeState: "active", invocationId: "b".repeat(32), mainPidBirth: "700:800" } : u),
      cgroups: base.cgroups.map(c => c.ownerUnit === "fixture-1.service" ? { ...c, members: [{ birth: "700:800", controlGroup: c.path }] } : c) });
    expect(() => assertHostedInventorySuccessorCongruent(predecessor(), withMember)).toThrow("hosted_installation_successor_invalid");
    const activator = { name: "fixture.timer", aliases: [], targets: ["fixture-1.service"], controlGroup: null, delegate: null, fragmentPath: "/fixture/timer", fragmentSha256: digest("a"),
      dropIns: [], loadState: "loaded", activeState: "active", unitFileState: "enabled", invocationId: "b".repeat(32), job: "" };
    expect(() => assertHostedInventorySuccessorCongruent(predecessor(), parseHostedInventoryV5({ ...base, activators: [activator] }))).toThrow("hosted_installation_successor_invalid");
  });
});

// a10 F2 generation semantics. BINDING tests (real fixtures through the real parser; the rule under test is the only thing between
// "history of an earlier supervisor generation" and "a lookalike or a live start"): removing the `!input.terminal && ...` clause,
// the `born` lookup or the boot/generation clause of `admittingSupervisorGeneration` makes the corresponding cases below stop
// refusing. The mutation runs are an operator step (nothing was executed by the author of this change).
describe("installation successor: supervisor generations keep their own identity", () => {
  const old = hostedSupervisorGeneration(predecessor()), next = hostedSupervisorGeneration(candidate());
  const generations = hostedSupervisorGenerationMap([next, old]);
  const admission = (over: Partial<HostedOrdinaryStartAdmission> = {}): HostedOrdinaryStartAdmission => ({ generations, subject: next, candidateCensus: false, bootId: BOOT,
    activationGeneration: 9, terminal: true, rowGeneration: 3, start: { supervisorId: old.birth, bootId: BOOT, activationGeneration: 3 }, ...over });

  it("a generation is named by the facts of its OWN inventory (birth, operation, boot and the two windows)", () => {
    const windows = parseHostedInventoryV5({ ...candidate(), supervisor: { ...candidate().supervisor, workEndEpochMs: 1500, cleanupEndEpochMs: 2500 } });
    expect(hostedSupervisorGeneration(windows)).toEqual({ birth: "300:400", operationId: NEW_OP, bootId: BOOT, workEndEpochMs: 1500, cleanupEndEpochMs: 2500 });
    expect(hostedSupervisorGeneration(predecessor())).toEqual({ birth: "100:200", operationId: OLD_OP, bootId: BOOT, workEndEpochMs: 1000, cleanupEndEpochMs: 2000 });
  });

  it("two generations never share a birth or an operation (no relabelled supervisor)", () => {
    expect(hostedSupervisorGenerationMap([next, old]).size).toBe(2);
    expect(() => hostedSupervisorGenerationMap([next, { ...old, birth: next.birth }])).toThrow("hosted_installation_successor_invalid");
    expect(() => hostedSupervisorGenerationMap([next, { ...old, operationId: next.operationId }])).toThrow("hosted_installation_successor_invalid");
  });

  it("a TERMINAL predecessor start keeps the generation that admitted it - in the candidate census and after the selection, never the candidate's birth", () => {
    for (const candidateCensus of [true, false]) {
      const born = admittingSupervisorGeneration(admission({ candidateCensus, subject: candidateCensus ? old : next }));
      expect(born).toEqual(old);
      expect(born.birth).not.toBe(next.birth);
    }
  });

  it("an ACTIVE start belongs to the generation the committed activation names and to nowhere else", () => {
    const active = (over: Partial<HostedOrdinaryStartAdmission>) => admission({ terminal: false, ...over });
    expect(admittingSupervisorGeneration(active({ subject: next, start: { supervisorId: next.birth, bootId: BOOT, activationGeneration: 3 } }))).toEqual(next);
    // An active start admitted by an earlier generation cannot be adopted by the selected one ...
    expect(() => admittingSupervisorGeneration(active({ subject: next }))).toThrow("hosted_installation_successor_invalid");
    // ... and no start at all may be active while the inventory under census is a not-yet-selected candidate (even the predecessor's own).
    expect(() => admittingSupervisorGeneration(active({ candidateCensus: true, subject: old, start: { supervisorId: old.birth, bootId: BOOT, activationGeneration: 3 } }))).toThrow("hosted_installation_successor_invalid");
  });

  it.each([
    ["an unknown admitting birth (foreign history)", { start: { supervisorId: "900:901", bootId: BOOT, activationGeneration: 3 } }],
    ["a start without an admitting birth", { start: { supervisorId: undefined, bootId: BOOT, activationGeneration: 3 } }],
    ["a start of another boot", { start: { supervisorId: old.birth, bootId: "33333333-3333-3333-3333-333333333333", activationGeneration: 3 } }],
    ["a census of another boot than the generation that admitted the start", { bootId: "33333333-3333-3333-3333-333333333333" }],
    ["a start record and an activation row that disagree on the reservation generation (mixed reference)", { start: { supervisorId: old.birth, bootId: BOOT, activationGeneration: 4 } }],
    ["a row generation that is not a positive integer", { rowGeneration: 0, start: { supervisorId: old.birth, bootId: BOOT, activationGeneration: 0 } }],
    ["a reservation newer than the activation that lists it", { rowGeneration: 10, start: { supervisorId: old.birth, bootId: BOOT, activationGeneration: 10 } }],
  ])("refuses %s", (_name, over) => {
    expect(() => admittingSupervisorGeneration(admission(over))).toThrow("hosted_installation_successor_invalid");
  });
});
