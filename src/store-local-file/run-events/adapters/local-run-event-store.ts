import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  parseRunEvent,
  runEventSourceKey,
  RunEventCompactionSafetyMode,
} from "@vioxen/subscription-runtime/worker-core";
import {
  localRunEventLogDefaultLockAcquireTimeoutMs as defaultLockAcquireTimeoutMs,
  localRunEventLogDefaultLockPollMs as defaultLockPollMs,
  localRunEventLogDefaultLockTtlMs as defaultLockTtlMs,
} from "../domain/run-event-log-policy";
import type {
  RunEvent,
  RunEventAppendResult,
  RunEventCompactionPlan,
  RunEventCompactionPort,
  RunEventCompactionResult,
  RunEventCursor,
  RunEventDeliveryCursorRewrite,
  RunEventDeliveryCursorSnapshot,
  RunEventDeliveryCursorStorePort,
  RunEventReadRequest,
  RunEventReadResult,
  RunEventReadWarning,
  RunEventRetentionPolicy,
  RunEventStorePort,
} from "../ports/run-event-store-contracts";
import {
  eventLogNeedsSeparatorNewline,
  eventLogGeneration,
  visitEventLogLines,
} from "./local-run-event-log-reader";
import {
  cursorLineNumber,
  encodeRunEventCursor,
  resolveRunEventCursor,
  validateRunEventDeliveryCursors,
} from "./local-run-event-cursor";
import {
  clearRunEventDedupeCache,
  refreshRunEventDedupeCache,
  updateRunEventDedupeCache,
} from "./local-run-event-dedupe-cache";
import { withDirectoryLock } from "./local-run-event-lock";

export type LocalFileRunEventStoreOptions = {
  readonly rootDir: string;
  readonly eventLogPath?: string;
  readonly lockTtlMs?: number;
  readonly lockAcquireTimeoutMs?: number;
  readonly lockPollMs?: number;
};

