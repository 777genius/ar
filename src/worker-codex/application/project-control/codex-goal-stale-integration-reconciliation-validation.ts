import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import {
  CheckRunStatus,
  IntegrationAttemptStatus,
  PushAttemptStatus,
  ReviewDecisionStatus,
  SecretScanStatus,
  markChecksRunning,
  markCommitCreated,
  markWorkerOutputApplied,
  openIntegrationAttempt,
  recordCheckRuns,
  type IntegrationAttempt,
} from "@vioxen/subscription-runtime/worker-core";
import {
  assertSafeGitRemoteName,
} from "./codex-goal-project-git";
import type {
  StaleIntegrationPatchEvidence,
  StaleIntegrationReconciliationEntry,
  StaleIntegrationReconciliationPlan,
} from "./codex-goal-stale-integration-reconciliation";

export function assertStaleIntegrationAttemptStructure(input: {
  readonly attempt: IntegrationAttempt;
  readonly attemptPath: string;
  readonly directoryName: string;
  readonly attemptsRoot: string;
  readonly controllerJobId: string;
  readonly projectId: string;
  readonly assertTargetBranch: (value: string) => void;
}): void {
  const attempt = input.attempt as unknown;
  if (!isRecord(attempt) ||
    typeof attempt.attemptId !== "string" || attempt.attemptId.length === 0 ||
    attempt.attemptId.length > 256 || /[\x00-\x1f\x7f]/.test(attempt.attemptId) ||
    !enumValue(IntegrationAttemptStatus, attempt.status) ||
    !nonEmptyString(attempt.controllerJobId) ||
    !nonEmptyString(attempt.projectId) ||
    !nonEmptyString(attempt.workerJobId) ||
    !nonEmptyString(attempt.sourceWorkspacePath) ||
    !nonEmptyString(attempt.targetWorkspacePath) ||
    !nonEmptyString(attempt.targetRemote) ||
    !nonEmptyString(attempt.targetBranch) ||
    !stringArray(attempt.expectedFiles) || attempt.expectedFiles.length === 0 ||
    !isRecord(attempt.workerOutput) ||
    !isRecord(attempt.reviewDecision) ||
    !Array.isArray(attempt.checkRuns) ||
    !nonEmptyString(attempt.createdAt) || !nonEmptyString(attempt.updatedAt)) {
    invalid();
  }
  assertWorkerOutputStructure(attempt.workerOutput);
  assertReviewDecisionStructure(attempt.reviewDecision);
  if (attempt.workerJobId !== attempt.workerOutput.workerJobId ||
    resolve(attempt.sourceWorkspacePath) !==
      resolve(attempt.workerOutput.workspacePath as string) ||
    attempt.reviewDecision.decision !== ReviewDecisionStatus.Approved ||
    JSON.stringify(attempt.expectedFiles) !==
      JSON.stringify(attempt.reviewDecision.approvedFiles)) {
    invalid();
  }
  if (attempt.merge !== undefined) assertMergeStructure(attempt.merge);
  if (attempt.appliedFiles !== undefined && !stringArray(attempt.appliedFiles)) {
    invalid();
  }
  if (attempt.appliedMergeSourceCommit !== undefined &&
    !safeCommit(attempt.appliedMergeSourceCommit)) {
    invalid();
  }
  for (const run of attempt.checkRuns) assertCheckRunStructure(run);
  if (attempt.commitCandidate !== undefined) {
    assertCommitCandidateStructure(attempt.commitCandidate);
  }
  if (attempt.pushAttempt !== undefined) assertPushAttemptStructure(attempt.pushAttempt);
  if (attempt.promotionAttempts !== undefined) {
    if (!Array.isArray(attempt.promotionAttempts)) invalid();
    for (const promotion of attempt.promotionAttempts) {
      assertPushAttemptStructure(promotion);
    }
  }
  if (attempt.rejectReason !== undefined && typeof attempt.rejectReason !== "string") {
    invalid();
  }
  const expectedDirectory = digest(attempt.attemptId);
  const expectedPath = join(resolve(input.attemptsRoot), expectedDirectory, "attempt.json");
  if (input.directoryName !== expectedDirectory ||
    resolve(input.attemptPath) !== expectedPath ||
    attempt.controllerJobId !== input.controllerJobId ||
    attempt.projectId !== input.projectId) {
    throw new Error("stale_integration_reconciliation_attempt_binding_noncanonical");
  }
  assertSafeGitRemoteName(attempt.targetRemote, "targetRemote");
  input.assertTargetBranch(attempt.targetBranch);
  assertLifecycleDomainInvariants(attempt as unknown as IntegrationAttempt);
}

