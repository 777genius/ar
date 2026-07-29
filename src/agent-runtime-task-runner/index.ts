import {
  createLocalAgentRuntimeTaskRunner as createWorkerLocalAgentRuntimeTaskRunner,
} from "../worker-local/agent-runtime-task-runner";
import {
  AgentRuntimeTaskProvider,
  ClaudeAgentRuntimeBackend,
  type AgentRuntimeTaskRunner,
  type CreateLocalAgentRuntimeTaskRunnerInput,
} from "./domain";

export {
  resolveLocalAgentRuntimeTaskRunnerCliPath,
} from "../worker-local/agent-runtime-task-runner";
export * from "./domain";

export function createLocalAgentRuntimeTaskRunner(
  input: CreateLocalAgentRuntimeTaskRunnerInput,
): AgentRuntimeTaskRunner {
  if (input.provider === AgentRuntimeTaskProvider.Claude) {
    const { providerRuntime, ...rest } = input;
    return createWorkerLocalAgentRuntimeTaskRunner({
      ...rest,
      claudeBackend:
        providerRuntime?.backend ?? ClaudeAgentRuntimeBackend.AgentSdk,
      ...(providerRuntime?.binaryPath
        ? { claudePath: providerRuntime.binaryPath }
        : {}),
      ...(providerRuntime?.backend === ClaudeAgentRuntimeBackend.Background &&
      providerRuntime.runtimeDistDir
        ? { claudeRuntimeDistDir: providerRuntime.runtimeDistDir }
        : {}),
    });
  }

  const { providerRuntime, ...rest } = input;
  return createWorkerLocalAgentRuntimeTaskRunner({
    ...rest,
    ...(providerRuntime?.binaryPath
      ? { codexBinaryPath: providerRuntime.binaryPath }
      : {}),
  });
}
