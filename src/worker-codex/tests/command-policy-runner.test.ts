import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { CommandPolicyRunner } from "../index";
import { codexAppServerCommandApprovalPolicy } from "../file-backend-codex-command-policy";
import {
  MemoryWorkerObservability,
  StaticRunner,
  isolatedWorkspaceCommandPolicy,
} from "./file-backend-codex-worker-test-support";

describe("CommandPolicyRunner", () => {
  it.each([
    "git p* origin main",
    "git p?sh origin main",
    "git p[uv]sh origin main",
    "git p{u..u}sh origin main",
    "git {push,} origin main",
    "(git push origin main)",
  ])("denies expansion or grouping that records a push: %s", async (payload) => {
    const cwd = await mkdtemp(join(tmpdir(), "command-policy-expansion-"));
    try {
      // Only this fixture file can match the glob. The function records argv;
      // no Git executable, provider, remote or inherited environment is used.
      await writeFile(join(cwd, "push"), "");
      const recorded = await promisify(execFile)("/bin/bash", [
        "--noprofile", "--norc", "-c",
        `git() { printf '%s\\n' "$@"; }; ${payload}`,
      ], { cwd, env: {}, timeout: 1_000 });
      expect(recorded.stdout).toBe("push\norigin\nmain\n");

      const observability = new MemoryWorkerObservability();
      const policy = codexAppServerCommandApprovalPolicy(
        isolatedWorkspaceCommandPolicy(), observability, {},
      );
      const inputs = [
        ...["bash", "sh", "/usr/bin/zsh"].flatMap((shell) =>
          ["-c", "-lc"].map((option) => ({
            source: "command_execution" as const, command: [shell, option, payload],
          }))
        ),
        { source: "thread_shell_command" as const, commandText: payload },
        { source: "thread_shell_command" as const, commandText: `bash -c '${payload}'` },
        { source: "thread_shell_command" as const, commandText: `sh -lc "${payload}"` },
      ];
      expect(inputs.map((input) => policy.reviewCommand(input))).toEqual(
        inputs.map(() => ({
          approved: false, reason: "script_interpreter_denied",
        })),
      );
      expect(observability.events).toHaveLength(inputs.length);
      expect(observability.events.every((event) =>
        event.name === "command_policy.denied" &&
        event.metadata?.reason === "script_interpreter_denied"
      )).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it.each(["p*", "p?sh", "p[uv]sh", "p{u..u}sh", "{push,}", "(push)"])(
    "preserves literal expansion characters in a direct vector: %s", (operation) => {
      const policy = codexAppServerCommandApprovalPolicy(
        isolatedWorkspaceCommandPolicy(), new MemoryWorkerObservability(), {},
      );
      expect(policy.reviewCommand({
        source: "command_execution", command: ["git", operation, "origin", "main"],
      })).toEqual({ approved: true, reason: "command_policy_allowed" });
    },
  );

  it.each([
    "git 'push' origin main",
    'git "push" origin main',
    "git pu\\sh origin main",
    "g\\it push origin main",
  ])("denies unsupported shell syntax that executes a push: %s", async (payload) => {
    // A shell function records argv; no Git executable or remote is invoked.
    const recorded = await promisify(execFile)("/bin/bash", [
      "--noprofile", "--norc", "-c",
      `git() { printf '%s\\n' "$@"; }; ${payload}`,
    ], { env: {}, timeout: 1_000 });
    expect(recorded.stdout).toBe("push\norigin\nmain\n");

    const observability = new MemoryWorkerObservability();
    const policy = codexAppServerCommandApprovalPolicy(
      isolatedWorkspaceCommandPolicy(), observability, {},
    );
    for (const input of [
      { source: "command_execution" as const, command: ["bash", "-c", payload] },
      { source: "thread_shell_command" as const, commandText: payload },
      { source: "thread_shell_command" as const, commandText: `bash -c '${payload}'` },
    ]) {
      expect(policy.reviewCommand(input)).toEqual({
        approved: false, reason: "script_interpreter_denied",
      });
    }
    expect(observability.events).toHaveLength(3);
    expect(observability.events.every((event) =>
      event.name === "command_policy.denied" &&
      event.metadata?.reason === "script_interpreter_denied"
    )).toBe(true);
  });

  it.each([
    "bash -c 'git status --short'",
    'sh -lc "git status --short"',
    "/usr/bin/zsh -c 'git status --short'",
  ])("preserves plain read-only shell wrapper text: %s", (commandText) => {
    const policy = codexAppServerCommandApprovalPolicy(
      isolatedWorkspaceCommandPolicy(), new MemoryWorkerObservability(), {},
    );
    expect(policy.reviewCommand({ source: "thread_shell_command", commandText }))
      .toEqual({ approved: true, reason: "command_policy_allowed" });
  });

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

  it.each([
    ["bash", "-c"],
    ["bash", "-lc"],
    ["sh", "-c"],
    ["sh", "-lc"],
    ["zsh", "-c"],
    ["zsh", "-lc"],
  ])("evaluates the nested vector for %s %s wrappers", (shell, option) => {
    const policy = codexAppServerCommandApprovalPolicy(
      isolatedWorkspaceCommandPolicy(),
      new MemoryWorkerObservability(),
      {},
    );

    expect(policy.reviewCommand({
      source: "command_execution",
      command: [shell, option, "git status --short"],
    })).toEqual({ approved: true, reason: "command_policy_allowed" });
  });

  it("does not allow a forbidden nested command to bypass policy", () => {
    const policy = codexAppServerCommandApprovalPolicy(
      isolatedWorkspaceCommandPolicy(),
      new MemoryWorkerObservability(),
      {},
    );

    expect(policy.reviewCommand({
      source: "command_execution",
      command: ["/usr/bin/zsh", "-lc", "git push origin main"],
    })).toEqual({ approved: false, reason: "denied_git_subcommand" });
  });

  it.each([
    ["bash -lc 'git status && git push origin main'"],
    ['sh -c "git status; git push origin main"'],
    ["zsh -lc 'git status' trailing-text"],
  ])("represents complex or ambiguous wrapper text conservatively: %s", (commandText) => {
    const policy = codexAppServerCommandApprovalPolicy(
      isolatedWorkspaceCommandPolicy(),
      new MemoryWorkerObservability(),
      {},
    );

    expect(policy.reviewCommand({
      source: "thread_shell_command",
      commandText,
    })).toEqual({ approved: false, reason: "script_interpreter_denied" });
  });

  it("does not rewrite shell-looking text in an argument of a non-wrapper command", () => {
    const policy = codexAppServerCommandApprovalPolicy(
      isolatedWorkspaceCommandPolicy(),
      new MemoryWorkerObservability(),
      {},
    );

    expect(policy.reviewCommand({
      source: "command_execution",
      command: ["printf", "%s", "bash -lc 'git push origin main'"],
    })).toEqual({ approved: true, reason: "command_policy_allowed" });
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
