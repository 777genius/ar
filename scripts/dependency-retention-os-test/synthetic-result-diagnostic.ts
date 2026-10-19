import type { TransientStartSample } from "./transient-start-diagnostic.ts";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { sameSyntheticDiagnosticFile, syntheticCliStderrDiagnostic } from "./synthetic-cli-diagnostic.ts";
import { attemptFailureReasons, type AttemptFailureReason, type SafeExecutionErrorCode } from "../../dist/worker-core/safe-execution/domain/safe-execution-policy.js";
import type { SubscriptionWorkerErrorCode } from "../../dist/worker-core/errors.js";
import { CodexGoalOriginReason, decodeCodexGoalOriginDiagnostic } from "../../dist/worker-codex/codex-goal-origin-diagnostic.js";

export type SyntheticResultSource = "safe_execution_stdout" | "runtime_result_file";
const runStatuses = ["running", "completed", "waiting_capacity", "partial", "failed", "aborted"] as const;
const returnedRunStatuses = ["completed", "waiting_capacity", "partial", "failed", "aborted"] as const;
const resultStatuses = ["done", "partial", "blocked", "failed"] as const;
const attemptStatuses = ["running", "completed", "blocked", "failed"] as const;
type Status = typeof runStatuses[number] | typeof resultStatuses[number] | typeof attemptStatuses[number];
const runnerReasons = ["runner_exception", "prewarm_failed", "provider_start_failed"] as const;
type Reason = AttemptFailureReason | typeof runnerReasons[number];
const reasons = new Set<string>([...attemptFailureReasons, ...runnerReasons]);
const purpose = "TEST_synthetic_structured_failure_only" as const;
type Identity = { readonly jobId: string; readonly workspace: string };
const validIdentity = (identity: Identity) => /^TEST-os-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(identity.jobId) &&
  identity.workspace === "/var/lib/subscription-runtime-host-policy/dependency-test-jobs/jobs/" + identity.jobId + "/workspace";
// Closed source contracts: safe-execution-policy.ts and worker-core/errors.ts.
const codes = ["safe_execution_invalid_task", "safe_execution_workspace_locked", "safe_execution_workspace_not_git",
  "safe_execution_external_retry_disabled", "safe_execution_continuation_disabled", "safe_execution_attempts_exhausted",
  "subscription_worker_not_started", "subscription_worker_already_started", "subscription_worker_disposed",
  "subscription_worker_start_failed", "subscription_worker_start_timeout", "subscription_worker_prewarm_failed",
  "subscription_worker_run_failed", "subscription_worker_health_failed", "subscription_worker_account_unavailable",
  "subscription_worker_shutdown_timeout", "subscription_worker_pool_draining", "subscription_worker_pool_capacity_unavailable",
  "subscription_worker_pool_queue_full", "subscription_worker_pool_run_aborted", "subscription_worker_pool_empty",
  "subscription_worker_pool_selector_invalid", "subscription_worker_pool_slot_busy", "subscription_worker_pool_slot_not_found",
  "subscription_worker_pool_slot_restart_failed", "subscription_worker_pool_slot_failed"] as const satisfies readonly (SafeExecutionErrorCode | SubscriptionWorkerErrorCode)[];
const codeSet = new Set<string>(codes);
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const member = <T extends string>(values: readonly T[], value: unknown): value is T => typeof value === "string" && values.includes(value as T);
function details(node: Record<string, unknown>) {
  return [node.details, node.failureDetails, node.lastFailureDetails].flatMap(value => { const item = record(value); return item ? [item] : []; });
}
function facts(node: Record<string, unknown>, status: Status) {
  const reason = node.reason ?? node.failureReason ?? node.lastFailureReason;
  const selectedCodes = [record(node.error)?.code, ...details(node).flatMap(value => [value.errorCode, value.safeExecutionCode, value.subscriptionWorkerCode])];
  return { status, ...(typeof reason === "string" && reasons.has(reason) ? { reason: reason as Reason } : {}),
    codes: [...new Set(selectedCodes.filter((code): code is typeof codes[number] => typeof code === "string" && codeSet.has(code)))] };
}

