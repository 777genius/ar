import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  codexGoalAccountSlots,
  runCodexGoal,
  type CodexGoalExecutor,
} from "../codex-goal-runner";

describe("Codex goal objective", () => {
  it("keeps long instructions in the initial turn and generates a short objective", async () => {
    const prompt = [
      "Implement the synthetic task and preserve this acceptance marker.",
      "acceptance-marker ".repeat(300),
    ].join("\n");
    expect(prompt.length).toBeGreaterThan(4_000);
    const input = await captureCodexGoalRunInput({
      prompt,
      taskId: "task-long-prompt",
    });
    expect(input.prompt).toBe(prompt);
    expect(input.originalPrompt).toBe(prompt);
    expect(input.systemPrompt).toContain("Codex goal runtime artifact rule");
    expect(input.metadata?.codexGoalObjective).toContain("task task-long-prompt");
    expect(input.metadata?.codexGoalObjective).toContain("initial user message");
    expect(String(input.metadata?.codexGoalObjective).length).toBeLessThan(400);
    expect(input.metadata?.codexGoalObjective).not.toContain("acceptance-marker");
  });

  it("preserves an explicit Codex goal objective exactly", async () => {
    const objective = "  Explicit objective with intentional whitespace.\n  ";
    const input = await captureCodexGoalRunInput({
      prompt: "Full task instructions remain here.\n",
      taskId: "task-explicit-objective",
      codexGoalObjective: objective,
    });
    expect(input.metadata?.codexGoalObjective).toBe(objective);
  });

  it("uses only bounded goal summaries in generated objectives", async () => {
    const bounded = await captureCodexGoalRunInput({
      prompt: "Full bounded-summary instructions.\n",
      taskId: "task-bounded-summary",
      goalSummary: "  Deliver the bounded summary\nwith verification  ",
    });
    expect(bounded.metadata?.codexGoalObjective).toContain(
      "task task-bounded-summary: Deliver the bounded summary with verification",
    );
    const fallback = await captureCodexGoalRunInput({
      prompt: "Full fallback instructions.\n",
      taskId: "task-summary-fallback",
      goalSummary: "unbounded-summary-marker".repeat(40),
    });
    expect(fallback.metadata?.codexGoalObjective).toContain(
      "task task-summary-fallback",
    );
    expect(fallback.metadata?.codexGoalObjective).not.toContain(
      "unbounded-summary-marker",
    );
  });
});

async function captureCodexGoalRunInput(input: {
  readonly prompt: string;
  readonly taskId: string;
  readonly goalSummary?: string;
  readonly codexGoalObjective?: string;
}): Promise<Parameters<CodexGoalExecutor["run"]>[0]> {
  const root = await mkdtemp(join(tmpdir(), "subscription-runtime-goal-objective-"));
  const promptPath = join(root, "prompt.md");
  let captured: Parameters<CodexGoalExecutor["run"]>[0] | undefined;
  try {
    await mkdir(join(root, "job"), { recursive: true });
    await mkdir(join(root, "workspace"), { recursive: true });
    await writeFile(promptPath, input.prompt);
    await runCodexGoal({
      jobRootDir: join(root, "job"),
      authRootDir: join(root, "auth"),
      workspacePath: join(root, "workspace"),
      promptPath,
      taskId: input.taskId,
      accounts: codexGoalAccountSlots(["account-a"]),
      ...(input.goalSummary === undefined ? {} : { goalSummary: input.goalSummary }),
      ...(input.codexGoalObjective === undefined
        ? {}
        : { codexGoalObjective: input.codexGoalObjective }),
    }, {
      createExecutor: () => ({
        async run(runInput) {
          captured = runInput;
          return {
            status: "completed",
            attempts: [],
            task: { outputText: "done" },
          } as never;
        },
        async dispose() {},
      }),
    });
    if (captured === undefined) throw new Error("executor input was not captured");
    return captured;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
