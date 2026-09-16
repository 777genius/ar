import { cp, mkdtemp, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ProjectDebtReason,
  type ConsumedOutputLedgerEpochPlan,
  type ProjectAdmissionSnapshot,
} from "@vioxen/subscription-runtime/worker-core";
import {
  assertLedgerEpochLegacyAdmissionUnchanged,
  buildLedgerEpochLegacyAdmissionAnchor,
} from "../application/project-control/codex-goal-ledger-epoch-legacy-admission";
import { assertConsumedOutputLedgerEpochAdmissionTransition } from
  "../application/project-control/codex-goal-ledger-epoch-admission-transition";
import {
  assertPreparedEpochV2Sidecar,
  preparedEpochV1ArtifactNames,
  upgradePreparedEpochV1,
} from
  "../application/project-control/codex-goal-consumed-output-ledger-epoch-target";

const cutoff = "2026-07-01T00:00:00.000Z";
const upgradeCrashBoundaries = [
  "intent.json",
  "source-orphan-0000.json",
  "source-orphan-0102.json",
  "source-orphan-0204.json",
  "plan.json",
  "owner.json",
  "state.json",
  "receipt.json",
  "manifest.json",
  "final-sidecar",
  "intent",
];

describe("ledger epoch legacy admission anchor", () => {
  it("defines every one of the 205 ordered orphan artifact boundaries", () => {
    const plan = { orphanWorkspaceBindings: Array.from({ length: 205 },
      (_, index) => ({ declaredPath: `/orphan/${index}`, state: "denied" })) } as
      unknown as ConsumedOutputLedgerEpochPlan;
    const names = preparedEpochV1ArtifactNames(plan);
    expect(names.filter((name) => name.startsWith("source-orphan-"))).toEqual(
      Array.from({ length: 205 }, (_, index) =>
        `source-orphan-${String(index).padStart(4, "0")}.json`
      ),
    );
  });
  it("binds the exact approved 495-item debt set independent of enumeration order", () => {
    const snapshot = legacySnapshot(495);
    const anchor = buildLedgerEpochLegacyAdmissionAnchor({
      snapshot,
      cutoff,
      processEvidence,
    });
    expect(anchor).toMatchObject({
      debtCount: 710,
      blockingDebtCount: 710,
      cutoff,
    });
    expect(() => assertLedgerEpochLegacyAdmissionUnchanged({
      expected: anchor!,
      snapshot: { ...snapshot, debt: [...snapshot.debt].reverse() },
    })).not.toThrow();
  });

  it.each([494, 496])("refuses a %i-item near miss", (count) => {
    expect(() => buildLedgerEpochLegacyAdmissionAnchor({
      snapshot: legacySnapshot(count),
      cutoff,
      processEvidence,
    })).toThrow("ledger_epoch_legacy_admission_exact_count_mismatch");
  });

  it("detects category, subject and evidence drift", () => {
    const snapshot = legacySnapshot(495);
    const anchor = buildLedgerEpochLegacyAdmissionAnchor({
      snapshot,
      cutoff,
      processEvidence,
    })!;
    const changed = [...snapshot.debt];
    changed[0] = {
      ...changed[0]!,
      reason: ProjectDebtReason.InactiveDirtyWorkspace,
    };
    expect(() => assertLedgerEpochLegacyAdmissionUnchanged({
      expected: anchor,
      snapshot: { ...snapshot, debt: changed },
    })).toThrow("ledger_epoch_legacy_admission_drift");
  });

  it("admits only the exact 495 preserved plus 414 quarantined transition", () => {
    const legacyAdmission = buildLedgerEpochLegacyAdmissionAnchor({
      snapshot: legacySnapshot(495),
      cutoff,
      processEvidence,
    })!;
    const transition = {
      plan: {
        legacyAdmission,
        inheritedQuarantinedCount: 0,
        quarantinedCount: 209,
        orphanWorkspaceBindings: Array.from({ length: 205 }, (_, index) => ({
          declaredPath: `/orphan/${index}`,
          state: "quarantined" as const,
        })),
      } as never,
      before: {
        debtCount: 710,
        counts: {
          activeWriterConflicts: 6,
          inactiveDirtyWorkspaces: 4,
          orphanLegacyWorkspaces: 205,
          unconsumedCompletedJobs: 495,
        },
      },
      proposed: {
        debtCount: 414,
        counts: {
          legacyOutputQuarantineRequired: 414,
          incompleteConsumedOutputRecords: 0,
          orphanLegacyWorkspaces: 0,
          retentionEvidenceMissing: 0,
        },
      },
    };
    expect(() => assertConsumedOutputLedgerEpochAdmissionTransition(transition))
      .not.toThrow();
    expect(() => assertConsumedOutputLedgerEpochAdmissionTransition({
      ...transition,
      proposed: {
        ...transition.proposed,
        counts: { ...transition.proposed.counts, legacyOutputQuarantineRequired: 413 },
      },
    })).toThrow("ledger_epoch_proposed_admission_quarantine_count_mismatch");
  });

  it.each(upgradeCrashBoundaries)(
    "resumes the prepared-v1 sidecar journal after %s",
    async (crashAfter) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "epoch-v1-upgrade-")));
    await mkdir(join(root, "workspace-quarantine"));
    const plan = {
      schemaVersion: 1,
      controllerJobId: "controller",
      projectId: "project",
      oldRoot: join(root, "old"),
      newRoot: root,
      epochNumber: 1,
      genesisOldRootHash: "b".repeat(64),
      oldRootDevice: 1,
      oldRootInode: 2,
      newRootParentDevice: 3,
      newRootParentInode: 4,
      orphanWorkspaceBindings: Array.from({ length: 205 }, (_, index) => ({
        declaredPath: join(root, `orphan-${index}`),
        state: "denied",
      })),
      planSha256: "c".repeat(64),
    } as unknown as ConsumedOutputLedgerEpochPlan;
    const owner = { schemaVersion: 1, ownerToken: "owner", planSha256: "c".repeat(64) };
    const state = {
      schemaVersion: 1,
      phase: "prepared",
      ownerToken: "owner",
      planSha256: "c".repeat(64),
      admissionBefore: { debtCount: 710 },
    };
    await Promise.all([
      writeFile(join(root, "ledger-epoch-plan.json"), `${JSON.stringify(plan)}\n`),
      writeFile(join(root, ".epoch-owner.json"), `${JSON.stringify(owner)}\n`),
      writeFile(join(root, "ledger-epoch-state.json"), `${JSON.stringify(state)}\n`),
      writeFile(join(root, "workspace-quarantine", "orphan.json"), "{}\n"),
    ]);
    const originalPlan = await readFile(join(root, "ledger-epoch-plan.json"));
    const originalOwner = await readFile(join(root, ".epoch-owner.json"));
    const originalState = await readFile(join(root, "ledger-epoch-state.json"));
    const evidence = {
      schemaVersion: 1 as const,
      observedAt: "2026-08-08T00:00:00.000Z",
      inspectedPidCount: 1,
      inventorySha256: "d".repeat(64),
      custodyPaths: [root],
      blockers: [],
    };
    const legacyAdmission = buildLedgerEpochLegacyAdmissionAnchor({
      snapshot: legacySnapshot(495),
      cutoff,
      processEvidence: evidence,
    })!;
    const rootMetadata = await stat(root);
    const debtCustody = [{
      reason: ProjectDebtReason.OrphanLegacyWorkspace,
      subject: "orphan",
      declaredPath: root,
      canonicalPath: root,
      device: rootMetadata.dev,
      inode: rootMetadata.ino,
    }];
    await expect(upgradePreparedEpochV1({
      plan,
      legacyAdmission,
      debtCustody,
      processEvidence: evidence,
      expectedPlanSha256: plan.planSha256,
      crashAfter,
    })).rejects.toThrow("ledger_epoch_simulated_upgrade_crash");
    await expect(upgradePreparedEpochV1({
      plan,
      legacyAdmission,
      debtCustody,
      processEvidence: evidence,
      expectedPlanSha256: plan.planSha256,
    })).resolves.toMatchObject({
      upgraded: crashAfter === "final-sidecar" || crashAfter === "intent"
        ? false
        : true,
    });
    expect(await readFile(join(root, "ledger-epoch-plan.json"))).toEqual(originalPlan);
    expect(await readFile(join(root, ".epoch-owner.json"))).toEqual(originalOwner);
    expect(await readFile(join(root, "ledger-epoch-state.json"))).toEqual(originalState);
    await expect(readFile(join(root, "ledger-epoch-receipt.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(upgradePreparedEpochV1({
      plan,
      legacyAdmission,
      debtCustody,
      processEvidence: { ...evidence, inventorySha256: "e".repeat(64) },
      expectedPlanSha256: plan.planSha256,
    })).rejects.toThrow("ledger_epoch_process_inventory_drift");
    if (crashAfter === "manifest.json") {
      const originalRoot = `${root}-original`;
      await rename(root, originalRoot);
      await cp(originalRoot, root, { recursive: true });
      await expect(assertPreparedEpochV2Sidecar(
        plan,
        evidence,
        legacyAdmission,
        debtCustody,
      )).rejects.toThrow(
        "ledger_epoch_target_root_identity_drift",
      );
    }
    },
  );
});

