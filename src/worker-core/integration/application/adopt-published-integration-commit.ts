import { createAccessPolicyService } from "../../access-control";
import {
  IntegrationAttemptStatus, PushAttemptStatus, SecretScanStatus, ReviewDecisionStatus,
  allCheckRunsPassed, assertIntegrationCommitFiles, markCommitCreated, markPushed,
  reviewedOutputFileByteAllowance,
  type ExternalPublicationAttestation, type IntegrationAttempt,
} from "../domain/integration-attempt";
import { IntegrationAuditEventType } from "../domain/integration-events";
import {
  assertCommitMessageAllowed, assertRequiredChecksSatisfied,
  type ProjectIntegrationPolicy,
} from "../domain/integration-policy";
import { assertCommitIdentity } from "../ports/commit-identity-port";
import type { CommitApprovedChangesDeps } from "./commit-approved-changes";
import type { IntegratedOutputLedgerPort } from "../ports/integrated-output-ledger-port";
import {
  loadIntegrationAttempt, nowIso, recordIntegrationAudit, runIntegrationTransaction,
} from "./common";

export type AdoptPublishedIntegrationCommitDeps = CommitApprovedChangesDeps & {
  readonly integratedOutputLedger: IntegratedOutputLedgerPort;
};

export type AdoptPublishedIntegrationCommitInput = {
  readonly attemptId: string;
  readonly commitSha: string;
  readonly message: string;
  readonly attestation: ExternalPublicationAttestation;
  readonly policy: ProjectIntegrationPolicy;
};

/** Admin recovery for a locally inspectable object with operator-attested publication. */
export async function adoptPublishedIntegrationCommit(
  deps: AdoptPublishedIntegrationCommitDeps,
  input: AdoptPublishedIntegrationCommitInput,
): Promise<IntegrationAttempt> {
  return runIntegrationTransaction(deps, input.attemptId, async () => {
    const initial = await loadIntegrationAttempt(deps.store, input.attemptId);
    const lock = await deps.locks.acquire({
      workspacePath: initial.targetWorkspacePath, owner: initial.attemptId,
    });
    try {
      return await adoptLocked(deps, input);
    } finally {
      await deps.locks.release(lock);
    }
  });
}

