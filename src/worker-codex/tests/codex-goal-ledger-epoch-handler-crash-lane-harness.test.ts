import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, vi } from "vitest";
import { ledgerEpochUpgradeCrashBoundaries } from "./codex-goal-ledger-epoch-handler-crash-boundaries";
import { certifyLedgerEpochCrashBoundaryShard } from "./codex-goal-ledger-epoch-handler-crash-shard-support";

const state = vi.hoisted(() => ({
  previousRangeMode: process.env.CODEX_LEDGER_EPOCH_CRASH_RANGE_ONLY,
  activeRoots: new Set<string>(),
  roots: [] as string[],
  crashes: [] as string[],
}));
vi.mock("./codex-goal-ledger-epoch-handler.test", () => ({
  handlerFixture: async (count: number, fast: boolean) => {
    // A leaked top-level beforeAll or fixture reused between shards fails here.
    expect(state.activeRoots.size).toBe(0);
    expect([count, fast]).toEqual([495, true]);
    const root = await mkdtemp(join(tmpdir(), "crash-harness-contract-"));
    state.activeRoots.add(root);
    state.roots.push(root);
    const newRoot = join(root, "new");
    const registryRootDir = join(root, "registry");
    await mkdir(newRoot, { recursive: true });
    await mkdir(join(registryRootDir, "controller"), { recursive: true });
    await writeFile(join(registryRootDir, "controller", "job.json"), "{}");
    const deps = { crashAfter: undefined as string | undefined, planSha256: root };
    return {
      newRoot, deps,
      args: () => ({ registryRootDir, controllerJobId: "controller" }),
      seedPreparedV1: async () => ({ planSha256: root }),
      freezePreparedV1Baseline: async () => {},
      setUpgradeCrashAfter: (boundary: string | undefined) => { deps.crashAfter = boundary; },
      cleanup: async () => { await rm(root, { recursive: true, force: true }); state.activeRoots.delete(root); },
    };
  },
}));
vi.mock("../codex-goal-mcp-project-control-ledger-epoch", () => ({
  projectControlLedgerEpochMigrationView: async (_request: unknown, deps: { crashAfter?: string; planSha256: string }) => {
    if (deps.crashAfter) {
      state.crashes.push(deps.crashAfter);
      throw new Error(`ledger_epoch_simulated_upgrade_crash:${deps.crashAfter}`);
    }
    return { ok: true, receipt: { planSha256: deps.planSha256, status: "active" } };
  },
}));
process.env.CODEX_LEDGER_EPOCH_CRASH_RANGE_ONLY = "1";
certifyLedgerEpochCrashBoundaryShard({ shard: 0, start: 0, end: 4 });
certifyLedgerEpochCrashBoundaryShard({ shard: 1, start: 4, end: 8 });
afterAll(() => {
  if (state.previousRangeMode === undefined) delete process.env.CODEX_LEDGER_EPOCH_CRASH_RANGE_ONLY;
  else process.env.CODEX_LEDGER_EPOCH_CRASH_RANGE_ONLY = state.previousRangeMode;
  expect(state.activeRoots.size).toBe(0);
  expect(state.roots).toHaveLength(2);
  expect(new Set(state.roots).size).toBe(2);
  expect(state.crashes).toEqual(ledgerEpochUpgradeCrashBoundaries.slice(0, 8));
});
