import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  AccessBoundary,
  consumedOutputRecordFor,
  type ProjectControlBroker,
  type ConsumedOutputRecord,
  type ProjectAccessScope,
  type ProjectControlOperationResult,
} from "@vioxen/subscription-runtime/worker-core";
import {
  listCodexGoalJobs,
  readCodexGoalJob,
  type CodexGoalJobManifest,
} from "../../codex-goal-jobs";
import type { CodexGoalStatus } from "../../codex-goal-ops";
import { resolveCodexGoalWorkerLiveness } from "../codex-goal-process-liveness";
import { execGit, execGitStdout } from "../../codex-goal-mcp-project-git";
import { projectControlWorkspaceLocks } from "../../codex-goal-project-workspace-lock";
import { readCodexGoalConsumedOutputLedgers } from "./codex-goal-consumed-output-ledger-io";

const RETIRABLE_STATUSES = new Set([
  "integrated",
  "rejected",
  "failed_no_output",
]);

export type TerminalWorktreeRetirementPermit = {
  readonly schemaVersion: 1;
  readonly registryRootDir: string;
  readonly controllerJobId: string;
  readonly projectId: string;
  readonly jobId: string;
  readonly expectedWorkspacePath: string;
  readonly expectedHeadSha: string;
  readonly expectedBranch: string | null;
  readonly expectedGitStatusSha256: string;
  readonly expectedGitCommonDir: string;
  readonly expectedReclaimedBytes: number;
};

export type TerminalWorktreeRetirementResult = {
  readonly status: "applied" | "noop";
  readonly jobId: string;
  readonly workspacePath: string;
  readonly terminalStatus: string;
  readonly workspaceExists: boolean;
  readonly headSha: string;
  readonly branch: string | null;
  readonly gitStatusSha256: string;
  readonly gitCommonDir: string;
  readonly reclaimedBytes: number;
  readonly permitSha256: string;
  readonly safeMessage?: string;
};

export type TerminalWorktreeRetirementDependencies = {
  readonly loadController?: typeof loadController;
  readonly readJob?: typeof readCodexGoalJob;
  readonly listJobs?: typeof listCodexGoalJobs;
  readonly readLedgers?: typeof readCodexGoalConsumedOutputLedgers;
  readonly collectStatus?: (
    input: TerminalWorktreeStatusInput,
  ) => Promise<CodexGoalStatus>;
  readonly broker?: (input: {
    readonly registryRootDir: string;
    readonly controller: CodexGoalJobManifest;
    readonly scope: ProjectAccessScope;
    readonly retireWorktreeEffect: (
      workspacePath: string,
    ) => Promise<ProjectControlOperationResult>;
  }) => Pick<ProjectControlBroker, "retireWorktree">;
};

