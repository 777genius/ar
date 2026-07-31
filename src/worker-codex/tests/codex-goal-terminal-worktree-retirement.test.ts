import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  AccessBoundary,
  NetworkAccessMode,
  ProjectControlBroker,
  type ProjectAccessScope,
  type ProjectControlOperationResult,
} from "@vioxen/subscription-runtime/worker-core";
import { createCodexGoalJob } from "../codex-goal-jobs";
import {
  retireTerminalProjectWorktree,
  type TerminalWorktreeRetirementPermit,
} from "../application/project-control/codex-goal-terminal-worktree-retirement";
import {
  assertTerminalWorktreeRetirementPermitFileSecurity,
  runTerminalWorktreeRetirementCli,
} from "../codex-goal-terminal-worktree-retirement-cli";
import {
  git,
  gitInitRepository,
  gitStdout,
} from "./codex-goal-mcp-test-support";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe("terminal project worktree retirement", () => {
  it("previews, retires through git worktree remove and replays idempotently", async () => {
    const fixture = await createFixture();

    const preview = await retireTerminalProjectWorktree({
      permit: fixture.permit,
      permitSha256: "a".repeat(64),
      confirm: false,
      deps: stoppedDeps(),
    });
    expect(preview).toMatchObject({
      status: "noop",
      jobId: fixture.workerJobId,
      workspacePath: fixture.workerWorkspace,
      workspaceExists: true,
      terminalStatus: "integrated",
      headSha: fixture.permit.expectedHeadSha,
      branch: fixture.permit.expectedBranch,
      gitStatusSha256: fixture.permit.expectedGitStatusSha256,
      gitCommonDir: fixture.permit.expectedGitCommonDir,
      reclaimedBytes: fixture.permit.expectedReclaimedBytes,
      safeMessage:
        "terminal worktree retirement requires explicit confirmation",
    });
    await expect(lstat(fixture.workerWorkspace)).resolves.toBeDefined();

    const applied = await retireTerminalProjectWorktree({
      permit: fixture.permit,
      permitSha256: "a".repeat(64),
      confirm: true,
      deps: stoppedDeps(),
    });
    expect(applied).toMatchObject({
      status: "applied",
      workspaceExists: true,
      reclaimedBytes: fixture.permit.expectedReclaimedBytes,
    });
    await expect(lstat(fixture.workerWorkspace)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      gitStdout(fixture.controllerWorkspace, [
        "worktree",
        "list",
        "--porcelain",
      ]),
    ).resolves.not.toContain(fixture.workerWorkspace);

    const replay = await retireTerminalProjectWorktree({
      permit: fixture.permit,
      permitSha256: "a".repeat(64),
      confirm: true,
      deps: stoppedDeps(),
    });
    expect(replay).toMatchObject({
      status: "noop",
      workspaceExists: false,
      reclaimedBytes: 0,
      safeMessage: "terminal worktree is already absent",
    });
  });

  it("fails closed on snapshot drift, live workers and shared workspaces", async () => {
    const drift = await createFixture();
    await writeFile(join(drift.workerWorkspace, "late.txt"), "drift\n");
    await expect(
      retireTerminalProjectWorktree({
        permit: drift.permit,
        permitSha256: "b".repeat(64),
        confirm: true,
        deps: stoppedDeps(),
      }),
    ).rejects.toThrow("project_control_retire_permit_snapshot_mismatch");

    const branch = await createFixture();
    await expect(
      retireTerminalProjectWorktree({
        permit: { ...branch.permit, expectedBranch: "test/wrong-branch" },
        permitSha256: "1".repeat(64),
        confirm: true,
        deps: stoppedDeps(),
      }),
    ).rejects.toThrow("project_control_retire_permit_snapshot_mismatch");

    const live = await createFixture();
    await expect(
      retireTerminalProjectWorktree({
        permit: live.permit,
        permitSha256: "c".repeat(64),
        confirm: true,
        deps: {
          collectStatus: async () => ({
            tmuxAlive: true,
            recommendedAction: "wait_for_worker",
            warnings: [],
          }),
        },
      }),
    ).rejects.toThrow("project_control_retire_worker_still_alive");

    const shared = await createFixture();
    await createStoredJob(
      shared,
      "project-worker-shared-v1",
      shared.workerWorkspace,
    );
    await expect(
      retireTerminalProjectWorktree({
        permit: shared.permit,
        permitSha256: "d".repeat(64),
        confirm: true,
        deps: stoppedDeps(),
      }),
    ).rejects.toThrow(
      "project_control_retire_shared_workspace_job:project-worker-shared-v1",
    );
  });

  it("requires valid archived terminal output and denies protected workspaces", async () => {
    const archive = await createFixture();
    await rm(archive.patchPath);
    await expect(
      retireTerminalProjectWorktree({
        permit: archive.permit,
        permitSha256: "e".repeat(64),
        confirm: true,
        deps: stoppedDeps(),
      }),
    ).rejects.toThrow("project_control_retire_terminal_output_required");

    const protectedFixture = await createFixture();
    const protectedPermit = {
      ...protectedFixture.permit,
      expectedWorkspacePath: protectedFixture.controllerWorkspace,
    };
    await createStoredJob(
      protectedFixture,
      protectedFixture.workerJobId,
      protectedFixture.controllerWorkspace,
      false,
      true,
    );
    await expect(
      retireTerminalProjectWorktree({
        permit: protectedPermit,
        permitSha256: "f".repeat(64),
        confirm: true,
        deps: stoppedDeps(),
      }),
    ).rejects.toThrow("project_control_retire_worktree_root_required");
  });

  it("accepts immutable output archived under the bound controller job", async () => {
    const fixture = await createFixture({ archiveOwner: "controller" });

    await expect(
      retireTerminalProjectWorktree({
        permit: fixture.permit,
        permitSha256: "2".repeat(64),
        confirm: false,
        deps: stoppedDeps(),
      }),
    ).resolves.toMatchObject({
      status: "noop",
      jobId: fixture.workerJobId,
      terminalStatus: "integrated",
      workspaceExists: true,
    });
  });

  it("denies immutable output archived under a different controller job", async () => {
    const fixture = await createFixture({ archiveOwner: "other-controller" });

    await expect(
      retireTerminalProjectWorktree({
        permit: fixture.permit,
        permitSha256: "3".repeat(64),
        confirm: false,
        deps: stoppedDeps(),
      }),
    ).rejects.toThrow("project_control_retire_archive_outside_project");
  });
});

