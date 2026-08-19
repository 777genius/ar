import { createServer } from "vite";
import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const mode = process.env.CODEX_LEDGER_EPOCH_PROCESS_CRASH_MODE;
const root = process.env.CODEX_LEDGER_EPOCH_PROCESS_CRASH_ROOT;
const planSha256 = process.env.CODEX_LEDGER_EPOCH_PROCESS_CRASH_PLAN_SHA256;
const markerPath = process.env.CODEX_LEDGER_EPOCH_PROCESS_CRASH_MARKER;
if ((mode !== "crash" && mode !== "resume") || !root || !planSha256) {
  throw new Error("ledger_epoch_process_crash_fixture_required");
}

const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
const vite = await createServer({
  appType: "custom",
  root: projectRoot,
  configFile: join(projectRoot, "vitest.config.ts"),
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
    if (!markerPath) throw new Error("ledger_epoch_process_crash_marker_required");
    fixture.setUpgradeCrashBoundary((boundary) => {
      if (boundary !== "final-sidecar") return;
      const marker = openSync(markerPath, "wx", 0o600);
      try {
        writeSync(marker, "final-sidecar\n");
        fsyncSync(marker);
      } finally {
        closeSync(marker);
      }
      process.kill(process.pid, "SIGKILL");
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
