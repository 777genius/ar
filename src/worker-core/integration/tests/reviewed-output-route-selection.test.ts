import { appendFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  type CheckRunnerPort,
  type GitCommitResult,
  CheckWorkspaceIntegrityDisposition,
  IntegrationAttemptStatus,
  IntegrationErrorReason,
  SecretScanStatus,
  applyWorkerOutput,
  commitApprovedChanges,
  openProjectIntegrationAttempt,
  pushApprovedCommit,
  runRequiredChecks,
} from "../../index";
import { LocalGitIntegrationAdapter } from "../../../worker-local/project-integration-local-adapters";
import type { LocalGitMergeRuntime } from "../../../worker-local/project-integration-local-merge-coordinator";
import { createMergeFixture, gitOutput } from "../../../worker-local/tests/project-integration-local-adapters.fixture";
import { createFixture, mergeInput, policy } from "./project-integration-use-cases.fixture";

const reviewed = {
  reviewedOutputId: "e".repeat(64),
  reviewedOutputFileByteAllowance: 8 * 1024 * 1024,
};

async function appliedFixture(merge = true) {
  const fixture = createFixture();
  const { merge: mergePlan, ...candidate } = mergeInput();
  const opened = await openProjectIntegrationAttempt(fixture.deps(), {
    ...candidate,
    ...(merge ? { merge: mergePlan } : {}),
    workerOutput: { ...candidate.workerOutput, ...reviewed },
  });
  await applyWorkerOutput(fixture.deps(), { attemptId: opened.attemptId });
  const verifyReviewedOutputTree = vi.fn(async () => "reviewed-tree");
  const reconcileReviewedCommit = vi.fn(async (): Promise<GitCommitResult | undefined> => undefined);
  const verify = vi.fn(async () => {});
  const deps = {
    ...fixture.deps(),
    git: Object.assign(fixture.git, { verifyReviewedOutputTree, reconcileReviewedCommit }),
    reviewedOutputIntegrity: { verify },
  };
  return { ...fixture, deps, opened, verifyReviewedOutputTree, reconcileReviewedCommit, verify };
}

