import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  acquireLocalControllerMaintenanceFence,
  acquireLocalControllerActivityLease,
  releaseLocalControllerActivityLease,
  releaseLocalControllerMaintenanceFence,
} from "@vioxen/subscription-runtime/store-local-file";
import {
  acquireConsumedOutputLedgerMaintenanceLock,
  releaseConsumedOutputLedgerMaintenanceLock,
} from "../../worker-local/consumed-output-ledger-maintenance-lock";
import {
  createOrReuseProjectControlOperation,
  createProjectControlOperation,
  projectControlOperationsRoot,
  runProjectControlOperationFile,
} from "../project-control-operation-lifecycle";
import {
  projectControlStartStoredJobView,
  type CodexGoalMcpProjectControlActionsDeps,
} from "../codex-goal-mcp-project-control-actions";
import {
  projectControlCreateCodexGoalJobView,
  type CodexGoalMcpProjectControlJobsDeps,
} from "../codex-goal-mcp-project-control-jobs";

describe("controller maintenance fence", () => {
  it("allows only one contender to replace a dead maintenance fence", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-dead-fence-"));
    const path = join(root, ".controller-maintenance-fence.json");
    const deadBytes = `${JSON.stringify({
      schemaVersion: 1,
      owner: "dead",
      ownerToken: "dead-owner",
      pid: 2_147_483_647,
      processStartIdentity: "dead-process",
      createdAt: "2026-08-08T00:00:00.000Z",
    })}\n`;
    await writeFile(path, deadBytes);
    await link(path, `${path}.stale-${sha256(deadBytes)}`);
    try {
      const results = await Promise.allSettled(["a", "b"].map(async (owner) =>
        await acquireLocalControllerMaintenanceFence({
          controllerJobRootDir: root,
          owner,
        })
      ));
      const acquired = results.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : []
      );
      expect(acquired).toHaveLength(1);
      await releaseLocalControllerMaintenanceFence(acquired[0]!);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows only one contender to replace a dead ledger lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-dead-ledger-lock-"));
    const ledgerRoot = join(root, "ledgers", "v1");
    await mkdir(ledgerRoot, { recursive: true });
    const path = join(root, ".consumed-output-ledger-maintenance.lock");
    const deadBytes = `${JSON.stringify({
        schemaVersion: 1,
        owner: "dead",
        ownerToken: "dead-owner",
        pid: 2_147_483_647,
        processStartIdentity: "dead-process",
        createdAt: "2026-08-08T00:00:00.000Z",
      })}\n`;
    await writeFile(path, deadBytes);
    await link(path, `${path}.stale-${sha256(deadBytes)}`);
    try {
      const results = await Promise.allSettled(["a", "b"].map(async (owner) =>
        await acquireConsumedOutputLedgerMaintenanceLock({ ledgerRoot, owner })
      ));
      const acquired = results.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : []
      );
      expect(acquired).toHaveLength(1);
      await releaseConsumedOutputLedgerMaintenanceLock(acquired[0]!);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails maintenance closed while a durable controller activity is active", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-activity-fence-"));
    const activity = await acquireLocalControllerActivityLease({
      controllerJobRootDir: root,
      owner: "active-operation",
    });
    try {
      await expect(acquireLocalControllerMaintenanceFence({
        controllerJobRootDir: root,
        owner: "ledger-epoch-test",
      })).rejects.toThrow("controller_maintenance_activity_active");
    } finally {
      await releaseLocalControllerActivityLease(activity);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks operation publication and execution while maintenance is fenced", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-operation-fence-"));
    const operationsRootDir = projectControlOperationsRoot(root);
    const input = {
      operationsRootDir,
      controllerJobId: "controller-v1",
      toolName: "codex_goal_project_refill_worker" as const,
      targetJobId: "worker-v1",
      args: { jobId: "worker-v1" },
    };
    const queued = await createProjectControlOperation(input);
    const fence = await acquireLocalControllerMaintenanceFence({
      controllerJobRootDir: root,
      owner: "ledger-epoch-test",
    });
    try {
      await expect(createOrReuseProjectControlOperation({
        ...input,
        args: { jobId: "worker-v2" },
      })).rejects.toThrow("controller_maintenance_fence_active");
      await expect(runProjectControlOperationFile({
        operationFilePath: queued.operationFilePath,
        invokeTool: async () => ({ ok: true }),
      })).rejects.toThrow("controller_maintenance_fence_active");
    } finally {
      await releaseLocalControllerMaintenanceFence(fence);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("denies a worker launch before reading or starting the child job", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-launch-fence-"));
    const fence = await acquireLocalControllerMaintenanceFence({
      controllerJobRootDir: root,
      owner: "ledger-epoch-test",
    });
    let childRead = false;
    const deps = {
      loadProjectControlController: async () => ({
        registryRootDir: join(root, "registry"),
        controller: { jobId: "controller-v1", jobRootDir: root },
        scope: { projectId: "test" },
      }),
      readProjectControlStoredJob: async () => {
        childRead = true;
        throw new Error("child_should_not_be_read");
      },
    } as unknown as CodexGoalMcpProjectControlActionsDeps;
    try {
      await expect(projectControlStartStoredJobView({ jobId: "worker-v1" }, deps))
        .rejects.toThrow("controller_maintenance_fence_active");
      expect(childRead).toBe(false);
    } finally {
      await releaseLocalControllerMaintenanceFence(fence);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("denies direct confirmed child creation while maintenance is fenced", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-create-fence-"));
    const registryRootDir = join(root, "registry");
    const controllerJobRootDir = join(root, "controller-v1");
    const workspaceRoot = join(root, "worktrees");
    await mkdir(workspaceRoot, { recursive: true });
    const scope = {
      projectId: "test",
      workspaceRoots: [workspaceRoot],
      worktreeRoots: [workspaceRoot],
      registryRoot: registryRootDir,
      jobIdPrefixes: ["worker-"],
      allowedAccountIds: ["account-a"],
    };
    const controller = {
      schemaVersion: 1,
      jobId: "controller-v1",
      createdAt: "2026-08-08T00:00:00.000Z",
      updatedAt: "2026-08-08T00:00:00.000Z",
      jobRootDir: controllerJobRootDir,
      workspacePath: join(root, "controller-workspace"),
      promptPath: join(controllerJobRootDir, "prompt.md"),
      taskId: "controller-v1",
      accounts: ["account-a"],
    } as const;
    let brokerCreated = false;
    const deps = {
      loadProjectControlController: async () => ({
        registryRootDir,
        controller,
        scope,
      }),
      codexProjectControlBroker: () => {
        brokerCreated = true;
        throw new Error("broker_must_not_be_created");
      },
    } as unknown as CodexGoalMcpProjectControlJobsDeps;
    const fence = await acquireLocalControllerMaintenanceFence({
      controllerJobRootDir,
      owner: "ledger-epoch-test",
    });
    try {
      await expect(projectControlCreateCodexGoalJobView({
        jobId: "worker-v1",
        workspacePath: join(workspaceRoot, "worker-v1"),
        promptPath: join(root, "worker-v1", "prompt.md"),
        taskId: "worker-v1",
        accounts: ["account-a"],
        confirmCreate: true,
      }, deps)).rejects.toThrow("controller_maintenance_fence_active");
      expect(brokerCreated).toBe(false);
    } finally {
      await releaseLocalControllerMaintenanceFence(fence);
      await rm(root, { recursive: true, force: true });
    }
  });
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
