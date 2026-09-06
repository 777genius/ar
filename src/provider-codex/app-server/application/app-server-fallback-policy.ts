import type { RedactorPort } from "@vioxen/subscription-runtime/core";
import type { CodexExecutionResult } from "../../codex-json-execution-engine";
import { safeMessage } from "../domain/app-server-errors";
import { isCodexAppServerOutputLimitError } from "../domain/app-server-errors";
import { isAppServerExecutionReplayUnsafe } from "../domain/app-server-execution-safety";
import { AppServerUsageError, usageFromError } from "../domain/app-server-usage-error";
import type {
  AppServerWaitingForInputResult,
  AppServerWarning,
} from "../domain/app-server-types";
import {
  redactAppServerWarning,
  redactBoundedAppServerWarnings,
} from "./app-server-warning-collector";

export function appServerFallbackWarning(input: {
  readonly error: unknown;
  readonly redactor: RedactorPort;
}): AppServerWarning {
  return redactAppServerWarning({
    warning: {
    code: "codex_app_server_fallback",
    safeMessage: `Codex app-server failed; used codex exec fallback: ${safeMessage(input.error)}`,
    },
    redactor: input.redactor,
    context: "codex-app-server-fallback-warning",
  });
}

export function appServerFallbackIsSafe(error: unknown): boolean {
  return !usageFromError(error) &&
    !isCodexAppServerOutputLimitError(error) &&
    !isAppServerExecutionReplayUnsafe(error);
}

export function redactFallbackAppServerResult(input: {
  readonly error: unknown;
  readonly result: CodexExecutionResult;
  readonly redactor: RedactorPort;
}): CodexExecutionResult {
  try {
    return {
      ...input.result,
      warnings: redactBoundedAppServerWarnings({
        warnings: [
          appServerFallbackWarning({ error: input.error, redactor: input.redactor }),
          ...input.result.warnings,
        ],
        redactor: input.redactor,
        context: "codex-app-server-fallback-result-warning",
      }),
    };
  } catch (error) {
    throw new AppServerUsageError(error, input.result.usage, true);
  }
}

export function isAppServerWaitingForInputResult(
  result: { readonly status?: string },
): result is AppServerWaitingForInputResult {
  return result.status === "waiting_for_input";
}

export function redactWaitingForInputResult(input: {
  readonly result: AppServerWaitingForInputResult;
  readonly outputText: string;
  readonly redactor: RedactorPort;
  readonly warnings: readonly AppServerWarning[];
}): CodexExecutionResult {
  const contextSummary = input.result.request.contextSummary;
  const suggestedAnswers = input.result.request.suggestedAnswers?.map((answer) =>
    input.redactor.redact(answer),
  );
  const providerState = input.result.resumeHandle.providerState;
  return {
    status: "waiting_for_input",
    runId: input.result.runId,
    outputText: input.outputText,
    request: {
      id: input.result.request.id,
      kind: input.result.request.kind,
      question: input.redactor.redact(input.result.request.question),
      ...(contextSummary === undefined
        ? {}
        : { contextSummary: input.redactor.redact(contextSummary) }),
      ...(suggestedAnswers === undefined ? {} : { suggestedAnswers }),
      audience: input.result.request.audience,
    },
    resumeHandle: {
      ...input.result.resumeHandle,
      ...(providerState === undefined
        ? {}
        : { providerState: redactStringRecord(providerState, input.redactor) }),
    },
    warnings: input.warnings,
  };
}

function redactStringRecord(
  record: Readonly<Record<string, string>>,
  redactor: RedactorPort,
): Readonly<Record<string, string>> {
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    redacted[key] = redactor.redact(value);
  }
  return redacted;
}
