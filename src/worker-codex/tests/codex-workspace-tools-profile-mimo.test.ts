import { describe, expect, it } from "vitest";
import { AgentRuntimeTool, type AgentRuntimeToolName } from "@vioxen/subscription-runtime/core";
import { CodexModelBackend } from "@vioxen/subscription-runtime/provider-codex";
import { buildCodexWorkspaceToolsProfile } from "../workspace-tools/codex-workspace-tools-profile";

const allowedTools: readonly AgentRuntimeToolName[] = [AgentRuntimeTool.ReadFile];

describe("buildCodexWorkspaceToolsProfile — MiMo backend", () => {
  it("omits [model_providers.mimo] on the default OpenAI/ChatGPT backend (byte-identical to today)", () => {
    const withoutBackend = buildCodexWorkspaceToolsProfile({
      workspaceRoot: "/tmp/workspace",
      allowedTools,
    });
    const withExplicitChatGpt = buildCodexWorkspaceToolsProfile({
      workspaceRoot: "/tmp/workspace",
      allowedTools,
      modelBackend: CodexModelBackend.OpenAiChatGpt,
    });
    expect(withExplicitChatGpt.configToml).toBe(withoutBackend.configToml);
    expect(withoutBackend.configToml).not.toContain("[model_providers.mimo]");
    expect(withoutBackend.configToml).toContain('model_verbosity = "low"');
  });

  it("adds the [model_providers.mimo] block and drops model_verbosity for the MiMo backend", () => {
    const profile = buildCodexWorkspaceToolsProfile({
      workspaceRoot: "/tmp/workspace",
      allowedTools,
      modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
      mimoApiKeyEnvVarName: "MY_MIMO_ENV_VAR",
    });

    expect(profile.configToml).toContain("[model_providers.mimo]");
    expect(profile.configToml).toContain('env_key = "MY_MIMO_ENV_VAR"');
    expect(profile.configToml).toContain('wire_api = "responses"');
    expect(profile.configToml).toContain("[mcp_servers.agent_runtime_workspace]");
    expect(profile.configToml).toContain('enabled_tools = ["read_file"]');
    expect(profile.configToml).toContain("shell_tool = false");
    expect(profile.configToml).toContain("unified_exec = false");
    expect(profile.configToml).toContain(
      '"token-plan-sgp.xiaomimimo.com" = "allow"',
    );
    expect(profile.configToml).not.toContain('model_verbosity = "low"');
    expect(profile.configToml.match(/include_only = \[([^\]]*)\]/)?.[1] ?? "").not.toContain(
      "MY_MIMO_ENV_VAR",
    );
  });

  it("uses the default MIMO_TOKEN_PLAN_API_KEY env var name when omitted", () => {
    const profile = buildCodexWorkspaceToolsProfile({
      workspaceRoot: "/tmp/workspace",
      allowedTools,
      modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
    });
    expect(profile.configToml).toContain('env_key = "MIMO_TOKEN_PLAN_API_KEY"');
  });
});
