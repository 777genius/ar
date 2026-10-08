import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LocalEncryptedFileStore } from "../../store-local-file";
import { codexAuthJsonFromArtifact } from "../../provider-codex";
import { mergeWorkerAndAccountCapacity, WorkerAccountCapacitySignalScope,
  type WorkerCapacitySnapshot } from "../../worker-core";
import { FileBackendCodexWorker } from "../file-backend-codex-worker";
import { FileBackendCodexSeedWriteback } from "../file-backend-codex-seed-writeback";
import { codexAccountCapacityStore } from "../application/codex-account-capacity-store";
import { codexSessionCapacityAccountId } from "../codex-session-capacity-identity";
import { FakeAppServerFactory, waitUntil } from "./file-backend-codex-worker-test-support";

const now = new Date("2026-10-07T00:00:00Z");
function auth(identity: string, lastRefresh: string): string {
  return JSON.stringify({ auth_mode: "chatgpt", last_refresh: lastRefresh, tokens: {
    account_id: "NOT-AN-ACCOUNT-SYNTHETIC", access_token: "test-fixture-literal",
    refresh_token: `NOT-A-CREDENTIAL-${identity}`, expiry: "2035-01-01T00:00:00Z",
  } });
}
const s0 = auth("S0", "2026-10-06T23:00:00Z");
const r = auth("R", "2026-10-06T23:05:00Z");
const s1 = auth("S1", "2026-10-06T22:00:00Z");
const n = auth("N", "2026-10-06T23:10:00Z");
const sessionId = (bytes: string): string => {
  const id = codexSessionCapacityAccountId(JSON.parse(bytes));
  if (!id) throw new Error("synthetic_session_id_missing");
  return id;
};
const busy = { code: "subscription_worker_run_failed", details: { reason: "codex_session_binding_busy" } };

async function fixture(goal = false) {
  const root = await mkdtemp(join(tmpdir(), "synthetic-r5-reseeding-"));
  const authRoot = join(root, "auth");
  await mkdir(join(authRoot, "a"), { recursive: true });
  const source = join(authRoot, "a", "auth.json");
  await writeFile(source, s0, { mode: 0o600 });
  const journal = new FileBackendCodexSeedWriteback(source);
  expect(await journal.publishRefresh({ source: s0, expected: s0, next: r })).toBe(true);
  const settings: { holdTurnOpen: boolean; goalStatusesAfterTurns: string[]; emitTopLevelErrorOnTurn?: string } = {
    holdTurnOpen: !goal, goalStatusesAfterTurns: ["blocked", "complete"],
  };
  const fake = new FakeAppServerFactory(settings);
  let peer: ReturnType<FakeAppServerFactory["create"]> | undefined;
  let startedTurns = 0;
  const invalidations: WorkerCapacitySnapshot[] = [];
  const shared = codexAccountCapacityStore(authRoot);
  const worker = new FileBackendCodexWorker({
    providerInstanceId: "synthetic-r5", stateRootDir: join(root, "job"),
    codexBinaryPath: "/SYNTHETIC-NONEXISTENT-PROVIDER", encryptionKey: new Uint8Array(32).fill(31),
    model: "gpt-6.1-sol", reasoningEffort: "high", warmupPrompt: "Synthetic warmup",
    ...(goal ? { executionEngine: "app-server-goal" as const } : {}),
    sourceEnv: { SUBSCRIPTION_RUNTIME_MANAGED_LAUNCH: "1" },
    appServerProcessFactory: input => {
      peer = fake.create(input);
      peer.stdout.on("data", (line: string) => {
        const message = JSON.parse(line) as { method?: string };
        if (message.method === "turn/started") startedTurns += 1;
      });
      return peer;
    },
    clock: { now: () => now, monotonicMs: () => performance.now() },
    onSessionInvalid: capacity => {
      invalidations.push(capacity);
      shared.observe({ accountId: "a", capacity, observedAt: now });
    },
  });
  await worker.start();
  await worker.seedCodexAuthJsonFile(source);
  return {
    root, source, worker, fake, settings, journal, shared, invalidations,
    held: async () => { await waitUntil(() => startedTurns > 0); },
    peer: () => { if (!peer) throw new Error("synthetic_peer_missing"); return peer; },
    close: async () => { await worker.dispose(); await rm(root, { recursive: true, force: true }); },
  };
}

