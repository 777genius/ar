import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HostedActivationPhase } from "@vioxen/subscription-runtime/worker-core";
import type { HostedInventoryV5 } from "../../core/host-infrastructure/host-inventory";
import { admittingSupervisorGeneration } from "../../core/host-infrastructure/host-installation-successor";
import {
  SUCCESSOR_BOOT, SUCCESSOR_HOST, SUCCESSOR_OLD_OPERATION, candidateInventory, predecessorInventory, successorDigest, successorInventory,
} from "../../core/tests/host-successor-fixture";
import { maximumSelectionChainDepth, resolveOrdinaryCensusHistory } from "../hosted-ordinary-installation-history";

// HOST test of the generation semantics the exclusive census relies on (`hosted-ordinary-installation-history.ts`). The private
// record readers are doubles over an IN-MEMORY file map, but the selection RESOLVER, the closed parsers, the digest checks and the
// generation rules are the real code: a case is accepted or refused for reasons those evaluate. What no double can prove here (live
// systemd, cgroups, descriptors, the installed Linux geometry) stays an operator qualification; nothing below claims an installed host.
const ROOT = "/var/lib/subscription-runtime-host-policy";
const mocks = vi.hoisted(() => ({ files: new Map<string, Buffer>() }));
vi.mock("@vioxen/subscription-runtime/provider-codex", async importOriginal => {
  const actual = await importOriginal<object>();
  const adapters = await vi.importActual<typeof import("../../provider-codex/app-server/adapters/hosted-process-activation")>("../../provider-codex/app-server/adapters/hosted-process-activation");
  const read = (name: string) => mocks.files.get(name) ?? null;
  return { ...actual, readHostedActivationBytes: (name: string) => name === "host-installation.json" || name === "readonly-inventory.json"
    ? adapters.resolveSelectedInstallationRecord(name, read).bytes : read(name) };
});
vi.mock("../hosted-readonly-custody", () => ({ readonlySupervisorRoot: "/var/lib/subscription-runtime-host-policy" }));
// The ONE reader of the ORIGINAL fixed inventory (the same private reader the Host uses for fixed records).
vi.mock("../hosted-readonly-inputs", () => ({ readHostedPrivateBytes: (path: string) => path === `${ROOT}/readonly-inventory.json` ? mocks.files.get("readonly-inventory.json") ?? null : null }));

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const encoded = (value: unknown) => Buffer.from(JSON.stringify(value) + "\n");
const INSTALLATION = "TEST-installation";
const ORIGIN = predecessorInventory(), NEXT = candidateInventory();
const THIRD = successorInventory({ supervisorUnit: "subscription-runtime-installation-third.service", birth: "500:600",
  operationId: "33333333-3333-3333-3333-333333333333", runtimeDirectory: "/fixture/runtime-third" });
const installationRecord = (inventory: HostedInventoryV5) => encoded({ schemaVersion: 1, installationId: INSTALLATION, hostId: SUCCESSOR_HOST, runtimeDirectory: "/fixture/runtime",
  runtimeSha: "1".repeat(40), runtimeManifestSha256: successorDigest("2"), inventorySha256: sha(encoded(inventory)) });
const startId = (c: string) => `${c.repeat(8)}-${c.repeat(4)}-${c.repeat(4)}-${c.repeat(4)}-${c.repeat(12)}`;
const terminalStart = (c: string) => ({ startId: startId(c), unit: `subscription-runtime-ordinary-${startId(c)}.service`, creatorId: "fixture-creator",
  originSha256: successorDigest("4"), generation: 3, state: "terminal" });
const activationRecord = (over: Record<string, unknown> = {}) => ({ schemaVersion: 1, installationId: INSTALLATION, hostId: SUCCESSOR_HOST, bootId: SUCCESSOR_BOOT,
  supervisorId: ORIGIN.supervisor.birth, generation: 7, phase: HostedActivationPhase.Closed, ordinaryOriginsSha256: successorDigest("3"), exclusiveEnrollmentSha256: null,
  ordinaryStarts: [terminalStart("a")], ...over });

