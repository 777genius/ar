import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CodexModelBackend } from "@vioxen/subscription-runtime/provider-codex";
import { AccessBoundary } from "@vioxen/subscription-runtime/worker-core";
import { describe, expect, it } from "vitest";
import { codexAccountCapacityStore } from "../application/codex-account-capacity-store";
import { reserveCodexProjectAccount } from "../application/project-control/codex-goal-project-account-reservation";
import { createCodexGoalMcpServer } from "../codex-goal-mcp";
import { projectControlRefillAccountNames } from "../codex-goal-mcp-project-accounts";
import { fixture } from "./codex-goal-project-account-reservation-fixture";
import { callToolJson } from "./codex-goal-mcp-test-support";

describe("MiMo project refill account selection", () => {
  it("preserves scoped configured slots through the public refill preview without OAuth discovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "TEST-project-refill-mimo-"));
    const authRootDir = join(root, "auth");
    const registryRootDir = join(root, "jobs", "registry");
    const sourceWorkspacePath = join(root, "source");
    const controllerJobRoot = join(root, "jobs", "test-controller");
    const server = createCodexGoalMcpServer();
    const client = new Client({ name: "TEST-project-refill-mimo", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await mkdir(authRootDir, { recursive: true });
      await mkdir(sourceWorkspacePath, { recursive: true });
      // OAuth-only catalog metadata must not reinterpret a configured MiMo pool.
      // No auth.json, provider credential, or live authority is manufactured.
      await writeFile(join(authRootDir, "account-labels.json"), JSON.stringify({
        "account-q": { quarantined: true },
      }));
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const controller = await callToolJson(client, "codex_goal_create_job", {
        registryRootDir,
        jobId: "test-controller",
        jobRootDir: controllerJobRoot,
        authRootDir,
        workspacePath: sourceWorkspacePath,
        promptPath: join(controllerJobRoot, "prompt.md"),
        taskId: "test-controller",
        accounts: ["account-q"],
        accessBoundary: AccessBoundary.ProjectScopedControl,
        projectAccessScope: {
          projectId: "TEST-refill-mimo",
          workspaceRoots: [sourceWorkspacePath],
          worktreeRoots: [join(root, "worktrees")],
          registryRoot: registryRootDir,
          jobIdPrefixes: ["test-"],
          tmuxSessionPrefixes: ["test-"],
          allowedAccountIds: ["account-q"],
          authRoot: authRootDir,
        },
      });
      expect(controller, JSON.stringify(controller)).toMatchObject({ ok: true });
      const preview = await callToolJson(client, "codex_goal_project_refill_worker", {
        registryRootDir,
        controllerJobId: "test-controller",
        jobId: "test-child",
        authRootDir,
        sourceWorkspacePath,
        workspacePath: join(root, "worktrees", "test-child"),
        promptBody: "TEST preview only.\n",
        taskId: "test-child",
        accounts: ["account-q", "account-outside", "account-q"],
        modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
        workerRole: "producer",
        startWorker: false,
        executionMode: "sync",
      });
      expect(preview, JSON.stringify(preview)).toMatchObject({
        ok: false,
        reason: "confirm_refill_required",
        manifestPreview: {
          accounts: ["account-q"],
          modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
        },
      });
      await expect(projectControlRefillAccountNames({
        authRootDir,
        requestedAccounts: ["account-q"],
        allowedAccountIds: ["account-q"],
      })).resolves.toEqual([]);
      await expect(projectControlRefillAccountNames({
        authRootDir,
        modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
        requestedAccounts: [],
        allowedAccountIds: ["account-q"],
      })).resolves.toEqual([]);
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("still rejects a configured MiMo slot with durable blocked capacity at reservation", async () => {
    const root = await mkdtemp(join(tmpdir(), "TEST-project-refill-mimo-capacity-"));
    try {
      const base = fixture(root, "test-child");
      const authRootDir = base.launch.config.authRootDir;
      const now = new Date();
      codexAccountCapacityStore(authRootDir).observe({
        accountId: "account-q",
        observedAt: now,
        capacity: {
          availability: "quota_exhausted",
          reason: "quota_limited",
          cooldownUntil: new Date(now.getTime() + 60 * 60_000),
        },
      });
      const accounts = await projectControlRefillAccountNames({
        authRootDir,
        modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
        requestedAccounts: ["account-q"],
        allowedAccountIds: ["account-q"],
      });
      await expect(reserveCodexProjectAccount({
        manifest: {
          ...base.manifest,
          accounts,
          modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
        },
        launch: {
          ...base.launch,
          config: {
            ...base.launch.config,
            accounts: accounts.map((name) => ({ name })),
            modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
          },
        },
        deps: { leaseMode: "shared", now },
      })).rejects.toThrow("project_control_account_reservation_unavailable_until:");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
