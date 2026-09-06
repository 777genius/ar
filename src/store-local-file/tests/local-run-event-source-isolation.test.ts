import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RunEventProjectionService, RunEventProviderKind, RunEventType,
  projectRunObservationEvents, runEventProjectionStateFromEvents,
  type RunEventSource, type RunObservationSnapshot,
} from "@vioxen/subscription-runtime/worker-core";
import { LocalFileRunEventProjectionStateStore, LocalFileRunEventStore } from "../local-run-event-store";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "source-isolation-fake-")); roots.push(root);
  const events = new LocalFileRunEventStore({ rootDir: root });
  const states = new LocalFileRunEventProjectionStateStore({ rootDir: root, lockPollMs: 1 });
  return { root, events, states };
}
const codex = { providerKind: RunEventProviderKind.Codex, registryRootDir: "/fake/registry-a" };
const claude = { ...codex, providerKind: RunEventProviderKind.Claude };
const other = { ...codex, registryRootDir: "/fake/registry-b" };
function snapshot(source: RunEventSource = codex, dirty = false): RunObservationSnapshot {
  return { runId: "same-id", providerKind: source.providerKind, observedAt: "2026-09-06T00:00:00Z",
    status: "running", liveness: "alive", warnings: [], process: { alive: true },
    workspace: { dirty, changedFilesCount: dirty ? 1 : 0, changedFiles: dirty ? ["fake.txt"] : [] },
    readOnlyDecision: { kind: "keep_watching", reason: "worker_observable", safeMessage: "watch" },
  };
}
function service(f: Awaited<ReturnType<typeof fixture>>, source: RunEventSource, observe = async () => snapshot(source)) {
  return new RunEventProjectionService({ eventStore: f.events, stateStore: f.states, ...source,
    observationPort: { observeRun: observe } });
}
function legacyProjection(source = codex, dirty = false) {
  const projection = projectRunObservationEvents({ snapshot: snapshot(source, dirty), ...source });
  const { source: _source, ...nextState } = projection.nextState;
  return { ...projection, nextState };
}