const processEvidence = {
  inventorySha256: "a".repeat(64),
  inspectedPidCount: 1,
  custodyPaths: ["/custody"],
  blockers: [],
};

function legacySnapshot(consumedCount: number): ProjectAdmissionSnapshot {
  const debt = [
    ...debtItems(
      ProjectDebtReason.UnconsumedCompletedJob,
      consumedCount,
      "blocking",
    ),
    ...debtItems(ProjectDebtReason.OrphanLegacyWorkspace, 205),
    ...debtItems(ProjectDebtReason.ActiveWriterConflict, 6),
    ...debtItems(ProjectDebtReason.InactiveDirtyWorkspace, 4),
  ];
  return {
    schemaVersion: 1,
    projectId: "production-shaped-project",
    observedAt: "2026-08-08T00:00:00.000Z",
    debt,
  };
}

function debtItems(
  reason: ProjectDebtReason,
  count: number,
  severity: "info" | "blocking" = "blocking",
) {
  return Array.from({ length: count }, (_, index) => ({
    reason,
    subject: reason === ProjectDebtReason.UnconsumedCompletedJob ||
        reason === ProjectDebtReason.ActiveWriterConflict
      ? `legacy-${reason}-${String(index).padStart(3, "0")}`
      : `/${reason}/${String(index).padStart(3, "0")}`,
    severity,
    evidence: [`legacy evidence ${reason} ${index}`],
  }));
}