export async function retireTerminalProjectWorktree(input: {
  readonly permit: TerminalWorktreeRetirementPermit;
  readonly permitSha256: string;
  readonly confirm: boolean;
  readonly deps?: TerminalWorktreeRetirementDependencies;
}): Promise<TerminalWorktreeRetirementResult> {
  const deps = input.deps ?? {};
  const controller = await (deps.loadController ?? loadController)({
    registryRootDir: input.permit.registryRootDir,
    controllerJobId: input.permit.controllerJobId,
  });
  assertControllerBinding(input.permit, controller);
  const readJob = deps.readJob ?? readCodexGoalJob;
  const initialManifest = await readJob({
    registryRootDir: controller.registryRootDir,
    jobId: input.permit.jobId,
  });
  assertWorkspaceBinding(initialManifest, input.permit.expectedWorkspacePath);

  const locks = projectControlWorkspaceLocks(controller.registryRootDir);
  // This is the same lock domain used by project integration/review actions.
  // Acquiring it is the fail-closed proof that no active broker operation owns
  // the exact workspace while its terminal snapshot is checked and removed.
  const lock = await locks.acquire({
    workspacePath: resolve(input.permit.expectedWorkspacePath),
    owner:
      `operator-retire-terminal-worktree:${controller.controller.jobId}:` +
      input.permit.jobId,
  });
  try {
    const manifest = await readJob({
      registryRootDir: controller.registryRootDir,
      jobId: input.permit.jobId,
    });
    assertWorkspaceBinding(manifest, input.permit.expectedWorkspacePath);
    const workspace = await inspectScopedWorkspace(
      input.permit.expectedWorkspacePath,
      controller.scope,
    );
    assertProtectedWorkspaceDenied({
      workspacePath: workspace.path,
      controllerWorkspacePath: controller.controller.workspacePath,
      scope: controller.scope,
    });

    const terminalRecord = await terminalRecordFor({
      registryRootDir: controller.registryRootDir,
      scope: controller.scope,
      manifest,
      workspacePath: workspace.path,
      readLedgers: deps.readLedgers ?? readCodexGoalConsumedOutputLedgers,
    });
    await assertImmutableTerminalArchive({
      record: terminalRecord,
      registryRootDir: controller.registryRootDir,
      jobRootDir: manifest.jobRootDir,
      jobId: manifest.jobId,
    });
    const collectStatus =
      deps.collectStatus ??
      (await import("../../codex-goal-ops")).collectCodexGoalStatus;
    const status = await collectStatus(statusInput(manifest, workspace.path));
    assertWorkerStopped(status);
    await assertWorkspaceExclusive({
      registryRootDir: controller.registryRootDir,
      jobId: manifest.jobId,
      workspacePath: workspace.path,
      listJobs: deps.listJobs ?? listCodexGoalJobs,
    });

    const source = await resolveSourceRepository({
      controllerWorkspacePath: controller.controller.workspacePath,
      scope: controller.scope,
      ...(workspace.exists ? { worktreePath: workspace.path } : {}),
      expectedGitCommonDir: input.permit.expectedGitCommonDir,
    });
    const snapshot = workspace.exists
      ? await snapshotWorktree(workspace.path, source.commonDir)
      : absentSnapshot(input.permit);
    assertExactPermit(input.permit, snapshot);

    const brokerFactory =
      deps.broker ??
      (await import("../../codex-goal-mcp-project-control-deps"))
        .codexProjectControlBroker;
    const broker = brokerFactory({
      registryRootDir: controller.registryRootDir,
      controller: controller.controller,
      scope: controller.scope,
      retireWorktreeEffect: async (
        authorizedWorkspacePath,
      ): Promise<ProjectControlOperationResult> => {
        if (resolve(authorizedWorkspacePath) !== resolve(workspace.path)) {
          throw new Error(
            "project_control_retire_authorized_workspace_mismatch",
          );
        }
        if (!input.confirm) {
          return {
            status: "noop",
            resourceId: workspace.path,
            safeMessage:
              "terminal worktree retirement requires explicit confirmation",
          };
        }
        if (!workspace.exists) {
          return {
            status: "noop",
            resourceId: workspace.path,
            safeMessage: "terminal worktree is already absent",
          };
        }
        await execGit([
          "-C",
          source.workspacePath,
          "worktree",
          "remove",
          "--force",
          workspace.path,
        ]);
        if (await pathExists(workspace.path)) {
          throw new Error("project_control_retire_worktree_still_exists");
        }
        const registered = await registeredWorktreePaths(source.workspacePath);
        if (registered.has(workspace.path)) {
          throw new Error(
            "project_control_retire_worktree_metadata_still_registered",
          );
        }
        return { status: "applied", resourceId: workspace.path };
      },
    });
    const operation = await broker.retireWorktree({
      jobId: manifest.jobId,
      registryRoot: controller.registryRootDir,
      workspacePath: workspace.path,
      realWorkspacePath: workspace.path,
      ...(manifest.tmuxSession ? { tmuxSession: manifest.tmuxSession } : {}),
    });
    return {
      status: operation.status,
      jobId: manifest.jobId,
      workspacePath: workspace.path,
      terminalStatus: terminalRecord.status,
      workspaceExists: workspace.exists,
      headSha: snapshot.headSha,
      branch: snapshot.branch,
      gitStatusSha256: snapshot.gitStatusSha256,
      gitCommonDir: snapshot.gitCommonDir,
      reclaimedBytes: snapshot.reclaimedBytes,
      permitSha256: input.permitSha256,
      ...(operation.safeMessage ? { safeMessage: operation.safeMessage } : {}),
    };
  } finally {
    await locks.release(lock);
  }
}

