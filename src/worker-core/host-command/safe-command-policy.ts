import {
  blockedGlobalFilesystemScan,
  blockedGlobalFilesystemScanCommand,
  unverifiableGlobalFilesystemScanCommand,
} from "./global-filesystem-scan-policy";

export type CommandPolicy = {
  readonly validateCommands: boolean;
  readonly deniedExecutableNames: readonly string[];
  readonly deniedGitSubcommands: readonly string[];
  readonly deniedPathPrefixes: readonly string[];
  readonly deniedInlineCodeExecutables: readonly string[];
  readonly deniedScriptExecutables: readonly string[];
};

export enum CommandValidationDecisionReason {
  Allowed = "allowed",
  ValidationDisabled = "validation_disabled",
  EmptyCommand = "empty_command",
  DeniedExecutable = "denied_executable",
  DeniedGitSubcommand = "denied_git_subcommand",
  DeniedPathPrefix = "denied_path_prefix",
  InlineCodeDenied = "inline_code_denied",
  ScriptInterpreterDenied = "script_interpreter_denied",
  GlobalFilesystemScanDenied = "global_filesystem_scan_denied",
  GlobalFilesystemScanUnverifiable = "global_filesystem_scan_unverifiable",
}

export type CommandValidationDecision = {
  readonly allowed: boolean;
  readonly reason: CommandValidationDecisionReason;
  readonly executableName?: string;
  readonly evidence: readonly string[];
};

export function validateCommandAgainstPolicy(input: {
  readonly command: readonly string[] | string;
  readonly policy: CommandPolicy;
}): CommandValidationDecision {
  if (!input.policy.validateCommands) {
    return commandAllowed(CommandValidationDecisionReason.ValidationDisabled);
  }
  const args = typeof input.command === "string"
    ? simpleCommandTokens(input.command)
    : input.command;
  if (args.length === 0 || !args[0]?.trim()) {
    return commandDenied(CommandValidationDecisionReason.EmptyCommand);
  }
  const executableName = executableBaseName(args[0] as string);
  if (input.policy.deniedExecutableNames.includes(executableName)) {
    return commandDenied(CommandValidationDecisionReason.DeniedExecutable, {
      executableName,
      evidence: [`${executableName} is denied by command policy`],
    });
  }
  if (
    executableName === "git" &&
    input.policy.deniedGitSubcommands.includes(args[1] ?? "")
  ) {
    return commandDenied(CommandValidationDecisionReason.DeniedGitSubcommand, {
      executableName,
      evidence: [`git ${args[1] ?? ""} is denied by command policy`],
    });
  }
  if (
    input.policy.deniedInlineCodeExecutables.includes(executableName) &&
    (args[1] === "-c" || args[1] === "-e")
  ) {
    return commandDenied(CommandValidationDecisionReason.InlineCodeDenied, {
      executableName,
      evidence: [`${executableName} inline code execution is denied`],
    });
  }
  if (
    input.policy.deniedScriptExecutables.includes(executableName) &&
    args.length > 1
  ) {
    return commandDenied(CommandValidationDecisionReason.ScriptInterpreterDenied, {
      executableName,
      evidence: [`${executableName} script execution is denied`],
    });
  }
  const unverifiableScan = typeof input.command === "string"
    ? unverifiableGlobalFilesystemScanCommand(input.command)
    : null;
  if (unverifiableScan !== null) {
    return commandDenied(CommandValidationDecisionReason.GlobalFilesystemScanUnverifiable, {
      executableName,
      evidence: [
        `subscription_runtime_global_scan_unverifiable expression=${unverifiableScan.expression} remediation=use a literal executable and bounded filesystem path, or a guard-owned executable environment reference exit_code=64`,
      ],
    });
  }
  const blockedScan = typeof input.command === "string"
    ? blockedGlobalFilesystemScanCommand(input.command)
    : blockedGlobalFilesystemScan(args);
  if (blockedScan !== null) {
    return commandDenied(CommandValidationDecisionReason.GlobalFilesystemScanDenied, {
      executableName,
      evidence: [
        `subscription_runtime_global_scan_blocked tool=${blockedScan.tool} root=${blockedScan.root} remediation=search an assigned workspace/job descendant, or run the search from the current directory exit_code=64`,
      ],
    });
  }
  const commandText = args.join(" ");
  const deniedPath = input.policy.deniedPathPrefixes.find((prefix) =>
    commandText.includes(prefix)
  );
  if (deniedPath) {
    return commandDenied(CommandValidationDecisionReason.DeniedPathPrefix, {
      executableName,
      evidence: [`command references denied path prefix ${deniedPath}`],
    });
  }
  return commandAllowed(CommandValidationDecisionReason.Allowed, executableName);
}

function commandAllowed(
  reason: CommandValidationDecisionReason,
  executableName?: string,
): CommandValidationDecision {
  return {
    allowed: true,
    reason,
    ...(executableName ? { executableName } : {}),
    evidence: [],
  };
}

function commandDenied(
  reason: CommandValidationDecisionReason,
  options: {
    readonly executableName?: string;
    readonly evidence?: readonly string[];
  } = {},
): CommandValidationDecision {
  return {
    allowed: false,
    reason,
    ...(options.executableName ? { executableName: options.executableName } : {}),
    evidence: options.evidence ?? [],
  };
}

function executableBaseName(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  return normalized.split("/").filter(Boolean).at(-1) ?? value;
}

function simpleCommandTokens(command: string): readonly string[] {
  return command.trim().split(/\s+/).filter(Boolean);
}
