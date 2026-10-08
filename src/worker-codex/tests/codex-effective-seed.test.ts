import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createHash, hkdfSync } from "node:crypto";
import { LocalEncryptedFileStore } from "../../store-local-file";
import { sessionArtifactFromCodexAuthJson } from "../../provider-codex";
import { describe, expect, it } from "vitest";
import { FileBackendCodexSeedWriteback } from "../file-backend-codex-seed-writeback";
import { FileBackendCodexWorker } from "../file-backend-codex-worker";
import { createCodexAccountHealthProbe } from "../account-diagnostics-adapter";
import { codexAccountCapacityStore } from "../application/codex-account-capacity-store";
import { codexSessionCapacityAccountId } from "../codex-session-capacity-identity";
import { codexAuthJsonAt, FakeAppServerFactory } from "./file-backend-codex-worker-test-support";

const seed = codexAuthJsonAt("SYNTHETIC-S0", "2026-05-31T00:00:00Z");
const rotated = codexAuthJsonAt("SYNTHETIC-R", "2026-05-31T00:05:00Z");
const now = new Date("2026-05-31T00:10:00Z");

describe("effective Codex seed readers and lineage", () => {
  // Supported callers can name the same source with relative/absolute paths.
  it("resolves one refresh custody for equivalent source path spellings", async () => {
    const root = await mkdtemp(join(tmpdir(), "synthetic-effective-path-"));
    try {
      const path = join(root, "auth.json"); await writeFile(path, seed, { mode: 0o600 });
      expect(await new FileBackendCodexSeedWriteback(relative(process.cwd(), path)).publish({ source: seed, expected: seed, next: rotated })).toBe(true);
      expect(await new FileBackendCodexSeedWriteback(path).read(seed) === rotated).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  // Readable v1 custody must enter stable custody even without another provider
  // rotation, before a subsequent same-authorization metadata rewrite.
  it("promotes readable byte-bound v1 refresh custody on a successful unchanged run", async () => {
    const root = await mkdtemp(join(tmpdir(), "synthetic-effective-legacy-"));
    const path = join(root, "auth.json");
    await writeFile(path, seed, { mode: 0o600 });
    const scope = createHash("sha256").update(path).update("\0").update(seed).digest("hex");
    await new LocalEncryptedFileStore({ providerId: "codex", rootDir: join(root, ".subscription-runtime-auth-writeback", scope),
      encryptionKey: new Uint8Array(hkdfSync("sha256", seed, "", "subscription-runtime/codex-seed-writeback/v1", 32)),
    }).write({ providerInstanceId: "codex:seed-writeback", expectedGeneration: 0,
      nextArtifact: sessionArtifactFromCodexAuthJson(rotated), idempotencyKey: "synthetic-readable-v1", leaseId: "synthetic-legacy" });
    const protocol = new FakeAppServerFactory();
    const worker = new FileBackendCodexWorker({ providerInstanceId: "synthetic-migration", stateRootDir: join(root, "job"),
      codexBinaryPath: "/SYNTHETIC-NONEXISTENT", encryptionKey: new Uint8Array(32).fill(17),
      sourceEnv: { SUBSCRIPTION_RUNTIME_MANAGED_LAUNCH: "1" }, appServerProcessFactory: protocol.create,
      clock: { now: () => now, monotonicMs: () => performance.now() } });
    try {
      await worker.start(); await worker.seedCodexAuthJsonFile(path);
      expect((await worker.run({ prompt: "Synthetic readable legacy custody" })).outputText).toBe("OK");
      expect(await readFile(join(protocol.codexHomes[0]!, "auth.json"), "utf8") === rotated).toBe(true);
      await writeFile(path, seed + "\n");
      expect(await new FileBackendCodexSeedWriteback(path).read(seed + "\n") === rotated).toBe(true);
    } finally { await worker.dispose(); await rm(root, { recursive: true, force: true }); }
  });
  // R1 red: a formatting/access-only replacement must retain the only usable R.
  it.each(["formatting", "access"])("retains rotated refresh after %s source replacement", async kind => {
    const root = await mkdtemp(join(tmpdir(), "synthetic-effective-seed-"));
    try {
      const path = join(root, "auth.json");
      await writeFile(path, seed, { mode: 0o600 });
      const custody = new FileBackendCodexSeedWriteback(path);
      expect(await custody.publish({ source: seed, expected: seed, next: rotated })).toBe(true);
      const next = kind === "formatting" ? seed + "\n" : JSON.stringify({
        ...JSON.parse(seed), last_refresh: now.toISOString(),
        tokens: { ...JSON.parse(seed).tokens, access_token: "test-fixture-literal" },
      });
      await writeFile(path + ".new", next, { mode: 0o600 });
      await rename(path + ".new", path);
      expect(await new FileBackendCodexSeedWriteback(path).read(next) === rotated).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  // R3 red: exercise the actual supported probe plan and its actual auth path.
  it.each(["health", "live_probe"] as const)("supplies effective refresh to the %s probe", async mode => {
    const root = await mkdtemp(join(tmpdir(), "synthetic-effective-probe-"));
    try {
      const path = join(root, "auth.json");
      await writeFile(path, seed, { mode: 0o600 });
      await new FileBackendCodexSeedWriteback(path).publish({ source: seed, expected: seed, next: rotated });
      let actual = false;
      const probe = createCodexAccountHealthProbe({ runner: async plan => {
        actual = await readFile(plan.env.REVIEWROUTER_CODEX_AUTH_PATH!, "utf8") === rotated
          && await readFile(join(plan.env.CODEX_HOME!, "auth.json"), "utf8") === rotated;
        return { exitCode: actual ? 0 : 1, stdout: "", stderr: actual ? "" : "refresh_token_invalidated" };
      } });
      const result = await probe.probeAccount({ account: {
        provider: "codex", slotId: "synthetic", providerInstanceId: "codex:synthetic", metadata: {}, authJsonPath: path,
      }, identity: { safeIdentity: "synthetic" }, mode, now });
      expect(actual).toBe(true);
      expect(result.availability).toBe("available");
      expect(await readFile(path, "utf8") === seed).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  // R2 red: local R defeats older incoming S0; invalid R must still disable S0.
  it("retains invalidation lineage when a newer local artifact defeats a rewritten seed", async () => {
    const root = await mkdtemp(join(tmpdir(), "synthetic-effective-invalid-"));
    const path = join(root, "auth.json");
    await writeFile(path, seed, { mode: 0o600 });
    const store = codexAccountCapacityStore(root);
    const protocol = new FakeAppServerFactory({ emitTopLevelErrorOnTurn: "refresh_token_invalidated" });
    const worker = new FileBackendCodexWorker({
      providerInstanceId: "synthetic-local-newer", stateRootDir: join(root, "job"),
      codexBinaryPath: "/SYNTHETIC-NONEXISTENT", encryptionKey: new Uint8Array(32).fill(17),
      sourceEnv: { SUBSCRIPTION_RUNTIME_MANAGED_LAUNCH: "1" }, appServerProcessFactory: protocol.create,
      clock: { now: () => now, monotonicMs: () => performance.now() },
      onSessionInvalid: capacity => store.observe({ accountId: "synthetic", capacity, observedAt: now }),
    });
    try {
      await worker.start();
      await worker.seedCodexAuthJsonFile(path);
      await worker.seedCodexAuthJson(rotated);
      await writeFile(path, seed + "\n");
      await expect(worker.run({ prompt: "Synthetic invalidation only" })).rejects.toMatchObject({ details: { code: "provider_session_invalid" } });
      const actualId = codexSessionCapacityAccountId(JSON.parse(rotated))!;
      const sourceId = codexSessionCapacityAccountId(JSON.parse(seed))!;
      expect(store.read({ accountId: actualId, now })?.reason).toBe("provider_session_invalid");
      expect(store.read({ accountId: sourceId, now })?.reason).toBe("provider_session_invalid");
    } finally { await worker.dispose(); await rm(root, { recursive: true, force: true }); }
  });

  // R1/R2: rejecting an older incoming artifact must not erase an existing
  // publication grant for the unchanged source authorization.
  it("retains usable local rotation under the previously bound unchanged authorization", async () => {
    const root = await mkdtemp(join(tmpdir(), "synthetic-effective-local-refresh-"));
    const path = join(root, "auth.json");
    await writeFile(path, seed, { mode: 0o600 });
    const worker = new FileBackendCodexWorker({
      providerInstanceId: "synthetic-known-lineage", stateRootDir: join(root, "job"),
      codexBinaryPath: "/SYNTHETIC-NONEXISTENT", encryptionKey: new Uint8Array(32).fill(17),
      sourceEnv: { SUBSCRIPTION_RUNTIME_MANAGED_LAUNCH: "1" }, appServerProcessFactory: new FakeAppServerFactory().create,
      clock: { now: () => now, monotonicMs: () => performance.now() },
    });
    try {
      await worker.start(); await worker.seedCodexAuthJsonFile(path);
      await worker.seedCodexAuthJson(rotated);
      await writeFile(path, seed + "\n");
      expect((await worker.run({ prompt: "Synthetic retained local refresh" })).outputText).toBe("OK");
      expect(await new FileBackendCodexSeedWriteback(path).read(seed + "\n") === rotated).toBe(true);
    } finally { await worker.dispose(); await rm(root, { recursive: true, force: true }); }
  });

  // Local eligibility has the same recovery boundary as durable shared capacity.
  it("does not recover a confirmed invalid local session on access-only source changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "synthetic-effective-recovery-"));
    const path = join(root, "auth.json");
    await writeFile(path, seed, { mode: 0o600 });
    const worker = new FileBackendCodexWorker({
      providerInstanceId: "synthetic-invalid-local", stateRootDir: join(root, "job"),
      codexBinaryPath: "/SYNTHETIC-NONEXISTENT", encryptionKey: new Uint8Array(32).fill(17),
      sourceEnv: { SUBSCRIPTION_RUNTIME_MANAGED_LAUNCH: "1" },
      appServerProcessFactory: new FakeAppServerFactory({ emitTopLevelErrorOnTurn: "refresh_token_invalidated" }).create,
      clock: { now: () => now, monotonicMs: () => performance.now() },
    });
    try {
      await worker.start(); await worker.seedCodexAuthJsonFile(path);
      await expect(worker.run({ prompt: "Synthetic invalid" })).rejects.toMatchObject({ details: { code: "provider_session_invalid" } });
      await writeFile(path, seed + "\n");
      expect(worker.capacity().reason).toBe("provider_session_invalid");
    } finally { await worker.dispose(); await rm(root, { recursive: true, force: true }); }
  });

  // New authorization must replace the revoked local artifact even if a login
  // writer preserves/rolls back timestamps; freshness is not authorization.
  it("imports newly authorized refresh identity despite an older login timestamp", async () => {
    const root = await mkdtemp(join(tmpdir(), "synthetic-effective-new-authorization-"));
    const path = join(root, "auth.json");
    const authorized = codexAuthJsonAt("SYNTHETIC-S1", "2026-05-30T23:00:00Z");
    await writeFile(path, seed, { mode: 0o600 });
    const protocol = new FakeAppServerFactory({ emitTopLevelErrorsOnTurns: ["refresh_token_invalidated", null] });
    const worker = new FileBackendCodexWorker({
      providerInstanceId: "synthetic-new-login", stateRootDir: join(root, "job"),
      codexBinaryPath: "/SYNTHETIC-NONEXISTENT", encryptionKey: new Uint8Array(32).fill(17),
      sourceEnv: { SUBSCRIPTION_RUNTIME_MANAGED_LAUNCH: "1" }, appServerProcessFactory: protocol.create,
      clock: { now: () => now, monotonicMs: () => performance.now() },
    });
    try {
      await worker.start(); await worker.seedCodexAuthJsonFile(path);
      await worker.seedCodexAuthJson(rotated);
      await expect(worker.run({ prompt: "Synthetic invalid R" })).rejects.toMatchObject({ details: { code: "provider_session_invalid" } });
      await writeFile(path, authorized);
      expect((await worker.run({ prompt: "Synthetic new authorization" })).outputText).toBe("OK");
      expect(await readFile(join(protocol.codexHomes.at(-1)!, "auth.json"), "utf8") === authorized).toBe(true);
    } finally { await worker.dispose(); await rm(root, { recursive: true, force: true }); }
  });
});
