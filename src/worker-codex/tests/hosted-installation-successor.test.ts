import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readHostedActivationBytes } from "@vioxen/subscription-runtime/provider-codex";
import {
  HostedActivationPhase, assertHostedActivationSuccessor, parseHostedActivation, parseHostedInstallation,
} from "@vioxen/subscription-runtime/worker-core";
import type { HostedInventoryV5 } from "../../core/host-infrastructure/host-inventory";
import {
  SUCCESSOR_BOOT, SUCCESSOR_HOST, SUCCESSOR_NEW_OPERATION, candidateInventory, predecessorInventory, successorDigest,
} from "../../core/tests/host-successor-fixture";
import { commitInstallationSuccessor, type InstallationSuccessorInput } from "../hosted-installation-successor";
import { assertInstallationSelectionTransition } from "../hosted-installation-selection-transition";

// HOST test of the installation SUCCESSOR transaction. The kernel, the installed-record readers, the private record writer and
// the clock are replaced by recording doubles over an IN-MEMORY file map ONLY to observe order and bindings; the doubles are not
// authority and prove nothing about a real V5 host (live cgroup membership, unit MainPID and birth are existing kernel code that
// needs the installed Linux geometry). What is real here: the closed parsers, the census congruence, the selection resolver
// (the real `resolveSelectedInstallationRecord` over the map), the activation successor guard and the selection-transition check.
const RUNTIME = fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/, "");
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const encoded = (value: unknown) => Buffer.from(JSON.stringify(value) + "\n");
const ROOT = "/var/lib/subscription-runtime-host-policy";
const STAGE = `/run/user/0/subscription-runtime-host-policy/codex-readonly-stages/${sha(Buffer.from(RUNTIME))}.json`;

const mocks = vi.hoisted(() => ({
  root: "/var/lib/subscription-runtime-host-policy",
  files: new Map<string, Buffer>(), writes: [] as string[], directories: new Set<string>(), kernels: [] as { candidate?: unknown }[], order: [] as string[],
  operatorSession: vi.fn(), verify: vi.fn(), verifyDescriptor: vi.fn(), assertInspected: vi.fn(),
}));
vi.mock("@vioxen/subscription-runtime/provider-codex", async importOriginal => {
  const actual = await importOriginal<object>();
  const adapters = await vi.importActual<typeof import("../../provider-codex/app-server/adapters/hosted-process-activation")>("../../provider-codex/app-server/adapters/hosted-process-activation");
  const read = (name: string) => mocks.files.get(name) ?? null;
  return { ...actual, assertHostedActivationOperator: () => undefined,
    readHostedActivationBytes: (name: string) => name === "host-installation.json" || name === "readonly-inventory.json"
      ? adapters.resolveSelectedInstallationRecord(name, read).bytes : read(name) };
});
vi.mock("../hosted-readonly-host-kernel", () => ({
  parseHostedInventoryRecord: (bytes: Uint8Array) => ({ candidateBytes: Buffer.from(bytes).toString("hex") }),
  HostedReadonlyHostKernel: class {
    constructor(readonly candidate?: unknown, readonly predecessor?: unknown) { mocks.kernels.push(this); }
    operatorSession() { mocks.order.push("operatorSession"); return mocks.operatorSession(this.candidate); }
    verifyExclusiveInventory(...args: unknown[]) { mocks.order.push("verifyExclusiveInventory"); return mocks.verify(this.candidate, ...args); }
    verifyDescriptorBoundary() { return mocks.verifyDescriptor(this.candidate); }
  },
}));
vi.mock("../hosted-installation-activation", async () => {
  const worker = await import("@vioxen/subscription-runtime/worker-core");
  const adapters = await vi.importActual<typeof import("../../provider-codex/app-server/adapters/hosted-process-activation")>("../../provider-codex/app-server/adapters/hosted-process-activation");
  const read = (name: string) => mocks.files.get(name) ?? null;
  return {
    assertInspectedInstallation: mocks.assertInspected,
    readHostedInstallationActivation: () => {
      if (read("host-activation.next")) throw new Error("hosted_activation_publication_recovery_required");
      const installationBytes = adapters.resolveSelectedInstallationRecord("host-installation.json", read).bytes, activationBytes = read("host-activation.json");
      return { installation: worker.parseHostedInstallation(JSON.parse(installationBytes!.toString())), activation: worker.parseHostedActivation(JSON.parse(activationBytes!.toString())) };
    },
  };
});
vi.mock("../hosted-readonly-custody", () => ({
  readonlySupervisorRoot: mocks.root,
  createReadonlyPrivateRecordOnce: (path: string, bytes: Buffer) => {
    const name = path.slice(mocks.root.length + 1);
    if (mocks.files.has(name)) throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
    mocks.files.set(name, bytes); mocks.writes.push(name);
    mocks.order.push(`write:${/^installation-successors\/[a-f0-9]{64}\.json$/.test(name) ? "selection" : name.split("/").pop()}`);
  },
}));
vi.mock("../hosted-readonly-inputs", () => ({ readHostedPrivateBytes: (path: string) => path === STAGE ? mocks.files.get("stage") ?? null : null }));
vi.mock("../hosted-readonly-linux-collector", () => ({ collectBootId: () => SUCCESSOR_BOOT }));
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual,
    mkdirSync: ((path: string) => {
      if (mocks.directories.has(path)) throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
      mocks.directories.add(path);
    }) as unknown as typeof actual.mkdirSync,
    readFileSync: ((path: unknown, ...rest: unknown[]) => path === "/etc/machine-id" ? `${SUCCESSOR_HOST}\n` : (actual.readFileSync as (...a: unknown[]) => unknown)(path, ...rest)) as typeof actual.readFileSync };
});

