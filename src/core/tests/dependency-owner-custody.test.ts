import { describe, expect, it } from "vitest";
import { DependencyConsumerLaunchKind as LaunchKind, type DependencyProtectedReference } from "../dependency-environment/dependency-custody-evidence";
import { DependencyOwnerKind as Kind, DependencyOwnerPhase as Phase, parseDependencyOwner, sameDependencyAttempt,
  type DependencyAttempt } from "../dependency-environment/dependency-owner";

const id = "00000000-0000-4000-8000-000000000001";
const reference = (name: string): DependencyProtectedReference => ({ path: "/TEST-protected/" + name + ".json", identity: { dev: "1", ino: "2" }, sha256: "a".repeat(64) });
const association = reference("association"), origin = reference("actual-start"), transfer = reference("transfer-output");
const ordinary = { installationId: id, bootId: id, runtimeSha: "b".repeat(40), grantDigest: "c".repeat(64), startId: id,
  unit: "subscription-runtime-ordinary-" + id + ".service" };
const managed = { ...ordinary, kind: LaunchKind.ManagedReadonlyLocalV1, association, origin,
  unit: "subscription-runtime-hosted-" + id + ".service" };
const base = { workspace: { canonicalPath: "/TEST/workspace", dev: "1", ino: "3" }, revision: 1, epoch: 1 };
const attempt = { attemptId: id, epoch: 1, launch: managed };
const record = { ...base, version: 3, custodyBinding: association, owner: { kind: Kind.Consumer, phase: Phase.ExclusiveMutation, attempt } };

// Red if old wires accept managed fields, or attempt equality ignores the real
// per-start/association pins. These JSON fixtures are data, not host authority.
describe("closed dependency owner custody wire", () => {
  it("keeps old ordinary wires exact and refuses every new field in v1/v2", () => {
    const legacy = { ...base, version: 1, owner: { phase: Phase.Running, attempt: { ...attempt, launch: ordinary } } };
    const modern = { ...legacy, version: 2, owner: { ...legacy.owner, kind: Kind.Consumer } };
    expect(parseDependencyOwner(legacy)).toEqual(legacy); expect(parseDependencyOwner(modern)).toEqual(modern);
    for (const value of [ { ...legacy, custodyBinding: association }, { ...modern, custodyBinding: association },
      { ...modern, owner: { ...modern.owner, attempt } }, { ...record, version: 2 } ]) expect(() => parseDependencyOwner(value)).toThrow("dependency_admission:invalid_record");
  });
  it("requires real unit/start linkage and closed references for each explicit kind", () => {
    expect(parseDependencyOwner(record)).toEqual(record);
    const successor = { ...record, custodyBinding: transfer,
      owner: { ...record.owner, attempt: { ...attempt, launch: { ...managed, kind: LaunchKind.OrdinaryReadonlySuccessorV1, unit: ordinary.unit } } } };
    expect(parseDependencyOwner(successor)).toEqual(successor);
    const invalidLaunches = [ { ...managed, kind: "other" }, { ...managed, unit: ordinary.unit },
      { ...managed, startId: "00000000-0000-4000-8000-000000000002" }, { ...managed, origin: true },
      { ...managed, origin: { ...origin, authority: true } }, { ...managed, association: transfer },
      { ...managed, kind: LaunchKind.OrdinaryReadonlySuccessorV1, unit: ordinary.unit } ];
    for (const launch of invalidLaunches) expect(() => parseDependencyOwner({ ...record, owner: { ...record.owner, attempt: { ...attempt, launch } } })).toThrow("dependency_admission:invalid_record");
    const { custodyBinding: _binding, ...missing } = record;
    expect(() => parseDependencyOwner(missing)).toThrow("dependency_admission:invalid_record");
  });
  it("retains finite maintenance host facts and rejects running maintenance", () => {
    const maintenance = { ...record, owner: { kind: Kind.Maintenance, phase: Phase.Fenced,
      attempt: { operationId: id, epoch: 1, host: { installationId: id, bootId: id, runtimeSha: ordinary.runtimeSha,
        inventoryDigest: "d".repeat(64), grantDigest: "e".repeat(64), supervisorId: "123:456" } } } };
    expect(parseDependencyOwner(maintenance)).toEqual(maintenance);
    expect(() => parseDependencyOwner({ ...maintenance, owner: { ...maintenance.owner, phase: Phase.Running } })).toThrow("dependency_admission:invalid_record");
    expect(() => parseDependencyOwner({ ...record, [Symbol("TEST-hidden")]: true })).toThrow("dependency_admission:invalid_record");
  });
  it("refuses label and nested accessors before evaluation with normalized errors", () => {
    let evaluated = 0;
    function accessor(value: object, key: string) {
      const copy = { ...value };
      Object.defineProperty(copy, key, { enumerable: true, get() { evaluated++; throw new Error("TEST getter must not run"); } });
      return copy;
    }
    const values = [ accessor(record, "version"), { ...record, owner: accessor(record.owner, "attempt") },
      { ...record, owner: { ...record.owner, attempt: accessor(attempt, "attemptId") } },
      { ...record, activity: { lastEntry: accessor({ epoch: 1, atMs: "100" }, "atMs"), lastRelease: null } } ];
    for (const value of values) expect(() => parseDependencyOwner(value)).toThrow("dependency_admission:invalid_record");
    expect(evaluated).toBe(0);
  });
  it("bounds the complete v3 wire before persistence", () => {
    const large = { ...association, path: "/" + "x".repeat(4000) };
    const value = { ...record, workspace: { ...base.workspace, canonicalPath: "/" + "w".repeat(4000) },
      custodyBinding: large, owner: { ...record.owner, attempt: { ...attempt, launch: { ...managed,
        association: large, origin: { ...origin, path: "/" + "y".repeat(4000) } } } } };
    expect(() => parseDependencyOwner(value)).toThrow("dependency_admission:invalid_record");
  });
  it("detaches data and includes every custody pin in attempt identity", () => {
    const parsed = parseDependencyOwner(record);
    expect(parsed).not.toBe(record); expect(parsed.workspace).not.toBe(record.workspace);
    const changes: DependencyAttempt[] = [ { ...attempt, launch: ordinary },
      { ...attempt, launch: { ...managed, origin: { ...origin, sha256: "f".repeat(64) } } },
      { ...attempt, launch: { ...managed, association: { ...association, identity: { dev: "1", ino: "99" } } } },
      { ...attempt, launch: { ...managed, kind: LaunchKind.OrdinaryReadonlySuccessorV1 } } ];
    expect(sameDependencyAttempt(attempt, { ...attempt })).toBe(true);
    for (const changed of changes) { expect(sameDependencyAttempt(attempt, changed)).toBe(false); expect(sameDependencyAttempt(changed, attempt)).toBe(false); }
  });
});
