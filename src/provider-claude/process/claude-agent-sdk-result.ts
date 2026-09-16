import { sdkClaudeTelemetry } from "./claude-agent-sdk-telemetry";
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import Ajv2020 from "ajv/dist/2020.js";
import {
  AgentRuntimeFailureCode,
  type ProviderFailure,
} from "@vioxen/subscription-runtime/core";
import {
  ClaudeProviderFailureError,
  classifyClaudeFailure,
} from "../protocol/failure-classifier";
import type {
  ClaudeTaskEngineInput,
  ClaudeTaskExecutionResult,
} from "../task/engine-contract";
import type { ClaudeAgentSdkSafeDiagnostics } from "./claude-agent-sdk-safe-diagnostics";

import { ClaudeTaskTelemetryError } from "../protocol/task-telemetry";

export function resultFromSdkMessage(
  message: SDKResultMessage,
  input: ClaudeTaskEngineInput,
  policyAudit: ReadonlySet<string>,
  safeDiagnostics: ClaudeAgentSdkSafeDiagnostics,
): ClaudeTaskExecutionResult {
  try {
    return parseSdkResult(message, input, policyAudit, safeDiagnostics);
  } catch (error) {
    if (error instanceof ClaudeProviderFailureError) {
      throw new ClaudeProviderFailureError(error.failure, sdkClaudeTelemetry(message));
    }
    throw new ClaudeTaskTelemetryError(error, sdkClaudeTelemetry(message));
  }
}

function parseSdkResult(
  message: SDKResultMessage,
  input: ClaudeTaskEngineInput,
  policyAudit: ReadonlySet<string>,
  safeDiagnostics: ClaudeAgentSdkSafeDiagnostics,
): ClaudeTaskExecutionResult {
  if (message.subtype !== "success") {
    throw new ClaudeProviderFailureError(
      failureFromSdkMessage(message, input, policyAudit),
    );
  }
  const outputText = input.redactor.redact(message.result);
  input.redactor.assertNoKnownSecret(outputText, "claude-agent-sdk-result");
  if (message.is_error) {
    throw new ClaudeProviderFailureError(
      failureFromSdkSuccessError(
        message,
        outputText,
        policyAudit,
        input.redactor,
        safeDiagnostics,
      ),
    );
  }
  const structuredOutput = structuredOutputFromSdkMessage(
    message,
    input.outputSchema,
    outputText,
    policyAudit,
    input.redactor,
  );
  const usedStructuredOutputTextFallback =
    input.outputSchema !== undefined &&
    message.structured_output === undefined &&
    structuredOutput !== undefined;
  return {
    outputText,
    ...(structuredOutput === undefined ? {} : { structuredOutput }),
    telemetry: {
      ...sdkClaudeTelemetry(message),
      providerSessionId: message.session_id,
    },
    warnings: usedStructuredOutputTextFallback
      ? [{
          code: "claude_structured_output_text_fallback",
          safeMessage:
            "Claude returned schema-valid JSON text without a structured output attachment.",
        }]
      : [],
  };
}

function structuredOutputFromSdkMessage(
  message: Extract<SDKResultMessage, { readonly subtype: "success" }>,
  outputSchema: Readonly<Record<string, unknown>> | undefined,
  redactedOutputText: string,
  policyAudit: ReadonlySet<string>,
  redactor: ClaudeTaskEngineInput["redactor"],
): unknown {
  if (message.structured_output !== undefined) return message.structured_output;
  if (outputSchema === undefined) return undefined;

  let parsed: unknown;
  try {
    if (redactedOutputText.trim().length === 0) throw new Error("empty");
    parsed = JSON.parse(redactedOutputText);
  } catch {
    throw structuredOutputFailure(
      message,
      policyAudit,
      redactedOutputText.trim().length === 0
        ? "fallback_empty"
        : "fallback_non_json",
      redactor,
    );
  }

  try {
    const validate = new Ajv2020({
      allowUnionTypes: true,
      allErrors: true,
      logger: {
        log() {},
        warn(message) {
          throw new Error(`ajv_warning:${String(message).slice(0, 300)}`);
        },
        error(message) {
          throw new Error(`ajv_error:${String(message).slice(0, 300)}`);
        },
      },
      ownProperties: true,
      strict: false,
    }).compile(outputSchema);
    if (validate(parsed)) return parsed;
  } catch {
    throw structuredOutputFailure(
      message,
      policyAudit,
      "fallback_schema_compile",
      redactor,
    );
  }
  throw structuredOutputFailure(
    message,
    policyAudit,
    "fallback_schema_mismatch",
    redactor,
  );
}

type SdkSuccessFailureReason =
  | "fallback_empty"
  | "fallback_non_json"
  | "fallback_schema_compile"
  | "fallback_schema_mismatch"
  | "success_is_error";

function structuredOutputFailure(
  message: Extract<SDKResultMessage, { readonly subtype: "success" }>,
  policyAudit: ReadonlySet<string>,
  reason: SdkSuccessFailureReason,
  redactor: ClaudeTaskEngineInput["redactor"],
): ClaudeProviderFailureError {
  return new ClaudeProviderFailureError({
    code: AgentRuntimeFailureCode.ProviderOutputInvalid,
    retryable: true,
    reconnectRequired: false,
    safeMessage: "Claude returned no valid structured output.",
    causeCategory: "success_without_structured_output",
    details: sdkSuccessDetails(message, policyAudit, reason, redactor),
  });
}

