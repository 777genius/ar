import { SubscriptionWorkerError } from "@vioxen/subscription-runtime/worker-core";
import { describe, expect, it } from "vitest";

import { errorDetails } from "../../worker-local/agent-runtime-task-runner/error-details";
import { workerFailureDetails } from "../worker-failure-details";

describe("Claude worker failure details", () => {
  it("preserves only bounded provider diagnostics through the CLI boundary", () => {
    const details = workerFailureDetails({
      code: "provider_output_invalid",
      retryable: true,
      reconnectRequired: false,
      safeMessage: "Claude provider output was invalid.",
      causeCategory: "error_max_structured_output_retries",
      details: {
        sdkSubtype: "error_max_structured_output_retries",
        sdkErrors: "x".repeat(1_100),
        permissionDenials: "1",
        hostPolicyDenials: "StructuredOutput:outside_policy",
        deniedTools: "StructuredOutput",
        apiRetryCount: "2",
        apiErrorHttpStatus: "http_429",
        terminalReason: "api_error",
        lastObservedApiRetryError: "overloaded",
        lastObservedApiRetryHttpStatus: "http_529",
        lastObservedAssistantError: "billing_error",
        lastObservedRateLimitStatus: "rejected",
        lastObservedRateLimitType: "overage",
        lastObservedOverageStatus: "rejected",
        lastObservedRateLimitReason: "credits_required",
        rawProviderContent: "must-not-cross-worker",
        providerRequestId: "must-not-cross-worker",
        ignored: "must-not-cross",
      },
    });

    expect(details).toEqual({
      code: "provider_output_invalid",
      retryable: "true",
      reconnectRequired: "false",
      causeCategory: "error_max_structured_output_retries",
      sdkSubtype: "error_max_structured_output_retries",
      sdkErrors: "x".repeat(1_000),
      permissionDenials: "1",
      hostPolicyDenials: "StructuredOutput:outside_policy",
      deniedTools: "StructuredOutput",
      apiRetryCount: "2",
      apiErrorHttpStatus: "http_429",
      terminalReason: "api_error",
      lastObservedApiRetryError: "overloaded",
      lastObservedApiRetryHttpStatus: "http_529",
      lastObservedAssistantError: "billing_error",
      lastObservedRateLimitStatus: "rejected",
      lastObservedRateLimitType: "overage",
      lastObservedOverageStatus: "rejected",
      lastObservedRateLimitReason: "credits_required",
    });

    const encoded = errorDetails(new SubscriptionWorkerError(
      "subscription_worker_run_failed",
      "Claude provider output was invalid.",
      {
        details: {
          ...details,
          rawProviderContent: "must-not-cross-cli",
          providerRequestId: "must-not-cross-cli",
          lastObservedRawError: "must-not-cross-cli",
        },
      },
    ));
    expect(encoded).toEqual({
      subscriptionWorkerCode: "subscription_worker_run_failed",
      providerFailureCode: "provider_output_invalid",
      sdkSubtype: "error_max_structured_output_retries",
      sdkErrors: "x".repeat(1_000),
      permissionDenials: "1",
      hostPolicyDenials: "StructuredOutput:outside_policy",
      deniedTools: "StructuredOutput",
      apiRetryCount: "2",
      apiErrorHttpStatus: "http_429",
      terminalReason: "api_error",
      lastObservedApiRetryError: "overloaded",
      lastObservedApiRetryHttpStatus: "http_529",
      lastObservedAssistantError: "billing_error",
      lastObservedRateLimitStatus: "rejected",
      lastObservedRateLimitType: "overage",
      lastObservedOverageStatus: "rejected",
      lastObservedRateLimitReason: "credits_required",
    });
  });
});
