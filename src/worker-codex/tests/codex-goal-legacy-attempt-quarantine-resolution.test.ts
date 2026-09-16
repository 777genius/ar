import { describe, expect, it, vi } from "vitest";
import type { ConsumedOutputLedgerEpochReceipt } from
  "@vioxen/subscription-runtime/worker-core";
import {
  resolveEpochAnchoredLegacyAttemptQuarantine,
  resolveLegacyAttemptQuarantine,
} from
  "../application/project-control/codex-goal-legacy-attempt-quarantine-resolution";

describe("legacy attempt quarantine resolution", () => {
  it("uses immutable epoch custody after switch without touching stale live CAS", async () => {
    const anchor = {
      schemaVersion: 1 as const,
      planSha256: "1".repeat(64),
      quarantineRootSha256: "2".repeat(64),
      receiptSha256: "3".repeat(64),
      attemptCount: 1,
      reconciliationEvidenceBoundCount: 0,
      unresolvedEvidenceQuarantineCount: 1,
    };
    const readLive = vi.fn(async () => {
      throw new Error("stale_controller_registry_cas");
    });
    const readStable = vi.fn(async () => ({
      attemptIds: new Set(["legacy-attempt"]),
      debt: [{
        attemptId: "legacy-attempt",
        status: "opened",
        disposition: "unresolved_evidence_quarantine",
        planSha256: anchor.planSha256,
      }],
    }));
    const result = await resolveLegacyAttemptQuarantine({
      controllerJobRootDir: "/controller",
      scope: {
        projectId: "project",
        consumedOutputLedgerRoots: ["/active-epoch"],
      },
      deps: {
        resolveEpochReceipt: async () => ({
          legacyAttemptQuarantine: anchor,
        } as ConsumedOutputLedgerEpochReceipt),
        readStable,
        readLive,
      },
    });
    expect([...result.attemptIds]).toEqual(["legacy-attempt"]);
    expect(readStable).toHaveBeenCalledWith("/controller", anchor);
    expect(readLive).not.toHaveBeenCalled();
  });

  it("keeps unrelated pre-epoch work on live validation", async () => {
    const readLive = vi.fn(async () => ({
      attemptIds: new Set<string>(),
      debt: [],
    }));
    await expect(resolveLegacyAttemptQuarantine({
      controllerJobRootDir: "/controller",
      scope: { projectId: "project", consumedOutputLedgerRoots: ["/old"] },
      deps: {
        resolveEpochReceipt: async () => {
          const error = new Error("missing");
          Object.assign(error, { code: "ENOENT" });
          throw error;
        },
        resolvePendingEpochPlan: async () => undefined,
        readLive,
      },
    })).resolves.toMatchObject({ debt: [] });
    expect(readLive).toHaveBeenCalledOnce();
  });

  it("does not classify a live pre-epoch receipt as immutable custody", async () => {
    await expect(resolveEpochAnchoredLegacyAttemptQuarantine({
      controllerJobRootDir: "/controller",
      scope: { projectId: "project", consumedOutputLedgerRoots: ["/old"] },
      deps: {
        resolveEpochReceipt: async () => {
          const error = new Error("missing");
          Object.assign(error, { code: "ENOENT" });
          throw error;
        },
        resolvePendingEpochPlan: async () => undefined,
        readStable: async () => {
          throw new Error("stable custody must not be read");
        },
      },
    })).resolves.toBeUndefined();
  });
});
