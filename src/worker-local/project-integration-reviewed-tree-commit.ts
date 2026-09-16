import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CommitIdentity, GitCommitResult, PreparedReviewedGitCommit, ReviewedCommitPublication } from "@vioxen/subscription-runtime/worker-core";
import type { LocalGitOutputRollbackRuntime } from "./project-integration-local-output-rollback";
import { assertPreparedReviewedCommit, reconcileReviewedIntegrationCommit } from "./project-integration-reviewed-tree-recovery";

/** Hooks inspect the exact candidate index. Only persisted, checked object names reach CAS. */
export async function commitReviewedIntegrationTree(input: {
  readonly runtime: LocalGitOutputRollbackRuntime;
  readonly workspacePath: string;
  readonly parent: string;
  readonly branch: string;
  readonly tree: string;
  readonly message: string;
  readonly identity: CommitIdentity;
  readonly prepared?: ReviewedCommitPublication;
  readonly onPrepared: (prepared: PreparedReviewedGitCommit) => Promise<void>;
  readonly verify: () => Promise<string>;
}): Promise<GitCommitResult> {
  const { runtime, workspacePath, identity } = input;
  const signing = await runtime.tryGit(["config", "--bool", "--get", "commit.gpgsign"], workspacePath);
  if (signing.stdout.trim() === "true" || (signing.exitCode !== 0 && signing.exitCode !== 1)) throw new Error("reviewed_output_commit_signing_requires_supported_path");
  // Post-publication hooks cannot be rejected atomically. This bounded path supports
  // validation hooks only; reject configured post-commit hooks before any publication.
  const postHook = resolve(workspacePath, (await runtime.git(["rev-parse", "--git-path", "hooks/post-commit"], workspacePath)).stdout.trim());
  const executable = await access(postHook, constants.X_OK).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "EACCES") return false;
    throw error;
  });
  if (executable) throw new Error("reviewed_output_post_commit_hook_unsupported");
  const tempRoot = await mkdtemp(join(tmpdir(), "reviewed-commit-index-"));
  let result: GitCommitResult | undefined;
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(tempRoot, "index"), GIT_EDITOR: ":",
      GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email,
      GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email };
    await runtime.git(["read-tree", input.tree], workspacePath, env);
    const messagePath = join(tempRoot, "COMMIT_EDITMSG");
    const messageBytes = `${input.message}\n`;
    await writeFile(messagePath, messageBytes, { mode: 0o600 });
    for (const args of [
      ["pre-commit"], ["prepare-commit-msg", "--", messagePath, "message"], ["commit-msg", "--", messagePath],
    ]) {
      await runtime.git(["hook", "run", "--ignore-missing", ...args], workspacePath, env);
      if ((await runtime.git(["write-tree"], workspacePath, env)).stdout.trim() !== input.tree ||
          await readFile(messagePath, "utf8") !== messageBytes || await input.verify() !== input.tree) {
        throw new Error("reviewed_output_commit_hook_mutation");
      }
    }
    const originalIndexTree = input.prepared?.originalIndexTree ?? (await runtime.git(["write-tree"], workspacePath)).stdout.trim();
    const commitSha = input.prepared?.candidate.commitSha ?? (await runtime.git(["commit-tree", input.tree, "-p", input.parent, "-m", input.message], workspacePath, env)).stdout.trim();
    const prepared = { commitSha, parent: input.parent, tree: input.tree, originalIndexTree };
    await assertPreparedReviewedCommit({ runtime, workspacePath, ...prepared, identity, message: input.message });
    if (await input.verify() !== input.tree) throw new Error("reviewed_output_checked_tree_mismatch");
    // This callback must durably store evidence in the existing integration attempt.
    await input.onPrepared(prepared);
    if (await input.verify() !== input.tree) throw new Error("reviewed_output_checked_tree_mismatch");
    await runtime.git(["update-ref", `refs/heads/${input.branch}`, commitSha, input.parent], workspacePath);
    result = await reconcileReviewedIntegrationCommit({ runtime, workspacePath, branch: input.branch,
      ...prepared, identity, message: input.message });
    if (!result) throw new Error("reviewed_output_publication_not_observed");
    return result;
  } finally {
    // Cleanup is independent of publication; durable evidence permits retry even
    // if a transport failure hid a successful CAS or this cleanup itself fails.
    await rm(tempRoot, { recursive: true, force: true }).catch((error) => { if (!result) throw error; });
  }
}
