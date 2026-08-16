import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { expect, type TestAPI } from "vitest";
import {
  CONSUMED_OUTPUT_LEDGER_RETIRED_MARKER,
  type ConsumedOutputLedgerEpochPlan,
} from "@vioxen/subscription-runtime/worker-core";
import {
  projectControlLedgerEpochMigrationView,
  type ProjectControlLedgerEpochDeps,
} from "../codex-goal-mcp-project-control-ledger-epoch";
import type { ProjectControlMcpArgs } from "../codex-goal-mcp-inputs";

type LoadedController = Awaited<ReturnType<
  ProjectControlLedgerEpochDeps["loadProjectControlController"]
>>;

type RecoveryFenceFixture = {
  readonly oldRoot: string;
  readonly newRoot: string;
  readonly deps: ProjectControlLedgerEpochDeps;
  seedScopeSwitched(): Promise<ConsumedOutputLedgerEpochPlan>;
  load(): Promise<LoadedController>;
  args(extra?: Record<string, unknown>): ProjectControlMcpArgs;
  oldScopeBytes(): Promise<{
    readonly controller: readonly string[];
    readonly oldRoot: readonly string[];
    readonly newRoot: readonly string[];
  }>;
};

export function certifyLedgerEpochRecoveryFence(input: {
  readonly test: TestAPI;
  readonly fixture: () => Promise<RecoveryFenceFixture>;
}): void {
  input.test.each([
    ["foreign controller ID", "ledger_epoch_controller_job_id_mismatch"],
    ["stable controller drift", "ledger_epoch_controller_manifest_cas_mismatch"],
  ] as const)("fences prepared active-root recovery from %s before mutation",
    async (variant, expectedError) => {
      const fixture = await input.fixture();
      const plan = await fixture.seedScopeSwitched();
      const statePath = join(fixture.newRoot, "ledger-epoch-state.json");
      const stateBefore = await readFile(statePath);
      expect(JSON.parse(stateBefore.toString()).phase).toBe("prepared");
      const before = await fixture.oldScopeBytes();
      let loadCount = 0;
      let injected = false;
      const deps: ProjectControlLedgerEpochDeps = {
        ...fixture.deps,
        loadProjectControlController: async () => {
          loadCount += 1;
          const current = await fixture.load();
          if (loadCount !== 5) return current;
          injected = true;
          return {
            ...current,
            controller: variant === "foreign controller ID"
              ? { ...current.controller, jobId: "foreign-controller" }
              : { ...current.controller, taskId: "stable-scope-drift" },
          };
        },
      };
      await expect(projectControlLedgerEpochMigrationView(fixture.args({
        confirmLedgerEpochMigration: true,
        expectedLedgerEpochPlanSha256: plan.planSha256,
      }), deps)).rejects.toThrow(expectedError);
      expect(injected).toBe(true);
      expect(await readFile(statePath)).toEqual(stateBefore);
      expect(JSON.parse(await readFile(statePath, "utf8")).phase).toBe("prepared");
      await expect(stat(join(fixture.oldRoot,
        CONSUMED_OUTPUT_LEDGER_RETIRED_MARKER)))
        .rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(join(fixture.newRoot, "ledger-epoch-receipt.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
      expect(await fixture.oldScopeBytes()).toEqual(before);
    });
}