type TerminalWorktreeStatusInput = {
  readonly jobRootDir: string;
  readonly taskId: string;
  readonly resultPath: string;
  readonly workspacePath: string;
  readonly tmuxSession?: string;
  readonly logPath: string;
  readonly progressPath: string;
  readonly accessBoundary?: AccessBoundary;
};

function statusInput(
  manifest: CodexGoalJobManifest,
  workspacePath: string,
): TerminalWorktreeStatusInput {
  return {
    jobRootDir: manifest.jobRootDir,
    taskId: manifest.taskId,
    resultPath:
      manifest.outputPath ??
      join(manifest.jobRootDir, `${manifest.taskId}.latest-result.json`),
    workspacePath,
    ...(manifest.tmuxSession ? { tmuxSession: manifest.tmuxSession } : {}),
    logPath:
      manifest.logPath ?? join(manifest.jobRootDir, `${manifest.taskId}.log`),
    progressPath:
      manifest.progressPath ??
      join(manifest.jobRootDir, `${manifest.taskId}.progress.json`),
    ...(manifest.accessBoundary
      ? { accessBoundary: manifest.accessBoundary }
      : {}),
  };
}

function assertControllerBinding(
  permit: TerminalWorktreeRetirementPermit,
  controller: Awaited<ReturnType<typeof loadController>>,
): void {
  if (
    controller.registryRootDir !== permit.registryRootDir ||
    controller.controller.jobId !== permit.controllerJobId ||
    controller.scope.projectId !== permit.projectId
  ) {
    throw new Error("project_control_retire_controller_scope_mismatch");
  }
}

async function loadController(input: {
  readonly registryRootDir: string;
  readonly controllerJobId: string;
}): Promise<{
  readonly registryRootDir: string;
  readonly controller: CodexGoalJobManifest;
  readonly scope: ProjectAccessScope;
}> {
  const controller = await readCodexGoalJob({
    registryRootDir: input.registryRootDir,
    jobId: input.controllerJobId,
  });
  if (controller.accessBoundary !== AccessBoundary.ProjectScopedControl) {
    throw new Error("project_control_controller_boundary_required");
  }
  if (!controller.projectAccessScope) {
    throw new Error("project_control_controller_scope_required");
  }
  return {
    registryRootDir: input.registryRootDir,
    controller,
    scope: controller.projectAccessScope,
  };
}

function assertWorkspaceBinding(
  manifest: CodexGoalJobManifest,
  expectedWorkspacePath: string,
): void {
  if (resolve(manifest.workspacePath) !== resolve(expectedWorkspacePath)) {
    throw new Error("project_control_retire_expected_workspace_mismatch");
  }
}

async function inspectScopedWorkspace(
  expectedWorkspacePath: string,
  scope: ProjectAccessScope,
): Promise<{ readonly path: string; readonly exists: boolean }> {
  if (!isAbsolute(expectedWorkspacePath)) {
    throw new Error("project_control_retire_workspace_absolute_required");
  }
  const expected = resolve(expectedWorkspacePath);
  const roots = await canonicalDirectoryRoots(scope.worktreeRoots ?? []);
  if (
    !roots.some(
      (root) => expected !== root && pathInsideOrEqual(expected, root),
    )
  ) {
    throw new Error("project_control_retire_worktree_root_required");
  }
  let status;
  try {
    status = await lstat(expected);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const parent = await realpath(dirname(expected));
      if (
        !roots.some(
          (root) => parent === root || pathInsideOrEqual(parent, root),
        )
      ) {
        throw new Error("project_control_retire_workspace_parent_escaped");
      }
      return { path: expected, exists: false };
    }
    throw error;
  }
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error("project_control_retire_workspace_directory_required");
  }
  const canonical = await realpath(expected);
  if (canonical !== expected) {
    throw new Error("project_control_retire_workspace_not_canonical");
  }
  return { path: canonical, exists: true };
}

function assertProtectedWorkspaceDenied(input: {
  readonly workspacePath: string;
  readonly controllerWorkspacePath: string;
  readonly scope: ProjectAccessScope;
}): void {
  const protectedPaths = [
    input.controllerWorkspacePath,
    ...(input.scope.workspaceRoots ?? []),
  ].map((path) => resolve(path));
  if (protectedPaths.includes(resolve(input.workspacePath))) {
    throw new Error("project_control_retire_protected_workspace_denied");
  }
}

