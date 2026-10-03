import { describe, expect, it } from "vitest";
import { AgentRuntimeTool } from "@vioxen/subscription-runtime/core";
import { AgentRuntimeAccessBoundary as AccessBoundary, ChildContinuationMode, ChildExecutionBudget, parseChildLifetime } from "../../index";

export const lifetime = () => parseChildLifetime({ schemaVersion: 1, accountId: "inventory-account-s",
  deadlineEpochMs: Date.now() + 60_000, maxGoalTurns: 2, maxAccountCycles: 1, maxAttempts: 1,
  continuationMode: ChildContinuationMode.Disabled, denyProjectInstructions: true,
  accessBoundary: AccessBoundary.ReadOnly, allowedTools: [AgentRuntimeTool.ReadFile, AgentRuntimeTool.SearchFiles] });

describe("immutable child lifetime", () => {
  // Bug: a failed or ambiguous transport write could refund a turn and permit N+1.
  it("spends before the write and never restores spent authority", () => {
    const budget = new ChildExecutionBudget(lifetime());
    budget.beginInvocation(); budget.beforeProviderStart();
    for (let n = 0; n < 2; n++) {
      expect(() => { budget.beforeTurnWrite(); throw new Error("ambiguous write"); }).toThrow("ambiguous write");
    }
    expect(budget.consumedTurns).toBe(2);
    expect(() => budget.beforeTurnWrite()).toThrow("child_turn_budget_exhausted");
    expect(() => budget.beginInvocation()).toThrow("child_turn_budget_exhausted");
  });
  // Bug: restarting one invocation could reset the child budget.
  it("rejects a second invocation even with unspent turns", () => {
    const budget = new ChildExecutionBudget(lifetime()); budget.beginInvocation();
    expect(() => budget.beginInvocation()).toThrow("child_invocation_consumed");
  });
  // Bug: replacing a transport client creates another provider within the same invocation.
  it("consumes the single provider start across transport instances", () => {
    const budget = new ChildExecutionBudget(lifetime()); budget.beginInvocation(); budget.beforeProviderStart();
    expect(() => budget.beforeProviderStart()).toThrow("child_invocation_consumed");
  });
  // Bug: mutating the caller's input changes granted tools or limits after enrollment.
  it("retains a frozen independent snapshot of authority", () => {
    const tools = [AgentRuntimeTool.ReadFile], input = { ...lifetime(), allowedTools: tools };
    const parsed = parseChildLifetime(input), budget = new ChildExecutionBudget(parsed);
    tools.push(AgentRuntimeTool.WriteFile); input.maxGoalTurns = 99;
    expect(budget.lifetime.maxGoalTurns).toBe(2); expect(budget.lifetime.allowedTools).toEqual([AgentRuntimeTool.ReadFile]);
    expect(Object.isFrozen(parsed)).toBe(true); expect(Object.isFrozen(parsed.allowedTools)).toBe(true);
  });
  // Bug: default cycles, attempts, native tools or readonly edit tools weaken confinement.
  it.each([{ maxAccountCycles: 5 }, { maxAttempts: 2 }, { maxGoalTurns: 0 },
    { continuationMode: "packet_first" }, { allowedTools: [AgentRuntimeTool.WriteFile] },
    { allowedTools: [AgentRuntimeTool.Shell] }, { denyProjectInstructions: false },
    { credentialPath: "/private/key" }])("rejects unsafe contracts: %j", change => {
    expect(() => parseChildLifetime({ ...lifetime(), ...change })).toThrow("child_lifetime_invalid");
  });
  // Bug: backward clocks extend deadlines; a forward jump then reset revives authority.
  it("bounds both clocks and latches clock inconsistency", () => {
    let wall = 1000, monotonic = 10;
    const budget = new ChildExecutionBudget({ ...lifetime(), deadlineEpochMs: 2000 },
      { wall: () => wall, monotonic: () => monotonic });
    monotonic = 510; wall = 1100;
    expect(budget.remainingMs()).toBe(500);
    wall = 1099;
    expect(() => budget.remainingMs()).toThrow("child_clock_inconsistent");
    wall = 1500;
    expect(() => budget.remainingMs()).toThrow("child_clock_inconsistent");
  });
  // Bug: issuing a fresh relative timeout would renew an expired absolute grant.
  it("expires against elapsed monotonic time even if wall time advances slowly", () => {
    let monotonic = 0;
    const budget = new ChildExecutionBudget({ ...lifetime(), deadlineEpochMs: 2000 },
      { wall: () => 1000, monotonic: () => monotonic });
    monotonic = 1000;
    expect(() => budget.remainingMs()).toThrow("child_deadline_expired");
  });
});
