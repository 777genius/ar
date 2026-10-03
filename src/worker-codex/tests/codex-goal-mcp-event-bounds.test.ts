import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  makeRunEvent,
  RunEventProviderKind,
  RunEventType,
  type RunEvent,
} from "@vioxen/subscription-runtime/worker-core";
import { mcpJson } from "../codex-goal-mcp-response";
import { boundedRunEventResponse } from "../codex-goal-mcp-run-event-response";
import {
  compactAgentRunEvents,
  planAgentRunEventCompaction,
  readAgentRunEvents,
  readAgentRunState,
} from "../codex-goal-mcp-run-events";

const MCP_ENVELOPE_MAX_BYTES = 64 * 1024;
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Codex goal MCP event history bounds", () => {
  it("bounds deeply nested projected-run metadata without changing small responses", () => {
    const small = boundedRunEventResponse({
      base: {
        ok: true,
        mode: "project_events",
        projectedRuns: [{
          status: "stopped",
          readModels: { liveness: { status: "dead" } },
        }],
      },
      read: { events: [], warnings: [], hasMore: false, eventCursors: [] },
      effectiveLimit: 100,
    });
    expect(small.projectedRuns).toEqual([expect.objectContaining({
      status: "stopped",
      readModels: { liveness: { status: "dead" } },
    })]);

    const response = boundedRunEventResponse({
      base: {
        ok: true,
        mode: "project_events",
        projectedRuns: Array.from({ length: 50 }, () => ({
          readModels: nestedMetadata(10),
        })),
      },
      read: {
        events: [],
        warnings: [],
        hasMore: false,
        eventCursors: [],
      },
      effectiveLimit: 100,
    });

    expect(envelopeBytes(response)).toBeLessThanOrEqual(MCP_ENVELOPE_MAX_BYTES);
  });

  it("bounds warning floods for compaction planning, execution, and state replay", async () => {
    const fixture = await eventLogFixture();
    const replayable = makeRunEvent({
      runId: "run-warning-state",
      type: RunEventType.Completed,
      occurredAt: "2026-09-05T00:00:00.000Z",
      source: { providerKind: RunEventProviderKind.Codex, registryRootDir: fixture.registryRootDir },
      payload: { status: "completed" },
      idempotencyParts: ["warning-state"],
    });
    await writeFile(fixture.path, [
      ...Array.from({ length: 10_000 }, (_, index) => `{corrupt-${index}`),
      JSON.stringify(replayable),
      "",
    ].join("\n"));

    const planResponse = await planAgentRunEventCompaction({
      registryRootDir: fixture.registryRootDir,
      eventRootDir: fixture.root,
    });
    expect(envelopeBytes(planResponse)).toBeLessThanOrEqual(MCP_ENVELOPE_MAX_BYTES);
    expect(planResponse).toMatchObject({
      ok: false,
      mode: "compaction_plan",
      sideEffects: [],
      plan: {
        totalLineCount: 10_001,
        validEventCount: 1,
        invalidLineCount: 10_000,
        retainedLineCount: 10_001,
        removableLineCount: 0,
        totalWarningCount: 10_000,
        warningsTruncated: true,
        warningCounts: { invalid_event_json: 10_000 },
      },
    });

    const compactResponse = await compactAgentRunEvents({
      registryRootDir: fixture.registryRootDir,
      eventRootDir: fixture.root,
      confirmCompact: true,
    });
    expect(envelopeBytes(compactResponse)).toBeLessThanOrEqual(MCP_ENVELOPE_MAX_BYTES);
    expect(compactResponse).toMatchObject({
      ok: false,
      mode: "compact_events",
      sideEffects: ["rewrite_run_event_log", "rewrite_delivery_cursors"],
      result: {
        compacted: false,
        invalidLineCount: 10_000,
        retainedLineCount: 10_001,
        removableLineCount: 0,
        totalWarningCount: 10_000,
        warningsTruncated: true,
      },
    });

    const stateResponse = await readAgentRunState({
      registryRootDir: fixture.registryRootDir,
      eventRootDir: fixture.root,
      jobId: replayable.runId,
    });
    expect(envelopeBytes(stateResponse)).toBeLessThanOrEqual(MCP_ENVELOPE_MAX_BYTES);
    expect(stateResponse).toMatchObject({
      ok: false,
      mode: "read_only_state",
      sideEffects: [],
      runId: replayable.runId,
      replayOnly: true,
      totalWarningCount: 10_000,
      warningsTruncated: true,
      warningCounts: { invalid_event_json: 10_000 },
    });
    expect((stateResponse.warnings as readonly unknown[]).length).toBeLessThanOrEqual(20);
  });

  it("aggregates 10,000 corrupt lines and advances to each valid event exactly once", async () => {
    const fixture = await eventLogFixture();
    const valid = Array.from({ length: 101 }, (_, index) => event(`valid-${index}`));
    await writeFile(fixture.path, [
      ...Array.from({ length: 10_000 }, (_, index) => `{corrupt-${index}`),
      ...valid.map((item) => JSON.stringify(item)),
      "",
    ].join("\n"));

    const received: string[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let firstPage: Readonly<Record<string, unknown>> | undefined;
    for (let pageNumber = 0; pageNumber < 5; pageNumber += 1) {
      const page = await readAgentRunEvents({
        registryRootDir: fixture.registryRootDir,
        eventRootDir: fixture.root,
        limit: 100,
        ...(cursor === undefined ? {} : { cursor }),
      });
      firstPage ??= page;
      expect(envelopeBytes(page)).toBeLessThanOrEqual(MCP_ENVELOPE_MAX_BYTES);
      received.push(...eventIds(page));
      const nextCursor = page.nextCursor as string | undefined;
      if (page.hasMore !== true) break;
      expect(nextCursor).toBeTruthy();
      expect(nextCursor).not.toBe(cursor);
      expect(cursors.has(nextCursor as string)).toBe(false);
      cursors.add(nextCursor as string);
      cursor = nextCursor;
    }

    expect(firstPage).toMatchObject({
      returnedEvents: 0,
      totalWarningCount: 10_000,
      warningsTruncated: true,
      warningCounts: { invalid_event_json: 10_000 },
      scanStopReason: "scan_limit",
      hasMore: true,
    });
    expect((firstPage?.warnings as readonly unknown[]).length).toBeLessThanOrEqual(50);
    expect(received).toEqual(valid.map((item) => item.eventId));
  });

  it("makes progress when a raw event fits the event cap but escaping exceeds the MCP envelope", async () => {
    const fixture = await eventLogFixture();
    const escaping = eventWithPayload("escaping", Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [
        `escaped${index}`,
        `edge-${"\"\\🚀".repeat(500)}`,
      ]),
    ));
    const rawBytes = Buffer.byteLength(JSON.stringify(escaping));
    expect(rawBytes).toBeGreaterThan(30 * 1024);
    expect(rawBytes).toBeLessThan(48 * 1024);
    await writeFile(fixture.path, `${JSON.stringify(escaping)}\n`);

    const page = await readAgentRunEvents({
      registryRootDir: fixture.registryRootDir,
      eventRootDir: fixture.root,
      limit: 100,
    });

    expect(envelopeBytes(page)).toBeLessThanOrEqual(MCP_ENVELOPE_MAX_BYTES);
    expect(page.nextCursor).toEqual(expect.stringMatching(/^v2\./));
    expect(page.nextCursor).not.toBe(undefined);
    expect([
      ...eventIds(page),
      ...omittedEventIds(page),
    ]).toEqual([escaping.eventId]);
  });

  it("returns a bounded hashed omission for a giant valid payload", async () => {
    const fixture = await eventLogFixture();
    const giant = eventWithPayload("giant-valid", Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [
        `chunk${index}`,
        `start-${"\"\\🚀".repeat(500)}-end`,
      ]),
    ));
    await writeFile(fixture.path, `${JSON.stringify(giant)}\n`);

    const page = await readAgentRunEvents({
      registryRootDir: fixture.registryRootDir,
      eventRootDir: fixture.root,
    });

    expect(envelopeBytes(page)).toBeLessThanOrEqual(MCP_ENVELOPE_MAX_BYTES);
    expect(page).toMatchObject({
      returnedEvents: 0,
      omittedEventCount: 1,
      hasMore: false,
      scanStopReason: "end_of_log",
      omittedEvents: [{
        eventId: giant.eventId,
        omission: {
          reason: "mcp_event_payload_too_large",
          byteLength: expect.any(Number),
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      }],
    });
  });

  it("bounds a giant corrupt UTF-8 line without LF and finishes from its partial cursor", async () => {
    const fixture = await eventLogFixture();
    const corrupt = Buffer.from(`{\"broken\":\"${"🚀".repeat(1_300_000)}`);
    expect(corrupt.byteLength).toBeGreaterThan(4 * 1024 * 1024);
    await writeFile(fixture.path, corrupt);

    const first = await readAgentRunEvents({
      registryRootDir: fixture.registryRootDir,
      eventRootDir: fixture.root,
    });
    expect(envelopeBytes(first)).toBeLessThanOrEqual(MCP_ENVELOPE_MAX_BYTES);
    expect(first).toMatchObject({
      returnedEvents: 0,
      hasMore: true,
      scanStopReason: "scan_limit",
      scannedBytes: 4 * 1024 * 1024,
    });

    const second = await readAgentRunEvents({
      registryRootDir: fixture.registryRootDir,
      eventRootDir: fixture.root,
      cursor: first.nextCursor as string,
    });
    expect(envelopeBytes(second)).toBeLessThanOrEqual(MCP_ENVELOPE_MAX_BYTES);
    expect(second).toMatchObject({
      returnedEvents: 0,
      hasMore: false,
      scanStopReason: "end_of_log",
      totalWarningCount: 1,
      warningCounts: { event_line_too_large: 1 },
    });
    expect(second.nextCursor).not.toBe(first.nextCursor);
  });

  it("bounds omission metadata even when event header fields are adversarially large", async () => {
    const fixture = await eventLogFixture();
    const base = event("giant-header");
    const giantHeader: RunEvent = {
      ...base,
      correlationId: `correlation-${"\"\\".repeat(40_000)}`,
      source: {
        ...base.source,
        hostId: `host-${"h".repeat(80_000)}`,
      },
    };
    await writeFile(fixture.path, `${JSON.stringify(giantHeader)}\n`);

    const page = await readAgentRunEvents({
      registryRootDir: fixture.registryRootDir,
      eventRootDir: fixture.root,
    });

    expect(envelopeBytes(page)).toBeLessThanOrEqual(MCP_ENVELOPE_MAX_BYTES);
    expect(omittedEventIds(page)).toEqual([giantHeader.eventId]);
    expect(page).toMatchObject({
      omittedEvents: [{
        omission: {
          reason: "mcp_event_payload_too_large",
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      }],
    });
  });
});

