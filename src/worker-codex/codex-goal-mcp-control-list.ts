import { createHash } from "node:crypto";
import type { WorkerControlSignalView } from "@vioxen/subscription-runtime/worker-core";
import { readCodexGoalControlSignals } from "./application/codex-goal-worker-control-use-cases";
import type { CodexGoalWorkerControlInput } from "./application/codex-goal-use-case-inputs";
import { mcpJson } from "./codex-goal-mcp-response";

export enum ControlListState {
  All = "all",
  Pending = "pending",
  Accepted = "accepted",
  InterruptRequested = "interrupt_requested",
  Interrupting = "interrupting",
  Interrupted = "interrupted",
  Delivered = "delivered",
  Continued = "continued",
  Acknowledged = "acknowledged",
  Superseded = "superseded",
  Expired = "expired",
  Rejected = "rejected",
  Failed = "failed"
}

export type ControlListInput = CodexGoalWorkerControlInput & {
  readonly limit?: number;
  readonly cursor?: string;
  readonly state?: ControlListState;
};

export const CONTROL_LIST_MAX_BYTES = 64 * 1024;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const retrieval = "Use WorkerControlService.listSignals({target, includeBodies:true, includeExpired:true}) and select signal.signalId for the full stored signal/body; control_list is a compact projection.";

function compact(view: WorkerControlSignalView, includeBodies: boolean) {
  const clippedFields: string[] = [];
  const clip = (value: string, field: string) => {
    if (value.length <= 512)
      return value;
    clippedFields.push(field);
    return value.slice(0, 512);
  };
  return {
    signal: {
      signalId: clip(view.signal.signalId, "signalId"),
      idempotencyKey: clip(view.signal.idempotencyKey, "idempotencyKey"),
      intent: view.signal.intent,
      deliveryMode: view.signal.deliveryMode,
      createdAt: view.signal.createdAt.toISOString(),
      priority: view.signal.priority,
      ...(includeBodies ? { body: view.signal.body } : {}),
    },
    state: view.state,
    expired: view.expired,
    deliverable: view.deliverable,
    ...(view.blockedReason ? { blockedReason: clip(view.blockedReason, "blockedReason") } : {}),
    ...(view.latestReceipt ? { latestReceipt: {
        state: view.latestReceipt.state,
        ...(view.latestReceipt.deliveryAttemptId ? {
          deliveryAttemptId: clip(view.latestReceipt.deliveryAttemptId, "deliveryAttemptId"),
        } : {}),
      } } : {}),
    ...(clippedFields.length ? { truncatedFields: clippedFields, retrieval } : {}),
  };
}

/** Bound the actual MCP result, including its duplicated text/structured content. */
export async function listCodexGoalControlSignalsMcp(args: ControlListInput) {
  const limit = args.limit ?? 50;
  const state = args.state ?? ControlListState.Pending;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("limit must be an integer between 1 and 100");
  }
  if (!Object.values(ControlListState).includes(state))
    throw new Error("Invalid control list state");
  if (args.cursor !== undefined && !/^v1\.[a-f0-9]{64}\.[a-f0-9]{64}$/.test(args.cursor)) {
    throw new Error("Invalid control list cursor");
  }
  const { signals, ...context } = await readCodexGoalControlSignals(args);
  const scope = hash(JSON.stringify([context.registryRootDir, context.jobId, context.taskId, state]));
  const ordered = [...signals].sort((a, b) => a.signal.createdAt.getTime() - b.signal.createdAt.getTime()
    || (a.signal.signalId < b.signal.signalId ? -1 : a.signal.signalId > b.signal.signalId ? 1 : 0));
  const key = (view: WorkerControlSignalView) => hash(JSON.stringify([
    view.signal.createdAt.toISOString(), view.signal.signalId,
  ]));
  let after = -1;
  if (args.cursor !== undefined) {
    const [, cursorScope, cursorKey] = args.cursor.split(".");
    if (cursorScope !== scope)
      throw new Error("Cursor belongs to a different job or state filter");
    after = ordered.findIndex((view) => key(view) === cursorKey);
    if (after < 0)
      throw new Error("Stale control list cursor; restart pagination without cursor");
  }
  const counts = Object.fromEntries(Object.values(ControlListState)
    .filter((value) => value !== ControlListState.All).map((value) => [value, 0]));
  for (const view of signals)
    counts[view.state] = (counts[view.state] ?? 0) + 1;
  const filtered = ordered.filter((view, index) => index > after &&
    (state === ControlListState.All || view.state === state));
  const rows: Record<string, unknown>[] = [];
  let nextCursor: string | null = null;
  const payload = () => ({
    ...context,
    signals: rows,
    page: { state, limit, returned: rows.length, nextCursor, hasMore: nextCursor !== null },
    counts: { total: signals.length, ...counts },
    compact: true,
    maxResponseBytes: CONTROL_LIST_MAX_BYTES,
  });
  const envelope = () => {
    const value = payload();
    return { ...mcpJson(value), structuredContent: value };
  };
  if (bytes(envelope()) > CONTROL_LIST_MAX_BYTES)
    throw new Error("Control list context exceeds response byte limit");
  for (const [index, view] of filtered.entries()) {
    const previousCursor = nextCursor;
    nextCursor = index + 1 < filtered.length ? `v1.${scope}.${key(view)}` : null;
    const row = compact(view, args.includeBodies ?? false);
    rows.push(row);
    if (bytes(envelope()) > CONTROL_LIST_MAX_BYTES) {
      if (rows.length > 1) {
        rows.pop();
        nextCursor = previousCursor;
        break;
      }
      // A large first body must not starve this item or every subsequent item.
      rows[0] = {
        ...compact(view, false),
        bodyOmitted: true,
        bodyBytes: Buffer.byteLength(view.signal.body),
        retrieval,
      };
      if (bytes(envelope()) > CONTROL_LIST_MAX_BYTES)
        throw new Error("Control list item exceeds response byte limit");
    }
    if (rows.length >= limit)
      break;
  }
  return envelope();
}
