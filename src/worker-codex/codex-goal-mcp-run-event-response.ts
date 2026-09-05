import { createHash } from "node:crypto";

import type {
  RunEvent,
  RunEventCompactionPlan,
  RunEventCursor,
  RunEventReadResult,
  RunEventReadWarning,
} from "@vioxen/subscription-runtime/worker-core";
import { mcpJson } from "./codex-goal-mcp-response";

const MCP_RESPONSE_MAX_BYTES = 64 * 1024;
const MCP_RAW_EVENT_MAX_BYTES = 48 * 1024;
const MCP_WARNING_SAMPLES = 20;

type JsonObject = Readonly<Record<string, unknown>>;

export function boundedEventHistoryMetadataResponse(value: JsonObject): JsonObject {
  const bounded = boundMetadata(value, 0, { remaining: 8_000 }) as JsonObject;
  if (mcpSerializedBytes(bounded) <= MCP_RESPONSE_MAX_BYTES) return bounded;
  const details = isObject(value.plan)
    ? value.plan
    : isObject(value.result) ? value.result : value;
  return {
    ok: value.ok,
    mode: value.mode,
    reason: "mcp_event_response_metadata_truncated",
    responseMetadataTruncated: true,
    runId: boundedScalar(value.runId),
    providerKind: boundedScalar(value.providerKind),
    summary: Object.fromEntries([
      "totalLineCount", "validEventCount", "invalidLineCount", "retainedLineCount",
      "removableLineCount", "blockedByCursorLineCount", "totalWarningCount",
      "totalDeliveryCursorCount", "totalCursorRewriteCount",
      "invalidatedUnreadCursorCount", "compacted",
    ].flatMap((key) => key in details ? [[key, details[key]]] : [])),
  };
}

export function boundedRunEventWarnings(
  warnings: readonly RunEventReadWarning[],
  summary: {
    readonly totalWarningCount?: number;
    readonly warningCounts?: Readonly<Record<string, number>>;
  } = {},
): JsonObject {
  const totalWarningCount = summary.totalWarningCount ?? warnings.length;
  return {
    warnings: warnings.slice(0, MCP_WARNING_SAMPLES),
    totalWarningCount,
    warningsTruncated: totalWarningCount > MCP_WARNING_SAMPLES,
    warningCounts: summary.warningCounts ?? countWarnings(warnings),
  };
}

export function boundedRunEventCompactionPlan(
  plan: RunEventCompactionPlan,
): JsonObject {
  const maxCursorDetails = 50;
  return {
    ...plan,
    ...boundedRunEventWarnings(plan.warnings),
    deliveryCursors: plan.deliveryCursors.slice(0, maxCursorDetails),
    cursorRewrites: plan.cursorRewrites.slice(0, maxCursorDetails),
    totalDeliveryCursorCount: plan.deliveryCursors.length,
    totalCursorRewriteCount: plan.cursorRewrites.length,
    cursorDetailsTruncated: plan.deliveryCursors.length > maxCursorDetails ||
      plan.cursorRewrites.length > maxCursorDetails,
    invalidatedUnreadCursorCount: plan.cursorRewrites.filter((item) =>
      item.invalidatedUnreadEvents
    ).length,
  };
}

export function boundedRunEventResponse(input: {
  readonly base: JsonObject;
  readonly read: RunEventReadResult;
  readonly requestedCursor?: string;
  readonly effectiveLimit: number;
}): JsonObject {
  const safeRequestedCursor = input.requestedCursor !== undefined &&
      input.requestedCursor.length <= 512
    ? input.requestedCursor
    : undefined;
  if (
    input.read.events.length > 0 &&
    input.read.eventCursors?.length !== input.read.events.length
  ) {
    return {
      ok: false,
      mode: input.base.mode,
      reason: "run_event_cursor_alignment_missing",
      safeMessage: "The event page did not include aligned cursors and was not advanced.",
      effectiveLimit: input.effectiveLimit,
      returnedEvents: 0,
      omittedEventCount: 0,
      hasMore: true,
      nextCursor: safeRequestedCursor,
      events: [],
    };
  }
  const base = boundedBase(input.base);
  const warnings = input.read.warnings.slice(0, MCP_WARNING_SAMPLES);
  const warningCounts = { ...(input.read.warningCounts ?? countWarnings(input.read.warnings)) };
  const omittedEvents: JsonObject[] = [];
  const events: RunEvent[] = [];
  let lastCursor: RunEventCursor | undefined;
  let stoppedForResponseBudget = false;
  let omissionWarningCount = 0;

  const assemble = (): JsonObject => ({
    ...base,
    ok: base.ok === true && omissionWarningCount === 0,
    effectiveLimit: input.effectiveLimit,
    returnedEvents: events.length,
    omittedEventCount: omittedEvents.length,
    pageFull: events.length + omittedEvents.length === input.effectiveLimit,
    hasMore: stoppedForResponseBudget || input.read.hasMore === true,
    nextCursor: (stoppedForResponseBudget
      ? lastCursor ?? (safeRequestedCursor === undefined
        ? undefined
        : { value: safeRequestedCursor })
      : input.read.nextCursor)?.value,
    scanStopReason: stoppedForResponseBudget
      ? "response_byte_limit"
      : input.read.scanStopReason,
    scannedBytes: input.read.scannedBytes ?? 0,
    scannedLines: input.read.scannedLines ?? 0,
    totalWarningCount: (input.read.totalWarningCount ?? input.read.warnings.length) +
      omissionWarningCount,
    warningsTruncated: (input.read.totalWarningCount ?? input.read.warnings.length) +
      omissionWarningCount > warnings.length,
    warningCounts,
    warnings,
    ...(omittedEvents.length === 0 ? {} : { omittedEvents }),
    events,
  });

  for (let index = 0; index < input.read.events.length; index += 1) {
    const event = input.read.events[index];
    const cursor = input.read.eventCursors?.[index];
    if (!event || !cursor) break;
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (bytes > MCP_RAW_EVENT_MAX_BYTES) {
      omittedEvents.push(oversizedEventEnvelope(event, index, bytes, "mcp_event_payload_too_large"));
      const previousCursor = lastCursor;
      lastCursor = cursor;
      if (mcpSerializedBytes(assemble()) > MCP_RESPONSE_MAX_BYTES && index > 0) {
        omittedEvents.pop();
        lastCursor = previousCursor;
        stoppedForResponseBudget = true;
        break;
      }
      addOmissionWarning(warnings, warningCounts, "mcp_event_payload_too_large");
      omissionWarningCount += 1;
      continue;
    }
    events.push(event);
    const previousCursor = lastCursor;
    lastCursor = cursor;
    if (mcpSerializedBytes(assemble()) > MCP_RESPONSE_MAX_BYTES) {
      events.pop();
      if (index === 0) {
        addOmissionWarning(warnings, warningCounts, "mcp_response_byte_limit");
        omissionWarningCount += 1;
        omittedEvents.push(oversizedEventEnvelope(
          event,
          index,
          bytes,
          "mcp_response_byte_limit",
        ));
        lastCursor = cursor;
      } else {
        lastCursor = previousCursor;
        stoppedForResponseBudget = true;
        break;
      }
    }
  }

  let response = assemble();
  while (mcpSerializedBytes(response) > MCP_RESPONSE_MAX_BYTES && warnings.length > 0) {
    warnings.pop();
    response = assemble();
  }
  if (mcpSerializedBytes(response) > MCP_RESPONSE_MAX_BYTES) {
    return {
      ok: false,
      mode: base.mode,
      reason: "mcp_event_response_metadata_too_large",
      safeMessage: "Run event metadata was reduced to stay within the MCP response bound.",
      effectiveLimit: input.effectiveLimit,
      returnedEvents: 0,
      omittedEventCount: 0,
      hasMore: true,
      nextCursor: safeRequestedCursor,
      totalWarningCount: input.read.totalWarningCount ?? input.read.warnings.length,
      warningCounts,
      events: [],
    };
  }
  return response;
}