function assertLifecycleDomainInvariants(attempt: IntegrationAttempt): void {
  if (attempt.status === IntegrationAttemptStatus.Pushed ||
    attempt.status === IntegrationAttemptStatus.Rejected) return;
  try {
    let expected = openIntegrationAttempt({
      attemptId: attempt.attemptId,
      projectId: attempt.projectId,
      controllerJobId: attempt.controllerJobId,
      sourceWorkspacePath: attempt.sourceWorkspacePath,
      targetWorkspacePath: attempt.targetWorkspacePath,
      targetBranch: attempt.targetBranch,
      targetRemote: attempt.targetRemote,
      ...(attempt.merge ? { merge: attempt.merge } : {}),
      workerOutput: attempt.workerOutput,
      reviewDecision: attempt.reviewDecision,
      now: attempt.createdAt,
    });
    if (attempt.status !== IntegrationAttemptStatus.Opened) {
      if (attempt.merge && !attempt.appliedFiles) invalid();
      expected = markWorkerOutputApplied(expected, {
        changedFiles: attempt.appliedFiles ?? attempt.workerOutput.changedFiles,
        ...(attempt.appliedMergeSourceCommit
          ? { mergeSourceCommit: attempt.appliedMergeSourceCommit }
          : {}),
        now: attempt.updatedAt,
      });
    }
    if (attempt.status === IntegrationAttemptStatus.ChecksRunning) {
      expected = markChecksRunning(expected, attempt.updatedAt);
      if (attempt.checkRuns.length > 0) {
        expected = recordCheckRuns(expected, {
          checkRuns: attempt.checkRuns,
          now: attempt.updatedAt,
        });
        if (expected.status !== IntegrationAttemptStatus.ChecksFailed) invalid();
        expected = markChecksRunning(expected, attempt.updatedAt);
      }
    } else if (
      attempt.status === IntegrationAttemptStatus.ChecksFailed ||
      attempt.status === IntegrationAttemptStatus.ChecksPassed ||
      attempt.status === IntegrationAttemptStatus.CommitCreated
    ) {
      expected = markChecksRunning(expected, attempt.updatedAt);
      expected = recordCheckRuns(expected, {
        checkRuns: attempt.checkRuns,
        now: attempt.updatedAt,
      });
      if (attempt.status === IntegrationAttemptStatus.CommitCreated) {
        if (!attempt.commitCandidate) invalid();
        expected = markCommitCreated(expected, {
          commitCandidate: attempt.commitCandidate,
          now: attempt.updatedAt,
        });
      }
    }
    if (JSON.stringify(lifecycleProjection(expected)) !==
      JSON.stringify(lifecycleProjection(attempt))) invalid();
  } catch (error) {
    if (error instanceof Error &&
      error.message === "stale_integration_reconciliation_attempt_structure_invalid") {
      throw error;
    }
    invalid();
  }
}

function lifecycleProjection(attempt: IntegrationAttempt): unknown {
  return {
    attemptId: attempt.attemptId,
    projectId: attempt.projectId,
    controllerJobId: attempt.controllerJobId,
    workerJobId: attempt.workerJobId,
    sourceWorkspacePath: attempt.sourceWorkspacePath,
    targetWorkspacePath: attempt.targetWorkspacePath,
    targetBranch: attempt.targetBranch,
    targetRemote: attempt.targetRemote,
    expectedFiles: attempt.expectedFiles,
    ...(attempt.merge ? { merge: attempt.merge } : {}),
    ...(attempt.appliedFiles ? { appliedFiles: attempt.appliedFiles } : {}),
    ...(attempt.appliedMergeSourceCommit
      ? { appliedMergeSourceCommit: attempt.appliedMergeSourceCommit }
      : {}),
    status: attempt.status,
    workerOutput: attempt.workerOutput,
    reviewDecision: attempt.reviewDecision,
    checkRuns: attempt.checkRuns,
    ...(attempt.commitCandidate ? { commitCandidate: attempt.commitCandidate } : {}),
    ...(attempt.pushAttempt ? { pushAttempt: attempt.pushAttempt } : {}),
    ...(attempt.promotionAttempts
      ? { promotionAttempts: attempt.promotionAttempts }
      : {}),
    ...(attempt.rejectReason ? { rejectReason: attempt.rejectReason } : {}),
    createdAt: attempt.createdAt,
    updatedAt: attempt.updatedAt,
  };
}

