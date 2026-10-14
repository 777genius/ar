import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentRuntimeTool, DefaultRedactor } from "@vioxen/subscription-runtime/core";
import { AgentRuntimeAccessBoundary as AccessBoundary } from "@vioxen/subscription-runtime/core";
import { ChildContinuationMode, ChildExecutionBudget, parseChildLifetime } from "@vioxen/subscription-runtime/core";
import { CodexAppServerExecutionEngine } from "../codex-app-server-execution-engine";
import { FakeAppServerFactory, type FakeAppServerFactoryOptions } from "../app-server/testing/fake-app-server";
import { StaticRunner } from "./codex-provider-test-support";
async function setup(options: FakeAppServerFactoryOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "pr3-TEST-child-transport-"));
  const lifetime = parseChildLifetime({ schemaVersion: 1, accountId: "inventory-s", deadlineEpochMs: Date.now() + 10000,
    maxGoalTurns: 2, maxAccountCycles: 1, maxAttempts: 1, continuationMode: ChildContinuationMode.Disabled,
    denyProjectInstructions: true, accessBoundary: AccessBoundary.ReadOnly, allowedTools: [AgentRuntimeTool.ReadFile] });
  const budget = new ChildExecutionBudget(lifetime), factory = new FakeAppServerFactory(options);
  const engine = new CodexAppServerExecutionEngine({ codexBinaryPath: "/fake/test-codex", childBudget: budget,
    goalMode: true, maxGoalTurns: 2, nativeToolSurface: "disabled", cleanThreadPrewarm: false,
    timeoutMs: 2000, processFactory: factory.create,
    commandApprovalPolicy: { reviewCommand: () => ({ approved: true }) } });
  const input = { prompt: "Synthetic unfinished test", model: "test-model", reasoningEffort: "low" as const,
    workspacePath: root, redactor: new DefaultRedactor(), runner: new StaticRunner(""), abortSignal: new AbortController().signal,
    session: { home: root, codexHome: root, env: { CODEX_HOME: root }, release: async () => undefined } };
  return { engine, factory, budget, input, close: async () => { await engine.dispose(); await rm(root, { recursive: true, force: true }); } };
}
describe("child transport budget", () => {
  // Bug: an ambiguous write restores authority or a later invocation starts another provider/thread.
  it("consumes a real failed turn/start write and refuses another invocation", async () => {
    const f = await setup({ throwOnRequestMethod: "turn/start" });
    try {
      await expect(f.engine.run(f.input)).rejects.toThrow();
      expect(f.budget.consumedTurns).toBe(1);
      expect(f.factory.spawnCount).toBe(1);
      await expect(f.engine.run(f.input)).rejects.toThrow("child_invocation_consumed");
      expect(f.factory.spawnCount).toBe(1);
      expect(f.factory.requests.filter(r => r.method === "thread/start")).toHaveLength(1);
    } finally { await f.close(); }
  });
  // Bug: a command policy capable of approving read commands reopens native shell in a bounded child.
  it("denies native approval even when an injected command policy would accept it", async () => {
    const f = await setup({ emitServerRequestOnTurn: { method: "item/commandExecution/requestApproval", params: { command: "cat README.md" } } });
    try {
      await f.engine.run(f.input);
      expect(f.factory.responses[0]?.result).toEqual({ decision: "decline" });
      expect(f.factory.requests.find(r => r.method === "thread/start")?.params?.environments).toEqual([]);
    } finally { await f.close(); }
  });
  // Bug: prewarm or logical continuation starts a provider before the child invocation gate.
  it("refuses prewarm and logical recovery with no process creation", async () => {
    const f = await setup();
    try {
      await expect(f.engine.prewarm(f.input)).rejects.toThrow("child_prewarm_denied");
      await expect(f.engine.runLogicalThread({ ...f.input, previousCheckpoint: "old-thread" })).rejects.toThrow("child_continuation_denied");
      await expect(f.engine.resume({ ...f.input, runId: "TEST", requestId: "TEST", answer: "continue",
        resumeHandle: { runId: "TEST", providerId: "codex", workspacePath: f.input.workspacePath } })).rejects.toThrow("child_continuation_denied");
      expect(f.factory.spawnCount).toBe(0);
      expect(f.factory.requests).toEqual([]);
    } finally { await f.close(); }
  });
});
