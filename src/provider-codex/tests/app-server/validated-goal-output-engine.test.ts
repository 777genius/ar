import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultRedactor } from "@vioxen/subscription-runtime/core";
import { CodexAppServerExecutionEngine, type AppServerCompletedGoalOutputValidator,
  type CodexAppServerExecutionEngineOptions } from "../../codex-app-server-execution-engine";
import { CodexModelBackend } from "../../codex-model-backend";
import type { CodexExecutionInput } from "../../codex-json-execution-engine";
import { InMemoryManagedRunStore } from "../../codex-app-server-managed-run-store";
import { FakeAppServerFactory } from "../../app-server/testing/fake-app-server";
import { FileBackendCodexWorker } from "../../../worker-codex/file-backend-codex-worker";
import { StaticRunner } from "../codex-provider-test-support";

// Synthetic completed turns only: no real CLI, provider request or credential.
const candidateIds = ["TEST-a", "TEST-b", "TEST-c", "TEST-d"];
const schema = {
  type: "object", additionalProperties: false, required: ["presentations"],
  properties: { presentations: { type: "array", minItems: 4, maxItems: 4,
    items: { type: "object", additionalProperties: false, required: ["candidateId", "text"],
      properties: { candidateId: { type: "string" }, text: { type: "string", maxLength: 119 } } } } },
};
const accepted = { presentations: candidateIds.map(candidateId => ({ candidateId, text: "TEST accepted output" })) };
const acceptExactIds: AppServerCompletedGoalOutputValidator = output => {
  const presentations = (output as typeof accepted).presentations;
  const ids = presentations.map(item => item.candidateId);
  return ids.length === candidateIds.length && new Set(ids).size === ids.length &&
    ids.every(id => candidateIds.includes(id));
};

