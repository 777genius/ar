import { expect, it } from "vitest";
import { classifyCodexFailure } from "../failure-classifier";
import { CodexAppServerTurnError } from "../app-server/application/app-server-turn-failure";
import { AppServerUsageError } from "../app-server/domain/app-server-usage-error";

const observed = "codex_app_server_error:stream disconnected before completion: Incomplete response returned, reason: max_output_tokens";
it.each(["", "retained partial output"])("classifies incomplete output as terminal token exhaustion with retained turn facts (%s)", output => {
  const error = new CodexAppServerTurnError({ cause: new Error(observed),
    phase: output ? "turn_error_after_output" : "turn_error_before_output",
    outputText: output, turnNumber: 1, elapsedMs: 640283 });
  const failure = classifyCodexFailure(new AppServerUsageError(error, undefined, true));
  expect(failure).toMatchObject({ code: "budget_exceeded", retryable: false,
    reconnectRequired: false, causeCategory: "max_output_tokens",
    details: { incompleteReason: "max_output_tokens", phase: error.failureDetails.phase,
      outputObserved: String(Boolean(output)), outputCharCount: String(output.length), elapsedMs: "640283" } });
});

it.each([
  "error decoding response body",
  "Incomplete response returned, reason: content_filter",
  "max_output_tokens is documented in the prompt",
  "Incomplete response returned, reason: max_output_tokens_other",
])("does not classify unrelated transport or provider failures as token exhaustion (%s)", cause => {
  const error = new CodexAppServerTurnError({ cause: new Error(cause),
    phase: "turn_error_after_output", turnNumber: 1, outputText: "partial", elapsedMs: 42 });
  expect(classifyCodexFailure(error).code).toBe("unknown_runtime_failure");
});

it("does not treat a rejected Start or a plain error containing provider text as an exhausted turn", () => {
  expect(classifyCodexFailure(new Error(observed)).code).toBe("unknown_runtime_failure");
  expect(classifyCodexFailure(new CodexAppServerTurnError({ cause: new Error(observed),
    phase: "turn_start_rejected", turnNumber: 1, elapsedMs: 1 })).code).toBe("unknown_runtime_failure");
});
