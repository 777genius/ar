import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createLocalFileBackendRuntimeAdapters } from "@vioxen/subscription-runtime/store-local-file";
import { encryptionKey } from "./file-backend-claude-worker-test-support";
import { ambientTestFixture } from "./claude-ambient-test-support";

describe("FileBackendClaudeWorker ambient selection", () => {
  it("requires renewed ambient opt-in after reopening durable TEST state", async () => {
    const fixture = await ambientTestFixture();
    const first = fixture.worker();
    const reopened = fixture.worker();
    try {
      await first.start();
      await first.seedClaudeAmbientHome({ homeDir: fixture.homeDir });
      expect(JSON.parse((await first.run({ prompt: "TEST initial opt-in" })).outputText))
        .toMatchObject({ home: fixture.homeDir, hasOauthToken: false, hasApiKey: false });
      await first.dispose();
      await rm(fixture.launchPath);
      await reopened.start();
      await expect(reopened.prewarm()).rejects.toThrow("claude_ambient_home_opt_in_required");
      await expect(reopened.run({ prompt: "TEST no opt-in" }))
        .rejects.toThrow("claude_ambient_home_opt_in_required");
      await expect(readFile(fixture.launchPath)).rejects.toMatchObject({ code: "ENOENT" });
      await reopened.seedClaudeAmbientHome({ homeDir: fixture.homeDir });
      expect(JSON.parse((await reopened.run({ prompt: "TEST renewed opt-in" })).outputText))
        .toMatchObject({ home: fixture.homeDir, hasOauthToken: false });
      expect(await readFile(join(fixture.homeDir, "synthetic-session.json"), "utf8"))
        .toBe('{"testSession":true}\n');
    } finally {
      await first.dispose();
      await reopened.dispose();
      await rm(fixture.rootDir, { recursive: true, force: true });
    }
  });

  it("gives explicit OAuth precedence over a persisted ambient TEST session", async () => {
    const fixture = await ambientTestFixture();
    const first = fixture.worker();
    const reopened = fixture.worker();
    try {
      await first.start();
      await first.seedClaudeAmbientHome({ homeDir: fixture.homeDir });
      await first.dispose();
      await reopened.start();
      await reopened.seedClaudeOAuth({ oauthToken: "TEST-oauth-only-synthetic" });
      const observed = JSON.parse((await reopened.run({ prompt: "TEST isolated OAuth" })).outputText);
      expect(observed).toEqual({
        home: reopened.configDir,
        configDir: reopened.configDir,
        hasOauthToken: true,
        hasApiKey: false,
      });
    } finally {
      await first.dispose();
      await reopened.dispose();
      await rm(fixture.rootDir, { recursive: true, force: true });
    }
  });

  it("preserves an existing OAuth TEST session when ambient auth is requested", async () => {
    const fixture = await ambientTestFixture();
    const worker = fixture.worker();
    try {
      await worker.start();
      await worker.seedClaudeOAuth({ oauthToken: "TEST-oauth-only-synthetic" });
      await worker.seedClaudeAmbientHome({ homeDir: fixture.homeDir });
      expect(JSON.parse((await worker.run({ prompt: "TEST OAuth precedence" })).outputText))
        .toMatchObject({ home: worker.configDir, hasOauthToken: true, hasApiKey: false });
    } finally {
      await worker.dispose();
      await rm(fixture.rootDir, { recursive: true, force: true });
    }
  });

  it("uses the newly selected TEST HOME and config directory on explicit reseeding", async () => {
    const fixture = await ambientTestFixture();
    const worker = fixture.worker();
    try {
      const nextHome = join(fixture.rootDir, "TEST-next-home");
      const nextConfig = join(nextHome, "TEST-config");
      await mkdir(nextConfig, { recursive: true });
      await worker.start();
      await worker.seedClaudeAmbientHome({ homeDir: fixture.homeDir });
      await worker.seedClaudeAmbientHome({ homeDir: nextHome, configDir: nextConfig });
      expect(JSON.parse((await worker.run({ prompt: "TEST selected paths" })).outputText))
        .toEqual({ home: nextHome, configDir: nextConfig, hasOauthToken: false, hasApiKey: false });
    } finally {
      await worker.dispose();
      await rm(fixture.rootDir, { recursive: true, force: true });
    }
  });

  it("revokes earlier ambient authorization when explicit OAuth finds an existing OAuth session", async () => {
    const fixture = await ambientTestFixture();
    const first = fixture.worker();
    const second = fixture.worker();
    const { sessionStore, leaseStore } = createLocalFileBackendRuntimeAdapters({
      providerId: "claude",
      rootDir: join(fixture.rootDir, "TEST-state", "sessions"),
      encryptionKey: encryptionKey(),
    });
    try {
      await first.start();
      await second.start();
      await first.seedClaudeAmbientHome({ homeDir: fixture.homeDir });
      const ambient = await sessionStore.read({
        providerInstanceId: "claude-TEST-ambient", expectedProviderId: "claude", purpose: "health-check",
      });
      if (!ambient) throw new Error("TEST ambient state missing");
      await second.seedClaudeOAuth({ oauthToken: "TEST-synthetic-second-oauth" });
      await first.seedClaudeOAuth({ oauthToken: "TEST-synthetic-first-oauth" });
      const oauth = await sessionStore.read({
        providerInstanceId: "claude-TEST-ambient", expectedProviderId: "claude", purpose: "health-check",
      });
      if (!oauth) throw new Error("TEST OAuth state missing");
      // Simulate restored durable paths; a previous opt-in must not outlive the new OAuth choice.
      const restorationLease = await leaseStore.acquire({
        providerInstanceId: "claude-TEST-ambient", runId: "TEST-restoration", attempt: 1,
        ttlMs: 60_000, restoredGenerationHash: oauth.generationHash,
      });
      if (restorationLease.status !== "granted") throw new Error("TEST restoration lease unavailable");
      await leaseStore.finalize({ leaseId: restorationLease.leaseId, restoredGenerationHash: oauth.generationHash });
      await leaseStore.markWritebackStarted({ leaseId: restorationLease.leaseId });
      const restored = await sessionStore.write({
        providerInstanceId: "claude-TEST-ambient",
        expectedGeneration: oauth.generation,
        nextArtifact: ambient.artifact,
        idempotencyKey: "TEST-restore-ambient", leaseId: restorationLease.leaseId,
      });
      expect(restored).toMatchObject({ status: "accepted" });
      if (restored.status === "stale_generation") throw new Error("TEST restoration generation changed");
      await expect(leaseStore.markWritebackCommitted({
        leaseId: restorationLease.leaseId, nextGenerationHash: restored.generationHash,
        idempotencyKey: "TEST-restore-ambient",
      })).resolves.toMatchObject({ status: "committed" });
      await expect(first.run({ prompt: "TEST OAuth remains the current choice" }))
        .rejects.toThrow("claude_ambient_home_opt_in_required");
      await expect(readFile(fixture.launchPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await first.dispose();
      await second.dispose();
      await rm(fixture.rootDir, { recursive: true, force: true });
    }
  });

  it("reseeds a config-only change, clears it, and returns to an earlier explicit choice", async () => {
    const fixture = await ambientTestFixture();
    const worker = fixture.worker();
    try {
      const configDir = join(fixture.homeDir, "TEST-config");
      await mkdir(configDir);
      await worker.start();
      for (const choice of [
        { homeDir: fixture.homeDir },
        { homeDir: fixture.homeDir, configDir },
        { homeDir: fixture.homeDir },
        { homeDir: fixture.homeDir, configDir },
      ]) {
        await worker.seedClaudeAmbientHome(choice);
        const observed = JSON.parse((await worker.run({ prompt: "TEST current choice" })).outputText);
        expect(observed).toEqual({
          home: choice.homeDir,
          configDir: choice.configDir ?? null,
          hasOauthToken: false,
          hasApiKey: false,
        });
      }
    } finally {
      await worker.dispose();
      await rm(fixture.rootDir, { recursive: true, force: true });
    }
  });

  it("refuses a durable ambient choice changed by another worker until explicitly selected", async () => {
    const fixture = await ambientTestFixture();
    const first = fixture.worker();
    const second = fixture.worker();
    try {
      const nextHome = join(fixture.rootDir, "TEST-another-home");
      await mkdir(nextHome);
      await first.start();
      await second.start();
      await first.seedClaudeAmbientHome({ homeDir: fixture.homeDir });
      await second.seedClaudeAmbientHome({ homeDir: nextHome });
      await expect(first.prewarm()).rejects.toThrow("claude_ambient_home_opt_in_required");
      await expect(first.run({ prompt: "TEST stale selection" }))
        .rejects.toThrow("claude_ambient_home_opt_in_required");
      await expect(readFile(fixture.launchPath)).rejects.toMatchObject({ code: "ENOENT" });
      await first.seedClaudeAmbientHome({ homeDir: fixture.homeDir });
      expect(JSON.parse((await first.run({ prompt: "TEST renewed choice" })).outputText))
        .toMatchObject({ home: fixture.homeDir, hasOauthToken: false });
    } finally {
      await first.dispose();
      await second.dispose();
      await rm(fixture.rootDir, { recursive: true, force: true });
    }
  });

  it.each(["hosted-TEST-job", ""])("denies persisted ambient execution with marker %j", async (marker) => {
    const fixture = await ambientTestFixture();
    const first = fixture.worker();
    const hosted = fixture.worker({ SUBSCRIPTION_RUNTIME_SANDBOX_KIND: marker });
    try {
      await first.start();
      await first.seedClaudeAmbientHome({ homeDir: fixture.homeDir });
      await first.dispose();
      await hosted.start();
      await expect(hosted.prewarm()).rejects.toThrow("claude_ambient_home_hosted_context_denied");
      await expect(hosted.run({ prompt: "TEST hosted persisted state" }))
        .rejects.toThrow("claude_ambient_home_hosted_context_denied");
      await expect(readFile(fixture.launchPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await first.dispose();
      await hosted.dispose();
      await rm(fixture.rootDir, { recursive: true, force: true });
    }
  });

  it.each(["hosted-TEST-job", ""])("rejects programmatic ambient opt-in with sandbox marker %j", async (marker) => {
    const fixture = await ambientTestFixture();
    const worker = fixture.worker({ SUBSCRIPTION_RUNTIME_SANDBOX_KIND: marker });
    try {
      await worker.start();
      await expect(worker.seedClaudeAmbientHome({ homeDir: fixture.homeDir }))
        .rejects.toThrow("claude_ambient_home_hosted_context_denied");
      await expect(readFile(fixture.launchPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await worker.dispose();
      await rm(fixture.rootDir, { recursive: true, force: true });
    }
  });

});