function failureFromSdkSuccessError(
  message: Extract<SDKResultMessage, { readonly subtype: "success" }>,
  redactedOutputText: string,
  policyAudit: ReadonlySet<string>,
  redactor: ClaudeTaskEngineInput["redactor"],
  safeDiagnostics: ClaudeAgentSdkSafeDiagnostics,
): ProviderFailure {
  const classified = classifyClaudeFailure(new Error(redactedOutputText));
  const causeCategory = classified.causeCategory === "unknown_runtime_failure"
    ? "sdk_success_is_error"
    : classified.causeCategory;
  return {
    ...classified,
    ...(causeCategory === undefined ? {} : { causeCategory }),
    details: sdkSuccessDetails(
      message,
      policyAudit,
      "success_is_error",
      redactor,
      safeDiagnostics.successErrorDetails(message),
    ),
  };
}

function sdkSuccessDetails(
  message: Extract<SDKResultMessage, { readonly subtype: "success" }>,
  policyAudit: ReadonlySet<string>,
  safeReason: SdkSuccessFailureReason,
  redactor: ClaudeTaskEngineInput["redactor"],
  safeDiagnostics: Readonly<Record<string, string>> = {},
): Readonly<Record<string, string>> {
  const deniedTools = safeDeniedTools(message.permission_denials, redactor);
  return {
    sdkSubtype: message.subtype,
    sdkErrors: safeReason,
    permissionDenials: String(message.permission_denials.length),
    hostPolicyDenials: safeHostPolicyDenials(policyAudit),
    ...safeDiagnostics,
    ...(deniedTools === undefined ? {} : { deniedTools }),
  };
}

const knownToolPolicyDenialReasons = [
  "outside_policy",
  "read_only_boundary",
  "invalid_path",
  "path_outside_workspace",
  "git_metadata_path",
  "project_instruction_path",
] as const;

function safeHostPolicyDenials(policyAudit: ReadonlySet<string>): string {
  if (policyAudit.size === 0) return "none";
  const reasons = [...new Set([...policyAudit].map((entry) =>
    knownToolPolicyDenialReasons.find((reason) =>
      entry.endsWith(`:${reason}`)
    ) ?? "unknown_policy_denial"
  ))];
  return reasons.join(",").slice(0, 1_000);
}

function safeDeniedTools(
  permissionDenials: readonly { readonly tool_name: string }[],
  redactor: ClaudeTaskEngineInput["redactor"],
): string | undefined {
  if (permissionDenials.length === 0) return undefined;
  const deniedTools = redactor.redact([...new Set(
    permissionDenials.map((denial) => denial.tool_name),
  )].join(",")).slice(0, 1_000);
  redactor.assertNoKnownSecret(deniedTools, "claude-agent-sdk-denied-tools");
  return deniedTools;
}

function failureFromSdkMessage(
  message: Exclude<SDKResultMessage, { readonly subtype: "success" }>,
  input: ClaudeTaskEngineInput,
  policyAudit: ReadonlySet<string>,
): ProviderFailure {
  const details = sdkErrorDetails(message, input, policyAudit);
  switch (message.subtype) {
    case "error_max_turns":
      return {
        code: AgentRuntimeFailureCode.GoalSliceExhausted,
        retryable: false,
        reconnectRequired: false,
        safeMessage: "Claude task exhausted its maximum turn limit.",
        causeCategory: message.subtype,
        details,
      };
    case "error_max_budget_usd":
      return {
        code: AgentRuntimeFailureCode.BudgetExceeded,
        retryable: false,
        reconnectRequired: false,
        safeMessage: "Claude task exhausted its USD budget.",
        causeCategory: message.subtype,
        details,
      };
    case "error_max_structured_output_retries":
      return {
        code: AgentRuntimeFailureCode.ProviderOutputInvalid,
        retryable: true,
        reconnectRequired: false,
        safeMessage: "Claude could not produce valid structured output.",
        causeCategory: message.subtype,
        details,
      };
    case "error_during_execution":
      return {
        code: AgentRuntimeFailureCode.UnknownRuntimeFailure,
        retryable: true,
        reconnectRequired: false,
        safeMessage: "Claude execution failed.",
        causeCategory: message.subtype,
        details,
      };
  }
}

function sdkErrorDetails(
  message: Exclude<SDKResultMessage, { readonly subtype: "success" }>,
  input: ClaudeTaskEngineInput,
  policyAudit: ReadonlySet<string>,
): Readonly<Record<string, string>> {
  const sdkErrors = input.redactor.redact(message.errors.join("; ")).slice(0, 1_000);
  input.redactor.assertNoKnownSecret(sdkErrors, "claude-agent-sdk-error-details");
  const deniedTools = safeDeniedTools(
    message.permission_denials,
    input.redactor,
  );
  return {
    sdkSubtype: message.subtype,
    permissionDenials: String(message.permission_denials.length),
    hostPolicyDenials: safeHostPolicyDenials(policyAudit),
    ...(deniedTools === undefined ? {} : { deniedTools }),
    ...(sdkErrors.length === 0 ? {} : { sdkErrors }),
  };
}
