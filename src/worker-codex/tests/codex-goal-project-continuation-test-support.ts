import { createHash } from "node:crypto";

import type { InMemoryAttemptJournal } from "@vioxen/subscription-runtime/worker-core";

export function sha256TestBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function legacyUnsupportedModelPrewarmRawCause(): string {
  return [
    "Codex prewarm transcript:",
    "user",
    "Respond with OK only.",
    'ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-5.6-sol\' model is not supported when using Codex with a ChatGPT account."}}',
    'ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-5.6-sol\' model is not supported when using Codex with a ChatGPT account."}}',
  ].join("\n");
}

export async function recordUnavailableAttempt(
  journal: InMemoryAttemptJournal,
  taskId: string,
  workspacePath: string,
  workspaceDirty = true,
): Promise<void> {
  const now = new Date("2026-07-14T00:00:00.000Z");
  await journal.startTask({
    taskId,
    workspaceRunId: "workspace-run",
    workspacePath,
    effectMode: "workspace_patch",
    provider: "codex",
    now,
  });
  await journal.appendAttempt({
    taskId,
    attempt: {
      taskId,
      attemptNumber: 1,
      accountId: "account-c",
      provider: "codex",
      startedAt: now,
      finishedAt: now,
      status: "blocked",
      failureReason: "account_unavailable",
      workspaceDirtyBefore: workspaceDirty,
      workspaceDirtyAfter: workspaceDirty,
      changedFiles: [],
    },
    now,
  });
  await journal.markPartial({
    taskId,
    status: "waiting_capacity",
    reason: "account_unavailable",
    now,
  });
}
