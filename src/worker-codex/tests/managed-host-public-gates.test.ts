import { expect, it, vi } from "vitest";

vi.mock("../../managed-host-entrypoint", () => ({
  assertManagedHostEntrypointAllowed: vi.fn(() => { throw new Error("managed entrypoint denied"); }),
}));

import { runCodexGoalCli } from "../codex-goal-cli";
import { createCodexGoalMcpServer } from "../codex-goal-mcp";
import { runCodexGoal, type CodexGoalRunConfig } from "../codex-goal-runner";
import { startCodexGoalTmux, type CodexGoalLaunchInput } from "../codex-goal-ops";
import { runSubscriptionAgentTaskCli } from "../../worker-local/agent-task-runner/cli";
import { runSubscriptionAgentRuntimeTaskCli, runSubscriptionAgentRuntimeTaskCliFromProcess } from "../../worker-local/agent-runtime-task-runner/cli";

it("refuses all public CLI dispatch before argument parsing, stdin or worker creation", async () => {
  const io = { writeStdout: vi.fn(), writeStderr: vi.fn(), cwd: vi.fn(), env: vi.fn(), readStdin: vi.fn() };
  const factory = vi.fn();
  expect(await runCodexGoalCli(["--invalid"], io)).toBe(2);
  expect(await runSubscriptionAgentTaskCli(["--invalid"], io, factory)).toBe(2);
  expect(await runSubscriptionAgentRuntimeTaskCli(["--capabilities-json", "1"], io, factory)).toBe(2);
  expect(io.readStdin).not.toHaveBeenCalled();
  expect(io.cwd).not.toHaveBeenCalled();
  expect(io.env).not.toHaveBeenCalled();
  expect(factory).not.toHaveBeenCalled();
  expect(io.writeStderr.mock.calls.flat().join("")).toContain("managed entrypoint denied");
});

it("refuses MCP registration and process signal installation", async () => {
  const once = vi.spyOn(process, "once");
  expect(() => createCodexGoalMcpServer()).toThrow("managed entrypoint denied");
  await expect(runSubscriptionAgentRuntimeTaskCliFromProcess()).rejects.toThrow("managed entrypoint denied");
  expect(once).not.toHaveBeenCalled();
  once.mockRestore();
});

it("refuses direct public goal APIs before filesystem or worker access", async () => {
  const config: CodexGoalRunConfig = { taskId: "synthetic", jobRootDir: "/must-not-read", workspacePath: "/must-not-read", authRootDir: "/must-not-read", promptPath: "/must-not-read", accounts: [], sourceEnv: {} };
  const launch: CodexGoalLaunchInput = { config, cwd: "/must-not-read", logPath: "/must-not-write", format: "json", tmuxSession: "must-not-start", cliCommand: ["/must-not-run"] };
  await expect(runCodexGoal(config)).rejects.toThrow("managed entrypoint denied");
  await expect(startCodexGoalTmux(launch)).rejects.toThrow("managed entrypoint denied");
});
