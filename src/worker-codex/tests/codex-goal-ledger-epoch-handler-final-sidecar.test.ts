import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { projectControlLedgerEpochMigrationView } from
  "../codex-goal-mcp-project-control-ledger-epoch";

type HandlerFixture = Awaited<ReturnType<
  typeof import("./codex-goal-ledger-epoch-handler.test").handlerFixture
>>;

let fixture: HandlerFixture;
let planSha256: string;

beforeAll(async () => {
  process.env.CODEX_LEDGER_EPOCH_HANDLER_FIXTURE_ONLY = "1";
  try {
    const { handlerFixture } = await import(
      "./codex-goal-ledger-epoch-handler.test"
    );
    fixture = await handlerFixture(495, true);
    const plan = await fixture.seedPreparedV1();
    planSha256 = plan.planSha256;
    await fixture.freezePreparedV1Baseline();
  } finally {
    delete process.env.CODEX_LEDGER_EPOCH_HANDLER_FIXTURE_ONLY;
  }
}, 90_000);

afterAll(() => {
  delete process.env.CODEX_LEDGER_EPOCH_HANDLER_FIXTURE_ONLY;
});

describe("conflicting exact-710 final sidecar", () => {
  it("captures the valid final-sidecar-before-intent boundary", async () => {
    await fixture.resetPreparedV1Baseline();
    fixture.setUpgradeCrashAfter("final-sidecar");
    await expect(projectControlLedgerEpochMigrationView(
      fixture.args({
        confirmLedgerEpochMigration: true,
        expectedLedgerEpochPlanSha256: planSha256,
      }),
      { ...fixture.deps },
    )).rejects.toThrow("ledger_epoch_simulated_upgrade_crash:final-sidecar");
  });

  it("refuses conflicting bytes through a fresh real handler", async () => {
    const manifestPath = join(
      fixture.newRoot,
      ".ledger-epoch-v2-sidecar",
      "manifest.json",
    );
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as
      Record<string, unknown>;
    await writeFile(manifestPath, `${JSON.stringify({
      ...manifest,
      processEvidence: { inventorySha256: "f".repeat(64) },
    }, null, 2)}\n`);
    fixture.setUpgradeCrashAfter(undefined);
    await expect(projectControlLedgerEpochMigrationView(
      fixture.args({
        confirmLedgerEpochMigration: true,
        expectedLedgerEpochPlanSha256: planSha256,
      }),
      { ...fixture.deps },
    )).rejects.toThrow("ledger_epoch_upgrade_sidecar_hash_mismatch");
    expect((await fixture.load()).scope.consumedOutputLedgerRoots)
      .toEqual([fixture.oldRoot]);
  });
});
