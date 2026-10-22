import { access, readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DefaultRedactor } from "@vioxen/subscription-runtime/core";
import {
  CodexAppServerExecutionEngine,
  CodexJsonAgentDriver,
  CodexModelBackend,
} from "../index";
import { FakeAppServerFactory } from "../app-server/testing/fake-app-server";
import { StaticRunner } from "./codex-provider-test-support";
import { HostedMimoCodingProxyOwner } from "../hosted-mimo-coding-proxy-material";
import * as mimoOrigin from "../hosted-mimo-worker-origin";
import { HostedMimoProfile } from "../hosted-mimo-profile";
import { AppServerExecutionLifetime } from "../app-server/application/app-server-child-lifetime";
import { codexExecutionFailure } from "../codex-json-execution-engine";

/**
 * Proves the MiMo backend runs the first-class goal path
 * (CodexJsonAgentDriver + CodexAppServerExecutionEngine with goalMode: true)
 * through the exact same app-server protocol as ChatGPT goal runs, with
 * `session: null` — no SessionArtifact, no auth.json read, no refresh logic
 * anywhere in the path. Mirrors "runs first-class Codex goal mode through
 * the app-server protocol" in codex-provider-app-server-goal.test.ts, but
 * for the MiMo backend.
 */
describe("Codex JSON agent driver — MiMo backend through the app-server goal path", () => {
  it("adds proxy-owned start facts only to failure details and ignores an observation failure", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "TEST-mimo-proxy-failure-details-"));
    const original = new Error("TEST existing provider failure"), facts = {
      mimoProxyStartUpstreamHttpFailureCount: "2", mimoProxyStartLastUpstreamStatus: "503" };
    const observation = vi.spyOn(HostedMimoCodingProxyOwner.prototype, "failureDetails");
    try {
      for (const failObservation of [false, true]) {
        if (failObservation) observation.mockImplementation(() => { throw Error("TEST private diagnostic failure"); });
        else observation.mockReturnValue(facts);
        const factory = new FakeAppServerFactory(), driver = new CodexJsonAgentDriver({
          engine: new CodexAppServerExecutionEngine({ codexBinaryPath: "/TEST/never-start", modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
            processFactory: factory.create, goalMode: true, cleanThreadPrewarm: false }),
          modelBackend: CodexModelBackend.XiaomiMimoTokenPlan, sourceEnv: { MIMO_TEST_KEY: "TEST-proxy-facts-fake-key" }, mimoApiKeyEnvVarName: "MIMO_TEST_KEY" });
        const redactor = new DefaultRedactor();
        try {
          const result = await driver.runTask({ session: null, task: { kind: "structured-prompt", prompt: "TEST no provider call" },
            workspace: { path: workspace }, runner: new StaticRunner(""), redactor, abortSignal: new AbortController().signal,
            onTaskStarted: () => { throw original; } });
          const expected = codexExecutionFailure(original, redactor);
          expect(result.status).toBe("failed");
          if (result.status !== "failed") throw Error("TEST expected failed result");
          expect(result.failure).toEqual(failObservation ? expected.failure : { ...expected.failure,
            details: { ...expected.failure.details, ...facts } });
          expect(factory.spawnCount).toBe(0);
        } finally { await driver.dispose(); }
      }
    } finally { observation.mockRestore(); await rm(workspace, { recursive: true, force: true }); }
  });
  it("runs goal mode for the MiMo backend with session: null, injecting the API key via env and never touching auth.json", async () => {
    const observation = vi.spyOn(HostedMimoCodingProxyOwner.prototype, "failureDetails").mockImplementation(() => { throw Error("TEST success must not read failure diagnostics"); });
    const workspace = await mkdtemp(join(tmpdir(), "codex-mimo-app-goal-test-"));
    const fakeFactory = new FakeAppServerFactory();
    // The driver deletes its temp CODEX_HOME as soon as runTask() returns, so
    // config.toml/auth.json must be inspected while the process is "alive" —
    // kick these reads off inside the process factory itself (which fires
    // after materializeMimoSession() has already written config.toml and
    // before release() runs) and await the results after the run completes.
    let codexHome: string | undefined;
    let configTomlPromise: Promise<string> | undefined;
    let authJsonExistsPromise: Promise<boolean> | undefined;
    const processFactory = (input: Parameters<typeof fakeFactory.create>[0]) => {
      const home = input.env.CODEX_HOME;
      if (!home) throw new Error("mimo_goal_test_codex_home_missing_in_env");
      codexHome = home;
      configTomlPromise = readFile(join(home, "config.toml"), "utf8");
      authJsonExistsPromise = access(join(home, "auth.json")).then(
        () => true,
        () => false,
      );
      return fakeFactory.create(input);
    };
    const boundedConfigToml = [
      "[mcp_servers.agent_runtime_workspace]",
      'enabled_tools = ["read_file"]',
      "shell_tool = false",
      "unified_exec = false",
      "[model_providers.mimo]",
      'env_key = "MIMO_TEST_TOKEN_PLAN_KEY"',
    ].join("\n");
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
        processFactory,
        cleanThreadPrewarm: false,
        goalMode: true,
        nativeToolSurface: "disabled",
        executionProfile: {
          kind: "custom",
          developerInstructions:
            "Use only the agent_runtime_workspace MCP tools exposed for this task.",
          disableTools: false,
          historyMode: "none",
        },
      }),
      model: "mimo-test-model",
      reasoningEffort: "low",
      modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
      mimoApiKeyEnvVarName: "MIMO_TEST_TOKEN_PLAN_KEY",
      mimoConfigToml: boundedConfigToml,
      sourceEnv: { MIMO_TEST_TOKEN_PLAN_KEY: "tp-fake-test-key-value" },
    });

    try {
      const result = await driver.runTask({
        session: null,
        task: {
          kind: "structured-prompt",
          prompt: "finish the benchmark goal with full instructions",
          metadata: {
            codexGoalObjective: "short benchmark goal",
          },
          controls: { editMode: "allow-edits" },
        },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        status: "completed",
        outputText:
          "app-server output:finish the benchmark goal with full instructions",
      });
      expect(result).not.toHaveProperty("failure"); expect(observation).not.toHaveBeenCalled();
      // Went through the real goal protocol, exactly like the ChatGPT path.
      expect(fakeFactory.requests.map((request) => request.method)).toEqual(
        expect.arrayContaining([
          "thread/start",
          "thread/goal/set",
          "turn/start",
          "thread/goal/get",
        ]),
      );
      const threadStart = fakeFactory.requests.find(
        (request) => request.method === "thread/start",
      );
      expect(threadStart?.params).toMatchObject({
        environments: [],
        config: {
          features: {
            shell_tool: false,
            unified_exec: false,
          },
          tools: { view_image: false },
        },
      });
      expect(threadStart?.params).not.toHaveProperty("dynamicTools");

      // The credential reached the spawned process via env, never via a
      // file on disk.
      expect(fakeFactory.envs).toHaveLength(1);
      expect(fakeFactory.envs[0]?.MIMO_TEST_TOKEN_PLAN_KEY).toBe(
        "tp-fake-test-key-value",
      );

      expect(codexHome).toBeTruthy();
      expect(fakeFactory.codexHomes[0]).toBe(codexHome);

      // config.toml carries the MiMo model_providers fragment.
      const configToml = await configTomlPromise;
      expect(configToml).toBe(boundedConfigToml);
      expect(configToml).toContain("[model_providers.mimo]");
      expect(configToml).toContain('env_key = "MIMO_TEST_TOKEN_PLAN_KEY"');
      expect(configToml).toContain("[mcp_servers.agent_runtime_workspace]");
      expect(configToml).toContain("shell_tool = false");

      // No auth.json was ever written for this backend — MiMo is a static
      // API key, never a ChatGPT OAuth session artifact.
      expect(await authJsonExistsPromise).toBe(false);
    } finally {
      observation.mockRestore();
      await driver.dispose();
    }
  });

  it("fails closed with a clear, non-retryable error when the MiMo env var is missing, instead of silently running with no credential", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-mimo-app-goal-missing-key-"));
    const fakeFactory = new FakeAppServerFactory();
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
        processFactory: fakeFactory.create,
        cleanThreadPrewarm: false,
        goalMode: true,
      }),
      model: "mimo-test-model",
      modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
      mimoApiKeyEnvVarName: "MIMO_TEST_TOKEN_PLAN_KEY_MISSING",
      sourceEnv: {},
    });

    try {
      const result = await driver.runTask({
        session: null,
        task: {
          kind: "structured-prompt",
          prompt: "should never reach the app-server",
          controls: { editMode: "allow-edits" },
        },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      // The missing env key must fail closed for this run without claiming an
      // invalid provider session: that claim poisons the shared account
      // capacity record (disabled, never rechecked) for every later run.
      expect(result).toMatchObject({
        status: "failed",
        failure: {
          code: "provider_runtime_unavailable",
          retryable: false,
          reconnectRequired: false,
        },
      });
      expect(fakeFactory.spawnCount).toBe(0);
    } finally {
      await driver.dispose();
    }
  });
});