async function adoptLocked(
  deps: AdoptPublishedIntegrationCommitDeps,
  input: AdoptPublishedIntegrationCommitInput,
): Promise<IntegrationAttempt> {
  let attempt = await loadIntegrationAttempt(deps.store, input.attemptId);
  if (![
    IntegrationAttemptStatus.ChecksPassed,
    IntegrationAttemptStatus.CommitCreated,
    IntegrationAttemptStatus.Pushed,
  ].includes(attempt.status)) throw new Error("published_commit_adoption_status_invalid");
  if (attempt.merge || !attempt.workerOutput.reviewedOutputId ||
      attempt.workerOutput.reviewedOutputFileByteAllowance === undefined ||
      !attempt.checkedReviewedTree || attempt.preparedReviewedCommit) {
    throw new Error("published_commit_adoption_exact_reviewed_output_required");
  }
  reviewedOutputFileByteAllowance(attempt.workerOutput.reviewedOutputFileByteAllowance);
  if (attempt.reviewDecision.decision !== ReviewDecisionStatus.Approved) {
    throw new Error("published_commit_adoption_review_not_approved");
  }
  if (!/^[a-f0-9]{40}$/.test(input.commitSha) ||
      !/^[a-f0-9]{64}$/.test(input.attestation.evidenceSha256) ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.attestation.repository) ||
      !/^[A-Za-z0-9_.@-]{1,200}$/.test(input.attestation.operator) ||
      !Number.isFinite(Date.parse(input.attestation.verifiedAt)) ||
      new Date(input.attestation.verifiedAt).toISOString() !== input.attestation.verifiedAt ||
      input.attestation.provenance !== "operator_attestation" ||
      input.attestation.verificationMethod !== "authenticated_gh_api" ||
      input.attestation.commitSha !== input.commitSha ||
      input.attestation.branch !== attempt.targetBranch ||
      input.attestation.remote !== attempt.targetRemote) {
    throw new Error("published_commit_adoption_attestation_invalid");
  }
  if (attempt.externalPublicationAttestation &&
      JSON.stringify(attempt.externalPublicationAttestation) !== JSON.stringify(input.attestation)) {
    throw new Error("published_commit_adoption_replay_conflict");
  }
  if (attempt.status === IntegrationAttemptStatus.ChecksPassed) {
    const ageMs = Date.parse(nowIso(deps.clock)) - Date.parse(input.attestation.verifiedAt);
    if (ageMs < -2 * 60_000 || ageMs > 30 * 60_000) {
      throw new Error("published_commit_adoption_attestation_stale");
    }
  }
  if (attempt.status !== IntegrationAttemptStatus.ChecksPassed &&
      (!attempt.externalPublicationAttestation || attempt.commitCandidate?.commitSha !== input.commitSha ||
       attempt.commitCandidate.message !== input.message)) {
    throw new Error("published_commit_adoption_replay_conflict");
  }
  if (attempt.status === IntegrationAttemptStatus.Pushed &&
      (attempt.pushAttempt?.commitSha !== input.commitSha ||
       attempt.pushAttempt.remote !== attempt.targetRemote ||
       attempt.pushAttempt.branch !== attempt.targetBranch ||
       attempt.pushAttempt.pushedAt !== input.attestation.verifiedAt)) {
    throw new Error("published_commit_adoption_replay_conflict");
  }
  assertCommitMessageAllowed(input.message);
  assertRequiredChecksSatisfied(input.policy, attempt);
  if (attempt.checkRuns.length === 0 || !allCheckRunsPassed(attempt.checkRuns)) {
    throw new Error("published_commit_adoption_checks_not_passed");
  }
  const decision = createAccessPolicyService(input.policy.access).canPushBranch({
    workspacePath: attempt.targetWorkspacePath,
    branch: attempt.targetBranch, remote: attempt.targetRemote, force: false,
  });
  if (!decision.allowed) throw new Error("published_commit_adoption_push_policy_denied");
  if (!deps.reviewedOutputIntegrity || !deps.git.reviewedOutputTreeFromPatch ||
      !deps.git.inspectIntegrationCommit || !deps.git.currentHead || !deps.git.remoteRepository) {
    throw new Error("published_commit_adoption_verifier_required");
  }
  if (await deps.git.remoteRepository({
    workspacePath: attempt.targetWorkspacePath, remote: attempt.targetRemote,
  }) !== input.attestation.repository.toLowerCase()) {
    throw new Error("published_commit_adoption_repository_mismatch");
  }
  await deps.reviewedOutputIntegrity.verify(attempt);
  const parent = (attempt.workerOutput.targetCommit ?? attempt.workerOutput.baseCommit)?.toLowerCase();
  if (!parent) throw new Error("published_commit_adoption_parent_required");
  const status = await deps.git.getStatus({ workspacePath: attempt.targetWorkspacePath });
  if (status.branch !== attempt.targetBranch || status.dirtyFiles.length !== 0) {
    throw new Error("published_commit_adoption_workspace_drift");
  }
  const head = await deps.git.currentHead({ workspacePath: attempt.targetWorkspacePath });
  if (head !== parent && head !== input.commitSha) {
    throw new Error("published_commit_adoption_head_drift");
  }
  const reviewedTree = await deps.git.reviewedOutputTreeFromPatch(attempt);
  if (reviewedTree !== attempt.checkedReviewedTree) {
    throw new Error("published_commit_adoption_reviewed_tree_drift");
  }
  const commit = await deps.git.inspectIntegrationCommit({
    workspacePath: attempt.targetWorkspacePath, commitSha: input.commitSha,
  });
  const identity = assertCommitIdentity(await deps.commitIdentity.approvedIdentity({
    projectId: attempt.projectId, workspacePath: attempt.targetWorkspacePath,
  }));
  if (commit.commitSha !== input.commitSha || commit.tree !== reviewedTree ||
      JSON.stringify(commit.parentCommits) !== JSON.stringify([parent]) ||
      commit.message !== input.message ||
      commit.author.name !== identity.name || commit.author.email !== identity.email ||
      commit.committer.name !== identity.name || commit.committer.email !== identity.email ||
      JSON.stringify(commit.files) !== JSON.stringify([...attempt.expectedFiles].sort())) {
    throw new Error("published_commit_adoption_commit_mismatch");
  }
  assertIntegrationCommitFiles(attempt, commit.files);
  const scan = await deps.scanner.scanFiles({
    workspacePath: attempt.targetWorkspacePath,
    reviewedTree, reviewedParent: parent,
    reviewedOutputFileByteAllowance: attempt.workerOutput.reviewedOutputFileByteAllowance,
    files: commit.files,
  });
  if (scan.status !== SecretScanStatus.Passed ||
      scan.scannedReviewedTree !== reviewedTree || scan.scannedReviewedParent !== parent) {
    throw new Error("published_commit_adoption_secret_scan_failed");
  }
  if (attempt.status === IntegrationAttemptStatus.ChecksPassed) {
    const adoptedAt = nowIso(deps.clock);
    attempt = {
      ...markCommitCreated(attempt, {
        commitCandidate: {
          commitSha: commit.commitSha, parentCommits: commit.parentCommits,
          message: commit.message, files: commit.files,
          secretScanStatus: SecretScanStatus.Passed, createdAt: adoptedAt,
        },
        now: adoptedAt,
      }),
      externalPublicationAttestation: input.attestation,
    };
    await deps.store.update(attempt);
  }
  const events = await deps.store.readEvents?.(attempt.attemptId);
  if (!events?.some((event) => event.type === IntegrationAuditEventType.ExternalCommitAdopted && event.commitSha === input.commitSha)) {
    await recordIntegrationAudit(deps, attempt, {
      type: IntegrationAuditEventType.ExternalCommitAdopted,
      occurredAt: attempt.commitCandidate!.createdAt,
      commitSha: input.commitSha,
      files: commit.files,
      safeReason: `operator_attestation:${input.attestation.operator}:${input.attestation.evidenceSha256}`,
    });
  }
  if (!deps.integratedOutputLedger.readPrepared || !deps.integratedOutputLedger.prepareAdoption) {
    throw new Error("published_commit_adoption_preparation_recovery_required");
  }
  const savedPreparation = await deps.integratedOutputLedger.readPrepared({ attempt, commitSha: input.commitSha });
  if (attempt.status === IntegrationAttemptStatus.Pushed && !savedPreparation) {
    throw new Error("published_commit_adoption_preparation_missing");
  }
  const preparation = savedPreparation ??
    await deps.integratedOutputLedger.prepareAdoption({ attempt, commitSha: input.commitSha });
  await deps.integratedOutputLedger.preflightFinalize({ preparation, pushedAt: input.attestation.verifiedAt });
  await deps.integratedOutputLedger.finalize({ preparation, pushedAt: input.attestation.verifiedAt });
  if (attempt.status !== IntegrationAttemptStatus.Pushed) {
    attempt = markPushed(attempt, {
      pushAttempt: {
        remote: attempt.targetRemote, branch: attempt.targetBranch,
        commitSha: input.commitSha, status: PushAttemptStatus.Pushed,
        pushedAt: input.attestation.verifiedAt,
      },
      now: input.attestation.verifiedAt,
    });
    await deps.store.update(attempt);
  }
  const pushedEvents = await deps.store.readEvents?.(attempt.attemptId);
  if (!pushedEvents?.some((event) => event.type === IntegrationAuditEventType.Pushed && event.commitSha === input.commitSha)) {
    await recordIntegrationAudit(deps, attempt, {
      type: IntegrationAuditEventType.Pushed, occurredAt: input.attestation.verifiedAt,
      commitSha: input.commitSha, safeReason: "operator_attested_external_publication",
    });
  }
  return attempt;
}
