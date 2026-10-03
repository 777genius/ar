import { describe, expect, it } from "vitest";
import { CodexModelBackend } from "@vioxen/subscription-runtime/provider-codex";
import { buildCodexControlledAgentProfile } from "../codex-controlled-agent-profile";

describe("hosted controller profile", () => {
  it("has no project-control MCP subprocess or exposed broker tool names", () => {
    const profile = buildCodexControlledAgentProfile({ stateDir: "/tmp/synthetic-controller",
      modelBackend: CodexModelBackend.XiaomiMimoTokenPlan, hostedController: true });
    expect(profile.hostedController).toBe(true);
    expect(profile.enabledTools).toEqual([]);
    expect(profile.configToml).not.toContain("[mcp_servers.");
    expect(profile.configToml).not.toContain("subscription-runtime-codex-goal-mcp");
    expect(profile.appServerNativeToolSurface).toBe("disabled");
  });
});