it("passes the source-only recovery binder before hosted Coding materialization and exposes its retained proof", async () => {
  const lifetime = new AppServerExecutionLifetime({ deadlineEpochMs: Date.now() + 10000, maxGoalTurns: 1,
    binding: { allocationId: "TEST", incarnationId: "TEST-recovery-binding" } });
  const origin = {} as mimoOrigin.HostedMimoCodingWorkerOrigin;
  const profile = vi.spyOn(mimoOrigin, "readHostedMimoWorkerProfileOrigin").mockReturnValue({ profile: HostedMimoProfile.CodingV1, origin });
  const acquire = vi.spyOn(HostedMimoCodingProxyOwner.prototype, "acquire").mockRejectedValue(Error("TEST recovery binding denied"));
  const proof = Object.freeze({ credentialFingerprint: "a".repeat(64), requestedModel: "mimo-v2.6-pro",
    requestSha256: "b".repeat(64), responseIdSha256: "c".repeat(64), completedResponses: 2,
    assertCurrent() {}, assertDisposed() {} });
  const observation = vi.spyOn(HostedMimoCodingProxyOwner.prototype, "capacityRecoveryProof").mockReturnValue(proof);
  const bind = vi.fn(async () => () => {}), factory = new FakeAppServerFactory();
  const engine = new CodexAppServerExecutionEngine({ codexBinaryPath: "/TEST/never-start", processFactory: factory.create,
    modelBackend: CodexModelBackend.XiaomiMimoTokenPlan, goalMode: true, nativeToolSurface: "disabled",
    executionLifetime: lifetime, maxGoalTurns: 1, cleanThreadPrewarm: false });
  const driver = new CodexJsonAgentDriver({ engine, executionLifetime: lifetime, modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
    sourceEnv: { SUBSCRIPTION_RUNTIME_SANDBOX_KIND: "hosted-codex-job" }, bindMimoCapacityRecoveryCredential: bind });
  try {
    const result = await driver.runTask({ session: null, task: { kind: "structured-prompt", prompt: "TEST no provider call" },
      workspace: { path: "/TEST/never-open" }, runner: new StaticRunner(""), redactor: new DefaultRedactor(),
      abortSignal: new AbortController().signal });
    expect(result.status).toBe("failed");
    expect(acquire).toHaveBeenCalledWith(expect.objectContaining({ origin, lifetime, bindCapacityRecoveryCredential: bind }));
    expect(factory.spawnCount).toBe(0);
    expect(driver.capacityRecoveryProof()).toBe(proof);
  } finally { await driver.dispose(); observation.mockRestore(); acquire.mockRestore(); profile.mockRestore(); }
});
