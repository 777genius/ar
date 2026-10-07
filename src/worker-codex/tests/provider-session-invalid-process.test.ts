import { join } from "node:path";
import { expect, it } from "vitest";
import { codexAccountCapacityStore } from "../application/codex-account-capacity-store";
import { listCodexGoalAccountStatuses } from "../codex-goal-account-status";
import { selectProjectControllerCodexAccountSlot } from "../application/project-control/codex-goal-project-controller-account-selection";

// Invoked by the parent regression test with its disposable synthetic pool.
it.runIf(Boolean(process.env.SR_SYNTHETIC_SESSION_ROOT))("reads persisted invalid capacity in a fresh process", async () => {
  const root = process.env.SR_SYNTHETIC_SESSION_ROOT!;
  const authRootDir = join(root, "auth");
  expect(codexAccountCapacityStore(authRootDir).read({ accountId: "account-i", now: new Date("2030-01-01") }))
    .toMatchObject({ availability: "disabled", reason: "provider_session_invalid" });
  const slots = await listCodexGoalAccountStatuses({ authRootDir, liveCheck: false });
  expect(slots.find(slot => slot.name === "account-i")?.schedulerEligible).toBe(false);
  expect(selectProjectControllerCodexAccountSlot({ slots })?.name).toBe("account-u");
});
