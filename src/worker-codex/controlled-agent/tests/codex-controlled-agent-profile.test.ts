import { describe, expect, it } from "vitest";
import {
  RunEventProviderKind,
  projectScopedControllerToolNames,
} from "@vioxen/subscription-runtime/worker-core";
import {
  CodexModelBackend,
  CodexProviderEgressProfileId,
  codexProviderEgressPolicy,
} from "@vioxen/subscription-runtime/provider-codex";

import { buildCodexControlledAgentProfile, withControlledAgentEgress } from "../index";

describe("buildCodexControlledAgentProfile", () => {
  it("generates a Codex profile with only broker/status MCP tools enabled", () => {
    const profile = buildCodexControlledAgentProfile({
      stateDir: "/tmp/controller-state",
      mcpCommand: "subscription-runtime-codex-goal-mcp",
      mcpArgs: ["--stdio"],
      rawShellMode: "disabled-by-provider",
    });

    expect(profile.providerKind).toBe(RunEventProviderKind.Codex);
    expect(profile.codexHome).toBe("/tmp/controller-state/codex-home");
    expect(profile.enabledTools).toEqual(projectScopedControllerToolNames());
    expect(profile.configToml).toContain(
      '[mcp_servers.subscription_runtime_project_control]',
    );
    expect(profile.configToml).toContain(
      `enabled_tools = ${JSON.stringify(projectScopedControllerToolNames()).replaceAll(",", ", ")}`,
    );
    expect(profile.configToml).toContain('sandbox_mode = "read-only"');
    expect(profile.configToml).toContain('approval_policy = "never"');
    expect(profile.configToml).toContain('web_search = "disabled"');
    expect(profile.configToml).toContain('cli_auth_credentials_store = "file"');
    expect(profile.configToml).toContain("disable_response_storage = true");
    expect(profile.configToml).toContain("[features]");
    expect(profile.configToml).toContain("multi_agent = false");
    expect(profile.configToml).toContain("[features.network_proxy]");
    expect(profile.configToml).toContain("enabled = true");
    expect(profile.configToml).toContain(
      'domains = { "api.openai.com" = "allow" }',
    );
    expect(profile.configToml).not.toContain('"*" = "allow"');
    expect(profile.configToml).toContain("[history]");
    expect(profile.configToml).toContain('persistence = "none"');
    expect(profile.configToml).toContain("[otel]");
    expect(profile.configToml).toContain('exporter = "none"');
    expect(profile.configToml).toContain("[shell_environment_policy]");
    expect(profile.configToml).toContain('inherit = "none"');
    expect(profile.configToml).not.toContain("danger-full-access");
    expect(profile.enforcement).toMatchObject({
      providerKind: RunEventProviderKind.Codex,
      canRestrictToolSurface: true,
      canDisableRawShell: true,
    });
  });

  it("marks deny-rules-only raw shell handling as insufficient for live controller launch", () => {
    const profile = buildCodexControlledAgentProfile({
      stateDir: "/tmp/controller-state",
      rawShellMode: "sandboxed-deny-rules-only",
    });

    expect(profile.enforcement.canDisableRawShell).toBe(false);
    expect(profile.rulesText).toContain('pattern = ["git"]');
    expect(profile.rulesText).toContain('pattern = ["tmux"]');
    expect(profile.rulesText).toContain('pattern = ["bash", "-lc"]');
  });

  it("omits [model_providers.mimo] on the default OpenAI/ChatGPT backend (byte-identical to today)", () => {
    const withoutBackend = buildCodexControlledAgentProfile({ stateDir: "/tmp/controller-state" });
    const withExplicitChatGpt = buildCodexControlledAgentProfile({
      stateDir: "/tmp/controller-state",
      modelBackend: CodexModelBackend.OpenAiChatGpt,
    });
    expect(withExplicitChatGpt.configToml).toBe(withoutBackend.configToml);
    expect(withoutBackend.configToml).not.toContain("[model_providers.mimo]");
    expect(withoutBackend.configToml).toContain('model_verbosity = "low"');
  });

  it("adds the [model_providers.mimo] block and drops model_verbosity for the MiMo backend", () => {
    const profile = buildCodexControlledAgentProfile({
      stateDir: "/tmp/controller-state",
      modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
      mimoApiKeyEnvVarName: "MY_MIMO_ENV_VAR",
    });

    expect(profile.configToml).toContain("[model_providers.mimo]");
    expect(profile.configToml).toContain('env_key = "MY_MIMO_ENV_VAR"');
    expect(profile.configToml).toContain('wire_api = "responses"');
    expect(profile.configToml).not.toContain('model_verbosity = "low"');
    // The credential env var must never appear in the shell allowlist — it is
    // injected directly into the child process env by the spawn call site,
    // never reachable from model-executed shell tool calls.
    expect(profile.configToml.match(/include_only = \[([^\]]*)\]/)?.[1] ?? "").not.toContain(
      "MY_MIMO_ENV_VAR",
    );
  });

  it("keeps withControlledAgentEgress working on a MiMo-backend profile", () => {
    const profile = buildCodexControlledAgentProfile({
      stateDir: "/tmp/controller-state",
      modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
    });
    const policy = codexProviderEgressPolicy(CodexProviderEgressProfileId.MimoTokenPlan);
    const authenticated = withControlledAgentEgress(profile, policy);
    expect(authenticated.providerEgressPolicy).toBe(policy);
    // The [model_providers.mimo] block generated earlier in configToml must
    // survive the tail-replacement withControlledAgentEgress performs.
    expect(authenticated.configToml).toContain("[model_providers.mimo]");
    expect(authenticated.configToml).toContain("token-plan-sgp.xiaomimimo.com");
  });
});