async function terminalRecordFor(input: {
  readonly registryRootDir: string;
  readonly scope: ProjectAccessScope;
  readonly manifest: CodexGoalJobManifest;
  readonly workspacePath: string;
  readonly readLedgers: typeof readCodexGoalConsumedOutputLedgers;
}): Promise<ConsumedOutputRecord> {
  const roots = input.scope.consumedOutputLedgerRoots ?? [];
  if (roots.length !== 1) {
    throw new Error("project_control_retire_consumed_output_ledger_required");
  }
  const ledger = await input.readLedgers({ roots });
  const record = consumedOutputRecordFor({
    ledger,
    jobId: input.manifest.jobId,
    workspacePath: input.workspacePath,
    resolvedWorkspacePath: input.workspacePath,
  });
  if (!record?.valid || !RETIRABLE_STATUSES.has(record.status)) {
    throw new Error("project_control_retire_terminal_output_required");
  }
  return record;
}

async function assertImmutableTerminalArchive(input: {
  readonly record: ConsumedOutputRecord;
  readonly registryRootDir: string;
  readonly jobRootDir: string;
  readonly jobId: string;
}): Promise<void> {
  if (!input.record.backup || input.record.backupEvidenceValid !== true) {
    throw new Error("project_control_retire_immutable_archive_required");
  }
  const paths = [
    input.record.backup.statusPath,
    input.record.backup.patchPath,
    input.record.backup.numstatPath,
    input.record.backup.untrackedArchivePath,
  ].filter((path): path is string => Boolean(path));
  if (paths.length < 2) {
    throw new Error("project_control_retire_immutable_archive_required");
  }
  const archiveRoots = [
    join(dirname(resolve(input.registryRootDir)), "archives"),
    join(resolve(input.jobRootDir), "archives"),
  ];
  for (const path of paths) {
    const canonical = await realpath(path).catch(() => {
      throw new Error("project_control_retire_archive_artifact_missing");
    });
    const status = await lstat(canonical);
    if (!status.isFile() || status.isSymbolicLink()) {
      throw new Error("project_control_retire_archive_artifact_invalid");
    }
    if (
      !archiveRoots.some((root) =>
        projectOwnedArchivePath(canonical, root, input.jobId),
      )
    ) {
      throw new Error("project_control_retire_archive_outside_project");
    }
  }
}

function projectOwnedArchivePath(
  path: string,
  archiveRoot: string,
  jobId: string,
): boolean {
  const rel = relative(resolve(archiveRoot), resolve(path));
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) return false;
  const archiveName = rel.split(sep)[0]!;
  return archiveName === jobId || archiveName.startsWith(`${jobId}-`);
}

function assertWorkerStopped(status: CodexGoalStatus): void {
  const progressStale =
    status.progressHeartbeatAgeMs !== undefined &&
    status.progressHeartbeatAgeMs > 10 * 60_000;
  if (resolveCodexGoalWorkerLiveness({ status, progressStale }).alive) {
    throw new Error("project_control_retire_worker_still_alive");
  }
}

async function assertWorkspaceExclusive(input: {
  readonly registryRootDir: string;
  readonly jobId: string;
  readonly workspacePath: string;
  readonly listJobs: typeof listCodexGoalJobs;
}): Promise<void> {
  const shared: string[] = [];
  for (const job of await input.listJobs({
    registryRootDir: input.registryRootDir,
  })) {
    if (
      job.jobId !== input.jobId &&
      resolve(job.workspacePath) === resolve(input.workspacePath)
    ) {
      shared.push(job.jobId);
    }
  }
  if (shared.length > 0) {
    throw new Error(
      `project_control_retire_shared_workspace_job:${shared.sort().join(",")}`,
    );
  }
}

