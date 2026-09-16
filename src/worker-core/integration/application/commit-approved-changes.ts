import {
  IntegrationAttemptStatus,
  reviewedOutputFileByteAllowance,
  SecretScanStatus,
  assertIntegrationCommitFiles,
  assertStatus,
  integrationAppliedFiles,
  markCommitCreated,
  normalizeProjectRelativePath,
  type IntegrationAttempt,
  type CommitCandidate,
} from "../domain/integration-attempt";
import {
  IntegrationError,
  IntegrationErrorReason,
} from "../domain/integration-errors";
import { IntegrationAuditEventType } from "../domain/integration-events";
import {
  assertCommitMessageAllowed,
  assertRequiredChecksSatisfied,
  type ProjectIntegrationPolicy,
} from "../domain/integration-policy";
import {
  assertCommitIdentity,
  type CommitIdentityPort,
} from "../ports/commit-identity-port";
import {
  commitCandidateFromGitResult,
  type GitPort,
  type GitCommitResult,
} from "../ports/git-port";
import type { SecretScannerPort, ReviewedOutputIntegrityPort } from "../ports/secret-scanner-port";
import type { WorkspaceLockPort } from "../ports/workspace-lock-port";
import {
  loadIntegrationAttempt,
  nowIso,
  recordIntegrationAudit,
  runIntegrationTransaction,
  type IntegrationUseCaseDeps,
} from "./common";

export type CommitApprovedChangesDeps = IntegrationUseCaseDeps & {
  readonly git: GitPort;
  readonly commitIdentity: CommitIdentityPort;
  readonly scanner: SecretScannerPort;
  readonly reviewedOutputIntegrity?: ReviewedOutputIntegrityPort;
  readonly locks: WorkspaceLockPort;
};

export type CommitApprovedChangesInput = {
  readonly attemptId: string;
  readonly message: string;
  readonly policy: ProjectIntegrationPolicy;
};

export async function commitApprovedChanges(
  deps: CommitApprovedChangesDeps,
  input: CommitApprovedChangesInput,
): Promise<IntegrationAttempt> {
  return await runIntegrationTransaction(deps, input.attemptId, async () =>
    await commitApprovedChangesTransaction(deps, input)
  );
}