function oversizedEventEnvelope(
  event: RunEvent,
  pageIndex: number,
  byteLength: number,
  reason: "mcp_event_payload_too_large" | "mcp_response_byte_limit",
): JsonObject {
  return {
    pageIndex,
    schemaVersion: event.schemaVersion,
    eventId: boundedString(event.eventId),
    runId: boundedString(event.runId),
    ...(event.jobId === undefined ? {} : { jobId: boundedString(event.jobId) }),
    type: boundedString(event.type),
    severity: event.severity,
    occurredAt: boundedString(event.occurredAt),
    observedAt: boundedString(event.observedAt),
    correlationId: boundedString(event.correlationId),
    source: {
      providerKind: event.source.providerKind,
      ...(event.source.hostId === undefined ? {} : { hostId: boundedString(event.source.hostId) }),
    },
    omission: {
      reason,
      byteLength,
      sha256: createHash("sha256").update(JSON.stringify(event)).digest("hex"),
    },
  };
}

function countWarnings(warnings: RunEventReadResult["warnings"]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const warning of warnings) counts[warning.code] = (counts[warning.code] ?? 0) + 1;
  return counts;
}

function addOmissionWarning(
  warnings: RunEventReadResult["warnings"] extends readonly (infer W)[] ? W[] : never,
  counts: Record<string, number>,
  code: string,
): void {
  counts[code] = (counts[code] ?? 0) + 1;
  if (warnings.length < MCP_WARNING_SAMPLES && !warnings.some((warning) => warning.code === code)) {
    warnings.push({
      code,
      message: "A run event was represented by a bounded omission envelope.",
    });
  }
}

function boundedString(value: string): string {
  return value.length <= 256 ? value : `${value.slice(0, 240)}...[truncated]`;
}

function boundedBase(value: JsonObject): JsonObject {
  const bounded = boundMetadata(value, 0, { remaining: 8_000 }) as Record<string, unknown>;
  const projectedRuns = Array.isArray(bounded.projectedRuns)
    ? bounded.projectedRuns as unknown[]
    : undefined;
  while (mcpSerializedBytes(bounded) > 16 * 1024 && projectedRuns?.length) {
    projectedRuns.pop();
    bounded.projectedRunsTruncated = true;
  }
  if (mcpSerializedBytes(bounded) <= 16 * 1024) return bounded;
  return {
    ok: bounded.ok,
    mode: bounded.mode,
    providerKind: bounded.providerKind,
    totalRuns: bounded.totalRuns,
    returnedRuns: bounded.returnedRuns,
    responseMetadataTruncated: true,
  };
}

function boundMetadata(
  value: unknown,
  depth: number,
  budget: { remaining: number },
): unknown {
  if (budget.remaining <= 0) return "[metadata truncated]";
  budget.remaining -= 1;
  if (typeof value === "string") return boundedString(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= 8) return "[metadata truncated]";
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => boundMetadata(item, depth + 1, budget));
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 50)
      .map(([key, item]) => [key, boundMetadata(item, depth + 1, budget)]),
  );
}

function boundedScalar(value: unknown): unknown {
  return typeof value === "string" ? boundedString(value) : value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mcpSerializedBytes(value: JsonObject): number {
  return Buffer.byteLength(JSON.stringify(mcpJson(value)));
}