describe("terminal worktree retirement CLI", () => {
  it("is preview-only by default and binds the exact permit hash", async () => {
    const fixture = await createFixture();
    const permitPath = join(fixture.root, "permit.json");
    const bytes = `${JSON.stringify(fixture.permit)}\n`;
    await writeFile(permitPath, bytes, { mode: 0o600 });
    const stdout: string[] = [];
    let observed:
      { readonly confirm: boolean; readonly permitSha256: string } | undefined;
    const exit = await runTerminalWorktreeRetirementCli(
      ["--permit-file", permitPath],
      {
        cwd: () => fixture.root,
        writeStdout: (chunk) => stdout.push(chunk),
        writeStderr: () => undefined,
      },
      {
        execute: async (input) => {
          observed = {
            confirm: input.confirm,
            permitSha256: input.permitSha256,
          };
          return {
            status: "noop",
            jobId: input.permit.jobId,
            workspacePath: input.permit.expectedWorkspacePath,
            terminalStatus: "integrated",
            workspaceExists: true,
            headSha: input.permit.expectedHeadSha,
            branch: input.permit.expectedBranch,
            gitStatusSha256: input.permit.expectedGitStatusSha256,
            gitCommonDir: input.permit.expectedGitCommonDir,
            reclaimedBytes: input.permit.expectedReclaimedBytes,
            permitSha256: input.permitSha256,
          };
        },
      },
    );
    expect(exit).toBe(0);
    expect(observed).toEqual({
      confirm: false,
      permitSha256: createHash("sha256").update(bytes).digest("hex"),
    });
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      schemaVersion: 1,
      mode: "preview",
      status: "noop",
    });
  });

  it("requires root and a root-owned mode-0600 permit", () => {
    expect(() =>
      assertTerminalWorktreeRetirementPermitFileSecurity(
        { uid: 0, mode: 0o100600 },
        0,
      ),
    ).not.toThrow();
    expect(() =>
      assertTerminalWorktreeRetirementPermitFileSecurity(
        { uid: 0, mode: 0o100644 },
        0,
      ),
    ).toThrow("terminal_worktree_retirement_permit_mode_invalid");
    expect(() =>
      assertTerminalWorktreeRetirementPermitFileSecurity(
        { uid: 1000, mode: 0o100600 },
        0,
      ),
    ).toThrow("terminal_worktree_retirement_permit_owner_invalid");
    expect(() =>
      assertTerminalWorktreeRetirementPermitFileSecurity(
        { uid: 0, mode: 0o100600 },
        1000,
      ),
    ).toThrow("terminal_worktree_retirement_root_required");
  });
});

