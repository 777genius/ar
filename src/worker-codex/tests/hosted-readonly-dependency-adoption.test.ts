import { describe, expect, it } from "vitest";
import { parseHostedReadonlyDependencyAdoptionIntent } from "../hosted-readonly-dependency-adoption";

const id = "00000000-0000-4000-8000-000000000001";
const ref = (path: string) => ({ path, identity: { dev: "1", ino: "42" }, sha256: "a".repeat(64) });
const value = { version: 1, operationId: id, candidateJobId: "TEST-C",
  candidateReady: ref("/var/lib/subscription-runtime-host-policy/dependency-receipt-history/1-42.ready.json"),
  policyInput: ref("/var/lib/subscription-runtime-host-policy/readonly-dependency-adoptions/" + id + ".policy.json"),
  maintenance: { operationId: id, epoch: 3, host: { installationId: id, bootId: id, runtimeSha: "b".repeat(40),
    inventoryDigest: "c".repeat(64), grantDigest: "d".repeat(64), supervisorId: "123:456" } } };

// Red if a future/hash-cycle grant or caller approval becomes an accepted
// intent, or nested accessors run before descriptor refusal. Data validation
// never asserts actual reference/owner/host authority or completed adoption.
describe("readonly dependency adoption intent data", () => {
  it("retains only already published references and detached maintenance facts", () => {
    const parsed = parseHostedReadonlyDependencyAdoptionIntent(value);
    expect(parsed).toEqual(value); expect(parsed).not.toBe(value); expect(parsed.maintenance).not.toBe(value.maintenance);
  });
  it("refuses implicit permit, foreign future path, wrong operation and incomplete host facts", () => {
    for (const changed of [{ approved: true }, { futureGrant: ref("/future/grant.json") },
      { policyInput: ref(value.policyInput.path + ".copy") }, { maintenance: { ...value.maintenance, operationId: "other" } },
      { maintenance: { ...value.maintenance, host: { ...value.maintenance.host, grantDigest: "secret" } } },
      { maintenance: { ...value.maintenance, epoch: 0 } }]) {
      expect(() => parseHostedReadonlyDependencyAdoptionIntent({ ...value, ...changed })).toThrow("hosted_readonly_dependency_adoption_held");
    }
  });
  it("refuses discriminant, attempt and host accessors without evaluating any", () => {
    let calls = 0;
    const accessor = (object: object,key: string) => Object.defineProperty({ ...object },key,
      { enumerable: true, get() { calls++; throw new Error("TEST getter evaluated"); } });
    for (const malformed of [accessor(value,"version"), { ...value, maintenance: accessor(value.maintenance,"epoch") },
      { ...value, maintenance: { ...value.maintenance, host: accessor(value.maintenance.host,"grantDigest") } }]) {
      expect(() => parseHostedReadonlyDependencyAdoptionIntent(malformed)).toThrow("hosted_readonly_dependency_adoption_held");
    }
    expect(calls).toBe(0);
  });
});
