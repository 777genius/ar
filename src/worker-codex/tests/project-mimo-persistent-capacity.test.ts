import { mkdtemp, rm } from "node:fs/promises";

import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexModelBackend } from "@vioxen/subscription-runtime/provider-codex";
import { codexAccountCapacityStore } from "../application/codex-account-capacity-store";
import { reserveCodexProjectAccount } from "../application/project-control/codex-goal-project-account-reservation";
import { fixture } from "./codex-goal-project-account-reservation-fixture";
const state = vi.hoisted(() => ({ authReads: 0 }));
vi.mock("node:fs", async original => {
  const real = await original<typeof import("node:fs")>();
  return { ...real, readFileSync: ((path: Parameters<typeof real.readFileSync>[0], ...args: unknown[]) => {
    if (String(path).endsWith("auth.json")) { state.authReads++; throw new Error("Unexpected ChatGPT auth read"); }
    return (real.readFileSync as (...values: unknown[]) => unknown)(path, ...args);
  }) as typeof real.readFileSync };
});
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
describe("MiMo project persistent capacity", () => {
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
