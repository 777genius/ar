import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentRuntimeExecutionMode, DefaultRedactor } from "@vioxen/subscription-runtime/core";
import {
  CodexAppServerExecutionEngine,
  CodexJsonAgentDriver,
  sessionArtifactFromCodexAuthJson,
} from "../index";
import {
  FakeAppServerFactory,
  type FakeAppServerFactoryOptions,
} from "../app-server/testing/fake-app-server";
import {
  StaticRunner,
  validAuthJson,
} from "./codex-provider-test-support";

describe("Codex app-server goal usage", () => {
  it("bills every exact snapshot a turn owns, once, and excludes unrelated notifications", async () => {
    const first = { inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedInputTokens: 80, cacheWriteInputTokens: 10, reasoningOutputTokens: 5 };
    const second = { inputTokens: 60, outputTokens: 20, totalTokens: 80, cachedInputTokens: 40, cacheWriteInputTokens: 5, reasoningOutputTokens: 3 };
    // The thread counter is cumulative across BOTH turns, exactly as the
    // protocol defines it: each turn makes two model responses costing `first`
    // then `second`, and `total` only ever grows.
    const afterTurn1 = { inputTokens: 160, outputTokens: 40, totalTokens: 200, cachedInputTokens: 120, cacheWriteInputTokens: 15, reasoningOutputTokens: 8 };
    const midTurn2 = { inputTokens: 260, outputTokens: 60, totalTokens: 320, cachedInputTokens: 200, cacheWriteInputTokens: 25, reasoningOutputTokens: 13 };
    const afterTurn2 = { inputTokens: 320, outputTokens: 80, totalTokens: 400, cachedInputTokens: 240, cacheWriteInputTokens: 30, reasoningOutputTokens: 16 };
    const distractors = [
      { threadId: "wrong-thread", total: { totalTokens: 99999 }, last: { totalTokens: 99999 } },
      { turnId: "wrong-turn", total: { totalTokens: 99999 }, last: { totalTokens: 99999 } },
    ];
    const result = await runSyntheticGoalUsage({
      tokenUsageNotificationsAfterTurns: [
        [
          { total: first, last: first },
          { total: afterTurn1, last: second }, { total: afterTurn1, last: second },
          ...distractors,
        ],
        [
          { total: midTurn2, last: first },
          { total: afterTurn2, last: second }, { total: afterTurn2, last: second },
          ...distractors,
        ],
      ],
    });
    // Each turn is billed both of its responses — never one of them, never
    // twice — so the repeated notification adds nothing, and the foreign-thread
    // / stale-turn 99999 distractors never reach either turn.
    expect(result.telemetry?.usage).toEqual({
      inputTokens: 320, outputTokens: 80, totalTokens: 400,
      cachedInputTokens: 240, cacheWriteInputTokens: 30, reasoningOutputTokens: 16,
    });
  });

  it("never backfills a turn whose exact usage was untrusted from the goal counter", async () => {
    const exact = { inputTokens: 30, outputTokens: 10, totalTokens: 40 };
    const result = await runSyntheticGoalUsage({
      tokenUsageNotificationsAfterTurns: [
        // Turn 1's exact snapshot is malformed, so the turn reports nothing.
        [{ total: { inputTokens: 400, outputTokens: 100, totalTokens: 500 }, last: { inputTokens: -1 } }],
        [{ total: { inputTokens: 430, outputTokens: 110, totalTokens: 540 }, last: exact }],
      ],
      // The goal's own cumulative counter knows turn 1's 500 tokens and would
      // hand them to anyone willing to subtract a checkpoint baseline. A turn
      // that reported nothing may be backfilled that way; a turn whose number
      // was untrusted may not, or the fail-closed decision is undone.
      goalUsageAfterTurns: [{ tokensUsed: 500 }, { tokensUsed: 540 }],
    });
    expect(result.status).toBe("completed");
    expect(result.telemetry?.usage).toEqual(exact);
    expect(result.warnings?.map((warning) => warning.code))
      .toContain("codex_app_server_turn_usage_untrusted");
  });

  it("does not charge a quota notification replaying the previous cumulative snapshot", async () => {
    const usage = { inputTokens: 100, outputTokens: 25, totalTokens: 125 };
    // No `last`: a pure cumulative replay carries no exact turn usage, so the
    // second turn's identical snapshot must add nothing.
    const result = await runSyntheticGoalUsage({ tokenUsageNotifications: [{ total: usage }], abortTurnNumbers: [2] });
    expect(result.status).toBe("failed");
    expect(result.telemetry?.usage).toEqual(usage);
  });

  it("does not count stale cumulative goal snapshots twice", async () => {
    const result = await runSyntheticGoalUsage({ goalStatusesAfterTurns: ["active", "active", "complete"], goalUsageAfterTurns: [{ tokensUsed: 100 }, { tokensUsed: 50 }, { tokensUsed: 150 }] });
    expect(result.telemetry?.usage).toEqual({ totalTokens: 150 });
  });

  it("subtracts known detailed tokens from a later cumulative fallback window", async () => {
    const result = await runSyntheticGoalUsage({ turnUsageAfterTurns: [{ totalTokens: 125 }, undefined], goalUsageAfterTurns: [undefined, { tokensUsed: 250 }] });
    expect(result.telemetry?.usage).toEqual({ totalTokens: 250 });
  });

  it("only fills the missing window when fully reported detailed and goal counters differ", async () => {
    const result = await runSyntheticGoalUsage({ turnUsageAfterTurns: [{ totalTokens: 10 }, undefined], goalUsageAfterTurns: [{ tokensUsed: 100 }, { tokensUsed: 200 }] });
    expect(result.telemetry?.usage).toEqual({ totalTokens: 110 });
  });

  it("retains fork replay arriving synchronously after the fork response", async () => {
    const result = await runSyntheticGoalUsage({ goalStatusesAfterTurns: ["complete"], forkUsageReplay: { totalTokens: 200 }, tokenUsageNotifications: [{ total: { totalTokens: 225 }, last: { totalTokens: 25 } }] }, false, "historical-fixture-thread");
    expect(result.telemetry?.usage).toEqual({ totalTokens: 25 });
  });

  it("preserves known goal fallback on usageLimited", async () => {
    const result = await runSyntheticGoalUsage({ goalStatusesAfterTurns: ["usageLimited"], goalUsageAfterTurns: [{ tokensUsed: 125 }] });
    expect(result.status).toBe("failed");
    expect(result.telemetry?.usage).toEqual({ totalTokens: 125 });
  });

  it("retains previous fallback when a subsequent turn aborts", async () => {
    const result = await runSyntheticGoalUsage({ goalUsageAfterTurns: [{ tokensUsed: 125 }], abortTurnNumbers: [2] });
    expect(result.status).toBe("failed");
    expect(result.telemetry?.usage).toEqual({ totalTokens: 125 });
  });

  it("includes usage observed on the failing turn exactly once", async () => {
    const result = await runSyntheticGoalUsage({ turnUsage: { inputTokens: 100, outputTokens: 25, totalTokens: 125 }, abortTurnNumbers: [2] });
    expect(result.status).toBe("failed");
    expect(result.telemetry?.usage).toEqual({ inputTokens: 200, outputTokens: 50, totalTokens: 250 });
  });

  it("subtracts previously reported goal tokens on resume", async () => {
    const result = await runSyntheticGoalUsage({ goalStatusesAfterTurns: ["blocked", "complete"], goalUsageAfterTurns: [{ tokensUsed: 200 }, { tokensUsed: 230 }] }, true);
    expect(result.telemetry?.usage).toEqual({ totalTokens: 30 });
  });

  it("keeps current detailed usage when getGoal fails", async () => {
    const result = await runSyntheticGoalUsage({ turnUsage: { totalTokens: 125 }, throwOnRequestMethod: "thread/goal/get" });
    expect(result.status).toBe("failed");
    expect(result.telemetry?.usage).toEqual({ totalTokens: 125 });
  });

  it("retains usage when the next turn start request fails", async () => {
    let starts = 0;
    const result = await runSyntheticGoalUsage({ goalUsageAfterTurns: [{ tokensUsed: 125 }],
      onRequest: (request) => { if (request.method === "turn/start" && ++starts === 2) throw new Error("synthetic start failure"); },
    });
    expect(result.status).toBe("failed");
    expect(result.telemetry?.usage).toEqual({ totalTokens: 125 });
  });

  it("tracks usage through provider turn-id aliases", async () => {
    const result = await runSyntheticGoalUsage({ mismatchTurnStartResponseId: true, turnUsage: { totalTokens: 125 } });
    expect(result.telemetry?.usage).toEqual({ totalTokens: 250 });
  });

  it("reports the latest cumulative goal usage snapshot", async () => {
    const result = await runSyntheticGoalUsage({
      goalUsageAfterTurns: [{ tokensUsed: 100 }, { tokensUsed: 250 }],
    });
    expect(result).toMatchObject({
      status: "completed",
      telemetry: { usage: { totalTokens: 250 } },
    });
  });

  it("retains the last goal usage when the final snapshot omits usage", async () => {
    const result = await runSyntheticGoalUsage({
      goalUsageAfterTurns: [{ tokensUsed: 100 }, undefined],
    });
    expect(result).toMatchObject({
      status: "completed",
      telemetry: { usage: { totalTokens: 100 } },
    });
  });

  it("prefers summed detailed turn usage over cumulative goal usage", async () => {
    const result = await runSyntheticGoalUsage({
      goalUsageAfterTurns: [{ tokensUsed: 100 }, { tokensUsed: 250 }],
      turnUsage: { input_tokens: 10, output_tokens: 5 },
    });
    expect(result).toMatchObject({
      status: "completed",
      telemetry: {
        usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
      },
    });
  });

  it("preserves cumulative goal usage on max-turn slice failures", async () => {
    const result = await runSyntheticGoalUsage({
      goalStatusesAfterTurns: ["active", "active"],
      goalUsageAfterTurns: [{ tokensUsed: 100 }, { tokensUsed: 250 }],
    });
    expect(result).toMatchObject({
      status: "failed",
      failure: { code: "goal_slice_exhausted" },
      telemetry: { finishReason: "max_turns", usage: { totalTokens: 250 } },
    });
  });

  it("preserves preferred detailed turn usage on max-turn slice failures", async () => {
    const result = await runSyntheticGoalUsage({
      goalStatusesAfterTurns: ["active", "active"],
      goalUsageAfterTurns: [{ tokensUsed: 100 }, { tokensUsed: 250 }],
      turnUsage: { input_tokens: 10, output_tokens: 5 },
    });
    expect(result).toMatchObject({
      status: "failed",
      telemetry: {
        finishReason: "max_turns",
        usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
      },
    });
  });

  it("omits max-turn usage telemetry when no usage was reported", async () => {
    const result = await runSyntheticGoalUsage({
      goalStatusesAfterTurns: ["active", "active"],
      goalUsageAfterTurns: [undefined, undefined],
    });
    expect(result).toMatchObject({
      status: "failed",
      telemetry: { finishReason: "max_turns" },
    });
    expect(result.telemetry).not.toHaveProperty("usage");
  });
});

