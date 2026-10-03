import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  makeRunEvent,
  RunEventProviderKind,
  RunEventType,
} from "@vioxen/subscription-runtime/worker-core";
import {
  LocalFileRunEventDeliveryCursorStore,
  LocalFileRunEventStore,
} from "../index";
import {
  refreshRunEventDedupeCache,
} from "../run-events/adapters/local-run-event-dedupe-cache";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("LocalFileRunEventStore adversarial history hardening", () => {
  it("rewinds an ordinary line crossing the scan-byte boundary and returns it once", async () => {
    const { path, store } = await fixture();
    const first = event("byte-boundary-first", "a".repeat(250));
    const second = event("byte-boundary-second", "b".repeat(250));
    const lineBytes = [first, second].map((item) =>
      Buffer.byteLength(`${JSON.stringify(item)}\n`)
    );
    expect(lineBytes.every((bytes) => bytes < 1_000)).toBe(true);
    expect(lineBytes[0]! + lineBytes[1]!).toBeGreaterThan(1_000);
    await writeFile(path, `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`);

    const pageOne = await store.read({ maxScannedBytes: 1_000, maxLineBytes: 1_000 });
    expect(pageOne.events.map((item) => item.eventId)).toEqual([first.eventId]);
    expect(pageOne.warnings).toEqual([]);
    expect(pageOne.hasMore).toBe(true);
    expect(pageOne.nextCursor).toBeDefined();

    const pageTwo = await store.read({
      cursor: pageOne.nextCursor!,
      maxScannedBytes: 1_000,
      maxLineBytes: 1_000,
    });
    expect(pageTwo.events.map((item) => item.eventId)).toEqual([second.eventId]);
    expect(pageTwo.warnings).toEqual([]);
    expect(pageTwo.hasMore).toBe(false);
    expect(pageTwo.nextCursor?.value).not.toBe(pageOne.nextCursor?.value);
  });

  it("keeps legacy numeric cursors compatible with LF records and bare CR bytes", async () => {
    const { path, root, store } = await fixture();
    const first = event("first");
    const second = event("second");
    const third = event("third");
    const fourth = event("fourth");
    const contents = [
      `${JSON.stringify(first)}\r\n`,
      `${JSON.stringify(second)}\r${JSON.stringify(third)}\n`,
      `${JSON.stringify(fourth)}\n`,
    ].join("");
    await writeFile(path, contents);

    const fromOne = await store.read({ cursor: { value: "1" } });

    expect(fromOne.events.map((item) => item.eventId)).toEqual([fourth.eventId]);
    expect(fromOne.warnings).toEqual([
      expect.objectContaining({ code: "invalid_event_json", lineNumber: 2 }),
    ]);
    expect(decodeCursor(fromOne.nextCursor?.value)).toMatchObject({ l: 3 });

    const beyondEnd = await store.read({ cursor: { value: "99" } });
    expect(beyondEnd).toMatchObject({
      events: [],
      nextCursor: { value: "99" },
      warnings: [],
      hasMore: false,
      scanStopReason: "end_of_log",
    });
    const delivery = new LocalFileRunEventDeliveryCursorStore({ rootDir: root });
    await delivery.writeDeliveryCursor({
      consumerId: "future-numeric-consumer",
      cursor: beyondEnd.nextCursor!,
    });
    const compacted = await store.compact({ keepLatestEventsPerRun: 1 });
    expect(compacted).toMatchObject({
      compacted: false,
      cursorFloorLine: 0,
      removableLineCount: 0,
      blockedByCursorLineCount: 1,
    });
    expect(compacted.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "delivery_cursor_generation_changed" }),
    ]));
    expect((await store.read()).events.map((item) => item.eventId)).toEqual([
      first.eventId,
      fourth.eventId,
    ]);
  });

  it("resets a stale generation cursor after atomic replacement without losing new events", async () => {
    const { path, store } = await fixture();
    const oldFirst = event("old-first");
    const oldSecond = event("old-second");
    await store.append([oldFirst, oldSecond]);
    const firstPage = await store.read({ limit: 1 });
    const staleCursor = firstPage.nextCursor;
    expect(staleCursor).toBeDefined();
    const replacement = event("replacement");
    const replacementPath = `${path}.replacement`;
    await writeFile(replacementPath, `${JSON.stringify(replacement)}\n`);
    await rename(replacementPath, path);

    const resumed = await store.read({ cursor: staleCursor! });

    expect(resumed.events.map((item) => item.eventId)).toEqual([replacement.eventId]);
    expect(resumed.warnings).toEqual([
      expect.objectContaining({ code: "cursor_generation_changed" }),
    ]);
    expect(resumed.nextCursor?.value).not.toBe(staleCursor?.value);
  });

  it("treats a stale delivery generation as unread before preserve-mode compaction", async () => {
    const { path, root, store } = await fixture();
    const delivery = new LocalFileRunEventDeliveryCursorStore({ rootDir: root });
    await store.append([event("old-delivered-a"), event("old-delivered-b")]);
    const oldRead = await store.read();
    expect(oldRead.nextCursor).toBeDefined();
    await delivery.writeDeliveryCursor({
      consumerId: "stale-generation-consumer",
      cursor: oldRead.nextCursor!,
    });
    const replacement = [
      event("new-unread-a"),
      event("new-unread-b"),
      event("new-unread-c"),
    ];
    const replacementPath = `${path}.replacement`;
    await writeFile(
      replacementPath,
      `${replacement.map((item) => JSON.stringify(item)).join("\n")}\n`,
    );
    await rename(replacementPath, path);

    const compacted = await store.compact({ keepLatestEventsPerRun: 1 });

    expect(compacted).toMatchObject({
      compacted: false,
      cursorFloorLine: 0,
      removableLineCount: 0,
      blockedByCursorLineCount: 2,
      warnings: [expect.objectContaining({
        code: "delivery_cursor_generation_changed",
      })],
    });
    expect((await store.read()).events.map((item) => item.eventId)).toEqual(
      replacement.map((item) => item.eventId),
    );
  });

  it("resets both fields of an out-of-range v2 cursor and preserves later unread lines", async () => {
    const { root, store } = await fixture();
    const delivery = new LocalFileRunEventDeliveryCursorStore({ rootDir: root });
    const records = [event("range-a"), event("range-b"), event("range-c")];
    await store.append(records);
    const generationCursor = await store.read({ limit: 1 });
    const decoded = decodeCursor(generationCursor.nextCursor?.value);
    const forged = encodeCursor({
      ...decoded,
      o: Number.MAX_SAFE_INTEGER,
      l: 77,
    });

    const reset = await store.read({ cursor: { value: forged }, limit: 1 });

    expect(reset.events.map((item) => item.eventId)).toEqual([records[0]!.eventId]);
    expect(reset.warnings).toEqual([
      expect.objectContaining({ code: "cursor_offset_out_of_range" }),
    ]);
    expect(decodeCursor(reset.eventCursors?.[0]?.value)).toMatchObject({ l: 1 });
    expect(decodeCursor(reset.nextCursor?.value)).toMatchObject({ l: 1 });
    await delivery.writeDeliveryCursor({
      consumerId: "out-of-range-consumer",
      cursor: reset.nextCursor!,
    });

    const compacted = await store.compact({ keepLatestEventsPerRun: 1 });
    expect(compacted).toMatchObject({
      compacted: true,
      cursorFloorLine: 1,
      removableLineCount: 1,
      blockedByCursorLineCount: 1,
    });
    expect((await store.read()).events.map((item) => item.eventId)).toEqual([
      records[1]!.eventId,
      records[2]!.eventId,
    ]);
  });

  it("dedupes same-batch, restarted-store, and externally appended event ids", async () => {
    const { path, root, store } = await fixture();
    const duplicate = event("duplicate");
    await expect(store.append([duplicate, duplicate])).resolves.toMatchObject({
      appendedCount: 1,
      skippedDuplicateCount: 1,
    });

    const restarted = new LocalFileRunEventStore({ rootDir: root, eventLogPath: path });
    await expect(restarted.append([duplicate])).resolves.toMatchObject({
      appendedCount: 0,
      skippedDuplicateCount: 1,
    });

    const external = event("external");
    await appendFile(path, `${JSON.stringify(external)}\n`);
    await expect(store.append([external])).resolves.toMatchObject({
      appendedCount: 0,
      skippedDuplicateCount: 1,
    });
    await expect(store.read()).resolves.toMatchObject({
      events: [duplicate, external],
    });
  });

  it("invalidates dedupe state after truncation and compaction removes an id", async () => {
    const { path, root, store } = await fixture();
    const removedByTruncate = event("removed-by-truncate");
    const retained = event("retained");
    await store.append([removedByTruncate]);

    await writeFile(path, `${JSON.stringify(retained)}\n`);
    const restarted = new LocalFileRunEventStore({ rootDir: root, eventLogPath: path });
    await expect(restarted.append([removedByTruncate])).resolves.toMatchObject({
      appendedCount: 1,
      skippedDuplicateCount: 0,
    });

    await expect(store.compact({ keepLatestEventsPerRun: 1 })).resolves.toMatchObject({
      compacted: true,
      removableLineCount: 1,
    });
    await expect(store.append([retained])).resolves.toMatchObject({
      appendedCount: 1,
      skippedDuplicateCount: 0,
    });
    expect((await store.read()).events.map((item) => item.eventId)).toEqual([
      removedByTruncate.eventId,
      retained.eventId,
    ]);
  });

  it("does not poison dedupe state when the durable append fails", async () => {
    const { path, store } = await fixture();
    const existing = event("existing-before-failure");
    const retried = event("retry-after-failure");
    await store.append([existing]);
    await chmod(path, 0o400);

    await expect(store.append([retried])).rejects.toThrow();
    await chmod(path, 0o600);

    await expect(store.append([retried])).resolves.toMatchObject({
      appendedCount: 1,
      skippedDuplicateCount: 0,
    });
    expect((await store.read()).events.map((item) => item.eventId)).toEqual([
      existing.eventId,
      retried.eventId,
    ]);
  });

  it("rescans an unterminated cached prefix completed by an external writer", async () => {
    const { path, store } = await fixture();
    const completed = event("externally-completed");
    const serialized = JSON.stringify(completed);
    await writeFile(path, serialized.slice(0, -1));
    await refreshRunEventDedupeCache(path);

    await appendFile(path, `${serialized.slice(-1)}\n`);

    await expect(store.append([completed])).resolves.toMatchObject({
      appendedCount: 0,
      skippedDuplicateCount: 1,
    });
    expect((await store.read()).events.map((item) => item.eventId)).toEqual([
      completed.eventId,
    ]);
  });

  it("uses a v2 byte cursor to resume near EOF with only tail bytes scanned", async () => {
    const { path, store } = await fixture();
    const events = Array.from({ length: 1_000 }, (_, index) => event(`seek-${index}`));
    await writeFile(path, `${events.map((item) => JSON.stringify(item)).join("\n")}\n`);
    const prefix = await store.read({ limit: 999 });
    expect(prefix.nextCursor).toBeDefined();

    const tail = await store.read({ cursor: prefix.nextCursor!, limit: 1 });

    expect(tail.events.map((item) => item.eventId)).toEqual([events[999]!.eventId]);
    expect(tail.scannedLines).toBe(1);
    expect(tail.scannedBytes).toBe(Buffer.byteLength(JSON.stringify(events[999])) + 1);
    expect(tail.scannedBytes).toBeLessThan((await stat(path)).size / 100);
  });

  it("keeps the internal store read lossless when an event exceeds MCP budgets", async () => {
    const { store } = await fixture();
    const payload = `prefix-${"\\\"🚀".repeat(1_400_000)}-suffix`;
    const giant = event("giant", payload);
    await store.append([giant]);

    const read = await store.read();

    expect(read.events).toHaveLength(1);
    expect(read.events[0]?.eventId).toBe(giant.eventId);
    expect(read.events[0]?.payload).toEqual(giant.payload);
    expect(read.warnings).toEqual([]);
    expect(read.scanStopReason).toBe("end_of_log");
  });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "run-event-hardening-"));
  temporaryRoots.push(root);
  const path = join(root, "run-events", "events.ndjson");
  await mkdir(dirname(path), { recursive: true });
  return { root, path, store: new LocalFileRunEventStore({ rootDir: root, eventLogPath: path }) };
}

function event(id: string, detail = id) {
  return makeRunEvent({
    runId: "run-hardening",
    type: RunEventType.ProgressUpdated,
    occurredAt: "2026-09-05T00:00:00.000Z",
    source: { providerKind: RunEventProviderKind.Codex },
    payload: { id, detail },
    idempotencyParts: [id],
  });
}

function decodeCursor(value: string | undefined): Record<string, unknown> {
  expect(value).toMatch(/^v2\./);
  return JSON.parse(Buffer.from((value as string).slice(3), "base64url").toString("utf8"));
}

function encodeCursor(value: Record<string, unknown>): string {
  return `v2.${Buffer.from(JSON.stringify(value)).toString("base64url")}`;
}
