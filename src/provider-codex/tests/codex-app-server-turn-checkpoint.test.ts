import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DefaultRedactor } from "@vioxen/subscription-runtime/core";
import { CodexAppServerExecutionEngine, CodexJsonAgentDriver, sessionArtifactFromCodexAuthJson } from "../index";
import type { AppServerCompletedTurnCheckpoint } from "../index";
import { FakeAppServerFactory } from "../app-server/testing/fake-app-server";
import { RecordingManagedRunStore, StaticRunner, validAuthJson } from "./codex-provider-test-support";
import { AppServerUsageError } from "../app-server/domain/app-server-usage-error";
import { AppServerTurnCheckpointError } from "../app-server/application/app-server-turn-checkpoint";
import { CodexAppServerTurnError } from "../app-server/application/app-server-turn-failure";
import { CodexAppServerRateLimitsRejectedError } from "../app-server/application/app-server-rate-limits-monitor";
import { CodexModelUnavailableError } from "../app-server/domain/model-catalog";
import { classifyCodexFailure } from "../failure-classifier";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function run(factory: FakeAppServerFactory, completedTurnCheckpoint?: AppServerCompletedTurnCheckpoint) {
  const workspace = await mkdtemp(join(tmpdir(), "codex-turn-boundary-"));
  roots.push(workspace);
  const driver = new CodexJsonAgentDriver({
    engine: new CodexAppServerExecutionEngine({ codexBinaryPath: "/bin/codex-test", processFactory: factory.create,
      cleanThreadPrewarm: false, goalMode: true, ...(completedTurnCheckpoint ? { completedTurnCheckpoint } : {}) }),
    model: "gpt-test", reasoningEffort: "low",
  });
  try {
    return await driver.runTask({
      session: sessionArtifactFromCodexAuthJson(validAuthJson),
      task: { kind: "structured-prompt", prompt: "finish task", controls: { editMode: "allow-edits" } },
      workspace: { path: workspace }, runner: new StaticRunner(""), redactor: new DefaultRedactor(),
      abortSignal: new AbortController().signal,
    });
  } finally { await driver.dispose(); }
}

describe("completed Codex turn checkpoint boundary", () => {
  it("holds the next turn until the first acknowledgement", async () => {
    const factory = new FakeAppServerFactory({ goalStatusesAfterTurns: ["active", "complete"] });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const firstEntered = new Promise<void>((resolve) => { entered = resolve; });
    const ordinals: number[] = [];
    const pending = run(factory, async (turn) => { ordinals.push(turn.turnNumber); if (turn.turnNumber === 1) { entered(); await gate; } });
    await firstEntered;
    expect(factory.requests.filter((request) => request.method === "turn/start")).toHaveLength(1);
    release();
    await expect(pending).resolves.toMatchObject({ status: "completed" });
    expect(ordinals).toEqual([1, 2]);
    expect(factory.requests.filter((request) => request.method === "turn/start")).toHaveLength(2);
  });

  it("prevents the next turn and reports a nonretryable failure", async () => {
    const factory = new FakeAppServerFactory({ goalStatusesAfterTurns: ["active", "complete"] });
    const result = await run(factory, async () => { throw new Error("offsite unavailable"); });
    expect(result).toMatchObject({ status: "failed", failure: { code: "checkpoint_unprotected", retryable: false } });
    expect(factory.requests.filter((request) => request.method === "turn/start")).toHaveLength(1);
  });

  it("leaves opt-out two-turn goals unchanged", async () => {
    const factory = new FakeAppServerFactory({ goalStatusesAfterTurns: ["active", "complete"] });
    await expect(run(factory)).resolves.toMatchObject({ status: "completed" });
    expect(factory.requests.filter((request) => request.method === "turn/start")).toHaveLength(2);
  });

  it("persists a nonretryable checkpoint failure on managed-run resume", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-turn-resume-checkpoint-"));
    roots.push(workspace);
    const runStore = new RecordingManagedRunStore();
    const factory = new FakeAppServerFactory({ goalStatusesAfterTurns: ["blocked", "complete"] });
    let checkpointCount = 0;
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({ codexBinaryPath: "/bin/codex-test",
        processFactory: factory.create, cleanThreadPrewarm: false, goalMode: true,
        runStore, completedTurnCheckpoint: async () => {
          if (++checkpointCount === 2) throw new Error("offsite unavailable");
        } }),
      model: "gpt-test", reasoningEffort: "low",
    });
    try {
      const waiting = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "structured-prompt", prompt: "finish task",
          controls: { editMode: "allow-edits" }, metadata: { codexManagedRunId: "checkpoint-resume-1" } },
        workspace: { path: workspace }, runner: new StaticRunner(""), redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });
      if (waiting.status !== "waiting_for_input") throw new Error("expected waiting result");
      const failed = await driver.resumeManagedRun({
        session: sessionArtifactFromCodexAuthJson(validAuthJson), runId: waiting.runId,
        requestId: waiting.request.id, answer: "continue", resumeHandle: waiting.resumeHandle,
        task: { controls: { editMode: "allow-edits" } }, workspace: { path: workspace },
        runner: new StaticRunner(""), redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });
      expect(failed).toMatchObject({ status: "failed",
        failure: { code: "checkpoint_unprotected", retryable: false } });
      expect(await runStore.get({ runId: waiting.runId })).toMatchObject({ status: "failed",
        failure: { code: "checkpoint_unprotected", retryable: false } });
    } finally { await driver.dispose(); }
  });

  it("unwraps usage errors for checkpoint and ordinary failure classification", () => {
    expect(classifyCodexFailure(new AppServerUsageError(
      new AppServerTurnCheckpointError(new Error("offsite unavailable")), undefined, true,
    ))).toMatchObject({ code: "checkpoint_unprotected", retryable: false });
    expect(classifyCodexFailure(new AppServerUsageError(
      Object.assign(new Error("codex_app_server_goal_max_turns_exceeded:20"),
        { lastOutputText: "app-server output:continue the task" }), undefined, true,
    ))).toMatchObject({ code: "goal_slice_exhausted", retryable: true,
      details: { lastOutputTail: "app-server output:continue the task" } });
    expect(classifyCodexFailure(new AppServerUsageError(
      new Error("quota_limited"), undefined, true,
    ))).toMatchObject({ code: "unknown_runtime_failure", retryable: true });
    expect(classifyCodexFailure(new AppServerUsageError(
      new CodexAppServerTurnError({ cause: new Error("turn failed"),
        phase: "turn_error_after_output", turnNumber: 3,
        outputText: "partial output", elapsedMs: 42 }), undefined, true,
    ))).toMatchObject({ details: { phase: "turn_error_after_output",
      turnNumber: "3", outputObserved: "true", outputCharCount: "14",
      elapsedMs: "42" } });
    expect(classifyCodexFailure(new AppServerUsageError(
      new CodexAppServerRateLimitsRejectedError("quota_limited"), undefined, true,
    ))).toMatchObject({ code: "quota_limited", retryable: true });
    expect(classifyCodexFailure(new AppServerUsageError(
      new CodexModelUnavailableError({ requestedModel: "gpt-test",
        availableModels: [{ model: "gpt-available", displayName: "Available",
          hidden: false, isDefault: true, supportedReasoningEfforts: ["low"] }] }),
      undefined, true,
    ))).toMatchObject({ code: "model_unavailable", retryable: true,
      details: { requestedModel: "gpt-test", availableModels: "gpt-available" } });
  });
});