describe("reviewed output custody route selection", () => {
  it("checks, commits, pushes and replays a reviewed-ID merge through the merge route", async () => {
    const fixture = await appliedFixture();
    const { deps, opened } = fixture;
    fixture.verifyReviewedOutputTree.mockRejectedValue(new Error("ordinary verifier must not receive merge"));
    const commit = vi.spyOn(deps.git, "commit");
    const scan = vi.spyOn(deps.scanner, "scanFiles");
    const checked = await runRequiredChecks(deps, { attemptId: opened.attemptId });
    expect(checked.status).toBe(IntegrationAttemptStatus.ChecksPassed);
    expect(checked.checkedReviewedTree).toBe(checked.authorizedMergeTree);
    expect(checked.authorizedMergeTree).toBe("e".repeat(40));
    const committed = await commitApprovedChanges(deps, {
      attemptId: opened.attemptId, message: "chore: merge reviewed output", policy: policy(),
    });
    expect(committed.status).toBe(IntegrationAttemptStatus.CommitCreated);
    expect(commit.mock.calls[0]?.[0]).toMatchObject({
      expectedParentCommits: [opened.merge!.expectedTargetCommit, opened.merge!.sourceCommit],
    });
    expect(commit.mock.calls[0]?.[0]).not.toHaveProperty("reviewedAttempt");
    expect(scan.mock.calls[0]?.[0]).toMatchObject({ reviewedOutputFileByteAllowance: reviewed.reviewedOutputFileByteAllowance });
    expect(fixture.verify).toHaveBeenCalledOnce();
    await pushApprovedCommit(deps, { attemptId: opened.attemptId, policy: policy() });
    await pushApprovedCommit(deps, { attemptId: opened.attemptId, policy: policy() });
    expect(fixture.git.calls.filter((call) => call === "push")).toHaveLength(1);
    expect(fixture.verifyReviewedOutputTree).not.toHaveBeenCalled();
    expect(fixture.reconcileReviewedCommit).not.toHaveBeenCalled();
  });

  it("keeps exact ordinary-patch verification before/after checks and before commit", async () => {
    const fixture = await appliedFixture(false);
    const checked = await runRequiredChecks(fixture.deps, { attemptId: fixture.opened.attemptId });
    expect(checked.checkedReviewedTree).toBe("reviewed-tree");
    expect(fixture.verifyReviewedOutputTree).toHaveBeenCalledTimes(2);
    fixture.verifyReviewedOutputTree.mockResolvedValue("mutated-tree");
    await expect(commitApprovedChanges(fixture.deps, {
      attemptId: fixture.opened.attemptId, message: "fix: reviewed output", policy: policy(),
    })).rejects.toThrow("reviewed_output_checked_tree_mismatch");
    expect(fixture.verifyReviewedOutputTree).toHaveBeenCalledTimes(3);
    expect(fixture.git.calls).not.toContain("commit");
  });

  it("still rejects incorrect merge commit parents", async () => {
    const fixture = await appliedFixture();
    await runRequiredChecks(fixture.deps, { attemptId: fixture.opened.attemptId });
    fixture.git.commitParents = ["c".repeat(40)];
    await expect(commitApprovedChanges(fixture.deps, {
      attemptId: fixture.opened.attemptId, message: "chore: merge reviewed output", policy: policy(),
    })).rejects.toMatchObject({ reason: IntegrationErrorReason.MergeParentsMismatch });
    expect(fixture.store.get(fixture.opened.attemptId)?.status).toBe(IntegrationAttemptStatus.ChecksPassed);
  });

  it("does not commit a merge whose check restored a mutated workspace tree", async () => {
    const fixture = await appliedFixture();
    const runCheck = fixture.deps.checks.runCheck.bind(fixture.deps.checks);
    vi.spyOn(fixture.deps.checks, "runCheck").mockImplementation((input) => ({
      ...runCheck(input), workspaceIntegrity: CheckWorkspaceIntegrityDisposition.Restored,
    }));
    const checked = await runRequiredChecks(fixture.deps, { attemptId: fixture.opened.attemptId });
    expect(checked.status).toBe(IntegrationAttemptStatus.ChecksFailed);
    await expect(commitApprovedChanges(fixture.deps, {
      attemptId: fixture.opened.attemptId, message: "chore: merge reviewed output", policy: policy(),
    })).rejects.toMatchObject({ reason: IntegrationErrorReason.InvalidTransition });
    expect(fixture.git.calls).not.toContain("commit");
  });

  it("rejects ordinary prepared-commit recovery evidence on a merge", async () => {
    const fixture = await appliedFixture();
    const checked = await runRequiredChecks(fixture.deps, { attemptId: fixture.opened.attemptId });
    Object.assign(fixture.deps.git, { reviewedTreeChangedFiles: vi.fn(async () => ["src/memory.ts"]) });
    fixture.reconcileReviewedCommit.mockResolvedValue({ commitSha: "c".repeat(40), parentCommits: [checked.merge!.expectedTargetCommit] });
    // All ordinary prepared fields and ports are otherwise valid; only the protocol differs.
    fixture.store.update({ ...checked, preparedReviewedCommit: {
      reviewedOutputId: reviewed.reviewedOutputId, tree: checked.checkedReviewedTree!, parent: checked.merge!.expectedTargetCommit,
      originalIndexTree: "f".repeat(40), identity: { name: "Approved Integrator", email: "integrator@example.com" },
      candidate: { commitSha: "c".repeat(40), message: "chore: merge reviewed output", files: ["src/memory.ts"],
        parentCommits: [checked.merge!.expectedTargetCommit],
        secretScanStatus: SecretScanStatus.Passed, createdAt: checked.updatedAt },
    } });
    await expect(commitApprovedChanges(fixture.deps, {
      attemptId: fixture.opened.attemptId, message: "chore: merge reviewed output", policy: policy(),
    })).rejects.toThrow("reviewed_output_prepared_identity_mismatch");
    expect(fixture.reconcileReviewedCommit).not.toHaveBeenCalled();
    expect(fixture.git.calls).not.toContain("commit");
  });

  it("retains reviewed-output integrity verification for merges", async () => {
    const fixture = await appliedFixture();
    await runRequiredChecks(fixture.deps, { attemptId: fixture.opened.attemptId });
    fixture.verify.mockRejectedValue(new Error("reviewed artifact mutated"));
    await expect(commitApprovedChanges(fixture.deps, {
      attemptId: fixture.opened.attemptId, message: "chore: merge reviewed output", policy: policy(),
    })).rejects.toThrow("reviewed artifact mutated");
    expect(fixture.git.calls).not.toContain("commit");
  });
});

