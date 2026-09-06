import type { AgentUsage } from "@vioxen/subscription-runtime/core";
import { readRecord } from "../domain/app-server-record";
import { maximumAgentUsage, readUsageFromRecords, subtractAgentUsage } from "../domain/app-server-usage";
import type { TurnState } from "./app-server-turn-state";

/** A bounded read model of provider cumulative snapshots, including attach replay. */
export class AppServerTokenUsageTracker {
  private readonly totals = new Map<string, AgentUsage | undefined>();

  registerResponse(method: string, result: unknown): void {
    if (method !== "thread/start" && method !== "thread/fork") return;
    const threadId = readRecord(readRecord(result)?.thread)?.id;
    if (typeof threadId === "string") this.registerThread(threadId, method === "thread/start");
  }

  ensureThread(threadId: string): void {
    if (!this.totals.has(threadId)) this.registerThread(threadId, false);
  }

  registerThread(threadId: string, fresh: boolean): void {
    this.totals.set(threadId, fresh ? {} : undefined);
    if (this.totals.size > 128) this.totals.delete(this.totals.keys().next().value!);
  }

  observe(
    params: Record<string, unknown> | null,
    pending: ReadonlyMap<string, string>,
    early: ReadonlyMap<string, string>,
    aliases: ReadonlyMap<string, string>,
    ensureTurn: (id: string) => TurnState,
  ): void {
    const threadId = params?.threadId;
    const turnId = params?.turnId;
    if (typeof threadId !== "string" || typeof turnId !== "string") return;
    if (!this.totals.has(threadId)) return;
    const expected = pending.get(threadId) ?? early.get(threadId);
    if (expected && turnId !== expected && aliases.get(turnId) !== expected) return;
    const total = readUsageFromRecords(readRecord(params?.tokenUsage)?.total);
    if (!total) return;
    const previous = this.totals.get(threadId);
    this.totals.set(threadId, maximumAgentUsage(previous, total));
    // A notification for an idle thread restores history, never bills a turn.
    if (!expected) return;
    const state = ensureTurn(turnId);
    if (state.completed || state.error) return;
    if (!state.usageBaseline) {
      state.usageBaseline = previous ?? total;
      // Unknown history cannot distinguish a request from quota/attach replay.
      if (!previous) return;
    }
    updateTurnUsage(state, total);
  }
}

export function updateTurnUsage(state: TurnState, total: AgentUsage): void {
  if (state.completed || state.error) return;
  if (!state.usageBaseline) {
    state.usageBaseline = total;
    return;
  }
  const next = subtractAgentUsage(total, state.usageBaseline);
  if (!state.usage && !Object.values(next ?? {}).some((value) => value > 0)) return;
  state.usage = maximumAgentUsage(state.usage, next);
}