async function resolveSourceRepository(input: {
  readonly controllerWorkspacePath: string;
  readonly scope: ProjectAccessScope;
  readonly worktreePath?: string;
  readonly expectedGitCommonDir: string;
}): Promise<{ readonly workspacePath: string; readonly commonDir: string }> {
  const candidates = Array.from(
    new Set(
      [
        input.controllerWorkspacePath,
        ...(input.scope.workspaceRoots ?? []),
      ].map((path) => resolve(path)),
    ),
  );
  for (const candidate of candidates) {
    if (!(await pathExists(candidate))) continue;
    const commonDir = await gitCommonDir(candidate).catch(() => undefined);
    if (commonDir !== input.expectedGitCommonDir) continue;
    if (input.worktreePath) {
      const worktreeCommonDir = await gitCommonDir(input.worktreePath);
      if (worktreeCommonDir !== commonDir) {
        throw new Error("project_control_retire_git_common_dir_mismatch");
      }
      const registered = await registeredWorktreePaths(candidate);
      if (!registered.has(input.worktreePath)) {
        throw new Error("project_control_retire_unregistered_worktree");
      }
    }
    return { workspacePath: candidate, commonDir };
  }
  throw new Error("project_control_retire_source_repository_mismatch");
}

async function snapshotWorktree(
  workspacePath: string,
  expectedCommonDir: string,
): Promise<{
  readonly headSha: string;
  readonly branch: string | null;
  readonly gitStatusSha256: string;
  readonly gitCommonDir: string;
  readonly reclaimedBytes: number;
}> {
  const gitStatus = await execGitStdout([
    "-C",
    workspacePath,
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  return {
    headSha: (await execGitStdout(["-C", workspacePath, "rev-parse", "HEAD"]))
      .trim()
      .toLowerCase(),
    branch: await currentBranch(workspacePath),
    gitStatusSha256: sha256(gitStatus),
    gitCommonDir: expectedCommonDir,
    reclaimedBytes: await directorySize(workspacePath),
  };
}

function absentSnapshot(permit: TerminalWorktreeRetirementPermit): {
  readonly headSha: string;
  readonly branch: string | null;
  readonly gitStatusSha256: string;
  readonly gitCommonDir: string;
  readonly reclaimedBytes: number;
} {
  return {
    headSha: permit.expectedHeadSha,
    branch: permit.expectedBranch,
    gitStatusSha256: permit.expectedGitStatusSha256,
    gitCommonDir: permit.expectedGitCommonDir,
    reclaimedBytes: 0,
  };
}

function assertExactPermit(
  permit: TerminalWorktreeRetirementPermit,
  snapshot: {
    readonly headSha: string;
    readonly branch: string | null;
    readonly gitStatusSha256: string;
    readonly gitCommonDir: string;
    readonly reclaimedBytes: number;
  },
): void {
  if (
    snapshot.headSha !== permit.expectedHeadSha.toLowerCase() ||
    snapshot.branch !== permit.expectedBranch ||
    snapshot.gitStatusSha256 !== permit.expectedGitStatusSha256.toLowerCase() ||
    snapshot.gitCommonDir !== permit.expectedGitCommonDir ||
    (snapshot.reclaimedBytes !== 0 &&
      snapshot.reclaimedBytes !== permit.expectedReclaimedBytes)
  ) {
    throw new Error("project_control_retire_permit_snapshot_mismatch");
  }
}

async function currentBranch(workspacePath: string): Promise<string | null> {
  const branch = (
    await execGitStdout([
      "-C",
      workspacePath,
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    ])
  ).trim();
  return branch === "HEAD" ? null : branch;
}

async function registeredWorktreePaths(
  sourceWorkspacePath: string,
): Promise<ReadonlySet<string>> {
  const output = await execGitStdout([
    "-C",
    sourceWorkspacePath,
    "worktree",
    "list",
    "--porcelain",
  ]);
  return new Set(
    output
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => resolve(line.slice("worktree ".length))),
  );
}

async function gitCommonDir(workspacePath: string): Promise<string> {
  const commonDir = (
    await execGitStdout(["-C", workspacePath, "rev-parse", "--git-common-dir"])
  ).trim();
  return await realpath(
    isAbsolute(commonDir) ? commonDir : join(workspacePath, commonDir),
  );
}

async function directorySize(root: string): Promise<number> {
  let total = 0;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(current, entry.name);
      const status = await lstat(path);
      total += status.size;
      if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(path);
    }
  }
  return total;
}

async function canonicalDirectoryRoots(
  roots: readonly string[],
): Promise<readonly string[]> {
  const canonical: string[] = [];
  for (const root of roots) {
    const status = await lstat(root).catch(() => undefined);
    if (!status?.isDirectory() || status.isSymbolicLink()) continue;
    canonical.push(await realpath(root));
  }
  return canonical;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function pathInsideOrEqual(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
