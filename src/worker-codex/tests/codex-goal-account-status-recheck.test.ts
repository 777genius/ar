import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { codexAccountCapacityStore } from "../application/codex-account-capacity-store";
import { CodexAccountCapacityRechecker } from "../application/codex-account-capacity-rechecker";
import { createCodexGoalMcpServer } from "../codex-goal-mcp";
import { callToolJson, writeFakeAuth } from "./codex-goal-mcp-test-support";

const statusTools = ["codex_accounts_status", "codex_goal_accounts_status"] as const;

async function withStatusFixture(
  tool: typeof statusTools[number],
  run: (fixture: {
    status: (options?: Record<string, unknown>) => Promise<Record<string, unknown>>;
    seedQuota: (resetAt: Date) => void;
  }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "codex-status-recheck-test-"));
  const authRootDir = join(root, "auth");
  const registryRootDir = join(root, "registry");
  const workspacePath = join(root, "sandbox-workspace");
  const jobRootDir = join(root, "job");
  const server = createCodexGoalMcpServer();
  const client = new Client({ name: "status-recheck-test", version: "0.0.0" });
  try {
    await mkdir(workspacePath);
    await mkdir(jobRootDir);
    await writeFile(join(jobRootDir, "prompt.md"), "Synthetic status fixture. Never launch a provider.");
    await writeFakeAuth(authRootDir, "account-a", { lastRefresh: new Date().toISOString() });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const created = await callToolJson(client, "codex_goal_create_job", {
      jobId: "status-test", registryRootDir, jobRootDir, authRootDir,
      workspacePath, promptPath: join(jobRootDir, "prompt.md"),
      taskId: "status-test", accounts: ["account-a"],
    });
    expect(created.ok).toBe(true);
    const scope = tool === "codex_goal_accounts_status"
      ? { jobId: "status-test", registryRootDir }
      : { authRootDir, accounts: ["account-a"] };
    const store = codexAccountCapacityStore(authRootDir);
    await run({
      status: (options = {}) => callToolJson(client, tool, { ...scope, ...options }),
      seedQuota: (resetAt) => store.observe({
        accountId: "account-a",
        observedAt: new Date(Date.now() - 60_000),
        capacity: { availability: "quota_exhausted", reason: "quota_limited", cooldownUntil: resetAt },
      }),
    });
  } finally {
    vi.restoreAllMocks();
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}

describe.each(statusTools)("%s due-only capacity transport", (tool) => {
  it("keeps default diagnostics observational even after reset time", async () => {
    const recheck = vi.spyOn(CodexAccountCapacityRechecker.prototype, "recheck")
      .mockResolvedValue({ availability: "available" });
    await withStatusFixture(tool, async ({ status, seedQuota }) => {
      seedQuota(new Date(Date.now() - 1000));
      const result = await status({ liveCheck: false });
      expect(result).toMatchObject({ recheckDueCapacity: false, liveCheck: false, available: 0 });
      expect(recheck).not.toHaveBeenCalled();
    });
  });

  it("opts in, restores expired capacity and preserves the account scope", async () => {
    const recheck = vi.spyOn(CodexAccountCapacityRechecker.prototype, "recheck")
      .mockResolvedValue({ availability: "available" });
    await withStatusFixture(tool, async ({ status, seedQuota }) => {
      seedQuota(new Date(Date.now() - 1000));
      const result = await status({ liveCheck: false, recheckDueCapacity: true, liveCheckTimeoutMs: 1000 });
      expect(result).toMatchObject({
        ok: true, liveCheck: false, recheckDueCapacity: true,
        availableDedupedAccountNames: ["account-a"], count: 1,
      });
      expect(recheck).toHaveBeenCalledTimes(1);
    });
  });

  it("does not recheck a future quota reset", async () => {
    const recheck = vi.spyOn(CodexAccountCapacityRechecker.prototype, "recheck")
      .mockResolvedValue({ availability: "available" });
    await withStatusFixture(tool, async ({ status, seedQuota }) => {
      seedQuota(new Date(Date.now() + 3600_000));
      expect(await status({ recheckDueCapacity: true })).toMatchObject({
        recheckDueCapacity: true, available: 0,
      });
      expect(recheck).not.toHaveBeenCalled();
    });
  });

  it("single-claims simultaneous due rechecks", async () => {
    const recheck = vi.spyOn(CodexAccountCapacityRechecker.prototype, "recheck")
      .mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { availability: "available" };
      });
    await withStatusFixture(tool, async ({ status, seedQuota }) => {
      seedQuota(new Date(Date.now() - 1000));
      await Promise.all([status({ recheckDueCapacity: true }), status({ recheckDueCapacity: true })]);
      expect(recheck).toHaveBeenCalledTimes(1);
      expect(await status()).toMatchObject({ availableDedupedAccountNames: ["account-a"] });
    });
  });

  it("keeps failed quota observation ineligible and does not leak its error", async () => {
    const recheck = vi.spyOn(CodexAccountCapacityRechecker.prototype, "recheck")
      .mockRejectedValue(new Error("synthetic-sensitive-provider-error"));
    await withStatusFixture(tool, async ({ status, seedQuota }) => {
      seedQuota(new Date(Date.now() - 1000));
      const result = await status({ recheckDueCapacity: true });
      expect(result).toMatchObject({ recheckDueCapacity: true, available: 0 });
      expect(recheck).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(result)).not.toContain("synthetic-sensitive-provider-error");
    });
  });
});
