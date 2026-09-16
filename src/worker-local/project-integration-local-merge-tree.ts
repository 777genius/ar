import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { integrationAppliedFiles, normalizeProjectRelativePath, type IntegrationAttempt } from "@vioxen/subscription-runtime/worker-core";
import { applyReviewedMerge, assertPendingMergeParents, commitParents, type LocalGitMergeRuntime } from "./project-integration-local-merge-coordinator";
import { writeTemporaryIndexTree } from "./project-integration-local-output-rollback";

/** Replays the merge protocol offline; the dirty target is never an authorization baseline. */
export async function verifyLocalMergeOutputTree(runtime: LocalGitMergeRuntime, attempt: IntegrationAttempt): Promise<string> {
  if (!attempt.merge) throw new Error("merge_output_plan_required");
  const source = attempt.appliedMergeSourceCommit ?? attempt.merge.sourceCommit;
  const parents = [attempt.merge.expectedTargetCommit, source];
  const objectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
  if (![...parents, attempt.merge.sourceCommit].every((id) => typeof id === "string" && objectId.test(id)) ||
      typeof attempt.workerOutput.patchSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(attempt.workerOutput.patchSha256)) {
    throw new Error("merge_output_original_evidence_required");
  }
  const workspacePath = attempt.targetWorkspacePath;
  for (const parent of [...new Set([...parents, attempt.merge.sourceCommit])]) {
    if ((await runtime.git(["cat-file", "-t", parent], workspacePath)).stdout.trim() !== "commit") {
      throw new Error("merge_output_original_evidence_required");
    }
  }
  if ((await runtime.getStatus(workspacePath)).branch !== attempt.targetBranch) {
    throw new Error("merge_output_target_branch_changed");
  }
  const tempRoot = await mkdtemp(join(tmpdir(), "integration-merge-tree-"));
  const replayPath = join(tempRoot, "replay");
  let registered = false;
  let expected: string;
  try {
    const patchPath = await runtime.canonicalWorkerPatch(attempt.workerOutput);
    const frozenPatch = join(tempRoot, "reviewed.patch");
    await writeFile(frozenPatch, await readFile(patchPath), { flag: "wx", mode: 0o600 });
    await runtime.assertPatchSha256(frozenPatch, attempt.workerOutput.patchSha256);
    const replayOutput = { ...attempt.workerOutput, patchPath: frozenPatch };
    await runtime.git(["worktree", "add", "--detach", "--no-checkout", replayPath, parents[0]!], workspacePath);
    registered = true;
    await runtime.git(["reset", "--hard", parents[0]!], replayPath);
    const replayRuntime = { ...runtime, remoteBranchCommit: async () => source, canonicalWorkerPatch: async () => frozenPatch };
    const replay = await applyReviewedMerge({ runtime: replayRuntime, workspacePath: replayPath,
      attempt: { ...attempt, targetWorkspacePath: replayPath }, workerOutput: replayOutput,
      pinnedSourceCommit: source });
    if (JSON.stringify([...replay.changedFiles].sort()) !== JSON.stringify([...integrationAppliedFiles(attempt)].sort()) ||
        (replay.mergeSourceCommit ?? attempt.merge.sourceCommit) !== source) {
      throw new Error("merge_output_replay_identity_mismatch");
    }
    expected = (await runtime.git(["write-tree"], replayPath)).stdout.trim();
  } finally {
    if (registered) await runtime.git(["worktree", "remove", "--force", replayPath], workspacePath);
    await rm(tempRoot, { recursive: true, force: true });
  }
  if (attempt.authorizedMergeTree !== undefined && attempt.authorizedMergeTree !== expected) {
    throw new Error("merge_output_authorized_tree_mismatch");
  }
  const pending = await runtime.tryGit(["rev-parse", "--verify", "MERGE_HEAD"], workspacePath);
  const head = (await runtime.git(["rev-parse", "HEAD"], workspacePath)).stdout.trim();
  if (pending.exitCode === 0 && head === parents[0]) {
    await assertPendingMergeParents(runtime, workspacePath, parents);
  } else {
    if (pending.exitCode === 0 && pending.stdout.trim() !== source) throw new Error("merge_output_recovery_parent_mismatch");
    const actualParents = await commitParents(runtime, workspacePath, head);
    if (JSON.stringify(actualParents) !== JSON.stringify(parents) ||
        (await runtime.git(["rev-parse", "HEAD^{tree}"], workspacePath)).stdout.trim() !== expected) {
      throw new Error("merge_output_recovery_tree_mismatch");
    }
  }
  await assertLocalMergeWorkspaceTree(runtime, workspacePath, expected, integrationAppliedFiles(attempt));
  return expected;
}

export async function assertLocalMergeWorkspaceTree(runtime: LocalGitMergeRuntime, workspacePath: string,
  expected: string, files: readonly string[]): Promise<void> {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(expected)) throw new Error("merge_output_authorized_tree_required");
  const indexTree = (await runtime.git(["write-tree"], workspacePath)).stdout.trim();
  const worktreeTree = await writeTemporaryIndexTree({ runtime, workspacePath, baseCommit: expected,
    worktreeFiles: files });
  const untracked = await runtime.gitNullTerminatedPaths(["ls-files", "--others", "--exclude-standard", "-z"], workspacePath);
  if (indexTree !== expected || worktreeTree !== expected || untracked.length > 0) {
    throw new Error("merge_output_target_tree_mismatch");
  }
  // Finish with raw bytes after Git staging can run filters, covering every tracked entry.
  const root = resolve(workspacePath);
  const entries = (await runtime.git(["ls-tree", "-r", "-z", expected], workspacePath)).stdout.split("\0").filter(Boolean);
  for (const entry of entries) {
    const match = /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\t([\s\S]+)$/.exec(entry);
    if (!match) throw new Error("merge_output_target_tree_mismatch");
    const file = normalizeProjectRelativePath(match[3]!);
    // Git stdout is decoded text: U+FFFD filenames are unsupported because byte identity is ambiguous.
    if (file !== match[3] || file.includes("\uFFFD")) throw new Error("merge_output_target_tree_mismatch");
    const path = join(root, file);
    try {
      for (let parent = dirname(path); parent !== root; parent = dirname(parent)) {
        if (!(await lstat(parent)).isDirectory()) throw new Error("unsupported parent");
      }
      const stat = await lstat(path);
      if (!stat.isFile() || ((stat.mode & 0o100) !== 0) !== (match[1] === "100755")) throw new Error("unsupported mode");
      const raw = (await runtime.git(["hash-object", "--no-filters", "--", file], workspacePath)).stdout.trim();
      if (raw !== match[2]) throw new Error("raw blob mismatch");
    } catch {
      throw new Error("merge_output_target_tree_mismatch");
    }
  }
}
