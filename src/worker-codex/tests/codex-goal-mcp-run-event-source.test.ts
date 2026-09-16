import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunEventProjectionService, RunEventProviderKind, type RunEventSource, type RunObservationSnapshot } from "@vioxen/subscription-runtime/worker-core";
import { LocalFileRunEventStore, LocalFileRunEventProjectionStateStore } from "@vioxen/subscription-runtime/store-local-file";
import { readAgentRunState } from "../codex-goal-mcp-run-events";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mcp-source-fake-")); roots.push(root);
  return { root, events: new LocalFileRunEventStore({ rootDir: root }), states: new LocalFileRunEventProjectionStateStore({ rootDir: root }) };
}
const codex = { providerKind: RunEventProviderKind.Codex, registryRootDir: "/fake/registry-a" };
const claude = { ...codex, providerKind: RunEventProviderKind.Claude };
function service(f: Awaited<ReturnType<typeof fixture>>, source: RunEventSource) {
  return new RunEventProjectionService({ eventStore: f.events, stateStore: f.states, ...source,
    observationPort: { observeRun: async (): Promise<RunObservationSnapshot> => ({
      runId: "same-id", providerKind: source.providerKind, observedAt: "2026-09-06T00:00:00Z",
      status: "running", liveness: "alive", warnings: [],
      readOnlyDecision: { kind: "keep_watching", reason: "worker_observable", safeMessage: "watch" },
    }) } });
}
describe("MCP scoped event state", () => {
  it("reads MCP state by registry and provider, treating host as metadata", async () => {
    const f = await fixture();
    await service(f, { ...claude, hostId: "fake-host" }).projectRun({ runId: "same-id" });
    const args = { eventRootDir: f.root, registryRootDir: claude.registryRootDir, jobId: "same-id" };
    expect(await readAgentRunState(args)).toMatchObject({ ok: true, providerKind: RunEventProviderKind.Claude });
    await service(f, codex).projectRun({ runId: "same-id" });
    expect(await readAgentRunState(args)).toMatchObject({ ok: false, reason: "run_event_state_source_ambiguous" });
    expect(await readAgentRunState({ ...args, providerKind: "claude" })).toMatchObject({ ok: true, providerKind: RunEventProviderKind.Claude });
    await rm(join(f.root, "run-event-projection-state"), { recursive: true });
    expect(await readAgentRunState({ ...args, providerKind: "claude" })).toMatchObject({ ok: true, replayOnly: true, providerKind: RunEventProviderKind.Claude });
  });
});
