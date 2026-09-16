import { createHash } from "node:crypto";
import type { RunObservationSnapshot } from "@vioxen/subscription-runtime/worker-core";
import { mcpJson } from "./codex-goal-mcp-response";
import { summarizeRunObservationSnapshots } from "./codex-goal-mcp-observation-projection";

export const RUN_WATCH_DEFAULT_LIMIT = 25;
export const RUN_WATCH_MAX_LIMIT = 100;
export const RUN_WATCH_MAX_RESPONSE_BYTES = 64 * 1024;
type JsonObject = Readonly<Record<string, unknown>>;

export function runWatchPage(input: {
  readonly runIds: readonly string[];
  readonly filter: JsonObject;
  readonly limit?: number;
  readonly cursor?: string;
}) {
  const runIds = [...new Set(input.runIds)].sort();
  const fingerprint = createHash("sha256").update(JSON.stringify({ filter: input.filter, runIds })).digest("hex");
  let offset = 0;
  if (input.cursor !== undefined) {
    try {
      if (input.cursor.length > 1024) throw new Error();
      const value = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8"));
      if (value.v !== 1 || value.fingerprint !== fingerprint ||
          !Number.isSafeInteger(value.offset) || value.offset < 0 || value.offset > runIds.length) throw new Error();
      offset = value.offset;
    } catch {
      throw new Error("run_watch_cursor_invalid_or_selection_changed");
    }
  }
  const limit = Number.isInteger(input.limit) && (input.limit ?? 0) > 0
    ? Math.min(input.limit as number, RUN_WATCH_MAX_LIMIT) : RUN_WATCH_DEFAULT_LIMIT;
  return {
    runIds: runIds.slice(offset, offset + limit), totalRuns: runIds.length, offset, limit,
    cursorAt: (count: number) => Buffer.from(JSON.stringify({ v: 1, fingerprint, offset: offset + count })).toString("base64url"),
  };
}

export function boundedRunWatchResponse(input: {
  readonly base: JsonObject;
  readonly snapshots: readonly RunObservationSnapshot[];
  readonly page: ReturnType<typeof runWatchPage>;
}): JsonObject {
  const base = bytes(input.base) > 8 * 1024
    ? { ok: false, mode: "read_only", sideEffects: [], responseMetadataOmitted: true }
    : input.base;
  const snapshots: RunObservationSnapshot[] = [];
  const omittedSnapshots: JsonObject[] = [];
  let consumed = 0;
  const response = (): JsonObject => ({
    ...base,
    ok: base.ok === true && omittedSnapshots.length === 0 &&
      snapshots.every((snapshot) => !snapshot.warnings.some((warning) => warning.code === "run_observation_failed")),
    totalRuns: input.page.totalRuns,
    returnedRuns: snapshots.length,
    processedRuns: consumed,
    effectiveLimit: input.page.limit,
    truncated: input.page.offset + consumed < input.page.totalRuns,
    ...(input.page.offset + consumed < input.page.totalRuns ? { nextCursor: input.page.cursorAt(consumed) } : {}),
    summary: summarizeRunObservationSnapshots(snapshots),
    snapshots,
    ...(omittedSnapshots.length ? { omittedSnapshots, snapshotContentOmitted: true } : {}),
    ...(snapshots.some((snapshot) => snapshot.warnings.some((warning) => warning.code === "run_observation_failed"))
      ? { observationFailures: snapshots.filter((snapshot) => snapshot.warnings.some((warning) => warning.code === "run_observation_failed"))
        .map((snapshot) => ({ runId: snapshot.runId, warnings: snapshot.warnings.filter((warning) => warning.code === "run_observation_failed") })) } : {}),
  });
  for (const snapshot of input.snapshots) {
    snapshots.push(snapshot);
    consumed++;
    if (bytes(response()) <= RUN_WATCH_MAX_RESPONSE_BYTES) continue;
    snapshots.pop();
    consumed--;
    // Stop before the next ordinary item. An item that cannot fit alone is
    // explicitly omitted and consumed so every page makes forward progress.
    if (consumed > 0) break;
    omittedSnapshots.push({
      runId: snapshot.runId.slice(0, 512),
      runIdHash: createHash("sha256").update(snapshot.runId).digest("hex"),
      reason: "snapshot_exceeds_response_byte_limit",
      safeToContinue: false,
      reviewOnly: true,
    });
    consumed++;
    break;
  }
  const result = response();
  if (bytes(result) > RUN_WATCH_MAX_RESPONSE_BYTES) {
    // Locator metadata can itself be oversized. Keep the progress contract bounded.
    return {
      ok: false, mode: "read_only", sideEffects: [], reason: "watch_metadata_exceeds_response_byte_limit",
      totalRuns: input.page.totalRuns, returnedRuns: 0, processedRuns: 0,
      truncated: true, snapshots: [],
    };
  }
  return result;
}

function bytes(value: JsonObject): number {
  return Buffer.byteLength(JSON.stringify(mcpJson(value)), "utf8");
}
