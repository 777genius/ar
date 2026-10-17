import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { researchAdmissionObservation, ResearchAdmissionFailureStage as Stage } from "../research-launch-admission-diagnostics";
import { beginMimoProjectStartControlTiming, createMimoProjectStartControlTiming, measureMimoProjectStartControlTiming,
  mimoProjectStartControlReceipt, MimoProjectStartControlTimingScope as Scope } from "../research-launch-admission-diagnostics";
import { researchInvalid, ResearchHostCommandOperation as Operation, ResearchHostCommandUnitRole as Role } from "../research-launch-files";
const state = vi.hoisted(() => ({ writes: [] as unknown[], changed: false, failWrite: false }));
vi.mock("../research-launch-files", async importOriginal => {
  const actual = await importOriginal<typeof import("../research-launch-files")>();
  return { ...actual, researchRead: (path: string) => Buffer.from(state.changed ? "changed" : path.endsWith("spec.json")
    ? '{"startId":"TEST-start","unit":"TEST-runtime"}' : "TEST-binding"),
  researchPublish: (_path: string, value: unknown) => { if (state.failWrite) throw new Error("TEST-write-secret"); state.writes.push(value); } };
});
const make = () => researchAdmissionObservation("/TEST-private-start", Buffer.from('{"startId":"TEST-start","unit":"TEST-runtime"}'), Buffer.from("TEST-binding"));
function refusal(): unknown {
  try { researchInvalid("host-command-timeout", Operation.SystemctlShow, Role.Runtime, 30001); }
  catch (error) { return error; }
}
beforeEach(() => { state.writes = []; state.changed = false; state.failWrite = false; });
afterEach(() => vi.restoreAllMocks());
it("retains only identity-bound finite command evidence and the innermost stage, preserving the thrown identity", () => {
  const observe = make(), error = refusal();
  Object.assign(error as object, { secret: "TEST-secret", operation: "caller-command", stack: "TEST-secret" });
  let caught: unknown;
  try { observe(Stage.MaterialCurrent, () => observe(Stage.AuthorityCurrent, () => { throw error; })); } catch (failure) { caught = failure; }
  expect(caught).toBe(error);
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0]).toMatchObject({ schemaVersion: 1, startId: "TEST-start", runtimeUnit: "TEST-runtime", stage: Stage.AuthorityCurrent,
    hostCommand: { operation: Operation.SystemctlShow, unitRole: Role.Runtime, elapsedMs: 30001 } });
  expect(Object.keys(state.writes[0] as object).sort()).toEqual(["bindingSha256", "hostCommand", "runtimeUnit", "schemaVersion", "specSha256", "stage", "startId"]);
  expect(JSON.stringify(state.writes)).not.toContain("TEST-secret");
  expect(JSON.stringify(state.writes)).not.toContain("caller-command");
});
it("ignores spoofed error properties and successful admission", () => {
  const observe = make(), error = Object.assign(new Error("host-command-timeout"), { operation: Operation.SystemctlShow, unitRole: Role.Runtime, elapsedMs: 30000 });
  expect(observe(Stage.AuthorityCurrent, () => 42)).toBe(42);
  expect(() => observe(Stage.AuthorityCurrent, () => { throw error; })).toThrow(error);
  expect(state.writes).toEqual([]);
});
it("cannot publish against replaced start bytes and cannot replace denial when publication fails", () => {
  const observe = make(), error = refusal(); state.changed = true;
  expect(() => observe(Stage.AuthorityCurrent, () => { throw error; })).toThrow(error as Error);
  expect(state.writes).toEqual([]);
  state.changed = false; state.failWrite = true;
  expect(() => observe(Stage.AuthorityCurrent, () => { throw error; })).toThrow(error as Error);
  expect(state.writes).toEqual([]);
});
it("times Promise settlement, preserving the returned closure and original rejection/finally", async () => {
  let now = 1; vi.spyOn(process, "uptime").mockImplementation(() => now);
  const observe = vi.fn(), authority = vi.fn(() => 42);
  let release!: (value: typeof authority) => void;
  const result = measureMimoProjectStartControlTiming(Scope.BrokerStart, () => new Promise(resolve => { release = resolve; }), observe);
  expect(observe).not.toHaveBeenCalled(); now = 3; release(authority);
  expect(await result).toBe(authority); expect(authority).not.toHaveBeenCalled();
  expect(observe).toHaveBeenLastCalledWith(Scope.BrokerStart, 2000);
  const error = new Error("TEST original"), cleanup = vi.fn();
  await expect(measureMimoProjectStartControlTiming(Scope.BrokerStart, async () => {
    try { throw error; } finally { cleanup(); }
  }, () => { throw new Error("TEST observer fault"); })).rejects.toBe(error);
  expect(cleanup).toHaveBeenCalledOnce();
});
it("keeps clock failures and backward readings inert and finishes fence acquisition only at callback entry", async () => {
  const clock = vi.spyOn(process, "uptime").mockReturnValueOnce(1).mockReturnValueOnce(2), observe = vi.fn();
  const entered = beginMimoProjectStartControlTiming(Scope.WorkstreamFenceAcquire, observe);
  expect(observe).not.toHaveBeenCalled(); entered(); expect(observe).toHaveBeenCalledWith(Scope.WorkstreamFenceAcquire, 1000);
  for (const clockValue of [NaN, Infinity, -1, 86401, null, false, "1"]) {
    clock.mockReturnValue(clockValue as number);
    await expect(measureMimoProjectStartControlTiming(Scope.BrokerStart, async () => 42, observe)).resolves.toBe(42);
    expect(createMimoProjectStartControlTiming().snapshot()).toBeUndefined();
  }
  clock.mockImplementation(() => { throw new Error("TEST clock fault"); });
  await expect(measureMimoProjectStartControlTiming(Scope.BrokerStart, async () => 42, observe)).resolves.toBe(42);
  clock.mockReturnValueOnce(3).mockReturnValueOnce(1); observe.mockClear();
  await measureMimoProjectStartControlTiming(Scope.BrokerStart, async () => 42, observe); expect(observe).not.toHaveBeenCalled();
});
it("keeps three pre-broker observations disjoint from the inclusive broker and omits incomplete or overlapping residuals", () => {
  vi.spyOn(process, "uptime").mockReturnValue(1);
  const timing = createMimoProjectStartControlTiming();
  timing.observe(Scope.WorkstreamFenceAcquire, 10); timing.observe(Scope.RuntimeSelectionAndImport, 20);
  timing.observe(Scope.PreBrokerObservation, 1); timing.observe(Scope.PreBrokerObservation, 2);
  timing.observe(Scope.BrokerStart, 100);
  expect(timing.snapshot()).not.toHaveProperty("unattributedElapsedMsAtReceipt");
  timing.observe(Scope.PreBrokerObservation, 3);
  expect(timing.snapshot()).toMatchObject({ processElapsedMsAtReceipt: 1000, preBrokerObservationElapsedMs: 6, brokerStartElapsedMs: 100, unattributedElapsedMsAtReceipt: 864 });
  timing.observe(Scope.PreBrokerObservation, 4);
  expect(timing.snapshot()).not.toHaveProperty("preBrokerObservationElapsedMs");
  expect(timing.snapshot()).not.toHaveProperty("unattributedElapsedMsAtReceipt");
  const overlaps = createMimoProjectStartControlTiming();
  overlaps.observe(Scope.WorkstreamFenceAcquire, 600); overlaps.observe(Scope.RuntimeSelectionAndImport, 600);
  for (let i = 0; i < 3; i++) overlaps.observe(Scope.PreBrokerObservation, 1);
  overlaps.observe(Scope.BrokerStart, 1); expect(overlaps.snapshot()).not.toHaveProperty("unattributedElapsedMsAtReceipt");
});
it("decorates only applied inner success, preserves refusal bytes and response limit, and never re-evaluates handler accessors", () => {
  vi.spyOn(process, "uptime").mockReturnValue(1); const timing = createMimoProjectStartControlTiming();
  for (const value of [{ ok: false, error: "protected_job_birth_publication_busy" }, { ok: true, result: { ok: false, error: "TEST_refusal" } },
    { ok: true, result: { ok: true, mode: "project_control_stop", result: { status: "applied" } } }]) {
    const wire = JSON.stringify(value) + "\n"; expect(mimoProjectStartControlReceipt(wire, timing)).toBe(wire);
  }
  const getter = vi.fn(() => "project_control_start");
  const wire = JSON.stringify({ ok: true, result: { ok: true, get mode() { return getter(); }, result: { status: "applied" } } }) + "\n";
  const decorated = JSON.parse(mimoProjectStartControlReceipt(wire, timing));
  expect(decorated.result.controlTiming).toMatchObject({ schemaVersion: 1, kind: "owned-start", clock: "process-uptime", processElapsedMsAtReceipt: 1000 });
  expect(getter).toHaveBeenCalledOnce();
  const prefix = JSON.stringify({ ok: true, result: { ok: true, mode: "project_control_start", result: { status: "applied" }, padding: "" } }) + "\n";
  const full = prefix.replace('"padding":""', '"padding":"' + "a".repeat(1048576 - Buffer.byteLength(prefix)) + '"');
  expect(Buffer.byteLength(full)).toBe(1048576); expect(mimoProjectStartControlReceipt(full, timing)).toBe(full);
});
