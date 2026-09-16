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

describe("exact-710 public-handler terminal crash resume", () => {
  it("resumes the terminal intent crash through activation and replay", async () => {
    await fixture.resetPreparedV1Baseline();
    const request = fixture.args({
      confirmLedgerEpochMigration: true,
      expectedLedgerEpochPlanSha256: planSha256,
    });
    fixture.setUpgradeCrashAfter("intent");
    await expect(projectControlLedgerEpochMigrationView(
      request,
      { ...fixture.deps },
    )).rejects.toThrow("ledger_epoch_simulated_upgrade_crash:intent");
    fixture.setUpgradeCrashAfter(undefined);
    await expect(projectControlLedgerEpochMigrationView(
      request,
      { ...fixture.deps },
    )).resolves.toMatchObject({
      ok: true,
      receipt: { planSha256, status: "active" },
    });
    await expect(projectControlLedgerEpochMigrationView(
      request,
      { ...fixture.deps },
    )).resolves.toMatchObject({ ok: true, idempotentReplay: true });
  });
});
