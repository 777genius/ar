import type { ObservabilityPort } from "@vioxen/subscription-runtime/core";
import type {
  CodexAppServerCommandApprovalPolicy,
} from "@vioxen/subscription-runtime/provider-codex";
import type { CommandPolicy } from "@vioxen/subscription-runtime/worker-core";
import { validateCommandAgainstPolicy } from "@vioxen/subscription-runtime/worker-core";

export function codexAppServerCommandApprovalPolicy(
  policy: CommandPolicy,
  observability: ObservabilityPort,
  metadata: Readonly<Record<string, string>>,
): CodexAppServerCommandApprovalPolicy {
  return {
    reviewCommand(input) {
      const command = commandApprovalVector(input);
      if (command === null) {
        observability.emit({
          name: "command_policy.denied",
          providerId: "codex",
          metadata: {
            ...metadata,
            reason: "command_unparseable",
            source: input.source,
          },
        });
        return { approved: false, reason: "command_unparseable" };
      }
      const decision = validateCommandAgainstPolicy({ command, policy });
      if (!decision.allowed) {
        observability.emit({
          name: "command_policy.denied",
          providerId: "codex",
          metadata: {
            ...metadata,
            reason: decision.reason,
            source: input.source,
            ...(decision.executableName === undefined
              ? {}
              : { executableName: decision.executableName }),
          },
        });
      }
      return {
        approved: decision.allowed,
        reason: decision.allowed ? "command_policy_allowed" : decision.reason,
      };
    },
  };
}

function commandApprovalVector(input: {
  readonly command?: readonly string[];
  readonly commandText?: string;
}): readonly string[] | null {
  if (input.command !== undefined) {
    if (
      input.command.length === 3 &&
      isShellExecutable(input.command[0] ?? "") &&
      (input.command[1] === "-c" || input.command[1] === "-lc")
    ) {
      return commandTextApprovalVector(input.command[2] ?? "");
    }
    return input.command.length > 0 && input.command.every((part) => part.trim())
      ? input.command
      : null;
  }
  return commandTextApprovalVector(input.commandText ?? "");
}

function commandTextApprovalVector(commandTextInput: string): readonly string[] | null {
  const commandText = commandTextInput.trim();
  if (!commandText) return null;
  // Shell expansion and grouping can change the executable or its arguments.
  // Reject before unwrapping even quoted payloads; splitting is not a shell parser.
  if (/[*?\[\]{}()]/.test(commandText)) {
    return ["sh", "-lc", commandText];
  }
  const shellPayload = shellCommandTextPayload(commandText);
  if (shellPayload !== undefined) {
    return shellPayload === null
      ? ["sh", "-lc", commandText]
      : commandTextApprovalVector(shellPayload);
  }
  // Whitespace splitting cannot interpret shell quoting or escapes safely.
  if (/['"\\`$<>|;&\n\r]/.test(commandText)) {
    return ["sh", "-lc", commandText];
  }
  const parts = commandText.split(/\s+/).filter(Boolean);
  return parts.length > 0 ? parts : null;
}

function isShellExecutable(value: string): boolean {
  const executable = value.replaceAll("\\", "/").split("/").filter(Boolean).at(-1);
  return executable === "bash" || executable === "sh" || executable === "zsh";
}

function shellCommandTextPayload(value: string): string | null | undefined {
  const match = value.match(/^(?:\S*\/)?(?:bash|sh|zsh)\s+(?:-lc|-c)\s+(.+)$/);
  if (!match) return undefined;
  const encodedPayload = match[1]?.trim() ?? "";
  if (!encodedPayload) return null;
  if (
    encodedPayload.startsWith("'") &&
    encodedPayload.endsWith("'") &&
    !encodedPayload.slice(1, -1).includes("'")
  ) {
    return encodedPayload.slice(1, -1);
  }
  if (
    encodedPayload.startsWith('"') &&
    encodedPayload.endsWith('"') &&
    !encodedPayload.slice(1, -1).includes('"')
  ) {
    return encodedPayload.slice(1, -1);
  }
  return /\s|['"]/.test(encodedPayload) ? null : encodedPayload;
}
