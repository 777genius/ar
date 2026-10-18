import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  parseCodexGoalCliArgs,
  runCodexGoalCli,
  upsertRunCommandManifest,
  type CodexGoalCliIo,
} from "../codex-goal-cli";
import { projectControlChildScope } from "../codex-goal-mcp-project-scope";
import { writeBrokeredLaunchReceipt } from "../application/project-control/codex-goal-brokered-launch-receipt";

const hostPolicyFixture = vi.hoisted(() => ({ root: "" }));
// Substitute only an absent policy parent; keep real ancestor custody checks.
vi.mock("node:fs", async original => {
  const real = await original<typeof import("node:fs")>();
  const [{ tmpdir }, { join }] = await Promise.all([import("node:os"), import("node:path")]);
  hostPolicyFixture.root = real.mkdtempSync(join(tmpdir(), "TEST-codex-goal-cli-host-policy-"));
  return { ...real, lstatSync: ((path, ...args) => Reflect.apply(real.lstatSync, real, [
    path === "/etc/subscription-runtime" ? join(hostPolicyFixture.root, "absent-subscription-runtime") : path, ...args,
  ])) as typeof real.lstatSync };
});
afterAll(() => rm(hostPolicyFixture.root, { recursive: true, force: true }));

describe("codex goal cli brokered project launch receipt", () => {
  // Binding proof for the registered-launch seam: the run executes exactly the
  // manifest identity the project-control broker issued a launch receipt for
  // and a live controller scope adopted. With the seam removed (guard-binding
  // mutation) this run is denied project_control_broker_required and the test
  // fails. Disclosed shortcut: the receipt below is written by the broker's
  // real writer invoked directly, since driving the full MCP start tool here
  // would only re-test that tool's plumbing.
  it("lets a registered controller-adopted project worker run instead of denying it", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-cli-project-registered-"));
    const registryRoot = join(root, "registry");
    const controllerJobId = "infinity-context-controller-v1";
    const controllerJobRoot = join(root, "jobs", controllerJobId);
    const sourceWorkspace = join(root, "workspaces", "infinity-context-main");
    const worktreeRoot = join(root, "worktrees");
    const childJobId = "infinity-context-memory-child-v1";
    const childJobRoot = join(root, "jobs", childJobId);
    const childWorkspace = join(worktreeRoot, childJobId);
    const childPrompt = join(childJobRoot, "prompt.md");
    const projectAccessScope = {
      projectId: "infinity-context",
      workspaceRoots: [sourceWorkspace],
      worktreeRoots: [worktreeRoot],
      registryRoot,
      jobIdPrefixes: ["infinity-context-"],
      tmuxSessionPrefixes: ["infinity-context-"],
      allowedAccountIds: ["account-a"],
    };
    const childScope = projectControlChildScope(projectAccessScope, childWorkspace);
    const controllerCommand = parseCodexGoalCliArgs(
      [
        "run",
        "--job-root",
        controllerJobRoot,
        "--auth-root",
        join(root, "auth"),
        "--workspace",
        sourceWorkspace,
        "--prompt",
        join(controllerJobRoot, "prompt.md"),
        "--task-id",
        controllerJobId,
        "--job-id",
        controllerJobId,
        "--accounts",
        "account-a",
        "--registry-root",
        registryRoot,
        "--access-boundary",
        "project_scoped_control",
        "--project-access-scope-json",
        JSON.stringify(projectAccessScope),
        "--network-access",
        "restricted",
        "--no-require-git-workspace",
      ],
      fakeIo(),
    );
    const workerRunArgs = (runScope: object, workspacePath = childWorkspace) => [
      "run",
      "--no-tmux",
      "--job-root",
      childJobRoot,
      "--auth-root",
      join(root, "auth"),
      "--workspace",
      workspacePath,
      "--prompt",
      childPrompt,
      "--task-id",
      childJobId,
      "--job-id",
      childJobId,
      "--accounts",
      "account-a",
      "--registry-root",
      registryRoot,
      "--access-boundary",
      "isolated_workspace_write",
      "--project-access-scope-json",
      JSON.stringify(runScope),
      "--network-access",
      "restricted",
      "--no-require-git-workspace",
    ];
    try {
      expect(controllerCommand.kind).toBe("run");
      if (controllerCommand.kind !== "run") return;
      await upsertRunCommandManifest(controllerCommand);
      const workerCommand = parseCodexGoalCliArgs(workerRunArgs(childScope), fakeIo());
      expect(workerCommand.kind).toBe("run");
      if (workerCommand.kind !== "run") return;
      await upsertRunCommandManifest(workerCommand);

      // Ordering attack: registering the identities without brokered issuance
      // is self-serviceable and must stay raw.
      const unreceiptedIo = captureIo();
      const unreceiptedExitCode = await runCodexGoalCli(workerRunArgs(childScope), unreceiptedIo);
      expect(unreceiptedExitCode).toBe(2);
      expect(unreceiptedIo.stderr).toContain("project_control_broker_required");

      // The broker's real receipt writer, driven directly (disclosed shortcut).
      const issueReceipt = async (controllerJobId: string) => {
        const config = workerCommand.config;
        await writeBrokeredLaunchReceipt({
          jobId: config.jobId ?? config.taskId,
          taskId: config.taskId,
          jobRootDir: config.jobRootDir,
          promptPath: config.promptPath,
          workspacePath: config.workspacePath,
          ...(config.accessBoundary === undefined
            ? {}
            : { accessBoundary: config.accessBoundary }),
          projectAccessScope: config.projectAccessScope!,
          controllerJobId,
        });
      };
      await issueReceipt(controllerJobId);

      const io = captureIo();
      const exitCode = await runCodexGoalCli(workerRunArgs(childScope), io);
      expect(exitCode).not.toBe(0);
      expect(io.stderr).not.toContain("project_control_broker_required");

      // A scope that differs from the registered manifest is raw, even though
      // the manifest exists, the receipt is current and the controller adopts.
      const tamperedIo = captureIo();
      const tamperedExitCode = await runCodexGoalCli(
        workerRunArgs({ ...childScope, readRoots: [join(root, "elsewhere")] }),
        tamperedIo,
      );
      expect(tamperedExitCode).toBe(2);
      expect(tamperedIo.stderr).toContain("project_control_broker_required");

      // A receipt issued by another controller binding is raw.
      await issueReceipt("infinity-context-other-controller-v1");
      const foreignReceiptIo = captureIo();
      const foreignReceiptExitCode = await runCodexGoalCli(workerRunArgs(childScope), foreignReceiptIo);
      expect(foreignReceiptExitCode).toBe(2);
      expect(foreignReceiptIo.stderr).toContain("project_control_broker_required");

      // A receipt without a live adopting controller is raw.
      await issueReceipt(controllerJobId);
      await rm(join(registryRoot, controllerJobId), { recursive: true, force: true });
      const controllerlessIo = captureIo();
      const controllerlessExitCode = await runCodexGoalCli(workerRunArgs(childScope), controllerlessIo);
      expect(controllerlessExitCode).toBe(2);
      expect(controllerlessIo.stderr).toContain("project_control_broker_required");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

});

function fakeIo(
  env: Readonly<Record<string, string | undefined>> = {},
): CodexGoalCliIo {
  return {
    writeStdout(): void {},
    writeStderr(): void {},
    cwd(): string {
      return "/tmp";
    },
    env(): Readonly<Record<string, string | undefined>> {
      return env;
    },
  };
}

function captureIo(
  env: Readonly<Record<string, string | undefined>> = {},
): CodexGoalCliIo & {
  readonly stdout: string;
  readonly stderr: string;
} {
  let stdout = "";
  let stderr = "";
  return {
    writeStdout(chunk): void {
      stdout += chunk;
    },
    writeStderr(chunk): void {
      stderr += chunk;
    },
    cwd(): string {
      return "/tmp";
    },
    env(): Readonly<Record<string, string | undefined>> {
      return env;
    },
    get stdout(): string {
      return stdout;
    },
    get stderr(): string {
      return stderr;
    },
  };
}