async function runSyntheticGoalUsage(options: FakeAppServerFactoryOptions, resume = false, previousCheckpoint?: string) {
  const workspace = await mkdtemp(join(tmpdir(), "codex-app-goal-usage-test-"));
  const fakeFactory = new FakeAppServerFactory({
    goalStatusesAfterTurns: ["active", "complete"],
    ...options,
  });
  const driver = new CodexJsonAgentDriver({
    engine: new CodexAppServerExecutionEngine({
      codexBinaryPath: "/bin/codex-test",
      processFactory: fakeFactory.create,
      cleanThreadPrewarm: false,
      goalMode: true,
      maxGoalTurns: Math.max(2, options.goalStatusesAfterTurns?.length ?? 0),
    }),
    model: "gpt-test",
    reasoningEffort: "low",
  });
  try {
    const initial = await driver.runTask({
      ...(previousCheckpoint ? { logicalThread: { threadId: "fixture-logical-thread", previousCheckpoint, onCheckpoint: () => {} } } : {}),
      session: sessionArtifactFromCodexAuthJson(validAuthJson),
      task: {
        kind: "structured-prompt",
        ...(previousCheckpoint ? { execution: { mode: AgentRuntimeExecutionMode.Goal, completionCondition: "complete fixture" } } : {}),
        prompt: "measure cumulative goal usage",
        controls: { editMode: "allow-edits" },
      },
      workspace: { path: workspace },
      runner: new StaticRunner(""),
      redactor: new DefaultRedactor(),
      abortSignal: new AbortController().signal,
    });
    if (!resume || initial.status !== "waiting_for_input") return initial;
    return await driver.resumeManagedRun({
      session: sessionArtifactFromCodexAuthJson(validAuthJson),
      runId: initial.runId, requestId: initial.request.id, answer: "continue",
      resumeHandle: initial.resumeHandle,
      task: { controls: { editMode: "allow-edits" } },
      workspace: { path: workspace }, runner: new StaticRunner(""),
      redactor: new DefaultRedactor(), abortSignal: new AbortController().signal,
    });
  } finally {
    await driver.dispose();
    await rm(workspace, { recursive: true, force: true });
  }
}
