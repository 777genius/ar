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
    const { handlerFixture } = await import("./codex-goal-ledger-epoch-handler.test");
    fixture = await handlerFixture(495, true);
    planSha256 = (await fixture.seedPreparedV1()).planSha256;
    await fixture.freezePreparedV1Baseline();
  } finally {
    delete process.env.CODEX_LEDGER_EPOCH_HANDLER_FIXTURE_ONLY;
  }
}, 90_000);

afterAll(() => delete process.env.CODEX_LEDGER_EPOCH_HANDLER_FIXTURE_ONLY);

describe("exact-710 public-handler early crash resume", () => {
  it("resumes through early and midpoint orphan publication crashes", async () => {
    await fixture.resetPreparedV1Baseline();
    for (const crashAfter of ["source-orphan-0000.json", "source-orphan-0102.json"]) {
      fixture.setUpgradeCrashAfter(crashAfter);
      await expect(projectControlLedgerEpochMigrationView(fixture.args({
        confirmLedgerEpochMigration: true,
        expectedLedgerEpochPlanSha256: planSha256,
      }), { ...fixture.deps }), crashAfter).rejects.toThrow(
        `ledger_epoch_simulated_upgrade_crash:${crashAfter}`,
      );
    }
  });
});