describe("strict accepted output through the Goal engine and worker factory", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const dispose of cleanup.splice(0).reverse()) await dispose();
  });

  async function workspace(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "TEST-validated-goal-output-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    return root;
  }

  async function fixture(output: unknown = accepted, validator: AppServerCompletedGoalOutputValidator | undefined = acceptExactIds,
    goalStatus = "active") {
    const root = await workspace();
    const text = typeof output === "string" ? output : JSON.stringify(output);
    const factory = new FakeAppServerFactory({ agentMessageDeltas: [text], completedAgentMessageText: text,
      goalStatusesAfterTurns: [goalStatus] });
    const runStore = new InMemoryManagedRunStore();
    const engine = new CodexAppServerExecutionEngine({ codexBinaryPath: "/TEST/fake-codex", sourceEnv: {},
      processFactory: factory.create, goalMode: true, cleanThreadPrewarm: false, maxGoalTurns: 1, runStore,
      modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
      ...(validator === undefined ? {} : { completedGoalOutputValidator: validator }) });
    cleanup.push(() => engine.dispose());
    const input: CodexExecutionInput = { runId: "TEST-validated-output", prompt: "Prepare the four TEST presentations",
      goalObjective: "Prepare exactly four accepted TEST presentations", workspacePath: root,
      model: "mimo-v2.6-pro", reasoningEffort: "none", sandboxMode: "read-only",
      outputSchema: { name: "TEST-presentations", schema },
      session: { home: root, codexHome: root, env: { CODEX_HOME: root }, release: async () => undefined },
      runner: new StaticRunner(""), redactor: new DefaultRedactor(), abortSignal: new AbortController().signal };
    return { factory, runStore, engine, input };
  }

  const completeSetters = (factory: FakeAppServerFactory) => factory.requests.filter(request =>
    request.method === "thread/goal/set" && request.params?.status === "complete");

  it("delivers normalized strict output to acceptance and settles the same native Goal in one turn", async () => {
    const validator = vi.fn(acceptExactIds);
    const f = await fixture(accepted, validator);
    const result = await f.engine.run(f.input);
    expect(result.structuredOutput).toEqual(accepted);
    expect(validator).toHaveBeenCalledExactlyOnceWith(accepted, { runId: f.input.runId, turnNumber: 1 });
    expect(f.factory.requests.filter(request => request.method === "turn/start")).toHaveLength(1);
    expect(completeSetters(f.factory)).toHaveLength(1);
    const setter = completeSetters(f.factory)[0]!;
    expect(setter.params).toMatchObject({ threadId: "thread-1", objective: f.input.goalObjective, status: "complete" });
    const afterSetter = f.factory.requests.slice(f.factory.requests.indexOf(setter) + 1);
    expect(afterSetter.some(request => request.method === "thread/goal/get")).toBe(true);
    expect((await f.runStore.get({ runId: f.input.runId! }))?.status).toBe("completed");
  });

  it.each([
    ["missing root", { candidates: accepted.presentations }],
    ["wrong root type", { presentations: "TEST-not-an-array" }],
    ["extra property", { ...accepted, unexpected: true }],
    ["invalid item", { presentations: accepted.presentations.map(item => ({ ...item, text: 42 })) }],
    ["invalid JSON", "TEST-no-JSON"],
  ])("rejects %s before host acceptance or native completion", async (_label, output) => {
    const validator = vi.fn(acceptExactIds);
    const f = await fixture(output, validator);
    await expect(f.engine.run(f.input)).rejects.toThrow("codex_goal_completed_output_rejected");
    expect(validator).not.toHaveBeenCalled();
    expect(completeSetters(f.factory)).toHaveLength(0);
    expect(f.factory.requests.filter(request => request.method === "turn/start")).toHaveLength(1);
    expect((await f.runStore.get({ runId: f.input.runId! }))?.status).not.toBe("completed");
  });

  it.each([false, "true", undefined])("requires literal true from the trusted predicate (%s)", async result => {
    const validator = vi.fn(async () => result) as unknown as AppServerCompletedGoalOutputValidator;
    const f = await fixture(accepted, validator);
    await expect(f.engine.run(f.input)).rejects.toThrow("codex_goal_completed_output_rejected");
    expect(completeSetters(f.factory)).toHaveLength(0);
    expect(f.factory.requests.filter(request => request.method === "turn/start")).toHaveLength(1);
  });

  it("rejects duplicate or unexpected IDs even when the named JSON schema passes", async () => {
    for (const id of ["TEST-a", "TEST-unrequested"]) {
      const output = { presentations: accepted.presentations.map((item, index) => index === 3 ? { ...item, candidateId: id } : item) };
      const validator = vi.fn(acceptExactIds);
      const f = await fixture(output, validator);
      await expect(f.engine.run(f.input)).rejects.toThrow("codex_goal_completed_output_rejected");
      expect(validator).toHaveBeenCalledOnce();
      expect(completeSetters(f.factory)).toHaveLength(0);
    }
  });

  it("refuses missing named schema before starting an app-server process", async () => {
    const f = await fixture();
    const { outputSchema: _schema, ...input } = f.input;
    await expect(f.engine.run(input)).rejects.toThrow("codex_goal_output_validator_requires_schema");
    expect(f.factory.spawnCount).toBe(0);
  });

  it("preserves model-owned completion when the callback is absent", async () => {
    // Explicitly construct absence: the fixture default intentionally supplies acceptance.
    const f = await fixture(accepted, acceptExactIds, "complete");
    await f.engine.dispose();
    const engine = new CodexAppServerExecutionEngine({ codexBinaryPath: "/TEST/fake-codex", sourceEnv: {},
      processFactory: f.factory.create, goalMode: true, cleanThreadPrewarm: false, maxGoalTurns: 1,
      modelBackend: CodexModelBackend.XiaomiMimoTokenPlan });
    cleanup.push(() => engine.dispose());
    expect((await engine.run(f.input)).structuredOutput).toEqual(accepted);
    expect(completeSetters(f.factory)).toHaveLength(0);
  });

  it("refuses logical-thread and resume entrypoints before provider startup", async () => {
    const f = await fixture();
    await expect(f.engine.runLogicalThread(f.input)).rejects.toThrow("validated_goal_output_one_shot_only");
    await expect(f.engine.resume({ ...f.input, runId: "TEST-resume", requestId: "TEST-request", answer: "TEST-answer",
      resumeHandle: { runId: "TEST-resume", providerId: "codex", threadId: "TEST-thread", workspacePath: f.input.workspacePath } }))
      .rejects.toThrow("validated_goal_output_one_shot_only");
    expect(f.factory.spawnCount).toBe(0);
  });

  it("rejects fallback, non-Goal and child profiles before process startup", () => {
    const factory = new FakeAppServerFactory();
    const base: CodexAppServerExecutionEngineOptions = { codexBinaryPath: "/TEST/fake-codex", sourceEnv: {},
      processFactory: factory.create, goalMode: true, completedGoalOutputValidator: acceptExactIds };
    for (const override of [{ goalMode: false }, { childBudget: {} }, { executionLifetime: {} },
      { hostedControllerTools: {} }, { fallback: {} }]) {
      expect(() => new CodexAppServerExecutionEngine({ ...base, ...override } as CodexAppServerExecutionEngineOptions))
        .toThrow("codex_goal_output_validator_profile_invalid");
    }
    expect(factory.spawnCount).toBe(0);
  });

  it("forwards trusted acceptance through the actual MiMo worker factory and registered schema", async () => {
    const root = await workspace();
    const validator = vi.fn(acceptExactIds);
    const text = JSON.stringify(accepted);
    const factory = new FakeAppServerFactory({ agentMessageDeltas: [text], completedAgentMessageText: text,
      goalStatusesAfterTurns: ["active"] });
    const worker = new FileBackendCodexWorker({ providerInstanceId: "TEST-mimo-validator",
      stateRootDir: join(root, "state"), workspacePath: root, codexBinaryPath: "/TEST/fake-codex",
      encryptionKey: new Uint8Array(32).fill(7), modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
      model: "mimo-v2.6-pro", reasoningEffort: "none", executionEngine: "app-server-goal",
      sourceEnv: { MIMO_TOKEN_PLAN_API_KEY: "TEST-dummy-not-a-provider-key" },
      boundedWorkspaceTools: { allowedTools: [], denyProjectInstructions: true },
      appServerProcessFactory: factory.create, warmupPrompt: false, cleanThreadPrewarm: false,
      maxGoalTurns: 1, outputSchemas: { "TEST-presentations": schema }, completedGoalOutputValidator: validator });
    cleanup.push(() => worker.dispose());
    await worker.start();
    const result = await worker.run({ runId: "TEST-worker-validator", prompt: "Prepare four TEST presentations",
      outputSchemaName: "TEST-presentations", metadata: { codexGoalObjective: "Prepare accepted TEST presentations" } });
    expect(result.structuredOutput).toEqual(accepted);
    expect(validator).toHaveBeenCalledExactlyOnceWith(accepted, { runId: "TEST-worker-validator", turnNumber: 1 });
    expect(factory.requests.filter(request => request.method === "turn/start")).toHaveLength(1);
    expect(completeSetters(factory)).toHaveLength(1);
    expect(factory.requests.find(request => request.method === "thread/start")?.params?.config)
      .toMatchObject({ features: { goals: true, shell_tool: false, unified_exec: false } });
  });
});
