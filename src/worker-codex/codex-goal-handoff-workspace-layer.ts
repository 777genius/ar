import { lstat, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  assertSafeHandoffRelativePath as assertSafeRelativePath,
  isHandoffNodeError as isNodeError,
  uniqueSortedHandoffPaths as uniqueSorted,
} from "./codex-goal-handoff-artifact-guards";
import {
  handoffGitNullPaths as gitNullPaths,
  handoffGitOutput as gitOutput,
  handoffGitText as gitText,
} from "./codex-goal-handoff-git-snapshot";
import { withHandoffLiveIndexSnapshot } from
  "./codex-goal-handoff-worktree-index";

type HandoffWorkspaceLayer = "staged" | "unstaged" | "clean";

/** Classify one authoritative Git layer without mutating the live index. */
export async function captureHandoffWorkspaceLayer(
  workspacePath: string,
  gitBinaryPath?: string,
): Promise<HandoffWorkspaceLayer> {
  const [headTree, indexPath, sharedIndexPath, repositoryObjectsPath] =
    await Promise.all([
      gitText(workspacePath, ["rev-parse", "--verify", "HEAD^{tree}"],
        undefined, gitBinaryPath),
      gitText(workspacePath, ["rev-parse", "--path-format=absolute",
        "--git-path", "index"], undefined, gitBinaryPath),
      gitText(workspacePath, ["rev-parse", "--path-format=absolute",
        "--shared-index-path"], undefined, gitBinaryPath),
      gitText(workspacePath, ["rev-parse", "--path-format=absolute",
        "--git-path", "objects"], undefined, gitBinaryPath),
    ]);
  return withHandoffLiveIndexSnapshot({
    sourceIndexPath: indexPath,
    ...(sharedIndexPath ? { sharedIndexPath } : {}),
    operation: async ({ temporaryDirectory, indexPath: temporaryIndexPath }) => {
      const temporaryObjectsPath = join(temporaryDirectory, "objects");
      await mkdir(temporaryObjectsPath, { recursive: true, mode: 0o700 });
      const env = {
        ...process.env,
        GIT_OBJECT_DIRECTORY: temporaryObjectsPath,
        GIT_ALTERNATE_OBJECT_DIRECTORIES: repositoryObjectsPath,
        GIT_INDEX_FILE: temporaryIndexPath,
      };
      // write-tree may cache its result, so it must only see the copied index.
      const indexTree = await gitText(
        workspacePath,
        ["write-tree"],
        env,
        gitBinaryPath,
      );
      await gitOutput(workspacePath, ["read-tree", indexTree],
        1024 * 1024, env, gitBinaryPath);
      const [unstagedPaths, untrackedPaths, modeDriftPaths] = await Promise.all([
        gitNullPaths(workspacePath, ["diff", "--no-ext-diff", "--name-only",
          "--no-renames", "-z", "--"], env, gitBinaryPath),
        gitNullPaths(workspacePath, ["ls-files", "--others",
          "--exclude-standard", "-z"], undefined, gitBinaryPath),
        gitIndexWorktreeModeDriftPaths(workspacePath, gitBinaryPath),
      ]);
      const staged = indexTree !== headTree;
      const unstaged = unstagedPaths.length > 0 || untrackedPaths.length > 0 ||
        modeDriftPaths.length > 0;
      if (staged && unstaged) {
        throw new Error("handoff_mixed_index_worktree_state");
      }
      return staged ? "staged" : unstaged ? "unstaged" : "clean";
    },
  });
}

async function gitIndexWorktreeModeDriftPaths(
  workspacePath: string,
  gitBinaryPath?: string,
): Promise<readonly string[]> {
  const output = await gitOutput(workspacePath, ["ls-files", "--stage", "-z"],
    16 * 1024 * 1024, undefined, gitBinaryPath);
  const changed: string[] = [];
  for (const rawEntry of output.split("\0").filter(Boolean)) {
    const separator = rawEntry.indexOf("\t");
    const metadata = rawEntry.slice(0, separator).split(" ");
    const path = assertSafeRelativePath(rawEntry.slice(separator + 1));
    const [mode, objectId, stage] = metadata;
    if (separator < 0 ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(objectId ?? "") ||
      stage !== "0") throw new Error("handoff_index_entry_invalid");
    if (mode !== "100644" && mode !== "100755") continue;
    let item;
    try {
      item = await lstat(resolve(workspacePath, path));
    } catch (error) {
      if (isNodeError(error, "ENOENT")) continue;
      throw error;
    }
    if (!item.isFile()) continue;
    const worktreeMode = (item.mode & 0o111) === 0 ? "100644" : "100755";
    if (worktreeMode !== mode) changed.push(path);
  }
  return uniqueSorted(changed);
}
