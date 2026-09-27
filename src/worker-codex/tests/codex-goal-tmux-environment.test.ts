import { describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexModelBackend } from "@vioxen/subscription-runtime/provider-codex";
import {
  buildCodexGoalNoTmuxCommand,
  prepareCodexGoalLaunchPaths,
  type CodexGoalLaunchInput,
} from "../codex-goal-ops";

describe("Codex goal tmux environment", () => {
  it("pre-creates the tmux log with private file permissions", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-goal-private-log-"));
    const input: CodexGoalLaunchInput = {
      config: {
        jobRootDir: join(root, "job"), authRootDir: join(root, "auth"),
        workspacePath: join(root, "workspace"), promptPath: join(root, "prompt.md"),
        taskId: "private-log", accounts: [{ name: "test-account" }],
      },
      cwd: root, logPath: join(root, "job", "worker.log"),
      cliCommand: ["subscription-runtime-codex-goal"],
    };
    try {
      await prepareCodexGoalLaunchPaths(input);
      expect(statSync(input.logPath).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("loads a MiMo key from a private file inside the worker shell without exposing its value in the launch command", () => {
    const root = mkdtempSync(join(tmpdir(), "mimo-key-launch-"));
    const keyFile = join(root, "key");
    writeFileSync(keyFile, "synthetic-private-key", { mode: 0o600 });
    chmodSync(keyFile, 0o600);
    const previous = process.env.SUBSCRIPTION_RUNTIME_MIMO_KEY_FILE;
    process.env.SUBSCRIPTION_RUNTIME_MIMO_KEY_FILE = keyFile;
    try {
      const input: CodexGoalLaunchInput = {
        config: {
          jobRootDir: join(root, "job"), authRootDir: join(root, "auth"),
          workspacePath: join(root, "workspace"), promptPath: join(root, "prompt.md"),
          taskId: "mimo-key", accounts: [{ name: "mimo-main" }],
          modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
        },
        cwd: root, logPath: join(root, "job.log"),
        cliCommand: ["subscription-runtime-codex-goal"],
      };
      const command = buildCodexGoalNoTmuxCommand(input);
      expect(command).toContain(`MIMO_TOKEN_PLAN_API_KEY=$(cat -- ${keyFile})`);
      expect(command).toContain(`SUBSCRIPTION_RUNTIME_MIMO_KEY_FILE=${keyFile}`);
      expect(command).not.toContain("synthetic-private-key");
      expect(() => buildCodexGoalNoTmuxCommand({
        ...input,
        config: {
          ...input.config,
          mimoAccounts: [{ name: "mimo-main", envVarName: "MIMO_TOKEN_PLAN_API_KEY_CUSTOM" }],
        },
      })).toThrow("codex_goal_mimo_key_file_account_mapping_unsupported");
      expect(() => buildCodexGoalNoTmuxCommand({
        ...input,
        config: {
          ...input.config,
          accounts: [{ name: "mimo-main", envVarName: "MIMO_TOKEN_PLAN_API_KEY_CUSTOM" }],
        },
      })).toThrow("codex_goal_mimo_key_file_account_mapping_unsupported");
    } finally {
      if (previous === undefined) delete process.env.SUBSCRIPTION_RUNTIME_MIMO_KEY_FILE;
      else process.env.SUBSCRIPTION_RUNTIME_MIMO_KEY_FILE = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("preserves hosted global-scan guard configuration", () => {
    const input: CodexGoalLaunchInput = {
      config: {
        jobRootDir: "/tmp/job",
        authRootDir: "/tmp/auth",
        workspacePath: "/tmp/workspace",
        promptPath: "/tmp/job/prompt.md",
        taskId: "task-1",
        accounts: [{ name: "account-a" }],
        sourceEnv: {
          SUBSCRIPTION_RUNTIME_SANDBOX_KIND: "hosted-codex-job",
          SUBSCRIPTION_RUNTIME_GLOBAL_SCAN_GUARD_CODEX_SOURCE:
            "/opt/codex/bin/codex",
          SUBSCRIPTION_RUNTIME_GLOBAL_SCAN_GUARD_TOOL: "rg",
        },
      },
      cwd: "/tmp/workspace",
      logPath: "/tmp/job/task-1.log",
      cliCommand: ["subscription-runtime-codex-goal"],
    };

    const command = buildCodexGoalNoTmuxCommand(input);

    expect(command).toContain(
      "SUBSCRIPTION_RUNTIME_SANDBOX_KIND=hosted-codex-job",
    );
    expect(command).toContain(
      "SUBSCRIPTION_RUNTIME_GLOBAL_SCAN_GUARD_CODEX_SOURCE=/opt/codex/bin/codex",
    );
    expect(command).not.toContain(
      "SUBSCRIPTION_RUNTIME_GLOBAL_SCAN_GUARD_TOOL",
    );
  });
});
