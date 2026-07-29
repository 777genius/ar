import { describe, expect, it } from "vitest";
import {
  AgentRuntimeTaskProvider,
  AuthSourceKind,
  ClaudeAgentRuntimeBackend,
  createLocalAgentRuntimeTaskRunner,
} from "../index";

describe("public Agent Runtime task runner API", () => {
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
