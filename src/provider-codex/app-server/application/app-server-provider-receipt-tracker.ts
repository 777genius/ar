import type { AgentUsage } from "@vioxen/subscription-runtime/core";
import { readRecord } from "../domain/app-server-record";
import { stringField } from "../protocol/app-server-content-parser";
import type { AppServerTurnState } from "./app-server-turn-result";

type ReceiptState = {
  readonly threadId: string;
  turnId: string | null;
  started: boolean;
  terminalPending: boolean;
  usage: AgentUsage | undefined;
};

export type ProviderReceiptEvent = {
  readonly handled: boolean;
  readonly turnId?: string;
  readonly usage?: AgentUsage;
  readonly completed?: boolean;
  readonly error?: Error;
};

export function applyProviderReceiptNotification(
  tracker: AppServerProviderReceiptTracker,
  method: string,
  params: Record<string, unknown> | null,
  turns: Map<string, AppServerTurnState>,
  fail: (error: Error) => void,
  complete: (state: AppServerTurnState) => void,
): boolean {
  const event = tracker.handle(method, params);
  if (!event.handled) return false;
  if (event.error) fail(event.error);
  else if (event.turnId) {
    let state = turns.get(event.turnId);
    if (!state) {
      state = {
        outputText: "",
        usage: undefined,
        completed: false,
        error: null,
        waiters: [],
        reconnectGraceTimer: null,
      };
      turns.set(event.turnId, state);
    }
    if (event.usage) state.usage = event.usage;
    if (event.completed) {
      setTimeout(() => {
        state.completed = true;
        complete(state);
      }, 10);
    }
  }
  return true;
}

const _TOMBSTONE_LIMIT = 256;

export class AppServerProviderReceiptTracker {
  private readonly byThread = new Map<string, ReceiptState>();
  private readonly byTurn = new Map<string, ReceiptState>();
  private readonly completedTurnIds = new Set<string>();

  begin(threadId: string): void {
    if (this.byThread.has(threadId)) {
      throw new Error("codex_app_server_receipt_identity_duplicate");
    }
    const state = {
      threadId,
      turnId: null,
      started: false,
      terminalPending: false,
      usage: undefined,
    };
    this.byThread.set(threadId, state);
  }

  bind(threadId: string, turnId: string): void {
    const state = this.byThread.get(threadId);
    const owner = this.byTurn.get(turnId);
    if (
      !state ||
      (state.turnId !== null && state.turnId !== turnId) ||
      (owner !== undefined && owner !== state)
    ) {
      throw new Error("codex_app_server_receipt_response_identity_invalid");
    }
    state.turnId = turnId;
    this.byTurn.set(turnId, state);
  }

  cancel(threadId: string): void {
    const state = this.byThread.get(threadId);
    if (state?.turnId) this.byTurn.delete(state.turnId);
    this.byThread.delete(threadId);
  }

  handle(method: string, params: Record<string, unknown> | null): ProviderReceiptEvent {
    const postTerminal = this.rejectPostTerminal(method, params);
    if (postTerminal) return postTerminal;
    if (method === "turn/started") return this.onStarted(params);
    if (method === "thread/tokenUsage/updated") return this.onUsage(params);
    if (method === "turn/completed") return this.onCompleted(params);
    return { handled: false };
  }

  clearActive(turnId: string, threadId: string): void {
    this.byTurn.delete(turnId);
    this.byThread.delete(threadId);
  }

  clear(): void {
    this.byThread.clear();
    this.byTurn.clear();
    this.completedTurnIds.clear();
  }

  private onStarted(params: Record<string, unknown> | null): ProviderReceiptEvent {
    const threadId = stringField(params, "threadId");
    const turnId = stringField(readRecord(params?.turn), "id");
    const state = threadId ? this.byThread.get(threadId) : undefined;
    const owner = turnId ? this.byTurn.get(turnId) : undefined;
    if (
      !state ||
      !turnId ||
      state.terminalPending ||
      (state.turnId !== null && state.turnId !== turnId) ||
      (owner !== undefined && owner !== state) ||
      state.started
    ) {
      return this.failure("codex_app_server_receipt_started_identity_invalid");
    }
    state.turnId = turnId;
    this.byTurn.set(turnId, state);
    state.started = true;
    return { handled: true, turnId };
  }