describe("quiescent same-worker Codex reseeding", () => {
  it.each(["submit", "stream", "prewarm", "resume"] as const)(
    "rejects public reseeding during %s and fences the old R/S0 failure", async lifecycle => {
      const f = await fixture(lifecycle === "resume");
      try {
        const deltas: string[] = [];
        let operation: Promise<unknown>;
        if (lifecycle === "resume") {
          const waiting = await f.worker.run({ runId: "r5-resume", prompt: "Synthetic waiting turn" });
          if (waiting.status !== "waiting_for_input") throw new Error("synthetic_waiting_required");
          f.settings.holdTurnOpen = true;
          operation = f.worker.resumeManagedRun({ runId: waiting.runId, requestId: waiting.request.id,
            answer: "Synthetic answer", resumeHandle: waiting.resumeHandle });
        } else {
          operation = lifecycle === "prewarm" ? f.worker.prewarm() : f.worker.run(
            { prompt: "Synthetic held turn" }, { onProviderTextDelta: delta => { deltas.push(delta); } });
        }
        // Attach rejection handling before releasing the fake response.
        const settled = operation.then(() => null, (error: unknown) => error);
        await waitUntil(() => f.fake.prompts.length === (lifecycle === "resume" ? 2 : 1));
        await f.held();
        expect(await readFile(join(f.fake.codexHomes[0]!, "auth.json"), "utf8") === r).toBe(true);
        if (lifecycle === "stream") {
          f.peer().stdout.emit("data", JSON.stringify({ method: "item/agentMessage/delta",
            params: { turnId: "turn-1", delta: "Synthetic partial output" } }) + "\n");
          await waitUntil(() => deltas.length === 1);
        }
        await writeFile(f.source, s1);
        // This is the reviewer gap: invoke the SAME worker's public reseeder.
        // On exact5746 it accepts S1 and the subsequent invalidation names S1.
        let reseedError: unknown = null;
        try { await f.worker.seedCodexAuthJsonFile(f.source); } catch (error) { reseedError = error; }
        if (lifecycle === "resume") {
          // Existing resume recovery retries inside the admitted binding. Its
          // fake response fails too; no new recovery policy is introduced.
          f.settings.holdTurnOpen = false;
          f.settings.emitTopLevelErrorOnTurn = "refresh_token_invalidated";
        }
        f.peer().stdout.emit("data", JSON.stringify({ method: "error", message: "refresh_token_invalidated" }) + "\n");
        expect(await settled).toBeInstanceOf(Error);
        expect(f.invalidations.map(value => value.details?.capacitySessionId)).toEqual([sessionId(r), sessionId(s0)]);
        expect(f.shared.read({ accountId: sessionId(r), now })?.reason).toBe("provider_session_invalid");
        expect(f.shared.read({ accountId: sessionId(s0), now })?.reason).toBe("provider_session_invalid");
        expect(f.shared.read({ accountId: sessionId(s1), now })).toBeNull();
        expect(f.shared.read({ accountId: "a", now })).toBeNull();
        expect(reseedError).toMatchObject(busy);
        // An independent owner login is accepted only after the old operation
        // and its failure/writeback cleanup have settled. It does not erase holds.
        await f.worker.seedCodexAuthJsonFile(f.source);
        expect(f.worker.capacity().details?.capacitySessionId).toBe(sessionId(s1));
        expect(f.shared.read({ accountId: sessionId(s0), now })?.reason).toBe("provider_session_invalid");
        expect(mergeWorkerAndAccountCapacity(f.worker.capacity(), f.shared.read({ accountId: "a", now }) ?? { availability: "available" }).availability)
          .toBe(lifecycle === "prewarm" ? "degraded" : "available");
      } finally { await f.close(); }
    });

  it("keeps S1 subject to the shared account quota after an old-session failure", async () => {
    const f = await fixture();
    try {
      f.shared.observe({ accountId: "a", scope: WorkerAccountCapacitySignalScope.AccountWide, observedAt: now,
        capacity: { availability: "quota_exhausted", reason: "quota_limited", cooldownUntil: new Date("2035-01-01") } });
      const operation = f.worker.run({ prompt: "Synthetic quota-preserving invalidation" }).catch((error: unknown) => error);
      await waitUntil(() => f.fake.prompts.length === 1);
      await writeFile(f.source, s1);
      await expect(f.worker.seedCodexAuthJsonFile(f.source)).rejects.toMatchObject(busy);
      f.peer().stdout.emit("data", JSON.stringify({ method: "error", message: "refresh_token_invalidated" }) + "\n");
      await operation;
      await f.worker.seedCodexAuthJsonFile(f.source);
      expect(f.shared.read({ accountId: sessionId(s1), now })).toBeNull();
      const boundary = mergeWorkerAndAccountCapacity(f.worker.capacity(), f.shared.read({ accountId: "a", now })!);
      expect(boundary).toMatchObject({ availability: "quota_exhausted", reason: "quota_limited" });
    } finally { await f.close(); }
  });

  it("attributes a held quota failure to the old binding before allowing a reseed", async () => {
    const f = await fixture();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const publish = FileBackendCodexSeedWriteback.prototype.publishRefresh;
    let exporting = false;
    const hook = vi.spyOn(FileBackendCodexSeedWriteback.prototype, "publishRefresh")
      .mockImplementationOnce(async function (this: FileBackendCodexSeedWriteback, input) {
        exporting = true; await held; return await publish.call(this, input);
      });
    try {
      const operation = f.worker.run({ prompt: "Synthetic held quota" }).catch((error: unknown) => error);
      await waitUntil(() => f.fake.prompts.length === 1);
      await writeFile(f.source, s1);
      await expect(f.worker.seedCodexAuthJson(s1)).rejects.toMatchObject(busy);
      f.peer().stdout.emit("data", JSON.stringify({ method: "error", message: "usage limit reached" }) + "\n");
      await waitUntil(() => exporting);
      const capacity = f.worker.capacity();
      expect(capacity.reason).toBe("quota_limited");
      expect(capacity.details?.capacitySessionId).toBe(sessionId(s0));
      f.shared.observe({ accountId: "a", scope: WorkerAccountCapacitySignalScope.AccountWide, capacity, observedAt: now });
      await expect(f.worker.seedCodexAuthJsonFile(f.source)).rejects.toMatchObject(busy);
      release(); await operation; hook.mockRestore();
      await f.worker.seedCodexAuthJsonFile(f.source);
      expect(f.worker.capacity().details?.capacitySessionId).toBe(sessionId(s1));
      expect(f.shared.read({ accountId: "a", now })?.reason).toBe("quota_limited");
    } finally { release(); hook.mockRestore(); await f.close(); }
  });

  it("keeps successful refresh out of changed authorization until the operation settles", async () => {
    const f = await fixture();
    try {
      const operation = f.worker.run({ prompt: "Synthetic successful rotation" });
      await waitUntil(() => f.fake.prompts.length === 1);
      await writeFile(f.source, s1);
      await expect(f.worker.seedCodexAuthJsonFile(f.source)).rejects.toMatchObject(busy);
      await writeFile(join(f.fake.codexHomes[0]!, "auth.json"), n);
      f.peer().completeHeldTurn();
      expect((await operation).outputText).toBe("OK");
      expect(await readFile(f.source, "utf8") === s1).toBe(true);
      expect(await f.journal.read(s1) === s1).toBe(true);
      expect(await f.journal.read(s0) === r).toBe(true);
      const local = await new LocalEncryptedFileStore({ providerId: "codex", rootDir: join(f.root, "job", "sessions"),
        encryptionKey: new Uint8Array(32).fill(31) }).read({ providerInstanceId: "synthetic-r5" });
      expect(local !== null && codexAuthJsonFromArtifact(local.artifact) === n).toBe(true);
      await f.worker.seedCodexAuthJsonFile(f.source);
      expect(f.worker.capacity().details?.capacitySessionId).toBe(sessionId(s1));
    } finally { await f.close(); }
  });

  it("keeps a waiting managed provider session bound through resume", async () => {
    const f = await fixture(true);
    try {
      const waiting = await f.worker.run({ runId: "r5-waiting", prompt: "Synthetic waiting turn" });
      if (waiting.status !== "waiting_for_input") throw new Error("synthetic_waiting_required");
      await writeFile(f.source, s1);
      await expect(f.worker.seedCodexAuthJsonFile(f.source)).rejects.toMatchObject(busy);
      await expect(f.worker.seedCodexAuthJson(s1)).rejects.toMatchObject(busy);
      await expect(f.worker.run({ prompt: "Synthetic overlapping import" })).rejects.toMatchObject(busy);
      expect((await f.worker.resumeManagedRun({ runId: waiting.runId, requestId: waiting.request.id,
        answer: "Synthetic answer", resumeHandle: waiting.resumeHandle })).outputText).toBe("OK");
      expect(await f.journal.read(s1) === s1).toBe(true);
      await f.worker.seedCodexAuthJsonFile(f.source);
      expect(f.worker.capacity().details?.capacitySessionId).toBe(sessionId(s1));
    } finally { await f.close(); }
  });

  it("reserves the binding before asynchronous seed IO and releases it after settlement", async () => {
    const f = await fixture();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const original = LocalEncryptedFileStore.prototype.read;
    const hook = vi.spyOn(LocalEncryptedFileStore.prototype, "read").mockImplementationOnce(async function (this: LocalEncryptedFileStore, input) {
      await held; return await original.call(this, input);
    });
    try {
      const seeding = f.worker.seedCodexAuthJsonFile(f.source);
      await expect(f.worker.run({ prompt: "Synthetic admission during seed" })).rejects.toMatchObject(busy);
      await expect(f.worker.prewarm()).rejects.toMatchObject(busy);
      await expect(f.worker.seedCodexAuthJson(s1)).rejects.toMatchObject(busy);
      release(); await seeding; hook.mockRestore();
      await f.worker.seedCodexAuthJsonFile(f.source);
    } finally { release(); hook.mockRestore(); await f.close(); }
  });

  it("reserves the binding before asynchronous operation import IO", async () => {
    const f = await fixture();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const original = LocalEncryptedFileStore.prototype.read;
    let importing = false;
    const hook = vi.spyOn(LocalEncryptedFileStore.prototype, "read").mockImplementationOnce(
      async function (this: LocalEncryptedFileStore, input) {
        importing = true; await held; return await original.call(this, input);
      });
    try {
      // Force an ordinary source metadata read before provider admission.
      await writeFile(f.source, s0 + "\n");
      const operation = f.worker.run({ prompt: "Synthetic admission IO" }).catch((error: unknown) => error);
      await waitUntil(() => importing);
      await expect(f.worker.seedCodexAuthJsonFile(f.source)).rejects.toMatchObject(busy);
      await expect(f.worker.seedCodexAuthJson(s1)).rejects.toMatchObject(busy);
      expect(f.fake.prompts).toHaveLength(0);
      release(); hook.mockRestore(); await f.held();
      f.peer().stdout.emit("data", JSON.stringify({ method: "error", message: "refresh_token_invalidated" }) + "\n");
      await operation;
      await writeFile(f.source, s1); await f.worker.seedCodexAuthJsonFile(f.source);
      expect(f.worker.capacity().details?.capacitySessionId).toBe(sessionId(s1));
    } finally { release(); hook.mockRestore(); await f.close(); }
  });

  it("adopts owner replacement at durable resume admission when the old provider is gone", async () => {
    const f = await fixture(true);
    const replacement = new FakeAppServerFactory();
    const recovered = new FileBackendCodexWorker({
      providerInstanceId: "synthetic-r5", stateRootDir: join(f.root, "job"),
      codexBinaryPath: "/SYNTHETIC-NONEXISTENT-PROVIDER", encryptionKey: new Uint8Array(32).fill(31),
      model: "gpt-6.1-sol", reasoningEffort: "high", executionEngine: "app-server-goal",
      sourceEnv: { SUBSCRIPTION_RUNTIME_MANAGED_LAUNCH: "1" }, appServerProcessFactory: replacement.create,
      clock: { now: () => now, monotonicMs: () => performance.now() },
    });
    try {
      const waiting = await f.worker.run({ runId: "r5-restart", prompt: "Synthetic waiting turn" });
      if (waiting.status !== "waiting_for_input") throw new Error("synthetic_waiting_required");
      await f.worker.dispose();
      await recovered.start(); await recovered.seedCodexAuthJsonFile(f.source);
      await writeFile(f.source, s1);
      expect((await recovered.resumeManagedRun({ runId: waiting.runId, requestId: waiting.request.id,
        answer: "Synthetic answer", resumeHandle: waiting.resumeHandle })).outputText).toBe("OK");
      expect(await readFile(join(replacement.codexHomes[0]!, "auth.json"), "utf8") === s1).toBe(true);
      expect(recovered.capacity().details?.capacitySessionId).toBe(sessionId(s1));
    } finally { await recovered.dispose(); await f.close(); }
  });
});
