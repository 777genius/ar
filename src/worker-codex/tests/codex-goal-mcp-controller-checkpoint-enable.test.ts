import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { AccessBoundary, NetworkAccessMode } from "@vioxen/subscription-runtime/worker-core";
import { createCodexGoalMcpServer } from "../codex-goal-mcp";
import {
  codexGoalJobManifestPath,
  codexGoalJobToArgs,
  readCodexGoalJob,
  updateCodexGoalJob,
} from "../codex-goal-jobs";
import { goalLaunchInput } from "../codex-goal-mcp-launch-input";
import { bindProjectChildCheckpointPublisher } from "../codex-goal-mcp-project-broker";
import { withCurrentControllerLaunchPolicy } from "../codex-goal-mcp-project-controller-launch-policy";
import { callToolJson } from "./codex-goal-mcp-test-support";

async function withSyntheticController(
  test: (input: {
    client: Client;
    root: string;
    registryRootDir: string;
    controllerJobId: string;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "controller-checkpoint-enable-TEST-"));
  const registryRootDir = join(root, "registry");
  const controllerJobId = "test-controller-v1";
  const server = createCodexGoalMcpServer();
  const client = new Client({ name: "checkpoint-enable-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const created = await callToolJson(client, "codex_goal_create_job", {
      registryRootDir,
      jobId: controllerJobId,
      jobRootDir: join(root, "jobs", controllerJobId),
      authRootDir: join(root, "auth"),
      workspacePath: join(root, "workspaces", "controller"),
      promptPath: join(root, "jobs", controllerJobId, "prompt.md"),
      taskId: controllerJobId,
      accounts: ["account-a"],
      accessBoundary: AccessBoundary.ProjectScopedControl,
      networkAccess: NetworkAccessMode.Restricted,
      projectAccessScope: {
        projectId: "test-project",
        registryRoot: registryRootDir,
        workspaceRoots: [join(root, "workspaces")],
        worktreeRoots: [join(root, "worktrees")],
        jobIdPrefixes: ["test-"],
        tmuxSessionPrefixes: ["test-"],
        allowedAccountIds: ["account-a"],
      },
    });
    expect(created).toMatchObject({ ok: true });
    await test({ client, root, registryRootDir, controllerJobId });
  } finally {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}