const OLD_OP_INVENTORY = predecessorInventory();
const oldInventoryBytes = encoded(OLD_OP_INVENTORY);
const installation = { schemaVersion: 1, installationId: "TEST-installation", hostId: SUCCESSOR_HOST, runtimeDirectory: RUNTIME, runtimeSha: "1".repeat(40),
  runtimeManifestSha256: successorDigest("2"), inventorySha256: sha(oldInventoryBytes) };
const oldInstallationBytes = encoded(installation);
const terminalStart = { startId: "99999999-9999-9999-9999-999999999999", unit: "subscription-runtime-ordinary-99999999-9999-9999-9999-999999999999.service",
  creatorId: "fixture-creator", originSha256: successorDigest("4"), generation: 3, state: "terminal" };
const activation = (over: Record<string, unknown> = {}) => ({ schemaVersion: 1, installationId: "TEST-installation", hostId: SUCCESSOR_HOST, bootId: SUCCESSOR_BOOT,
  supervisorId: "100:200", generation: 7, phase: HostedActivationPhase.Closed, ordinaryOriginsSha256: successorDigest("3"), exclusiveEnrollmentSha256: null,
  ordinaryStarts: [terminalStart], ...over });
const NEW_RUNTIME = { runtimeDirectory: RUNTIME, runtimeSha: "7".repeat(40), runtimeManifestSha256: successorDigest("8") };
const outsideRecord = (inventory: HostedInventoryV5 = candidateInventory()) => ({ operationId: SUCCESSOR_NEW_OPERATION, unit: inventory.supervisorUnit, bootId: SUCCESSOR_BOOT,
  birth: inventory.supervisor.birth, invocationId: "c".repeat(32), controlGroup: `/${inventory.supervisorUnit}` });

