import { describe, expect, it } from "vitest";
import { CommandPolicyRunner } from "../index";
import {
  MemoryWorkerObservability,
  StaticRunner,
  isolatedWorkspaceCommandPolicy,
} from "./file-backend-codex-worker-test-support";

describe("CommandPolicyRunner", () => {
  it("exposes wrapper runner id in capabilities for runtime policy negotiation", () => {
    const inner = new StaticRunner({ exitCode: 0, stdout: "", stderr: "" });
    const runner = new CommandPolicyRunner(inner, isolatedWorkspaceCommandPolicy());

    expect(runner.runnerId).toBe("node-process:command-policy");
    expect(runner.capabilities.runnerId).toBe(runner.runnerId);
  });

  it("blocks denied commands before the inner runner is invoked", async () => {
    const inner = new StaticRunner({ exitCode: 0, stdout: "", stderr: "" });
    const runner = new CommandPolicyRunner(inner, isolatedWorkspaceCommandPolicy());

    await expect(runner.run({
      command: "git",
      args: ["push", "origin", "main"],
      cwd: "/tmp/project",
      env: {},
      timeoutMs: 1_000,
      abortSignal: new AbortController().signal,
    })).rejects.toThrow("command_policy_denied:denied_git_subcommand");
    expect(inner.lastArgs).toEqual([]);
  });

  it("delegates allowed commands to the inner runner", async () => {
    const inner = new StaticRunner({ exitCode: 0, stdout: "clean", stderr: "" });
    const runner = new CommandPolicyRunner(inner, isolatedWorkspaceCommandPolicy());

    await expect(runner.run({
      command: "git",
      args: ["status", "--short"],
      cwd: "/tmp/project",
      env: {},
      timeoutMs: 1_000,
      abortSignal: new AbortController().signal,
    })).resolves.toMatchObject({ exitCode: 0, stdout: "clean" });
    expect(inner.lastArgs).toEqual(["status", "--short"]);
  });

  it("emits a redacted audit event when a command is denied", async () => {
    const inner = new StaticRunner({ exitCode: 0, stdout: "", stderr: "" });
    const observability = new MemoryWorkerObservability();
    const runner = new CommandPolicyRunner(inner, isolatedWorkspaceCommandPolicy(), {
      observability,
      providerId: "codex",
      metadata: { workerId: "worker-a" },
    });

    await expect(runner.run({
      command: "git",
      args: ["push", "https://secret-token@example.com/repo.git", "main"],
      cwd: "/tmp/project",
      env: {},
      timeoutMs: 1_000,
      abortSignal: new AbortController().signal,
    })).rejects.toThrow("command_policy_denied:denied_git_subcommand");

    expect(observability.events).toHaveLength(1);
    expect(observability.events[0]).toMatchObject({
      name: "command_policy.denied",
      providerId: "codex",
      metadata: {
        reason: "denied_git_subcommand",
        executableName: "git",
        runnerId: "node-process",
        workerId: "worker-a",
      },
    });
    expect(JSON.stringify(observability.events)).not.toContain("secret-token");
  });
});
