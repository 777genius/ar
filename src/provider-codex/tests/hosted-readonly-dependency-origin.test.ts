import { describe, expect, it } from "vitest";
import { parseHostedReadonlyDependencyStart, readonlyDependencyAssociationName, readonlyDependencyStartName } from "../app-server/adapters/hosted-dependency-origin";

const id = "00000000-0000-4000-8000-000000000001";
const jobRootDir = "/var/lib/subscription-runtime-host-policy/dependency-test-jobs/jobs/TEST-C";
const workspace = { canonicalPath: jobRootDir + "/workspace", dev: "1", ino: "42" };
const value = { version: 1, installationId: id, runtimeSha: "a".repeat(40), inventoryDigest: "b".repeat(64),
  hostId: "c".repeat(32), bootId: id, supervisorId: "123:456", generation: 7, startId: id, creatorId: id,
  unit: "subscription-runtime-outer-" + id + ".service", candidateJobId: "TEST-C", readonlyJobId: "TEST-R", jobRootDir, workspace,
  association: { path: "/var/lib/subscription-runtime-host-policy/readonly-dependency-bindings/1-42.json",
    identity: { dev: "1", ino: "43" }, sha256: "d".repeat(64) }, grantDigest: "e".repeat(64), policyDigest: "f".repeat(64),
  reviewDigest: "0".repeat(64), stageDigest: "1".repeat(64), leaseDigest: "2".repeat(64) };

// Data-only independent transport contract. Red if R/C identities collapse,
// managed provider/ordinary units substitute for actual outer, or physical
// association naming is detached from the exact selected workspace.
describe("readonly dependency per-start transport", () => {
  it("preserves distinct logical candidate and actual custody while detaching data", () => {
    const parsed = parseHostedReadonlyDependencyStart(value);
    expect(parsed).toEqual(value); expect(parsed).not.toBe(value); expect(parsed.workspace).not.toBe(value.workspace);
    expect(readonlyDependencyAssociationName(workspace)).toBe("readonly-dependency-bindings/1-42.json");
    expect(readonlyDependencyStartName(id)).toBe("readonly-dependency-starts/" + id + ".json");
  });
  it("rejects wrong role, stale name, foreign root, physical association and implicit authority", () => {
    for (const changed of [{ unit: "subscription-runtime-hosted-" + id + ".service" },
      { unit: "subscription-runtime-ordinary-" + id + ".service" }, { creatorId: "other" }, { readonlyJobId: "TEST-C" },
      { jobRootDir: jobRootDir + "-copy" }, { workspace: { ...workspace, ino: "44" } },
      { association: { ...value.association, path: value.association.path + "-copy" } },
      { generation: 0 }, { grantDigest: "credential" }, { admitted: true }]) {
      expect(() => parseHostedReadonlyDependencyStart({ ...value, ...changed })).toThrow("hosted_readonly_dependency_origin_unresolved");
    }
  });
  it("rejects own and nested accessors before evaluating them", () => {
    let calls = 0;
    const accessor = (object: object, key: string) => Object.defineProperty({ ...object },key,
      { enumerable: true, get() { calls++; throw new Error("TEST getter evaluated"); } });
    for (const malformed of [accessor(value,"version"), { ...value, workspace: accessor(workspace,"dev") },
      { ...value, association: accessor(value.association,"sha256") }, { ...value, [Symbol("TEST-hidden")]: true }]) {
      expect(() => parseHostedReadonlyDependencyStart(malformed)).toThrow("hosted_readonly_dependency_origin_unresolved");
    }
    expect(calls).toBe(0);
  });
});
