import { beforeEach, expect, it, vi } from "vitest";
import { researchAdmissionObservation, ResearchAdmissionFailureStage as Stage } from "../research-launch-admission-diagnostics";
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
