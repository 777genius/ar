import type { AppServerExecutionLease } from "./app-server-admission";
import type { AgentUsage } from "@vioxen/subscription-runtime/core";
import type { AppServerWarning } from "../domain/app-server-types";
import { readRecord } from "../domain/app-server-record";
import {
  maximumAgentUsage,
  readExactTurnUsage,
  readUsageFromRecords,
  subtractAgentUsage,
} from "../domain/app-server-usage";
import type { TurnState } from "./app-server-turn-state";

/**
 * The live usage record a caller holds for an in-flight turn.
 *
 * `usage` is explicitly resettable to `undefined`: a poisoned turn must be able
 * to withdraw a number it had already published to the caller.
 */
export type ActiveTurnUsage = { usage?: AgentUsage | undefined };

/** Emitted when a turn is billed from the cumulative estimate, not exact usage. */
export const estimatedTurnUsageWarningCode = "codex_app_server_turn_usage_estimated";
/** Emitted when a malformed exact snapshot bars a turn from reporting usage. */
export const untrustedTurnUsageWarningCode = "codex_app_server_turn_usage_untrusted";
/** Emitted when an update carries no readable cumulative counter to bill against. */
export const incompleteTurnUsageWarningCode = "codex_app_server_turn_usage_incomplete";
/** Emitted when the provider rewrote its cumulative counter rather than growing it. */
export const rewrittenCounterWarningCode = "codex_app_server_turn_usage_counter_rewritten";
/** Emitted when an update reports context occupancy instead of a response's cost. */
export const occupancyTurnUsageWarningCode = "codex_app_server_turn_usage_occupancy";

/**
 * Classifies how a cumulative snapshot moved against what this turn has already
 * been shown.
 *
 * A counter that only grows can only move forwards. Backwards on EVERY counter
 * it names is a redelivered older snapshot — ordinary, and silent. Backwards on
 * one and forwards on another cannot be an increment at all: the provider
 * replaced the counter, and its delta is no longer commensurable with a baseline
 * anchored before the replacement.
 *
 * The comparison is against what THIS TURN has been shown, never the thread's
 * high-water mark: a frame belonging to another turn must not be able to freeze
 * billing for every turn that follows it.
 */
function counterMovement(
  seen: AgentUsage | undefined,
  total: AgentUsage,
): "forward" | "stale" | "rewritten" {
  if (!seen) return "forward";
  let behind = false;
  let ahead = false;
  for (const [key, value] of Object.entries(seen)) {
    const current = total[key as keyof AgentUsage];
    if (current === undefined) continue;
    if (current < value) behind = true;
    if (current > value) ahead = true;
  }
  if (!behind) return "forward";
  return ahead ? "rewritten" : "stale";
}

/**
 * A bounded read model of provider cumulative snapshots, including attach replay.
 *
 * `thread/tokenUsage/updated` carries two numbers whose relationship is fixed by
 * the app-server protocol: `tokenUsage.total` is the thread's cumulative counter
 * and `tokenUsage.last` is the exact usage of the model response that produced
 * this update, with `total += last` applied before the notification is sent. A
 * turn spans as many updates as it makes model responses, so a turn's cost is
 * the sum of its `last` values — equivalently, the growth of `total` across the
 * turn. Both fields are required by the protocol schema.
 *
 * The turn's baseline is therefore taken from the payload itself (`total - last`)
 * rather than from whatever history this process happened to observe. That is
 * what makes the number exact for a freshly started thread, a forked thread, an
 * attach replay and a thread evicted from this read model alike.
 */
export class AppServerTokenUsageTracker {
  private readonly pins = new Map<string, number>();
  private readonly active = new Map<string, ActiveTurnUsage>();
  private readonly totals = new Map<string, AgentUsage | undefined>();

  constructor(private readonly warn: (warning: AppServerWarning) => void) {}

  registerResponse(method: string, result: unknown, lease?: AppServerExecutionLease): void {
    if (method !== "thread/start" && method !== "thread/fork") return;
    const threadId = readRecord(readRecord(result)?.thread)?.id;
    if (typeof threadId === "string") {
      lease?.retain(threadId);
      this.registerThread(threadId, method === "thread/start");
    }
  }

  ensureThread(threadId: string): void {
    if (!this.totals.has(threadId)) this.registerThread(threadId, false);
  }

  registerThread(threadId: string, fresh: boolean): void {
    this.totals.set(threadId, fresh ? {} : undefined);
    this.pruneIdle();
  }

  activate(threadId: string): ActiveTurnUsage {
    const usage = {};
    this.active.set(threadId, usage);
    this.ensureThread(threadId);
    return usage;
  }

  deactivate(threadId: string): void {
    this.active.delete(threadId);
    this.pruneIdle();
  }

  pin(threadId: string): () => void {
    this.pins.set(threadId, (this.pins.get(threadId) ?? 0) + 1);
    return () => {
      const count = this.pins.get(threadId) ?? 0;
      if (count <= 1) this.pins.delete(threadId);
      else this.pins.set(threadId, count - 1);
      this.pruneIdle();
    };
  }

