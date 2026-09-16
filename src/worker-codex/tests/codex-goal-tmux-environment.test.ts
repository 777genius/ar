import { describe, expect, it } from "vitest";
import {
  buildCodexGoalNoTmuxCommand,
  type CodexGoalLaunchInput,
} from "../codex-goal-ops";

describe("Codex goal tmux environment", () => {
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