describe("source scoped projection and recovery", () => {
  it("isolates providers and registries in a shared outbox, including cold replay", async () => {
    const f = await fixture();
    for (const source of [codex, claude, other]) {
      const projected = await service(f, source).projectRun({ runId: "same-id" });
      expect(projected.events.filter(event => event.type === RunEventType.ObservationRecorded)).toHaveLength(1);
      expect((await f.states.readProjectionState("same-id", source))?.revision).toBe(1);
    }
    await rm(join(f.root, "run-event-projection-state"), { recursive: true });
    for (const source of [codex, claude, other]) {
      const projected = await service(f, source).projectRun({ runId: "same-id" });
      expect(projected.nextState.revision).toBe(2);
      expect(projected.events).toHaveLength(0);
    }
    const mixed = (await f.events.read()).events;
    expect(() => runEventProjectionStateFromEvents(mixed)).toThrow("run_event_replay_source_mismatch");
  });

  it("uses independent source locks while serializing each source", async () => {
    const f = await fixture();
    let active = 0, peak = 0;
    await Promise.all([codex, claude, other].map(source => service(f, source, async () => {
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 25));
      active--; return snapshot(source);
    }).projectRun({ runId: "same-id" })));
    expect(peak).toBe(3);
  });

  it("keeps foreign pending intact and recovers only the owning source", async () => {
    const f = await fixture();
    vi.spyOn(f.events, "append").mockRejectedValueOnce(new Error("fake_append_crash"));
    await expect(service(f, codex).projectRun({ runId: "same-id" })).rejects.toThrow("fake_append_crash");
    await service(f, other).projectRun({ runId: "same-id" });
    expect(await f.states.readPendingProjection("same-id", codex)).not.toBeNull();
    await service(f, codex).projectRun({ runId: "same-id" });
    expect(await f.states.readPendingProjection("same-id", codex)).toBeNull();
    expect((await f.events.read()).events.filter(event => event.type === RunEventType.ObservationRecorded)).toHaveLength(2);
  });

  it.each([false, true])("migrates proven legacy WAL, including copy-before-retire crash=%s", async copied => {
    const f = await fixture();
    const legacy = legacyProjection();
    await f.states.writePendingProjection(legacy);
    if (copied) await f.states.writePendingProjection({ ...legacy, nextState: { ...legacy.nextState, source: codex } });
    await service(f, other).projectRun({ runId: "same-id" });
    expect(await f.states.readPendingProjection("same-id")).not.toBeNull();
    await service(f, codex, async () => snapshot(codex, true)).projectRun({ runId: "same-id" });
    expect(await f.states.readPendingProjection("same-id")).toBeNull();
    await service(f, codex).projectRun({ runId: "same-id" });
    const own = (await f.events.read({ sourceRegistryRootDir: codex.registryRootDir })).events;
    expect(own.filter(event => event.type === RunEventType.WorkspaceChanged).map(event => event.payload.dirty)).toEqual([false, true, false]);
    expect((await f.states.readProjectionState("same-id", codex))?.revision).toBe(3);
  });

  it.each([true, false])("rebuilds legacy state from a complete source baseline, versioned=%s", async versioned => {
    const f = await fixture();
    const legacy = legacyProjection();
    await f.states.writeProjectionState(legacy.nextState);
    await f.events.append(legacy.events.map(event => {
      if (versioned) return event;
      const { projectionRevision: _revision, ...payload } = event.payload;
      return { ...event, payload };
    }));
    const result = await service(f, codex, async () => snapshot(codex, true)).projectRun({ runId: "same-id" });
    expect(result.events.some(event => event.type === RunEventType.WorkspaceChanged && event.payload.dirty === true)).toBe(true);
    expect(await f.states.readProjectionState("same-id", codex)).not.toBeNull();
  });

  it("refuses ambiguous legacy state and empty legacy WAL without deleting either", async () => {
    const f = await fixture();
    const legacy = legacyProjection();
    await f.states.writeProjectionState(legacy.nextState);
    await expect(service(f, other).projectRun({ runId: "same-id" })).rejects.toThrow("scope_ambiguous");
    await f.states.writePendingProjection({ nextState: legacy.nextState, events: [] });
    await expect(service(f, codex).projectRun({ runId: "same-id" })).rejects.toThrow("scope_ambiguous");
    expect(await f.states.readProjectionState("same-id")).not.toBeNull();
    expect(await f.states.readPendingProjection("same-id")).not.toBeNull();
  });

  it("rejects a scoped WAL carrying foreign events before append", async () => {
    const f = await fixture();
    const own = projectRunObservationEvents({ snapshot: snapshot(), ...codex });
    await f.states.writePendingProjection({ ...own, events: legacyProjection(other).events });
    await expect(service(f, codex).projectRun({ runId: "same-id" })).rejects.toThrow("invalid_pending");
    expect((await f.events.read()).events).toHaveLength(0);
  });

  it("retains a latest-event floor for each source during compaction", async () => {
    const f = await fixture();
    for (const source of [codex, claude, other]) await service(f, source).projectRun({ runId: "same-id" });
    await f.events.compact({ keepLatestEventsPerRun: 1 });
    expect((await f.events.read()).events).toHaveLength(3);
  });

  it("preserves unscoped readers only when the source is unique", async () => {
    const f = await fixture();
    await service(f, codex).projectRun({ runId: "same-id" });
    expect((await f.states.readProjectionState("same-id"))?.source).toMatchObject(codex);
    await service(f, other).projectRun({ runId: "same-id" });
    await expect(f.states.readProjectionState("same-id")).rejects.toThrow("source_ambiguous");
  });

});

describe("lifecycle replay", () => {
  it("replays alive -> completed/dead -> alive and stale -> alive with cleared flags", async () => {
    const f = await fixture();
    const snapshots: RunObservationSnapshot[] = [snapshot(),
      { ...snapshot(), status: "completed", liveness: "dead", process: { alive: false } },
      { ...snapshot(), liveness: "stale", progress: { stale: true, silentStale: true, heartbeatOnlyNoOutput: true } },
      snapshot(),
    ];
    for (const current of snapshots) {
      const projected = await service(f, codex, async () => current).projectRun({ runId: "same-id" });
      const replayed = runEventProjectionStateFromEvents((await f.events.read()).events);
      expect(replayed?.readModels.liveness).toEqual(projected.nextState.readModels.liveness);
      expect(replayed?.status).toBe(projected.nextState.status);
    }
    const last = await service(f, codex).projectRun({ runId: "same-id" });
    expect(last.events).toHaveLength(0);
  });

  it("does not emit lifecycle events solely because heartbeat age increased", () => {
    const first = projectRunObservationEvents({ snapshot: { ...snapshot(), progress: { heartbeatAgeMs: 1 } }, ...codex });
    const next = projectRunObservationEvents({ snapshot: { ...snapshot(), progress: { heartbeatAgeMs: 2 } }, previousState: first.nextState, ...codex });
    expect(next.events).toHaveLength(0);
  });
});
