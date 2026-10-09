import { mkdtemp, mkdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { FileBackendCodexSeedWriteback } from "../file-backend-codex-seed-writeback";
import { FileBackendCodexWorker } from "../file-backend-codex-worker";
import { FakeAppServerFactory, codexAuthJsonAt, waitUntil } from "./file-backend-codex-worker-test-support";

const hooks = vi.hoisted(() => ({ beforePublication: null as (() => Promise<void>) | null }));
vi.mock("@vioxen/subscription-runtime/store-local-file", async importOriginal => {
  const original = await importOriginal<typeof import("@vioxen/subscription-runtime/store-local-file")>();
  class HookedStore extends original.LocalEncryptedFileStore {
    override async write(input: Parameters<import("@vioxen/subscription-runtime/store-local-file").LocalEncryptedFileStore["write"]>[0]) {
      const hook = hooks.beforePublication;
      hooks.beforePublication = null;
      await hook?.();
      return super.write(input);
    }
  }
  return { ...original, LocalEncryptedFileStore: HookedStore };
});

const seed = codexAuthJsonAt("synthetic-source", "2026-05-31T00:00:00.000Z");
const refreshed = codexAuthJsonAt("synthetic-provider-refresh", "2026-05-31T00:05:00.000Z");
const relogin = codexAuthJsonAt("synthetic-relogin", "2026-05-31T00:10:00.000Z");

describe("source-bound Codex refresh writeback", () => {
  it("retains normal provider refresh in custody and supplies it to an independent worker", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-refresh-writeback-"));
    const source = join(root, "auth.json");
    await writeFile(source, seed, { mode: 0o600 });
    const factories = [new FakeAppServerFactory({ holdTurnOpen: true }), new FakeAppServerFactory({ holdTurnOpen: true }), new FakeAppServerFactory()];
    const processes: ReturnType<FakeAppServerFactory["create"]>[] = [];
    const workers = factories.map((factory, index) => new FileBackendCodexWorker({
      providerInstanceId: `synthetic-worker-${index}`,
      stateRootDir: join(root, `job-${index}`),
      codexBinaryPath: "unused-fake-provider",
      encryptionKey: new Uint8Array(32).fill(index + 7),
      model: "gpt-6.1-sol", reasoningEffort: "high",
      sourceEnv: { SUBSCRIPTION_RUNTIME_MANAGED_LAUNCH: "1" },
      appServerProcessFactory: input => {
        const process = factory.create(input); processes.push(process); return process;
      },
      clock: { now: () => new Date("2026-05-31T00:05:00Z"), monotonicMs: () => performance.now() },
    }));
    try {
      await workers[0]!.start();
      await workers[0]!.seedCodexAuthJsonFile(source);
      await workers[1]!.start();
      await workers[1]!.seedCodexAuthJsonFile(source);
      const first = workers[0]!.run({ prompt: "Synthetic refresh task" });
      await waitUntil(() => factories[0]!.prompts.length === 1);
      // Fake provider refreshes its disposable session home, exercising the
      // real task-update CAS and the worker's final writeback path.
      await writeFile(join(factories[0]!.codexHomes[0]!, "auth.json"), refreshed);
      processes[0]!.completeHeldTurn();
      expect((await first).outputText).toBe("OK");
      expect(await readFile(source, "utf8") === seed).toBe(true);
      const custody = new FileBackendCodexSeedWriteback(source);
      expect(await custody.read(seed) === refreshed).toBe(true);
      const second = workers[1]!.run({ prompt: "Synthetic refreshed task" });
      await waitUntil(() => factories[1]!.prompts.length === 1);
      expect(await readFile(join(factories[1]!.codexHomes[0]!, "auth.json"), "utf8") === refreshed).toBe(true);
      processes[1]!.completeHeldTurn();
      expect((await second).outputText).toBe("OK");
      await workers[2]!.start();
      await workers[2]!.seedCodexAuthJsonFile(source);
      expect((await workers[2]!.run({ prompt: "Synthetic fresh job" })).outputText).toBe("OK");
      expect(await readFile(join(factories[2]!.codexHomes[0]!, "auth.json"), "utf8") === refreshed).toBe(true);
    } finally {
      await Promise.all(workers.map(worker => worker.dispose()));
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not bind a rejected older seed to a fresher local session", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-rejected-seed-writeback-"));
    const source = join(root, "auth.json");
    await writeFile(source, seed, { mode: 0o600 });
    const factory = new FakeAppServerFactory();
    const worker = new FileBackendCodexWorker({
      providerInstanceId: "synthetic-fresher-store", stateRootDir: join(root, "job"),
      codexBinaryPath: "unused-fake-provider", encryptionKey: new Uint8Array(32).fill(9),
      sourceEnv: { SUBSCRIPTION_RUNTIME_MANAGED_LAUNCH: "1" }, appServerProcessFactory: factory.create,
      clock: { now: () => new Date("2026-05-31T00:15:00Z"), monotonicMs: () => performance.now() },
    });
    try {
      await worker.start();
      await worker.seedCodexAuthJson(relogin);
      await worker.seedCodexAuthJsonFile(source);
      expect((await worker.run({ prompt: "Synthetic persisted session" })).outputText).toBe("OK");
      expect(await new FileBackendCodexSeedWriteback(source).read(seed) === seed).toBe(true);
      expect(await readFile(source, "utf8") === seed).toBe(true);
    } finally { await worker.dispose(); await rm(root, { recursive: true, force: true }); }
  });

  it("recognizes relogin with unchanged file timestamps after local invalidation", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-source-identity-"));
    const source = join(root, "auth.json");
    await writeFile(source, seed, { mode: 0o600 });
    const metadata = await stat(source);
    const factory = new FakeAppServerFactory({ emitTopLevelErrorsOnTurns: ["refresh_token_invalidated", null] });
    const worker = new FileBackendCodexWorker({
      providerInstanceId: "synthetic-source-identity", stateRootDir: join(root, "job"),
      codexBinaryPath: "unused-fake-provider", encryptionKey: new Uint8Array(32).fill(9),
      sourceEnv: { SUBSCRIPTION_RUNTIME_MANAGED_LAUNCH: "1" }, appServerProcessFactory: factory.create,
      clock: { now: () => new Date("2026-05-31T00:15:00Z"), monotonicMs: () => performance.now() },
    });
    try {
      await worker.start();
      await worker.seedCodexAuthJsonFile(source);
      await expect(worker.run({ prompt: "Synthetic invalid session" })).rejects.toMatchObject({
        details: { code: "provider_session_invalid" },
      });
      expect(worker.capacity()).toMatchObject({ availability: "disabled", reason: "provider_session_invalid" });
      await writeFile(source, relogin);
      await utimes(source, metadata.atime, metadata.mtime);
      expect(worker.capacity()).toMatchObject({ availability: "available", reason: "auth_reseed_pending" });
      expect((await worker.run({ prompt: "Synthetic authorized session" })).outputText).toBe("OK");
      expect(factory.prompts).toHaveLength(2);
    } finally { await worker.dispose(); await rm(root, { recursive: true, force: true }); }
  });

  it.each([false, true])("does not replace relogin at the publication boundary: atomic replacement=%s", async atomic => {
    const root = await mkdtemp(join(tmpdir(), "codex-export-source-race-"));
    try {
      const source = join(root, "auth.json");
      await writeFile(source, seed, { mode: 0o600 });
      const custody = new FileBackendCodexSeedWriteback(source);
      hooks.beforePublication = async () => {
        if (atomic) {
          const replacement = join(root, "new-login.json");
          await writeFile(replacement, relogin);
          await rename(replacement, source);
        } else {
          await writeFile(source, relogin);
        }
      };
      expect(await custody.publish({ source: seed, expected: seed, next: refreshed })).toBe(true);
      // A read-check-write on the login path would lose either replacement.
      // The stale publication is instead unreachable from the new seed.
      expect(await readFile(source, "utf8") === relogin).toBe(true);
      expect(await custody.read(relogin) === relogin).toBe(true);
      expect(await custody.publish({ source: seed, expected: refreshed, next: seed })).toBe(false);
    } finally {
      hooks.beforePublication = null;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects stale refresh publication and never steals a held writer lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-refresh-cas-"));
    try {
      const source = join(root, "auth.json");
      await writeFile(source, seed, { mode: 0o600 });
      const first = new FileBackendCodexSeedWriteback(source);
      const second = new FileBackendCodexSeedWriteback(source);
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      let reached!: () => void;
      const reachedBoundary = new Promise<void>(resolve => { reached = resolve; });
      hooks.beforePublication = async () => { reached(); await held; };
      const publishing = first.publish({ source: seed, expected: seed, next: refreshed });
      await reachedBoundary;
      try {
        expect(await second.publish({ source: seed, expected: seed, next: relogin })).toBe(false);
      } finally { release(); }
      expect(await publishing).toBe(true);
      expect(await second.publish({ source: seed, expected: seed, next: relogin })).toBe(false);
      expect(await second.read(seed) === refreshed).toBe(true);
      // Source remains the authority; the custody file is private like auth.json.
      const { readdir } = await import("node:fs/promises");
      const dir = join(root, ".subscription-runtime-auth-writeback");
      const files = await readdir(dir);
      expect(files).toHaveLength(1);
      const slot = join(dir, files[0]!);
      const records = await readdir(slot);
      expect(records).toHaveLength(1);
      const record = join(slot, records[0]!);
      expect((await stat(record)).mode & 0o777).toBe(0o600);
      const encrypted = await readFile(record, "utf8");
      expect(encrypted.includes("synthetic-provider-refresh")).toBe(false);
      expect(encrypted.includes("synthetic-source")).toBe(false);
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("fences two independent processes publishing from the same seeded generation", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-process-writeback-cas-"));
    try {
      await writeFile(join(root, "auth.json"), seed, { mode: 0o600 });
      const run = promisify(execFile);
      const children = ["first", "second"].map(id => run(process.execPath, [
        fileURLToPath(new URL("../../../node_modules/vitest/vitest.mjs", import.meta.url)),
        "run", fileURLToPath(import.meta.url), "-t", "publishes from an isolated writer process",
      ], { env: { ...process.env, SR_SYNTHETIC_WRITEBACK_ROOT: root, SR_SYNTHETIC_WRITER: id }, timeout: 30_000 }));
      // Attach rejection handlers immediately while waiting for both barriers.
      const done = Promise.allSettled(children);
      await waitUntil(async () => {
        await readFile(join(root, "ready-first")); await readFile(join(root, "ready-second")); return true;
      }, 20_000);
      await writeFile(join(root, "go"), "synthetic barrier");
      expect((await done).map(result => result.status)).toEqual(["fulfilled", "fulfilled"]);
      const accepted = await Promise.all(["first", "second"].map(id => readFile(join(root, `result-${id}`), "utf8")));
      expect(accepted.filter(value => value === "true")).toHaveLength(1);
      const custody = new FileBackendCodexSeedWriteback(join(root, "auth.json"));
      const latest = await custody.read(seed);
      expect([refreshed, relogin].some(bytes => bytes === latest)).toBe(true);
      expect(await readFile(join(root, "auth.json"), "utf8") === seed).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

// Invoked only with a NEW disposable fixture by the parent test.
it.runIf(Boolean(process.env.SR_SYNTHETIC_WRITEBACK_ROOT))("publishes from an isolated writer process", async () => {
  const root = process.env.SR_SYNTHETIC_WRITEBACK_ROOT!;
  const id = process.env.SR_SYNTHETIC_WRITER!;
  if (!["first", "second"].includes(id)) throw new Error("invalid_synthetic_writer");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, `ready-${id}`), "synthetic ready");
  await waitUntil(async () => { await readFile(join(root, "go")); return true; }, 20_000);
  const custody = new FileBackendCodexSeedWriteback(join(root, "auth.json"));
  const accepted = await custody.publish({ source: seed, expected: seed, next: id === "first" ? refreshed : relogin });
  await writeFile(join(root, `result-${id}`), String(accepted));
});
