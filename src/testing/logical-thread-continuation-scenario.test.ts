import { describe, expect, it } from "vitest";

import { AgentRuntimeThreadOutcome } from "../agent-runtime-task/index.js";
import { evaluateLogicalThreadContinuation } from
  "./logical-thread-continuation-eval.js";
// @ts-expect-error The live harness scenario is a repository-only ESM module.
import { buildLogicalThreadContinuationRequests, runLogicalThreadContinuationScenario } from "../../scripts/e2e-live-workers/logical-thread-continuation-scenario.mjs";

const firstToken = "first-secret";
const longHorizonToken = "long-secret";
const secondToken = "second-secret";
const outcomes = {
  startedFresh: AgentRuntimeThreadOutcome.StartedFresh,
  continued: AgentRuntimeThreadOutcome.Continued,
};

describe("logical-thread continuation scenario", () => {
  it("wires exact request order, snapshots, output isolation, replay, and boundary", async () => {
    const scenario = await scriptedScenario();

    expect(scenario.requests.second.task.prompt).not.toContain(longHorizonToken);
    expect(scenario.requests.third.task.prompt).not.toContain(firstToken);
    expect(scenario.requests.third.task.prompt).not.toContain(longHorizonToken);
    expect(scenario.requests.third.task.prompt).not.toContain(secondToken);
    expect(scenario).toMatchObject({
      exactContextRecallChecks: [true, true],
      restartCount: 5,
      exactReplayChecks: [true, true, true],
      exactReplayProviderSideEffects: 0,
      restoredEffectRecovered: true,
      staleWorkspaceFailedClosed: true,
      forbiddenTokensAbsentFromWorkspaceSnapshots: true,
      longHorizonTokenAbsentFromRoundTwoOutput: true,
      workspaceBoundaryPreserved: true,
    });
    expect(score(scenario).passed).toBe(true);
  });

  it("rejects swapped requests before running a provider", async () => {
    const canonical = buildLogicalThreadContinuationRequests(planInput());
    await expect(scriptedScenario({
      requests: {
        first: canonical.first,
        second: canonical.third,
        third: canonical.second,
      },
    })).rejects.toThrow("exact round content and order");
  });

  it("fails the score when a forbidden token appears in a round snapshot", async () => {
    const scenario = await scriptedScenario({ snapshotLeak: true });
    expect(scenario.forbiddenTokensAbsentFromWorkspaceSnapshots).toBe(false);
    expect(score(scenario).passed).toBe(false);
  });

  it("fails the score when round two refreshes the long-horizon token", async () => {
    const scenario = await scriptedScenario({ roundTwoOutputRefresh: true });
    expect(scenario.longHorizonTokenAbsentFromRoundTwoOutput).toBe(false);
    expect(score(scenario).passed).toBe(false);
  });

  it("fails the score when the restored final file is corrupted", async () => {
    const scenario = await scriptedScenario({ corruptFinalFile: true });
    expect(scenario.workspaceBoundaryPreserved).toBe(false);
    expect(score(scenario).passed).toBe(false);
  });
});

type ScenarioOptions = {
  readonly requests?: Readonly<Record<"first" | "second" | "third", unknown>>;
  readonly snapshotLeak?: boolean;
  readonly roundTwoOutputRefresh?: boolean;
  readonly corruptFinalFile?: boolean;
};