  private pruneIdle(): void {
    let idle = [...this.totals.keys()].filter((id) => !this.active.has(id) && !this.pins.has(id)).length;
    for (const threadId of this.totals.keys()) {
      if (idle <= 128) break;
      if (!this.active.has(threadId) && !this.pins.has(threadId)) {
        this.totals.delete(threadId);
        idle -= 1;
      }
    }
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
    const tokenUsage = readRecord(params?.tokenUsage);
    const total = readUsageFromRecords(tokenUsage?.total);
    const previous = this.totals.get(threadId);
    // The cumulative counter belongs to the THREAD, not to the turn that
    // happened to report it. Attach replay re-sends the whole counter under a
    // historical turn id — or under `""` when the rebuilt thread has none — so
    // dropping those frames with the turn-id guard below would lose history and
    // leave the NEXT turn's baseline stale-low, billing it someone else's turn.
    if (total) this.totals.set(threadId, maximumAgentUsage(previous, total));
    const expected = pending.get(threadId) ?? early.get(threadId);
    // A notification for an idle thread restores history, never bills a turn.
    if (!expected) return;
    if (turnId !== expected && aliases.get(turnId) !== expected) return;
    const exact = readExactTurnUsage(tokenUsage?.last);
    const state = ensureTurn(turnId);
    state.usageThreadId = threadId;
    if (state.completed || state.error || state.usagePoisoned) return;
    if (exact.kind === "invalid") {
      this.poisonTurn(threadId, state);
      return;
    }
    if (exact.kind === "occupancy") {
      // A context-occupancy report, not a cost. It bills nothing, and it must
      // not anchor a baseline either: its `total` is the provider's own
      // pre-rewrite counter and pairing the two would charge the difference.
      //
      // It can also BE the counter replacement: `fill_to_context_window`
      // rewrites `total` alongside `last`. Record that before returning, or a
      // turn that continues past it keeps billing against an origin the
      // provider has already discarded.
      if (total && counterMovement(state.usageTotalSeen, total) === "rewritten") {
        state.usageCounterRewritten = true;
      }
      this.warnDegraded(state, occupancyTurnUsageWarningCode,
        "Codex app-server reported context occupancy rather than a model response's cost; this update bills nothing.");
      return;
    }
    this.billTurn(threadId, state, exact.kind === "exact" ? exact.usage : undefined, total, previous);
  }

  /**
   * Folds an aliased turn's usage into the turn it turned out to be, and
   * re-publishes the merged number to the caller's live record.
   *
   * Without the re-publish, `active.usage` would keep the pre-merge value for
   * the window in which a failing turn reads it back as its measured usage.
   */
  adoptAliasedTurn(expected: TurnState, actual: TurnState): void {
    adoptAliasedTurnUsage(expected, actual);
    const threadId = expected.usageThreadId;
    if (!threadId) return;
    const active = this.active.get(threadId);
    if (active) active.usage = expected.usage;
  }

