import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { WorkerAccountCapacityClaimStatus, WorkerAccountCapacityRecheckMode,
  WorkerAccountCapacityResolutionType, WorkerAccountCapacitySignalScope, WorkerAccountCapacityResolveStatus,
  InMemoryWorkerAccountCapacityStore } from "../../worker-core";
import { LocalFileWorkerAccountCapacityStore } from "../../store-local-file";
import { codexAccountCapacityRootDir, codexAccountCapacityStore } from "../application/codex-account-capacity-store";
import { selectProjectControllerCodexAccountSlot } from "../application/project-control/codex-goal-project-controller-account-selection";
import { buildCodexGoalExecutorOptions } from "../codex-goal-runner";
import { listCodexGoalAccountStatuses } from "../codex-goal-account-status";
import { FileBackendCodexSafeExecutor } from "../file-backend-codex-safe-executor";
import { recordProjectControllerCapacitySignal } from "../project-controller-capacity";
import { FakeAppServerFactory, StaticRunner, waitUntil } from "./file-backend-codex-worker-test-support";

const now = new Date("2026-10-06T19:00:00Z");
const demand = { provider: "codex", model: "gpt-6.1-sol", reasoningEffort: "high" };

describe("confirmed invalid session admission", () => {
  it("persists a real normalized provider failure across goal jobs and excludes it from controller selection", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-invalid-session-jobs-"));
    try {
      await writeSeed(root, "account-i", "identity-i", "synthetic-revoked-seed");
      await writeSeed(root, "account-u", "identity-u", "synthetic-healthy-seed");
      const invalid = new FakeAppServerFactory({ emitTopLevelErrorOnTurn: "refresh_token_invalidated: refresh token was revoked" });
      const first = await executor(root, "job-first", ["account-i"], [invalid]);
      try {
        const result = await first.run({ taskId: "first", prompt: "Synthetic task" });
        expect(["blocked", "waiting_capacity"]).toContain(result.status);
        if (result.status === "completed") throw new Error("expected invalid session failure");
        expect(result.attempts[0]?.failureDetails).toMatchObject({ code: "provider_session_invalid" });
        expect(invalid.prompts).toHaveLength(1);
      } finally { await first.dispose(); }

      const shared = codexAccountCapacityStore(join(root, "auth"));
      expect(shared.read({ accountId: "account-i", demand: { provider: "codex", model: "other-model" }, now: new Date("2030-01-01") }))
        .toMatchObject({ availability: "disabled", reason: "provider_session_invalid" });
      const slots = await listCodexGoalAccountStatuses({ authRootDir: join(root, "auth"), liveCheck: false });
      expect(slots.find(slot => slot.name === "account-i")).toMatchObject({
        schedulerEligible: false, availability: "reconnect_required", recommendedAction: "relogin",
        capacityReason: "provider_session_invalid",
      });
      expect(selectProjectControllerCodexAccountSlot({ slots })?.name).toBe("account-u");
      await promisify(execFile)(process.execPath, [
        fileURLToPath(new URL("../../../node_modules/vitest/vitest.mjs", import.meta.url)),
        "run", fileURLToPath(new URL("./provider-session-invalid-process.test.ts", import.meta.url)),
      ], { env: { ...process.env, SR_SYNTHETIC_SESSION_ROOT: root }, timeout: 30_000 });

      const forbidden = new FakeAppServerFactory();
      const healthy = new FakeAppServerFactory();
      const second = await executor(root, "job-second", ["account-i", "account-u"], [forbidden, healthy]);
      try {
        expect((await second.run({ taskId: "second", prompt: "Next synthetic task" })).status).toBe("completed");
        expect(forbidden.spawnCount).toBe(0);
        expect(healthy.prompts).toHaveLength(1);
      } finally { await second.dispose(); }
      const persisted = await readTree(codexAccountCapacityRootDir(join(root, "auth")));
      expect(persisted).not.toContain("synthetic-revoked-seed");
      expect(persisted).not.toContain("synthetic-access");
      expect(persisted).not.toContain("identity-i");
      await writeSeed(root, "account-i", "identity-i", "new-authorized-session");
      const recovered = new FakeAppServerFactory();
      const third = await executor(root, "job-recovered", ["account-i"], [recovered]);
      try {
        expect((await third.run({ taskId: "recovered", prompt: "Synthetic recovery task" })).status).toBe("completed");
        expect(recovered.prompts).toHaveLength(1);
      } finally { await third.dispose(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("falls back to a different eligible account without repeating the invalid session", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-invalid-session-fallback-"));
    try {
      await writeSeed(root, "account-i", "identity-i", "revoked");
      await writeSeed(root, "account-u", "identity-u", "healthy");
      const invalid = new FakeAppServerFactory({ emitTopLevelErrorOnTurn: "refresh_token_invalidated" });
      const healthy = new FakeAppServerFactory();
      const run = await executor(root, "fallback", ["account-i", "account-u"], [invalid, healthy]);
      try {
        const result = await run.run({ taskId: "fallback", prompt: "Synthetic task" });
        expect(result.status, JSON.stringify(result)).toBe("completed");
        expect(invalid.prompts).toHaveLength(1);
        expect(healthy.prompts).toHaveLength(1);
      } finally { await run.dispose(); }
      expect(codexAccountCapacityStore(join(root, "auth")).read({ accountId: "account-i", now }))
        .toMatchObject({ reason: "provider_session_invalid" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("persists confirmed invalidation during prewarm before failed-worker disposal", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-invalid-session-prewarm-"));
    try {
      await writeSeed(root, "account-i", "identity-i", "revoked");
      const fake = new FakeAppServerFactory({ emitTopLevelErrorOnTurn: "refresh_token_invalidated" });
      const run = await executor(root, "prewarm", ["account-i"], [fake], true);
      try { await expect(run.prewarm()).rejects.toThrow(); }
      finally { await run.dispose(); }
      expect(fake.prompts).toHaveLength(1);
      expect(codexAccountCapacityStore(join(root, "auth")).read({ accountId: "account-i", now }))
        .toMatchObject({ availability: "disabled", reason: "provider_session_invalid" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("blocks unchanged seeds across aliases, recovers on changed session, and preserves account quota", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-invalid-session-seeds-"));
    try {
      await writeSeed(root, "account-i", "same-identity", "revoked");
      await writeSeed(root, "account-copy", "same-identity", "revoked");
      await writeSeed(root, "account-other-session", "same-identity", "healthy");
      await writeSeed(root, "account-other-identity", "other-identity", "revoked");
      const store = codexAccountCapacityStore(join(root, "auth"));
      store.observe({ accountId: "account-i", demand, observedAt: now,
        capacity: { availability: "disabled", reason: "provider_session_invalid",
          details: { capacitySessionId: "synthetic-untrusted-secret" } } });
      expect(await readTree(codexAccountCapacityRootDir(join(root, "auth")))).not.toContain("synthetic-untrusted-secret");
      expect(codexAccountCapacityStore(join(root, "auth")).read({ accountId: "account-copy", now }))
        .toMatchObject({ reason: "provider_session_invalid" });
      expect(store.read({ accountId: "account-other-session", now })).toBeNull();
      expect(store.read({ accountId: "account-other-identity", now })).toBeNull();
      // File rewrites, metadata changes and access-token renewal do not authorize
      // reuse of the same revoked refresh session.
      await writeSeed(root, "account-i", "same-identity", "revoked", "changed-access", "2026-10-06");
      expect(codexAccountCapacityStore(join(root, "auth")).read({ accountId: "account-i", now: new Date("2030-01-01") }))
        .toMatchObject({ reason: "provider_session_invalid" });
      await writeSeed(root, "account-i", "same-identity", "new-authorized-session");
      expect(codexAccountCapacityStore(join(root, "auth")).read({ accountId: "account-i", now })).toBeNull();
      expect(store.read({ accountId: "account-copy", now })).toMatchObject({ reason: "provider_session_invalid" });
      store.observe({ accountId: "account-i", scope: WorkerAccountCapacitySignalScope.AccountWide, observedAt: now,
        capacity: { availability: "quota_exhausted", reason: "quota_limited", cooldownUntil: new Date("2026-10-07") } });
      await writeSeed(root, "account-i", "same-identity", "another-authorized-session");
      expect(store.read({ accountId: "account-i", now })).toMatchObject({ reason: "quota_limited" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("does not let a successful quota recheck clear a later invalid-session signal", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-invalid-session-cas-"));
    try {
      await writeSeed(root, "account-i", "identity-i", "revoked");
      const store = codexAccountCapacityStore(join(root, "auth"));
      store.observe({ accountId: "account-i", scope: WorkerAccountCapacitySignalScope.AccountWide, observedAt: now,
        capacity: { availability: "cooldown", reason: "quota_limited", cooldownUntil: new Date(now.getTime() + 1) } });
      const dueAt = new Date(now.getTime() + 2);
      const state = store.readState({ accountId: "account-i", now: dueAt })!;
      const claim = store.tryClaimRecheck({ state, ownerId: "quota-observer", now: dueAt, ttlMs: 60_000, mode: WorkerAccountCapacityRecheckMode.DueOnly });
      expect(claim.status).toBe(WorkerAccountCapacityClaimStatus.Claimed);
      store.observe({ accountId: "account-i", observedAt: dueAt,
        capacity: { availability: "disabled", reason: "provider_session_invalid" } });
      if (claim.status !== WorkerAccountCapacityClaimStatus.Claimed) throw new Error("expected quota claim");
      store.resolveRecheck({ claim: claim.claim, observedAt: dueAt,
        resolution: { type: WorkerAccountCapacityResolutionType.Available } });
      const restarted = codexAccountCapacityStore(join(root, "auth"));
      const blocked = restarted.readState({ accountId: "account-i", now: new Date("2030-01-01") })!;
      expect(blocked.capacity).toMatchObject({ availability: "disabled", reason: "provider_session_invalid" });
      expect(restarted.tryClaimRecheck({ state: blocked, ownerId: "quota-observer", now: dueAt, ttlMs: 60_000, mode: WorkerAccountCapacityRecheckMode.Refresh }).status)
        .toBe(WorkerAccountCapacityClaimStatus.NotDue);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([false, true])("rejects stale resolution and quota claims after session invalidation at the store contract: memory=%s", async memory => {
    const root = await mkdtemp(join(tmpdir(), "codex-invalid-session-store-cas-"));
    try {
      const store = memory ? new InMemoryWorkerAccountCapacityStore() : new LocalFileWorkerAccountCapacityStore({ rootDir: root });
      store.observe({ accountId: "synthetic-session", observedAt: now, scope: WorkerAccountCapacitySignalScope.AccountWide,
        capacity: { availability: "cooldown", reason: "quota_limited", cooldownUntil: new Date(now.getTime() + 1) } });
      const dueAt = new Date(now.getTime() + 2);
      const claim = store.tryClaimRecheck({ state: store.readState({ accountId: "synthetic-session", now: dueAt })!,
        ownerId: "synthetic-observer", now: dueAt, ttlMs: 60_000, mode: WorkerAccountCapacityRecheckMode.DueOnly });
      if (claim.status !== WorkerAccountCapacityClaimStatus.Claimed) throw new Error("expected quota claim");
      store.observe({ accountId: "synthetic-session", observedAt: dueAt, scope: WorkerAccountCapacitySignalScope.AccountWide,
        capacity: { availability: "disabled", reason: "provider_session_invalid" } });
      const resolution = store.resolveRecheck({ claim: claim.claim, observedAt: dueAt,
        resolution: { type: WorkerAccountCapacityResolutionType.Available } });
      expect([WorkerAccountCapacityResolveStatus.Conflict, WorkerAccountCapacityResolveStatus.StaleClaim]).toContain(resolution.status);
      const state = store.readState({ accountId: "synthetic-session", now: new Date("2030-01-01") })!;
      expect(state.capacity).toMatchObject({ availability: "disabled", reason: "provider_session_invalid" });
      expect(store.tryClaimRecheck({ state, ownerId: "synthetic-observer", now: dueAt, ttlMs: 60_000,
        mode: WorkerAccountCapacityRecheckMode.Refresh }).status).toBe(WorkerAccountCapacityClaimStatus.NotDue);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("records controller invalid sessions for every model without a cooldown release", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-invalid-controller-"));
    try {
      await writeSeed(root, "account-i", "identity-i", "revoked");
      expect(recordProjectControllerCapacitySignal({ authRootDir: join(root, "auth"), controllerJobId: "synthetic-controller",
        config: demand, observedAt: now,
        run: { status: "failed", safeMessage: "Codex session is invalid.", capacityAccountId: "account-i" } })).toBe(true);
      expect(codexAccountCapacityStore(join(root, "auth")).read({ accountId: "account-i", demand: { provider: "codex", model: "other-model" }, now: new Date("2030-01-01") }))
        .toMatchObject({ availability: "disabled", reason: "provider_session_invalid" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("reconciles a controller failure against its captured session after seed rotation", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-invalid-controller-rotation-"));
    try {
      await writeSeed(root, "account-i", "identity-i", "old-session");
      await writeSeed(root, "account-copy", "identity-i", "old-session");
      const store = codexAccountCapacityStore(join(root, "auth"));
      const previous = store.observe({ accountId: "account-i", observedAt: now,
        capacity: { availability: "disabled", reason: "provider_session_invalid" } })!;
      await writeSeed(root, "account-i", "identity-i", "new-session");
      expect(recordProjectControllerCapacitySignal({ authRootDir: join(root, "auth"), controllerJobId: "synthetic-controller",
        config: demand, observedAt: now, run: { status: "failed", safeMessage: "Codex session is invalid.",
          capacityAccountId: "account-i", capacitySessionId: previous.accountId } })).toBe(true);
      expect(store.read({ accountId: "account-i", now })).toBeNull();
      expect(store.read({ accountId: "account-copy", now })).toMatchObject({ reason: "provider_session_invalid" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("binds a late failure to the old session without overwriting an authorized replacement seed", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-invalid-session-rotation-race-"));
    try {
      await writeSeed(root, "account-i", "identity-i", "old-session");
      await writeSeed(root, "account-copy", "identity-i", "old-session");
      const fake = new FakeAppServerFactory({ holdTurnOpen: true });
      let process: ReturnType<FakeAppServerFactory["create"]> | undefined;
      // Replace only the executor port, retaining the real worker, failure
      // normalization, shared file store and scheduler admission.
      const boundFactory = { create: (input: Parameters<FakeAppServerFactory["create"]>[0]) => {
        process = fake.create(input); return process;
      } };
      const run = await executor(root, "rotation-race", ["account-i"], [boundFactory]);
      try {
        const result = run.run({ taskId: "race", prompt: "Synthetic held task", maxAccountCycles: 1 });
        await waitUntil(() => fake.prompts.length === 1);
        await writeSeed(root, "account-i", "identity-i", "authorized-replacement");
        process!.stdout.emit("data", `${JSON.stringify({ method: "error", message: "refresh_token_invalidated" })}\n`);
        await result;
        const store = codexAccountCapacityStore(join(root, "auth"));
        expect(store.read({ accountId: "account-copy", now })).toMatchObject({ reason: "provider_session_invalid" });
        expect(store.read({ accountId: "account-i", now })).toBeNull();
        expect(await readFile(join(root, "auth", "account-i", "auth.json"), "utf8")).toContain("authorized-replacement");
      } finally { await run.dispose(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("keeps relogin after a successful stale parallel worker exports its old session", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-successful-stale-session-"));
    try {
      await writeSeed(root, "account-i", "identity-i", "old-session");
      await writeSeed(root, "account-copy", "identity-i", "old-session");
      const factories = [new FakeAppServerFactory({ holdTurnOpen: true }), new FakeAppServerFactory({ holdTurnOpen: true })];
      const processes: ReturnType<FakeAppServerFactory["create"]>[] = [];
      const bound = factories.map(factory => ({ create: (input: Parameters<FakeAppServerFactory["create"]>[0]) => {
        const process = factory.create(input); processes.push(process); return process;
      } }));
      const first = await executor(root, "invalid-parallel", ["account-i"], [bound[0]!]);
      const second = await executor(root, "successful-parallel", ["account-i"], [bound[1]!]);
      try {
        const failing = first.run({ taskId: "invalid", prompt: "Synthetic failing task", maxAccountCycles: 1 });
        await waitUntil(() => factories[0]!.prompts.length === 1);
        const succeeding = second.run({ taskId: "successful", prompt: "Synthetic held task", maxAccountCycles: 1 });
        await waitUntil(() => factories[1]!.prompts.length === 1);
        processes[0]!.stdout.emit("data", `${JSON.stringify({ method: "error", message: "refresh_token_invalidated" })}\n`);
        expect((await failing).status).not.toBe("completed");
        const store = codexAccountCapacityStore(join(root, "auth"));
        expect(store.read({ accountId: "account-i", demand: { provider: "codex", model: "other-model" }, now }))
          .toMatchObject({ availability: "disabled", reason: "provider_session_invalid" });
        await writeSeed(root, "account-i", "identity-i", "authorized-replacement");
        const source = join(root, "auth", "account-i", "auth.json");
        const replacement = await readFile(source, "utf8");
        processes[1]!.completeHeldTurn();
        expect((await succeeding).status).toBe("completed");
        // Compare bytes without printing synthetic credentials on failure.
        expect((await readFile(source, "utf8")) === replacement).toBe(true);
        expect(store.read({ accountId: "account-i", now })).toBeNull();
        expect(store.read({ accountId: "account-copy", now })).toMatchObject({ reason: "provider_session_invalid" });
        const recovered = new FakeAppServerFactory();
        const third = await executor(root, "after-stale-success", ["account-i"], [recovered]);
        try {
          expect((await third.run({ taskId: "recovered", prompt: "Synthetic recovery" })).status).toBe("completed");
          expect(recovered.prompts).toHaveLength(1);
        } finally { await third.dispose(); }
      } finally { await Promise.all([first.dispose(), second.dispose()]); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("keeps a revoked cached provider refresh disabled for its unchanged source across jobs", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-invalid-cached-refresh-"));
    try {
      await writeSeed(root, "account-i", "identity-i", "source-session");
      await writeSeed(root, "account-copy", "identity-i", "source-session");
      const factory = new FakeAppServerFactory({ holdTurnOpen: true });
      let process: ReturnType<FakeAppServerFactory["create"]> | undefined;
      const first = await executor(root, "cached-refresh", ["account-i"], [{ create: input => {
        process = factory.create(input); return process;
      } }]);
      try {
        const result = first.run({ taskId: "refresh", prompt: "Synthetic refresh" });
        await waitUntil(() => factory.prompts.length === 1);
        const path = join(factory.codexHomes[0]!, "auth.json");
        const auth = JSON.parse(await readFile(path, "utf8")) as { tokens: { refresh_token: string }; last_refresh: string };
        auth.tokens.refresh_token = "synthetic-refreshed-session";
        auth.last_refresh = now.toISOString();
        await writeFile(path, JSON.stringify(auth));
        process!.completeHeldTurn();
        expect((await result).status).toBe("completed");
      } finally { await first.dispose(); }
      await writeSeed(root, "account-refreshed-copy", "identity-i", "synthetic-refreshed-session");
      const invalid = new FakeAppServerFactory({ emitTopLevelErrorOnTurn: "refresh_token_invalidated" });
      const second = await executor(root, "cached-invalid", ["account-i"], [invalid]);
      try {
        expect((await second.run({ taskId: "invalid", prompt: "Synthetic invalidation", maxAccountCycles: 1 })).status).not.toBe("completed");
      } finally { await second.dispose(); }
      const store = codexAccountCapacityStore(join(root, "auth"));
      expect(store.read({ accountId: "account-i", demand: { provider: "codex", model: "other-model" }, now }))
        .toMatchObject({ availability: "disabled", reason: "provider_session_invalid" });
      expect(store.read({ accountId: "account-copy", now })).toMatchObject({ reason: "provider_session_invalid" });
      expect(store.read({ accountId: "account-refreshed-copy", now })).toMatchObject({ reason: "provider_session_invalid" });
      const forbidden = new FakeAppServerFactory();
      const third = await executor(root, "cached-blocked", ["account-i"], [forbidden]);
      try {
        expect((await third.run({ taskId: "blocked", prompt: "Synthetic unchanged source", maxAccountCycles: 1 })).status).not.toBe("completed");
        expect(forbidden.spawnCount).toBe(0);
      } finally { await third.dispose(); }
      expect((await listCodexGoalAccountStatuses({ authRootDir: join(root, "auth"), liveCheck: false }))
        .find(slot => slot.name === "account-i")).toMatchObject({ availability: "reconnect_required" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("admits parallel goal jobs on the same healthy identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-healthy-parallel-jobs-"));
    try {
      await writeSeed(root, "account-u", "identity-u", "healthy-session");
      const factories = [new FakeAppServerFactory(), new FakeAppServerFactory()];
      const first = await executor(root, "parallel-first", ["account-u"], [factories[0]!]);
      const second = await executor(root, "parallel-second", ["account-u"], [factories[1]!]);
      try {
        const results = await Promise.all([
          first.run({ taskId: "parallel-first", prompt: "First synthetic task" }),
          second.run({ taskId: "parallel-second", prompt: "Second synthetic task" }),
        ]);
        expect(results.map(result => result.status)).toEqual(["completed", "completed"]);
        expect(factories.map(factory => factory.prompts.length)).toEqual([1, 1]);
        expect(codexAccountCapacityStore(join(root, "auth")).read({ accountId: "account-u", now })).toBeNull();
      } finally { await Promise.all([first.dispose(), second.dispose()]); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

async function writeSeed(root: string, alias: string, accountId: string, refresh: string,
  access = "synthetic-access", lastRefresh = "2026-09-20"): Promise<void> {
  const dir = join(root, "auth", alias);
  await mkdir(dir, { recursive: true });
  // Match the supported operator publication boundary: a new login inode.
  // Same-size in-place writes can share timestamp resolution and make the
  // existing metadata-based alias cache turn this fixture into a timing test.
  const staged = join(dir, `.synthetic-login-${randomUUID()}`);
  await writeFile(staged, JSON.stringify({ auth_mode: "chatgpt", last_refresh: lastRefresh,
    tokens: { account_id: accountId, refresh_token: refresh, access_token: access, expiry: "2035-01-01T00:00:00Z" } }), { mode: 0o600 });
  await rename(staged, join(dir, "auth.json"));
}

async function executor(root: string, jobId: string, accounts: readonly string[], factories: readonly Pick<FakeAppServerFactory, "create">[], warmup = false): Promise<FileBackendCodexSafeExecutor> {
  const jobRootDir = join(root, "jobs", jobId);
  const workspacePath = join(root, "projects", jobId);
  await mkdir(workspacePath, { recursive: true });
  await writeFile(join(workspacePath, "fixture.txt"), "synthetic project\n");
  const options = buildCodexGoalExecutorOptions({ config: { jobRootDir, authRootDir: join(root, "auth"), workspacePath,
    promptPath: join(jobRootDir, "prompt.md"), taskId: jobId, accounts: accounts.map(name => ({ name })),
    model: "gpt-6.1-sol", reasoningEffort: "high", sourceEnv: { SUBSCRIPTION_RUNTIME_MANAGED_LAUNCH: "1" }, requireGitWorkspace: false, maxAccountCycles: 2 },
    stateRootDir: join(jobRootDir, "state"), encryptionKey: new Uint8Array(32).fill(7) });
  return new FileBackendCodexSafeExecutor({ ...options, clock: { now: () => now },
    accounts: options.accounts.map((account, index) => ({ ...account, worker: { ...account.worker,
      appServerProcessFactory: factories[index]!.create, sourceEnv: { SUBSCRIPTION_RUNTIME_MANAGED_LAUNCH: "1" },
      ...(warmup ? { executionEngine: "app-server", warmupPrompt: "Synthetic session validation" } as const : {}),
      runner: new StaticRunner({ exitCode: 0, stdout: "OK", stderr: "" }),
      clock: { now: () => now, monotonicMs: () => Date.now() } } })) });
}

async function readTree(root: string): Promise<string> {
  const chunks: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    chunks.push(entry.isDirectory() ? await readTree(path) : await readFile(path, "utf8"));
  }
  return chunks.join("\n");
}
