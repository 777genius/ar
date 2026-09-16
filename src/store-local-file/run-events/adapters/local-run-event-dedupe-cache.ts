import { open, stat } from "node:fs/promises";

import { parseRunEvent } from "@vioxen/subscription-runtime/worker-core";
import { eventLogGeneration, visitEventLogLines } from "./local-run-event-log-reader";

type CacheEntry = {
  readonly generation: string;
  readonly indexedSize: number;
  readonly mtimeNs: bigint;
  readonly anchor: string;
  readonly terminated: boolean;
  readonly eventIds: Set<string>;
};

const cache = new Map<string, CacheEntry>();
const maxPaths = 32;

export async function refreshRunEventDedupeCache(path: string): Promise<Set<string>> {
  let file;
  try {
    file = await stat(path, { bigint: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      cache.delete(path);
      return new Set<string>();
    }
    throw error;
  }
  const generation = eventLogGeneration(file);
  const size = safeFileSize(file.size);
  const cached = cache.get(path);
  const reusable = cached && cached.terminated && cached.generation === generation &&
    size >= cached.indexedSize &&
    (size !== cached.indexedSize || file.mtimeNs === cached.mtimeNs) &&
    await readAnchor(path, cached.indexedSize) === cached.anchor;
  const eventIds = reusable ? cached.eventIds : new Set<string>();
  const startOffset = reusable ? cached.indexedSize : 0;
  if (size > startOffset) {
    await visitEventLogLines({
      path,
      startOffset,
      visit: ({ line }) => {
        if (!line.trim()) return false;
        try {
          const event = parseRunEvent(JSON.parse(line));
          if (event) eventIds.add(event.eventId);
        } catch {
          // Invalid durable lines do not contribute an idempotency key.
        }
        return false;
      },
    });
  }
  const anchor = await readAnchor(path, size);
  setCache(path, {
    generation,
    indexedSize: size,
    mtimeNs: file.mtimeNs,
    anchor,
    terminated: size === 0 || Buffer.from(anchor, "base64").at(-1) === 0x0a,
    eventIds,
  });
  return eventIds;
}

export async function updateRunEventDedupeCache(
  path: string,
  eventIds: Set<string>,
): Promise<void> {
  const file = await stat(path, { bigint: true });
  const size = safeFileSize(file.size);
  const anchor = await readAnchor(path, size);
  setCache(path, {
    generation: eventLogGeneration(file),
    indexedSize: size,
    mtimeNs: file.mtimeNs,
    anchor,
    terminated: size === 0 || Buffer.from(anchor, "base64").at(-1) === 0x0a,
    eventIds,
  });
}

export function clearRunEventDedupeCache(path: string): void {
  cache.delete(path);
}

function setCache(path: string, entry: CacheEntry): void {
  cache.delete(path);
  cache.set(path, entry);
  while (cache.size > maxPaths) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

async function readAnchor(path: string, endOffset: number): Promise<string> {
  if (endOffset <= 0) return "";
  const length = Math.min(128, endOffset);
  const buffer = Buffer.allocUnsafe(length);
  const handle = await open(path, "r");
  try {
    const read = await handle.read(buffer, 0, length, endOffset - length);
    return buffer.subarray(0, read.bytesRead).toString("base64");
  } finally {
    await handle.close();
  }
}

function safeFileSize(value: bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error("run_event_log_too_large");
  return result;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