export function assertStaleIntegrationUnsignedPlanStructure(
  plan: Omit<StaleIntegrationReconciliationPlan, "planSha256">,
  controllerJobRootDir: string,
  assertTargetBranch: (value: string) => void,
): void {
  if (plan.schemaVersion !== 1 || !nonEmptyString(plan.controllerJobId) ||
    !nonEmptyString(plan.projectId) ||
    resolve(plan.registryRootDir) !== plan.registryRootDir ||
    resolve(plan.controllerJobRootDir) !== plan.controllerJobRootDir ||
    resolve(controllerJobRootDir) !== plan.controllerJobRootDir ||
    !sha256String(plan.controllerManifestSha256) ||
    !sha256String(plan.controllerScopeEpochSha256) ||
    resolve(plan.gitBinaryPath) !== plan.gitBinaryPath ||
    !exactSortedResolved(plan.targetWorkspaceRoots) ||
    !exactSortedResolved(plan.deniedRoots) ||
    !exactSortedStrings(plan.allowedGitRemotes) ||
    !exactSortedStrings(plan.allowedBranches) || !Array.isArray(plan.entries)) {
    throw new Error("stale_integration_reconciliation_plan_structure_invalid");
  }
  for (const remote of plan.allowedGitRemotes) {
    assertSafeGitRemoteName(remote, "allowedGitRemote");
  }
  const attemptIds = new Set<string>();
  const attemptPaths = new Set<string>();
  const targetBindings = new Set<string>();
  const attemptsRoot = join(
    plan.controllerJobRootDir,
    "project-integration",
    "integration-attempts",
  );
  for (const entry of plan.entries) {
    assertEntryStructure(entry, attemptsRoot, assertTargetBranch);
    const targetBinding = JSON.stringify([
      entry.attemptId,
      entry.targetWorkspacePath,
      entry.targetRemote,
      entry.targetBranch,
    ]);
    if (attemptIds.has(entry.attemptId) || attemptPaths.has(entry.attemptPath) ||
      targetBindings.has(targetBinding)) {
      throw new Error("stale_integration_reconciliation_attempt_binding_duplicate");
    }
    attemptIds.add(entry.attemptId);
    attemptPaths.add(entry.attemptPath);
    targetBindings.add(targetBinding);
  }
}

function assertEntryStructure(
  entry: StaleIntegrationReconciliationEntry,
  attemptsRoot: string,
  assertTargetBranch: (value: string) => void,
): void {
  if (!nonEmptyString(entry.attemptId) || entry.attemptId.length > 256 ||
    /[\x00-\x1f\x7f]/.test(entry.attemptId) ||
    !sha256String(entry.attemptSha256) ||
    !enumValue(IntegrationAttemptStatus, entry.status) ||
    !nonEmptyString(entry.targetRemote) || !nonEmptyString(entry.targetBranch) ||
    resolve(entry.targetWorkspacePath) !== entry.targetWorkspacePath) {
    throw new Error("stale_integration_reconciliation_entry_structure_invalid");
  }
  assertSafeGitRemoteName(entry.targetRemote, "targetRemote");
  assertTargetBranch(entry.targetBranch);
  const expectedPath = join(attemptsRoot, digest(entry.attemptId), "attempt.json");
  if (resolve(entry.attemptPath) !== expectedPath ||
    entry.remoteRef !== undefined &&
      entry.remoteRef !== `refs/remotes/${entry.targetRemote}/${entry.targetBranch}` ||
    entry.remoteHead !== undefined && !/^[a-f0-9]{40,64}$/.test(entry.remoteHead)) {
    throw new Error("stale_integration_reconciliation_entry_binding_noncanonical");
  }
  if (entry.patchEvidence) assertPatchEvidenceStructure(entry.patchEvidence);
}

function assertPatchEvidenceStructure(evidence: StaleIntegrationPatchEvidence): void {
  if (resolve(evidence.declaredPath) !== evidence.declaredPath ||
    resolve(evidence.canonicalPath) !== evidence.canonicalPath ||
    !nonNegativeInteger(evidence.device) || !nonNegativeInteger(evidence.inode) ||
    !nonNegativeInteger(evidence.mode) || !nonNegativeInteger(evidence.size) ||
    !sha256String(evidence.sha256) || !sha256String(evidence.reviewedOutputId) ||
    !nonEmptyString(evidence.reviewedProjectId) ||
    !nonEmptyString(evidence.reviewedControllerJobId) ||
    !nonEmptyString(evidence.reviewedWorkerJobId)) {
    throw new Error("stale_integration_reconciliation_patch_evidence_invalid");
  }
}

