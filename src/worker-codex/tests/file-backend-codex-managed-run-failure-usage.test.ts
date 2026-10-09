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
