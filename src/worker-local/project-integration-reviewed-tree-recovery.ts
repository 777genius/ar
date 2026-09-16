import { link, lstat, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CommitIdentity, GitCommitResult, PreparedReviewedGitCommit } from "@vioxen/subscription-runtime/worker-core";
import type { LocalGitOutputRollbackRuntime } from "./project-integration-local-output-rollback";

type PreparedInput = PreparedReviewedGitCommit & {
  readonly runtime: LocalGitOutputRollbackRuntime;
  readonly workspacePath: string;
  readonly identity: CommitIdentity;
  readonly message: string;
};

export async function assertPreparedReviewedCommit(input: PreparedInput): Promise<void> {
  for (const sha of [input.commitSha, input.parent, input.tree, input.originalIndexTree]) {
    if (!/^[a-f0-9]{40,64}$/.test(sha)) throw new Error("reviewed_output_prepared_identity_invalid");
  }
  const result = await input.runtime.git(["show", "-s", "--format=%T%x00%P%x00%an%x00%ae%x00%cn%x00%ce%x00%B", input.commitSha, "--"], input.workspacePath);
  const [tree, parents, author, authorEmail, committer, committerEmail, message] = result.stdout.split("\0");
  if (tree !== input.tree || parents !== input.parent || author !== input.identity.name ||
      committer !== input.identity.name || authorEmail !== input.identity.email ||
      committerEmail !== input.identity.email || message?.trimEnd() !== input.message.trimEnd()) {
    throw new Error("reviewed_output_prepared_identity_mismatch");
  }
}

/** Ref identity decides publication. Index recovery failure never erases that fact. */
export async function reconcileReviewedIntegrationCommit(input: PreparedInput & {
  readonly branch: string;
  readonly indexRecoveryCompleted?: boolean;
}): Promise<GitCommitResult | undefined> {
  const { runtime, workspacePath } = input;
  await assertPreparedReviewedCommit(input);
  const assertBranch = async () => {
    if ((await runtime.git(["symbolic-ref", "HEAD"], workspacePath)).stdout.trim() !== `refs/heads/${input.branch}`) {
      throw new Error("reviewed_output_target_branch_changed");
    }
  };
  await assertBranch();
  const head = (await runtime.git(["rev-parse", `refs/heads/${input.branch}`], workspacePath)).stdout.trim();
  if (head === input.parent) return undefined;
  if (head !== input.commitSha) throw new Error("reviewed_output_publication_ref_conflict");
  // A durable completed sync ends our ownership of the index. Subsequent staging
  // belongs to the caller, even when it exactly matches the original tree.
  if (input.indexRecoveryCompleted) return { commitSha: input.commitSha, parentCommits: [input.parent], reviewedIndexRecoveryPending: false };
  let pending = true;
  let tempRoot: string | undefined;
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  let lockPath: string | undefined;
  let ownerPath: string | undefined;
  let ownsLock = false;
  try {
    const indexPath = resolve(workspacePath, (await runtime.git(["rev-parse", "--git-path", "index"], workspacePath)).stdout.trim());
    lockPath = `${indexPath}.lock`;
    ownerPath = `${indexPath}.reviewed-${input.commitSha}.lock`;
    // A hard-linked staging file proves ownership of a lock left by this exact
    // publication. Never remove a foreign index.lock merely because it exists.
    const previousOwner = await lstat(ownerPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (previousOwner) {
      const previousLock = await lstat(lockPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (!previousOwner.isFile() || (previousLock && (!previousLock.isFile() ||
          previousOwner.ino !== previousLock.ino || previousOwner.dev !== previousLock.dev))) {
        throw new Error("reviewed_output_index_recovery_lock_conflict");
      }
      if (previousLock) await rm(lockPath);
      await rm(ownerPath);
    }
    lock = await open(ownerPath, "wx", 0o600);
    await link(ownerPath, lockPath);
    ownsLock = true;
    tempRoot = await mkdtemp(join(tmpdir(), "reviewed-index-recovery-"));
    const env = { ...process.env, GIT_INDEX_FILE: join(tempRoot, "index") };
    await writeFile(env.GIT_INDEX_FILE, await readFile(indexPath));
    const currentTree = (await runtime.git(["write-tree"], workspacePath, env)).stdout.trim();
    if (currentTree !== input.originalIndexTree && currentTree !== input.tree) throw new Error("reviewed_output_index_recovery_conflict");
    await runtime.git(["read-tree", input.tree], workspacePath, env);
    await lock.writeFile(await readFile(env.GIT_INDEX_FILE));
    await lock.sync();
    await assertBranch();
    if ((await runtime.git(["rev-parse", "HEAD"], workspacePath)).stdout.trim() !== input.commitSha) throw new Error("reviewed_output_publication_ref_conflict");
    await rename(lockPath, indexPath);
    pending = false;
  } catch {
    // Do not delete another writer's lock or overwrite a changed index. Retry the
    // same attempt to reconcile the recorded commit and synchronize independently.
  } finally {
    if (lock) {
      await lock.close().catch(() => {});
      if (pending && ownsLock && lockPath) {
        await rm(lockPath, { force: true }).then(() => { ownsLock = false; }, () => {});
      }
      // Keep the ownership proof when lock cleanup fails, for idempotent retry.
      if ((!pending || !ownsLock) && ownerPath) await rm(ownerPath, { force: true }).catch(() => {});
    }
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
  return { commitSha: input.commitSha, parentCommits: [input.parent], reviewedIndexRecoveryPending: pending };
}
