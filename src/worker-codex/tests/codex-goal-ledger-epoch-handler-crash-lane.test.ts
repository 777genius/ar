import { ledgerEpochUpgradeCrashBoundaries } from
  "./codex-goal-ledger-epoch-handler-crash-boundaries";
import { certifyLedgerEpochCrashBoundaryShard } from
  "./codex-goal-ledger-epoch-handler-crash-shard-support";

// One collected module shares imports, while each logical file gets a fresh
// fixture, its original boundary range, and its own external 240 second budget.
if (process.env.CODEX_LEDGER_EPOCH_CRASH_LANE_SOCKET) {
  const lane = Number(process.env.SHARD_LANE);
  if (!Number.isInteger(lane) || lane < 0 || lane >= 8) {
    throw new Error("SHARD_LANE must be an integer from 0 to 7");
  }
  if (ledgerEpochUpgradeCrashBoundaries.length !== 213) {
    throw new Error("crash lane requires the exact 213-boundary contract");
  }
  for (let shard = lane; shard < 54; shard += 8) {
    certifyLedgerEpochCrashBoundaryShard({
      shard,
      start: shard * 4,
      end: Math.min((shard + 1) * 4, 213),
    });
  }
}
