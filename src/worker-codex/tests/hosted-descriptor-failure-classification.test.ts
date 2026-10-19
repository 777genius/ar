import { expect, it } from "vitest";
import { SubscriptionWorkerError } from "../../worker-core/errors";
import { defaultSafeExecutionErrorClassifier, failureDetailsFromUnknown } from "../../worker-core/safe-execution/domain/safe-execution-policy";
import { AppServerLaunchStderrFact, createAppServerLaunchStderrObservation } from "../../provider-codex/app-server/application/app-server-launch-stderr";
import { AppServerProviderSetupStage as Stage, AppServerProviderSetupCheckpoint as Checkpoint, AppServerProviderSetupCode as Code,
  retainAppServerProviderSetupFailure, appServerProviderSetupFailureCause } from "../../provider-codex/app-server/domain/app-server-provider-setup-observation";

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

it("keeps FDA setup observations outside worker failure and retry decisions", () => {
  for (const stage of Object.values(Stage)) for (const checkpoint of Object.values(Checkpoint)) for (const count of [401, 403, 429, 502, 503]) {
    const child = {}, original = new Error("codex_app_server_exited:70");
    retainAppServerProviderSetupFailure(child, { stage, checkpoint, code: Code.Boundary, ready: true,
      released: false, elapsedMsCapped: count, limitMs: count });
    const observed = new Error(original.message, { cause: appServerProviderSetupFailureCause(child) });
    for (const wrap of [(error: Error) => error, (error: Error) => new SubscriptionWorkerError(
      "subscription_worker_pool_slot_failed", "Worker pool slot failed to run a task.", { cause: error })]) {
      const before = defaultSafeExecutionErrorClassifier(wrap(original)), after = defaultSafeExecutionErrorClassifier(wrap(observed));
      expect({ reason: after.reason, retryable: after.retryable, safeMessage: after.safeMessage })
        .toEqual({ reason: before.reason, retryable: before.retryable, safeMessage: before.safeMessage });
    }
  }
});

it("keeps app-server stderr observations outside failure and retry decisions", () => {
  for (const fact of Object.values(AppServerLaunchStderrFact)) {
    const original = new Error("codex_app_server_exited:70");
    const observed = new Error(original.message, { cause: new Error(`app_server_stderr label=${fact}`) });
    for (const wrap of [(error: Error) => error, (error: Error) => new SubscriptionWorkerError(
      "subscription_worker_pool_slot_failed", "Worker pool slot failed to run a task.", { cause: error })]) {
      const before = defaultSafeExecutionErrorClassifier(wrap(original)), after = defaultSafeExecutionErrorClassifier(wrap(observed));
      expect({ reason: after.reason, retryable: after.retryable, safeMessage: after.safeMessage })
        .toEqual({ reason: before.reason, retryable: before.retryable, safeMessage: before.safeMessage });
    }
  }
  const observation = createAppServerLaunchStderrObservation();
  observation.observe("hosted_app_server_research_bootstrap_timeout\n");
  const cause = observation.snapshotCause();
  expect(cause?.message).toBe("app_server_stderr label=research_bootstrap_deadline");
  expect(failureDetailsFromUnknown(new Error("codex_app_server_exited:70", { cause }))?.rawCause)
    .toBe("codex_app_server_exited:70 <- app_server_stderr label=research_bootstrap_deadline");
});
