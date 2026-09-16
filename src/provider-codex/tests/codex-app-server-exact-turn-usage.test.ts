import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DefaultRedactor } from "@vioxen/subscription-runtime/core";
import { CodexAppServerExecutionEngine } from "../codex-app-server-execution-engine";
import type { CodexAppServerClient } from "../app-server/application/app-server-client";
import { readExactTurnUsage } from "../app-server/domain/app-server-usage";
import { FakeAppServerFactory, type FakeAppServerRequest } from "../app-server/testing/fake-app-server";
import { StaticRunner } from "./codex-provider-test-support";

/**
 * The exact-turn-usage contract, replayed against the real client.
 *
 * `thread/tokenUsage/updated` carries two numbers whose relationship the
 * app-server protocol fixes: `tokenUsage.total` is the thread's cumulative
 * counter and `tokenUsage.last` is the exact usage of the model response that
 * produced this update, with `total += last` applied before it is sent. A turn
 * spans one update per model response, so the turn's cost is the growth of
 * `total` across the turn — anchored by `total - last` on its first update, so
 * that whatever the counter already carried never lands on this turn.
 */
const usage = (inputTokens: number, outputTokens: number, totalTokens = inputTokens + outputTokens) => ({
  inputTokens, outputTokens, totalTokens,
});

/** A protocol-faithful cumulative counter: `total += last` before each update. */
function counter(startingTotal = usage(0, 0)) {
  let total = startingTotal;
  return {
    get total() { return total; },
    respond(last: ReturnType<typeof usage>) {
      total = usage(total.inputTokens + last.inputTokens, total.outputTokens + last.outputTokens);
      return { last, total };
    },
  };
}