function seed(over: { activation?: Record<string, unknown> } = {}): InstallationSuccessorInput["request"] {
  mocks.files.clear(); mocks.writes.length = 0; mocks.directories.clear(); mocks.kernels.length = 0; mocks.order.length = 0;
  const activationBytes = encoded(activation(over.activation));
  mocks.files.set("host-installation.json", oldInstallationBytes); mocks.files.set("readonly-inventory.json", oldInventoryBytes);
  mocks.files.set("host-activation.json", activationBytes);
  mocks.files.set("stage", encoded({ schemaVersion: 1, ...NEW_RUNTIME }));
  return { installationId: "TEST-installation", installationSha256: sha(oldInstallationBytes), inventorySha256: sha(oldInventoryBytes),
    activationSha256: sha(activationBytes), activationGeneration: 7 };
}
/** The store double applies the REAL activation successor guard and the REAL selection-transition check, then commits the bytes. */
function storeDouble() {
  const publish = vi.fn((_fence: unknown, next: unknown) => {
    const prior = parseHostedActivation(JSON.parse(mocks.files.get("host-activation.json")!.toString()));
    const after = parseHostedActivation(next);
    assertHostedActivationSuccessor(prior, after);
    assertInstallationSelectionTransition(prior, after);
    mocks.order.push("publish");
    mocks.files.set("host-activation.json", encoded(after));
  });
  return { serialized: <T>(action: (fence: object) => T) => action({}), publish } as unknown as InstallationSuccessorInput["store"] & { publish: typeof publish };
}
function input(request: InstallationSuccessorInput["request"], over: Partial<InstallationSuccessorInput> = {}, inventory: HostedInventoryV5 = candidateInventory()) {
  return { store: storeDouble(), operationId: SUCCESSOR_NEW_OPERATION, request, candidateBytes: encoded(inventory), runtime: NEW_RUNTIME,
    outside: outsideRecord(inventory), ...over } satisfies InstallationSuccessorInput;
}
const nothingStaged = () => expect(mocks.writes).toEqual([]);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.operatorSession.mockReturnValue({ hostId: SUCCESSOR_HOST, bootId: SUCCESSOR_BOOT, supervisorId: "300:400" });
});

