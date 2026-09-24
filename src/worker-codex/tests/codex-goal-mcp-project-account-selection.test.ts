import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import {
  AccessBoundary,
  InMemoryWorkerAccountCapacityStore,
  InMemoryWorkerAccountLeaseStore,
  NetworkAccessMode,
} from "@vioxen/subscription-runtime/worker-core";
import { createCodexGoalMcpServer } from "../codex-goal-mcp";
import {
  CodexGoalAccountSelectionMode,
  readCodexGoalJob,
  type CodexGoalJobManifest,
} from "../codex-goal-jobs";
import { reserveCodexProjectAccount } from
  "../application/project-control/codex-goal-project-account-reservation";
import { codexAccountCapacityStore } from
  "../application/codex-account-capacity-store";
import { callToolJson, fakeJwt, writeFakeAuth } from "./codex-goal-mcp-test-support";

describe("project-control account selection through the broker", () => {
  it("persists explicit order through create and reservation while rotating omitted and legacy pools", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-account-order-e2e-"));
    const registryRootDir = join(root, "jobs", "registry");
    const authRootDir = join(root, "auth");
    const accountIds = ["account-o", "account-p", "account-q", "account-v"];
    const server = createCodexGoalMcpServer();
    const client = new Client({ name: "account-order-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all(accountIds.map((id) => writeFakeAuth(authRootDir, id, {
        lastRefresh: new Date().toISOString(),
      })));
      await Promise.all(accountIds.map(async (id) => {
        const path = join(authRootDir, id, "auth.json");
        const auth = JSON.parse(await readFile(path, "utf8")) as {
          tokens: { id_token: string };
        };
        auth.tokens.id_token = fakeJwt({
          email: `${id}@example.test`,
          sub: `oauth-${id}`,
          "https://api.openai.com/auth": {
            chatgpt_account_id: `chatgpt-${id}`,
            chatgpt_user_id: `user-${id}`,
          },
        });
        await writeFile(path, JSON.stringify(auth));
      }));
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const controller = await callToolJson(client, "codex_goal_create_job", {
        registryRootDir,
        jobId: "job-controller",
        jobRootDir: join(root, "jobs", "job-controller"),
        authRootDir,
        workspacePath: join(root, "workspaces", "controller"),
        promptPath: join(root, "jobs", "job-controller", "prompt.md"),
        taskId: "job-controller",
        accounts: ["account-v"],
        accessBoundary: AccessBoundary.ProjectScopedControl,
        networkAccess: NetworkAccessMode.Restricted,
        projectAccessScope: {
          projectId: "synthetic",
          workspaceRoots: [join(root, "workspaces")],
          worktreeRoots: [join(root, "worktrees")],
          registryRoot: registryRootDir,
          jobIdPrefixes: ["job-"],
          tmuxSessionPrefixes: ["job-"],
          allowedAccountIds: accountIds,
        },
      });
      expect(controller, JSON.stringify(controller)).toMatchObject({ ok: true });
      const create = async (jobId: string, accounts?: string[]) => {
        const created = await callToolJson(client, "codex_goal_project_create_job", {
          registryRootDir,
          controllerJobId: "job-controller",
          jobId,
          jobRootDir: join(root, "jobs", jobId),
          authRootDir,
          workspacePath: join(root, "worktrees", jobId),
          promptPath: join(root, "jobs", jobId, "prompt.md"),
          taskId: jobId,
          ...(accounts ? { accounts } : {}),
          confirmCreate: true,
        });
        expect(created, JSON.stringify(created)).toMatchObject({ ok: true });
        return await readCodexGoalJob({ registryRootDir, jobId });
      };
      const capacityStore = new InMemoryWorkerAccountCapacityStore();
      const leaseStore = new InMemoryWorkerAccountLeaseStore();
      const reserve = async (
        manifest: CodexGoalJobManifest,
        leaseMode: "shared" | "exclusive" = "shared",
        excludedAccountIds: readonly string[] = [],
        continuation?: { previousAttemptCount: number },
      ) => reserveCodexProjectAccount({
        manifest,
        launch: {
          config: {
            jobId: manifest.jobId,
            jobRootDir: manifest.jobRootDir,
            authRootDir,
            workspacePath: manifest.workspacePath,
            promptPath: manifest.promptPath,
            taskId: manifest.taskId,
            accounts: manifest.accounts.map((name) => ({ name })),
          },
          tmuxSession: manifest.jobId,
          cwd: manifest.workspacePath,
          logPath: join(manifest.jobRootDir, "worker.log"),
          cliCommand: ["node", "synthetic.js"],
        },
        excludedAccountIds,
        ...(continuation ? { continuation } : {}),
        deps: {
          capacityStore,
          leaseStore,
          leaseMode,
          now: new Date("2026-09-24T00:00:00.000Z"),
        },
      });

      const explicit = await create("job-1", ["account-v", "account-o"]);
      expect(explicit.accounts).toEqual(["account-v", "account-o"]);
      expect(explicit.accountSelectionMode).toBe(CodexGoalAccountSelectionMode.Explicit);
      expect((await reserve(explicit)).accountId).toBe("account-v");
      expect((await reserve(explicit, "exclusive")).accountId).toBe("account-v");
      expect((await reserve(explicit, "exclusive", ["account-v"], {
        previousAttemptCount: 1,
      })).accountId).toBe("account-o");

      const onlyV = await create("job-6", ["account-v"]);
      expect(onlyV.accounts).toEqual(["account-v"]);
      expect(onlyV.accountSelectionMode).toBe(CodexGoalAccountSelectionMode.Explicit);
      expect((await reserve(onlyV)).accountId).toBe("account-v");

      const omitted = await create("job-2");
      expect(omitted.accountSelectionMode).toBe(CodexGoalAccountSelectionMode.Automatic);
      expect(omitted.accounts).toHaveLength(4);
      expect((await reserve(omitted)).accountId).toBe(omitted.accounts[2]);

      const { accountSelectionMode: _selectionMode, ...legacy } = explicit;
      expect((await reserve(legacy)).accountId).toBe("account-o");

      codexAccountCapacityStore(authRootDir).observe({
        accountId: "account-v",
        observedAt: new Date(),
        capacity: {
          availability: "quota_exhausted",
          reason: "quota_limited",
          cooldownUntil: new Date(Date.now() + 60 * 60_000),
        },
      });
      const blocked = await create("job-3", ["account-v", "account-o"]);
      expect(blocked.accounts).toEqual(["account-o"]);
      expect(blocked.accountSelectionMode).toBe(CodexGoalAccountSelectionMode.Explicit);
      expect((await reserve(blocked)).accountId).toBe("account-o");
      const fallback = await create("job-4", ["account-v"]);
      expect(fallback.accountSelectionMode).toBe(CodexGoalAccountSelectionMode.Automatic);
      expect(fallback.accounts).not.toContain("account-v");
      expect(fallback.accounts).toHaveLength(3);

      const denied = await callToolJson(client, "codex_goal_project_create_job", {
        registryRootDir,
        controllerJobId: "job-controller",
        jobId: "job-5",
        jobRootDir: join(root, "jobs", "job-5"),
        authRootDir,
        workspacePath: join(root, "worktrees", "job-5"),
        accounts: ["account-outside-scope"],
        confirmCreate: true,
      });
      expect(denied).toMatchObject({
        ok: false,
        error: "project_control_denied:account_denied",
      });
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps an explicit project-control child account despite a ready pool", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-project-accounts-"));
    const registryRootDir = join(root, "worker-jobs", "registry");
    const authRootDir = join(root, "auth");
    const controllerJobRoot = join(root, "worker-jobs", "infinity-context-controller-v1");
    const controllerWorkspace = join(root, "workspaces", "infinity-context-controller");
    const childWorkspace = join(root, "worktrees", "infinity-context-child-v1");
    const childJobRoot = join(root, "worker-jobs", "infinity-context-child-v1");
    const server = createCodexGoalMcpServer();
    const client = new Client({
      name: "subscription-runtime-test",
      version: "0.0.0",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      await writeFakeAuth(authRootDir, "account-a", {
        lastRefresh: new Date().toISOString(),
      });
      await writeFakeAuth(authRootDir, "account-b", {
        lastRefresh: new Date().toISOString(),
      });

      await callToolJson(client, "codex_goal_create_job", {
        registryRootDir,
        jobId: "infinity-context-controller-v1",
        jobRootDir: controllerJobRoot,
        authRootDir,
        workspacePath: controllerWorkspace,
        promptPath: join(controllerJobRoot, "prompt.md"),
        taskId: "infinity-context-controller-v1",
        accounts: ["account-a"],
        accessBoundary: AccessBoundary.ProjectScopedControl,
        networkAccess: NetworkAccessMode.Restricted,
        projectAccessScope: {
          projectId: "infinity-context",
          workspaceRoots: [join(root, "workspaces")],
          worktreeRoots: [join(root, "worktrees")],
          registryRoot: registryRootDir,
          jobIdPrefixes: ["infinity-context-"],
          tmuxSessionPrefixes: ["infinity-context-"],
          allowedAccountIds: ["account-a", "account-b"],
        },
      });

      const created = await callToolJson(client, "codex_goal_project_create_job", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        jobId: "infinity-context-child-v1",
        jobRootDir: childJobRoot,
        authRootDir,
        workspacePath: childWorkspace,
        promptPath: join(childJobRoot, "prompt.md"),
        taskId: "infinity-context-child-v1",
        accounts: ["account-a"],
        confirmCreate: true,
      });

      expect(created).toMatchObject({
        ok: true,
        manifest: {
          accounts: ["account-a"],
        },
      });
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

});