function selectedMessageFields(root: Record<string, unknown>, task: Record<string, unknown> | undefined,
  attempt: Record<string, unknown> | undefined, source: SyntheticResultSource) {
  // Bits follow these seven fixed source fields. Presence is separate from
  // acceptance: unknown types/unsafe text never masquerade as absent fields.
  return [
    ["root.failureDetails.rawCause", source === "safe_execution_stdout" ? record(root.failureDetails)?.rawCause : undefined],
    ["root.details.rawCause", source === "runtime_result_file" ? record(root.details)?.rawCause : undefined],
    ["task.lastFailureDetails.rawCause", record(task?.lastFailureDetails)?.rawCause],
    ["attempt.failureDetails.rawCause", record(attempt?.failureDetails)?.rawCause],
    ["root.safeMessage", source === "safe_execution_stdout" ? root.safeMessage : undefined],
    ["task.lastFailureMessage", task?.lastFailureMessage],
    ["attempt.failureMessage", attempt?.failureMessage],
  ] as const;
}
function selectedMessages(fields: ReturnType<typeof selectedMessageFields>, trusted: boolean, sourceSha: string) {
  const messageFieldPresenceBits = fields.reduce((bits, [, value], index) => bits | (value === undefined ? 0 : 1 << index), 0);
  const messageObservations: { field: typeof fields[number][0]; diagnostic: ReturnType<typeof syntheticCliStderrDiagnostic> }[] = [];
  const seen = new Set<string>();
  for (const [field, value] of fields) {
    if (typeof value !== "string" || seen.has(value)) continue;
    if (messageObservations.length === 3) break;
    seen.add(value);
    // JSON fields are framed as a line, without trimming, truncating or
    // rewriting their text. The existing stderr filter decides acceptance.
    const bytes = Buffer.from(value.endsWith("\n") ? value : value + "\n");
    messageObservations.push({ field, diagnostic: syntheticCliStderrDiagnostic(bytes, {
      fullBytes: bytes.length, offset: 0, initialBytes: bytes.length, currentBytes: bytes.length,
    }, trusted, sourceSha) });
  }
  return { messageFieldPresenceBits, messageObservations };
}

function closedOrigin(value: unknown, rawCause: boolean) {
  if (typeof value !== "string" || value.length > 4096 || Buffer.byteLength(value, "utf8") > 4096) return undefined;
  const decode = (text: string) => decodeCodexGoalOriginDiagnostic(text) ??
    (member(Object.values(CodexGoalOriginReason), text) ? { reason: text, locations: [] } : undefined);
  const direct = decode(value); if (direct || !rawCause) return direct;
  // worker-pool.ts:145 and safe-execution-policy.ts:602 own these exact
  // wrapper/join bytes. No unknown prefix, partial token or raw segment escapes.
  const segments = value.split(" <- ", 5);
  if (segments.length < 2 || segments.length > 4 ||
      segments.slice(0, -1).some(segment => segment !== "Worker pool failed to start.")) return undefined;
  return decode(segments[segments.length - 1]!);
}

/** Observations only from the exact proved fake fresh fixture. Never copy
 * raw result bodies/messages, task IDs, account data or provider output. */
