import {
  blockedGlobalFilesystemScanCommand,
  unverifiableGlobalFilesystemScanCommand,
} from "@vioxen/subscription-runtime/worker-core";
import { staticExecCommandsFromCodeModeSource } from "./code-mode-exec-command-parser";

export type CodexPreToolUseHookResult = {
  readonly hookSpecificOutput: {
    readonly hookEventName: "PreToolUse";
    readonly permissionDecision: "deny";
    readonly permissionDecisionReason: string;
  };
};

export function hostedGlobalScanPreToolUseResult(
  input: unknown,
): CodexPreToolUseHookResult | null {
  if (!isRecord(input)) return null;
  if (input.hook_event_name !== "PreToolUse") return null;
  const toolInput = input.tool_input;
  const extraction = shellCommandsForTool(input.tool_name, toolInput);
  if (extraction.dynamicCommand) {
    return deny(
      "subscription_runtime_dynamic_command_blocked " +
        "remediation=pass each tools.exec_command cmd as a static string literal so hosted scan scope can be verified exit_code=64",
    );
  }
  const unverifiable = extraction.commands
    .map(unverifiableGlobalFilesystemScanCommand)
    .find((candidate) => candidate !== null) ?? null;
  if (unverifiable !== null) {
    return deny(
      `subscription_runtime_global_scan_unverifiable expression=${unverifiable.expression} ` +
        "remediation=use a literal executable and bounded filesystem path, or a guard-owned executable environment reference exit_code=64",
    );
  }
  const blocked = extraction.commands
    .map(blockedGlobalFilesystemScanCommand)
    .find((candidate) => candidate !== null) ?? null;
  if (blocked === null) return null;
  return deny(
    `subscription_runtime_global_scan_blocked tool=${blocked.tool} root=${blocked.root} ` +
      "remediation=search an assigned workspace/job descendant, or run the search from the current directory exit_code=64",
  );
}

function deny(reason: string): CodexPreToolUseHookResult {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

type ShellCommandExtraction = {
  readonly commands: readonly string[];
  readonly dynamicCommand: boolean;
};

function shellCommandsForTool(
  toolName: unknown,
  toolInput: unknown,
): ShellCommandExtraction {
  if (toolName === "Bash" && isRecord(toolInput)) {
    return {
      commands: typeof toolInput.command === "string" ? [toolInput.command] : [],
      dynamicCommand: false,
    };
  }
  if (toolName !== "exec") return { commands: [], dynamicCommand: false };
  const sources = typeof toolInput === "string"
    ? [toolInput]
    : isRecord(toolInput)
    ? [toolInput.code, toolInput.input, toolInput.source]
        .filter((value): value is string => typeof value === "string")
    : [];
  const extractions = sources.map(staticExecCommandsFromCodeModeSource);
  return {
    commands: extractions.flatMap((candidate) => candidate.commands),
    dynamicCommand: extractions.some((candidate) => candidate.dynamicCommand),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
