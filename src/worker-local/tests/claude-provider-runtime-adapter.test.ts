import { describe, expect, it } from "vitest";
import { RunEventProviderKind } from "@vioxen/subscription-runtime/worker-core";
import { createClaudeProviderRuntimeAdapter } from "../claude-provider-runtime-adapter";
import { buildLocalClaudeControlledAgentProfile } from "../claude-controlled-agent-local";

const adapter = createClaudeProviderRuntimeAdapter();

describe("ClaudeProviderRuntimeAdapter.controllerProfile", () => {
  it("mirrors the values the legacy Claude profile functions produced", () => {
    const input = {
      stateDir: "/tmp/controller-state",
      mcpCommand: "subscription-runtime-codex-goal-mcp",
      mcpArgs: ["--stdio"],
    };
    const raw = buildLocalClaudeControlledAgentProfile(input);
    const profile = adapter.controllerProfile(input);

    expect(profile.kind).toBe(RunEventProviderKind.Claude);
    expect(profile.allowedTools()).toEqual(raw.allowedTools);
    expect(profile.sessionId("job-1")).toBe("job-1:controlled-agent:claude");
    expect(profile.enforcement).toEqual(raw.enforcement);
    expect(profile.readyJson()).toEqual({
      allowedTools: raw.allowedTools,
      disallowedTools: raw.disallowedTools,
      configDir: raw.configDir,
      mcpConfig: raw.mcpConfig,
      strictMcpConfig: raw.strictMcpConfig,
      appendSystemPrompt: raw.appendSystemPrompt,
    });
    expect(profile.rawProfile).toMatchObject({
      providerKind: RunEventProviderKind.Claude,
    });
  });

  it("ignores the codex-only raw shell mode when building the profile", () => {
    const profile = adapter.controllerProfile({
      stateDir: "/tmp/controller-state",
      rawShellMode: "sandboxed-deny-rules-only",
    });
    expect(profile.enforcement.canDisableRawShell).toBe(true);
  });
});

describe("ClaudeProviderRuntimeAdapter.observation", () => {
  it("exposes the claude state/artifact roots as the response locator", () => {
    const observation = adapter.observation({
      registryRootDir: "/tmp/registry",
      stateRootDir: "/tmp/state",
      runArtifactsRootDir: "/tmp/state/claude-run-artifacts",
      includeLogTail: false,
    });
    expect(observation.responseLocator).toEqual({
      stateRootDir: "/tmp/state",
      runArtifactsRootDir: "/tmp/state/claude-run-artifacts",
    });
  });

  it("returns a read-only failed snapshot for a run that fails observation", async () => {
    const observation = adapter.observation({
      registryRootDir: "/tmp/registry",
      includeLogTail: false,
    });
    const snapshot = await observation.observeFailedRun!({
      runId: "missing-run",
      error: new Error("boom"),
    });
    expect(snapshot).toMatchObject({
      runId: "missing-run",
      providerKind: RunEventProviderKind.Claude,
      status: "unknown",
      liveness: "unknown",
      readOnlyDecision: {
        kind: "manual_review_required",
        reason: "run_observation_failed",
      },
    });
  });
});
