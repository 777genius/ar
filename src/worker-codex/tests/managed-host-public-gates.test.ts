import { expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

const custody = vi.hoisted(() => ({ spawn: vi.fn(), complete: vi.fn(), close: vi.fn() }));
vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(), spawn: custody.spawn,
}));
vi.mock("../hosted-readonly-supervisor-host", () => ({
  HostedReadonlySupervisorHost: class {
    runRuntimeLaunch(command: string, args: readonly string[], _cwd: string,
      submit: (launch: { command: string; args: readonly string[] }) => unknown) {
      return submit({ command, args });
    }
    recordRuntimeWaitCompletion = custody.complete;
    closeRuntimeLaunch = custody.close;
  },
}));

vi.mock("../../managed-host-entrypoint", async importOriginal => {
  const actual = await importOriginal<typeof import("../../managed-host-entrypoint")>();
  return { assertManagedHostEntrypointAllowed: vi.fn(() => {
    try {
      actual.assertManagedHostEntrypointAllowed("linux", () => ({ rdev: 0, isCharacterDevice: () => false }));
    } catch (cause) {
      throw new Error("managed entrypoint denied", { cause });
    }
  }) };
});

import { runCodexGoalCli } from "../codex-goal-cli";
import { createCodexGoalMcpServer } from "../codex-goal-mcp";
import { runCodexGoal, type CodexGoalRunConfig } from "../codex-goal-runner";
import { startCodexGoalTmux, type CodexGoalLaunchInput } from "../codex-goal-ops";
import { runHostedReadonlyForeground } from "../hosted-readonly-foreground";
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

it("custody-created foreground writer still refuses public dispatch on an unconfined managed host", async () => {
  // Only the process adapter is synthetic: execute the real custody foreground
  // composition and its real public CLI entrypoint, without starting a process.
  const io = { writeStdout: vi.fn(), writeStderr: vi.fn(), cwd: vi.fn(), env: vi.fn() };
  const child = new EventEmitter();
  const stdin = Object.assign(new EventEmitter(), { end: vi.fn() });
  Object.assign(child, { stdin, kill: vi.fn() });
  custody.spawn.mockImplementationOnce(() => {
    queueMicrotask(async () => {
      const code = await runCodexGoalCli(["run", "--invalid"], io);
      child.emit("exit", code, null);
    });
    return child;
  });
  expect(await runHostedReadonlyForeground("/synthetic/node", ["/synthetic/goal-cli", "run"],
    "/synthetic/workspace", { SUBSCRIPTION_RUNTIME_MANAGED_LAUNCH: "1" })).toBe(2);
  expect(custody.spawn).toHaveBeenCalledTimes(1);
  expect(stdin.end).toHaveBeenCalledWith(expect.any(Buffer));
  expect(io.cwd).not.toHaveBeenCalled();
  expect(io.env).not.toHaveBeenCalled();
  expect(io.writeStderr).toHaveBeenCalledWith("managed entrypoint denied\n");
  expect(custody.complete).not.toHaveBeenCalled();
  expect(custody.close).toHaveBeenCalledTimes(1);
});
