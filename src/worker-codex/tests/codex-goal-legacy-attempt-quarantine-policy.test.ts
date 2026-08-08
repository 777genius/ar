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
    const entries = [
      entry(true),
      entry(true),
      ...Array.from({ length: 3 }, () => entry(false, "target_workspace_dirty")),
      ...Array.from({ length: 7 }, () =>
        entry(false, "attempt_patch_partial_or_ambiguous")
      ),
      ...Array.from({ length: 5 }, () =>
        entry(false, "patch_outside_reviewed_store")
      ),
    ];
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
      entries: [entry(true)],
      cutoff,
      now,
    })).toThrow("legacy_attempt_quarantine_cutoff_not_stable");
  });

  it("rejects refusal classes outside the audited incident allowlist", () => {
    expect(() => assertLegacyAttemptQuarantineIncidentPolicy({
      entries: [entry(false, "target_workspace_out_of_scope")],
      cutoff: "2026-08-08T00:00:00.000Z",
      now,
    })).toThrow("legacy_attempt_quarantine_refusal_not_allowed");
  });
});

function entry(
  eligible: boolean,
  refusalReason?: string,
): StaleIntegrationReconciliationEntry {
  return {
    attemptId: `attempt-${eligible}-${refusalReason ?? "eligible"}`,
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
