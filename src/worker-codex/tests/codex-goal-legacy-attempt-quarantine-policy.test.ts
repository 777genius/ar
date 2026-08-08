import { describe, expect, it } from "vitest";
import type { StaleIntegrationReconciliationEntry } from
  "../application/project-control/codex-goal-stale-integration-reconciliation";
import {
  assertLegacyAttemptQuarantineIncidentPolicy,
  legacyAttemptQuarantineDispositionCounts,
} from
  "../application/project-control/codex-goal-legacy-attempt-quarantine-policy";

describe("legacy attempt quarantine incident policy", () => {
  const now = new Date("2026-08-10T00:00:00.000Z");

  it("accepts the exact audited 2 evidence-bound / 15 unresolved shape", () => {
    const entries = auditedEntries();
    expect(() => assertLegacyAttemptQuarantineIncidentPolicy({
      entries,
      cutoff: "2026-08-08T00:00:00.000Z",
      now,
    })).not.toThrow();
    expect(legacyAttemptQuarantineDispositionCounts(entries)).toEqual({
      attemptCount: 17,
      reconciliationEvidenceBoundCount: 2,
      unresolvedEvidenceQuarantineCount: 15,
    });
  });

  it.each([
    ["2026-08-11T00:00:00.000Z", "future"],
    ["2026-08-09T12:00:00.000Z", "fresh"],
  ])("rejects a %s cutoff", (cutoff) => {
    expect(() => assertLegacyAttemptQuarantineIncidentPolicy({
      entries: auditedEntries(),
      cutoff,
      now,
    })).toThrow("legacy_attempt_quarantine_cutoff_not_stable");
  });

  it("rejects refusal classes outside the audited incident allowlist", () => {
    const entries = auditedEntries();
    entries[2] = entry(false, "target_workspace_out_of_scope", 2);
    expect(() => assertLegacyAttemptQuarantineIncidentPolicy({
      entries,
      cutoff: "2026-08-08T00:00:00.000Z",
      now,
    })).toThrow("legacy_attempt_quarantine_refusal_not_allowed");
  });

  it.each([16, 18])("rejects an incident with %i attempts", (count) => {
    const entries = auditedEntries();
    if (count === 16) entries.pop();
    else entries.push(entry(false, "patch_outside_reviewed_store", 17));
    expectPolicyFailure(entries, "legacy_attempt_quarantine_incident_count_mismatch");
  });

  it.each([1, 3, 17])("rejects an incident with %i eligible attempts", (count) => {
    const entries = auditedEntries();
    for (let index = 0; index < entries.length; index += 1) {
      entries[index] = entry(index < count, index < count
        ? undefined
        : refusalForIndex(index - count), index);
    }
    expectPolicyFailure(entries, "legacy_attempt_quarantine_eligible_count_mismatch");
  });

  it.each([
    ["target_workspace_dirty", "attempt_patch_partial_or_ambiguous"],
    ["attempt_patch_partial_or_ambiguous", "patch_outside_reviewed_store"],
    ["patch_outside_reviewed_store", "target_workspace_dirty"],
  ])("rejects refusal distribution drift from %s to %s", (from, to) => {
    const entries = auditedEntries();
    const index = entries.findIndex((item) => item.refusalReason === from);
    entries[index] = entry(false, to, index);
    expectPolicyFailure(
      entries,
      "legacy_attempt_quarantine_refusal_distribution_mismatch",
    );
  });
});

function auditedEntries(): StaleIntegrationReconciliationEntry[] {
  return [
    entry(true, undefined, 0),
    entry(true, undefined, 1),
    ...Array.from({ length: 3 }, (_, index) =>
      entry(false, "target_workspace_dirty", index + 2)),
    ...Array.from({ length: 7 }, (_, index) =>
      entry(false, "attempt_patch_partial_or_ambiguous", index + 5)),
    ...Array.from({ length: 5 }, (_, index) =>
      entry(false, "patch_outside_reviewed_store", index + 12)),
  ];
}

function refusalForIndex(index: number): string {
  if (index < 3) return "target_workspace_dirty";
  if (index < 10) return "attempt_patch_partial_or_ambiguous";
  return "patch_outside_reviewed_store";
}

function expectPolicyFailure(
  entries: readonly StaleIntegrationReconciliationEntry[],
  code: string,
): void {
  expect(() => assertLegacyAttemptQuarantineIncidentPolicy({
    entries,
    cutoff: "2026-08-08T00:00:00.000Z",
    now: new Date("2026-08-10T00:00:00.000Z"),
  })).toThrow(code);
}

function entry(
  eligible: boolean,
  refusalReason?: string,
  index = 0,
): StaleIntegrationReconciliationEntry {
  return {
    attemptId: `attempt-${index}-${eligible}-${refusalReason ?? "eligible"}`,
    attemptPath: "/tmp/fixture/attempt.json",
    attemptSha256: "a".repeat(64),
    status: "opened",
    targetWorkspacePath: "/tmp/fixture/target",
    targetRemote: "origin",
    targetBranch: "main",
    eligible,
    ...(refusalReason ? { refusalReason } : {}),
  };
}