// Real Git custody checks use only disposable fixture repositories.
describe("reviewed-ID merge with local Git", () => {
  it.each(["unchanged", "recovery", "patch", "parent", "tree", "before-checks", "check-mutation", "forged-recovery", "legacy", "legacy-tamper", "quit-recovery", "patch-after-checks", "legacy-passed", "staged-tree", "hidden-tree", "commit-mutation"] as const)(
    "preserves existing merge controls for %s output",
    async (mutation) => {
      const repo = await createMergeFixture();
      try {
        const fixture = createFixture();
        const candidate = mergeInput();
        const localPolicy = {
          ...policy(), access: { ...policy().access, scope: {
            ...policy().access.scope!, workspaceRoots: [repo.workspacePath],
            worktreeRoots: [repo.workspacePath],
          } },
        };
        const git = new LocalGitIntegrationAdapter({ allowedPatchRoots: [repo.rootDir] });
        const verifyTree = vi.spyOn(git, "verifyReviewedOutputTree");
        const deps = { ...fixture.deps(), checks: fixture.checks as CheckRunnerPort, git, reviewedOutputIntegrity: { verify: async () => {} } };
        const opened = await openProjectIntegrationAttempt(deps, {
          ...candidate, policy: localPolicy,
          sourceWorkspacePath: repo.workspacePath, targetWorkspacePath: repo.workspacePath,
          merge: { ...candidate.merge, sourceCommit: repo.sourceCommit, expectedTargetCommit: repo.targetCommit },
          workerOutput: { ...candidate.workerOutput, ...reviewed, workspacePath: repo.workspacePath,
            baseCommit: repo.targetCommit, patchPath: repo.patchPath, patchSha256: repo.patchSha256 },
        });
        if (mutation === "patch") {
          await appendFile(repo.patchPath, "\nmutated\n");
          await expect(applyWorkerOutput(deps, { attemptId: opened.attemptId }))
            .rejects.toThrow("local_git_integration_patch_hash_mismatch");
          return;
        }
        await applyWorkerOutput(deps, { attemptId: opened.attemptId });
        if (mutation === "legacy" || mutation === "legacy-tamper") {
          const applied = fixture.store.get(opened.attemptId)!;
          const { authorizedMergeTree: _tree, ...legacy } = applied;
          fixture.store.update(legacy);
        }
        if (mutation === "before-checks" || mutation === "legacy-tamper") {
          await writeFile(join(repo.workspacePath, "src/memory.ts"), "unreviewed content\n");
          await expect(runRequiredChecks(deps, { attemptId: opened.attemptId })).rejects.toThrow("merge_output_target_tree_mismatch");
          expect((await gitOutput(repo.workspacePath, ["rev-parse", "HEAD"])).trim()).toBe(repo.targetCommit);
          return;
        }
        if (mutation === "check-mutation") {
          const runCheck = deps.checks.runCheck.bind(deps.checks);
          vi.spyOn(deps.checks, "runCheck").mockImplementation(async (input) => {
            await writeFile(join(repo.workspacePath, "src/memory.ts"), "check mutated content\n");
            return runCheck(input);
          });
          await expect(runRequiredChecks(deps, { attemptId: opened.attemptId })).rejects.toThrow("merge_output_target_tree_mismatch");
          return;
        }
        const checked = await runRequiredChecks(deps, { attemptId: opened.attemptId });
        expect(checked.authorizedMergeTree).toBe(checked.checkedReviewedTree);
        if (mutation === "legacy-passed") {
          const { authorizedMergeTree: _tree, checkedReviewedTree: _checked, ...legacy } = checked;
          fixture.store.update(legacy);
          await expect(commitApprovedChanges(deps, {
            attemptId: opened.attemptId, message: "chore: merge reviewed output", policy: localPolicy,
          })).rejects.toThrow("merge_output_checks_migration_required");
          const run = vi.spyOn(deps.checks, "runCheck");
          const migrated = await runRequiredChecks(deps, { attemptId: opened.attemptId });
          expect(run).toHaveBeenCalledOnce();
          expect(migrated.authorizedMergeTree).toBe(checked.authorizedMergeTree);
          expect(migrated.checkedReviewedTree).toBe(checked.checkedReviewedTree);
        }
        if (mutation === "patch-after-checks") {
          await appendFile(repo.patchPath, "changed patch\n");
          await expect(commitApprovedChanges(deps, {
            attemptId: opened.attemptId, message: "chore: merge reviewed output", policy: localPolicy,
          })).rejects.toThrow("local_git_integration_patch_hash_mismatch");
          return;
        }
        if (mutation === "quit-recovery") {
          const faultPort = git as unknown as Pick<LocalGitMergeRuntime, "git">;
          const originalGit = faultPort.git.bind(git);
          let failQuit = true;
          vi.spyOn(faultPort, "git").mockImplementation(async (args, ...rest) => {
            if (args[0] === "merge" && args[1] === "--quit" && failQuit) {
              failQuit = false;
              throw new Error("lost commit acknowledgement");
            }
            return originalGit(args, ...rest);
          });
        }
        if (mutation === "forged-recovery") {
          await writeFile(join(repo.workspacePath, "src/memory.ts"), "forged content\n");
          await gitOutput(repo.workspacePath, ["add", "src/memory.ts"]);
          await gitOutput(repo.workspacePath, ["-c", "user.name=Approved Integrator", "-c", "user.email=integrator@example.com", "commit", "-m", "chore: merge reviewed output"]);
          await expect(commitApprovedChanges(deps, {
            attemptId: opened.attemptId, message: "chore: merge reviewed output", policy: localPolicy,
          })).rejects.toThrow("merge_output_recovery_tree_mismatch");
          expect((await gitOutput(repo.workspacePath, ["show", "-s", "--format=%P", "HEAD"])).trim()).toBe(`${repo.targetCommit} ${repo.sourceCommit}`);
          expect((await gitOutput(repo.workspacePath, ["show", "-s", "--format=%an|%ae|%cn|%ce", "HEAD"])).trim()).toBe("Approved Integrator|integrator@example.com|Approved Integrator|integrator@example.com");
          return;
        }
        expect(checked.status).toBe(IntegrationAttemptStatus.ChecksPassed);
        if (mutation === "parent") {
          await writeFile(join(repo.workspacePath, ".git/MERGE_HEAD"), `${repo.targetCommit}\n`);
        } else if (mutation === "tree" || mutation === "staged-tree" || mutation === "hidden-tree") {
          await writeFile(join(repo.workspacePath, "src/memory.ts"), "unreviewed content\n");
          if (mutation === "staged-tree") await gitOutput(repo.workspacePath, ["add", "src/memory.ts"]);
          if (mutation === "hidden-tree") await gitOutput(repo.workspacePath, ["update-index", "--assume-unchanged", "src/memory.ts"]);
        }
        if (mutation === "commit-mutation") {
          const commit = git.commit.bind(git);
          vi.spyOn(git, "commit").mockImplementation(async (input) => {
            await writeFile(join(repo.workspacePath, "src/memory.ts"), "late mutation\n");
            return commit(input);
          });
        }
        if (mutation === "recovery") fixture.store.failNextUpdate = new Error("lost commit acknowledgement");
        let committed = commitApprovedChanges(deps, {
          attemptId: opened.attemptId, message: "chore: merge reviewed output", policy: localPolicy,
        });
        let recoveredCommit: string | undefined;
        if (mutation === "recovery" || mutation === "quit-recovery") {
          await expect(committed).rejects.toThrow("lost commit acknowledgement");
          recoveredCommit = (await gitOutput(repo.workspacePath, ["rev-parse", "HEAD"])).trim();
          committed = commitApprovedChanges(deps, {
            attemptId: opened.attemptId, message: "chore: merge reviewed output", policy: localPolicy,
          });
        }
        if (mutation === "unchanged" || mutation === "recovery" || mutation === "legacy" || mutation === "legacy-passed" || mutation === "quit-recovery") {
          await expect(committed).resolves.toMatchObject({
            status: IntegrationAttemptStatus.CommitCreated,
            commitCandidate: { parentCommits: [repo.targetCommit, repo.sourceCommit],
              ...(recoveredCommit === undefined ? {} : { commitSha: recoveredCommit }) },
          });
        } else if (mutation === "tree" || mutation === "staged-tree" || mutation === "hidden-tree" || mutation === "commit-mutation") {
          await expect(committed).rejects.toThrow("merge_output_target_tree_mismatch");
        } else {
          await expect(committed).rejects.toMatchObject({ reason: IntegrationErrorReason.MergeParentsMismatch });
        }
        if (mutation === "unchanged" || mutation === "recovery" || mutation === "legacy" || mutation === "legacy-passed" || mutation === "quit-recovery") {
          expect((await gitOutput(repo.workspacePath, ["rev-parse", "HEAD^{tree}"])).trim()).toBe(checked.authorizedMergeTree);
        }
        expect(verifyTree).not.toHaveBeenCalled();
      } finally {
        await rm(repo.rootDir, { recursive: true, force: true });
      }
    },
  );
});
