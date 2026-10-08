import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import {
  AccessBoundary,
  NetworkAccessMode,
  type WorkerHealthSnapshot,
} from "@vioxen/subscription-runtime/worker-core";
import { createCodexGoalMcpServer } from "../codex-goal-mcp";
import {
  codexProjectControlBroker,
  loadJobLaunch,
  loadProjectControlController,
} from "../codex-goal-mcp-project-control-deps";
import {
  decideCodexGoalProjectStop,
  isCodexGoalProjectTerminalCapacityPause,
} from "../application/project-control/codex-goal-project-stop-policy";
import { callToolJson, hasTmux } from "./codex-goal-mcp-test-support";
import { inspectCodexGoalProcessSnapshot } from "../codex-goal-process-snapshot";

const execFileAsync = promisify(execFile);

describe("project worker stop policy", () => {
  it.each([
    { alive: false, silentStale: false, heartbeatOnlyNoOutput: false },
    { alive: true, silentStale: true, heartbeatOnlyNoOutput: false },
    { alive: true, silentStale: false, heartbeatOnlyNoOutput: true },
  ])("allows only terminalizable worker evidence: %o", (evidence) => {
    expect(
      decideCodexGoalProjectStop(workerHealth(evidence)),
    ).toEqual({ allowed: true });
  });

  it("denies an alive worker even when no positive health signal is available", () => {
    expect(
      decideCodexGoalProjectStop(workerHealth({
        alive: true,
        silentStale: false,
        heartbeatOnlyNoOutput: false,
      })),
    ).toMatchObject({
      allowed: false,
      reason: "project_control_fresh_worker_stop_denied",
      requiredState: "silent_stale_or_heartbeat_only_no_output",
    });
  });

  it("allows a broker-bound terminal capacity supervisor to be reaped", () => {
    expect(
      decideCodexGoalProjectStop({
        ...workerHealth(),
        terminalCapacityPause: true,
      }),
    ).toEqual({ allowed: true });
  });

  it("classifies runtime-preserved admitted input as a terminal capacity pause", () => {
    expect(isCodexGoalProjectTerminalCapacityPause(
      "admitted_input_patch_runtime_continuation",
    )).toBe(true);
    expect(isCodexGoalProjectTerminalCapacityPause(
      "reviewed_dirty_continuation",
    )).toBe(false);
  });

  it("does not let forceStop terminate a fresh live project worker", async () => {
    if (!(await hasTmux())) return;

    const root = await mkdtemp(join(tmpdir(), "project-stop-policy-"));
    const registryRootDir = join(root, "worker-jobs", "registry");
    const authRootDir = join(root, "auth");
    const controllerJobRoot = join(root, "worker-jobs", "project-controller");
    const controllerWorkspace = join(root, "workspaces", "project-controller");
    const childWorkspace = join(root, "worktrees", "project-child");
    const childJobRoot = join(root, "worker-jobs", "project-child");
    const tmuxSession = `project-child-${process.pid}-${Date.now()}`;
    const server = createCodexGoalMcpServer();
    const client = new Client({ name: "stop-policy-test", version: "0.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([
        mkdir(controllerWorkspace, { recursive: true }),
        mkdir(childWorkspace, { recursive: true }),
        mkdir(childJobRoot, { recursive: true }),
      ]);
      await execFileAsync("git", ["init"], { cwd: childWorkspace });
      await execFileAsync("git", [
        "-c",
        "user.name=Subscription Runtime Test",
        "-c",
        "user.email=test@subscription-runtime.invalid",
        "commit",
        "--allow-empty",
        "-m",
        "test base",
      ], { cwd: childWorkspace });
      await execFileAsync("tmux", [
        "new-session",
        "-d",
        "-s",
        tmuxSession,
        "-c",
        childWorkspace,
        "sleep 300",
      ]);
      const { stdout: workerPidOutput } = await execFileAsync("tmux", [
        "display-message", "-p", "-t", `${tmuxSession}:0.0`, "#{pane_pid}",
      ]);
      const workerPid = Number(workerPidOutput.trim());
      expect(Number.isSafeInteger(workerPid) && workerPid > 0).toBe(true);
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      await callToolJson(client, "codex_goal_create_job", {
        registryRootDir,
        jobId: "project-controller",
        jobRootDir: controllerJobRoot,
        authRootDir,
        workspacePath: controllerWorkspace,
        promptPath: join(controllerJobRoot, "prompt.md"),
        taskId: "project-controller",
        accounts: ["account-a"],
        accessBoundary: AccessBoundary.ProjectScopedControl,
        networkAccess: NetworkAccessMode.Restricted,
        projectAccessScope: {
          projectId: "project",
          workspaceRoots: [join(root, "workspaces")],
          worktreeRoots: [join(root, "worktrees")],
          registryRoot: registryRootDir,
          jobIdPrefixes: ["project-"],
          tmuxSessionPrefixes: ["project-"],
          allowedAccountIds: ["account-a"],
        },
      });
      await callToolJson(client, "codex_goal_project_create_job", {
        registryRootDir,
        controllerJobId: "project-controller",
        jobId: "project-child",
        jobRootDir: childJobRoot,
        authRootDir,
        workspacePath: childWorkspace,
        promptPath: join(childJobRoot, "prompt.md"),
        taskId: "project-child",
        accounts: ["account-a"],
        workerRole: "producer",
        tmuxSession,
        confirmCreate: true,
      });
      await writeFile(
        join(childJobRoot, "project-child.progress.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          taskId: "project-child",
          status: "running",
          pid: workerPid,
          updatedAt: new Date().toISOString(),
        })}\n`,
      );

      const result = await callToolJson(client, "codex_goal_project_stop", {
        registryRootDir,
        controllerJobId: "project-controller",
        jobId: "project-child",
        confirmStop: true,
        forceStop: true,
      });

      expect(result).toMatchObject({
        ok: false,
        reason: "project_control_fresh_worker_stop_denied",
        requiredState: "silent_stale_or_heartbeat_only_no_output",
        status: {
          tmuxAlive: true,
          progressStatus: "running",
          recommendedAction: "wait_for_worker",
        },
      });

      const controller = await loadProjectControlController({
        registryRootDir,
        controllerJobId: "project-controller",
      });
      const child = await loadJobLaunch({
        registryRootDir,
        jobId: "project-child",
      });
      const broker = codexProjectControlBroker({
        registryRootDir,
        controller: controller.controller,
        scope: controller.scope,
        stopLaunch: child.launch,
      });
      await expect(
        broker.stopWorker({
          jobId: "project-child",
          registryRoot: registryRootDir,
          workspacePath: child.launch.config.workspacePath,
          tmuxSession,
        }),
      ).rejects.toThrow("project_control_fresh_worker_stop_denied");

      await expect(
        execFileAsync("tmux", ["has-session", "-t", tmuxSession]),
      ).resolves.toBeDefined();
      await expect(
        readFile(join(childJobRoot, "project-child.progress.json"), "utf8"),
      ).resolves.toContain('"status":"running"');

      await writeFile(
        join(childJobRoot, "project-child.progress.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          taskId: "project-child",
          status: "running",
          pid: workerPid,
          updatedAt: new Date(Date.now() - 11 * 60_000).toISOString(),
        })}\n`,
      );
      await writeFile(join(childWorkspace, "safe-output.txt"), "preserve me\n");
      await execFileAsync("tmux", ["kill-session", "-t", tmuxSession]);
      // Missing tmux alone is not a process-absence proof. Retain the actual
      // fixture PID and wait for the same OS observation used by the stop guard.
      await expect.poll(() => inspectCodexGoalProcessSnapshot(workerPid), {
        timeout: 5_000,
      }).toMatchObject({ alive: false });
      await expect(
        broker.stopWorker({
          jobId: "project-child",
          registryRoot: registryRootDir,
          workspacePath: child.launch.config.workspacePath,
          tmuxSession,
        }),
      ).resolves.toMatchObject({
        status: "noop",
        evidence: {
          handoffPacketPath: expect.stringContaining(".packet"),
          handoffManifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      });
      await writeFile(join(childWorkspace, ".env"), "unsafe=secret\n");
      const forcedGoneBroker = codexProjectControlBroker({
        registryRootDir,
        controller: controller.controller,
        scope: controller.scope,
        stopLaunch: child.launch,
        forceStopAfterMaterializationFailure: true,
      });
      await expect(forcedGoneBroker.stopWorker({
        jobId: "project-child",
        registryRoot: registryRootDir,
        workspacePath: child.launch.config.workspacePath,
        tmuxSession,
      })).resolves.toMatchObject({
        status: "noop",
        evidence: {
          handoffPreservationError: expect.stringContaining(
            "handoff_sensitive_path_rejected",
          ),
          preservationDegraded: "true",
        },
      });
      await rm(join(childWorkspace, ".env"));
      await execFileAsync("tmux", [
        "new-session", "-d", "-s", tmuxSession, "-c", childWorkspace,
        "sleep 300",
      ]);
      const { stdout: restartedPidOutput } = await execFileAsync("tmux", [
        "display-message", "-p", "-t", `${tmuxSession}:0.0`, "#{pane_pid}",
      ]);
      const restartedPid = Number(restartedPidOutput.trim());
      expect(Number.isSafeInteger(restartedPid) && restartedPid > 0).toBe(true);
      await writeFile(join(childJobRoot, "project-child.progress.json"),
        `${JSON.stringify({ schemaVersion: 1, taskId: "project-child", status: "running",
          pid: restartedPid, updatedAt: new Date(Date.now() - 11 * 60_000).toISOString() })}\n`);
      await writeFile(join(childWorkspace, ".env"), "unsafe=secret\n");
      const degradedStop = await callToolJson(client, "codex_goal_project_stop", {
        registryRootDir,
        controllerJobId: "project-controller",
        jobId: "project-child",
        confirmStop: true,
        forceStop: true,
      });
      expect(degradedStop).toMatchObject({
        ok: true,
        mode: "project_control_stop",
        preservationDegraded: true,
        handoffPreservationError: expect.stringContaining(
          "handoff_sensitive_path_rejected",
        ),
      });
      const stopEvent = JSON.parse(
        await readFile(String(degradedStop.stopEventPath), "utf8"),
      );
      expect(stopEvent).toMatchObject({
        forceStop: true,
        handoffPreservationError: degradedStop.handoffPreservationError,
      });
      expect(stopEvent).not.toHaveProperty("handoffPacketPath");
      await expect(
        execFileAsync("tmux", ["has-session", "-t", tmuxSession]),
      ).rejects.toBeDefined();
    } finally {
      await execFileAsync("tmux", ["kill-session", "-t", tmuxSession]).catch(
        () => undefined,
      );
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

function workerHealth(
  overrides: Partial<WorkerHealthSnapshot> = {},
): WorkerHealthSnapshot {
  return {
    alive: true,
    freshProgressAlive: true,
    stale: false,
    silentStale: false,
    heartbeatOnlyNoOutput: false,
    blocked: true,
    safeToContinue: false,
    liveness: "alive",
    progressFreshness: "fresh",
    activeWriterRisk: {
      kind: "active_worker",
      risky: true,
      reasons: ["worker_alive"],
    },
    reasons: ["worker_alive"],
    evidence: [],
    ...overrides,
  };
}
