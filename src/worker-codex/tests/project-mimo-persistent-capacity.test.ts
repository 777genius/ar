import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";

import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexModelBackend } from "@vioxen/subscription-runtime/provider-codex";
import { codexAccountCapacityStore } from "../application/codex-account-capacity-store";
import { reserveCodexProjectAccount } from "../application/project-control/codex-goal-project-account-reservation";
import { fixture } from "./codex-goal-project-account-reservation-fixture";
import { FileBackendCodexSafeExecutor } from "../file-backend-codex-safe-executor";
const state = vi.hoisted(() => ({ authReads: 0, rateHandlers: [] as unknown[] }));
vi.mock("../file-backend-codex-worker", async original => {
  const real = await original<typeof import("../file-backend-codex-worker")>();
  return { ...real, FileBackendCodexWorker: class extends real.FileBackendCodexWorker {
    constructor(input: ConstructorParameters<typeof real.FileBackendCodexWorker>[0]) {
      state.rateHandlers.push("rateLimitsSnapshotHandler" in input ? input.rateLimitsSnapshotHandler : undefined);
      super(input);
    }
  } };
});
vi.mock("node:fs", async original => {
  const real = await original<typeof import("node:fs")>();
  return { ...real, readFileSync: ((path: Parameters<typeof real.readFileSync>[0], ...args: unknown[]) => {
    if (String(path).endsWith("auth.json")) { state.authReads++; throw new Error("Unexpected ChatGPT auth read"); }
    return (real.readFileSync as (...values: unknown[]) => unknown)(path, ...args);
  }) as typeof real.readFileSync };
});
const roots: string[] = [];
beforeEach(() => { state.authReads = 0; state.rateHandlers = []; });
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
describe("MiMo project persistent capacity", () => {
  it("keeps MiMo capacity on its literal slot without reading default Codex auth or installing Codex quota ingestion", async () => {
    const root = await mkdtemp(join(tmpdir(), "TEST-mimo-capacity-isolation-")); roots.push(root);
    const authRootDir = join(root, "auth"), now = new Date("2026-10-15T10:00:00Z");
    await mkdir(join(authRootDir, "account-q"), { recursive: true });
    await writeFile(join(authRootDir, "account-q", "auth.json"), "{}\n");
    const sourceHandler = vi.fn();
    const executor = new FileBackendCodexSafeExecutor({
      authRootDir, stateRootDir: join(root, "state"), workspacePath: join(root, "workspace"), requireGitWorkspace: false,
      accountCapacityStore: codexAccountCapacityStore(authRootDir, { modelBackend: CodexModelBackend.XiaomiMimoTokenPlan }),
      accounts: [{ worker: { providerInstanceId: "TEST-mimo", capacityAccountId: "account-q", stateRootDir: join(root, "state"),
        codexBinaryPath: "codex", encryptionKey: new Uint8Array(32).fill(13), executionEngine: "app-server-goal",
        modelBackend: CodexModelBackend.XiaomiMimoTokenPlan, mimoApiKeyEnvVarName: "TEST_MIMO_KEY",
        sourceEnv: { TEST_MIMO_KEY: "TEST-only-key" }, rateLimitsSnapshotHandler: sourceHandler } }],
    });
    try {
      const observed = executor.accountCapacityStore.observe({ accountId: "account-q", observedAt: now,
        capacity: { availability: "cooldown", reason: "quota_limited", cooldownUntil: new Date(now.getTime() + 60_000) } });
      expect(observed?.accountId).toBe("account-q");
      expect(executor.accountCapacityStore.read({ accountId: "account-q", now })).toMatchObject({ reason: "quota_limited" });
      expect(state.authReads).toBe(0);
    } finally { await executor.dispose(); }

    // A fresh slot starts its real worker construction, without executing any provider turn.
    const fresh = new FileBackendCodexSafeExecutor({
      authRootDir, stateRootDir: join(root, "fresh-state"), workspacePath: join(root, "workspace"), requireGitWorkspace: false,
      accounts: [{ worker: { providerInstanceId: "TEST-mimo-fresh", stateRootDir: join(root, "fresh-state"),
        codexBinaryPath: "codex", encryptionKey: new Uint8Array(32).fill(13), executionEngine: "app-server-goal",
        modelBackend: CodexModelBackend.XiaomiMimoTokenPlan, mimoApiKeyEnvVarName: "TEST_MIMO_KEY",
        sourceEnv: { TEST_MIMO_KEY: "TEST-only-key" }, rateLimitsSnapshotHandler: sourceHandler } }],
    });
    try { await fresh.start(); expect(state.rateHandlers).toEqual([undefined]); expect(sourceHandler).not.toHaveBeenCalled(); }
    finally { await fresh.dispose(); }
  });
  it("reserves with a real exclusive lease and honors persisted quota without auth.json reads", async () => {
    const root = await mkdtemp(join(tmpdir(), "TEST-mimo-capacity-")); roots.push(root);
    const base = fixture(root, "TEST-mimo");
    const input = { manifest: { ...base.manifest, modelBackend: CodexModelBackend.XiaomiMimoTokenPlan, accounts: ["account-q"] },
      launch: { ...base.launch, config: { ...base.launch.config, accounts: [{ name: "account-q" }],
        modelBackend: CodexModelBackend.XiaomiMimoTokenPlan, model: "mimo-v2.6-pro", maxAccountCycles: 1 } } };
    const now = new Date("2026-10-09T18:00:00Z");
    const reservation = await reserveCodexProjectAccount({ ...input, deps: { leaseMode: "exclusive", now } });
    expect(reservation).toMatchObject({ mode: "exclusive", accountId: "account-q" });
    const store = codexAccountCapacityStore(input.launch.config.authRootDir, { modelBackend: CodexModelBackend.XiaomiMimoTokenPlan });
    store.observe({ accountId: "account-q", capacity: { availability: "cooldown", reason: "quota_limited",
      cooldownUntil: new Date(now.getTime() + 3600000) }, observedAt: now });
    const fresh = { ...input, manifest: { ...input.manifest, jobId: "TEST-other" }, launch: { ...input.launch,
      config: { ...input.launch.config, jobId: "TEST-other", jobRootDir: join(root, "TEST-other") } } };
    await expect(reserveCodexProjectAccount({ ...fresh, deps: { leaseMode: "shared", now } })).rejects.toThrow();
    expect(state.authReads).toBe(0);
  });
});
