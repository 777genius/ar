import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { LocalFileRunEventStore } from "../index";
import {
  makeRunEvent,
  RunEventProviderKind,
  RunEventType,
} from "@vioxen/subscription-runtime/worker-core";

describe("LocalFileRunEventStore streaming reads", () => {
  it("reads a small page from a large event log and stops at the limit", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "run-event-store-"));
    const path = join(rootDir, "run-events", "events.ndjson");
    const store = new LocalFileRunEventStore({ rootDir, eventLogPath: path });
    const first = event("run-a", RunEventType.ProgressUpdated, "🚀".repeat(40_000));
    const tail = Array.from({ length: 10_000 }, (_, index) =>
      JSON.stringify(
        event("run-tail", RunEventType.ProgressUpdated, `tail-${index}`),
      )
    );
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      [JSON.stringify(first), "{unread-corrupt", ...tail, ""].join("\n"),
    );

    const read = await store.read({ limit: 1 });

    expect(read.events.map((item) => item.eventId)).toEqual([first.eventId]);
    expectCursorLine(read.nextCursor?.value, 1);
    expect(read.warnings).toEqual([]);
  });

  it("preserves numeric cursor, line warnings, filters, and utf8 content", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "run-event-store-"));
    const path = join(rootDir, "run-events", "events.ndjson");
    const store = new LocalFileRunEventStore({ rootDir, eventLogPath: path });
    const skipped = event("run-a", RunEventType.ProgressUpdated, "пропущено");
    const foreign = event("run-other", RunEventType.ProgressUpdated, "чужой");
    const matching = event("run-a", RunEventType.Completed, "готово-🚀");
    const later = event("run-a", RunEventType.ResultUpdated, "позже");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, [
      JSON.stringify(skipped),
      "",
      JSON.stringify(foreign),
      "{broken\rstillbroken}",
      JSON.stringify(matching),
      JSON.stringify(later),
      "",
    ].join("\n"));

    const page = await store.read({
      cursor: { value: "1" },
      runId: "run-a",
      types: [RunEventType.Completed],
      limit: 1,
    });

    expect(page.events.map((item) => item.eventId)).toEqual([matching.eventId]);
    expectCursorLine(page.nextCursor?.value, 5);
    expect(page.warnings).toEqual([
      expect.objectContaining({ code: "invalid_event_json", lineNumber: 4 }),
    ]);
    const beyondEnd = await store.read({ cursor: { value: "99" } });
    expect(beyondEnd).toMatchObject({
      events: [],
      warnings: [],
      nextCursor: { value: "99" },
    });
  });

  it("adds one separator when appending to an unterminated log", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "run-event-store-"));
    const path = join(rootDir, "run-events", "events.ndjson");
    const store = new LocalFileRunEventStore({ rootDir, eventLogPath: path });
    const first = event("run-a", RunEventType.ProgressUpdated, "first");
    const second = event("run-a", RunEventType.Completed, "second");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(first));

    await store.append([second]);

    expect(await readFile(path, "utf8")).toBe(
      `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`,
    );

    const emptyPath = join(rootDir, "empty", "events.ndjson");
    await mkdir(dirname(emptyPath), { recursive: true });
    await writeFile(emptyPath, "");
    await new LocalFileRunEventStore({ rootDir, eventLogPath: emptyPath }).append([
      first,
    ]);
    expect(await readFile(emptyPath, "utf8")).toBe(`${JSON.stringify(first)}\n`);

    await writeFile(emptyPath, "\n");
    await expect(
      new LocalFileRunEventStore({ rootDir, eventLogPath: emptyPath }).read(),
    ).resolves.toMatchObject({ nextCursor: { value: expect.stringMatching(/^v2\./) } });
  });
});

function event(runId: string, type: RunEventType, idempotencyPart: string) {
  return makeRunEvent({
    runId,
    type,
    occurredAt: "2026-07-02T00:00:00.000Z",
    source: { providerKind: RunEventProviderKind.Codex },
    payload: { idempotencyPart },
    idempotencyParts: [idempotencyPart],
  });
}

function expectCursorLine(value: string | undefined, line: number): void {
  expect(value).toMatch(/^v2\./);
  const parsed = JSON.parse(Buffer.from((value as string).slice(3), "base64url").toString("utf8"));
  expect(parsed.l).toBe(line);
}