describe("Codex exact turn usage", () => {
  it("bills every model response of one turn, once, and nothing else", async () => {
    const test = await setup();
    try {
      const turn = await test.startTurn();
      const thread = counter();
      // Three model responses in one turn: a turn is not one update.
      test.tokenUsage(turn.threadId, turn.turnId, thread.respond(usage(50, 20)));
      test.tokenUsage(turn.threadId, turn.turnId, thread.respond(usage(12, 5)));
      const replayed = thread.respond(usage(7, 3));
      test.tokenUsage(turn.threadId, turn.turnId, replayed);
      // A redelivered notification must not bill its response twice.
      test.tokenUsage(turn.threadId, turn.turnId, replayed);
      // Neither another thread's turn, nor another turn of this thread.
      test.tokenUsage("foreign-thread", turn.turnId, counter().respond(usage(999, 999)));
      test.tokenUsage(turn.threadId, "stale-turn", counter().respond(usage(888, 888)));
      test.emit({ method: "codex/rawResponse", params: {
        threadId: turn.threadId, turnId: turn.turnId,
        tokenUsage: { last: usage(777, 777), total: usage(777, 777) },
      } });
      const result = await turn.complete();
      expect(result.usage).toEqual(usage(69, 28));
      expect(test.warningCodes()).toEqual([]);
    } finally { await test.close(); }
  });

  it("bills only this turn's responses when the thread counter already carried history", async () => {
    const test = await setup();
    try {
      const turn = await test.startTurn();
      // The provider's counter opens far above zero — a primed thread, an
      // attach replay, or history this process never observed. The turn made a
      // single 17-token response, and 17 is the only number it may be billed.
      const thread = counter(usage(900, 300));
      test.tokenUsage(turn.threadId, turn.turnId, thread.respond(usage(12, 5)));
      const result = await turn.complete();
      expect(result.usage).toEqual(usage(12, 5));
    } finally { await test.close(); }
  });

  it("bills the rest of a turn from its anchored baseline, announced, when exact usage stops", async () => {
    const test = await setup();
    try {
      const turn = await test.startTurn();
      const thread = counter(usage(100, 50));
      test.tokenUsage(turn.threadId, turn.turnId, thread.respond(usage(50, 20)));
      // The provider stops reporting `last` mid-turn. The baseline is already
      // anchored to `total - last`, so the counter's growth across the turn is
      // still this turn's own cost and nobody else's — discarding these updates
      // would silently unbill every remaining response. It is no longer the
      // provider's own per-turn number, so it is announced as an estimate.
      test.emit({ method: "thread/tokenUsage/updated", params: {
        threadId: turn.threadId, turnId: turn.turnId,
        tokenUsage: { total: usage(500, 200), modelContextWindow: 200_000 },
      } });
      const result = await turn.complete();
      expect(result.usage).toEqual(usage(400, 150));
      expect(test.warningCodes()).toEqual(["codex_app_server_turn_usage_estimated"]);
    } finally { await test.close(); }
  });

  it("bills nothing for a context-window-exhausted turn, and says so", async () => {
    const test = await setup();
    try {
      const turn = await test.startTurn();
      test.tokenUsage(turn.threadId, turn.turnId, {
        last: usage(12_000, 300), total: usage(12_000, 300),
      });
      // `TokenUsageInfo::fill_to_context_window` reports the context window
      // against zeroed itemised counters when a turn exhausts it. That is
      // occupancy, not a response's cost: billing it would charge 187700 tokens
      // for work nobody did.
      test.tokenUsage(turn.threadId, turn.turnId, {
        last: { inputTokens: 0, outputTokens: 0, totalTokens: 187_700 },
        total: { inputTokens: 0, outputTokens: 0, totalTokens: 200_000 },
      });
      const result = await turn.complete();
      expect(result.usage).toEqual(usage(12_000, 300));
      expect(result.usagePoisoned).toBe(false);
      expect(test.warningCodes()).toEqual(["codex_app_server_turn_usage_occupancy"]);
    } finally { await test.close(); }
  });

  it("bills nothing for the occupancy estimate a mid-turn compaction reports", async () => {
    const test = await setup();
    try {
      const turn = await test.startTurn();
      // `Session::recompute_token_usage` fires after a SUCCESSFUL auto-compaction
      // and the turn then continues. Its `last` is an estimate of the whole
      // conversation history and `total` is left untouched, so pairing the two
      // would bill the entire history to this one turn.
      test.tokenUsage(turn.threadId, turn.turnId, {
        last: usage(2_500, 500), total: usage(400_000, 100_000),
      });
      test.tokenUsage(turn.threadId, turn.turnId, {
        last: { inputTokens: 0, outputTokens: 0, totalTokens: 80_000 },
        total: usage(400_000, 100_000),
      });
      test.tokenUsage(turn.threadId, turn.turnId, {
        last: usage(1_000, 200), total: usage(401_000, 100_200),
      });
      const result = await turn.complete();
      expect(result.usage).toEqual(usage(3_500, 700));
      expect(test.warningCodes()).toEqual(["codex_app_server_turn_usage_occupancy"]);
    } finally { await test.close(); }
  });

  it("never anchors a turn's baseline on an occupancy estimate", async () => {
    const test = await setup();
    try {
      const turn = await test.startTurn();
      // The compaction estimate arrives FIRST. If it anchored the baseline, the
      // next real response would be billed the whole history behind it.
      test.tokenUsage(turn.threadId, turn.turnId, {
        last: { inputTokens: 0, outputTokens: 0, totalTokens: 80_000 },
        total: usage(400_000, 100_000),
      });
      test.tokenUsage(turn.threadId, turn.turnId, {
        last: usage(1_000, 200), total: usage(401_000, 100_200),
      });
      const result = await turn.complete();
      expect(result.usage).toEqual(usage(1_000, 200));
    } finally { await test.close(); }
  });

  it("keeps billing the provider's own numbers after it rewrites its counter", async () => {
    const test = await setup();
    try {
      const turn = await test.startTurn();
      test.tokenUsage(turn.threadId, turn.turnId, {
        last: usage(500, 50), total: usage(1_500, 150),
      });
      // Backwards on the itemised counters and forwards on the total: replaced,
      // not incremented. The delta dies here — permanently, so a later frame
      // climbing back above the old high-water cannot resurrect it — but the
      // provider's own per-response numbers are still good.
      test.tokenUsage(turn.threadId, turn.turnId, {
        last: usage(600, 40), total: { inputTokens: 100, outputTokens: 20, totalTokens: 200_000 },
      });
      test.tokenUsage(turn.threadId, turn.turnId, {
        last: usage(700, 60), total: usage(30_000, 200, 230_200),
      });
      const result = await turn.complete();
      expect(result.usage).toEqual(usage(700, 60));
      expect(test.warningCodes()).toEqual(["codex_app_server_turn_usage_counter_rewritten"]);
    } finally { await test.close(); }
  });

  it("announces every distinct degradation a turn hits, not just the first", async () => {
    const test = await setup();
    try {
      const turn = await test.startTurn();
      const cumulativeOnly = (total: Record<string, number>) => test.emit({
        method: "thread/tokenUsage/updated",
        params: { threadId: turn.threadId, turnId: turn.turnId, tokenUsage: { total } },
      });
      cumulativeOnly(usage(30, 10));
      // A second, different degradation. Deduplicating warnings per TURN rather
      // than per CODE would leave the operator told only that this turn was
      // estimated, never that its counter was then rewritten under it.
      cumulativeOnly({ inputTokens: 5, outputTokens: 2, totalTokens: 200_000 });
      const result = await turn.complete();
      expect(result.usage).toEqual(usage(30, 10));
      expect(test.warningCodes().sort()).toEqual([
        "codex_app_server_turn_usage_counter_rewritten",
        "codex_app_server_turn_usage_estimated",
      ]);
    } finally { await test.close(); }
  });

  it("stops billing from a counter the occupancy report itself replaced", async () => {
    const test = await setup();
    try {
      const turn = await test.startTurn();
      test.tokenUsage(turn.threadId, turn.turnId, {
        last: usage(500, 50), total: usage(1_200, 250, 1_450),
      });
      // `fill_to_context_window` rewrites `total` as well as `last`. If the turn
      // continues past it, the pre-rewrite baseline is dead — and because the
      // itemised counters restart from zero, a later frame climbs back above the
      // old high-water and looks like ordinary forward movement.
      test.tokenUsage(turn.threadId, turn.turnId, {
        last: { inputTokens: 0, outputTokens: 0, totalTokens: 198_550 },
        total: { inputTokens: 0, outputTokens: 0, totalTokens: 200_000 },
      });
      test.tokenUsage(turn.threadId, turn.turnId, {
        last: usage(1_500, 300), total: usage(1_500, 300, 201_800),
      });
      const result = await turn.complete();
      // The provider's own numbers, not 200900.
      expect(result.usage).toEqual(usage(1_500, 300));
    } finally { await test.close(); }
  });

  it("stays silent about an ordinary redelivered snapshot", async () => {
    const test = await setup();
    try {
      const turn = await test.startTurn();
      const thread = counter();
      const first = thread.respond(usage(50, 20));
      const second = thread.respond(usage(12, 5));
      test.tokenUsage(turn.threadId, turn.turnId, first);
      test.tokenUsage(turn.threadId, turn.turnId, second);
      // Out of order, every counter behind: a redelivery, not a provider fault.
      test.tokenUsage(turn.threadId, turn.turnId, first);
      const result = await turn.complete();
      expect(result.usage).toEqual(usage(62, 25));
      expect(test.warningCodes()).toEqual([]);
    } finally { await test.close(); }
  });


  it("announces an update whose cumulative counter it cannot read", async () => {
    const test = await setup();
    try {
      const turn = await test.startTurn();
      // Without a readable counter the exact snapshots can only be held as a
      // floor — summing them would double-bill a replay — so a turn's later
      // responses may go unbilled. Degraded, therefore announced.
      test.tokenUsage(turn.threadId, turn.turnId, { last: usage(100, 50), total: [1, 2, 3] });
      test.tokenUsage(turn.threadId, turn.turnId, { last: usage(200, 100), total: [1, 2, 3] });
      const result = await turn.complete();
      expect(result.usage).toEqual(usage(200, 100));
      expect(test.warningCodes()).toEqual(["codex_app_server_turn_usage_incomplete"]);
    } finally { await test.close(); }
  });

  it("never lets a later partial snapshot erase a counter already billed", async () => {
    const test = await setup();
    try {
      const turn = await test.startTurn();
      test.tokenUsage(turn.threadId, turn.turnId, {
        last: usage(100, 50), total: usage(100, 50),
      });
      test.tokenUsage(turn.threadId, turn.turnId, {
        last: { cachedInputTokens: 5 },
        total: { ...usage(100, 50), cachedInputTokens: 5 },
      });
      const result = await turn.complete();
      expect(result.usage).toEqual({ ...usage(100, 50), cachedInputTokens: 5 });
    } finally { await test.close(); }
  });

  it("keeps a counter the exact snapshot reports and the cumulative one omits", async () => {
    const test = await setup();
    try {
      const turn = await test.startTurn();
      test.tokenUsage(turn.threadId, turn.turnId, {
        last: { ...usage(10, 5), cachedInputTokens: 7 },
        total: usage(10, 5),
      });
      const result = await turn.complete();
      expect(result.usage).toEqual({ ...usage(10, 5), cachedInputTokens: 7 });
    } finally { await test.close(); }
  });

  it.each([
    { name: "a total below the parts it contains", last: usage(100, 100, 5) },
    { name: "a one-sided total below the part it contains", last: { inputTokens: 100, totalTokens: 5 } },
    { name: "a negative counter", last: usage(-1, 2, 1) },
    { name: "an array instead of a snapshot", last: [1, 2, 3] },
    { name: "two spellings of one counter disagreeing", last: { inputTokens: 50, input_tokens: 9_999 } },
  ])("poisons a turn for a malformed exact snapshot: $name", async ({ last }) => {
    const test = await setup();
    try {
      const turn = await test.startTurn();
      test.tokenUsage(turn.threadId, turn.turnId, { last, total: usage(4, 2) });
      // A later well-formed snapshot must not revive it, and there is no
      // fallback to the cumulative counter.
      test.tokenUsage(turn.threadId, turn.turnId, { last: usage(7, 3), total: usage(11, 5) });
      const result = await turn.complete();
      expect(result.usage).toBeUndefined();
      expect(result.usagePoisoned).toBe(true);
      // PARAMOUNT: a turn silently dropped from billing is a silent failure.
      expect(test.warningCodes()).toContain("codex_app_server_turn_usage_untrusted");
    } finally { await test.close(); }
  });

  it("withdraws a number it had already published when a later snapshot poisons the turn", async () => {
    const test = await setup();
    try {
      const turn = await test.startTurn();
      test.tokenUsage(turn.threadId, turn.turnId, { last: usage(4, 2), total: usage(4, 2) });
      test.tokenUsage(turn.threadId, turn.turnId, { last: usage(-1, 2, 1), total: usage(4, 2) });
      const result = await turn.complete();
      expect(result.usage).toBeUndefined();
      expect(result.usagePoisoned).toBe(true);
    } finally { await test.close(); }
  });

  it("reports no usage when the provider reports none", async () => {
    const test = await setup();
    try {
      const turn = await test.startTurn();
      const result = await turn.complete();
      expect(result.usage).toBeUndefined();
      expect(result.usagePoisoned).toBe(false);
    } finally { await test.close(); }
  });

  it("announces the cumulative estimate for providers that report no exact usage", async () => {
    const test = await setup();
    try {
      const turn = await test.startTurn();
      const cumulative = { method: "thread/tokenUsage/updated", params: {
        threadId: turn.threadId, turnId: turn.turnId,
        tokenUsage: { total: usage(30, 10), modelContextWindow: 200_000 },
      } };
      test.emit(cumulative);
      test.emit(cumulative); // A replayed cumulative snapshot must not double bill.
      const result = await turn.complete();
      expect(result.usage).toEqual(usage(30, 10));
      // The number is derived, not reported. Degraded, therefore announced.
      expect(test.warningCodes()).toEqual(["codex_app_server_turn_usage_estimated"]);
    } finally { await test.close(); }
  });
});