describe("installation successor: ONE fenced selection of versioned create-once records", () => {
  it("admits the fresh supervisor against its OWN candidate census FIRST, verifies the candidate's exclusive census, stages versioned records (selection LAST), publishes once, then verifies the NEW world", () => {
    const request = seed();
    const run = input(request);
    const result = commitInstallationSuccessor(run);
    expect(mocks.operatorSession.mock.calls[0]![0]).toEqual({ candidateBytes: Buffer.from(run.candidateBytes).toString("hex") }); // the candidate, not the stored inventory
    expect(mocks.order).toEqual(["operatorSession", "verifyExclusiveInventory", "write:readonly-inventory.json", "write:host-installation.json", "write:selection", "publish", "verifyExclusiveInventory"]);
    expect(run.store.publish).toHaveBeenCalledTimes(1);
    // a10 F2: the FIRST census is the candidate's, under the very fence the publication uses, with the funded predecessor pins.
    const [candidateCensus, selectedCensus] = mocks.verify.mock.calls;
    expect(candidateCensus![0]).toEqual({ candidateBytes: Buffer.from(run.candidateBytes).toString("hex") });
    expect(candidateCensus![1]).toBe((run.store.publish as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0]);
    expect((mocks.kernels[0] as { predecessor?: unknown }).predecessor).toEqual(request);
    // The final verification is the NORMAL kernel (no candidate, no pins) against the newly selected world.
    expect(selectedCensus![0]).toBeUndefined();
    expect((mocks.kernels[1] as { predecessor?: unknown }).predecessor).toBeUndefined();
    expect(result.supervisorId).toBe("300:400");
    expect(result.generation).toBe(8);
    expect(typeof result.installationSelectionSha256).toBe("string");
  });

  // DISCLOSURE (Rule 31 clause 3): the census is a recording double here, so this case proves ORDER and FAIL-CLOSED WIRING only
  // (no record, no selection, no selected-world verification after a refused candidate census). What the census itself accepts or
  // refuses is bound in `hosted-ordinary-installation-history.test.ts` and `core/tests/host-installation-successor.test.ts`;
  // the live systemd/cgroup part needs the installed Linux geometry.
  it("a refused candidate census (drifted host, foreign group, active or unknown start, changing custody) stops everything: nothing staged, nothing published", () => {
    const request = seed(); const run = input(request);
    mocks.verify.mockImplementationOnce(() => { throw new Error("hosted_ordinary_inventory_unresolved"); });
    expect(() => commitInstallationSuccessor(run)).toThrow("hosted_ordinary_inventory_unresolved");
    nothingStaged(); expect(run.store.publish).not.toHaveBeenCalled();
    expect(mocks.verify).toHaveBeenCalledTimes(1); // the selected-world verification never ran
  });

  it("preserves the predecessor files, the installation identity, the origin catalog, the enrollment and every terminal start", () => {
    const request = seed();
    const before = { installation: Buffer.from(mocks.files.get("host-installation.json")!), inventory: Buffer.from(mocks.files.get("readonly-inventory.json")!) };
    const result = commitInstallationSuccessor(input(request));
    // Fixed predecessor records are byte-identical: the successor never rewrites them.
    expect(mocks.files.get("host-installation.json")!.equals(before.installation)).toBe(true);
    expect(mocks.files.get("readonly-inventory.json")!.equals(before.inventory)).toBe(true);
    expect(result).toMatchObject({ installationId: "TEST-installation", ordinaryOriginsSha256: successorDigest("3"), exclusiveEnrollmentSha256: null, phase: "CLOSED" });
    expect(result.ordinaryStarts).toEqual([terminalStart]);
    // The selected readers resolve the NEW generation; the new installation record keeps the identity and pins the new inventory.
    const selectedInstallation = parseHostedInstallation(JSON.parse(commitSelected("host-installation.json").toString()));
    expect(selectedInstallation).toMatchObject({ installationId: "TEST-installation", hostId: SUCCESSOR_HOST, runtimeSha: "7".repeat(40) });
    expect(selectedInstallation.inventorySha256).toBe(sha(commitSelected("readonly-inventory.json")));
    expect(sha(commitSelected("readonly-inventory.json"))).not.toBe(sha(before.inventory));
  });

  it.each([
    ["the kernel refuses the candidate supervisor (an unadmitted or lookalike process)", () => { mocks.operatorSession.mockImplementation(() => { throw new Error("hosted_custody_kernel_evidence_invalid"); }); }, "hosted_custody_kernel_evidence_invalid"],
  ])("refuses before ANY record when %s", (_name, arrange, message) => {
    const request = seed(); arrange();
    expect(() => commitInstallationSuccessor(input(request))).toThrow(message);
    nothingStaged();
  });

  it.each([
    ["an outside record of another operation", { operationId: "33333333-3333-3333-3333-333333333333" }],
    ["an outside record of another unit", { unit: "subscription-runtime-installation-other.service" }],
    ["an outside record of another process birth", { birth: "500:600" }],
    ["an outside record of another invocation", { invocationId: "b".repeat(32) }],
    ["an outside record of another cgroup", { controlGroup: "/somewhere-else.service" }],
    ["an outside record of another boot", { bootId: "33333333-3333-3333-3333-333333333333" }],
  ])("refuses %s before any record (self-authored candidate bytes are not admission)", (_name, override) => {
    const request = seed();
    expect(() => commitInstallationSuccessor(input(request, { outside: { ...outsideRecord(), ...override } }))).toThrow("hosted_installation_successor_held:outside_supervisor_record");
    nothingStaged();
  });

  it.each([
    ["a stale installation hash", (r: InstallationSuccessorInput["request"]) => ({ ...r, installationSha256: successorDigest("9") })],
    ["a stale inventory hash", (r: InstallationSuccessorInput["request"]) => ({ ...r, inventorySha256: successorDigest("9") })],
    ["a stale activation hash", (r: InstallationSuccessorInput["request"]) => ({ ...r, activationSha256: successorDigest("9") })],
    ["a stale activation generation", (r: InstallationSuccessorInput["request"]) => ({ ...r, activationGeneration: 6 })],
    ["another installation id", (r: InstallationSuccessorInput["request"]) => ({ ...r, installationId: "TEST-other" })],
  ])("refuses %s with nothing staged and nothing published", (_name, change) => {
    const request = seed(); const run = input(change(request));
    expect(() => commitInstallationSuccessor(run)).toThrow("hosted_installation_successor_held:predecessor_pins");
    nothingStaged(); expect(run.store.publish).not.toHaveBeenCalled();
    expect(mocks.verify).not.toHaveBeenCalled(); // stale pins never reach the candidate census
  });

  it("refuses an activation that is not CLOSED, one with a reserved (active) start, and one of another boot - nothing is suppressed", () => {
    for (const [over, reason] of [
      [{ phase: HostedActivationPhase.Ordinary }, "predecessor_not_closed"],
      [{ ordinaryStarts: [{ ...terminalStart, state: "reserved" }] }, "predecessor_not_closed"],
      [{ bootId: "44444444-4444-4444-4444-444444444444" }, "predecessor_session"],
    ] as const) {
      const request = seed({ activation: over }); const run = input(request);
      expect(() => commitInstallationSuccessor(run)).toThrow(`hosted_installation_successor_held:${reason}`);
      nothingStaged(); expect(run.store.publish).not.toHaveBeenCalled();
    }
  });

  it("refuses a pending publication or recovery (the normal reader refuses it) and a candidate census that is not congruent", () => {
    const request = seed();
    mocks.files.set("host-activation.next", Buffer.from("{}"));
    expect(() => commitInstallationSuccessor(input(request))).toThrow("hosted_activation_publication_recovery_required");
    nothingStaged();
    seed();
    const extra = candidateInventory({ borrowed: ["fixture-1.service", "fixture-2.service", "fixture-3.service"] });
    expect(() => commitInstallationSuccessor(input(request, {}, extra))).toThrow("hosted_installation_successor_invalid");
    nothingStaged();
  });

  // The candidate is refused BEFORE any record is staged or selected when its bytes are not a valid inventory or its creator
  // launch changed (the candidate census above only runs after these parsers and the congruence check hold).
  it("refuses candidate bytes that are not a valid inventory, and a candidate whose creator launch changed, before any record exists", () => {
    const request = seed();
    const invalid = input(request, { candidateBytes: Buffer.from('{"schemaVersion":5}\n') });
    expect(() => commitInstallationSuccessor(invalid)).toThrow();
    nothingStaged(); expect(invalid.store.publish).not.toHaveBeenCalled(); expect(mocks.operatorSession).not.toHaveBeenCalled();
    const changed = candidateInventory({ launchTamper: l => ({ ...l, args: l.args.map((a, i) => i === 4 ? '{"goal":"another"}' : a) }) });
    const run = input(request, {}, changed);
    expect(() => commitInstallationSuccessor(run)).toThrow("hosted_installation_successor_invalid");
    nothingStaged(); expect(run.store.publish).not.toHaveBeenCalled();
  });

  it("refuses a runtime that is not the staged artifact", () => {
    const request = seed();
    mocks.files.set("stage", encoded({ schemaVersion: 1, ...NEW_RUNTIME, runtimeSha: "6".repeat(40) }));
    expect(() => commitInstallationSuccessor(input(request))).toThrow("hosted_installation_successor_held:runtime_stage");
    nothingStaged();
  });

  it("a crash before the activation publication leaves inert staged records: no reader selects them, the predecessor stays selected, and a repeat does not overwrite", () => {
    const request = seed();
    const run = input(request);
    (run.store.publish as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error("TEST_crash_before_rename"); });
    expect(() => commitInstallationSuccessor(run)).toThrow("TEST_crash_before_rename");
    const staged = [...mocks.writes];
    expect(staged).toHaveLength(3);
    // Nothing selects the staged records: the selected readers still return the predecessor.
    expect(commitSelected("readonly-inventory.json").equals(oldInventoryBytes)).toBe(true);
    // The same operation cannot be consumed twice: the selection directory already exists, nothing is rewritten.
    expect(() => commitInstallationSuccessor(input(request))).toThrow("EEXIST");
    expect(mocks.writes).toEqual(staged);
  });
});

