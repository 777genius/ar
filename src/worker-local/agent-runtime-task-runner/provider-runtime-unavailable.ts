import {
  AgentRuntimeFailureCode,
  makeFailedAgentRuntimeTaskResult,
  type AgentRuntimeTaskResult,
} from "@vioxen/subscription-runtime/agent-runtime-task";
import type { RuntimeWarning } from "@vioxen/subscription-runtime/core";
import {
  AgentRuntimeTaskProvider,
  type ProviderName,
} from "./ports";

export class ProviderRuntimeUnavailableError extends Error {
  constructor(
    readonly provider: ProviderName,
    readonly missing: string,
    message: string,
  ) {
    super(message);
    this.name = "ProviderRuntimeUnavailableError";
  }
}

export function providerRuntimeUnavailableResult(
  provider: ProviderName,
  error: unknown,
  warnings: readonly RuntimeWarning[],
): AgentRuntimeTaskResult | undefined {
  const unavailable = classifyProviderRuntimeUnavailable(provider, error);
  if (!unavailable) return undefined;
  return makeFailedAgentRuntimeTaskResult({
    code: AgentRuntimeFailureCode.ProviderRuntimeUnavailable,
    safeMessage: unavailable.safeMessage,
    details: {
      provider,
      missing: unavailable.missing,
    },
    warnings,
  });
}

function classifyProviderRuntimeUnavailable(
  provider: ProviderName,
  error: unknown,
): { readonly missing: string; readonly safeMessage: string } | undefined {
  if (error instanceof ProviderRuntimeUnavailableError) {
    return {
      missing: error.missing,
      safeMessage: `${provider} runtime is unavailable.`,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (
    provider === AgentRuntimeTaskProvider.Claude &&
    message.includes("@anthropic-ai/claude-agent-sdk") &&
    (message.includes("Cannot find package") ||
      message.includes("Cannot find module") ||
      message.includes("ERR_MODULE_NOT_FOUND"))
  ) {
    return {
      missing: "claude-agent-sdk",
      safeMessage: "Claude Agent SDK is unavailable.",
    };
  }
  if (
    provider === AgentRuntimeTaskProvider.Claude &&
    (message.includes("CLAUDE_RUNTIME_DIST_DIR") ||
      message.includes("Cannot find package 'claude-runtime'") ||
      message.includes('Cannot find package "claude-runtime"') ||
      message.includes("Cannot find module 'claude-runtime'") ||
      message.includes('Cannot find module "claude-runtime"') ||
      (message.includes("ERR_MODULE_NOT_FOUND") &&
        message.includes("claude-runtime")))
  ) {
    return {
      missing: "claude-runtime",
      safeMessage: "Claude runtime is unavailable.",
    };
  }
  if (
    provider === AgentRuntimeTaskProvider.Codex &&
    message.includes("ENOENT") &&
    message.toLowerCase().includes("codex")
  ) {
    return {
      missing: "codex",
      safeMessage: "Codex runtime is unavailable.",
    };
  }
  return undefined;
}
