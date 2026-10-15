import { describe, expect, it } from "vitest";
import { writeHostedTestEgressGrant, type HostedDependencyReferenceEnrollment } from "../hosted-test-egress-files";
import type { HostedTestEgressGrant } from "../hosted-test-egress-contract";
import { HostedDependencyReferenceKind } from "../../provider-codex/app-server/adapters/hosted-dependency-workspace";
import type { DependencyToolRegistration } from "../../core/dependency-environment/dependency-tool-profile";

// A regression that interprets caller getters/proxies or ignores the new
// finite selection reaches the grant/operator boundary and fails this test.
// No filesystem/operator is mocked and no positive host authority is claimed.
describe("original reference issuer selection before privileged effects", () => {
  it("refuses proxy, accessor, inherited and extra authority fields without invoking caller code", async () => {
    let calls = 0;
    const trap = () => { calls++; throw new Error("TEST caller code must not run"); };
    const grant = new Proxy({}, { get: trap }) as HostedTestEgressGrant;
    const candidateJobId = "TEST-os-11111111-1111-4111-8111-111111111111";
    const kind = HostedDependencyReferenceKind.LegacyLocalNoLifecycleV1;
    const accessor = Object.defineProperty({ kind }, "candidateJobId", { get: trap, enumerable: true });
    const inherited = Object.create({ candidateJobId, kind }) as unknown;
    for (const reference of [
      new Proxy({}, { get: trap, getPrototypeOf: trap, ownKeys: trap }), accessor, inherited,
      { candidateJobId, kind, operationId: "11111111-1111-4111-8111-111111111111" },
      { candidateJobId, kind, toolProfile: {} }, { candidateJobId, kind, [Symbol("extra")]: true },
    ]) {
      await expect(writeHostedTestEgressGrant(grant, undefined, reference as HostedDependencyReferenceEnrollment))
        .rejects.toThrow("hosted_dependency_reference_fresh_closed_enrollment_required");
    }
    expect(calls).toBe(0);
  });
  it("refuses mixing tool publication with reference enrollment before grant or operator access", async () => {
    let calls = 0;
    const grant = new Proxy({}, { get() { calls++; throw new Error("TEST unreachable grant"); } }) as HostedTestEgressGrant;
    await expect(writeHostedTestEgressGrant(grant, {} as DependencyToolRegistration, {
      candidateJobId: "TEST-os-11111111-1111-4111-8111-111111111111",
      kind: HostedDependencyReferenceKind.LegacyLocalNoLifecycleV1,
    })).rejects.toThrow("hosted_dependency_reference_fresh_closed_enrollment_required");
    expect(calls).toBe(0);
  });
});