export class LocalFileRunEventStore
  implements RunEventStorePort, RunEventCompactionPort
{
  constructor(private readonly options: LocalFileRunEventStoreOptions) {}
  async append(events: readonly RunEvent[]): Promise<RunEventAppendResult> {
    if (events.length === 0) {
      return {
        appendedCount: 0,
        skippedDuplicateCount: 0,
      };
    }
    return this.withEventLogLock(async () => {
      const path = this.eventLogPath();
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const existing = await refreshRunEventDedupeCache(path);
      const lines: string[] = [];
      const pendingIds = new Set<string>();
      const appendedEventIds: string[] = [];
      const skippedDuplicateEventIds: string[] = [];
      let skippedDuplicateCount = 0;
      for (const event of events) {
        if (existing.has(event.eventId) || pendingIds.has(event.eventId)) {
          skippedDuplicateCount += 1;
          skippedDuplicateEventIds.push(event.eventId);
          continue;
        }
        pendingIds.add(event.eventId);
        appendedEventIds.push(event.eventId);
        try {
          lines.push(JSON.stringify(event));
        } catch (error) {
          clearRunEventDedupeCache(path);
          throw error;
        }
      }
      if (lines.length === 0) {
        return {
          appendedCount: 0,
          skippedDuplicateCount,
          appendedEventIds,
          skippedDuplicateEventIds,
        };
      }
      const prefix = await this.needsSeparatorNewline(path) ? "\n" : "";
      try {
        await writeFile(path, `${prefix}${lines.join("\n")}\n`, {
          encoding: "utf8",
          flag: "a",
          mode: 0o600,
        });
        for (const eventId of pendingIds) existing.add(eventId);
        await updateRunEventDedupeCache(path, existing);
      } catch (error) {
        clearRunEventDedupeCache(path);
        throw error;
      }
      return {
        appendedCount: lines.length,
        skippedDuplicateCount,
        appendedEventIds,
        skippedDuplicateEventIds,
      };
    });
  }

  async read(input: RunEventReadRequest = {}): Promise<RunEventReadResult> {
    const path = this.eventLogPath();
    const resolved = await resolveRunEventCursor(path, input.cursor?.value);
    const events: RunEvent[] = [];
    const warnings: RunEventReadWarning[] = [];
    const eventPositions: { readonly offset: number; readonly line: number }[] = [];
    const typeFilter = input.types === undefined ? null : new Set(input.types);
    const runIdFilter = runEventRunIdFilter(input.runId, input.runIds);
    let totalWarningCount = 0;
    const warningCounts: Record<string, number> = {};
    const maxWarnings = input.maxWarnings;
    const addWarning = (warning: RunEventReadWarning): void => {
      totalWarningCount += 1;
      warningCounts[warning.code] = (warningCounts[warning.code] ?? 0) + 1;
      if (maxWarnings === undefined || warnings.length < maxWarnings) warnings.push(warning);
    };
    if (resolved.warning) addWarning(resolved.warning);
    let hitEventLimit = false;

    const visited = await visitEventLogLines({
      path,
      startLine: resolved.line,
      startOffset: resolved.offset,
      ...(resolved.generation === undefined ? {} : { expectedGeneration: resolved.generation }),
      ...(resolved.discardPartialLine === true ? { discardPartialLine: true } : {}),
      ...(input.maxScannedBytes === undefined ? {} : { maxBytes: input.maxScannedBytes }),
      ...(input.maxScannedLines === undefined ? {} : { maxLines: input.maxScannedLines }),
      ...(input.maxLineBytes === undefined && input.maxScannedBytes === undefined
        ? {}
        : { maxLineBytes: input.maxLineBytes ?? input.maxScannedBytes }),
      visit: ({ line, lineNumber: index, nextOffset, oversized }) => {
        if (oversized) {
          addWarning({
            code: "event_line_too_large",
            message: "Skipped run event line exceeding the configured read bound.",
            lineNumber: index + 1,
          });
          return false;
        }
        if (!line.trim()) return false;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          addWarning({
            code: "invalid_event_json",
            message: "Skipped invalid run event JSON line.",
            lineNumber: index + 1,
          });
          return false;
        }
        const event = parseRunEvent(parsed);
        if (!event) {
          addWarning({
            code: "invalid_event_shape",
            message: "Skipped run event with invalid schema.",
            lineNumber: index + 1,
          });
          return false;
        }
        if (!runIdFilter(event.runId)) return false;
        if (
          input.sourceProviderKind !== undefined &&
          event.source.providerKind !== input.sourceProviderKind
        ) return false;
        if (
          input.sourceRegistryRootDir !== undefined &&
          event.source.registryRootDir !== input.sourceRegistryRootDir
        ) return false;
        if (typeFilter && !typeFilter.has(event.type)) return false;
        events.push(event);
        eventPositions.push({ offset: nextOffset, line: index + 1 });
        hitEventLimit = input.limit !== undefined && events.length >= input.limit;
        return hitEventLimit;
      },
    });
    if (!visited.exists) return { events: [], warnings, totalWarningCount };
    if (visited.generationChanged) {
      addWarning({
        code: "cursor_generation_changed",
        message: "The event log was replaced; reading restarted from the beginning and may repeat events.",
      });
    }
    if (visited.cursorOutOfRange) {
      addWarning({
        code: "cursor_offset_out_of_range",
        message: "The event cursor offset exceeded the current log; reading restarted from the beginning.",
      });
    }
    const generation = visited.generation;
    const nextCursor = resolved.futureLegacyCursor !== undefined && visited.scannedLines === 0
      ? { value: resolved.futureLegacyCursor }
      : generation === undefined
      ? { value: String(visited.nextLine) }
      : encodeRunEventCursor(
        generation,
        visited.nextOffset,
        visited.nextLine,
        visited.nextLineIncomplete,
      );
    const scanLimited = visited.hasMore && !hitEventLimit;

    return {
      events,
      nextCursor,
      warnings,
      eventCursors: generation === undefined ? [] : eventPositions.map((position) =>
        encodeRunEventCursor(generation, position.offset, position.line)
      ),
      hasMore: visited.hasMore,
      scanStopReason: hitEventLimit && visited.hasMore
        ? "event_limit"
        : scanLimited ? "scan_limit" : "end_of_log",
      scannedBytes: visited.scannedBytes,
      scannedLines: visited.scannedLines,
      totalWarningCount,
      warningsTruncated: warnings.length < totalWarningCount,
      warningCounts,
    };
  }

  async planCompaction(
    policy: RunEventRetentionPolicy = {},
  ): Promise<RunEventCompactionPlan> {
    return this.withEventLogLock(async () =>
      this.withDeliveryCursorLock(async () =>
        (await this.buildCompactionPlan(policy)).plan
      )
    );
  }

  async compact(
    policy: RunEventRetentionPolicy = {},
  ): Promise<RunEventCompactionResult> {
    return this.withEventLogLock(async () =>
      this.withDeliveryCursorLock(async () => {
        const planned = await this.buildCompactionPlan(policy);
        if (planned.plan.removableLineCount === 0) {
          return {
            ...planned.plan,
            compacted: false,
          };
        }
        const path = this.eventLogPath();
        const tempPath = join(dirname(path), `${randomUUID()}.compact.tmp`);
        try {
          await writeFile(
            tempPath,
            planned.retainedLines.length === 0
              ? ""
              : `${planned.retainedLines.join("\n")}\n`,
            { encoding: "utf8", mode: 0o600 },
          );
          await rename(tempPath, path);
          const compactedFile = await stat(path, { bigint: true });
          const compactedGeneration = eventLogGeneration(compactedFile);
          const retainedOffsets = lineEndOffsets(planned.retainedLines);
          const cursorRewrites = planned.plan.cursorRewrites.map((rewrite) => {
            const nextLine = cursorLineNumber(rewrite.nextCursor.value);
            return {
              ...rewrite,
              nextCursor: encodeRunEventCursor(
                compactedGeneration,
                retainedOffsets[Math.min(nextLine, retainedOffsets.length - 1)] ?? 0,
                nextLine,
              ),
            };
          });
          clearRunEventDedupeCache(path);
          for (const rewrite of cursorRewrites) {
            await this.writeDeliveryCursorSnapshot({
              consumerId: rewrite.consumerId,
              cursor: rewrite.nextCursor,
            });
          }
          return {
            ...planned.plan,
            cursorRewrites,
            compacted: true,
          };
        } catch (error) {
          await rm(tempPath, { force: true });
          throw error;
        }
      })
    );
  }

  private eventLogPath(): string {
    return this.options.eventLogPath ??
      join(this.options.rootDir, "run-events", "events.ndjson");
  }

  private eventLogLockPath(): string {
    return `${this.eventLogPath()}.lock`;
  }

  private async withEventLogLock<T>(fn: () => Promise<T>): Promise<T> {
    return withDirectoryLock({
      lockPath: this.eventLogLockPath(),
      parentDir: dirname(this.eventLogPath()),
      lockTtlMs: this.lockTtlMs(),
      lockAcquireTimeoutMs: this.lockAcquireTimeoutMs(),
      lockPollMs: this.lockPollMs(),
      timeoutError: "local_run_event_store_lock_timeout",
    }, fn);
  }

  private lockTtlMs(): number {
    return this.options.lockTtlMs ?? defaultLockTtlMs;
  }

  private lockAcquireTimeoutMs(): number {
    return this.options.lockAcquireTimeoutMs ?? defaultLockAcquireTimeoutMs;
  }

  private lockPollMs(): number {
    return this.options.lockPollMs ?? defaultLockPollMs;
  }

  private async needsSeparatorNewline(path: string): Promise<boolean> {
    return eventLogNeedsSeparatorNewline(path);
  }

  private async buildCompactionPlan(
    policy: RunEventRetentionPolicy,
  ): Promise<{
    readonly plan: RunEventCompactionPlan;
    readonly retainedLines: readonly string[];
  }> {
    const safetyMode = policy.safetyMode ??
      RunEventCompactionSafetyMode.PreserveDeliveryCursors;
    const lines = await this.readEventLogLines();
    const records = lines.map((line, index) => eventLogLineRecord(line, index));
    const savedDeliveryCursors = await this.readDeliveryCursorSnapshots();
    const validatedCursors = await validateRunEventDeliveryCursors(
      this.eventLogPath(),
      savedDeliveryCursors,
      lineEndOffsets(lines),
    );
    const deliveryCursors = validatedCursors.cursors;
    const cursorFloorLine = deliveryCursors.length === 0
      ? lines.length
      : Math.min(...deliveryCursors.map((cursor) => cursor.lineNumber));
    const latestRetainedLineIndexes = latestLineIndexesByRun(
      records,
      policy.keepLatestEventsPerRun,
    );
    const cutoffMs = policy.keepEventsAfter === undefined
      ? undefined
      : Date.parse(policy.keepEventsAfter);
    const removableIndexes = new Set<number>();
    let blockedByCursorLineCount = 0;

    for (const record of records) {
      const candidate = compactionCandidate({
        record,
        policy,
        ...(cutoffMs === undefined ? {} : { cutoffMs }),
        cursorFloorLine,
        latestRetainedLineIndexes,
      });
      if (!candidate) continue;
      if (
        safetyMode === RunEventCompactionSafetyMode.PreserveDeliveryCursors &&
        record.index >= cursorFloorLine
      ) {
        blockedByCursorLineCount += 1;
        continue;
      }
      removableIndexes.add(record.index);
    }

    const cursorRewrites = deliveryCursors.map((cursor) =>
      cursorRewriteForRemovedLines(cursor, removableIndexes)
    );
    const warnings = [
      ...validatedCursors.warnings,
      ...records
      .filter((record) => record.warning !== undefined)
      .map((record) => record.warning as RunEventReadWarning),
    ];
    return {
      plan: {
        schemaVersion: 1,
        safetyMode,
        totalLineCount: lines.length,
        validEventCount: records.filter((record) => record.event !== undefined).length,
        invalidLineCount: records.filter((record) => record.invalid).length,
        retainedLineCount: lines.length - removableIndexes.size,
        removableLineCount: removableIndexes.size,
        blockedByCursorLineCount,
        ...(deliveryCursors.length === 0 ? {} : { cursorFloorLine }),
        deliveryCursors,
        cursorRewrites,
        warnings,
      },
      retainedLines: lines.filter((_, index) => !removableIndexes.has(index)),
    };
  }

  private async readEventLogLines(): Promise<readonly string[]> {
    try {
      return splitEventLogLines(await readFile(this.eventLogPath(), "utf8"));
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw error;
    }
  }

  private async readDeliveryCursorSnapshots(): Promise<
    readonly RunEventDeliveryCursorSnapshot[]
  > {
    const dir = deliveryCursorDir(this.options.rootDir);
    let entries: readonly string[];
    try {
      entries = await readdir(dir);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw error;
    }
    const snapshots: RunEventDeliveryCursorSnapshot[] = [];
    for (const entry of entries) {
      const parsed = await readDeliveryCursorFile(join(dir, entry));
      if (parsed !== null) snapshots.push(parsed);
    }
    return snapshots.sort((left, right) =>
      left.consumerId.localeCompare(right.consumerId)
    );
  }

  private async writeDeliveryCursorSnapshot(input: {
    readonly consumerId: string;
    readonly cursor: RunEventCursor;
  }): Promise<void> {
    await writeDeliveryCursorFile(this.options.rootDir, input);
  }

  private async withDeliveryCursorLock<T>(fn: () => Promise<T>): Promise<T> {
    return withDirectoryLock({
      lockPath: deliveryCursorLockPath(this.options.rootDir),
      parentDir: this.options.rootDir,
      lockTtlMs: this.lockTtlMs(),
      lockAcquireTimeoutMs: this.lockAcquireTimeoutMs(),
      lockPollMs: this.lockPollMs(),
      timeoutError: "local_run_event_cursor_lock_timeout",
    }, fn);
  }
}

