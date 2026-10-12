import { describe, expect, it } from "vitest";
import { AgentRuntimeTaskProvider } from "../../agent-runtime-task-runner/domain";
import { resolveLocalAgentRuntimeTaskRunnerInput } from "../agent-runtime-task-runner/local-agent-runtime-task-runner";

describe("Agent Runtime runner resolved storage contract", () => {
  it("selects one provider-specific state for both the retained store and downstream worker", () => {
    const input = { storageRootDir: "/external/runtime", workspaceRoot: "/sandbox/workspace",
      encryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", env: {} };
    expect(resolveLocalAgentRuntimeTaskRunnerInput({ ...input,
      provider: AgentRuntimeTaskProvider.Codex }).stateRootDir).toBe("/external/runtime/state/agent-runtime-task/codex");
    expect(resolveLocalAgentRuntimeTaskRunnerInput({ ...input,
      provider: AgentRuntimeTaskProvider.Claude }).stateRootDir).toBe("/external/runtime/state/agent-runtime-task/claude");
    expect(resolveLocalAgentRuntimeTaskRunnerInput({ ...input,
      provider: AgentRuntimeTaskProvider.Codex, stateRootDir: "/legacy/state",
      env: { SUBSCRIPTION_RUNTIME_STORAGE_ROOT: "/env/runtime" },
    }).stateRootDir).toBe("/legacy/state");
  });
});
