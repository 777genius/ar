import { describe, expect, it } from "vitest";
import { CodexProviderEgressProfileId } from "../codex-provider-egress-policy";
import { collectHostedOrdinaryProcessOriginFacts, type HostedOrdinaryProcessOriginFacts } from "../app-server/adapters/hosted-process-activation";
import { formHostedOrdinarySelectedParentLineageFacts, assertSameHostedOrdinarySelectedParentLineageFacts } from "../app-server/adapters/hosted-ordinary-selected-lineage-facts";

// Pure comparison fixtures, not positive operator/FDA/root-purpose simulation.
// A regression is hashing the mutable whole activation, ignoring a selected
// parent's changed birth/start, or allowing generation regression/terminal use.
function facts(): HostedOrdinaryProcessOriginFacts {
  const reservation = { startId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", unit: "subscription-runtime-ordinary-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.service",
    creatorId: "creator-1", originSha256: "a".repeat(64), generation: 2, state: "reserved" };
  return { installation: { schemaVersion: 1, installationId: "installation-1", hostId: "host-1", runtimeDirectory: "/opt/runtime",
      runtimeSha: "a".repeat(40), runtimeManifestSha256: "b".repeat(64), inventorySha256: "c".repeat(64) },
    activation: { schemaVersion: 1, installationId: "installation-1", hostId: "host-1", bootId: "boot-1", supervisorId: "supervisor-1",
      generation: 2, phase: "ORDINARY", ordinaryOriginsSha256: "d".repeat(64), exclusiveEnrollmentSha256: null, ordinaryStarts: [reservation] },
    start: { schemaVersion: 1, installationId: "installation-1", jobId: "job-1", jobRootDir: "/jobs/job-1", workspacePath: "/jobs/job-1/workspace",
      activationGeneration: 2, bootId: "boot-1", supervisorId: "supervisor-1", originSha256: reservation.originSha256,
      unit: reservation.unit, controlGroup: "/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/" + reservation.unit,
      creatorId: "creator-1", creatorPidBirth: "100:200", grantSha256: "e".repeat(64) },
    reservation, profileId: CodexProviderEgressProfileId.TestNpmQualification, childBound: false, parentStartSha256: "f".repeat(64) };
}
describe("selected Ordinary parent comparison facts", () => {
  it("allows a fresh provider append and unrelated catalog revision without changing parent lineage", () => {
    const first = facts(), selected = formHostedOrdinarySelectedParentLineageFacts(first);
    const provider = { startId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", unit: "subscription-runtime-hosted-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.service",
      creatorId: "creator-1", originSha256: "a".repeat(64), generation: 3, state: "reserved" };
    const fresh = { ...first, activation: { ...first.activation, generation: 3, ordinaryOriginsSha256: "1".repeat(64),
      ordinaryStarts: [...first.activation.ordinaryStarts, provider] } };
    expect(() => assertSameHostedOrdinarySelectedParentLineageFacts(selected, fresh)).not.toThrow();
    expect(selected.parentGeneration).toBe(2);
    expect(selected.parentStartSha256).toBe("f".repeat(64));
    expect(Object.isFrozen(selected)).toBe(true);
  });
  it("rejects exact start-byte replacement even when all decoded fields are equal", () => {
    const first = facts(), selected = formHostedOrdinarySelectedParentLineageFacts(first);
    expect(() => assertSameHostedOrdinarySelectedParentLineageFacts(selected, { ...first, parentStartSha256: "0".repeat(64) })).toThrow();
  });
  it("rejects a coordinated replacement of selected creator/start/reservation", () => {
    const first = facts(), selected = formHostedOrdinarySelectedParentLineageFacts(first);
    const reservation = { ...first.reservation, creatorId: "replacement" };
    const fresh = { ...first, start: { ...first.start, creatorId: "replacement" }, reservation,
      activation: { ...first.activation, ordinaryStarts: [reservation] } };
    expect(() => assertSameHostedOrdinarySelectedParentLineageFacts(selected, fresh)).toThrow();
  });
  it.each(["missing", "terminal", "duplicate", "changed-row"])("refuses %s current selected reservation", kind => {
    const first = facts(), selected = formHostedOrdinarySelectedParentLineageFacts(first);
    const row = { ...first.reservation, ...(kind === "terminal" ? { state: "terminal" } : kind === "changed-row" ? { generation: 1 } : {}) };
    const ordinaryStarts = kind === "missing" ? [] : kind === "duplicate" ? [row, row] : [row];
    expect(() => assertSameHostedOrdinarySelectedParentLineageFacts(selected, { ...first, activation: { ...first.activation, ordinaryStarts } })).toThrow();
  });
  it.each([1, 0, NaN, 2.5])("refuses invalid/regressed current generation %s", generation => {
    const first = facts(), selected = formHostedOrdinarySelectedParentLineageFacts(first);
    expect(() => assertSameHostedOrdinarySelectedParentLineageFacts(selected, { ...first, activation: { ...first.activation, generation } })).toThrow();
  });
  it("does not make a copied held field into a genuine factual collector fence", () => {
    expect(() => collectHostedOrdinaryProcessOriginFacts({ held: true })).toThrow("hosted_custody_common_fence_required");
  });
});
