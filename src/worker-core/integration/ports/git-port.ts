import type {
  CommitCandidate,
  IntegrationAttempt,
  WorkerOutput,
} from "../domain/integration-attempt";
import type { CommitIdentity } from "./commit-identity-port";

export type GitWorkspaceStatus = {
  readonly branch: string;
  readonly dirtyFiles: readonly string[];
};

export type GitApplyWorkerOutputResult = {
  readonly changedFiles: readonly string[];
  readonly mergeSourceCommit?: string;
};

export type GitDiffCheckResult = {
  readonly ok: boolean;
  readonly safeMessage?: string;
};

export type GitCommitResult = {
  readonly commitSha: string;
  readonly parentCommits?: readonly string[];
  readonly diffStat?: string;
  readonly reviewedIndexRecoveryPending?: boolean;
};

export type PreparedReviewedGitCommit = {
  readonly commitSha: string;
  readonly parent: string;
  readonly tree: string;
  readonly originalIndexTree: string;
};

export interface GitPort {
  reconcileReviewedCommit?(attempt: IntegrationAttempt): Promise<GitCommitResult | undefined>;
  verifyMergeOutputTree?(attempt: IntegrationAttempt): Promise<string>;
  verifyReviewedOutputTree?(attempt: IntegrationAttempt): Promise<string>;

  reviewedTreeChangedFiles?(input: {
    readonly attempt: IntegrationAttempt;
    readonly tree: string;
  }): Promise<readonly string[]>;

  getStatus(input: {
    readonly workspacePath: string;
  }): Promise<GitWorkspaceStatus> | GitWorkspaceStatus;

  applyWorkerOutput(input: {
    readonly attempt: IntegrationAttempt;
    readonly workerOutput: WorkerOutput;
    readonly allowAlreadyApplied?: boolean;
  }): Promise<GitApplyWorkerOutputResult> | GitApplyWorkerOutputResult;

  diffCheck(input: {
    readonly workspacePath: string;
  }): Promise<GitDiffCheckResult> | GitDiffCheckResult;

  changedFilesSinceCommit(input: {
    readonly workspacePath: string;
    readonly commit: string;
  }): Promise<readonly string[]> | readonly string[];

  commit(input: {
    readonly workspacePath: string;
    readonly message: string;
    readonly files: readonly string[];
    readonly identity: CommitIdentity;
    readonly expectedParentCommits?: readonly string[];
    readonly expectedMergeTree?: string;
    readonly reviewedAttempt?: IntegrationAttempt;
    readonly onReviewedCommitPrepared?: (prepared: PreparedReviewedGitCommit) => Promise<void>;
  }): Promise<GitCommitResult> | GitCommitResult;

  abortMerge?(input: {
    readonly attempt: IntegrationAttempt;
  }): Promise<void> | void;

  rollbackWorkerOutput?(input: {
    readonly attempt: IntegrationAttempt;
  }): Promise<void> | void;

  push(input: {
    readonly workspacePath: string;
    readonly remote: string;
    readonly branch: string;
    readonly commitSha: string;
    readonly force: boolean;
    readonly expectedRemoteCommit?: string;
  }): Promise<void> | void;

  remoteBranchCommit(input: {
    readonly workspacePath: string;
    readonly remote: string;
    readonly branch: string;
  }): Promise<string | null> | string | null;

  currentBranch(input: {
    readonly workspacePath: string;
  }): Promise<string> | string;
}

export function commitCandidateFromGitResult(input: {
  readonly message: string;
  readonly files: readonly string[];
  readonly secretScanStatus: CommitCandidate["secretScanStatus"];
  readonly createdAt: string;
  readonly result: GitCommitResult;
}): CommitCandidate {
  return {
    commitSha: input.result.commitSha,
    ...(input.result.parentCommits
      ? { parentCommits: input.result.parentCommits }
      : {}),
    message: input.message,
    files: input.files,
    secretScanStatus: input.secretScanStatus,
    createdAt: input.createdAt,
    ...(input.result.diffStat ? { diffStat: input.result.diffStat } : {}),
  };
}