/** The ORIGINAL fixed records plus a committed activation; returns the funded pins of exactly those bytes. */
function seedOriginal(over: Record<string, unknown> = {}) {
  mocks.files.clear();
  const inventory = encoded(ORIGIN), installation = installationRecord(ORIGIN), activation = encoded(activationRecord(over));
  mocks.files.set("readonly-inventory.json", inventory); mocks.files.set("host-installation.json", installation); mocks.files.set("host-activation.json", activation);
  return { installationId: INSTALLATION, installationSha256: sha(installation), inventorySha256: sha(inventory), activationSha256: sha(activation), activationGeneration: 7 };
}
/** One selected successor generation; `link` is what it records as its predecessor. Returns the selection digest. */
function stageSelection(selected: HostedInventoryV5, generation: number, link: { selectionSha256: string | null; inventory: HostedInventoryV5 },
  over: Record<string, unknown> = {}): string {
  const inventory = encoded(selected), installation = installationRecord(selected);
  const record = { schemaVersion: 1, installationId: INSTALLATION, generation, operationId: selected.supervisor.operationId, bootId: selected.bootId,
    supervisorBirth: selected.supervisor.birth,
    predecessor: { selectionSha256: link.selectionSha256, installationSha256: successorDigest("1"), inventorySha256: sha(encoded(link.inventory)),
      activationSha256: successorDigest("2"), activationGeneration: 4 },
    installationSha256: sha(installation), inventorySha256: sha(inventory), ...over };
  const bytes = encoded(record), id = sha(bytes);
  mocks.files.set(`installation-successors/${id}.json`, bytes);
  mocks.files.set(`installation-successors/${id}/readonly-inventory.json`, inventory);
  mocks.files.set(`installation-successors/${id}/host-installation.json`, installation);
  return id;
}
/** The committed activation AFTER the selection of `selection`, naming the selected supervisor. */
function selectActivation(selection: string, supervisor: HostedInventoryV5, over: Record<string, unknown> = {}) {
  mocks.files.set("host-activation.json", encoded(activationRecord({ generation: 8, supervisorId: supervisor.supervisor.birth, installationSelectionSha256: selection, ...over })));
}
const snapshot = () => JSON.stringify([...mocks.files].map(([name, bytes]) => [name, sha(bytes)]).sort());

beforeEach(() => { mocks.files.clear(); });

describe("exclusive census history: CANDIDATE census before the selection", () => {
  it("authenticates the pinned predecessor activation and names the two generations separately, changing nothing", () => {
    const pins = seedOriginal(), before = snapshot();
    const history = resolveOrdinaryCensusHistory(NEXT, pins)!;
    expect(history.candidateCensus).toBe(true);
    // The subject of the committed activation is the PREDECESSOR; the candidate is not a generation of the committed world.
    expect(history.subject.birth).toBe(ORIGIN.supervisor.birth);
    expect([...history.generations.keys()]).toEqual([ORIGIN.supervisor.birth]);
    expect(history.generations.has(NEXT.supervisor.birth)).toBe(false);
    expect(history.activation.supervisorId).toBe(ORIGIN.supervisor.birth); // candidate activation is not pretended to exist
    expect(snapshot()).toBe(before);
  });

  it("genuine terminal predecessor history stays the predecessor's: admitted by ITS generation, not the candidate's birth", () => {
    const pins = seedOriginal(); const history = resolveOrdinaryCensusHistory(NEXT, pins)!;
    const row = (history.activation.ordinaryStarts as { generation: number }[])[0]!;
    const born = admittingSupervisorGeneration({ generations: history.generations, subject: history.subject, candidateCensus: history.candidateCensus, bootId: NEXT.bootId,
      activationGeneration: history.activation.generation as number, terminal: true, rowGeneration: row.generation,
      start: { supervisorId: ORIGIN.supervisor.birth, bootId: SUCCESSOR_BOOT, activationGeneration: row.generation } });
    expect(born.birth).toBe("100:200");
    expect(born.birth).not.toBe(NEXT.supervisor.birth);
    // The same start claiming the CANDIDATE's birth would be a lookalike: the candidate admitted nothing yet.
    expect(() => admittingSupervisorGeneration({ generations: history.generations, subject: history.subject, candidateCensus: true, bootId: NEXT.bootId,
      activationGeneration: 7, terminal: true, rowGeneration: 3, start: { supervisorId: NEXT.supervisor.birth, bootId: SUCCESSOR_BOOT, activationGeneration: 3 } })).toThrow("hosted_installation_successor_invalid");
  });

  it.each([
    ["a stale activation (pinned bytes)", (p: ReturnType<typeof seedOriginal>) => ({ ...p, activationSha256: successorDigest("9") })],
    ["a stale activation generation", (p: ReturnType<typeof seedOriginal>) => ({ ...p, activationGeneration: 6 })],
    ["a stale inventory pin", (p: ReturnType<typeof seedOriginal>) => ({ ...p, inventorySha256: successorDigest("9") })],
    ["a stale installation pin", (p: ReturnType<typeof seedOriginal>) => ({ ...p, installationSha256: successorDigest("9") })],
    ["another installation id", (p: ReturnType<typeof seedOriginal>) => ({ ...p, installationId: "TEST-other" })],
  ])("refuses %s before anything is adopted", (_name, change) => {
    const pins = seedOriginal();
    expect(() => resolveOrdinaryCensusHistory(NEXT, change(pins))).toThrow("hosted_ordinary_history_refused:stale_predecessor");
  });

  it.each([
    ["an activation that is not CLOSED", { phase: HostedActivationPhase.Ordinary }, "predecessor_not_closed"],
    ["an ACTIVE predecessor start", { ordinaryStarts: [{ ...terminalStart("a"), state: "reserved" }] }, "predecessor_active_start"],
    ["an activation naming some other supervisor (foreign session)", { supervisorId: "700:800" }, "predecessor_session"],
    ["an activation of another host", { hostId: "e".repeat(32) }, "activation_session"],
    ["an activation of another boot", { bootId: "33333333-3333-3333-3333-333333333333" }, "activation_session"],
  ])("refuses %s", (_name, over, reason) => {
    // The pins describe the bytes that ARE committed, so only the named property can refuse.
    const pins = seedOriginal(over);
    expect(() => resolveOrdinaryCensusHistory(NEXT, pins)).toThrow(`hosted_ordinary_history_refused:${reason}`);
  });

  it.each([
    ["a candidate that reuses the predecessor's birth (a relabelled supervisor)", candidateInventory({ birth: ORIGIN.supervisor.birth })],
    ["a candidate that reuses the predecessor's operation", candidateInventory({ operationId: SUCCESSOR_OLD_OPERATION })],
  ])("refuses %s", (_name, foreign) => {
    const pins = seedOriginal();
    expect(() => resolveOrdinaryCensusHistory(foreign, pins)).toThrow("hosted_ordinary_history_refused:candidate_relabelled");
  });

  it("refuses a candidate census when no activation is committed at all (there is no predecessor to succeed)", () => {
    const pins = seedOriginal(); mocks.files.delete("host-activation.json");
    expect(() => resolveOrdinaryCensusHistory(NEXT, pins)).toThrow("hosted_ordinary_history_refused:missing:host-activation.json");
  });

  it("refuses a predecessor whose selected installation does not pin the selected inventory (a mixed reference)", () => {
    const pins = seedOriginal();
    const mixed = installationRecord(NEXT); // an installation that pins another inventory
    mocks.files.set("host-installation.json", mixed);
    expect(() => resolveOrdinaryCensusHistory(NEXT, { ...pins, installationSha256: sha(mixed) })).toThrow("hosted_ordinary_history_refused:predecessor_installation");
  });
});