async function eventLogFixture() {
  const root = await mkdtemp(join(tmpdir(), "mcp-event-bounds-"));
  temporaryRoots.push(root);
  const path = join(root, "run-events", "events.ndjson");
  await mkdir(dirname(path), { recursive: true });
  return { root, path, registryRootDir: join(root, "registry") };
}

function event(id: string, detail = id) {
  return makeRunEvent({
    runId: "run-bounds",
    type: RunEventType.ProgressUpdated,
    occurredAt: "2026-09-05T00:00:00.000Z",
    source: { providerKind: RunEventProviderKind.Codex },
    payload: { id, detail },
    idempotencyParts: [id],
  });
}

function eventWithPayload(id: string, payload: Record<string, string>): RunEvent {
  return {
    ...event(id),
    payload: { id, ...payload },
  };
}

function envelopeBytes(page: Readonly<Record<string, unknown>>): number {
  return Buffer.byteLength(JSON.stringify(mcpJson(page)));
}

function eventIds(page: Readonly<Record<string, unknown>>): string[] {
  return ((page.events ?? []) as readonly { readonly eventId: string }[])
    .map((item) => item.eventId);
}

function omittedEventIds(page: Readonly<Record<string, unknown>>): string[] {
  return ((page.omittedEvents ?? []) as readonly { readonly eventId: string }[])
    .map((item) => item.eventId);
}

function nestedMetadata(depth: number): unknown {
  if (depth === 0) return { status: "alive" };
  const child = nestedMetadata(depth - 1);
  return Object.fromEntries(Array.from({ length: 10 }, (_, index) => [
      `branch-${index}`,
      child,
    ]));
}