function runEventRunIdFilter(
  runId: string | undefined,
  runIds: readonly string[] | undefined,
): (value: string) => boolean {
  const runIdSet = runIds === undefined ? undefined : new Set(runIds);
  return (value) => {
    if (runId !== undefined && value !== runId) return false;
    if (runIdSet !== undefined && !runIdSet.has(value)) return false;
    return true;
  };
}

export { LocalFileRunEventProjectionStateStore } from "./local-run-event-projection-state-store";

export class LocalFileRunEventDeliveryCursorStore
  implements RunEventDeliveryCursorStorePort
{
  constructor(private readonly options: LocalFileRunEventStoreOptions) {}

  async readDeliveryCursor(consumerId: string): Promise<RunEventCursor | null> {
    return this.withDeliveryCursorLock(async () => {
      const snapshot = await readDeliveryCursorFile(this.cursorPath(consumerId));
      if (snapshot === null || snapshot.consumerId !== consumerId) return null;
      return snapshot.cursor;
    });
  }

  async writeDeliveryCursor(input: {
    readonly consumerId: string;
    readonly cursor: RunEventCursor;
  }): Promise<void> {
    await this.withDeliveryCursorLock(async () =>
      writeDeliveryCursorFile(this.options.rootDir, input)
    );
  }

  private cursorPath(consumerId: string): string {
    return deliveryCursorPath(this.options.rootDir, consumerId);
  }

  private async withDeliveryCursorLock<T>(fn: () => Promise<T>): Promise<T> {
    return withDirectoryLock({
      lockPath: deliveryCursorLockPath(this.options.rootDir),
      parentDir: this.options.rootDir,
      lockTtlMs: this.options.lockTtlMs ?? defaultLockTtlMs,
      lockAcquireTimeoutMs: this.options.lockAcquireTimeoutMs ??
        defaultLockAcquireTimeoutMs,
      lockPollMs: this.options.lockPollMs ?? defaultLockPollMs,
      timeoutError: "local_run_event_cursor_lock_timeout",
    }, fn);
  }
}

