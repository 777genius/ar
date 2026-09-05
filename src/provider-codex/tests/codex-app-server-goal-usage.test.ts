import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DefaultRedactor } from "@vioxen/subscription-runtime/core";
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

async function runSyntheticGoalUsage(options: FakeAppServerFactoryOptions) {
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
      maxGoalTurns: 2,
    }),
    model: "gpt-test",
    reasoningEffort: "low",
  });
  try {
    return await driver.runTask({
      session: sessionArtifactFromCodexAuthJson(validAuthJson),
      task: {
        kind: "structured-prompt",
        prompt: "measure cumulative goal usage",
        controls: { editMode: "allow-edits" },
      },
      workspace: { path: workspace },
      runner: new StaticRunner(""),
      redactor: new DefaultRedactor(),
      abortSignal: new AbortController().signal,
    });
  } finally {
    await driver.dispose();
    await rm(workspace, { recursive: true, force: true });
  }
}