  private onUsage(params: Record<string, unknown> | null): ProviderReceiptEvent {
    const threadId = stringField(params, "threadId");
    const turnId = stringField(params, "turnId");
    const state = threadId ? this.byThread.get(threadId) : undefined;
    if (
      !state || !turnId || state.terminalPending ||
      state.turnId !== turnId || !state.started
    ) {
      return this.failure("codex_app_server_receipt_usage_identity_invalid");
    }
    const tokenUsage = readRecord(params?.tokenUsage);
    const last = exactUsage(readRecord(tokenUsage?.last));
    const total = exactUsage(readRecord(tokenUsage?.total));
    if (
      !last || !total || !usageSubset(last, total) ||
      (state.usage !== undefined && !usageSubset(state.usage, total))
    ) {
      return this.failure("codex_app_server_receipt_usage_invalid");
    }
    state.usage = total;
    return { handled: true, turnId, usage: total };
  }

  private onCompleted(params: Record<string, unknown> | null): ProviderReceiptEvent {
    const turn = readRecord(params?.turn);
    const turnId = stringField(turn, "id");
    const status = readRecord(turn?.status);
    const statusType = stringField(turn, "status") ?? stringField(status, "type");
    if (!turnId || this.completedTurnIds.has(turnId)) {
      return this.failure("codex_app_server_receipt_completed_identity_invalid");
    }
    if (statusType !== "completed") {
      return this.failure("codex_app_server_receipt_terminal_status_invalid");
    }
    const state = this.byTurn.get(turnId);
    if (!state || state.terminalPending || !state.started || !state.usage) {
      return this.failure("codex_app_server_receipt_completed_before_evidence");
    }
    state.terminalPending = true;
    this.addTombstone(turnId);
    return { handled: true, turnId, usage: state.usage, completed: true };
  }

  private rejectPostTerminal(
    method: string,
    params: Record<string, unknown> | null,
  ): ProviderReceiptEvent | undefined {
    if (!_POST_TERMINAL_METHODS.has(method)) return undefined;
    const turnId = stringField(params, "turnId") ??
      stringField(readRecord(params?.turn), "id");
    if (!turnId || !this.completedTurnIds.has(turnId)) return undefined;
    return this.failure("codex_app_server_receipt_event_after_terminal");
  }

  private failure(message: string): ProviderReceiptEvent {
    return { handled: true, error: new Error(message) };
  }

  private addTombstone(turnId: string): void {
    this.completedTurnIds.add(turnId);
    while (this.completedTurnIds.size > _TOMBSTONE_LIMIT) {
      const oldest = this.completedTurnIds.values().next().value;
      if (typeof oldest !== "string") break;
      this.completedTurnIds.delete(oldest);
    }
  }
}

const _POST_TERMINAL_METHODS = new Set([
  "turn/started",
  "thread/tokenUsage/updated",
  "item/agentMessage/delta",
  "item/completed",
  "model/rerouted",
  "turn/completed",
  "turn/aborted",
  "turn_aborted",
  "error",
]);

function exactUsage(record: Record<string, unknown> | null): AgentUsage | undefined {
  if (!record) return undefined;
  const inputTokens = exactCount(record.inputTokens);
  const cachedInputTokens = exactCount(record.cachedInputTokens);
  const outputTokens = exactCount(record.outputTokens);
  const reasoningOutputTokens = exactCount(record.reasoningOutputTokens);
  const totalTokens = exactCount(record.totalTokens);
  if (
    inputTokens === undefined || cachedInputTokens === undefined ||
    outputTokens === undefined || reasoningOutputTokens === undefined ||
    totalTokens === undefined || totalTokens !== inputTokens + outputTokens ||
    cachedInputTokens > inputTokens || reasoningOutputTokens > outputTokens
  ) return undefined;
  return { inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, totalTokens };
}

function usageSubset(last: AgentUsage, total: AgentUsage): boolean {
  return last.inputTokens! <= total.inputTokens! &&
    last.cachedInputTokens! <= total.cachedInputTokens! &&
    last.outputTokens! <= total.outputTokens! &&
    last.reasoningOutputTokens! <= total.reasoningOutputTokens! &&
    last.totalTokens! <= total.totalTokens!;
}

function exactCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}
