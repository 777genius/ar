import { fileURLToPath } from "node:url";

export function resolveLocalAgentRuntimeTaskRunnerCliPath(): string {
  return fileURLToPath(new URL("../agent-runtime-task-runner-cli.js", import.meta.url));
}
