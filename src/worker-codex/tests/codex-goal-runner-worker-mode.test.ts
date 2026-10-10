import "./hosted-test-egress-default-fixture";
import "./unmanaged-goal-host-fixture";
import { execFile } from "node:child_process";
import * as nodeFs from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { AccessBoundary, NetworkAccessMode, WorkerMode } from "@vioxen/subscription-runtime/worker-core";
import * as hostedHostPolicy from "../../provider-codex/app-server/adapters/hosted-host-policy";
import { goalLaunchInput } from "../application/codex-goal-launch-input";
import { createCodexGoalJob, readCodexGoalJob, codexGoalJobToArgs } from "../codex-goal-jobs";
import { prepareWorkerToolRoot, WorkerToolRootStatus } from "../worker-tool-root";
import { codexGoalRuntimeEventsPath, runCodexGoal, type CodexGoalRunDeps,
  type CodexGoalExecutor } from "../codex-goal-runner";
import { createLinkedGitWorktree, readJsonLines } from "./codex-goal-runner-fixtures";

const execFileAsync = promisify(execFile);
describe("codex goal runner worker mode", () => {
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
      vi.spyOn(hostedHostPolicy, "readHostedActivationMode").mockReturnValue(hostedHostPolicy.HostedActivationMode.Disabled);
      vi.spyOn(hostedHostPolicy, "hasHostedActivationOrigin").mockReturnValue(false);
      vi.spyOn(hostedHostPolicy, "isHostedContainment").mockReturnValue(false);
      vi.spyOn(hostedHostPolicy, "assertHostedBaselineIdentity").mockImplementation(() => {});
      const readFileSync = nodeFs.readFileSync;
      vi.spyOn(nodeFs, "readFileSync").mockImplementation(((path, ...args) =>
        path === "/proc/self/cgroup" ? "0::/\n" : Reflect.apply(readFileSync, nodeFs, [path, ...args])
      ) as typeof nodeFs.readFileSync);
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
