import { expect, it } from "vitest";
import { SubscriptionWorkerError } from "../../worker-core/errors";
import { defaultSafeExecutionErrorClassifier, failureDetailsFromUnknown } from "../../worker-core/safe-execution/domain/safe-execution-policy";

it("preserves normalized failure classification while transporting closed cause facts", () => {
  const message = "hosted_custody_inherited_handle_denied";
  const fact = "hosted_fd_fact fd=24 type=file access=write role=event";
  const denied = new Error(message, { cause: new Error(fact) });
  const wrapped = new SubscriptionWorkerError("subscription_worker_start_failed", "Worker pool failed to start.", { cause: denied });
  for (const error of [denied, wrapped]) {
    expect(defaultSafeExecutionErrorClassifier(error).reason).toBe("unknown_error");
    expect(failureDetailsFromUnknown(error)?.rawCause).toBe(error === denied ? `${message} <- ${fact}` : `Worker pool failed to start. <- ${message} <- ${fact}`);
  }
  expect(denied.message).toBe(message);
});
