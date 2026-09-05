import { open } from "node:fs/promises";
import { createHash } from "node:crypto";

export type EventLogLineVisit = {
  readonly line: string;
  readonly lineNumber: number;
  readonly startOffset: number;
  readonly nextOffset: number;
  readonly byteLength: number;
  readonly oversized: boolean;
};

export type EventLogVisitResult = {
  readonly exists: boolean;
  readonly generation?: string;
  readonly snapshotSize: number;
  readonly nextOffset: number;
  readonly nextLine: number;
  readonly scannedBytes: number;
  readonly scannedLines: number;
  readonly hasMore: boolean;
  readonly generationChanged: boolean;
  readonly cursorOutOfRange: boolean;
  readonly nextLineIncomplete: boolean;
};

export async function visitEventLogLines(input: {
  readonly path: string;
  readonly startLine?: number;
  readonly startOffset?: number;
  readonly expectedGeneration?: string;
  readonly discardPartialLine?: boolean;
  readonly maxBytes?: number;
  readonly maxLines?: number;
  readonly maxLineBytes?: number;
  readonly visit: (line: EventLogLineVisit) => boolean;
}): Promise<EventLogVisitResult> {
  let handle;
  try {
    handle = await open(input.path, "r");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return emptyVisitResult(false);
    throw error;
  }
  try {
    const file = await handle.stat({ bigint: true });
    const snapshotSize = safeNumber(file.size);
    const generation = eventLogGeneration(file);
    const generationChanged = input.expectedGeneration !== undefined &&
      input.expectedGeneration !== generation;
    const cursorOutOfRange = !generationChanged && (input.startOffset ?? 0) > snapshotSize;
    const requestedOffset = generationChanged || cursorOutOfRange
      ? 0
      : clampInteger(input.startOffset ?? 0, 0, snapshotSize);
    const requestedLine = generationChanged || cursorOutOfRange
      ? 0
      : clampInteger(input.startLine ?? 0, 0);
    if (requestedOffset >= snapshotSize) {
      return {
        exists: true, generation, snapshotSize, nextOffset: requestedOffset,
        nextLine: requestedLine, scannedBytes: 0, scannedLines: 0, hasMore: false,
        generationChanged, cursorOutOfRange, nextLineIncomplete: false,
      };
    }
    const stream = handle.createReadStream({
      autoClose: false,
      start: requestedOffset,
      end: snapshotSize - 1,
    });
    const maxBytes = positiveLimit(input.maxBytes);
    const maxLines = positiveLimit(input.maxLines);
    const maxLineBytes = positiveLimit(input.maxLineBytes);
    let fragments: Buffer[] = [];
    let retainedBytes = 0;
    let lineBytes = 0;
    let oversized = !generationChanged && !cursorOutOfRange &&
      input.discardPartialLine === true;
    let lineStartOffset = requestedOffset;
    let nextOffset = requestedOffset;
    let nextLine = requestedLine;
    let scannedBytes = 0;
    let scannedLines = 0;
    let stopped = false;
    let nextLineIncomplete = false;

    const consumeLine = (terminated: boolean): void => {
      const consumedBytes = lineBytes + (terminated ? 1 : 0);
      nextOffset = lineStartOffset + consumedBytes;
      scannedBytes += consumedBytes;
      scannedLines += 1;
      const line = oversized ? "" : Buffer.concat(fragments, retainedBytes).toString("utf8");
      const shouldStop = input.visit({
        line, lineNumber: nextLine, startOffset: lineStartOffset, nextOffset,
        byteLength: lineBytes, oversized,
      });
      nextLine += 1;
      lineStartOffset = nextOffset;
      fragments = [];
      retainedBytes = 0;
      lineBytes = 0;
      oversized = false;
      stopped = shouldStop ||
        (maxBytes !== undefined && scannedBytes >= maxBytes) ||
        (maxLines !== undefined && scannedLines >= maxLines);
    };

    try {
      chunks: for await (const rawChunk of stream) {
        const completeChunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
        const remainingBudget = maxBytes === undefined
          ? completeChunk.length
          : Math.max(0, maxBytes - scannedBytes - lineBytes);
        const chunk = completeChunk.subarray(0, remainingBudget);
        let start = 0;
        for (let newline = chunk.indexOf(0x0a, start); newline >= 0;
          newline = chunk.indexOf(0x0a, start)) {
          const part = chunk.subarray(start, newline);
          lineBytes += part.length;
          if (!oversized && maxLineBytes !== undefined && lineBytes > maxLineBytes) {
            oversized = true;
            fragments = [];
            retainedBytes = 0;
          } else if (!oversized && part.length > 0) {
            fragments.push(part);
            retainedBytes += part.length;
          }
          consumeLine(true);
          if (stopped) break chunks;
          start = newline + 1;
        }
        if (start < chunk.length) {
          const part = chunk.subarray(start);
          lineBytes += part.length;
          if (!oversized && maxLineBytes !== undefined && lineBytes > maxLineBytes) {
            oversized = true;
            fragments = [];
            retainedBytes = 0;
          } else if (!oversized) {
            fragments.push(part);
            retainedBytes += part.length;
          }
        }
        if (chunk.length < completeChunk.length ||
          (maxBytes !== undefined && scannedBytes + lineBytes >= maxBytes)) {
          if (lineStartOffset + lineBytes < snapshotSize) {
            if (oversized || (
              maxLineBytes !== undefined && lineBytes >= maxLineBytes &&
              lineStartOffset === requestedOffset && scannedBytes === 0
            )) {
              oversized = true;
              nextOffset = lineStartOffset + lineBytes;
              nextLineIncomplete = true;
            } else {
              nextOffset = lineStartOffset;
              nextLineIncomplete = false;
            }
            stopped = true;
            break;
          }
        }
      }
      if (!stopped && lineBytes > 0) consumeLine(false);
    } finally {
      stream.destroy();
    }
    return {
      exists: true, generation, snapshotSize, nextOffset, nextLine,
      scannedBytes: scannedBytes + lineBytes,
      scannedLines, hasMore: stopped && nextOffset < snapshotSize,
      generationChanged, cursorOutOfRange, nextLineIncomplete,
    };
  } finally {
    await handle.close();
  }
}