describe("readExactTurnUsage", () => {
  it("classifies an unreadable snapshot as untrusted, never as absent", () => {
    expect(readExactTurnUsage(undefined)).toEqual({ kind: "absent" });
    expect(readExactTurnUsage(null)).toEqual({ kind: "absent" });
    expect(readExactTurnUsage({})).toEqual({ kind: "absent" });
    expect(readExactTurnUsage({ modelContextWindow: 200_000 })).toEqual({ kind: "absent" });
    for (const value of [[1, 2, 3], [], "17", 17, { inputTokens: "17" }]) {
      expect(readExactTurnUsage(value)).toEqual({ kind: "invalid" });
    }
  });

  it("rejects a total that disagrees with the parts it contains", () => {
    expect(readExactTurnUsage({ inputTokens: 4, outputTokens: 2, totalTokens: 6 }))
      .toEqual({ kind: "exact", usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } });
    expect(readExactTurnUsage({ inputTokens: 100, outputTokens: 100, totalTokens: 5 })).toEqual({ kind: "invalid" });
    // One-sided: the missing part cannot excuse a total smaller than the part
    // that IS present.
    expect(readExactTurnUsage({ inputTokens: 100, totalTokens: 5 })).toEqual({ kind: "invalid" });
    expect(readExactTurnUsage({ outputTokens: 100, totalTokens: 5 })).toEqual({ kind: "invalid" });
    expect(readExactTurnUsage({ inputTokens: 4, totalTokens: 6 }))
      .toEqual({ kind: "exact", usage: { inputTokens: 4, totalTokens: 6 } });
    // `cachedInputTokens` is a SUBSET of `inputTokens` and `reasoningOutputTokens`
    // of `outputTokens`, so nothing legitimately pushes the total above the sum.
    expect(readExactTurnUsage({ inputTokens: 4, outputTokens: 2, totalTokens: 99 })).toEqual({ kind: "invalid" });
  });

  it("classifies a zeroed-parts total as context occupancy, not a cost", () => {
    // The shape `fill_to_context_window` and `recompute_token_usage` emit. A
    // model response always consumes input, so this is not one.
    expect(readExactTurnUsage({ inputTokens: 0, outputTokens: 0, totalTokens: 187_700 }))
      .toEqual({ kind: "occupancy", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 187_700 } });
    expect(readExactTurnUsage({
      inputTokens: 0, outputTokens: 0, totalTokens: 80_000, cachedInputTokens: 0, reasoningOutputTokens: 0,
    })).toMatchObject({ kind: "occupancy" });
    // A genuinely free response is still exact, not occupancy.
    expect(readExactTurnUsage({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }))
      .toEqual({ kind: "exact", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } });
  });

  it("never fabricates a total from an incomplete snapshot", () => {
    // `{ outputTokens: 500 }` would derive `totalTokens: 500`, implicitly
    // asserting `inputTokens === 0` — a number the provider never reported.
    expect(readExactTurnUsage({ outputTokens: 500 })).toEqual({ kind: "exact", usage: { outputTokens: 500 } });
    expect(readExactTurnUsage({ inputTokens: 500 })).toEqual({ kind: "exact", usage: { inputTokens: 500 } });
    expect(readExactTurnUsage({ inputTokens: 4, outputTokens: 2 }))
      .toEqual({ kind: "exact", usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } });
  });

  it("rejects two spellings of one counter that disagree, and accepts ones that agree", () => {
    expect(readExactTurnUsage({ inputTokens: 50, input_tokens: 9_999 })).toEqual({ kind: "invalid" });
    expect(readExactTurnUsage({ cachedInputTokens: 5, cached_input_tokens: 6 })).toEqual({ kind: "invalid" });
    expect(readExactTurnUsage({ inputTokens: 50, input_tokens: 50 }))
      .toEqual({ kind: "exact", usage: { inputTokens: 50 } });
    expect(readExactTurnUsage({ reasoning_output_tokens: 7 }))
      .toEqual({ kind: "exact", usage: { reasoningOutputTokens: 7 } });
  });

  it("rejects the whole snapshot for one counter it cannot bill", () => {
    for (const last of [
      { inputTokens: -1 },
      { inputTokens: 1.5 },
      { inputTokens: Number.NaN },
      { inputTokens: Number.POSITIVE_INFINITY },
      { inputTokens: Number.MAX_SAFE_INTEGER + 1 },
      { inputTokens: 4, outputTokens: 2, cachedInputTokens: -1 },
    ]) {
      expect(readExactTurnUsage(last)).toEqual({ kind: "invalid" });
    }
  });
});

