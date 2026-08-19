import { createServer } from "vite";

const mode = process.env.CODEX_LEDGER_EPOCH_PROCESS_CRASH_MODE;
const root = process.env.CODEX_LEDGER_EPOCH_PROCESS_CRASH_ROOT;
const planSha256 = process.env.CODEX_LEDGER_EPOCH_PROCESS_CRASH_PLAN_SHA256;
if ((mode !== "crash" && mode !== "resume") || !root || !planSha256) {
  throw new Error("ledger_epoch_process_crash_fixture_required");
}

const vite = await createServer({
  appType: "custom",
  server: { middlewareMode: true },
});
try {
  const { handlerFixture } = await vite.ssrLoadModule(
    "/src/worker-codex/tests/codex-goal-ledger-epoch-handler.test.ts",
  );
  const { projectControlLedgerEpochMigrationView } = await vite.ssrLoadModule(
    "/src/worker-codex/codex-goal-mcp-project-control-ledger-epoch.ts",
  );
  const fixture = await handlerFixture(676, true, true, false, root);
  if (mode === "crash") {
    fixture.setUpgradeCrashBoundary((boundary) => {
      if (boundary === "final-sidecar") process.kill(process.pid, "SIGKILL");
    });
  }
  const request = fixture.args({
    confirmLedgerEpochMigration: true,
    expectedLedgerEpochPlanSha256: planSha256,
  });
  const activated = await projectControlLedgerEpochMigrationView(
    request,
    fixture.deps,
  );
  if (mode !== "resume" || activated?.receipt?.status !== "active") {
    throw new Error("ledger_epoch_process_crash_resume_not_active");
  }
  const replay = await projectControlLedgerEpochMigrationView(
    request,
    fixture.deps,
  );
  if (replay?.receipt?.status !== "active") {
    throw new Error("ledger_epoch_process_crash_replay_not_active");
  }
} finally {
  await vite.close();
}
