import type { RedactorPort } from "@vioxen/subscription-runtime/core";
import type { CodexExecutionResult } from "../../codex-json-execution-engine";
import { safeMessage } from "../domain/app-server-errors";
import { isCodexAppServerOutputLimitError } from "../domain/app-server-errors";
import { isAppServerExecutionReplayUnsafe } from "../domain/app-server-execution-safety";
import { usageFromError } from "../domain/app-server-usage-error";
import type {
  AppServerWaitingForInputResult,
  AppServerWarning,
} from "../domain/app-server-types";

export function appServerFallbackWarning(error: unknown): AppServerWarning {
  return {
    code: "codex_app_server_fallback",
    safeMessage: `Codex app-server failed; used codex exec fallback: ${safeMessage(error)}`,
  };
}

export function appServerFallbackIsSafe(error: unknown): boolean {
  return !usageFromError(error) &&
    !isCodexAppServerOutputLimitError(error) &&
    !isAppServerExecutionReplayUnsafe(error);
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
    warnings: input.result.warnings,
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
