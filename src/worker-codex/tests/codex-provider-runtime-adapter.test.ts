import { describe, expect, it } from "vitest";
import { RunEventProviderKind } from "@vioxen/subscription-runtime/worker-core";
import { createCodexProviderRuntimeAdapter } from "../codex-provider-runtime-adapter";
import { buildCodexControlledAgentProfile } from "../controlled-agent";

const adapter = createCodexProviderRuntimeAdapter();

describe("CodexProviderRuntimeAdapter.controllerProfile", () => {
  it("mirrors the values the legacy Codex profile functions produced", () => {
    const input = {
      stateDir: "/tmp/controller-state",
      mcpCommand: "subscription-runtime-codex-goal-mcp",
      mcpArgs: ["--stdio"],
    };
    const raw = buildCodexControlledAgentProfile({
      ...input,
      rawShellMode: "disabled-by-provider",
    });
    const profile = adapter.controllerProfile(input);

    expect(profile.kind).toBe(RunEventProviderKind.Codex);
    expect(profile.allowedTools()).toEqual(raw.enabledTools);
    expect(profile.sessionId("job-1")).toBe("job-1:controlled-agent");
    expect(profile.enforcement).toEqual(raw.enforcement);
    expect(profile.readyJson()).toEqual({
      allowedTools: raw.enabledTools,
      codexHome: raw.codexHome,
      configToml: raw.configToml,
      rulesText: raw.rulesText,
    });
    expect(profile.rawProfile).toMatchObject({
      providerKind: RunEventProviderKind.Codex,
    });
  });

  it("honors the deny-rules-only raw shell mode through the neutral input", () => {
    const profile = adapter.controllerProfile({
      stateDir: "/tmp/controller-state",
      rawShellMode: "sandboxed-deny-rules-only",
    });
    expect(profile.enforcement.canDisableRawShell).toBe(false);
  });
});

describe("CodexProviderRuntimeAdapter.observation", () => {
  it("exposes the codex registry root as the response locator", () => {
    const observation = adapter.observation({
      registryRootDir: "/tmp/registry",
      includeLogTail: false,
    });
    expect(observation.responseLocator).toEqual({ registryRootDir: "/tmp/registry" });
  });

  it("falls back to a read-only failed snapshot when there is no orphan artifact root", async () => {
    const observation = adapter.observation({
      registryRootDir: "/tmp/registry",
      includeLogTail: false,
    });
    const snapshot = await observation.observeFailedRun!({
      runId: "missing-run",
      error: new Error("job.json ENOENT"),
    });
    expect(snapshot).toMatchObject({
      runId: "missing-run",
      providerKind: RunEventProviderKind.Codex,
      status: "unknown",
      liveness: "unknown",
      readOnlyDecision: {
        kind: "manual_review_required",
        reason: "run_observation_failed",
      },
    });
  });
});
