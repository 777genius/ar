import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { projectControlLedgerEpochMigrationView } from
  "../codex-goal-mcp-project-control-ledger-epoch";
import { ledgerEpochUpgradeCrashBoundaries } from
  "./codex-goal-ledger-epoch-handler-crash-boundaries";

type HandlerFixture = Awaited<ReturnType<
  typeof import("./codex-goal-ledger-epoch-handler.test").handlerFixture
>>;

export function certifyLedgerEpochCrashBoundaryShard(input: {
  readonly shard: number;
  readonly start: number;
  readonly end: number;
}): void {
  let fixture: HandlerFixture;
  let planSha256: string;

  const assertFinalBoundaryActivation = async (request: ReturnType<HandlerFixture["args"]>) => {
    const recoverySnapshot = `${fixture.newRoot}-final-boundary-recovery`;
    const controllerManifest = join(
      request.registryRootDir,
      request.controllerJobId,
      "job.json",
    );
    const controllerRecoverySnapshot = `${recoverySnapshot}-controller.json`;
    await rm(recoverySnapshot, { recursive: true, force: true });
    await rm(controllerRecoverySnapshot, { force: true });
    await cp(fixture.newRoot, recoverySnapshot, { recursive: true });
    await cp(controllerManifest, controllerRecoverySnapshot);
    try {
      fixture.setUpgradeCrashAfter(undefined);
      await expect(projectControlLedgerEpochMigrationView(
        request,
        { ...fixture.deps },
      )).resolves.toMatchObject({
        ok: true,
        receipt: { planSha256, status: "active" },
      });
    } finally {
      await rm(fixture.newRoot, { recursive: true, force: true });
      await cp(recoverySnapshot, fixture.newRoot, { recursive: true });
      await cp(controllerRecoverySnapshot, controllerManifest);
      await rm(recoverySnapshot, { recursive: true, force: true });
      await rm(controllerRecoverySnapshot, { force: true });
    }
  };

  beforeAll(async () => {
    process.env.CODEX_LEDGER_EPOCH_HANDLER_FIXTURE_ONLY = "1";
    try {
      const module = await import("./codex-goal-ledger-epoch-handler.test");
      // The public handler must admit the authentic 495 consumed registrations
      // plus 205 source orphans before it can enter the 213-boundary upgrade.
      // Keep that production-shaped admission contract here; range mode below
      // removes the accidental duplicate execution that exhausted the budget.
      fixture = await module.handlerFixture(495, true);
      planSha256 = (await fixture.seedPreparedV1()).planSha256;
      await fixture.freezePreparedV1Baseline();
      const resume = process.env.CODEX_LEDGER_EPOCH_CRASH_RESUME_SNAPSHOT;
      if (resume) {
        await rm(fixture.newRoot, { recursive: true, force: true });
        await cp(resolve(resume), fixture.newRoot, { recursive: true });
      }
    } finally {
      delete process.env.CODEX_LEDGER_EPOCH_HANDLER_FIXTURE_ONLY;
    }
  }, 90_000);

  afterAll(async () => {
    delete process.env.CODEX_LEDGER_EPOCH_HANDLER_FIXTURE_ONLY;
    if (fixture) {
      const save = process.env.CODEX_LEDGER_EPOCH_CRASH_SAVE_SNAPSHOT;
      if (save) {
        await rm(resolve(save), { recursive: true, force: true });
        await mkdir(dirname(resolve(save)), { recursive: true });
        await cp(fixture.newRoot, resolve(save), { recursive: true });
      }
      await fixture.cleanup();
    }
    delete process.env.CODEX_LEDGER_EPOCH_CRASH_RESUME_SNAPSHOT;
    delete process.env.CODEX_LEDGER_EPOCH_CRASH_SAVE_SNAPSHOT;
  });

  describe(`exact-213 public-handler interruption boundary shard ${input.shard}`, () => {
    for (let groupStart = input.start; groupStart < input.end; groupStart += 4) {
      const groupEnd = Math.min(groupStart + 4, input.end);
      it.runIf(process.env.CODEX_LEDGER_EPOCH_CRASH_RANGE_ONLY === "1")(
        `certifies ordered range ${groupStart}..${groupEnd - 1}`,
        async () => {
        const request = fixture.args({
          confirmLedgerEpochMigration: true,
          expectedLedgerEpochPlanSha256: planSha256,
        });
        for (const crashAfter of ledgerEpochUpgradeCrashBoundaries.slice(
          groupStart,
          groupEnd,
        )) {
          fixture.setUpgradeCrashAfter(crashAfter);
          await expect(projectControlLedgerEpochMigrationView(
            request,
            { ...fixture.deps },
          ), crashAfter).rejects.toThrow(
            `ledger_epoch_simulated_upgrade_crash:${crashAfter}`,
          );
        }
        if (groupEnd === input.end) {
          await assertFinalBoundaryActivation(request);
        }
        },
        120_000,
      );
    }
    for (const [offset, crashAfter] of ledgerEpochUpgradeCrashBoundaries.slice(
      input.start,
      input.end,
    ).entries()) {
      const boundary = input.start + offset;
      // Range mode is the bounded certification path used by the shard runner.
      // Do not also execute the per-boundary presentation tests in that mode:
      // doing both replayed every public-handler crash twice and made an
      // eight-boundary shard exceed its external 240 second budget.
      it.skipIf(process.env.CODEX_LEDGER_EPOCH_CRASH_RANGE_ONLY === "1")(
        `executes ordered boundary ${boundary}: ${crashAfter}`,
        async () => {
        const request = fixture.args({
          confirmLedgerEpochMigration: true,
          expectedLedgerEpochPlanSha256: planSha256,
        });
        fixture.setUpgradeCrashAfter(crashAfter);
        await expect(projectControlLedgerEpochMigrationView(
          request,
          { ...fixture.deps },
        ), crashAfter).rejects.toThrow(
          `ledger_epoch_simulated_upgrade_crash:${crashAfter}`,
        );
        if (boundary === input.end - 1) {
          await assertFinalBoundaryActivation(request);
        }
        },
        120_000,
      );
    }
  });
}
