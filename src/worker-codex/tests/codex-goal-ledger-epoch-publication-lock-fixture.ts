import { stat } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { ProjectDebtReason } from
  "@vioxen/subscription-runtime/worker-core";
import { projectControlLedgerEpochMigrationView } from
  "../codex-goal-mcp-project-control-ledger-epoch";

type MigrationArgs = Parameters<typeof projectControlLedgerEpochMigrationView>[0];
type MigrationDeps = Parameters<typeof projectControlLedgerEpochMigrationView>[1];

export async function assertPublicationLockAdmissionGuardrails(input: {
  readonly fixture: {
    readonly oldRoot: string;
    readonly newRoot: string;
    readonly args: (extra?: Record<string, unknown>) => MigrationArgs;
    readonly deps: MigrationDeps;
  };
  readonly exactTreeBytes: (path: string) => Promise<unknown>;
}): Promise<void> {
  const { fixture } = input;
  const blockingDeps: MigrationDeps = {
    ...fixture.deps,
    buildAdmissionSnapshot: async () => ({
      schemaVersion: 1 as const,
      projectId: "social-monitor",
      observedAt: "2026-08-08T00:00:00.000Z",
      debt: [{
        reason: ProjectDebtReason.UnreadableRoot,
        subject: join(fixture.oldRoot, "unrelated-blocking-root"),
        severity: "blocking" as const,
        evidence: ["unrelated blocking debt must survive normalization"],
      }],
      counts: { unreadableRoots: 1 },
    }),
  };
  const blockedPreview = await projectControlLedgerEpochMigrationView(
    fixture.args(),
    blockingDeps,
  );
  const beforeBlockedConfirmation = await input.exactTreeBytes(fixture.oldRoot);
  await expect(stat(fixture.newRoot)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(projectControlLedgerEpochMigrationView(
    fixture.args({
      confirmLedgerEpochMigration: true,
      expectedLedgerEpochPlanSha256: String(blockedPreview.planSha256),
    }),
    blockingDeps,
  )).rejects.toThrow("ledger_epoch_proposed_admission_blocked");
  expect(await input.exactTreeBytes(fixture.oldRoot)).toEqual(beforeBlockedConfirmation);
  await expect(stat(fixture.newRoot)).rejects.toMatchObject({ code: "ENOENT" });

  const deps: MigrationDeps = {
    ...fixture.deps,
    buildAdmissionSnapshot: async () => ({
      schemaVersion: 1 as const,
      projectId: "social-monitor",
      observedAt: "2026-08-08T00:00:00.000Z",
      debt: [{
        reason: ProjectDebtReason.LegacyOutputQuarantineRequired,
        subject: join(fixture.newRoot, "legacy-preservation"),
        severity: "info" as const,
        evidence: ["fixture record retained by the epoch"],
      }],
      counts: { legacyOutputQuarantineRequired: 1 },
    }),
  };
  const preview = await projectControlLedgerEpochMigrationView(
    fixture.args(),
    deps,
  );
  expect(preview.oldRootFileCount).toBe(1);
  const planSha256 = String(preview.planSha256);

  await expect(projectControlLedgerEpochMigrationView(
    fixture.args({
      confirmLedgerEpochMigration: true,
      expectedLedgerEpochPlanSha256: planSha256,
    }),
    deps,
  )).resolves.toMatchObject({
    ok: true,
    receipt: { planSha256, status: "active" },
  });
}
