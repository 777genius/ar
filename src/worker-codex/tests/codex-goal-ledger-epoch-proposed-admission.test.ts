import { describe, expect, it } from "vitest";
import {
  ProjectDebtReason,
  type ConsumedOutputLedgerEpochPlan,
  type ProjectAdmissionSnapshot,
  type ProjectDebtItem,
} from "@vioxen/subscription-runtime/worker-core";
import {
  createOrVerifySocialProposedAdmissionAnchor,
  normalizeAnchoredProposedAdmission,
  SOCIAL_PROPOSED_ADMISSION_PLAN_SHA256,
  type LedgerEpochProposedAdmissionAnchor,
} from "../application/project-control/codex-goal-ledger-epoch-proposed-admission";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifySocialPreparedV1SourceOrphanSeal } from
  "../application/project-control/codex-goal-ledger-epoch-proposed-admission";
import { assertConsumedOutputLedgerEpochAdmissionTransition } from
  "../application/project-control/codex-goal-ledger-epoch-admission-transition";
import { verifyConsumedOutputLedgerEpochProposedAdmissionAnchor } from
  "../application/project-control/codex-goal-consumed-output-ledger-epoch";

describe("Social prepared-v1 proposed-admission anchor", () => {
  it("restricts the transition exception to the exact old debt count", () => {
    expect(() => assertConsumedOutputLedgerEpochAdmissionTransition({
      plan: plan(), before: { debtCount: 1110 }, proposed: proposedSummary(),
    })).not.toThrow();
    expect(() => assertConsumedOutputLedgerEpochAdmissionTransition({
      plan: plan(), before: { debtCount: 1109 }, proposed: proposedSummary(),
    })).toThrow("ledger_epoch_proposed_admission_before_mismatch");
  });

  it("rejects missing and forged structural direct-apply authority", async () => {
    await expect(verifyConsumedOutputLedgerEpochProposedAdmissionAnchor({
      plan: plan(),
    })).rejects.toThrow("ledger_epoch_proposed_admission_verified_anchor_required");

    await expect(verifyConsumedOutputLedgerEpochProposedAdmissionAnchor({
      plan: plan(),
      expectedProposedAdmissionAnchorSha256: "a".repeat(64),
    } as Parameters<typeof verifyConsumedOutputLedgerEpochProposedAdmissionAnchor>[0] &
      { readonly expectedProposedAdmissionAnchorSha256: string })).rejects.toThrow(
      "ledger_epoch_proposed_admission_anchor_missing",
    );
  });

  it("rejects a caller-supplied no-op verifier as direct-apply authority", async () => {
    await expect(verifyConsumedOutputLedgerEpochProposedAdmissionAnchor({
      plan: plan(),
      expectedProposedAdmissionAnchorSha256: "a".repeat(64),
      verifyProposedAdmissionAnchor: async () => {},
    } as Parameters<typeof verifyConsumedOutputLedgerEpochProposedAdmissionAnchor>[0] & {
      readonly verifyProposedAdmissionAnchor: () => Promise<void>;
    })).rejects.toThrow("ledger_epoch_proposed_admission_anchor_missing");
  });

  it("downgrades only exact anchored debt and allows anchored debt to disappear", () => {
    const first = debt(ProjectDebtReason.UnconsumedCompletedJob, "job-1");
    const second = debt(ProjectDebtReason.OrphanLegacyWorkspace, "/work/orphan-1");
    const anchor = anchorFor([first, second]);

    expect(normalizeAnchoredProposedAdmission({
      anchor,
      snapshot: snapshot([first]),
    }).debt).toEqual([{ ...first, severity: "info" }]);

    expect(normalizeAnchoredProposedAdmission({
      anchor,
      snapshot: snapshot([]),
    }).debt).toEqual([]);

    expect(() => normalizeAnchoredProposedAdmission({
      anchor,
      snapshot: snapshot([{ ...first, evidence: ["changed"] }]),
    })).toThrow("ledger_epoch_proposed_admission_new_or_changed_debt");

    expect(() => normalizeAnchoredProposedAdmission({
      anchor,
      snapshot: snapshot([
        first,
        debt(ProjectDebtReason.UnconsumedCompletedJob, "new-job"),
      ]),
    })).toThrow("ledger_epoch_proposed_admission_new_or_changed_debt");

    expect(() => normalizeAnchoredProposedAdmission({
      anchor,
      snapshot: snapshot([{
        ...debt(ProjectDebtReason.LegacyOutputQuarantineRequired, "new-info"),
        severity: "info",
      }]),
    })).toThrow("ledger_epoch_proposed_admission_new_or_changed_debt");
  });

  it("blocks a generic unreadable item even inside the exact count envelope", async () => {
    const blocking = [
      ...many(ProjectDebtReason.UnconsumedCompletedJob, 493),
      ...many(ProjectDebtReason.OrphanLegacyWorkspace, 205),
      ...many(ProjectDebtReason.ActiveWriterConflict, 6),
      ...many(ProjectDebtReason.InactiveDirtyWorkspace, 4),
      {
        ...debt(ProjectDebtReason.UnreadableWorkspace, "/unrelated/unreadable"),
        evidence: [
          "mentions social-monitor-x-attribution-reuse-fixture-integration-v1-20260719",
        ],
      },
    ];
    const info = Array.from({ length: 1738 }, (_, index) => ({
      ...debt(ProjectDebtReason.LegacyOutputQuarantineRequired, `info-${index}`),
      severity: "info" as const,
    }));
    await expect(createOrVerifySocialProposedAdmissionAnchor({
      plan: plan(),
      snapshot: snapshot([...blocking, ...info]),
      summaries: [],
      controllerJobRootDir: "/controller",
      debtCustody: [],
      sourceOrphanSeal: {
        bindings: Array.from({ length: 205 }, (_, index) => ({ index })),
        bindingSha256: Array.from({ length: 205 }, () => "f".repeat(64)),
        bindingsSha256: "c".repeat(64),
      },
      expectedAnchorSha256: "a".repeat(64),
    })).rejects.toThrow(
      "ledger_epoch_proposed_admission_generic_unreadable_blocked",
    );
  });

  it("fails closed around the exact plan-bound 506-record source-orphan seal", async () => {
    const root = await mkdtemp(join(tmpdir(), "proposed-admission-sidecar-"));
    try {
      const sidecar = join(root, ".ledger-epoch-v2-sidecar");
      await mkdir(sidecar);
      const records = plan().orphanWorkspaceBindings
        .map((record) => JSON.stringify(record)).sort()
        .map((record) => JSON.parse(record) as Record<string, unknown>);
      const writeRecord = async (index: number, record: Record<string, unknown>) => {
        await writeFile(join(sidecar,
          `source-orphan-${String(index).padStart(4, "0")}.json`),
        JSON.stringify(record));
      };
      for (const [index, record] of records.entries()) await writeRecord(index, record);
      const intent = { planSha256: SOCIAL_PROPOSED_ADMISSION_PLAN_SHA256 };
      for (const [name, value] of [
        ["intent.json", intent], ["plan.json", {}], ["owner.json", {}],
        ["state.json", {}], ["receipt.json", {}],
      ] as const) await writeFile(join(sidecar, name), JSON.stringify(value));
      const sourceOrphansSha256 = sha256(records.map((record) =>
          JSON.stringify(record)
        ).join("\n"));
      const writeManifest = async (sourceHash: string) => {
        const unsigned = {
          schemaVersion: 2,
          planSha256: SOCIAL_PROPOSED_ADMISSION_PLAN_SHA256,
          sourceOrphansSha256: sourceHash,
          intentSha256: sha256(JSON.stringify(intent)),
        };
        await writeFile(join(sidecar, "manifest.json"), JSON.stringify({
          ...unsigned,
          upgradeSha256: sha256(JSON.stringify(unsigned)),
        }));
      };
      await writeManifest(sourceOrphansSha256);
      const sealed = await verifySocialPreparedV1SourceOrphanSeal({
        ...plan(), newRoot: root,
      });
      expect(sealed.bindingSha256).toHaveLength(506);
      expect(sealed.bindingsSha256).toBe(sourceOrphansSha256);

      await rm(join(sidecar, "source-orphan-0505.json"));
      await expect(verifySocialPreparedV1SourceOrphanSeal({
        ...plan(), newRoot: root,
      })).rejects.toThrow("ledger_epoch_proposed_admission_source_orphan_sidecar_partial");
      await writeRecord(505, records[505]!);

      await writeFile(join(sidecar, "source-orphan-0506.json"), "{}\n");
      await expect(verifySocialPreparedV1SourceOrphanSeal({
        ...plan(), newRoot: root,
      })).rejects.toThrow("ledger_epoch_proposed_admission_source_orphan_sidecar_partial");
      await rm(join(sidecar, "source-orphan-0506.json"));

      await writeRecord(0, {});
      await expect(verifySocialPreparedV1SourceOrphanSeal({
        ...plan(), newRoot: root,
      })).rejects.toThrow("ledger_epoch_proposed_admission_source_orphan_seal_mismatch");
      await writeRecord(0, records[0]!);

      await writeRecord(0, records[1]!);
      await writeRecord(1, records[0]!);
      await expect(verifySocialPreparedV1SourceOrphanSeal({
        ...plan(), newRoot: root,
      })).rejects.toThrow("ledger_epoch_proposed_admission_source_orphan_seal_mismatch");
      await writeRecord(0, records[0]!);
      await writeRecord(1, records[1]!);

      await writeManifest("0".repeat(64));
      await expect(verifySocialPreparedV1SourceOrphanSeal({
        ...plan(), newRoot: root,
      })).rejects.toThrow("ledger_epoch_proposed_admission_source_orphan_seal_mismatch");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function debt(reason: ProjectDebtReason, subject: string): ProjectDebtItem {
  return { reason, subject, severity: "blocking", evidence: [`evidence ${subject}`] };
}

function many(reason: ProjectDebtReason, count: number): readonly ProjectDebtItem[] {
  return Array.from({ length: count }, (_, index) => debt(reason, `${reason}-${index}`));
}

function snapshot(debtItems: readonly ProjectDebtItem[]): ProjectAdmissionSnapshot {
  return {
    schemaVersion: 1,
    projectId: "social-monitor",
    observedAt: new Date(0).toISOString(),
    debt: debtItems,
  };
}

function itemHash(item: ProjectDebtItem): string {
  const canonical = {
    reason: item.reason,
    subject: item.subject,
    evidence: [...item.evidence],
    severity: item.severity ?? "blocking",
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function anchorFor(items: readonly ProjectDebtItem[]): LedgerEpochProposedAdmissionAnchor {
  return {
    schemaVersion: 1,
    planSha256: SOCIAL_PROPOSED_ADMISSION_PLAN_SHA256,
    controllerJobId: "controller",
    projectId: "social-monitor",
    oldRoot: "/ledger/v1",
    newRoot: "/ledger/v2",
    cutoff: "2026-07-20T00:00:00.000Z",
    debtCount: 2447,
    blockingDebtCount: 709,
    infoDebtCount: 1738,
    categoryCounts: {},
    debt: [...items].sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right))),
    debtItemSha256: items.map(itemHash).sort(),
    blockingDebtItemSha256: items.map(itemHash).sort(),
    debtSha256: "a".repeat(64),
    debtCustody: [],
    debtCustodySha256: "b".repeat(64),
    sourceOrphanBindingSha256: Array.from(
      { length: 205 }, () => "f".repeat(64)
    ),
    sourceOrphanBindingsSha256: "c".repeat(64),
    sourceOrphanBindings: Array.from({ length: 205 }, (_, index) => ({ index })),
    sourceOrphanBindingCount: 205,
    historicalAlias: {
      name: "social-monitor-x-attribution-reuse-fixture-integration-v1-20260719",
      declaredPath: "/archive/alias",
      linkTarget: "/archive/target",
      canonicalPath: "/archive/target",
      headSha: "6c0129f" + "0".repeat(33),
      registryManifest: file("/registry/job.json"),
      pushedAttempt: file("/controller/attempt.json"),
      consumedEvidence: file("/ledger/v1/items/job.json"),
    },
    anchorSha256: "d".repeat(64),
  };
}

function file(path: string) {
  return {
    path,
    canonicalPath: path,
    device: 1,
    inode: 2,
    size: 3,
    sha256: "e".repeat(64),
  };
}

function plan(): ConsumedOutputLedgerEpochPlan {
  return {
    schemaVersion: 1,
    controllerJobId: "controller",
    projectId: "social-monitor",
    oldRoot: "/ledger/v1",
    newRoot: "/ledger/v2",
    cutoff: "2026-07-20T00:00:00.000Z",
    oldRootHash: "a".repeat(64),
    oldRootFileCount: 1,
    oldRootDevice: 1,
    oldRootInode: 2,
    newRootParentDevice: 1,
    newRootParentInode: 3,
    epochNumber: 1,
    genesisOldRootHash: "a".repeat(64),
    controllerManifestSha256: "b".repeat(64),
    controllerStableScopeSha256: "c".repeat(64),
    registryJobIdsSha256: "d".repeat(64),
    registryJobCount: 708,
    migratedCount: 493,
    quarantinedCount: 209,
    inheritedQuarantinedCount: 0,
    deniedRoots: [],
    evidenceBindings: [],
    orphanWorkspaceBindings: Array.from({ length: 506 }, (_, index) => ({
      declaredPath: `/work/orphan-${index}`,
      state: "denied" as const,
    })),
    files: [],
    planSha256: SOCIAL_PROPOSED_ADMISSION_PLAN_SHA256,
  };
}

function proposedSummary() {
  return {
    debtCount: 2447,
    counts: {
      unconsumedCompletedJobs: 493,
      orphanLegacyWorkspaces: 205,
      activeWriterConflicts: 6,
      inactiveDirtyWorkspaces: 4,
      unreadableWorkspaces: 1,
      legacyOutputQuarantineRequired: 1738,
    },
  };
}