/** The selection transition, re-validated also on recovery: every wrong chain, pin or identity refuses. */
describe("installation successor: selection transition re-validation (first publication and recovery)", () => {
  function staged() {
    const request = seed(); const run = input(request);
    (run.store.publish as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => undefined); // stage everything, publish nothing
    // Nothing was published, so the final re-read through the normal readers truthfully refuses the (unselected) world.
    expect(() => commitInstallationSuccessor(run)).toThrow("hosted_installation_successor_held:selected_world");
    const prior = parseHostedActivation(JSON.parse(mocks.files.get("host-activation.json")!.toString()));
    const selectionName = mocks.writes.find(name => /^installation-successors\/[a-f0-9]{64}\.json$/.test(name))!;
    const selection = selectionName.replace(/^installation-successors\//, "").replace(/\.json$/, "");
    const next = { ...prior, generation: prior.generation + 1, supervisorId: "300:400", installationSelectionSha256: selection };
    return { prior, next, selection };
  }

  it("accepts the exact staged successor as the immediate transition", () => {
    const { prior, next } = staged();
    expect(() => assertHostedActivationSuccessor(prior, parseHostedActivation(next))).not.toThrow();
    expect(() => assertInstallationSelectionTransition(prior, parseHostedActivation(next))).not.toThrow();
  });

  type Staged = ReturnType<typeof staged>;
  const cases: [string, (s: Staged) => Record<string, unknown>, string][] = [
    ["an activation that changed after staging (stale predecessor pin)", s => {
      mocks.files.set("host-activation.json", encoded({ ...s.prior, ordinaryOriginsSha256: successorDigest("5") })); return s.next; }, "predecessor_pins"],
    ["a successor session that is not the staged supervisor", s => ({ ...s.next, supervisorId: "301:401" }), "session"],
    ["a successor of another boot", s => ({ ...s.next, bootId: "44444444-4444-4444-4444-444444444444" }), "session"],
    ["a selection record that does not exist", s => ({ ...s.next, installationSelectionSha256: successorDigest("0") }), "selection_record"],
    ["a staged inventory whose bytes changed", s => {
      mocks.files.set(`installation-successors/${s.selection}/readonly-inventory.json`, Buffer.from("{}")); return s.next; }, "successor_files"],
  ];
  it.each(cases)("refuses %s", (_name, change, reason) => {
    const s = staged(); const next = parseHostedActivation(change(s));
    expect(() => assertInstallationSelectionTransition(s.prior, next)).toThrow(`hosted_installation_selection_invalid:${reason}`);
  });

  it("refuses a chain that skips the first generation and a removed selection", () => {
    const s = staged();
    const second = { ...s.next, generation: s.prior.generation + 2 };
    expect(() => assertHostedActivationSuccessor(s.prior, parseHostedActivation(second))).toThrow();
    // The guard never lets a selection disappear or move without a new session and a CLOSED/terminal prior.
    const selected = parseHostedActivation(s.next);
    expect(() => assertHostedActivationSuccessor(selected, parseHostedActivation({ ...s.prior, generation: selected.generation + 1, supervisorId: "500:600" }))).toThrow("hosted_activation_invalid");
    expect(() => assertHostedActivationSuccessor(s.prior, parseHostedActivation({ ...s.next, supervisorId: s.prior.supervisorId }))).toThrow("hosted_activation_invalid");
    expect(() => assertHostedActivationSuccessor(s.prior, parseHostedActivation({ ...s.next, ordinaryStarts: [{ ...terminalStart, state: "reserved" }] }))).toThrow("hosted_activation_invalid");
  });

  it("an activation that selects nothing keeps its exact original bytes (the key is emitted only when selecting)", () => {
    const plain = activation();
    expect(Object.keys(parseHostedActivation(plain))).not.toContain("installationSelectionSha256");
    expect(() => parseHostedActivation({ ...plain, installationSelectionSha256: "not-a-digest" })).toThrow("hosted_activation_invalid");
  });
});

/** What every reader sees: the real selection resolver over the in-memory records (not a path computed by this test). */
function commitSelected(name: "host-installation.json" | "readonly-inventory.json"): Buffer {
  return readHostedActivationBytes(name)!;
}
