import { describe, expect, it } from "vitest";
import { createTurnState } from "../app-server/application/app-server-turn-state";
import { AppServerTokenUsageTracker, updateTurnUsage } from "../app-server/application/app-server-turn-usage";
import { AppServerUsageError, usageFromError } from "../app-server/domain/app-server-usage-error";

describe("Codex token snapshots", () => {
  it("excludes restored history and retains only known requests for a resumed turn", () => {
    const state = createTurnState();
    updateTurnUsage(state, { totalTokens: 230 });
    expect(state.usage).toBeUndefined();
    updateTurnUsage(state, { totalTokens: 230 });
    expect(state.usage).toBeUndefined();
    updateTurnUsage(state, { totalTokens: 250 });
    expect(state.usage).toEqual({ totalTokens: 20 });
  });

  it("keeps optional-only known counters and rejects malformed counts", () => {
    const state = createTurnState();
    state.usageBaseline = { cachedInputTokens: 60 };
    updateTurnUsage(state, { cachedInputTokens: 80 });
    expect(state.usage).toEqual({ cachedInputTokens: 20 });
    updateTurnUsage(state, { cachedInputTokens: 70 });
    expect(state.usage).toEqual({ cachedInputTokens: 20 });
  });

  it("uses restored idle-thread snapshots as the next turn baseline", () => {
    const warnings: { code: string }[] = [];
    const tracker = new AppServerTokenUsageTracker((warning) => warnings.push(warning));
    tracker.registerThread("restored", false);
    const pending = new Map<string, string>();
    const state = createTurnState();
    const observe = (turnId: string, totalTokens: number) => tracker.observe({ threadId: "restored", turnId, tokenUsage: { total: { totalTokens }, last: { totalTokens: 30 } } }, pending, new Map(), new Map(), () => state);
    observe("previous", 200);
    pending.set("restored", "new");
    observe("new", 230);
    expect(state.usage).toEqual({ totalTokens: 30 });
    // The provider reported exact usage, so nothing here was an estimate.
    expect(warnings).toEqual([]);
  });

  it("announces the estimate on a thread whose history it never observed", () => {
    // An attached, forked or evicted thread: the counter's origin is unknown, so
    // the first update can only be a baseline and the SECOND one bills. The
    // announcement has to survive that split, or the whole class of long-session
    // threads is billed from a derived number with nothing said about it.
    const warnings: { code: string }[] = [];
    const tracker = new AppServerTokenUsageTracker((warning) => warnings.push(warning));
    tracker.registerThread("restored", false);
    const state = createTurnState();
    const pending = new Map([["restored", "turn"]]);
    const observe = (total: Record<string, number>, last?: Record<string, number>) => tracker.observe(
      { threadId: "restored", turnId: "turn", tokenUsage: { total, ...(last ? { last } : {}) } },
      pending, new Map(), new Map(), () => state,
    );
    observe({ inputTokens: 900, outputTokens: 300, totalTokens: 1200 });
    // The turn is billed against a baseline that was never derived from a
    // payload, so the announcement has to be made on the update that ESTABLISHES
    // that baseline — by the time one bills, it may carry exact usage and look
    // like nothing was estimated at all.
    observe(
      { inputTokens: 1400, outputTokens: 600, totalTokens: 2000 },
      { inputTokens: 500, outputTokens: 300, totalTokens: 800 },
    );
    expect(state.usage).toEqual({ inputTokens: 500, outputTokens: 300, totalTokens: 800 });
    expect(warnings.map((warning) => warning.code)).toEqual(["codex_app_server_turn_usage_estimated"]);
  });

  it("keeps a thread's counter from a frame it cannot attribute to the pending turn", () => {
    const tracker = new AppServerTokenUsageTracker(() => {});
    tracker.registerThread("thread", true);
    const pending = new Map([["thread", "turn-1"]]);
    const first = createTurnState();
    // An attach replay carries the whole counter under a historical turn id —
    // or under `""`, which `restored_token_usage_turn_id` falls back to. It
    // cannot bill turn-1, but the counter it carries belongs to the THREAD.
    tracker.observe(
      { threadId: "thread", turnId: "", tokenUsage: { total: { inputTokens: 4000, outputTokens: 1000, totalTokens: 5000 } } },
      pending, new Map(), new Map(), () => first,
    );
    expect(first.usage).toBeUndefined();
    // Dropping that frame outright would leave turn-2's baseline empty and bill
    // it the replayed turn's 5000 tokens on top of its own 500.
    pending.set("thread", "turn-2");
    const second = createTurnState();
    tracker.observe(
      { threadId: "thread", turnId: "turn-2", tokenUsage: { total: { inputTokens: 4400, outputTokens: 1100, totalTokens: 5500 } } },
      pending, new Map(), new Map(), () => second,
    );
    expect(second.usage).toEqual({ inputTokens: 400, outputTokens: 100, totalTokens: 500 });
  });

  it("carries the rewrite detector's high-water through an alias merge", () => {
    const tracker = new AppServerTokenUsageTracker(() => {});
    const expected = createTurnState();
    expected.usageTotalSeen = { inputTokens: 10, totalTokens: 900 };
    const actual = createTurnState();
    actual.usageTotalSeen = { inputTokens: 400, totalTokens: 500 };
    tracker.adoptAliasedTurn(expected, actual);
    // Both ids name one turn. Dropping either side's high-water would leave the
    // merged turn's counter-rewrite detector disarmed on that counter.
    expect(expected.usageTotalSeen).toEqual({ inputTokens: 400, totalTokens: 900 });
  });

  it("refuses to bill a poisoned turn even when called directly", () => {
    // The exported entry point carries the contract itself; it does not rely on
    // its one current caller having filtered poisoned turns out already.
    const state = createTurnState();
    state.usageBaseline = { totalTokens: 100 };
    state.usagePoisoned = true;
    updateTurnUsage(state, { totalTokens: 200 });
    expect(state.usage).toBeUndefined();
  });

  it("withdraws an aliased turn's usage from the live record when the merge is poisoned", () => {
    const tracker = new AppServerTokenUsageTracker(() => {});
    const active = tracker.activate("thread");
    const expected = createTurnState();
    tracker.observe(
      { threadId: "thread", turnId: "expected", tokenUsage: { total: { totalTokens: 90 }, last: { totalTokens: 40 } } },
      new Map([["thread", "expected"]]), new Map(), new Map(), () => expected,
    );
    expect(active.usage).toEqual({ totalTokens: 40 });
    const actual = createTurnState();
    actual.usagePoisoned = true;
    tracker.adoptAliasedTurn(expected, actual);
    // Both ids name one turn, so the poison binds it — and the number already
    // published to the caller has to be taken back, not left behind.
    expect(expected.usage).toBeUndefined();
    expect(active.usage).toBeUndefined();
  });

  it("sanitizes usage-carrying failures without inventing unknown counters", () => {
    const failure = new AppServerUsageError(new Error("failed"), { totalTokens: 125, inputTokens: -1, outputTokens: Number.NaN, cachedInputTokens: 80 });
    expect(usageFromError(new Error("outer", { cause: failure }))).toEqual({ totalTokens: 125, cachedInputTokens: 80 });
    expect(usageFromError(new Error("unknown"))).toBeUndefined();
  });
});
