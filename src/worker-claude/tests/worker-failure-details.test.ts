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
        ignored: "must-not-cross",
      },
    });

    expect(details).toMatchObject({
      code: "provider_output_invalid",
      causeCategory: "error_max_structured_output_retries",
      sdkSubtype: "error_max_structured_output_retries",
      permissionDenials: "1",
      hostPolicyDenials: "StructuredOutput:outside_policy",
      deniedTools: "StructuredOutput",
    });
    expect(details.sdkErrors).toHaveLength(1_000);
    expect(details).not.toHaveProperty("ignored");

    const encoded = errorDetails(new SubscriptionWorkerError(
      "subscription_worker_run_failed",
      "Claude provider output was invalid.",
      { details },
    ));
    expect(encoded).toMatchObject({
      subscriptionWorkerCode: "subscription_worker_run_failed",
      providerFailureCode: "provider_output_invalid",
      sdkSubtype: "error_max_structured_output_retries",
      permissionDenials: "1",
      hostPolicyDenials: "StructuredOutput:outside_policy",
      deniedTools: "StructuredOutput",
    });
    expect(encoded?.sdkErrors).toHaveLength(1_000);
  });
});
