import { parseNativeWebEvidence, type NativeWebEvidence, type RedactorPort } from "@vioxen/subscription-runtime/core";
import type { AgentUsage } from "@vioxen/subscription-runtime/core";
import { safeMessage } from "./app-server-errors";
import { sanitizeAgentUsage } from "./app-server-usage";

export class AppServerUsageError extends Error {
  readonly usage?: AgentUsage;
  readonly nativeWeb?: NativeWebEvidence;
  readonly executionMayHaveStarted: boolean;
  constructor(error: unknown, usage?: AgentUsage, executionMayHaveStarted = false, nativeWeb?: NativeWebEvidence) {
    super(safeMessage(error), { cause: error });
    this.name = "AppServerUsageError";
    this.executionMayHaveStarted = executionMayHaveStarted;
    if (nativeWeb) this.nativeWeb = parseNativeWebEvidence(nativeWeb);
    const sanitized = sanitizeAgentUsage(usage);
    if (sanitized) this.usage = sanitized;
  }
}

export function usageFromError(error: unknown): AgentUsage | undefined {
  const seen = new Set<Error>();
  while (error instanceof Error && !seen.has(error)) {
    if (error instanceof AppServerUsageError && error.usage) return error.usage;
    seen.add(error);
    error = error.cause;
  }
  return undefined;
}

/** The outer bounded aggregate is authoritative; callers must merge a rejected
 * turn before wrapping, rather than double-counting the cause chain. */
export function nativeWebFromError(error: unknown): NativeWebEvidence | undefined {
  const seen = new Set<Error>();
  while (error instanceof Error && !seen.has(error)) {
    if (error instanceof AppServerUsageError && error.nativeWeb) return error.nativeWeb;
    seen.add(error); error = error.cause;
  }
  return undefined;
}

export function safeNativeWebFromError(error: unknown, redactor: RedactorPort): NativeWebEvidence | undefined {
  const evidence = nativeWebFromError(error);
  if (!evidence) return undefined;
  try { redactor.assertNoKnownSecret(JSON.stringify(evidence), "codex-native-web-failure"); return evidence; }
  catch { return { turns: [], truncated: true }; }
}
