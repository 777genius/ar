import type { AgentUsage } from "@vioxen/subscription-runtime/core";
import { safeMessage } from "./app-server-errors";
import { sanitizeAgentUsage } from "./app-server-usage";

export class AppServerUsageError extends Error {
  readonly usage?: AgentUsage;
  readonly executionMayHaveStarted: boolean;
  constructor(error: unknown, usage?: AgentUsage, executionMayHaveStarted = false) {
    super(safeMessage(error), { cause: error });
    this.name = "AppServerUsageError";
    this.executionMayHaveStarted = executionMayHaveStarted;
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
