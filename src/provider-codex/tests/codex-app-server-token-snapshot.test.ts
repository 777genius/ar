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
    const tracker = new AppServerTokenUsageTracker();
    tracker.registerThread("restored", false);
    const pending = new Map<string, string>();
    const state = createTurnState();
    const observe = (turnId: string, totalTokens: number) => tracker.observe({ threadId: "restored", turnId, tokenUsage: { total: { totalTokens }, last: { totalTokens: 30 } } }, pending, new Map(), new Map(), () => state);
    observe("previous", 200);
    pending.set("restored", "new");
    observe("new", 230);
    expect(state.usage).toEqual({ totalTokens: 30 });
  });

  it("sanitizes usage-carrying failures without inventing unknown counters", () => {
    const failure = new AppServerUsageError(new Error("failed"), { totalTokens: 125, inputTokens: -1, outputTokens: Number.NaN, cachedInputTokens: 80 });
    expect(usageFromError(new Error("outer", { cause: failure }))).toEqual({ totalTokens: 125, cachedInputTokens: 80 });
    expect(usageFromError(new Error("unknown"))).toBeUndefined();
  });
});