function assertWorkerOutputStructure(value: Record<string, unknown>): void {
  if (!nonEmptyString(value.workerJobId) || !nonEmptyString(value.workspacePath) ||
    !stringArray(value.changedFiles) ||
    value.patchPath !== undefined && !nonEmptyString(value.patchPath) ||
    value.sourcePatchPath !== undefined && !nonEmptyString(value.sourcePatchPath) ||
    !nonEmptyString(value.patchPath ?? value.sourcePatchPath) ||
    !sha256String(value.patchSha256) ||
    value.commitSha !== undefined && !safeCommit(value.commitSha) ||
    value.baseCommit !== undefined && !safeCommit(value.baseCommit) ||
    value.targetCommit !== undefined && !safeCommit(value.targetCommit) ||
    value.baseRevisionReasons !== undefined && !stringArray(value.baseRevisionReasons) ||
    value.evidencePaths !== undefined && !stringArray(value.evidencePaths)) invalid();
}

function assertReviewDecisionStructure(value: Record<string, unknown>): void {
  if (!nonEmptyString(value.reviewedBy) ||
    !enumValue(ReviewDecisionStatus, value.decision) || !nonEmptyString(value.reason) ||
    !stringArray(value.approvedFiles) || value.approvedFiles.length === 0 ||
    !Array.isArray(value.requiredChecks) ||
    value.riskyPaths !== undefined && !stringArray(value.riskyPaths)) invalid();
  for (const check of value.requiredChecks) {
    if (!isRecord(check) || !nonEmptyString(check.checkId) ||
      !stringArray(check.command) || check.command.length === 0 ||
      check.cwd !== undefined && !nonEmptyString(check.cwd) ||
      check.timeoutMs !== undefined && !positiveInteger(check.timeoutMs)) invalid();
  }
}

function assertMergeStructure(value: unknown): void {
  if (!isRecord(value) || !nonEmptyString(value.sourceRemote) ||
    !nonEmptyString(value.sourceBranch) || !safeCommit(value.sourceCommit) ||
    !safeCommit(value.expectedTargetCommit)) invalid();
}

function assertCheckRunStructure(value: unknown): void {
  if (!isRecord(value) || !nonEmptyString(value.checkId) ||
    !stringArray(value.command) || value.command.length === 0 ||
    !enumValue(CheckRunStatus, value.status) || !nonEmptyString(value.startedAt) ||
    !nonEmptyString(value.completedAt) ||
    value.exitCode !== undefined && !Number.isSafeInteger(value.exitCode) ||
    value.safeOutputTail !== undefined && typeof value.safeOutputTail !== "string") invalid();
}

function assertCommitCandidateStructure(value: unknown): void {
  if (!isRecord(value) || !safeCommit(value.commitSha) ||
    value.parentCommits !== undefined &&
      (!stringArray(value.parentCommits) || !value.parentCommits.every(safeCommit)) ||
    !nonEmptyString(value.message) || !stringArray(value.files) ||
    !enumValue(SecretScanStatus, value.secretScanStatus) ||
    !nonEmptyString(value.createdAt)) invalid();
}

function assertPushAttemptStructure(value: unknown): void {
  if (!isRecord(value) || !nonEmptyString(value.remote) ||
    !nonEmptyString(value.branch) || !safeCommit(value.commitSha) ||
    !enumValue(PushAttemptStatus, value.status) || !nonEmptyString(value.pushedAt)) invalid();
}

function invalid(): never {
  throw new Error("stale_integration_reconciliation_attempt_structure_invalid");
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function uniqueResolved(values: readonly string[]): readonly string[] {
  return [...new Set(values.map((value) => resolve(value)))].sort();
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function exactSortedResolved(values: readonly string[]): boolean {
  return JSON.stringify(values) === JSON.stringify(uniqueResolved(values));
}

function exactSortedStrings(values: readonly string[]): boolean {
  return JSON.stringify(values) === JSON.stringify(uniqueSorted(values));
}

export function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function sha256String(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function stringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function safeCommit(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{40,64}$/.test(value);
}

function enumValue<T extends Record<string, string>>(
  enumeration: T,
  value: unknown,
): value is T[keyof T] {
  return typeof value === "string" && Object.values(enumeration).includes(value);
}