type EventLogLineRecord = {
  readonly index: number;
  readonly raw: string;
  readonly event?: RunEvent;
  readonly invalid: boolean;
  readonly warning?: RunEventReadWarning;
};

function eventLogLineRecord(line: string, index: number): EventLogLineRecord {
  if (!line.trim()) {
    return { index, raw: line, invalid: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return {
      index,
      raw: line,
      invalid: true,
      warning: {
        code: "invalid_event_json",
        message: "Skipped invalid run event JSON line.",
        lineNumber: index + 1,
      },
    };
  }
  const event = parseRunEvent(parsed);
  if (!event) {
    return {
      index,
      raw: line,
      invalid: true,
      warning: {
        code: "invalid_event_shape",
        message: "Skipped run event with invalid schema.",
        lineNumber: index + 1,
      },
    };
  }
  return { index, raw: line, event, invalid: false };
}

function latestLineIndexesByRun(
  records: readonly EventLogLineRecord[],
  keepLatestEventsPerRun: number | undefined,
): ReadonlySet<number> {
  const retained = new Set<number>();
  if (keepLatestEventsPerRun === undefined) return retained;
  if (keepLatestEventsPerRun <= 0) return retained;
  const byRun = new Map<string, EventLogLineRecord[]>();
  for (const record of records) {
    if (!record.event) continue;
    const key = JSON.stringify([record.event.runId, runEventSourceKey(record.event.source)]);
    const existing = byRun.get(key) ?? [];
    existing.push(record);
    byRun.set(key, existing);
  }
  for (const recordsForRun of byRun.values()) {
    for (const record of recordsForRun.slice(-keepLatestEventsPerRun)) {
      retained.add(record.index);
    }
  }
  return retained;
}

function compactionCandidate(input: {
  readonly record: EventLogLineRecord;
  readonly policy: RunEventRetentionPolicy;
  readonly cutoffMs?: number;
  readonly cursorFloorLine: number;
  readonly latestRetainedLineIndexes: ReadonlySet<number>;
}): boolean {
  if (input.latestRetainedLineIndexes.has(input.record.index)) return false;
  if (!input.record.event) {
    return input.record.invalid && input.policy.dropInvalidLines === true;
  }
  let candidate = false;
  if (input.cutoffMs !== undefined && Number.isFinite(input.cutoffMs)) {
    const eventTimeMs = Date.parse(
      input.record.event.observedAt || input.record.event.occurredAt,
    );
    if (Number.isFinite(eventTimeMs) && eventTimeMs < input.cutoffMs) {
      candidate = true;
    }
  }
  if (input.policy.keepLatestEventsPerRun !== undefined) {
    candidate = true;
  }
  if (
    input.policy.compactDeliveredEvents === true &&
    input.record.index < input.cursorFloorLine
  ) {
    candidate = true;
  }
  return candidate;
}

function cursorRewriteForRemovedLines(
  cursor: RunEventDeliveryCursorSnapshot,
  removedIndexes: ReadonlySet<number>,
): RunEventDeliveryCursorRewrite {
  let removedBeforeCursor = 0;
  let invalidatedUnreadEvents = false;
  for (const index of removedIndexes) {
    if (index < cursor.lineNumber) removedBeforeCursor += 1;
    if (index >= cursor.lineNumber) invalidatedUnreadEvents = true;
  }
  return {
    consumerId: cursor.consumerId,
    previousCursor: cursor.cursor,
    nextCursor: {
      value: String(Math.max(0, cursor.lineNumber - removedBeforeCursor)),
    },
    invalidatedUnreadEvents,
  };
}

function splitEventLogLines(contents: string): readonly string[] {
  if (!contents) return [];
  const normalized = contents.endsWith("\n") ? contents.slice(0, -1) : contents;
  return normalized ? normalized.split("\n") : [];
}

function lineEndOffsets(lines: readonly string[]): readonly number[] {
  const offsets = [0];
  for (const line of lines) {
    offsets.push((offsets[offsets.length - 1] ?? 0) + Buffer.byteLength(line) + 1);
  }
  return offsets;
}

function deliveryCursorDir(rootDir: string): string {
  return join(rootDir, "run-event-delivery-cursors");
}

function deliveryCursorPath(rootDir: string, consumerId: string): string {
  return join(
    deliveryCursorDir(rootDir),
    createHash("sha256").update(consumerId).digest("hex"),
  );
}

function deliveryCursorLockPath(rootDir: string): string {
  return join(rootDir, "run-event-delivery-cursors.lock");
}

async function readDeliveryCursorFile(
  path: string,
): Promise<RunEventDeliveryCursorSnapshot | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (
      isNodeError(error) &&
      (error.code === "ENOENT" || error.code === "EISDIR")
    ) {
      return null;
    }
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  if (
    !isRecord(parsed) ||
    parsed.schemaVersion !== 1 ||
    typeof parsed.consumerId !== "string" ||
    typeof parsed.cursor !== "string"
  ) {
    return null;
  }
  const lineNumber = cursorLineNumber(parsed.cursor);
  return {
    consumerId: parsed.consumerId,
    cursor: { value: parsed.cursor },
    lineNumber,
  };
}

async function writeDeliveryCursorFile(
  rootDir: string,
  input: {
    readonly consumerId: string;
    readonly cursor: RunEventCursor;
  },
): Promise<void> {
  if (!input.consumerId.trim()) {
    throw new Error("local_run_event_cursor_consumer_id_required");
  }
  const path = deliveryCursorPath(rootDir, input.consumerId);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tempPath = join(dirname(path), `${randomUUID()}.tmp`);
  try {
    await writeFile(
      tempPath,
      `${JSON.stringify({
        schemaVersion: 1,
        consumerId: input.consumerId,
        cursor: input.cursor.value,
      }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}


function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
