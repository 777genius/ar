import { describe, expect, it } from "vitest";
import {
  CommandValidationDecisionReason,
  validateCommandAgainstPolicy,
} from "../index";

describe("validateCommandAgainstPolicy", () => {
  it("keeps command validation available from the host-command seam", () => {
    const policy = {
      validateCommands: true,
      deniedExecutableNames: ["tmux"],
      deniedGitSubcommands: ["push"],
      deniedPathPrefixes: ["/var/data/worker-jobs/registry"],
      deniedInlineCodeExecutables: ["python3", "node"],
      deniedScriptExecutables: ["sh", "bash"],
    };

    expect(validateCommandAgainstPolicy({
      command: ["git", "status"],
      policy,
    })).toMatchObject({
      allowed: true,
      reason: CommandValidationDecisionReason.Allowed,
    });
    expect(validateCommandAgainstPolicy({
      command: ["/usr/bin/git", "push", "origin", "main"],
      policy,
    })).toMatchObject({
      allowed: false,
      reason: CommandValidationDecisionReason.DeniedGitSubcommand,
    });
    expect(validateCommandAgainstPolicy({
      command: "python3 -c print(1)",
      policy,
    })).toMatchObject({
      allowed: false,
      reason: CommandValidationDecisionReason.InlineCodeDenied,
    });
  });

  it("blocks broad find, rg, and recursive grep scans with stable evidence", () => {
    const policy = {
      validateCommands: true,
      deniedExecutableNames: [],
      deniedGitSubcommands: [],
      deniedPathPrefixes: [],
      deniedInlineCodeExecutables: [],
      deniedScriptExecutables: [],
    };

    for (const command of [
      ["find", "/var/data", "-type", "f"],
      ["/usr/bin/rg", "--files", "/"],
      ["grep", "-R", "needle", "/tmp"],
      ["rg", "needle", "/mnt/volume_ams3_123"],
    ]) {
      expect(validateCommandAgainstPolicy({ command, policy })).toMatchObject({
        allowed: false,
        reason: CommandValidationDecisionReason.GlobalFilesystemScanDenied,
        evidence: [expect.stringMatching(
          /^subscription_runtime_global_scan_blocked .*remediation=search an assigned workspace\/job descendant.*exit_code=64$/,
        )],
      });
    }
  });

  it("allows bounded descendants, patterns, and non-recursive grep files", () => {
    const policy = {
      validateCommands: true,
      deniedExecutableNames: [],
      deniedGitSubcommands: [],
      deniedPathPrefixes: [],
      deniedInlineCodeExecutables: [],
      deniedScriptExecutables: [],
    };

    for (const command of [
      ["find", "/var/data/jobs/task-1", "-type", "f"],
      ["rg", "needle", "/tmp/task-1"],
      ["rg", "/tmp"],
      ["grep", "needle", "/tmp"],
      ["grep", "-r", "/tmp", "."],
    ]) {
      expect(validateCommandAgainstPolicy({ command, policy })).toMatchObject({
        allowed: true,
        reason: CommandValidationDecisionReason.Allowed,
      });
    }
  });

  it.each([
    'TOOL=/usr/bin/rg; exec "$TOOL" --files /',
    'TOOL=/usr/bin/rg exec "$TOOL" --files /',
    'printf ready\\n\nexec "$TOOL" --files /',
    '( exec "$TOOL" --files / )',
    'exec "${TOOL}" --files /',
    'rg --files "$ROOT"',
    'find "${SEARCH_ROOT:?}" -type f',
    'grep -R needle "$(resolve-root)"',
  ])("rejects unverifiable executable or scan-root expansion in %s", (command) => {
    const policy = {
      validateCommands: true,
      deniedExecutableNames: [],
      deniedGitSubcommands: [],
      deniedPathPrefixes: [],
      deniedInlineCodeExecutables: [],
      deniedScriptExecutables: [],
    };

    expect(validateCommandAgainstPolicy({ command, policy })).toMatchObject({
      allowed: false,
      reason: CommandValidationDecisionReason.GlobalFilesystemScanUnverifiable,
      evidence: [expect.stringMatching(
        /^subscription_runtime_global_scan_unverifiable .*remediation=.*exit_code=64$/,
      )],
    });
  });

  it("preserves statically known guard-owned executable expansion", () => {
    const policy = {
      validateCommands: true,
      deniedExecutableNames: [],
      deniedGitSubcommands: [],
      deniedPathPrefixes: [],
      deniedInlineCodeExecutables: [],
      deniedScriptExecutables: [],
    };

    expect(validateCommandAgainstPolicy({
      command: 'exec "${SUBSCRIPTION_RUNTIME_GLOBAL_SCAN_GUARD_RG_REAL:?missing}" --files ./src',
      policy,
    })).toMatchObject({
      allowed: true,
      reason: CommandValidationDecisionReason.Allowed,
    });
    expect(validateCommandAgainstPolicy({
      command: 'exec "$SUBSCRIPTION_RUNTIME_GLOBAL_SCAN_GUARD_RG_REAL" --files /',
      policy,
    })).toMatchObject({
      allowed: false,
      reason: CommandValidationDecisionReason.GlobalFilesystemScanDenied,
      evidence: [expect.stringMatching(/exit_code=64$/)],
    });
    expect(validateCommandAgainstPolicy({
      command: 'SUBSCRIPTION_RUNTIME_GLOBAL_SCAN_GUARD_RG_REAL=/usr/bin/find; exec "$SUBSCRIPTION_RUNTIME_GLOBAL_SCAN_GUARD_RG_REAL" /',
      policy,
    })).toMatchObject({
      allowed: false,
      reason: CommandValidationDecisionReason.GlobalFilesystemScanUnverifiable,
      evidence: [expect.stringMatching(/exit_code=64$/)],
    });
    expect(validateCommandAgainstPolicy({
      command: "SUBSCRIPTION_RUNTIME_GLOBAL_SCAN_GUARD_RG_REAL=/usr/bin/find bash -lc 'exec \"$SUBSCRIPTION_RUNTIME_GLOBAL_SCAN_GUARD_RG_REAL\" /'",
      policy,
    })).toMatchObject({
      allowed: false,
      reason: CommandValidationDecisionReason.GlobalFilesystemScanUnverifiable,
      evidence: [expect.stringMatching(/exit_code=64$/)],
    });
  });
});
