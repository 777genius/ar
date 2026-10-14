import { changedFilesFromWorkspace } from "../codex-goal-workspace-changes";
import { initializeControllerStateOrigin } from "../application/project-control/codex-goal-controller-state-location";
import { routeHostedGoalLaunch } from "../hosted-readonly-goal-launch";
import "./absent-host-readonly-authority-fixture";
import "./unmanaged-goal-host-fixture";
import { execFile } from "node:child_process";
import * as nodeFs from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccessBoundary, NetworkAccessMode, WorkerMode } from "@vioxen/subscription-runtime/worker-core";
import { goalLaunchInput } from "../application/codex-goal-launch-input";
import { createCodexGoalJob, readCodexGoalJob, codexGoalJobToArgs } from "../codex-goal-jobs";
import { prepareWorkerToolRoot, WorkerToolRootStatus } from "../worker-tool-root";
import { codexGoalAccountSlots, codexGoalProgressPath, codexGoalRuntimeEventsPath, runCodexGoal, type CodexGoalRunConfig, type CodexGoalRunDeps,
  type CodexGoalExecutor } from "../codex-goal-runner";
import { createLinkedGitWorktree, readJsonLines } from "./codex-goal-runner-fixtures";

// This suite models an unmanaged machine. Project only fixed host-policy
// discovery into actual absent TEST paths; keep origin, storage and access
// decisions real. Finite proc facts describe an unmanaged user namespace and
// cannot issue an initial-root birth; no installed host private state is read.
const unmanagedHost = vi.hoisted(() => ({ root: "" }));
vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>();
  const local = (path: unknown) => {
    if (typeof path !== "string") return path;
    for (const [base, name] of [["/etc/subscription-runtime", "etc"],
      ["/var/lib/subscription-runtime-host-policy", "policy"], ["/run/user/0", "volatile"]] as const) {
      if (path === base || path.startsWith(base + "/")) {
        if (!unmanagedHost.root) throw new Error("TEST unmanaged host fixture not initialized");
        return unmanagedHost.root + "/absent-" + name + path.slice(base.length);
      }
    }
    return path;
  };
  return { ...actual,
    lstatSync: ((path, ...args) => Reflect.apply(actual.lstatSync, actual, [local(path), ...args])) as typeof actual.lstatSync,
    readFileSync: ((path, ...args) => {
      const fact = path === "/proc/self/cgroup" ? "0::/\n"
        : path === "/proc/self/uid_map" || path === "/proc/self/gid_map" ? "0 100000 65536\n" : undefined;
      return fact === undefined ? Reflect.apply(actual.readFileSync, actual, [path, ...args])
        : args[0] === "utf8" ? fact : Buffer.from(fact);
    }) as typeof actual.readFileSync,
  };
});
beforeEach(() => {
  unmanagedHost.root = nodeFs.mkdtempSync(join(tmpdir(), "TEST-unmanaged-runner-host-"));
  vi.stubEnv("SUBSCRIPTION_RUNTIME_SANDBOX_KIND", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  nodeFs.rmSync(unmanagedHost.root, { recursive: true, force: true }); unmanagedHost.root = "";
});

const execFileAsync = promisify(execFile);
describe("codex goal runner worker mode", () => {
  // Native owner-side status must not execute workspace-controlled fsmonitor.
  it.skipIf(process.platform !== "linux")("collects host workspace changes without executing Git fsmonitor", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "TEST-host-git-status-")));
    const workspace = join(root, "workspace"), marker = join(root, "escaped"), hook = join(root, "fsmonitor");
    try {
      await mkdir(workspace);
      await execFileAsync("git", ["init", "--quiet", workspace]);
      await writeFile(hook, "#!/bin/sh\nprintf escaped > '" + marker.replaceAll("'", "'\\''") + "'\n");
      await chmod(hook, 0o700);
      await execFileAsync("git", ["-C", workspace, "config", "core.fsmonitor", hook]);
      await writeFile(join(workspace, "change.txt"), "TEST change\n");
      expect(await changedFilesFromWorkspace(workspace, true)).toEqual({ changedFiles: ["change.txt"] });
      await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  // Regression: a forged raw boundary/env must not turn a controller's
  // protected never-started origin into a writable raw job at either entry.
  it.skipIf(process.platform !== "linux").each(["runner", "foreground"] as const)("denies raw %s over a controller origin before runtime writes", async entry => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "TEST-controller-raw-origin-")));
    const config: CodexGoalRunConfig = {
      jobId: "TEST-controller", taskId: "TEST-controller", jobRootDir: join(root, "job"),
      workspacePath: join(root, "workspace"), authRootDir: join(root, "auth"),
      promptPath: join(root, "prompt.md"), accounts: codexGoalAccountSlots(["account-a"]),
      accessBoundary: AccessBoundary.IsolatedWorkspaceWrite,
      projectAccessScope: { projectId: "TEST-controller", workspaceRoots: [join(root, "workspace")], isolatedWorkspaceRoot: join(root, "workspace") },
      sourceEnv: { SUBSCRIPTION_RUNTIME_PROJECT_CONTROL_BROKERED_START: "1" },
    };
    try {
      await initializeControllerStateOrigin({
        schemaVersion: 1, jobId: config.jobId!, taskId: config.taskId,
        jobRootDir: config.jobRootDir, workspacePath: config.workspacePath, promptPath: config.promptPath,
        accounts: ["account-a"], createdAt: "2026-10-10T00:00:00.000Z", updatedAt: "2026-10-10T00:00:00.000Z",
      });
      const origin = join(config.jobRootDir, ".controller-state-origin.json");
      const before = await readFile(origin);
      let executorCalls = 0;
      const attempt = entry === "runner"
        ? runCodexGoal(config, { createExecutor: () => { executorCalls++; throw new Error("unexpected executor"); } })
        : routeHostedGoalLaunch({ config, cliCommand: ["node", "unused-cli.js"], cwd: root, logPath: join(config.jobRootDir, "log") });
      await expect(attempt).rejects.toThrow("controller_origin_raw_launch_denied");
      expect(executorCalls).toBe(0);
      expect(await readFile(origin)).toEqual(before);
      await expect(readFile(codexGoalProgressPath(config))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(codexGoalRuntimeEventsPath(config))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  // Binding: real manifest/launch/tool-root/runner composition. Host admission
  // and OS discovery are synthetic; executor forwarding is not OS enforcement.
  it("binds open manifest evidence, executor launch and private roots without strict handoff warnings", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-goal-open-TEST-"));
    const workspacePath = join(root, "worker");
    const registryRootDir = join(root, "job-registry");
    const privateRoots = [
      join(root, "accounts", "auth"),
      join(root, "scope-accounts", "auth"),
      join(root, "scope-jobs", "registry"),
    ];
    try {
      await createLinkedGitWorktree(root, workspacePath);
      const manifest = await createCodexGoalJob({ registryRootDir, manifest: {
        jobId: "TEST-open-runner", taskId: "TEST-open-runner",
        jobRootDir: join(root, "job"), authRootDir: privateRoots[0]!,
        workspacePath, promptPath: join(root, "prompt.md"),
        accounts: ["TEST-account-a", "TEST-account-b"], workerMode: WorkerMode.Open,
        accessBoundary: AccessBoundary.IsolatedWorkspaceWrite,
        networkAccess: NetworkAccessMode.Restricted,
        projectAccessScope: {
          projectId: "TEST", workspaceRoots: [workspacePath],
          isolatedWorkspaceRoot: workspacePath,
          authRoot: privateRoots[1]!, registryRoot: privateRoots[2]!,
        },
      } });
      const { stdout: base } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: workspacePath });
      expect(await prepareWorkerToolRoot({
        jobId: manifest.jobId, workspacePath,
        sourceRepositoryPath: join(root, "repo"), base: base.trim(), commitAllowed: true,
      })).toEqual({ status: WorkerToolRootStatus.Prepared });
      const stored = await readCodexGoalJob({ registryRootDir, jobId: manifest.jobId });
      const launch = await goalLaunchInput(codexGoalJobToArgs(stored));
      const config = { ...launch.config, sourceEnv: {} };
      await mkdir(config.jobRootDir, { recursive: true });
      await writeFile(config.promptPath, "Change the file, run tests, then git commit the changes.\n");
      vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      vi.spyOn(process, "getuid").mockReturnValue(0);
      const createExecutor = vi.fn((options: Parameters<NonNullable<CodexGoalRunDeps["createExecutor"]>>[0]) => {
        expect(options.accounts).toHaveLength(stored.accounts.length);
        for (const account of options.accounts) {
          expect(account.worker.openWorker).toMatchObject({ toolRoot: `${workspacePath}.tool`, commitAllowed: true });
          // Each independent private producer root and its parent must be shielded.
          expect(account.worker.openWorker?.secretRoots).toEqual(expect.arrayContaining([
            ...privateRoots.flatMap(path => [path, join(path, "..")]), config.jobRootDir,
          ]));
        }
        return {
          async run(input: Parameters<CodexGoalExecutor["run"]>[0]) {
            expect(input.systemPrompt).toContain("Commit there as often as you like");
            expect(input.systemPrompt).not.toContain("edit/test/handoff-only");
            return { status: "completed", attempts: [], task: { outputText: "done" } } as never;
          },
          async dispose() {},
        };
      });
      await runCodexGoal(config, { createExecutor });
      expect(createExecutor).toHaveBeenCalledOnce();
      const events = await readJsonLines(codexGoalRuntimeEventsPath(config));
      expect(events.find(event => event.event === "runner_starting")).toMatchObject({
        attributes: { workerModeRequested: WorkerMode.Open, workerModeEffective: WorkerMode.Open },
      });
      expect(events.map(event => event.event)).not.toContain("linked_worktree_commit_preflight_warning");
      expect(events.map(event => event.event)).not.toContain("linked_worktree_handoff_guardrail");
    } finally {
      vi.restoreAllMocks();
      await rm(root, { recursive: true, force: true });
    }
  });

});