async function setup() {
  const workspace = await mkdtemp(join(tmpdir(), "codex-exact-turn-usage-test-"));
  const factory = new FakeAppServerFactory();
  const starts: FakeAppServerRequest[] = [];
  const engine = new CodexAppServerExecutionEngine({
    codexBinaryPath: "/bin/codex-test", cleanThreadPrewarm: false, goalMode: false, timeoutMs: 5_000,
    processFactory: (processInput) => {
      const child = factory.create(processInput);
      const write = child.stdin.write.bind(child.stdin);
      child.stdin.write = (chunk) => {
        const request = JSON.parse(String(chunk)) as FakeAppServerRequest;
        if (request.method !== "turn/start") return write(chunk);
        starts.push(request);
        const turnId = `manual-${request.id}`;
        const send = (packet: unknown) => child.stdout.emit("data", `${JSON.stringify(packet)}\n`);
        send({ id: request.id, result: { turn: { id: turnId } } });
        send({ method: "turn/started", params: { threadId: request.params?.threadId, turn: { id: turnId } } });
        return true;
      };
      return child;
    },
  });
  const input = {
    session: { home: workspace, codexHome: workspace, env: { CODEX_HOME: workspace }, sessionHash: "synthetic", release: async () => undefined },
    workspacePath: workspace, model: "gpt-test", reasoningEffort: "low" as const,
    runner: new StaticRunner(""), redactor: new DefaultRedactor(),
    abortSignal: new AbortController().signal, prompt: "synthetic exact usage",
  };
  await engine.prewarm(input);
  const slots = (engine as unknown as { slotPool: { slots: Map<string, { client: CodexAppServerClient }> } }).slotPool.slots;
  const client = [...slots.values()][0]!.client;
  const child = factory.processes[0]!;
  const emit = (packet: unknown) => child.stdout.emit("data", `${JSON.stringify(packet)}\n`);
  return {
    emit,
    warningCodes: () => client.drainWarnings().map((warning) => warning.code),
    tokenUsage: (
      threadId: string,
      turnId: string,
      snapshot: { readonly last: unknown; readonly total: unknown },
    ) => emit({
      method: "thread/tokenUsage/updated",
      params: { threadId, turnId, tokenUsage: {
        last: snapshot.last, total: snapshot.total, modelContextWindow: 200_000,
      } },
    }),
    startTurn: async () => {
      const threadId = await client.startThread({ ...input, timeoutMs: 5_000 });
      const pending = client.startTurn({ ...input, threadId, timeoutMs: 5_000 });
      await expect.poll(() => starts.length, { timeout: 2_000, interval: 5 }).toBe(1);
      const turnId = `manual-${starts[0]!.id}`;
      return {
        threadId, turnId,
        complete: async () => {
          emit({ method: "turn/completed", params: { turn: { id: turnId, status: "completed" } } });
          return await pending;
        },
      };
    },
    close: async () => {
      await engine.dispose();
      await rm(workspace, { recursive: true, force: true });
    },
  };
}
