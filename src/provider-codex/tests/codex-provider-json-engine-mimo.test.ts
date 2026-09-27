import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DefaultRedactor } from "@vioxen/subscription-runtime/core";
import {
  CodexJsonAgentDriver,
  CodexModelBackend,
  buildCodexJsonExecArgs,
  codexMimoTokenPlanEgressPolicy,
} from "../index";
import type { CodexExecutionEngine } from "../codex-json-execution-engine";
import { StaticRunner } from "./codex-provider-test-support";

function streamingEngine(
  run: (input: Parameters<CodexExecutionEngine["run"]>[0]) => void,
): CodexExecutionEngine {
  return {
    kind: "streaming-test",
    capabilities: {
      supportsStructuredOutput: false,
      supportsJsonEvents: true,
      supportsThreadResume: false,
      requiresSchemaFile: false,
    },
    async run(input) {
      run(input);
      return { outputText: "safe output", warnings: [] };
    },
  };
}

describe("Codex provider adapter - MiMo backend", () => {
  it("gives packaged JSON exec the MiMo model provider and strips ChatGPT-only config", () => {
    const args = buildCodexJsonExecArgs({
      jsonFlag: "--json",
      modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
      providerEgressPolicy: codexMimoTokenPlanEgressPolicy(),
      model: "mimo-v2.6-pro",
      reasoningEffort: "low",
      serviceTier: "fast",
    });
    expect(args).toContain('model_provider="mimo"');
    expect(args).not.toContain('model_verbosity="low"');
    expect(args).not.toContain('service_tier="fast"');
    expect(args).not.toContain("features.fast_mode=true");
    expect(args).toContain(
      'features.network_proxy.domains={ "token-plan-sgp.xiaomimimo.com" = "allow" }',
    );
    expect(args).not.toContain("--ignore-user-config");
  });

  it("passes driver-materialized MiMo config.toml through CODEX_HOME to packaged exec", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-json-mimo-home-test-"));
    const envVarName = "REVIEW_ROUTER_MIMO_TOKEN_PLAN_API_KEY";
    const apiKey = "tp-fixture-not-a-real-token-plan-key-0000000000";
    let observedCodexHome: string | undefined;
    let observedConfigToml = "";
    const runner = new StaticRunner(
      `${JSON.stringify({ type: "agent_message", message: "mimo review output" })}\n`,
      async (input) => {
        observedCodexHome = input.env.CODEX_HOME;
        if (!observedCodexHome) throw new Error("missing_codex_home");
        observedConfigToml = await readFile(
          join(observedCodexHome, "config.toml"),
          "utf8",
        );
      },
    );
    const driver = new CodexJsonAgentDriver({
      codexBinaryPath: "/bin/codex-test",
      modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
      mimoApiKeyEnvVarName: envVarName,
      sourceEnv: { [envVarName]: apiKey },
    });

    try {
      const result = await driver.runTask({
        session: null,
        task: { kind: "review", prompt: "inspect diff" },
        workspace: { path: workspace },
        runner,
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        status: "completed",
        outputText: "mimo review output",
      });
      expect(runner.lastEnv?.CODEX_HOME).toBe(observedCodexHome);
      expect(runner.lastEnv?.[envVarName]).toBe(apiKey);
      expect(runner.lastArgs).toContain('model_provider="mimo"');
      expect(runner.lastArgs).not.toContain("--ignore-user-config");
      expect(observedConfigToml).toBe([
        'cli_auth_credentials_store = "file"',
        'approval_policy = "never"',
        'sandbox_mode = "read-only"',
        'web_search = "disabled"',
        "disable_response_storage = true",
        "",
        "[features]",
        "apps = false",
        "hooks = false",
        "memories = false",
        "multi_agent = false",
        "shell_snapshot = false",
        "skill_mcp_dependency_install = false",
        "",
        "[history]",
        'persistence = "none"',
        "",
        "[otel]",
        'exporter = "none"',
        'metrics_exporter = "none"',
        'trace_exporter = "none"',
        "log_user_prompt = false",
        "",
        "[shell_environment_policy]",
        'inherit = "all"',
        'include_only = ["PATH", "HOME", "CI", "CODEX_HOME", "SUBSCRIPTION_RUNTIME_GLOBAL_SCAN_GUARD_WRAPPER", "SUBSCRIPTION_RUNTIME_GLOBAL_SCAN_GUARD_FIND_REAL", "SUBSCRIPTION_RUNTIME_GLOBAL_SCAN_GUARD_RG_REAL", "SUBSCRIPTION_RUNTIME_GLOBAL_SCAN_GUARD_GREP_REAL"]',
        "",
        "[model_providers.mimo]",
        'name = "MiMo Token Plan"',
        'base_url = "https://token-plan-sgp.xiaomimimo.com/v1"',
        'wire_api = "responses"',
        `env_key = ${JSON.stringify(envVarName)}`,
        "",
        "# Provider egress is selected by trusted host admission.",
        "[sandbox_workspace_write]",
        "network_access = true",
        "",
        "[features.network_proxy]",
        "enabled = true",
        'domains = { "token-plan-sgp.xiaomimimo.com" = "allow" }',
        "",
      ].join("\n"));
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("fails closed when MiMo is paired with an engine that does not declare the backend", () => {
    expect(
      () =>
        new CodexJsonAgentDriver({
          engine: streamingEngine(() => undefined),
          modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
        }),
    ).toThrow("codex_json_mimo_engine_incompatible");
  });
});
