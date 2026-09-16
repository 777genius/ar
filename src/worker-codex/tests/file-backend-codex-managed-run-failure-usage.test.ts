import { describe, expect, it } from "vitest";
import { managedRunFailureToWorkerError } from "../file-backend-codex-managed-run-recovery";

describe("managed Codex run failure usage", () => {
  it("preserves structured provider usage on the worker error", () => {
    const error = managedRunFailureToWorkerError({
      status: "failed",
      failure: {
        code: "goal_slice_exhausted",
        retryable: true,
        reconnectRequired: false,
        safeMessage: "Codex goal reached its turn slice limit.",
      },
      telemetry: {
        finishReason: "max_turns",
        usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
      },
      warnings: [],
    });

    expect(error.usage).toEqual({
      inputTokens: 20,
      outputTokens: 10,
      totalTokens: 30,
    });
  });

  it("does not turn missing provider usage into zero", () => {
    const error = managedRunFailureToWorkerError({
      status: "failed",
      failure: {
        code: "goal_slice_exhausted",
        retryable: true,
        reconnectRequired: false,
        safeMessage: "Codex goal reached its turn slice limit.",
      },
      telemetry: { finishReason: "max_turns" },
      warnings: [],
    });

    expect(error.usage).toBeUndefined();
  });
});
