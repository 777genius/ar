import type { WorkerControlSignalView } from "@vioxen/subscription-runtime/worker-core";
import { ControlListState, CONTROL_LIST_MAX_BYTES, listCodexGoalControlSignalsMcp } from "../codex-goal-mcp-control-list";
import { mcpJson } from "../codex-goal-mcp-response";
import { workerControlSignalViewJson } from "../application/codex-goal-worker-control-view";
const source = vi.hoisted(() => ({ signals: [] as WorkerControlSignalView[] }));
vi.mock("../application/codex-goal-worker-control-use-cases", () => ({
    readCodexGoalControlSignals: async (args: {
        jobId?: string;
    }) => ({
        ok: true, registryRootDir: "/tmp/test-registry", jobId: args.jobId ?? "test-job", taskId: "test-task", signals: source.signals,
    }),
}));
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
function view(index: number, state: WorkerControlSignalView["state"] = "pending", body = "test guidance"): WorkerControlSignalView {
    return { signal: { schemaVersion: 1, signalId: `signal-${String(index).padStart(4, "0")}`,
            idempotencyKey: `key-${index}`, target: { jobId: "test-job" }, intent: "guidance",
            deliveryMode: "next_safe_point", body, createdAt: new Date("2026-09-06T00:00:00Z"),
            createdBy: "operator", priority: "normal", supersedesSignalIds: [], metadata: {},
        }, state, deliverable: state === "pending", expired: false };
}
beforeEach(() => { source.signals = []; });
it("bounds a delivered archive by default while retaining counts and explicit archive access", async () => {
    source.signals = Array.from({ length: 1000 }, (_, i) => view(i, "delivered", "Continue current work. ".repeat(50)));
    const result = await listCodexGoalControlSignalsMcp({});
    expect(result.structuredContent.signals).toEqual([]);
    expect(result.structuredContent.counts).toMatchObject({ total: 1000, delivered: 1000, pending: 0 });
    const archive = await listCodexGoalControlSignalsMcp({ state: ControlListState.All });
    expect(archive.structuredContent.signals).toHaveLength(50);
    expect(archive.structuredContent.page.hasMore).toBe(true);
    const before = mcpJson({ signals: source.signals.map(v => workerControlSignalViewJson(v, false)) });
    console.log("CONTROL_LIST_BYTES", JSON.stringify({ before: bytes(before), afterDefault: bytes(result), afterArchive: bytes(archive) }));
    expect(bytes(result)).toBeLessThan(2000);
});
it("paginates equal timestamps deterministically, including state changes of the cursor item", async () => {
    source.signals = [view(2), view(0), view(1)];
    const first = await listCodexGoalControlSignalsMcp({ limit: 1 });
    expect(first.structuredContent.signals[0]).toMatchObject({ signal: { signalId: "signal-0000" } });
    source.signals[1] = view(0, "delivered");
    const second = await listCodexGoalControlSignalsMcp({ limit: 1, cursor: first.structuredContent.page.nextCursor! });
    expect(second.structuredContent.signals[0]).toMatchObject({ signal: { signalId: "signal-0001" } });
    const third = await listCodexGoalControlSignalsMcp({ limit: 1, cursor: second.structuredContent.page.nextCursor! });
    expect(third.structuredContent.page.nextCursor).toBeNull();
    expect(third.structuredContent.signals[0]).toMatchObject({ signal: { signalId: "signal-0002" } });
});
it("caps the duplicated UTF-8 envelope, explicitly omits oversized body and makes forward progress", async () => {
    source.signals = [view(0, "pending", '😀"\\'.repeat(30000)), ...Array.from({ length: 20 }, (_, i) => view(i + 1, "pending", '😀"\\'.repeat(1000)))];
    let cursor: string | undefined;
    const ids: string[] = [];
    do {
        const result = await listCodexGoalControlSignalsMcp({ includeBodies: true, limit: 100, ...(cursor ? { cursor } : {}) });
        expect(bytes(result)).toBeLessThanOrEqual(CONTROL_LIST_MAX_BYTES);
        for (const row of result.structuredContent.signals)
            ids.push((row.signal as {
                signalId: string;
            }).signalId);
        if (!cursor)
            expect(result.structuredContent.signals[0]).toMatchObject({ bodyOmitted: true, retrieval: expect.stringContaining("WorkerControlService.listSignals") });
        cursor = result.structuredContent.page.nextCursor ?? undefined;
    } while (cursor);
    expect(ids).toEqual(source.signals.map(v => v.signal.signalId));
});
it.each([0, -1, 101, 1.5, NaN])("rejects invalid limit %s", async (limit) => {
    await expect(listCodexGoalControlSignalsMcp({ limit })).rejects.toThrow("limit");
});
it("rejects invalid, mismatched and stale cursors", async () => {
    source.signals = [view(0), view(1)];
    await expect(listCodexGoalControlSignalsMcp({ cursor: "garbage" })).rejects.toThrow("cursor");
    const first = await listCodexGoalControlSignalsMcp({ limit: 1 });
    const cursor = first.structuredContent.page.nextCursor!;
    await expect(listCodexGoalControlSignalsMcp({ cursor, state: ControlListState.All })).rejects.toThrow("different");
    await expect(listCodexGoalControlSignalsMcp({ cursor, jobId: "other" })).rejects.toThrow("different");
    source.signals.shift();
    await expect(listCodexGoalControlSignalsMcp({ cursor })).rejects.toThrow("Stale");
});

it("keeps pending intents visible when optional metadata and diagnostics are oversized", async () => {
  const pending = view(0);
  source.signals = [{
    ...pending,
    signal: { ...pending.signal, metadata: { note: "x".repeat(100000) } },
    blockedReason: "reason".repeat(10000),
  }];
  const result = await listCodexGoalControlSignalsMcp({});
  expect(bytes(result)).toBeLessThanOrEqual(CONTROL_LIST_MAX_BYTES);
  expect(result.structuredContent.signals[0]).toMatchObject({
    signal: { signalId: "signal-0000", intent: "guidance" },
    state: "pending",
    truncatedFields: ["blockedReason"],
  });
  await expect(listCodexGoalControlSignalsMcp({
    state: "invalid" as ControlListState,
  })).rejects.toThrow("Invalid control list state");
});
