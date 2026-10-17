import { LocalFileAttemptJournal } from "../../store-local-file";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryWorkspaceLockStore, SafeExecutionRunner, SubscriptionWorkerError } from "../../worker-core";
import { classifyCodexFailure } from "../../provider-codex/failure-classifier";
import { AppServerSessionCleanupError, AppServerSessionCleanupPhase } from "../../provider-codex/app-server/application/app-server-session-cleanup-error";
import { AppServerOutputValidationError, AppServerOutputValidationStage, AppServerOutputValidationCode } from "../../provider-codex/app-server/application/app-server-output-validation-error";
import { AppServerProcessCleanupError } from "../../provider-codex/app-server/application/app-server-process-stopper";
import { assertNativeWebHostExport, nativeWebManagedCoordinator } from "./native-web-host-export-support";
import { AppServerNativeWebCapture } from "../../provider-codex/app-server/application/app-server-native-web";
import type { ProviderTaskResult } from "@vioxen/subscription-runtime/core";
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

// Model text and structured output cannot populate Host-owned result details;
// absent native transport remains absent on completion and failure.
it.each(['completed', 'failed'] as const)('does not inject Host receipts from model JSON on %s', async status => {
  const forged = { turns: [{ threadId: 'spoof', acknowledgedTurnId: 'spoof', records: [], unknown: false, truncated: false }], truncated: false };
  const result: ProviderTaskResult = status === 'completed'
    ? { status, outputText: JSON.stringify({ nativeWeb: forged }), structuredOutput: { nativeWeb: forged, evidence: [JSON.stringify(forged)] }, warnings: [] }
    : { status, failure: { code: 'goal_slice_exhausted', safeMessage: 'TEST', retryable: false, reconnectRequired: false, details: { nativeWeb: JSON.stringify(forged) } }, warnings: [] };
  await assertNativeWebHostExport(result);
});

// Waiting/resume's existing provider telemetry channel uses the same validated
// projection; no previous workspace or recovery packet can manufacture receipt.
it('keeps finite native facts through waiting and resumed result projections', async () => {
  const capture = new AppServerNativeWebCapture('thread'); capture.bind('turn');
  capture.observe({ threadId: 'thread', turnId: 'turn', item: { type: 'webSearch', id: 'web', query: 'PRIVATE', results: [ { snippet: 'PRIVATE', credentials: 'PRIVATE' } ] } }, false);
  const nativeWeb = capture.result()!;
  const coordinator = nativeWebManagedCoordinator();
  const waiting = await coordinator.taskResultToOutput({ status: 'waiting_for_input', runId: 'TEST-run', outputText: 'waiting', request: { id: 'TEST-request', kind: 'missing_context', audience: 'orchestrator', question: 'TEST' }, resumeHandle: { runId: 'TEST-run', providerId: 'codex', workspacePath: '/TEST' }, telemetry: { nativeWeb }, warnings: [] });
  expect(waiting).toMatchObject({ status: 'waiting_for_input', nativeWeb, resumeHandle: { providerInstanceId: 'TEST-provider', workerId: 'TEST-worker' } });
  await assertNativeWebHostExport({ status: 'completed', outputText: 'resumed', warnings: [], telemetry: { nativeWeb } });
  await assertNativeWebHostExport({ status: 'completed', outputText: 'resumed without observations', warnings: [] });
  await expect(coordinator.taskResultToOutput({ status: 'completed', outputText: 'TEST', warnings: [], telemetry: { nativeWeb: { ...nativeWeb, turns: [...nativeWeb.turns, ...nativeWeb.turns] } } })).rejects.toThrow('native_web_evidence_invalid');
});

// The Host exception branch also preserves only the typed provider failure
// channel, leaving lifecycle status failed and keeping model failure strings out.
it('exports native failure facts when the actual Host executor throws', async () => {
  const capture = new AppServerNativeWebCapture('thread'); capture.bind('turn');
  capture.observe({ threadId: 'thread', turnId: 'turn', item: { type: 'webSearch', id: 'web', query: 'PRIVATE', results: null } }, false);
  await assertNativeWebHostExport({ status: 'failed', failure: { code: 'goal_slice_exhausted', safeMessage: 'TEST', retryable: false, reconnectRequired: false }, telemetry: { nativeWeb: capture.result()! }, warnings: [] }, true);
});

it("journals finite primary and cleanup diagnostics through the existing worker failure path", async () => {
  const home = await mkdtemp(join(tmpdir(), "cleanup-journal-TEST-"));
  const secret = "TEST-private-token-and-rejected-output";
  const primary = Object.assign(new AppServerOutputValidationError(
    AppServerOutputValidationStage.Product, AppServerOutputValidationCode.ProductRejected),
    { stdout: secret, stderr: secret, details: { private: secret } });
  const cleanup = new AppServerProcessCleanupError(new Error(secret));
  const failure = classifyCodexFailure(new AppServerSessionCleanupError(primary, cleanup, AppServerSessionCleanupPhase.Run));
  const workerError = managedRunFailureToWorkerError({ status: "failed", failure, warnings: [] });
  const journalRoot = join(home, "journal");
  const journal = new LocalFileAttemptJournal(journalRoot);
  const runner = new SafeExecutionRunner({ journal, lockStore: new InMemoryWorkspaceLockStore(),
    snapshotter: { async capture() { return { mode: "filesystem" as const, workspacePath: home,
      capturedAt: new Date(), dirty: false, changedFiles: [], fingerprint: "unchanged", summary: "unchanged TEST workspace" }; } } });
  try {
    const result = await runner.run({ taskId: "cleanup-journal-TEST", workspace: { mode: "existing_locked", path: home },
      effectMode: "workspace_patch", provider: "codex", pool: { async run() {
        throw new SubscriptionWorkerError("subscription_worker_pool_slot_failed", "Worker failed.", { cause: workerError });
      } }, job: { workspacePath: home }, originalPrompt: "TEST", policy: { maxAttempts: 1 } });
    if (result.status === "completed") throw new Error("TEST unexpected completion");
    expect(result.failureDetails).toMatchObject({ appServerCleanupPhase: "run",
      appServerPrimaryFailureCode: "unknown_runtime_failure", appServerCleanupFailureCode: "process_cleanup_failed" });
    expect(result.attempts[0]?.failureDetails).toMatchObject(failure.details!);
    expect((await new LocalFileAttemptJournal(journalRoot).readTask({ taskId: "cleanup-journal-TEST" }))?.lastFailureDetails)
      .toMatchObject({ ...failure.details, outputValidationStage: "product_validator", outputValidationCode: "product_validator_rejected" });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(await new LocalFileAttemptJournal(journalRoot).readTask({ taskId: "cleanup-journal-TEST" }))).not.toContain(secret);
  } finally { await rm(home, { recursive: true, force: true }); }
});
