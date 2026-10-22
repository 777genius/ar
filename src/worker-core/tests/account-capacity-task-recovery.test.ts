import { describe, expect, it } from "vitest";
import {
  prepareWorkerAccountTaskRecovery,
} from "../account-capacity/domain/worker-account-task-recovery";
import { WorkerAccountCapacityPhase } from "../account-capacity/domain/worker-account-capacity-recheck";

const now = new Date("2026-10-15T14:00:00Z");
const demand = { provider: "codex", model: "mimo-v2.6-pro", reasoningEffort: "high" };
const state = {
  recordId: "/TEST/capacity/record", revision: "original-revision", accountId: "legacy-id",
  demand: null, phase: WorkerAccountCapacityPhase.RecheckDue,
  capacity: { availability: "cooldown" as const, reason: "quota_limited", cooldownUntil: now },
};
const preparation = () => prepareWorkerAccountTaskRecovery({ state, recordSha256: "a".repeat(64), recordSetSha256: "b".repeat(64), demand, now })!;
describe("original ordinary task capacity recovery", () => {
  it("prepares an exact expired quota revision without declaring availability", () => {
    expect(preparation()).toMatchObject({ phase: "prepared", revision: state.revision,
      recordId: state.recordId, recordSha256: "a".repeat(64) });
    expect(preparation()).not.toHaveProperty("availability");
  });

  it.each([
    { ...state, phase: WorkerAccountCapacityPhase.Blocking },
    { ...state, capacity: { ...state.capacity, cooldownUntil: new Date(now.getTime() + 1) } },
    { ...state, capacity: { ...state.capacity, reason: "provider_session_invalid" } },
    { ...state, demand: { ...demand, model: "different-model" } },
  ])("refuses an undue, disabled or differently scoped record", invalid => {
    expect(prepareWorkerAccountTaskRecovery({ state: invalid, recordSha256: "a".repeat(64), recordSetSha256: "b".repeat(64), demand, now })).toBeUndefined();
  });

});
