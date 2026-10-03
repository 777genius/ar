import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProviderRuntimeRegistry, RunEventProviderKind, type ProviderRuntimeAdapter, type RunObservationSnapshot } from "@vioxen/subscription-runtime/worker-core";
import { watchAgentRuns, projectAgentRunEvents } from "../codex-goal-mcp-run-events";
import { mcpJson } from "../codex-goal-mcp-response";
import { RUN_WATCH_MAX_RESPONSE_BYTES } from "../codex-goal-mcp-run-watch-page";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
function fakeRegistry(count: number, options: { oversized?: boolean; locator?: boolean } = {}) {
  const ids = Array.from({ length: count }, (_, i) => `fake-${String(i).padStart(4, "0")}`);
  let active = 0, peak = 0, calls = 0;
  const snapshots = (runId: string): RunObservationSnapshot => ({
    runId, providerKind: RunEventProviderKind.Codex, observedAt: "2026-09-06T00:00:00Z",
    status: "running", liveness: "alive", warnings: [],
    readOnlyDecision: { kind: "keep_watching", reason: "worker_observable", safeMessage: options.oversized && runId === ids[0] ? "x".repeat(100_000) : "watch" },
  });
  const registry = createProviderRuntimeRegistry([{
    kind: RunEventProviderKind.Codex,
    controllerProfile: () => { throw new Error("fake_unused"); },
    controlledAgentProvider: async () => { throw new Error("fake_unused"); },
    observation: () => ({
      responseLocator: { registryRootDir: options.locator ? "x".repeat(100_000) : "/fake" },
      listRunIds: async () => ids,
      observeRun: async ({ runId }: { runId: string }) => {
        calls++; active++; peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active--; return snapshots(runId);
      },
    }),
  } satisfies ProviderRuntimeAdapter]);
  return { registry, ids, stats: () => ({ peak, calls }) };
}

describe("run watch bounded presentation", () => {
  it("walks 1000 fake jobs once with bounded concurrency and complete envelope bytes", async () => {
    const fake = fakeRegistry(1000);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const result = await watchAgentRuns({ registryRootDir: "/fake", ...(cursor ? { cursor } : {}) }, fake.registry);
      expect(Buffer.byteLength(JSON.stringify(mcpJson(result)))).toBeLessThanOrEqual(RUN_WATCH_MAX_RESPONSE_BYTES);
      expect(result.returnedRuns).toBeLessThanOrEqual(25);
      seen.push(...(result.snapshots as RunObservationSnapshot[]).map((snapshot) => snapshot.runId));
      cursor = result.nextCursor as string | undefined;
    } while (cursor);
    expect(seen).toEqual(fake.ids);
    expect(fake.stats()).toEqual({ peak: 4, calls: 1000 });
  });
  it("rejects cursor reuse after filters or membership change", async () => {
    const fake = fakeRegistry(30);
    const page = await watchAgentRuns({}, fake.registry);
    await expect(watchAgentRuns({ cursor: page.nextCursor as string, includeChangedFiles: true }, fake.registry))
      .rejects.toThrow("run_watch_cursor_invalid_or_selection_changed");
    fake.ids.push("fake-new");
    await expect(watchAgentRuns({ cursor: page.nextCursor as string }, fake.registry))
      .rejects.toThrow("run_watch_cursor_invalid_or_selection_changed");
  });
  it("explicitly omits oversized snapshots and advances to the next run", async () => {
    const fake = fakeRegistry(2, { oversized: true });
    const first = await watchAgentRuns({}, fake.registry);
    expect(first).toMatchObject({ ok: false, returnedRuns: 0, processedRuns: 1, snapshotContentOmitted: true });
    expect(first.omittedSnapshots).toMatchObject([{ runId: "fake-0000", safeToContinue: false }]);
    const second = await watchAgentRuns({ cursor: first.nextCursor as string }, fake.registry);
    expect(second).toMatchObject({ ok: true, returnedRuns: 1, truncated: false });
    expect(Buffer.byteLength(JSON.stringify(mcpJson(first)))).toBeLessThanOrEqual(RUN_WATCH_MAX_RESPONSE_BYTES);
  });
  it("bounds oversized metadata and unknown provider strings without losing progress", async () => {
    const fake = fakeRegistry(2, { locator: true });
    const result = await watchAgentRuns({}, fake.registry);
    expect(result).toMatchObject({ ok: false, processedRuns: 2, truncated: false, responseMetadataOmitted: true });
    const unsupported = await watchAgentRuns({ providerKind: "x".repeat(100_000) }, fake.registry);
    for (const value of [result, unsupported]) expect(Buffer.byteLength(JSON.stringify(mcpJson(value)))).toBeLessThanOrEqual(RUN_WATCH_MAX_RESPONSE_BYTES);
  });
  it("preserves small snapshots and caps explicit public limits", async () => {
    const fake = fakeRegistry(2);
    const result = await watchAgentRuns({}, fake.registry);
    expect(result).toMatchObject({ ok: true, mode: "read_only", sideEffects: [], totalRuns: 2, returnedRuns: 2, truncated: false });
    expect(result.snapshots).toHaveLength(2);
    const large = await watchAgentRuns({ limit: 1000 }, fakeRegistry(1000).registry);
    expect(large.returnedRuns).toBeLessThanOrEqual(100);
  });
  it("serializes concurrent MCP projections before observation of the same run", async () => {
    const root = await mkdtemp(join(tmpdir(), "run-mcp-concurrent-fake-")); roots.push(root);
    const fake = fakeRegistry(1);
    const args = { registryRootDir: root, eventRootDir: join(root, "events") };
    const results = await Promise.all([projectAgentRunEvents(args, fake.registry), projectAgentRunEvents(args, fake.registry)]);
    expect(fake.stats()).toEqual({ peak: 1, calls: 2 });
    expect(results.map((result) => result.appendedCount).filter((count) => count === 0)).toHaveLength(1);
  });
  it("projects all selected runs beyond the default public page", async () => {
    const root = await mkdtemp(join(tmpdir(), "run-projection-fake-")); roots.push(root);
    const fake = fakeRegistry(30);
    const result = await projectAgentRunEvents({ registryRootDir: root, eventRootDir: join(root, "events") }, fake.registry);
    expect(result).toMatchObject({ totalRuns: 30, returnedRuns: 30, totalProjectedRuns: 30 });
    expect(fake.stats().calls).toBe(30);
  });
});
