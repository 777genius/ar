import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RunEventProjectionService, RunEventProviderKind, RunEventType,
  projectRunObservationEvents, runEventProjectionStateFromEvents,
  type RunObservationSnapshot,
} from "@vioxen/subscription-runtime/worker-core";
import { LocalFileRunEventProjectionStateStore, LocalFileRunEventStore } from "../local-run-event-store";
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function rootDir() { const root = await mkdtemp(join(tmpdir(), "projection-transaction-fake-")); roots.push(root); return root; }
function snapshot(dirty = false, unsafe = false): RunObservationSnapshot {
  return {
    runId: "fake-run", providerKind: RunEventProviderKind.Codex, observedAt: "2026-09-06T00:00:00Z",
    status: "running", liveness: "alive", warnings: [], process: { alive: true },
    workspace: { key: "/fake", dirty, changedFilesCount: dirty ? 1 : 0, changedFiles: dirty ? ["fake.txt"] : [] },
    readOnlyDecision: unsafe
      ? { kind: "unsafe_state_mismatch", reason: "fake_mismatch", safeMessage: "review" }
      : { kind: "keep_watching", reason: "worker_observable", safeMessage: "watch" },
  };
}
describe("durable run projection transactions", () => {
  it("preserves repeated workspace and unsafe cycles with retry-stable revisions", async () => {
    const root = await rootDir();
    const eventStore = new LocalFileRunEventStore({ rootDir: root });
    let previous;
    for (const flag of [false, true, false, true, false]) {
      const input = { snapshot: snapshot(flag, !flag), previousState: previous ?? null };
      const projection = projectRunObservationEvents(input);
      expect(projectRunObservationEvents(input).events).toEqual(projection.events);
      await eventStore.append(projection.events);
      expect((await eventStore.append(projection.events)).appendedCount).toBe(0);
      previous = projection.nextState;
    }
    const events = (await eventStore.read()).events;
    expect(events.filter((event) => event.type === RunEventType.WorkspaceChanged).map((event) => event.payload.dirty)).toEqual([false, true, false, true, false]);
    expect(events.filter((event) => event.type === RunEventType.UnsafeStateDetected)).toHaveLength(3);
    expect(runEventProjectionStateFromEvents(events)?.readModels.safety).toEqual(previous?.readModels.safety);
    expect(runEventProjectionStateFromEvents(events)?.revision).toBe(5);
  });
  it("recovers append-before-state failure with an existing state and changed runtime", async () => {
    const root = await rootDir();
    const eventStore = new LocalFileRunEventStore({ rootDir: root });
    const stateStore = new LocalFileRunEventProjectionStateStore({ rootDir: root });
    let current = snapshot();
    const service = new RunEventProjectionService({ providerKind: RunEventProviderKind.Codex, eventStore, stateStore, observationPort: { observeRun: async () => current } });
    await service.projectRun({ runId: "fake-run" });
    current = snapshot(true, true);
    vi.spyOn(stateStore, "writeProjectionState").mockRejectedValueOnce(new Error("fake_state_write_crash"));
    await expect(service.projectRun({ runId: "fake-run" })).rejects.toThrow("fake_state_write_crash");
    expect((await stateStore.readProjectionState("fake-run", { providerKind: RunEventProviderKind.Codex }))?.revision).toBe(1);
    expect(await stateStore.readPendingProjection("fake-run", { providerKind: RunEventProviderKind.Codex })).not.toBeNull();
    current = snapshot();
    // New objects simulate process restart, including independent local-store instances.
    const restarted = new RunEventProjectionService({ providerKind: RunEventProviderKind.Codex,
      eventStore: new LocalFileRunEventStore({ rootDir: root }),
      stateStore: new LocalFileRunEventProjectionStateStore({ rootDir: root }),
      observationPort: { observeRun: async () => current },
    });
    await restarted.projectRun({ runId: "fake-run" });
    expect(await stateStore.readPendingProjection("fake-run", { providerKind: RunEventProviderKind.Codex })).toBeNull();
    expect((await stateStore.readProjectionState("fake-run", { providerKind: RunEventProviderKind.Codex }))?.revision).toBe(3);
    const events = (await eventStore.read()).events;
    expect(events.filter((event) => event.type === RunEventType.WorkspaceChanged).map((event) => event.payload.dirty)).toEqual([false, true, false]);
    expect(new Set(events.map((event) => event.eventId)).size).toBe(events.length);
  });
  it("retries a partial append from the durable pending projection before observing", async () => {
    const root = await rootDir();
    const eventStore = new LocalFileRunEventStore({ rootDir: root });
    const stateStore = new LocalFileRunEventProjectionStateStore({ rootDir: root });
    const append = eventStore.append.bind(eventStore);
    vi.spyOn(eventStore, "append").mockImplementationOnce(async (events) => {
      await append(events.slice(0, 1)); throw new Error("fake_partial_append");
    });
    let observations = 0;
    const service = new RunEventProjectionService({ providerKind: RunEventProviderKind.Codex, eventStore, stateStore, observationPort: { observeRun: async () => { observations++; return snapshot(); } } });
    await expect(service.projectRun({ runId: "fake-run" })).rejects.toThrow("fake_partial_append");
    expect(await stateStore.readProjectionState("fake-run", { providerKind: RunEventProviderKind.Codex })).toBeNull();
    const pending = await stateStore.readPendingProjection("fake-run", { providerKind: RunEventProviderKind.Codex });
    expect(pending).not.toBeNull();
    const recovered = await service.projectRun({ runId: "fake-run" });
    expect(recovered.recoveryAppendResult).toMatchObject({ appendedCount: (pending?.events.length ?? 0) - 1, skippedDuplicateCount: 1 });
    expect(observations).toBe(2);
    expect((await eventStore.read()).events.map((event) => event.eventId)).toEqual(pending?.events.map((event) => event.eventId));
  });
  it("serializes independent service instances including observation", async () => {
    const root = await rootDir();
    let active = 0, peak = 0, index = 0;
    const flags = [false, true, false, true, false];
    const services = flags.map(() => new RunEventProjectionService({ providerKind: RunEventProviderKind.Codex,
      eventStore: new LocalFileRunEventStore({ rootDir: root }),
      stateStore: new LocalFileRunEventProjectionStateStore({ rootDir: root, lockPollMs: 1 }),
      observationPort: { observeRun: async () => {
        active++; peak = Math.max(peak, active);
        const flag = flags[index++] as boolean;
        await new Promise((resolve) => setTimeout(resolve, 2));
        active--; return snapshot(flag);
      } },
    }));
    await Promise.all(services.map((service) => service.projectRun({ runId: "fake-run" })));
    expect(peak).toBe(1);
    const events = (await new LocalFileRunEventStore({ rootDir: root }).read()).events;
    expect(events.filter((event) => event.type === RunEventType.WorkspaceChanged).map((event) => event.payload.dirty)).toEqual(flags);
    expect((await new LocalFileRunEventProjectionStateStore({ rootDir: root }).readProjectionState("fake-run", { providerKind: RunEventProviderKind.Codex }))?.revision).toBe(5);
  });
});