function stoppedDeps() {
  return {
    collectStatus: async () => ({
      tmuxAlive: false,
      recommendedAction: "review_completed" as const,
      warnings: [],
    }),
    broker: (input: {
      readonly scope: ProjectAccessScope;
      readonly retireWorktreeEffect: (
        workspacePath: string,
      ) => Promise<ProjectControlOperationResult>;
    }) => createTestBroker(input),
  };
}

function createTestBroker(input: {
  readonly scope: ProjectAccessScope;
  readonly retireWorktreeEffect: (
    workspacePath: string,
  ) => Promise<ProjectControlOperationResult>;
}): ProjectControlBroker {
  return new ProjectControlBroker(
    {
      boundary: AccessBoundary.ProjectScopedControl,
      scope: input.scope,
    },
    {
      registry: {
        createJob: async () => ({ status: "noop" }),
        writeReviewMarker: async () => ({ status: "noop" }),
      },
      supervisor: {
        startWorker: async () => ({ status: "noop" }),
        stopWorker: async () => ({ status: "noop" }),
      },
      workspace: {
        createWorktree: async () => ({ status: "noop" }),
        retireWorktree: input.retireWorktreeEffect,
      },
      git: {
        integrateCommit: async () => ({ status: "noop" }),
        pushBranch: async () => ({ status: "noop" }),
      },
    },
  );
}

type Fixture = Awaited<ReturnType<typeof createFixture>>;

