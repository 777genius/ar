import { describe, expect, it } from "vitest";
import {
  AgentRuntimeTaskProvider,
  AgentRuntimeTaskReasoningEffort,
  AgentRuntimeTaskServiceTier,
  AuthSourceKind,
  ClaudeAgentRuntimeBackend,
  createLocalAgentRuntimeTaskRunner,
} from "../index";

describe("public Agent Runtime task runner API", () => {
  it("accepts only the exact supported Codex execution profile", async () => {
    const runner = createLocalAgentRuntimeTaskRunner({
      provider: AgentRuntimeTaskProvider.Codex,
      stateRootDir: "/tmp/runtime-state",
      encryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      workspaceRoot: process.cwd(),
      env: {},
      providerRuntime: {
        reasoningEffort: AgentRuntimeTaskReasoningEffort.High,
        serviceTier: AgentRuntimeTaskServiceTier.Default,
      },
    });
    await runner.dispose();

    expect(() => createLocalAgentRuntimeTaskRunner({
      provider: AgentRuntimeTaskProvider.Codex,
      stateRootDir: "/tmp/runtime-state",
      encryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      workspaceRoot: process.cwd(),
      env: {},
      providerRuntime: { reasoningEffort: "medium" },
    } as never)).toThrow("reasoningEffort must be high");
    expect(() => createLocalAgentRuntimeTaskRunner({
      provider: AgentRuntimeTaskProvider.Codex,
      stateRootDir: "/tmp/runtime-state",
      encryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      workspaceRoot: process.cwd(),
      env: {},
      providerRuntime: { serviceTier: "fast" },
    } as never)).toThrow("serviceTier must be default");
    expect(() => createLocalAgentRuntimeTaskRunner({
      provider: AgentRuntimeTaskProvider.Claude,
      stateRootDir: "/tmp/runtime-state",
      encryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      workspaceRoot: process.cwd(),
      env: {},
      providerRuntime: { reasoningEffort: "high" },
    } as never)).toThrow("Codex execution options");
  });

  it("accepts provider runtime config and validates requests at the module boundary", async () => {
    const runner = createLocalAgentRuntimeTaskRunner({
      provider: AgentRuntimeTaskProvider.Claude,
      stateRootDir: "/tmp/runtime-state",
      encryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      workspaceRoot: process.cwd(),
      env: {},
      authSource: {
        kind: AuthSourceKind.PreseededSession,
      },
      providerRuntime: {
        backend: ClaudeAgentRuntimeBackend.Background,
        runtimeDistDir: "/tmp/test-claude-runtime/dist",
        binaryPath: "/usr/local/bin/claude",
      },
    });

    const result = await runner.run({
      protocolVersion: 1,
      task: {
        kind: "structured-prompt",
      },
    } as never);

    expect(result).toMatchObject({
      status: "failed",
      failure: {
        safeMessage: "request.task.prompt must be a string",
      },
    });
  });
});
