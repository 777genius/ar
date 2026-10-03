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
    return input.command.length > 0 && input.command.every((part) => part.trim())
      ? input.command
      : null;
  }
  const commandText = input.commandText?.trim();
  if (!commandText) return null;
  // Preserve literal quoted URLs (including ordinary '&' query separators).
  // Expansion and compound shell commands remain subject to interpreter denial.
  const parts: string[] = [];
  let token = "", quote: "'" | '"' | undefined, started = false;
  for (let index = 0; index < commandText.length; index++) {
    const char = commandText[index]!;
    if (quote !== "'" && (char === "$" || char === "`")) return ["sh", "-lc", commandText];
    if (char === "\\" && quote !== "'") {
      const next = commandText[++index];
      if (next === undefined || next === "\n" || next === "\r") return null;
      token += next; started = true; continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      else token += char;
    } else if (char === "'" || char === '"') {
      quote = char; started = true;
    } else if (/[<>|;&\n\r]/.test(char)) {
      return ["sh", "-lc", commandText];
    } else if (/\s/.test(char)) {
      if (started) { parts.push(token); token = ""; started = false; }
    } else { token += char; started = true; }
  }
  if (quote) return null;
  if (started) parts.push(token);
  return parts.length > 0 ? parts : null;
}