async function commitApprovedChangesTransaction(
  deps: CommitApprovedChangesDeps,
  input: CommitApprovedChangesInput,
): Promise<IntegrationAttempt> {
  let attempt = await loadIntegrationAttempt(deps.store, input.attemptId);
  assertStatus(attempt, attempt.preparedReviewedCommit
    ? [IntegrationAttemptStatus.ChecksPassed, IntegrationAttemptStatus.CommitCreated]
    : [IntegrationAttemptStatus.ChecksPassed]);
  assertRequiredChecksSatisfied(input.policy, attempt);
  assertCommitMessageAllowed(input.message);
  const lock = await deps.locks.acquire({
    workspacePath: attempt.targetWorkspacePath,
    owner: attempt.attemptId,
  });
  try {
    if (
      attempt.workerOutput.reviewedOutputFileByteAllowance !== undefined ||
      attempt.workerOutput.reviewedOutputId !== undefined
    ) {
      reviewedOutputFileByteAllowance(attempt.workerOutput.reviewedOutputFileByteAllowance);
      if (!deps.reviewedOutputIntegrity) {
        throw new Error("reviewed_output_integrity_verifier_required");
      }
      await deps.reviewedOutputIntegrity.verify(attempt);
    }
    const identity = assertCommitIdentity(await deps.commitIdentity.approvedIdentity({
      projectId: input.policy.access.scope?.projectId ?? "",
      workspacePath: attempt.targetWorkspacePath,
    }));
    if (attempt.preparedReviewedCommit) {
      const prepared = attempt.preparedReviewedCommit;
      if (attempt.merge || !deps.git.reconcileReviewedCommit || !deps.git.reviewedTreeChangedFiles ||
          prepared.reviewedOutputId !== attempt.workerOutput.reviewedOutputId ||
          prepared.tree !== attempt.checkedReviewedTree ||
          prepared.identity.name !== identity.name || prepared.identity.email !== identity.email ||
          prepared.candidate.message !== input.message || prepared.candidate.secretScanStatus !== SecretScanStatus.Passed ||
          JSON.stringify(prepared.candidate.parentCommits) !== JSON.stringify([prepared.parent]) ||
          (attempt.commitCandidate !== undefined && JSON.stringify(attempt.commitCandidate) !== JSON.stringify(prepared.candidate)) ||
          attempt.workerOutput.reviewedOutputFileByteAllowance === undefined) {
        throw new Error("reviewed_output_prepared_identity_mismatch");
      }
      const files = await deps.git.reviewedTreeChangedFiles({ attempt, tree: prepared.tree });
      assertIntegrationCommitFiles(attempt, files);
      if (JSON.stringify(files) !== JSON.stringify(prepared.candidate.files)) throw new Error("reviewed_output_prepared_files_mismatch");
      const reconciled = await deps.git.reconcileReviewedCommit(attempt);
      if (reconciled) return await recordCommitted(deps, attempt, prepared.candidate, reconciled);
      if (attempt.status === IntegrationAttemptStatus.CommitCreated) throw new Error("reviewed_output_publication_ref_conflict");
    }
    const diffCheck = await deps.git.diffCheck({
      workspacePath: attempt.targetWorkspacePath,
    });
    if (!diffCheck.ok) {
      throw new IntegrationError({
        reason: IntegrationErrorReason.DiffCheckFailed,
        evidence: diffCheck.safeMessage ? [diffCheck.safeMessage] : [],
      });
    }
    let reviewedTree: string | undefined;
    let mergeTree: string | undefined;
    if (attempt.merge) {
      if (!deps.git.verifyMergeOutputTree) throw new Error("merge_output_tree_verifier_required");
      mergeTree = await deps.git.verifyMergeOutputTree(attempt);
      if (mergeTree !== attempt.checkedReviewedTree || mergeTree !== attempt.authorizedMergeTree) {
        throw new Error("merge_output_checks_migration_required");
      }
    }
    if (!attempt.merge && attempt.workerOutput.reviewedOutputFileByteAllowance !== undefined) {
      if (!deps.git.verifyReviewedOutputTree) throw new Error("reviewed_output_tree_verifier_required");
      if (!deps.git.reconcileReviewedCommit) throw new Error("reviewed_output_publication_reconciler_required");
      reviewedTree = await deps.git.verifyReviewedOutputTree(attempt);
      if (reviewedTree !== attempt.checkedReviewedTree) throw new Error("reviewed_output_checked_tree_mismatch");
    }
    const status = await deps.git.getStatus({
      workspacePath: attempt.targetWorkspacePath,
    });
    const observedDirtyFiles = status.dirtyFiles
      .map(normalizeProjectRelativePath)
      .sort();
    const dirtyFiles = reviewedTree !== undefined
      ? await (() => {
          if (!deps.git.reviewedTreeChangedFiles) throw new Error("reviewed_output_tree_delta_required");
          return deps.git.reviewedTreeChangedFiles({ attempt, tree: reviewedTree });
        })()
      : attempt.merge && observedDirtyFiles.length === 0
        ? [...integrationAppliedFiles(attempt)]
        : observedDirtyFiles;
    if (dirtyFiles.length === 0) {
      throw new IntegrationError({
        reason: IntegrationErrorReason.UnexpectedFiles,
        evidence: ["no_changed_files"],
      });
    }
    assertIntegrationCommitFiles(attempt, dirtyFiles);
    const sourceDeltaFiles = attempt.merge
      ? new Set(await deps.git.changedFilesSinceCommit({
          workspacePath: attempt.targetWorkspacePath,
          commit:
            attempt.appliedMergeSourceCommit ?? attempt.merge.sourceCommit,
        }))
      : undefined;
    const scanFiles = sourceDeltaFiles === undefined
      ? dirtyFiles
      : dirtyFiles.filter((file) => sourceDeltaFiles.has(file));
    const reviewedParent = reviewedTree === undefined ? undefined : (attempt.workerOutput.targetCommit ?? attempt.workerOutput.baseCommit)?.toLowerCase();
    if (reviewedTree !== undefined && !reviewedParent) throw new Error("reviewed_output_parent_required");
    const scan = await deps.scanner.scanFiles({
      ...(reviewedTree === undefined ? {} : { reviewedTree }),
      ...(reviewedParent === undefined ? {} : { reviewedParent }),
      workspacePath: attempt.targetWorkspacePath,
      files: scanFiles,
      ...(attempt.workerOutput.reviewedOutputFileByteAllowance === undefined
        ? {}
        : { reviewedOutputFileByteAllowance: attempt.workerOutput.reviewedOutputFileByteAllowance }),
    });
    if (scan.status !== SecretScanStatus.Passed || (reviewedTree !== undefined && (scan.scannedReviewedTree !== reviewedTree || scan.scannedReviewedParent !== reviewedParent))) {
      throw new IntegrationError({
        reason: IntegrationErrorReason.SecretScanFailed,
        evidence: scan.safeMessage ? [scan.safeMessage] : [],
      });
    }
    const committedAt = nowIso(deps.clock);
    let result: GitCommitResult;
    try {
      result = await deps.git.commit({
      workspacePath: attempt.targetWorkspacePath,
      message: input.message,
      files: dirtyFiles,
      identity,
      ...(reviewedTree === undefined ? {} : {
        reviewedAttempt: attempt,
        onReviewedCommitPrepared: async (prepared) => {
          const existing = attempt.preparedReviewedCommit;
          if (prepared.tree !== reviewedTree || (existing && (
            existing.candidate.commitSha !== prepared.commitSha || existing.parent !== prepared.parent ||
            existing.originalIndexTree !== prepared.originalIndexTree))) throw new Error("reviewed_output_prepared_identity_mismatch");
          if (existing) return;
          attempt = { ...attempt, preparedReviewedCommit: {
            reviewedOutputId: attempt.workerOutput.reviewedOutputId!, tree: prepared.tree,
            parent: prepared.parent, originalIndexTree: prepared.originalIndexTree, identity,
            candidate: commitCandidateFromGitResult({ message: input.message, files: dirtyFiles,
              secretScanStatus: scan.status, createdAt: committedAt,
              result: { commitSha: prepared.commitSha, parentCommits: [prepared.parent] } }),
          } };
          await deps.store.update(attempt);
        },
      }),
      ...(attempt.merge
        ? {
            expectedMergeTree: mergeTree!,
            expectedParentCommits: [
              attempt.merge.expectedTargetCommit,
              attempt.appliedMergeSourceCommit ?? attempt.merge.sourceCommit,
            ],
          }
        : {}),
    });
    } catch (error) {
      // A failed response after CAS is uncertain. Reconcile the exact persisted
      // candidate rather than losing CommitCreated or creating a replacement.
      if (!attempt.preparedReviewedCommit || !deps.git.reconcileReviewedCommit) throw error;
      const reconciled = await deps.git.reconcileReviewedCommit(attempt);
      if (!reconciled) throw error;
      result = reconciled;
    }
    if (reviewedTree !== undefined && !attempt.preparedReviewedCommit) throw new Error("reviewed_output_prepared_evidence_required");
    const commitCandidate = attempt.preparedReviewedCommit?.candidate ?? commitCandidateFromGitResult({
        message: input.message,
        files: dirtyFiles,
        secretScanStatus: scan.status,
        createdAt: committedAt,
        result,
      });
    return await recordCommitted(deps, attempt, commitCandidate, result);
  } finally {
    await deps.locks.release(lock);
  }
}

async function recordCommitted(deps: CommitApprovedChangesDeps, attempt: IntegrationAttempt,
  commitCandidate: CommitCandidate, result: GitCommitResult): Promise<IntegrationAttempt> {
  if (result.commitSha !== commitCandidate.commitSha) throw new Error("reviewed_output_prepared_identity_mismatch");
  const updated = {
    ...(attempt.status === IntegrationAttemptStatus.CommitCreated ? attempt : markCommitCreated(attempt, {
      commitCandidate, now: commitCandidate.createdAt,
    })),
    ...(result.reviewedIndexRecoveryPending === undefined ? {} : { reviewedIndexRecoveryPending: result.reviewedIndexRecoveryPending }),
  };
  await deps.store.update(updated);
  const events = await deps.store.readEvents?.(attempt.attemptId);
  if (!events?.some((event) => event.type === IntegrationAuditEventType.CommitCreated && event.commitSha === commitCandidate.commitSha)) {
    await recordIntegrationAudit(deps, updated, { type: IntegrationAuditEventType.CommitCreated,
      occurredAt: commitCandidate.createdAt, files: commitCandidate.files, commitSha: commitCandidate.commitSha });
  }
  return updated;
}
