import { access, readFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DefaultRedactor } from "@vioxen/subscription-runtime/core";
import {
  CodexAppServerExecutionEngine,
  CodexJsonAgentDriver,
  CodexModelBackend,
} from "../index";
import { FakeAppServerFactory } from "../app-server/testing/fake-app-server";
import { StaticRunner } from "./codex-provider-test-support";

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
  it("runs goal mode for the MiMo backend with session: null, injecting the API key via env and never touching auth.json", async () => {
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

      expect(result).toMatchObject({
        status: "failed",
        failure: {
          code: "provider_session_invalid",
          retryable: false,
          reconnectRequired: true,
        },
      });
      expect(fakeFactory.spawnCount).toBe(0);
    } finally {
      await driver.dispose();
    }
  });
});
