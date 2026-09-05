import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalFileRunEventStore } from "@vioxen/subscription-runtime/store-local-file";
import {
  RunEventProviderKind,
  RunEventType,
  makeRunEvent,
} from "@vioxen/subscription-runtime/worker-core";
import {
  projectAgentRunEvents,
  readAgentRunEvents,
} from "../codex-goal-mcp-run-events";
import { writeClaudeRunArtifacts } from "./codex-goal-mcp-test-support";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("bounded MCP run event output", () => {
  it("pages every filtered event once in order and stops after an empty page", async () => {
    const root = await temporaryRoot();
    const registryRootDir = join(root, "registry");
    const eventRootDir = join(root, "events");
    const store = new LocalFileRunEventStore({ rootDir: eventRootDir });
    const expected = Array.from({ length: 237 }, (_, index) =>
      event(`wanted-${index}`, "run-a", registryRootDir)
    );
    const interleaved = expected.flatMap((item, index) => [
      event(`foreign-${index}`, "run-b", registryRootDir),
      item,
    ]);
    await store.append(interleaved);

    const received: string[] = [];
    const pageSizes: number[] = [];
    let cursor: string | undefined;
    let lastCursor: string | undefined;
    do {
      const page = await readAgentRunEvents({
        registryRootDir,
        eventRootDir,
        jobId: "run-a",
        type: RunEventType.ProgressUpdated,
        ...(cursor === undefined ? {} : { cursor }),
      });
      expect(page.effectiveLimit).toBe(100);
      pageSizes.push(page.returnedEvents as number);
      received.push(...(page.events as readonly { eventId: string }[]).map((item) => item.eventId));
      lastCursor = page.nextCursor as string | undefined;
      cursor = page.hasMore === true ? lastCursor : undefined;
    } while (cursor !== undefined);

    expect(pageSizes).toEqual([100, 100, 37]);
    expect(received).toEqual(expected.map((item) => item.eventId));
    expect(new Set(received).size).toBe(expected.length);

    const empty = await readAgentRunEvents({
      registryRootDir,
      eventRootDir,
      jobId: "run-a",
      ...(lastCursor === undefined ? {} : { cursor: lastCursor }),
    });
    expect(empty).toMatchObject({ returnedEvents: 0, pageFull: false, hasMore: false });
  });

  it("caps an explicit MCP page without changing unbounded store replay", async () => {
    const root = await temporaryRoot();
    const registryRootDir = join(root, "registry");
    const eventRootDir = join(root, "events");
    const store = new LocalFileRunEventStore({ rootDir: eventRootDir });
    const events = Array.from({ length: 520 }, (_, index) =>
      event(`event-${index}`, "run-a", registryRootDir)
    );
    await store.append(events);

    const bounded = await readAgentRunEvents({
      registryRootDir,
      eventRootDir,
      limit: 5_000,
    });
    expect(bounded).toMatchObject({
      effectiveLimit: 500,
      returnedEvents: 500,
      pageFull: true,
      hasMore: true,
    });
    await expect(store.read()).resolves.toMatchObject({ events });
  });

  it("uses projection cursor and eventLimit independently from run limit", async () => {
    const root = await temporaryRoot();
    const registryRootDir = join(root, "registry");
    const eventRootDir = join(root, "events");
    const stateRootDir = join(root, "state");
    const runArtifactsRootDir = join(stateRootDir, "claude-run-artifacts");
    const workspacePath = join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    await writeClaudeRunArtifacts({
      rootDir: runArtifactsRootDir,
      runId: "run-a",
      providerInstanceId: "claude-test",
      workerId: "worker-test",
      configDir: join(root, "config"),
      workspacePath,
    });
    const store = new LocalFileRunEventStore({ rootDir: eventRootDir });
    const existing = Array.from({ length: 12 }, (_, index) =>
      event(`existing-${index}`, "run-a", registryRootDir, RunEventProviderKind.Claude)
    );
    await store.append(existing);

    const projected = await projectAgentRunEvents({
      providerKind: RunEventProviderKind.Claude,
      registryRootDir,
      stateRootDir,
      eventRootDir,
      jobId: "run-a",
      limit: 1,
      cursor: "4",
      eventLimit: 3,
    });

    expect(projected).toMatchObject({
      returnedRuns: 1,
      effectiveEventLimit: 3,
      returnedEvents: 3,
      nextCursor: "7",
      pageFull: true,
      hasMore: true,
    });
    expect((projected.events as readonly { eventId: string }[]).map((item) => item.eventId))
      .toEqual(existing.slice(4, 7).map((item) => item.eventId));
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mcp-run-events-"));
  temporaryRoots.push(root);
  return root;
}

function event(
  id: string,
  runId: string,
  registryRootDir: string,
  providerKind = RunEventProviderKind.Codex,
) {
  return makeRunEvent({
    runId,
    type: RunEventType.ProgressUpdated,
    occurredAt: "2026-09-05T00:00:00.000Z",
    source: { providerKind, registryRootDir },
    payload: { id },
    idempotencyParts: [id],
  });
}
