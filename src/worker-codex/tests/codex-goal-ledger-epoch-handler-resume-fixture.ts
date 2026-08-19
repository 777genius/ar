import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ProjectDebtReason,
  type ProjectAdmissionSnapshot,
} from "@vioxen/subscription-runtime/worker-core";
import { seedLegacyAdmissionHandlerFixture } from
  "./codex-goal-ledger-epoch-legacy-admission-fixture";

export async function loadOrSeedHandlerAdmissionFixture(input: {
  readonly resuming: boolean;
  readonly persistedAdmissionPath: string;
  readonly root: string;
  readonly oldRoot: string;
  readonly legacyConsumedCount?: number;
  readonly fastOrphanBoundaries: boolean;
  readonly currentSocialDebt: boolean;
}): Promise<ProjectAdmissionSnapshot | undefined> {
  if (input.resuming) {
    return JSON.parse(await readFile(input.persistedAdmissionPath, "utf8"));
  }
  const seeded = input.legacyConsumedCount === undefined
    ? undefined
    : await seedLegacyAdmissionHandlerFixture({
        root: input.root,
        oldRoot: input.oldRoot,
        consumedCount: input.legacyConsumedCount,
        fastOrphanBoundaries: input.fastOrphanBoundaries,
      });
  const snapshot = seeded && input.currentSocialDebt
    ? { ...seeded, debt: [
        ...seeded.debt.filter((item) => item.reason ===
          ProjectDebtReason.UnconsumedCompletedJob).map((item) =>
            ({ ...item, reason: ProjectDebtReason.ConsumedDirtyWorkspace })),
        ...seeded.debt.filter((item) => item.reason ===
          ProjectDebtReason.OrphanLegacyWorkspace).slice(0, 57),
        ...Array.from({ length: 377 }, (_, index) => ({
          reason: ProjectDebtReason.UnreadableRoot,
          subject: `${input.root}/unreadable/${index}`,
          severity: "blocking" as const,
          evidence: [`unreadable root ${index}`],
        })),
      ] }
    : seeded;
  if (snapshot) {
    await writeFile(input.persistedAdmissionPath, `${JSON.stringify(snapshot)}\n`);
  } else {
    await writeFile(join(input.oldRoot, "items", "legacy.json"), "not-json\n");
  }
  return snapshot;
}
