import { realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ProjectAccessScope } from "@vioxen/subscription-runtime/worker-core";
import type { CodexGoalProjectCreateWorktreeInput } from "./application/project-control/codex-goal-project-control-contracts";
import type { CodexGoalJobManifestInput } from "./codex-goal-jobs";
import { requiresStandaloneProjectWorkspace, assertStandaloneProjectWorkspace, fetchStandaloneProjectRevision } from "./project-standalone-workspace";
import { projectControlRealPathOutsideWorkspaceScope } from "./application/project-control/codex-goal-project-workspace-scope";
import { assertGitCurrentBranch, execGit, execGitStdout, isGitAncestor } from "./codex-goal-mcp-project-git";

export async function fastForwardExistingProjectWorktree(input: {
  readonly input: CodexGoalProjectCreateWorktreeInput;
  readonly scope: ProjectAccessScope;
  readonly manifest?: CodexGoalJobManifestInput | undefined;
  readonly registryRootDir?: string;
  readonly afterFastForwardForTest?: () => Promise<void>;
}): Promise<boolean> {
  const request = input.input;
  const fastForward = request.fastForwardExisting;
  if (!fastForward) return false;
  if (!request.sourceRevisionPinned) {
    throw new Error("project_control_existing_worktree_fast_forward_unpinned");
  }
  if (!request.newBranch || request.sourceRef !== request.newBranch) {
    throw new Error(
      "project_control_existing_worktree_fast_forward_branch_required",
    );
  }
  if (request.inputPatch) {
    throw new Error(
      "project_control_existing_worktree_fast_forward_patch_forbidden",
    );
  }
  const materializedRealPath = await realpath(request.path);
  if (
    !request.expectedRealPath ||
    materializedRealPath !== request.expectedRealPath
  ) {
    throw new Error(
      "project_control_existing_worktree_fast_forward_real_path_changed",
    );
  }
  if (
    await projectControlRealPathOutsideWorkspaceScope(
      materializedRealPath,
      input.scope,
    )
  ) {
    throw new Error(
      "project_control_existing_worktree_real_path_outside_scope",
    );
  }
  const standalone = requiresStandaloneProjectWorkspace({ manifest: input.manifest, target: request,
    scope: input.scope, registryRootDir: input.registryRootDir ?? "" });
  if (standalone) {
    if (await realpath(request.sourceWorkspacePath) !== request.expectedSourceRealPath)
      throw new Error("project_control_source_workspace_real_path_changed");
    if ((await execGitStdout(["-C", request.expectedSourceRealPath, "worktree", "list", "--porcelain"]))
        .split("\n").includes(`branch refs/heads/${request.newBranch}`))
      throw new Error("project_control_existing_branch_materialization_failed");
    if ((await execGitStdout(["-C", request.expectedSourceRealPath, "rev-parse", `refs/heads/${request.newBranch}`])).trim() !== request.expectedRevision)
      throw new Error("project_control_source_workspace_revision_changed");
    await assertStandaloneProjectWorkspace(materializedRealPath);
    await fetchStandaloneProjectRevision(materializedRealPath, request.expectedSourceRealPath, request.expectedRevision);
  } else {
    const [sourceCommonDir, worktreeCommonDir] = await Promise.all([
      resolveGitCommonDir(request.expectedSourceRealPath),
      resolveGitCommonDir(materializedRealPath),
    ]);
    if (sourceCommonDir !== worktreeCommonDir) {
      throw new Error("project_control_existing_worktree_foreign_repository");
    }
  }
  const statusBefore = await execGitStdout([
    "-C",
    materializedRealPath,
    "status",
    "--porcelain",
  ]);
  if (statusBefore.trim().length > 0) {
    throw new Error("project_control_existing_worktree_fast_forward_dirty");
  }
  await assertGitCurrentBranch({
    workspacePath: materializedRealPath,
    branch: request.newBranch,
  });
  const current = (
    await execGitStdout(["-C", materializedRealPath, "rev-parse", "HEAD"])
  )
    .trim()
    .toLowerCase();
  const expectedCurrent = fastForward.expectedCurrentRevision.toLowerCase();
  const expectedNext = request.expectedRevision.toLowerCase();
  if (current === expectedNext) {
    if (expectedCurrent === expectedNext) return false;
    try {
      if (
        await isGitAncestor({
          workspacePath: materializedRealPath,
          ancestor: expectedCurrent,
          descendant: expectedNext,
        })
      )
        return false;
    } catch {
      // The regular current-mismatch error below is the stable public result.
    }
  }
  if (current !== expectedCurrent) {
    throw new Error(
      "project_control_existing_worktree_fast_forward_current_mismatch",
    );
  }
  if (
    !(await isGitAncestor({
      workspacePath: materializedRealPath,
      ancestor: expectedCurrent,
      descendant: expectedNext,
    }))
  ) {
    throw new Error(
      "project_control_existing_worktree_fast_forward_non_ancestor",
    );
  }
  await execGit([
    "-c",
    "core.hooksPath=/dev/null",
    "-C",
    materializedRealPath,
    "merge",
    "--ff-only",
    "--no-stat",
    expectedNext,
  ]);
  await input.afterFastForwardForTest?.();
  try {
    const confirmed = (
      await execGitStdout(["-C", materializedRealPath, "rev-parse", "HEAD"])
    )
      .trim()
      .toLowerCase();
    const statusAfter = await execGitStdout([
      "-C",
      materializedRealPath,
      "status",
      "--porcelain",
    ]);
    if (confirmed !== expectedNext || statusAfter.trim().length > 0) {
      throw new Error(
        "project_control_existing_worktree_fast_forward_verification_failed",
      );
    }
    if (standalone) await execGit(["-c", "core.hooksPath=/dev/null", "-C", request.expectedSourceRealPath, "update-ref", `refs/heads/${request.newBranch}`, expectedNext, expectedNext]);
  } catch (error) {
    const rollback = await rollbackFastForwardRevision({
      workspacePath: materializedRealPath,
      expectedCurrent,
      expectedNext,
    });
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}; rollback=${rollback}`);
  }
  return true;
}

async function resolveGitCommonDir(workspacePath: string): Promise<string> {
  const commonDir = (
    await execGitStdout(["-C", workspacePath, "rev-parse", "--git-common-dir"])
  ).trim();
  return await realpath(
    isAbsolute(commonDir) ? commonDir : join(workspacePath, commonDir),
  );
}

async function rollbackFastForwardRevision(input: {
  readonly workspacePath: string;
  readonly expectedCurrent: string;
  readonly expectedNext: string;
}): Promise<string> {
  const observed = (
    await execGitStdout(["-C", input.workspacePath, "rev-parse", "HEAD"])
  )
    .trim()
    .toLowerCase();
  if (observed !== input.expectedNext) return "skipped_head_changed";
  const status = await execGitStdout([
    "-C",
    input.workspacePath,
    "status",
    "--porcelain",
  ]);
  if (status.trim().length > 0) return "skipped_dirty";
  try {
    await execGit([
      "-c",
      "core.hooksPath=/dev/null",
      "-C",
      input.workspacePath,
      "reset",
      "--merge",
      input.expectedCurrent,
    ]);
  } catch {
    return "failed_preserved";
  }
  const restored = (
    await execGitStdout(["-C", input.workspacePath, "rev-parse", "HEAD"])
  )
    .trim()
    .toLowerCase();
  return restored === input.expectedCurrent ? "revision" : "failed_preserved";
}
