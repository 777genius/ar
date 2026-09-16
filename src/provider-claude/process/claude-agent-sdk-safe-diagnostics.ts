import type {
  SDKAssistantMessageError,
  SDKMessage,
  SDKResultMessage,
  TerminalReason,
} from "@anthropic-ai/claude-agent-sdk";

const maxObservedApiRetries = 999;

const assistantErrors = new Set<string>([
  "authentication_failed",
  "oauth_org_not_allowed",
  "account_on_hold",
  "billing_error",
  "rate_limit",
  "overloaded",
  "invalid_request",
  "model_not_found",
  "server_error",
  "unknown",
  "max_output_tokens",
] satisfies readonly SDKAssistantMessageError[]);

const rateLimitStatuses = new Set<string>([
  "allowed",
  "allowed_warning",
  "rejected",
]);

const rateLimitTypes = new Set<string>([
  "five_hour",
  "seven_day",
  "seven_day_opus",
  "seven_day_sonnet",
  "seven_day_overage_included",
  "overage",
]);

const rateLimitReasons = new Set<string>([
  "credits_required",
  "overage_not_provisioned",
  "org_level_disabled",
  "org_level_disabled_until",
  "out_of_credits",
  "seat_tier_level_disabled",
  "member_level_disabled",
  "seat_tier_zero_credit_limit",
  "group_zero_credit_limit",
  "member_zero_credit_limit",
  "org_service_level_disabled",
  "no_limits_configured",
  "fetch_error",
  "unknown",
]);

const terminalReasons = new Set<string>([
  "blocking_limit",
  "rapid_refill_breaker",
  "prompt_too_long",
  "image_error",
  "model_error",
  "api_error",
  "malformed_tool_use_exhausted",
  "aborted_streaming",
  "aborted_tools",
  "stop_hook_prevented",
  "hook_stopped",
  "tool_deferred",
  "max_turns",
  "background_requested",
  "completed",
  "budget_exhausted",
  "structured_output_retry_exhausted",
  "tool_deferred_unavailable",
  "turn_setup_failed",
] satisfies readonly TerminalReason[]);

type SafeClaudeDiagnosticsState = {
  apiRetryCount: number;
  lastApiRetryError?: string;
  lastApiRetryHttpStatus?: string;
  lastAssistantError?: string;
  lastRateLimitStatus?: string;
  lastRateLimitType?: string;
  lastOverageStatus?: string;
  lastRateLimitReason?: string;
};

export type ClaudeAgentSdkSafeDiagnostics = {
  observe(message: SDKMessage): void;
  successErrorDetails(
    result: Extract<SDKResultMessage, { readonly subtype: "success" }>,
  ): Readonly<Record<string, string>>;
};

export function createClaudeAgentSdkSafeDiagnostics(): ClaudeAgentSdkSafeDiagnostics {
  const state: SafeClaudeDiagnosticsState = { apiRetryCount: 0 };
  return {
    observe(message) {
      observeMessage(state, message);
    },
    successErrorDetails(result) {
      return safeDetails(state, result);
    },
  };
}

function observeMessage(
  state: SafeClaudeDiagnosticsState,
  message: SDKMessage,
): void {
  if (message.type === "system" && message.subtype === "api_retry") {
    state.apiRetryCount = Math.min(
      maxObservedApiRetries,
      state.apiRetryCount + 1,
    );
    state.lastApiRetryError = normalizeEnum(message.error, assistantErrors);
    state.lastApiRetryHttpStatus = normalizeHttpStatus(message.error_status);
    return;
  }
  if (message.type === "assistant" && message.error !== undefined) {
    state.lastAssistantError = normalizeEnum(message.error, assistantErrors);
    return;
  }
  if (message.type !== "rate_limit_event") return;

  const info = message.rate_limit_info;
  state.lastRateLimitStatus = normalizeEnum(info.status, rateLimitStatuses);
  if (info.rateLimitType !== undefined) {
    state.lastRateLimitType = normalizeEnum(info.rateLimitType, rateLimitTypes);
  }
  if (info.overageStatus !== undefined) {
    state.lastOverageStatus = normalizeEnum(
      info.overageStatus,
      rateLimitStatuses,
    );
  }
  const reason = info.errorCode ?? info.overageDisabledReason;
  if (reason !== undefined) {
    state.lastRateLimitReason = normalizeEnum(reason, rateLimitReasons);
  }
}

function safeDetails(
  state: SafeClaudeDiagnosticsState,
  result: Extract<SDKResultMessage, { readonly subtype: "success" }>,
): Readonly<Record<string, string>> {
  const terminalReason = result.terminal_reason === undefined
    ? undefined
    : normalizeEnum(result.terminal_reason, terminalReasons);
  return {
    apiRetryCount: String(state.apiRetryCount),
    apiErrorHttpStatus: normalizeHttpStatus(result.api_error_status),
    ...(terminalReason === undefined ? {} : { terminalReason }),
    ...(state.lastApiRetryError === undefined
      ? {}
      : { lastObservedApiRetryError: state.lastApiRetryError }),
    ...(state.lastApiRetryHttpStatus === undefined
      ? {}
      : { lastObservedApiRetryHttpStatus: state.lastApiRetryHttpStatus }),
    ...(state.lastAssistantError === undefined
      ? {}
      : { lastObservedAssistantError: state.lastAssistantError }),
    ...(state.lastRateLimitStatus === undefined
      ? {}
      : { lastObservedRateLimitStatus: state.lastRateLimitStatus }),
    ...(state.lastRateLimitType === undefined
      ? {}
      : { lastObservedRateLimitType: state.lastRateLimitType }),
    ...(state.lastOverageStatus === undefined
      ? {}
      : { lastObservedOverageStatus: state.lastOverageStatus }),
    ...(state.lastRateLimitReason === undefined
      ? {}
      : { lastObservedRateLimitReason: state.lastRateLimitReason }),
  };
}

function normalizeEnum(value: unknown, allowed: ReadonlySet<string>): string {
  return typeof value === "string" && allowed.has(value) ? value : "unknown";
}

function normalizeHttpStatus(value: unknown): string {
  if (value === undefined) return "absent";
  if (value === null) return "no_http_response";
  if (Number.isInteger(value) && Number(value) >= 100 && Number(value) <= 599) {
    return `http_${String(value)}`;
  }
  return "invalid_http_status";
}