export function syntheticStructuredFailure(bytes: Uint8Array, sample: TransientStartSample, trusted: boolean,
  sourceSha: string, identity: Identity, source: SyntheticResultSource) {
  const refused = { purpose, state: "unavailable" as const };
  if (!trusted || !/^[a-f0-9]{40}$/.test(sourceSha) || bytes.length < 1 || bytes.length > 32768 || sample.offset !== 0 ||
      sample.fullBytes !== bytes.length || sample.initialBytes !== bytes.length || sample.currentBytes !== bytes.length ||
      !validIdentity(identity)) return refused;
  try {
    const text = Buffer.from(bytes).toString("utf8"); if (!Buffer.from(text).equals(bytes)) return refused;
    const root = record(JSON.parse(text)); if (!root) return refused;
    let task: Record<string, unknown> | undefined, attempts: Record<string, unknown>[] = [];
    if (source === "safe_execution_stdout") {
      task = record(root.task);
      if (!member(returnedRunStatuses, root.status) || !task || !member(runStatuses, task.status) || task.taskId !== identity.jobId ||
          task.workspacePath !== identity.workspace || root.taskId !== undefined && root.taskId !== identity.jobId ||
          !Array.isArray(root.attempts) || root.attempts.length > 1 || !Array.isArray(task.attempts) ||
          JSON.stringify(task.attempts) !== JSON.stringify(root.attempts)) return refused;
      for (const item of root.attempts) {
        const attempt = record(item);
        if (!attempt || !member(attemptStatuses, attempt.status) || attempt.taskId !== identity.jobId || attempt.attemptNumber !== 1) return refused;
        attempts.push(attempt);
      }
    } else if (source === "runtime_result_file") {
      if (root.schemaVersion !== 1 || !member(resultStatuses, root.status) || root.provider !== "codex" ||
          root.runId !== identity.jobId || root.taskId !== identity.jobId ||
          ![root.changedFiles, root.evidence, root.blockers].every(value => Array.isArray(value) && value.every(item => typeof item === "string"))) return refused;
    } else return refused;
    const fields = selectedMessageFields(root, task, attempts[0], source);
    const embedded = fields.map(([field, value]) => closedOrigin(value, field.endsWith(".rawCause"))).find(value => value !== undefined);
    return { purpose, state: "captured" as const, source, root: facts(root, root.status as Status),
      ...(task ? { task: facts(task, task.status as Status), attemptCount: attempts.length,
        attempts: attempts.map(attempt => facts(attempt, attempt.status as Status)) } : {}),
      ...(embedded ? { originDiagnostic: embedded } : {}),
      ...selectedMessages(fields, trusted, sourceSha) };
  } catch { return refused; }
}

/** The sole selected file is the verified fake launch's explicit --output.
 * Held descriptor, named file and private parents must stay physically stable. */
export function observeSyntheticResultFile(identity: Identity, trusted: boolean, sourceSha: string) {
  const refused = { purpose, state: "unavailable" as const };
  if (!trusted || !validIdentity(identity) || !/^[a-f0-9]{40}$/.test(sourceSha)) return refused;
  try {
    const root = "/var/lib/subscription-runtime-host-policy/dependency-test-jobs/jobs/" + identity.jobId;
    const parents = [root, root + "/state"].map(path => ({ path, stat: lstatSync(path) }));
    for (const { stat } of parents) if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || stat.gid !== 0 || stat.mode & 0o077) return refused;
    const path = root + "/state/TEST-result.json", before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || before.uid !== 0 || before.gid !== 0 || before.nlink !== 1 || before.mode & 0o077 || before.size < 1 || before.size > 32768) return refused;
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!sameSyntheticDiagnosticFile(before, fstatSync(fd))) return refused;
      const buffer = Buffer.alloc(before.size + 1); let length = 0;
      while (length < buffer.length) { const count = readSync(fd, buffer, length, buffer.length - length, null); if (!count) break; length += count; }
      const current = lstatSync(path), held = fstatSync(fd);
      if (length !== before.size || !sameSyntheticDiagnosticFile(before, current) || !sameSyntheticDiagnosticFile(before, held)) return refused;
      for (const { path: parentPath, stat } of parents) {
        const now = lstatSync(parentPath);
        if (!now.isDirectory() || now.isSymbolicLink() || now.dev !== stat.dev || now.ino !== stat.ino || now.uid !== stat.uid || now.gid !== stat.gid || now.mode !== stat.mode) return refused;
      }
      return syntheticStructuredFailure(buffer.subarray(0, length), { fullBytes: held.size, offset: 0,
        initialBytes: before.size, currentBytes: current.size }, true, sourceSha, identity, "runtime_result_file");
    } finally { closeSync(fd); }
  } catch { return refused; }
}
