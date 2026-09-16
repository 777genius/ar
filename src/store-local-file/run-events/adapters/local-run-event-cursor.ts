import { stat } from "node:fs/promises";

import type {
  RunEventCursor,
  RunEventDeliveryCursorSnapshot,
  RunEventReadWarning,
} from "../ports/run-event-store-contracts";
import { eventLogGeneration, visitEventLogLines } from "./local-run-event-log-reader";

export type ResolvedRunEventCursor = {
  readonly generation?: string;
  readonly offset: number;
  readonly line: number;
  readonly discardPartialLine?: boolean;
  readonly futureLegacyCursor?: string;
  readonly warning?: RunEventReadWarning;
};

export type VersionedRunEventCursor = {
  readonly generation: string;
  readonly offset: number;
  readonly line: number;
  readonly discardPartialLine: boolean;
};

export async function resolveRunEventCursor(
  path: string,
  value: string | undefined,
): Promise<ResolvedRunEventCursor> {
  if (value === undefined) return { offset: 0, line: 0 };
  if (/^\d+$/.test(value)) {
    const requestedLine = Number(value);
    if (!Number.isSafeInteger(requestedLine)) return invalidCursor();
    if (requestedLine === 0) {
      try {
        return {
          generation: eventLogGeneration(await stat(path, { bigint: true })),
          offset: 0,
          line: 0,
        };
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") return { offset: 0, line: 0 };
        throw error;
      }
    }
    const seek = await visitEventLogLines({
      path,
      maxLineBytes: 1,
      visit: ({ lineNumber }) => lineNumber + 1 >= requestedLine,
    });
    return {
      ...(seek.generation === undefined ? {} : { generation: seek.generation }),
      offset: seek.nextOffset,
      line: requestedLine > seek.nextLine ? requestedLine : seek.nextLine,
      ...(requestedLine > seek.nextLine ? { futureLegacyCursor: value } : {}),
    };
  }
  if (value.length <= 512 && value.startsWith("v2.")) {
    const parsed = decodeVersionedRunEventCursor(value);
    if (parsed) {
      return {
        generation: parsed.generation,
        offset: parsed.offset,
        line: parsed.line,
        ...(parsed.discardPartialLine ? { discardPartialLine: true } : {}),
      };
    }
  }
  return invalidCursor();
}

export function encodeRunEventCursor(
  generation: string,
  offset: number,
  line: number,
  discardPartialLine = false,
): RunEventCursor {
  return {
    value: `v2.${Buffer.from(JSON.stringify({
      v: 2,
      g: generation,
      o: offset,
      l: line,
      ...(discardPartialLine ? { d: true } : {}),
    })).toString("base64url")}`,
  };
}

export function cursorLineNumber(value: string | undefined): number {
  if (value === undefined) return 0;
  if (/^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : 0;
  }
  if (value.startsWith("v2.")) {
    return decodeVersionedRunEventCursor(value)?.line ?? 0;
  }
  return 0;
}

export async function validateRunEventDeliveryCursors(
  path: string,
  cursors: readonly RunEventDeliveryCursorSnapshot[],
  lineEndOffsets: readonly number[],
): Promise<{
  readonly cursors: readonly RunEventDeliveryCursorSnapshot[];
  readonly warnings: readonly RunEventReadWarning[];
}> {
  let generation: string | undefined;
  let size = 0;
  try {
    const file = await stat(path, { bigint: true });
    generation = eventLogGeneration(file);
    size = Number(file.size);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }
  const warnings: RunEventReadWarning[] = [];
  const validated = cursors.map((cursor) => {
    if (/^\d+$/.test(cursor.cursor.value)) {
      if (cursor.lineNumber > lineEndOffsets.length - 1) {
        warnings.push({
          code: "delivery_cursor_generation_changed",
          message:
            `Delivery cursor '${cursor.consumerId}' exceeded the current event log and was reset for compaction safety.`,
        });
        return { ...cursor, lineNumber: 0 };
      }
      return {
        ...cursor,
        lineNumber: cursor.lineNumber,
      };
    }
    const versioned = decodeVersionedRunEventCursor(cursor.cursor.value);
    if (versioned && versioned.generation === generation && versioned.offset <= size) {
      const boundaryLine = lineEndOffsets.indexOf(versioned.offset);
      if (boundaryLine >= 0 && !versioned.discardPartialLine) {
        return { ...cursor, lineNumber: boundaryLine };
      }
      if (
        versioned.discardPartialLine && versioned.line < lineEndOffsets.length &&
        versioned.offset >= (lineEndOffsets[versioned.line] ?? Number.MAX_SAFE_INTEGER)
      ) {
        return { ...cursor, lineNumber: versioned.line };
      }
    }
    warnings.push({
      code: "delivery_cursor_generation_changed",
      message:
        `Delivery cursor '${cursor.consumerId}' did not match the current event log and was reset for compaction safety.`,
    });
    return { ...cursor, lineNumber: 0 };
  });
  return { cursors: validated, warnings };
}

export function decodeVersionedRunEventCursor(
  value: string,
): VersionedRunEventCursor | null {
  if (
    value.length > 512 || !value.startsWith("v2.") ||
    !/^[A-Za-z0-9_-]+$/.test(value.slice(3))
  ) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value.slice(3), "base64url").toString("utf8")) as unknown;
    if (
      !isRecord(parsed) || parsed.v !== 2 || typeof parsed.g !== "string" ||
      parsed.g.length === 0 || parsed.g.length > 256 || !safeInteger(parsed.o) ||
      !safeInteger(parsed.l) || (parsed.d !== undefined && typeof parsed.d !== "boolean")
    ) return null;
    const decoded = {
      generation: parsed.g,
      offset: parsed.o,
      line: parsed.l,
      discardPartialLine: parsed.d === true,
    };
    return encodeRunEventCursor(
        decoded.generation,
        decoded.offset,
        decoded.line,
        decoded.discardPartialLine,
      ).value === value
      ? decoded
      : null;
  } catch {
    return null;
  }
}

function invalidCursor(): ResolvedRunEventCursor {
  return {
    offset: 0,
    line: 0,
    warning: {
      code: "invalid_event_cursor",
      message: "The event cursor was invalid; reading restarted from the beginning.",
    },
  };
}

function safeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
