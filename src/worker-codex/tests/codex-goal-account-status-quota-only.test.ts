import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { CodexAccountCapacityAliasStore } from "../application/codex-account-capacity-alias-store";
import { codexAccountCapacityStore } from "../application/codex-account-capacity-store";
import { createCodexGoalMcpServer } from "../codex-goal-mcp";
import { shellQuote } from "../codex-goal-ops";
import { callToolJson, writeFakeAuth } from "./codex-goal-mcp-test-support";

const tools = ["codex_accounts_status", "codex_goal_accounts_status"] as const;
const creditsQuota = {
  rateLimitsByLimitId: { codex: {
    primary: { usedPercent: 100, windowDurationMins: 300 },
    credits: { hasCredits: true, unlimited: false, balance: "5" },
    rateLimitReachedType: "rate_limit_reached", spendControlReached: false,
  } },
};

async function withFixture(
  tool: typeof tools[number],
  quota: unknown,
  run: (fixture: {
    status: () => Promise<Record<string, unknown>>;
    store: ReturnType<typeof codexAccountCapacityStore>;
    resetAt: Date;
  }) => Promise<void>,
  transportFailure = false,
  authFailure = false,
) {
  const root = await mkdtemp(join(tmpdir(), "codex-quota-only-sandbox-"));
  const authRootDir = join(root, "auth");
  const registryRootDir = join(root, "registry");
  const jobRootDir = join(root, "job");
  const workspacePath = join(root, "sandbox-workspace");
  const callsPath = join(root, "provider-calls");
  const binaryPath = join(root, "synthetic-codex.sh");
  const server = createCodexGoalMcpServer();
  const client = new Client({ name: "quota-only-sandbox", version: "0.0.0" });
  const throttleNames = [
    "AGENT_ACCOUNT_OBSERVABILITY_CODEX_APP_SERVER_MIN_INTERVAL_MS",
    "SUBSCRIPTION_RUNTIME_CODEX_APP_SERVER_MIN_INTERVAL_MS",
  ] as const;
  const previousThrottle = throttleNames.map((name) => process.env[name]);
  try {
    // Every provider call here targets our synthetic binary. Production
    // throttling is covered separately and would only delay this fixture.
    for (const name of throttleNames) process.env[name] = "0";
    await mkdir(workspacePath);
    await mkdir(jobRootDir);
    await writeFile(join(jobRootDir, "prompt.md"), "Synthetic status fixture; never launch a provider.");
    await writeFakeAuth(authRootDir, "account-a", { lastRefresh: new Date().toISOString() });
    const reply = transportFailure
      ? { id: 3, error: { code: -32000, message: "synthetic-sensitive-transport-error" } }
      : { id: 3, result: quota };
    const accountReply = authFailure
      ? { id: 2, error: { code: -32000, message: "refresh token was revoked" } }
      : { id: 2, result: { account: { id: "chatgpt-account-secret" } } };
    await writeFile(binaryPath, `#!/bin/sh
if [ "$1" != "app-server" ]; then
  echo 'FALLBACK' >> ${shellQuote(callsPath)}
  exit 1
fi
while IFS= read -r line; do
  printf '%s\\n' "$line" >> ${shellQuote(callsPath)}
  case "$line" in
    *'"method":"initialize"'*) echo '{"id":1,"result":{}}' ;;
    *'"method":"account/read"'*) echo ${shellQuote(JSON.stringify(accountReply))}${authFailure ? "; exit 0" : ""} ;;
    *'"method":"account/rateLimits/read"'*) echo ${shellQuote(JSON.stringify(reply))}; exit 0 ;;
  esac
done
`);
    await chmod(binaryPath, 0o700);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    expect(await callToolJson(client, "codex_goal_create_job", {
      jobId: "quota-only-test", registryRootDir, jobRootDir, workspacePath,
      authRootDir, promptPath: join(jobRootDir, "prompt.md"), taskId: "quota-only-test", accounts: ["account-a"],
    })).toMatchObject({ ok: true });
    const scope = tool === "codex_goal_accounts_status"
      ? { jobId: "quota-only-test", registryRootDir }
      : { authRootDir, accounts: ["account-a"] };
    const store = codexAccountCapacityStore(authRootDir);
    const resetAt = new Date(Date.now() + 6 * 24 * 3600_000);
    const observedAt = new Date(Date.now() - 60_000);
    store.observe({ accountId: "account-a", observedAt, capacity: {
      availability: "quota_exhausted", reason: "quota_limited", cooldownUntil: resetAt,
      lastLimitSignalAt: observedAt, details: { capacitySource: "codex_app_server_live_quota" },
    } });
    await run({ store, resetAt, status: () => callToolJson(client, tool, {
      ...scope, quotaOnlyLiveCheck: true, liveCheck: true, recheckDueCapacity: true,
      codexBinaryPath: binaryPath, liveCheckTimeoutMs: 1_000,
    }) });
    const text = await readFile(callsPath, "utf8");
    expect(text).not.toContain("FALLBACK");
    const calls = text.trim().split("\n").map((line) => JSON.parse(line) as {
      method?: string; params?: Record<string, unknown>;
    }).filter((call) => call.method !== "initialized");
    expect(calls.map((call) => call.method)).toEqual([
      "initialize", "account/read", ...(authFailure ? [] : ["account/rateLimits/read"]),
    ]);
    expect(calls[1]?.params).toEqual({ refreshToken: false });
  } finally {
    try {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    } finally {
      throttleNames.forEach((name, index) => {
        const previous = previousThrottle[index];
        if (previous === undefined) delete process.env[name];
        else process.env[name] = previous;
      });
    }
  }
}

