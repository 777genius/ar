import type { RedactorPort } from "@vioxen/subscription-runtime/core";
import type { CodexExecutionResult } from "../../codex-json-execution-engine";
import { assertOutputWithinBounds } from "../domain/app-server-errors";
import { AppServerUsageError } from "../domain/app-server-usage-error";
import type { AppServerRunResult, AppServerWarning } from "../domain/app-server-types";
import {
  isAppServerWaitingForInputResult,
  redactWaitingForInputResult,
} from "./app-server-fallback-policy";
import { redactBoundedAppServerWarnings } from "./app-server-warning-collector";

export function redactCompletedAppServerResult(input: {
  readonly result: AppServerRunResult;
  readonly schemaWarnings: readonly AppServerWarning[];
  readonly redactor: RedactorPort;
  readonly maxOutputBytes: number;
}): CodexExecutionResult {
  try {
    const outputText = input.redactor.redact(input.result.outputText);
    input.redactor.assertNoKnownSecret(outputText, "codex-app-server-output");
    assertOutputWithinBounds(outputText, input.maxOutputBytes);
    const warnings = redactBoundedAppServerWarnings({
      warnings: [...input.schemaWarnings, ...input.result.warnings],
      redactor: input.redactor,
      context: "codex-app-server-result-warning",
    });
    if (isAppServerWaitingForInputResult(input.result)) {
      return redactWaitingForInputResult({
        result: input.result,
        outputText,
        redactor: input.redactor,
        warnings,
      });
    }
    return {
      outputText,
      ...(input.result.usage === undefined ? {} : { usage: input.result.usage }),
      warnings,
    };
  } catch (error) {
    throw new AppServerUsageError(error, input.result.usage, true);
  }
}
