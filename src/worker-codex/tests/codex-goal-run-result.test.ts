import { describe, expect, it } from "vitest";
import { codexRunnerExceptionFailure } from "../codex-goal-run-result";

describe("codexRunnerExceptionFailure", () => {
  it("reports a malformed provider tool-call stream as a closed reason", () => {
    const failure = codexRunnerExceptionFailure(new Error("MALFORMED_TOOL_CALL_STREAM: content_after_tool_call_start"));
    expect(failure.reason).toBe("provider_stream_malformed");
    expect(failure.safeMessage).not.toContain("MALFORMED_TOOL_CALL_STREAM");
  });

  it("classifies malformed stream evidence nested in a cause chain", () => {
    const error = new Error("turn failed", { cause: new Error("stream: content_after_tool_call_start") });
    expect(codexRunnerExceptionFailure(error).reason).toBe("provider_stream_malformed");
  });

  it("keeps the runner_exception fallback for unrelated errors", () => {
    const failure = codexRunnerExceptionFailure(new Error("unrelated"));
    expect(failure.reason).toBe("runner_exception");
  });
});