describe.each(tools)("%s quota-only live status", (tool) => {
  // These fail if auth-only availability clears capacity, or if a retained
  // blocker is hidden by fresh credit-aware quota availability.
  it("clears future tagged quota capacity when paid credits permit Codex", async () => {
    await withFixture(tool, creditsQuota, async ({ status, store }) => {
      expect(await status()).toMatchObject({
        ok: true, quotaOnlyLiveCheck: true, available: 1, availableDedupedAccountNames: ["account-a"],
        slots: [{ status: "ready", availability: "available", schedulerEligible: true, liveCheck: "passed" }],
      });
      expect(store.read({ accountId: "account-a" })).toBeNull();
    });
  });

  it.each([
    {}, { rateLimits: {} }, { rateLimitsByLimitId: { codex: {} } },
    { rateLimitsByLimitId: { codex: { usedPercent: -1 } } },
    { rateLimitsByLimitId: { other: { usedPercent: 10, windowDurationMins: 300 } } },
  ])("preserves cooldown and reports unknown for unusable quota %j", async (quota) => {
    await withFixture(tool, quota, async ({ status, store, resetAt }) => {
      expect(await status()).toMatchObject({
        ok: false, available: 0,
        slots: [{ status: "quota_unknown", availability: "unknown", schedulerEligible: false, liveCheck: "failed" }],
      });
      expect(store.read({ accountId: "account-a" })).toMatchObject({
        reason: "quota_limited", cooldownUntil: resetAt,
      });
    });
  });

  it("preserves cooldown on transport failure without leaking the error", async () => {
    await withFixture(tool, {}, async ({ status, store, resetAt }) => {
      const result = await status();
      expect(result).toMatchObject({ ok: false, available: 0,
        slots: [{ availability: "unknown", schedulerEligible: false, liveCheck: "failed" }],
      });
      expect(JSON.stringify(result)).not.toContain("synthetic-sensitive-transport-error");
      expect(store.read({ accountId: "account-a" })).toMatchObject({ cooldownUntil: resetAt });
    }, true);
  });

  it("reports a recognized auth denial as relogin without clearing shared capacity", async () => {
    await withFixture(tool, {}, async ({ status, store }) => {
      const now = new Date();
      const before = store.readState({ accountId: "account-a", now });
      expect(await status()).toMatchObject({ ok: false, available: 0, summary: { invalid: 1 },
        slots: [{ status: "auth_invalid", availability: "reconnect_required",
          recommendedAction: "relogin", schedulerEligible: false, liveCheck: "failed" }],
      });
      expect(store.readState({ accountId: "account-a", now })).toEqual(before);
    }, false, true);
  });

  it("retains authoritative auth denial and warning when capacity persistence fails", async () => {
    await withFixture(tool, {}, async ({ status, store }) => {
      const now = new Date();
      const before = store.readState({ accountId: "account-a", now });
      const readState = vi.spyOn(CodexAccountCapacityAliasStore.prototype, "readState")
        .mockImplementation(() => { throw new Error("synthetic-sensitive-capacity-io-error"); });
      try {
        const result = await status();
        expect(result).toMatchObject({ ok: false, available: 0, summary: { invalid: 1 },
          slots: [{ status: "auth_invalid", availability: "reconnect_required",
            recommendedAction: "relogin", schedulerEligible: false, liveCheck: "failed",
            warnings: expect.arrayContaining(["live quota capacity persistence failed"]) }],
        });
        expect(JSON.stringify(result)).not.toContain("synthetic-sensitive-capacity-io-error");
      } finally {
        readState.mockRestore();
      }
      expect(store.readState({ accountId: "account-a", now })).toEqual(before);
    }, false, true);
  });

  it("keeps the retained reset time when a newer signal rejects live limited quota", async () => {
    const liveResetSeconds = Math.floor((Date.now() + 24 * 3600_000) / 1_000);
    await withFixture(tool, { rateLimitsByLimitId: { codex: {
      usedPercent: 100, windowDurationMins: 300, resetsAt: liveResetSeconds,
      rateLimitReachedType: "five_hour_limit",
    } } }, async ({ status, store, resetAt }) => {
      const observedAt = new Date(Date.now() + 60_000);
      store.clear({ accountId: "account-a" });
      store.observe({ accountId: "account-a", observedAt, capacity: {
        availability: "quota_exhausted", reason: "quota_limited", cooldownUntil: resetAt,
        lastLimitSignalAt: observedAt, details: { capacitySource: "codex_app_server_live_quota" },
      } });
      const now = new Date();
      const before = store.readState({ accountId: "account-a", now });
      expect(before?.capacity.lastLimitSignalAt).toEqual(observedAt);
      expect(await status()).toMatchObject({ ok: false, available: 0,
        slots: [{ availability: "limited", schedulerEligible: false,
          limitResetAt: resetAt.toISOString(), capacityCooldownUntil: resetAt.toISOString() }],
      });
      expect(store.readState({ accountId: "account-a", now })).toEqual(before);
    });
  });

  it.each(["execution", "newer_signal", "provider_session_invalid"])("retains %s blocker despite fresh credits", async (kind) => {
    await withFixture(tool, creditsQuota, async ({ status, store, resetAt }) => {
      const observedAt = new Date(Date.now() + (kind === "newer_signal" ? 60_000 : -30_000));
      const reason = kind === "newer_signal" ? "quota_limited" : kind === "execution" ? "quota_recheck_failed" : kind;
      store.clear({ accountId: "account-a" });
      store.observe({ accountId: "account-a", observedAt, capacity: {
        availability: "cooldown", reason, cooldownUntil: resetAt, lastLimitSignalAt: observedAt,
        details: { capacitySource: "codex_app_server_live_quota" },
      } });
      const now = new Date();
      const before = store.readState({ accountId: "account-a", now });
      expect(await status()).toMatchObject({ ok: false, available: 0,
        slots: [{ schedulerEligible: false, capacityReason: reason }],
      });
      expect(store.readState({ accountId: "account-a", now })).toEqual(before);
    });
  });
});
