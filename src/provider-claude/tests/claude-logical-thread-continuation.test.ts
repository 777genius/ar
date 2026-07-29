import { describe, expect, it } from "vitest";
import {
  AgentRuntimeTurnLimitEnforcement,
  DefaultRedactor,
  ProviderLogicalThreadOutcome,
  type ProcessResult,
  type RunnerCapabilities,
  type RunnerPort,
} from "@vioxen/subscription-runtime/core";
import {
  ClaudeTaskAgentDriver,
  claudeRuntimeResumeSessionIdMetadataKey,
  claudeRuntimeThreadIdMetadataKey,
  sessionArtifactFromClaudeOAuth,
  type ClaudeTaskEngineInput,
  type ClaudeTaskExecutionEngine,
} from "../index";

describe("Claude logical-thread continuation", () => {
  it("prefers the typed seam and preserves legacy metadata continuation", async () => {
    const engine = new LogicalThreadClaudeEngine();
    const driver = new ClaudeTaskAgentDriver({ engine });
    const checkpoints: unknown[] = [];

    const result = await driver.runTask({
      session: sessionArtifactFromClaudeOAuth({
        oauthToken: "claude-oauth-secret",
        configDir: "/tmp/claude-config",
      }),
      task: {
        kind: "structured-prompt",
        prompt: "continue",
        metadata: {
          [claudeRuntimeThreadIdMetadataKey]: "untrusted-thread",
          [claudeRuntimeResumeSessionIdMetadataKey]:
            "untrusted-provider-session",
        },
      },
      workspace: { path: "/tmp/claude-workspace" },
      runner: new StaticRunner(),
      redactor: new DefaultRedactor(),
      abortSignal: new AbortController().signal,
      logicalThread: {
        threadId: "trusted-thread",
        previousCheckpoint: "trusted-provider-session",
        onCheckpoint: (checkpoint) => {
          checkpoints.push(checkpoint);
        },
      },
    });

    expect(engine.records[0]?.runtimeThread).toEqual({
      threadId: "trusted-thread",
      resumeSessionId: "trusted-provider-session",
    });
    expect(checkpoints).toEqual([{
      checkpoint: "new-provider-session",
      outcome: ProviderLogicalThreadOutcome.Continued,
    }]);
    expect(result.telemetry).not.toHaveProperty("providerSessionId");

    await driver.runTask({
      session: sessionArtifactFromClaudeOAuth({
        oauthToken: "claude-oauth-secret",
        configDir: "/tmp/claude-config",
      }),
      task: {
        kind: "structured-prompt",
        prompt: "legacy metadata continuation",
        metadata: {
          [claudeRuntimeThreadIdMetadataKey]: "untrusted-thread",
          [claudeRuntimeResumeSessionIdMetadataKey]:
            "untrusted-provider-session",
        },
      },
      workspace: { path: "/tmp/claude-workspace" },
      runner: new StaticRunner(),
      redactor: new DefaultRedactor(),
      abortSignal: new AbortController().signal,
    });
    expect(engine.records[1]?.runtimeThread).toEqual({
      threadId: "untrusted-thread",
      resumeSessionId: "untrusted-provider-session",
    });
  });

  it("redacts a provider checkpoint echoed by a resume failure", async () => {
    const engine = new LogicalThreadClaudeEngine();
    const driver = new ClaudeTaskAgentDriver({ engine });
    const checkpoint = "provider-secret-checkpoint";

    const result = await driver.runTask({
      session: sessionArtifactFromClaudeOAuth({
        oauthToken: "claude-oauth-secret",
        configDir: "/tmp/claude-config",
      }),
      task: {
        kind: "structured-prompt",
        prompt: "fail resume",
      },
      workspace: { path: "/tmp/claude-workspace" },
      runner: new StaticRunner(),
      redactor: new DefaultRedactor(),
      abortSignal: new AbortController().signal,
      logicalThread: {
        threadId: "trusted-thread",
        previousCheckpoint: checkpoint,
        onCheckpoint: () => undefined,
      },
    });

    expect(result.status).toBe("failed");
    expect(JSON.stringify(result)).not.toContain(checkpoint);
  });
});

class LogicalThreadClaudeEngine implements ClaudeTaskExecutionEngine {
  readonly kind = "test-logical-thread";
  readonly capabilities = {
    supportsStreaming: false,
    supportsToolCalls: true,
    supportsUsage: true,
    supportsProviderRunId: true,
    supportsCleanup: true,
    turnLimitEnforcement: AgentRuntimeTurnLimitEnforcement.ProviderNative,
  } as const;
  readonly records: ClaudeTaskEngineInput[] = [];

  async run(input: ClaudeTaskEngineInput) {
    this.records.push(input);
    if (input.prompt === "fail resume") {
      throw new Error(
        `Claude could not resume session ${input.runtimeThread?.resumeSessionId}`,
      );
    }
    return {
      outputText: "done",
      telemetry: {
        providerRunId: "provider-run-1",
        providerSessionId: "new-provider-session",
      },
      warnings: [],
    };
  }
}

const runnerCapabilities: RunnerCapabilities = {
  runnerId: "static",
  supportsEnvAllowlist: true,
  supportsWorkingDirectory: true,
  supportsTimeout: true,
  supportsAbortSignal: true,
  supportsOutputRedaction: true,
  supportsReadOnlySandbox: true,
  readOnlyFilesystem: false,
  platform: "node-process",
};

class StaticRunner implements RunnerPort {
  readonly runnerId = runnerCapabilities.runnerId;
  readonly capabilities = runnerCapabilities;

  async run(): Promise<ProcessResult> {
    return { exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
  }
}