export async function eventLogNeedsSeparatorNewline(path: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
  try {
    const size = (await handle.stat()).size;
    if (size === 0) return false;
    const finalByte = Buffer.allocUnsafe(1);
    const { bytesRead } = await handle.read(finalByte, 0, 1, size - 1);
    return bytesRead === 1 && finalByte[0] !== 0x0a;
  } finally {
    await handle.close();
  }
}

export function eventLogGeneration(stats: {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
  readonly birthtimeNs?: bigint;
  readonly birthtimeMs?: number | bigint;
}): string {
  const born = stats.birthtimeNs ??
    (typeof stats.birthtimeMs === "bigint"
      ? stats.birthtimeMs * 1_000_000n
      : BigInt(Math.trunc((stats.birthtimeMs ?? 0) * 1_000_000)));
  return createHash("sha256")
    .update(`${String(stats.dev)}:${String(stats.ino)}:${String(born)}`)
    .digest("base64url");
}

function emptyVisitResult(exists: boolean): EventLogVisitResult {
  return {
    exists, snapshotSize: 0, nextOffset: 0, nextLine: 0,
    scannedBytes: 0, scannedLines: 0, hasMore: false, generationChanged: false,
    cursorOutOfRange: false, nextLineIncomplete: false,
  };
}

function positiveLimit(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function clampInteger(value: number, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  return Number.isSafeInteger(value) ? Math.min(maximum, Math.max(minimum, value)) : minimum;
}

function safeNumber(value: bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error("run_event_log_too_large");
  return result;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