async function createFixture(
  options: {
    readonly archiveOwner?: "registry" | "controller" | "other-controller";
  } = {},
) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "terminal-worktree-retirement-")),
  );
  roots.push(root);
  const registryRootDir = join(root, "worker-jobs", "registry");
  const ledgerRoot = join(root, "control", "consumed-output-ledger");
  const worktreeRoot = join(root, "worktrees");
  const controllerWorkspace = join(root, "repo");
  const controllerJobId = "project-controller-v1";
  const workerJobId = "project-worker-v1";
  const workerWorkspace = join(worktreeRoot, workerJobId);
  await mkdir(worktreeRoot, { recursive: true });
  await mkdir(controllerWorkspace, { recursive: true });
  await gitInitRepository(controllerWorkspace);
  await writeFile(join(controllerWorkspace, "README.md"), "base\n");
  await git(controllerWorkspace, ["add", "README.md"]);
  await git(controllerWorkspace, ["commit", "-m", "test: base"]);
  await git(controllerWorkspace, [
    "worktree",
    "add",
    "-b",
    `test/${workerJobId}`,
    workerWorkspace,
  ]);
  await writeFile(join(workerWorkspace, "worker.txt"), "terminal output\n");
  const seed = {
    root,
    registryRootDir,
    controllerWorkspace,
    ledgerRoot,
    worktreeRoot,
  };
  await createStoredJob(seed, controllerJobId, controllerWorkspace, true);
  await createStoredJob(seed, workerJobId, workerWorkspace);
  const controllerJobRoot = join(root, "worker-jobs", controllerJobId);
  const archiveRoot =
    options.archiveOwner === "controller"
      ? join(controllerJobRoot, "archives")
      : options.archiveOwner === "other-controller"
        ? join(root, "worker-jobs", "project-controller-other-v1", "archives")
        : join(root, "worker-jobs", "archives");
  const evidenceRoot = join(archiveRoot, `${workerJobId}-integrated`);
  await mkdir(join(ledgerRoot, "items"), { recursive: true });
  await mkdir(evidenceRoot, { recursive: true });
  const statusPath = join(evidenceRoot, "git-status.txt");
  const patchPath = join(evidenceRoot, "worker-output.patch");
  await writeFile(
    statusPath,
    await gitStdout(workerWorkspace, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]),
  );
  await writeFile(patchPath, "reviewed output\n");
  await writeFile(
    join(ledgerRoot, "items", `${workerJobId}.json`),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        jobId: workerJobId,
        status: "integrated",
        closedAt: "2026-07-31T00:00:00.000Z",
        commitSha: (
          await gitStdout(workerWorkspace, ["rev-parse", "HEAD"])
        ).trim(),
        note: "Terminal worker output consumed.",
        backup: {
          workspace: workerWorkspace,
          statusPath,
          patchPath,
        },
      },
      null,
      2,
    )}\n`,
  );
  const gitStatus = await gitStdout(workerWorkspace, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  const permit: TerminalWorktreeRetirementPermit = {
    schemaVersion: 1,
    registryRootDir,
    controllerJobId,
    projectId: "project",
    jobId: workerJobId,
    expectedWorkspacePath: workerWorkspace,
    expectedHeadSha: (
      await gitStdout(workerWorkspace, ["rev-parse", "HEAD"])
    ).trim(),
    expectedBranch: `test/${workerJobId}`,
    expectedGitStatusSha256: createHash("sha256")
      .update(gitStatus)
      .digest("hex"),
    expectedGitCommonDir: await realpath(join(controllerWorkspace, ".git")),
    expectedReclaimedBytes: await directorySize(workerWorkspace),
  };
  return {
    ...seed,
    controllerJobId,
    controllerJobRoot,
    workerJobId,
    workerWorkspace,
    statusPath,
    patchPath,
    permit,
  };
}

type StoredJobSeed = {
  readonly root: string;
  readonly registryRootDir: string;
  readonly controllerWorkspace: string;
  readonly ledgerRoot: string;
  readonly worktreeRoot: string;
};

async function createStoredJob(
  input: StoredJobSeed,
  jobId: string,
  workspacePath: string,
  controller = false,
  overwrite = false,
): Promise<void> {
  const jobRootDir = join(input.root, "worker-jobs", jobId);
  await mkdir(jobRootDir, { recursive: true });
  await writeFile(join(jobRootDir, "prompt.md"), "test prompt\n");
  await createCodexGoalJob({
    registryRootDir: input.registryRootDir,
    overwrite,
    manifest: {
      jobId,
      jobRootDir,
      workspacePath,
      promptPath: join(jobRootDir, "prompt.md"),
      taskId: jobId,
      accounts: ["account-a"],
      networkAccess: NetworkAccessMode.Restricted,
      ...(controller
        ? {
            accessBoundary: AccessBoundary.ProjectScopedControl,
            projectAccessScope: {
              projectId: "project",
              readRoots: [],
              workspaceRoots: [input.controllerWorkspace],
              worktreeRoots: [input.worktreeRoot],
              registryRoot: input.registryRootDir,
              consumedOutputLedgerRoots: [input.ledgerRoot],
              jobIdPrefixes: ["project-"],
              tmuxSessionPrefixes: ["project-"],
              allowedAccountIds: ["account-a"],
            },
          }
        : {}),
    },
  });
}

async function directorySize(root: string): Promise<number> {
  let total = 0;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of await import("node:fs/promises").then(
      async ({ readdir }) => await readdir(current, { withFileTypes: true }),
    )) {
      const path = join(current, entry.name);
      const status = await lstat(path);
      total += status.size;
      if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(path);
    }
  }
  return total;
}