async function scriptedScenario(options: ScenarioOptions = {}) {
  const files = new Map([
    ["round-one.txt", "pending\n"],
    ["context.txt", "unset\n"],
    ["round-three.txt", "unset\n"],
  ]);
  let calls = 0;
  let snapshotReads = 0;
  let providerInvocations = 0;
  const result = (
    round: number,
    outcome: AgentRuntimeThreadOutcome,
    outputText = "completed",
  ) => ({ round, outputText, thread: { outcome } });
  const first = result(1, outcomes.startedFresh);
  const second = result(
    2,
    outcomes.continued,
    options.roundTwoOutputRefresh ? longHorizonToken : "round two complete",
  );
  const third = result(3, outcomes.continued);
  const results = [first, first, second, second, third, third, { stale: true }, third];
  const canonical = buildLogicalThreadContinuationRequests(planInput());
  const expectedRequests = [
    canonical.first,
    canonical.first,
    canonical.second,
    canonical.second,
    canonical.third,
    canonical.third,
    canonical.third,
    canonical.third,
  ];

  return await runLogicalThreadContinuationScenario({
    ...planInput(),
    ...(options.requests === undefined ? {} : { requests: options.requests }),
    restart: async () => {},
    run: async (request: { executionId: string }) => {
      expect(request).toEqual(expectedRequests[calls]);
      calls += 1;
      if (calls === 1) {
        providerInvocations += 1;
        files.set("round-one.txt", "ready\n");
      } else if (calls === 3) {
        providerInvocations += 1;
        files.set("context.txt", `${firstToken}\n`);
      } else if (calls === 5) {
        providerInvocations += 1;
        files.set(
          "round-three.txt",
          `${firstToken}\n${longHorizonToken}\n${secondToken}\n`,
        );
      } else if (calls === 8 && options.corruptFinalFile) {
        files.set("round-three.txt", "corrupted\n");
      }
      return results[calls - 1];
    },
    assertCompleted: (
      actual: { thread: { outcome: AgentRuntimeThreadOutcome } },
      outcome: AgentRuntimeThreadOutcome,
    ) => expect(actual.thread.outcome).toBe(outcome),
    readWorkspaceFile: async (path: string) => files.get(path),
    readWorkspaceSnapshot: async () => {
      snapshotReads += 1;
      const snapshot = [...files.values()].join("");
      return options.snapshotLeak && snapshotReads <= 2
        ? `${snapshot}${longHorizonToken}`
        : snapshot;
    },
    writeWorkspaceFile: async (path: string, content: string) => {
      files.set(path, content);
    },
    resultOutputText: (actual: { outputText?: string }) =>
      actual.outputText ?? "",
    providerInvocationCount: () => providerInvocations,
    matchesStaleFailure: (actual: { stale?: boolean }) => actual.stale === true,
    observeFinalWorkspaceBoundary: async () =>
      files.get("round-one.txt") === "ready\n" &&
      files.get("context.txt") === `${firstToken}\n` &&
      files.get("round-three.txt") ===
        `${firstToken}\n${longHorizonToken}\n${secondToken}\n`,
  });
}

function planInput() {
  return {
    firstToken,
    longHorizonToken,
    secondToken,
    runIdPrefix: "offline",
    outcomes,
    createRequest: (request: {
      executionId: string;
      runId: string;
      prompt: string;
    }) => ({
      ...request,
      task: {
        prompt: request.prompt,
        execution: { mode: "goal" },
        controls: { maxTurns: 8 },
      },
    }),
  };
}

function score(scenario: Awaited<ReturnType<typeof scriptedScenario>>) {
  return evaluateLogicalThreadContinuation({
    expectedRounds: 3,
    completedRounds: 3,
    threadIds: ["thread", "thread", "thread"],
    executionIds: ["one", "two", "three"],
    outcomes: [outcomes.startedFresh, outcomes.continued, outcomes.continued],
    exactContextRecallChecks: scenario.exactContextRecallChecks,
    runnerRestartCount: scenario.restartCount,
    exactReplayChecks: scenario.exactReplayChecks,
    exactReplayProviderSideEffects: scenario.exactReplayProviderSideEffects,
    restoredEffectRecovered: scenario.restoredEffectRecovered,
    staleWorkspaceFailedClosed: scenario.staleWorkspaceFailedClosed,
    forbiddenTokensAbsentFromWorkspaceSnapshots:
      scenario.forbiddenTokensAbsentFromWorkspaceSnapshots,
    longHorizonTokenAbsentFromRoundTwoOutput:
      scenario.longHorizonTokenAbsentFromRoundTwoOutput,
    workspaceBoundaryPreserved: scenario.workspaceBoundaryPreserved,
  });
}