describe("existing controller checkpoint enable repair", () => {
  it("serializes policy publication with an old unmarked child launch", async () => {
    await withSyntheticController(async ({ client, root, registryRootDir, controllerJobId }) => {
      const childJobId = "test-child-before-checkpoint";
      const created = await callToolJson(client, "codex_goal_project_create_job", {
        registryRootDir, controllerJobId, jobId: childJobId,
        jobRootDir: join(root, "jobs", childJobId),
        authRootDir: join(root, "auth"),
        workspacePath: join(root, "worktrees", childJobId),
        promptPath: join(root, "jobs", childJobId, "prompt.md"),
        taskId: childJobId, accounts: ["account-a"], confirmCreate: true,
      });
      expect(created).toMatchObject({ ok: true });
      const staleController = await readCodexGoalJob({ registryRootDir, jobId: controllerJobId });
      const child = await readCodexGoalJob({ registryRootDir, jobId: childJobId });
      expect(child.checkpointRequired).toBeUndefined();
      const launch = await goalLaunchInput(codexGoalJobToArgs(child));
      const scope = staleController.projectAccessScope!;
      const loadCurrentController = async () => {
        const controller = await readCodexGoalJob({ registryRootDir, jobId: controllerJobId });
        return { registryRootDir, controller, scope: controller.projectAccessScope! };
      };
      const repairArgs = { registryRootDir, controllerJobId, jobId: controllerJobId,
        checkpointRequired: true };
      const preview = await callToolJson(client, "brokered_project_manifest_repair", repairArgs);

      // Pause the child launch effect after binding its command. Publication
      // cannot overtake an effect that still holds the policy lock.
      let entered!: () => void;
      let finish!: () => void;
      const atLaunch = new Promise<void>((resolve) => { entered = resolve; });
      const finishLaunch = new Promise<void>((resolve) => { finish = resolve; });
      const start = withCurrentControllerLaunchPolicy({
        registryRootDir, controllerJobId, expectedScope: scope, loadCurrentController,
        effect: async (current) => {
          const bound = bindProjectChildCheckpointPublisher({
            launch, controllerCheckpointRequired: current.checkpointRequired === true,
            childCheckpointRequired: child.checkpointRequired === true, hostEnv: {},
          });
          entered();
          await finishLaunch;
          return bound;
        },
      });
      await atLaunch;
      try {
        const concurrentRepair = await callToolJson(client, "brokered_project_manifest_repair", {
          ...repairArgs, confirmRepair: true,
          expectedManifestSha256: preview.expectedManifestSha256,
        });
        expect(concurrentRepair).toMatchObject({ ok: false,
          error: expect.stringContaining("Workspace is already locked") });
        expect((await readCodexGoalJob({ registryRootDir, jobId: controllerJobId }))
          .checkpointRequired).toBeUndefined();
      } finally {
        finish();
      }
      expect((await start).config.checkpointRequired).toBeUndefined();

      const enabled = await callToolJson(client, "brokered_project_manifest_repair", {
        ...repairArgs, confirmRepair: true,
        expectedManifestSha256: preview.expectedManifestSha256,
      });
      expect(enabled).toMatchObject({ ok: true, manifest: { checkpointRequired: true } });
      // The child and original controller objects are still unmarked. A start
      // arriving after publication must use the reloaded controller policy.
      await expect(withCurrentControllerLaunchPolicy({
        registryRootDir, controllerJobId, expectedScope: scope, loadCurrentController,
        effect: async (current) => bindProjectChildCheckpointPublisher({
          launch, controllerCheckpointRequired: current.checkpointRequired === true,
          childCheckpointRequired: child.checkpointRequired === true, hostEnv: {},
        }),
      })).rejects.toThrow("checkpoint_publisher_required");
    });
  });

  it("previews without publication, then enables inherited child policy and requires a Host socket", async () => {
    await withSyntheticController(async ({ client, root, registryRootDir, controllerJobId }) => {
      const args = { registryRootDir, controllerJobId, jobId: controllerJobId,
        checkpointRequired: true };
      const path = codexGoalJobManifestPath({ registryRootDir, jobId: controllerJobId });
      const before = await readFile(path);
      const preview = await callToolJson(client, "brokered_project_manifest_repair", args);
      expect(preview).toMatchObject({ ok: false, reason: "confirm_repair_required",
        proposedPatch: { checkpointRequired: true },
        expectedManifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
      expect(await readFile(path)).toEqual(before);
      expect(await callToolJson(client, "brokered_project_manifest_repair", {
        ...args, checkpointRequired: true, confirmRepair: true,
      })).toMatchObject({ ok: false,
        error: "project_control_repair_expected_manifest_sha256_required" });

      const confirmed = await callToolJson(client, "brokered_project_manifest_repair", {
        ...args, expectedManifestSha256: preview.expectedManifestSha256, confirmRepair: true,
      });
      expect(confirmed).toMatchObject({ ok: true, manifest: { checkpointRequired: true } });
      const controller = await readCodexGoalJob({ registryRootDir, jobId: controllerJobId });
      expect(controller).toMatchObject({ checkpointRequired: true,
        projectAccessScope: { projectId: "test-project", jobIdPrefixes: ["test-"] } });
      expect(JSON.parse(await readFile(path, "utf8"))).not.toHaveProperty("checkpointPublisherSocketPath");
      const alreadyEnabled = await callToolJson(client, "brokered_project_manifest_repair", args);
      expect(alreadyEnabled).toMatchObject({ ok: true, reason: "no_repair_needed" });

      const childJobId = "test-child-v1";
      const created = await callToolJson(client, "codex_goal_project_create_job", {
        registryRootDir, controllerJobId, jobId: childJobId,
        jobRootDir: join(root, "jobs", childJobId),
        authRootDir: join(root, "auth"),
        workspacePath: join(root, "worktrees", childJobId),
        promptPath: join(root, "jobs", childJobId, "prompt.md"),
        taskId: childJobId, accounts: ["account-a"], confirmCreate: true,
      });
      if (!created.ok) throw new Error(JSON.stringify(created));
      expect(created).toMatchObject({ ok: true, manifest: { checkpointRequired: true } });
      const child = await readCodexGoalJob({ registryRootDir, jobId: childJobId });
      expect(child.checkpointRequired).toBe(true);
      expect(JSON.parse(await readFile(codexGoalJobManifestPath({ registryRootDir,
        jobId: childJobId }), "utf8"))).not.toHaveProperty("checkpointPublisherSocketPath");
      const launch = await goalLaunchInput(codexGoalJobToArgs(child));
      await expect(Promise.resolve().then(() => bindProjectChildCheckpointPublisher({
        launch, controllerCheckpointRequired: controller.checkpointRequired === true,
        childCheckpointRequired: child.checkpointRequired === true, hostEnv: {},
      }))).rejects.toThrow("checkpoint_publisher_required");
      const bound = bindProjectChildCheckpointPublisher({
        launch, controllerCheckpointRequired: true, childCheckpointRequired: true,
        hostEnv: { SUBSCRIPTION_RUNTIME_CHECKPOINT_PUBLISHER_SOCKET:
          join(root, "trusted-host.sock") },
      });
      expect(bound.config).toMatchObject({ checkpointRequired: true,
        checkpointPublisherSocketPath: join(root, "trusted-host.sock") });
    });
  });

  it("rejects missing, false, mixed and child policy input, and rejects stale preview revisions", async () => {
    await withSyntheticController(async ({ client, root, registryRootDir, controllerJobId }) => {
      const args = { registryRootDir, controllerJobId, jobId: controllerJobId };
      const path = codexGoalJobManifestPath({ registryRootDir, jobId: controllerJobId });
      const before = await readFile(path);
      for (const [input, error] of [
        [{}, "project_control_repair_checkpoint_required_true_only"],
        [{ checkpointRequired: false }, "project_control_repair_checkpoint_required_true_only"],
        [{ checkpointRequired: true, description: "mixed" },
          "project_control_repair_controller_fields_mixed"],
        [{ checkpointRequired: true, accounts: ["account-a"] },
          "project_control_repair_controller_fields_mixed"],
      ] as const) {
        expect(await callToolJson(client, "brokered_project_manifest_repair", {
          ...args, ...input, confirmRepair: true,
        })).toMatchObject({ ok: false, error });
      }
      expect(await readFile(path)).toEqual(before);

      const childJobId = "test-child-v1";
      const childCreated = await callToolJson(client, "codex_goal_project_create_job", {
        registryRootDir, controllerJobId, jobId: childJobId,
        authRootDir: join(root, "auth"),
        workspacePath: join(root, "worktrees", childJobId),
        taskId: childJobId, accounts: ["account-a"], confirmCreate: true,
      });
      if (!childCreated.ok) throw new Error(JSON.stringify(childCreated));
      expect(childCreated).toMatchObject({ ok: true });
      for (const checkpointRequired of [true, false]) {
        expect(await callToolJson(client, "brokered_project_manifest_repair", {
          registryRootDir, controllerJobId, jobId: childJobId, checkpointRequired,
          confirmRepair: true,
        })).toMatchObject({ ok: false,
          error: "project_control_repair_child_checkpoint_policy_denied" });
      }

      const preview = await callToolJson(client, "brokered_project_manifest_repair", {
        ...args, checkpointRequired: true,
      });
      await updateCodexGoalJob({ registryRootDir, jobId: controllerJobId,
        patch: { description: "concurrent scope owner update" } });
      expect(await callToolJson(client, "brokered_project_manifest_repair", {
        ...args, checkpointRequired: true, confirmRepair: true,
        expectedManifestSha256: preview.expectedManifestSha256,
      })).toMatchObject({ ok: false, error: "project_control_controller_scope_cas_mismatch" });
      expect(await readCodexGoalJob({ registryRootDir, jobId: controllerJobId }))
        .toMatchObject({ description: "concurrent scope owner update" });
      expect((await readCodexGoalJob({ registryRootDir,
        jobId: controllerJobId })).checkpointRequired).toBeUndefined();
    });
  });
});