describe("exclusive census history: SELECTED census (normal current-kernel admission is not widened)", () => {
  it("without a selection the activation must name exactly the inventory's supervisor, and the census has one generation", () => {
    seedOriginal();
    const history = resolveOrdinaryCensusHistory(ORIGIN)!;
    expect(history).toMatchObject({ candidateCensus: false, subject: { birth: ORIGIN.supervisor.birth } });
    expect([...history.generations.keys()]).toEqual([ORIGIN.supervisor.birth]);
    // The same committed world does not admit the candidate as if it were already selected.
    expect(() => resolveOrdinaryCensusHistory(NEXT)).toThrow("hosted_ordinary_history_refused:selected_world");
    seedOriginal({ supervisorId: "700:800" });
    expect(() => resolveOrdinaryCensusHistory(ORIGIN)).toThrow("hosted_ordinary_history_refused:activation_supervisor");
  });

  it("returns null while nothing is committed (unchanged: no activation, no reservation)", () => {
    seedOriginal(); mocks.files.delete("host-activation.json");
    expect(resolveOrdinaryCensusHistory(ORIGIN)).toBeNull();
  });

  it("after one successor the predecessor generation is PROVEN from the committed chain and keeps its own facts", () => {
    seedOriginal();
    const selection = stageSelection(NEXT, 1, { selectionSha256: null, inventory: ORIGIN });
    selectActivation(selection, NEXT);
    const history = resolveOrdinaryCensusHistory(NEXT)!;
    expect(history.subject.birth).toBe(NEXT.supervisor.birth);
    expect([...history.generations.keys()].sort()).toEqual([NEXT.supervisor.birth, ORIGIN.supervisor.birth].sort());
    expect(history.generations.get(ORIGIN.supervisor.birth)).toMatchObject({ operationId: SUCCESSOR_OLD_OPERATION, bootId: SUCCESSOR_BOOT });
    // A terminal start of the predecessor is accepted as the predecessor's; an ACTIVE one of the predecessor is not adopted.
    const input = { generations: history.generations, subject: history.subject, candidateCensus: false, bootId: NEXT.bootId, activationGeneration: 8, rowGeneration: 3,
      start: { supervisorId: ORIGIN.supervisor.birth, bootId: SUCCESSOR_BOOT, activationGeneration: 3 } };
    expect(admittingSupervisorGeneration({ ...input, terminal: true }).birth).toBe(ORIGIN.supervisor.birth);
    expect(() => admittingSupervisorGeneration({ ...input, terminal: false })).toThrow("hosted_installation_successor_invalid");
  });

  it("a second successor proves the whole chain down to the original record", () => {
    seedOriginal();
    const first = stageSelection(NEXT, 1, { selectionSha256: null, inventory: ORIGIN });
    const second = stageSelection(THIRD, 2, { selectionSha256: first, inventory: NEXT });
    selectActivation(second, THIRD);
    const history = resolveOrdinaryCensusHistory(THIRD)!;
    expect([...history.generations.keys()].sort()).toEqual(["100:200", "300:400", "500:600"]);
    expect(history.subject.birth).toBe("500:600");
  });

  // The selected world resolves from the versioned copies, so these records are reached ONLY by the history's own chain walk.
  const tampered: [string, (first: string) => void, string][] = [
    ["an earlier selection record whose bytes changed", first => { mocks.files.set(`installation-successors/${first}.json`, encoded({ tampered: true })); }, "selection_record"],
    ["an original inventory that is not the one the first successor pinned", () => { mocks.files.set("readonly-inventory.json", encoded(candidateInventory({ birth: "800:900" }))); }, "selection_predecessor_inventory"],
    ["an original inventory that is missing", () => { mocks.files.delete("readonly-inventory.json"); }, "selection_predecessor_inventory"],
  ];
  it.each(tampered)("refuses %s (no fallback to a more convenient generation)", (_name, tamper, reason) => {
    seedOriginal();
    const first = stageSelection(NEXT, 1, { selectionSha256: null, inventory: ORIGIN });
    const second = stageSelection(THIRD, 2, { selectionSha256: first, inventory: NEXT });
    selectActivation(second, THIRD);
    tamper(first);
    expect(() => resolveOrdinaryCensusHistory(THIRD)).toThrow(`hosted_ordinary_history_refused:${reason}`);
  });

  it.each([
    ["a selection record of another supervisor birth than the selected inventory", { supervisorBirth: "999:998" }],
    ["a selection record of another operation", { operationId: "44444444-4444-4444-4444-444444444444" }],
    ["a selection record of another installation", { installationId: "TEST-other" }],
    ["a selection record of another boot", { bootId: "44444444-4444-4444-4444-444444444444" }],
  ])("refuses %s", (_name, over) => {
    seedOriginal();
    selectActivation(stageSelection(NEXT, 1, { selectionSha256: null, inventory: ORIGIN }, over), NEXT);
    expect(() => resolveOrdinaryCensusHistory(NEXT)).toThrow("hosted_ordinary_history_refused:selection_world");
  });

  it("refuses a chain that skips a generation, one that repeats a supervisor, and one longer than any this Host creates", () => {
    seedOriginal();
    selectActivation(stageSelection(NEXT, 2, { selectionSha256: null, inventory: ORIGIN }), NEXT);
    expect(() => resolveOrdinaryCensusHistory(NEXT)).toThrow("hosted_ordinary_history_refused:selection_chain");

    // The original record already describes the supervisor the first successor selects: a relabelled generation.
    seedOriginal(); mocks.files.set("readonly-inventory.json", encoded(NEXT));
    selectActivation(stageSelection(NEXT, 1, { selectionSha256: null, inventory: NEXT }), NEXT);
    expect(() => resolveOrdinaryCensusHistory(NEXT)).toThrow("hosted_installation_successor_invalid");

    seedOriginal();
    const inventories = Array.from({ length: maximumSelectionChainDepth + 2 }, (_, i) => successorInventory({
      supervisorUnit: `subscription-runtime-installation-g${i}.service`, birth: `${1000 + i}:${2000 + i}`,
      operationId: `${(i + 1).toString(16).padStart(8, "0")}-1111-1111-1111-111111111111`, runtimeDirectory: `/fixture/runtime-${i}` }));
    let previous: { selectionSha256: string | null; inventory: HostedInventoryV5 } = { selectionSha256: null, inventory: ORIGIN };
    inventories.forEach((inventory, i) => { previous = { selectionSha256: stageSelection(inventory, i + 1, previous), inventory }; });
    selectActivation(previous.selectionSha256!, previous.inventory);
    expect(() => resolveOrdinaryCensusHistory(previous.inventory)).toThrow("hosted_ordinary_history_refused:selection_chain_depth");
  });
});