  /**
   * Bills one `thread/tokenUsage/updated` against the turn it belongs to.
   *
   * The turn's usage is always `total - baseline`, monotonically maximised, so a
   * duplicated or replayed notification cannot double-bill and a later partial
   * snapshot cannot erase a counter already known. Only the baseline's origin
   * varies, and it is established exactly once per turn.
   */
  private billTurn(
    threadId: string,
    state: TurnState,
    exact: AgentUsage | undefined,
    total: AgentUsage | undefined,
    previous: AgentUsage | undefined,
  ): void {
    if (total) {
      const movement = counterMovement(state.usageTotalSeen, total);
      // A snapshot strictly behind what this turn has already seen is a
      // redelivery, not a provider fault. It adds nothing and is not worth an
      // operator's attention; the maximum below would ignore it anyway.
      if (movement === "stale") return;
      // Backwards on one counter and forwards on another cannot be an
      // increment: the provider REPLACED its counter. The turn's baseline was
      // anchored to the old origin, so `total - baseline` is meaningless from
      // here on — and it stays meaningless, hence the latch.
      if (movement === "rewritten") state.usageCounterRewritten = true;
    }
    if (state.usageCounterRewritten) {
      // The provider's own per-response numbers are still good; only the
      // cumulative delta is dead. Keep them as a floor rather than dropping the
      // rest of the turn entirely.
      if (exact) this.publish(threadId, state, maximumAgentUsage(state.usage, exact));
      this.warnDegraded(state, rewrittenCounterWarningCode,
        "Codex app-server rewrote the thread's cumulative token counter mid-turn; the remainder of this turn is not billed from it.");
      return;
    }
    if (total) state.usageTotalSeen = maximumAgentUsage(state.usageTotalSeen, total);
    if (!total) {
      // The protocol requires `total` alongside `last`, so a missing or
      // unreadable one is a degraded payload. The exact snapshot still stands,
      // but only as a floor — summing it would double-bill a replayed
      // notification, so a turn's later responses may go unbilled.
      if (exact) this.publish(threadId, state, maximumAgentUsage(state.usage, exact));
      this.warnDegraded(state, incompleteTurnUsageWarningCode,
        "Codex app-server reported no readable cumulative token counter for this update; this turn's usage may be under-reported.");
      return;
    }
    if (!state.usageBaseline) {
      if (exact) {
        // `total` already includes this update, so `total - last` is the thread's
        // counter as it stood before the turn. The payload proves it; no observed
        // history is required, and none is trusted over it.
        state.usageBaseline = subtractAgentUsage(total, exact);
      } else {
        state.usageBaseline = previous ?? total;
        // Billing a turn from a cumulative delta is an estimate, not the
        // provider's own per-turn number. Never let that pass unannounced —
        // including on the branch below, which bills a LATER update against the
        // baseline established here and would otherwise carry no such signal.
        this.warnDegraded(state, estimatedTurnUsageWarningCode,
          "Codex app-server reported no exact per-turn token usage; this turn is billed from the thread's cumulative counter.");
        // Unknown history cannot distinguish a request from quota/attach replay.
        if (!previous) return;
      }
    } else if (!exact) {
      // The baseline is anchored, so `total - baseline` stays the turn's real
      // cost and this update is NOT discarded — dropping it would silently
      // unbill every remaining response of the turn. It is still not the
      // provider's own per-turn number, so it is announced as an estimate.
      this.warnDegraded(state, estimatedTurnUsageWarningCode,
        "Codex app-server stopped reporting exact per-turn token usage mid-turn; the remainder of this turn is billed from the thread's cumulative counter.");
    }
    updateTurnUsage(state, total);
    // A counter the exact snapshot reports but the cumulative one omits would
    // otherwise be dropped. The accumulated delta already covers every counter
    // both carry, so this only ever fills gaps — it never re-adds a response.
    this.publish(threadId, state, exact ? maximumAgentUsage(state.usage, exact) : state.usage);
  }

  /**
   * Announces a degraded billing path once per turn PER CODE.
   *
   * Deduplicating across codes would let the first degradation silence every
   * later one, so an operator could be told a turn was "estimated" and never
   * learn its counter was then rewritten.
   */
  private warnDegraded(state: TurnState, code: string, safeMessage: string): void {
    if (state.usageWarned.has(code)) return;
    state.usageWarned.add(code);
    this.warn({ code, safeMessage });
  }

  /**
   * Fails a turn's usage closed after the provider contradicted itself.
   *
   * Once a malformed snapshot has been seen we cannot prove a later well-formed
   * one is the real cost, so no number is reported at all — and the operator is
   * told, because a silently unbilled turn is indistinguishable from a free one.
   */
  private poisonTurn(threadId: string, state: TurnState): void {
    state.usagePoisoned = true;
    this.publish(threadId, state, undefined);
    this.warn({
      code: untrustedTurnUsageWarningCode,
      safeMessage:
        "Codex app-server reported a malformed exact token-usage snapshot; this turn reports no usage.",
    });
  }

  private publish(threadId: string, state: TurnState, usage: AgentUsage | undefined): void {
    state.usage = usage;
    const active = this.active.get(threadId);
    if (active) active.usage = usage;
  }
}

/**
 * Folds an aliased turn's usage into the turn it turned out to be.
 *
 * Poison survives the merge: the two ids name the same turn, so a malformed
 * snapshot seen under either one bars the merged turn from ever billing.
 */
export function adoptAliasedTurnUsage(expected: TurnState, actual: TurnState): void {
  expected.usagePoisoned = expected.usagePoisoned || actual.usagePoisoned;
  for (const code of actual.usageWarned) expected.usageWarned.add(code);
  expected.usageCounterRewritten = expected.usageCounterRewritten || actual.usageCounterRewritten;
  expected.usageTotalSeen = maximumAgentUsage(expected.usageTotalSeen, actual.usageTotalSeen);
  // Two ids, one turn: take the higher of the two rather than letting whichever
  // side is merged in last decide, so the merge cannot lower a billed counter.
  expected.usage = expected.usagePoisoned
    ? undefined
    : maximumAgentUsage(expected.usage, actual.usage);
  expected.usageBaseline = actual.usageBaseline ?? expected.usageBaseline;
  expected.usageThreadId = expected.usageThreadId ?? actual.usageThreadId;
}

export function updateTurnUsage(state: TurnState, total: AgentUsage): void {
  if (state.completed || state.error || state.usagePoisoned) return;
  if (!state.usageBaseline) {
    state.usageBaseline = total;
    return;
  }
  const next = subtractAgentUsage(total, state.usageBaseline);
  if (!state.usage && !Object.values(next ?? {}).some((value) => value > 0)) return;
  state.usage = maximumAgentUsage(state.usage, next);
}
