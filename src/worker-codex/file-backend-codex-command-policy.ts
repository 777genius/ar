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
    if (input.command.length === 3 && isShellExecutable(input.command[0] ?? "") &&
        (input.command[1] === "-c" || input.command[1] === "-lc")) {
      return commandTextApprovalVector(input.command[2] ?? "");
    }
    return input.command.length > 0 && input.command.every((part) => part.trim())
      ? input.command
      : null;
  }
  return commandTextApprovalVector(input.commandText ?? "");
}

function commandTextApprovalVector(value: string, depth = 0): readonly string[] | null {
  const commandText = value.trim();
  if (!commandText) return null;
  const shellPayload = shellCommandTextPayload(commandText);
  if (shellPayload !== undefined) {
    return shellPayload === null || depth >= 8
      ? ["sh", "-lc", commandText]
      : commandTextApprovalVector(shellPayload, depth + 1);
  }
  // Preserve literal quoted URLs (including ordinary '&' query separators).
  // Expansion and compound shell commands remain subject to interpreter denial.
  const parts: string[] = [];
  let encoded = false;
  let token = "", quote: "'" | '"' | undefined, started = false;
  for (let index = 0; index < commandText.length; index++) {
    const char = commandText[index]!;
    if (quote !== "'" && (char === "$" || char === "`")) return ["sh", "-lc", commandText];
    if (char === "\\" && quote !== "'") {
      const next = commandText[++index];
      if (next === undefined || next === "\n" || next === "\r") return null;
      // Double-quoted backslashes only escape these shell characters.
      if (quote === '"' && !['$', '`', '"', '\\'].includes(next)) token += "\\";
      token += next; encoded = true; started = true; continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      else token += char;
    } else if (char === "'" || char === '"') {
      quote = char; encoded = true; started = true;
    } else if (/[<>|;&*?\[\]{}()\n\r]/.test(char)) {
      return ["sh", "-lc", commandText];
    } else if (/\s/.test(char)) {
      if (started) { parts.push(token); token = ""; started = false; }
    } else { token += char; started = true; }
  }
  if (quote) return null;
  if (started) parts.push(token);
  // Keep the existing conservative Git syntax boundary. Shell quotes and
  // escapes in Git text still require an interpreter review; direct argv
  // remains literal. Ordinary quoted network operands need no expansion.
  if (encoded && isGitExecutable(parts[0] ?? "")) return ["sh", "-lc", commandText];
  return parts.length > 0 ? parts : null;
}

function isShellExecutable(value: string): boolean {
  const executable = value.replaceAll("\\", "/").split("/").filter(Boolean).at(-1);
  return executable === "bash" || executable === "sh" || executable === "zsh";
}

function shellCommandTextPayload(value: string): string | null | undefined {
  // Unwrap only a literal executable/path: shell syntax in a greedy path
  // prefix can execute another command before the apparent read wrapper.
  const match = value.match(/^(?:[A-Za-z0-9_.\/-]*\/)?(?:bash|sh|zsh)[ \t]+(?:-lc|-c)[ \t]+(.+)$/);
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
    encodedPayload.endsWith('"')
  ) {
    return literalDoubleQuotedShellPayload(encodedPayload.slice(1, -1));
  }
  return /\s|['"]/.test(encodedPayload) ? null : encodedPayload;
}

function literalDoubleQuotedShellPayload(value: string): string | null {
  // Apostrophes are data inside outer double quotes: they cannot protect
  // expansion before the inner shell starts. Decode only this literal layer,
  // then let commandTextApprovalVector review the resulting inner body.
  let payload = "";
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!;
    if (char === "$" || char === "`" || char === '"') return null;
    if (char === "\\") {
      const next = value[++index];
      if (next === undefined || next === "\n" || next === "\r") return null;
      // In double quotes, other backslashes survive into the inner body.
      if (!['$', '`', '"', '\\'].includes(next)) payload += "\\";
      payload += next;
    } else {
      payload += char;
    }
  }
  return payload;
}

function isGitExecutable(value: string): boolean {
  return value.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) === "git";
}
