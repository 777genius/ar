import { createHash } from "node:crypto";
import { constants } from "node:fs";
import type { Dirent } from "node:fs";
import {
  access,
  lstat,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, relative, resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  IntegrationAttemptStatus,
  ReviewDecisionStatus,
  markRejected,
  matchesAnyPattern,
  type IntegrationAttempt,
} from "@vioxen/subscription-runtime/worker-core";
import {
  acquireLocalControllerMaintenanceFence,
  releaseLocalControllerMaintenanceFence,
} from "@vioxen/subscription-runtime/store-local-file";
import {
  durablePublishJsonFile,
  durableReplaceJsonFile,
} from "../../project-control-operation-file-store";
import {
  LocalReviewedWorkerOutputStore,
  reviewedWorkerOutputRoot,
} from "../../reviewed-worker-output";
import {
  assertSafeGitCommitSha,
  assertSafeGitRefName,
  assertSafeGitRemoteName,
} from "./codex-goal-project-git";
import {
  assertStaleIntegrationAttemptStructure,
  assertStaleIntegrationUnsignedPlanStructure,
  isRecord,
  nonEmptyString,
  sha256String,
} from "./codex-goal-stale-integration-reconciliation-validation";
import { staleIntegrationReconciliationProofRefusal } from
  "./codex-goal-stale-integration-refusal";

const execFileAsync = promisify(execFile);

export type StaleIntegrationReconciliationEntry = {
  readonly attemptId: string;
  readonly attemptPath: string;
  readonly attemptSha256: string;
  readonly status: string;
  readonly targetWorkspacePath: string;
  readonly targetRemote: string;
  readonly targetBranch: string;
  readonly targetHead?: string;
  readonly remoteRef?: string;
  readonly remoteHead?: string;
  readonly patchEvidence?: StaleIntegrationPatchEvidence;
  readonly proof?: "commit_incorporated" | "patch_incorporated" | "patch_absent";
  readonly eligible: boolean;
  readonly refusalReason?: string;
};

export type StaleIntegrationPatchEvidence = {
  readonly declaredPath: string;
  readonly canonicalPath: string;
  readonly device: number;
  readonly inode: number;
  readonly mode: number;
  readonly size: number;
  readonly sha256: string;
  readonly reviewedOutputId: string;
  readonly reviewedProjectId: string;
  readonly reviewedControllerJobId: string;
  readonly reviewedWorkerJobId: string;
};

export type StaleIntegrationReconciliationPlan = {
  readonly schemaVersion: 1;
  readonly controllerJobId: string;
  readonly projectId: string;
  readonly registryRootDir: string;
  readonly controllerJobRootDir: string;
  readonly controllerManifestSha256: string;
  readonly controllerScopeEpochSha256: string;
  readonly gitBinaryPath: string;
  readonly targetWorkspaceRoots: readonly string[];
  readonly deniedRoots: readonly string[];
  readonly allowedGitRemotes: readonly string[];
  readonly allowedBranches: readonly string[];
  readonly entries: readonly StaleIntegrationReconciliationEntry[];
  readonly planSha256: string;
};

type StaleIntegrationReconciliationProgress = {
  readonly schemaVersion: 2;
  readonly planSha256: string;
  readonly entries: readonly StaleIntegrationReconciliationProgressEntry[];
};

type StaleIntegrationReconciliationProgressEntry = {
  readonly attemptId: string;
  readonly rejectedPostImageBase64: string;
  readonly rejectedPostImageSha256: string;
  readonly completed: boolean;
};

type StaleIntegrationReconciliationReceipt = {
  readonly schemaVersion: 1;
  readonly status: "completed";
  readonly planSha256: string;
  readonly controllerJobId: string;
  readonly projectId: string;
  readonly reconciled: readonly string[];
  readonly completedAt: string;
};

export async function buildStaleIntegrationReconciliationPlan(input: {
  readonly controllerJobId: string;
  readonly projectId: string;
  readonly registryRootDir: string;
  readonly controllerJobRootDir: string;
  readonly controllerManifestSha256: string;
  readonly controllerScopeEpochSha256: string;
  readonly targetWorkspaceRoots: readonly string[];
  readonly deniedRoots?: readonly string[];
  readonly allowedGitRemotes: readonly string[];
  readonly allowedBranches: readonly string[];
}): Promise<StaleIntegrationReconciliationPlan> {
  const gitBinaryPath = await resolveGitBinary();
  const attemptsRoot = join(
    input.controllerJobRootDir,
    "project-integration",
    "integration-attempts",
  );
  let directories: Dirent[];
  try {
    directories = await readdir(attemptsRoot, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error, "ENOENT")) directories = [];
    else throw error;
  }
  const candidates: Array<{
    readonly attempt: IntegrationAttempt;
    readonly attemptPath: string;
    readonly attemptSha256: string;
  }> = [];
  const observedAttemptIds = new Set<string>();
  const observedAttemptPaths = new Set<string>();
  for (const directory of directories.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!directory.isDirectory() || directory.isSymbolicLink()) {
      throw new Error("stale_integration_reconciliation_attempt_root_unsafe");
    }
    const attemptPath = join(attemptsRoot, directory.name, "attempt.json");
    const bytes = await readHardenedFile(attemptPath);
    const attempt = JSON.parse(bytes.toString("utf8")) as IntegrationAttempt;
    assertAttemptStructure({
      attempt,
      attemptPath,
      directoryName: directory.name,
      attemptsRoot,
      controllerJobId: input.controllerJobId,
      projectId: input.projectId,
    });
    if (attempt.status === IntegrationAttemptStatus.Pushed ||
      attempt.status === IntegrationAttemptStatus.Rejected
    ) continue;
    if (observedAttemptIds.has(attempt.attemptId) ||
      observedAttemptPaths.has(attemptPath)) {
      throw new Error("stale_integration_reconciliation_attempt_binding_duplicate");
    }
    observedAttemptIds.add(attempt.attemptId);
    observedAttemptPaths.add(attemptPath);
    candidates.push({ attempt, attemptPath, attemptSha256: sha256(bytes) });
  }
  const targetWorkspaceRoots = uniqueResolved(input.targetWorkspaceRoots);
  const deniedRoots = uniqueResolved(input.deniedRoots ?? []);
  const allowedGitRemotes = uniqueSorted(input.allowedGitRemotes);
  const allowedBranches = uniqueSorted(input.allowedBranches);
  const entries: StaleIntegrationReconciliationEntry[] = [];
  for (const candidate of candidates) {
    entries.push(await reconcileEntry({
      ...candidate,
      gitBinaryPath,
      controllerJobId: input.controllerJobId,
      projectId: input.projectId,
      registryRootDir: input.registryRootDir,
      controllerJobRootDir: input.controllerJobRootDir,
      targetWorkspaceRoots,
      deniedRoots,
      allowedGitRemotes,
      allowedBranches,
    }));
  }
  const unsigned = {
    schemaVersion: 1 as const,
    controllerJobId: input.controllerJobId,
    projectId: input.projectId,
    registryRootDir: resolve(input.registryRootDir),
    controllerJobRootDir: resolve(input.controllerJobRootDir),
    controllerManifestSha256: input.controllerManifestSha256,
    controllerScopeEpochSha256: input.controllerScopeEpochSha256,
    gitBinaryPath,
    targetWorkspaceRoots,
    deniedRoots,
    allowedGitRemotes,
    allowedBranches,
    entries,
  };
  assertUnsignedPlanStructure(unsigned, input.controllerJobRootDir);
  return { ...unsigned, planSha256: sha256Json(unsigned) };
}

export async function previewStaleIntegrationReconciliationPlan(input: {
  readonly controllerJobId: string;
  readonly projectId: string;
  readonly registryRootDir: string;
  readonly controllerJobRootDir: string;
  readonly controllerManifestSha256: string;
  readonly controllerScopeEpochSha256: string;
  readonly targetWorkspaceRoots: readonly string[];
  readonly deniedRoots?: readonly string[];
  readonly allowedGitRemotes: readonly string[];
  readonly allowedBranches: readonly string[];
}): Promise<StaleIntegrationReconciliationPlan> {
  const plan = await buildStaleIntegrationReconciliationPlan(input);
  const path = reconciliationPlanPath(input.controllerJobRootDir, plan.planSha256);
  await durablePublishJsonFile({ path, value: plan });
  const stored = await readPersistedPlan(input.controllerJobRootDir, plan.planSha256);
  if (JSON.stringify(stored) !== JSON.stringify(plan)) {
    throw new Error("stale_integration_reconciliation_plan_publication_conflict");
  }
  return plan;
}

export async function loadStaleIntegrationReconciliationPlan(input: {
  readonly controllerJobRootDir: string;
  readonly expectedPlanSha256: string;
}): Promise<StaleIntegrationReconciliationPlan> {
  return await readPersistedPlan(
    input.controllerJobRootDir,
    input.expectedPlanSha256,
  );
}

export async function applyStaleIntegrationReconciliation(input: {
  readonly expectedPlanSha256: string;
  readonly controllerJobRootDir: string;
  readonly runAfterControllerScopeRevalidation: <T>(
    effect: () => Promise<T>,
  ) => Promise<T>;
  readonly crashAfterPreparedCount?: number;
  readonly crashAfterCompletedCount?: number;
}): Promise<StaleIntegrationReconciliationReceipt & {
  readonly idempotentReplay: boolean;
}> {
  // Validate the immutable plan and all attempt bindings before publishing even
  // the transient maintenance fence. The plan is loaded again under the fence.
  await readPersistedPlan(
    input.controllerJobRootDir,
    input.expectedPlanSha256,
  );
  const fence = await acquireLocalControllerMaintenanceFence({
    controllerJobRootDir: input.controllerJobRootDir,
    owner: `stale-integration-reconciliation:${input.expectedPlanSha256}`,
  });
  try {
    const effect = async () => await applyPersistedReconciliation(input);
    return await input.runAfterControllerScopeRevalidation(effect);
  } finally {
    await releaseLocalControllerMaintenanceFence(fence);
  }
}

async function applyPersistedReconciliation(input: {
  readonly expectedPlanSha256: string;
  readonly controllerJobRootDir: string;
  readonly crashAfterPreparedCount?: number;
  readonly crashAfterCompletedCount?: number;
}): Promise<StaleIntegrationReconciliationReceipt & {
  readonly idempotentReplay: boolean;
}> {
  const plan = await readPersistedPlan(
    input.controllerJobRootDir,
    input.expectedPlanSha256,
  );
  if (plan.entries.some((entry) => !entry.eligible)) {
    throw new Error("stale_integration_reconciliation_refused_entries_present");
  }
  const existingReceipt = await optionalJson<StaleIntegrationReconciliationReceipt>(
    reconciliationReceiptPath(input.controllerJobRootDir, plan.planSha256),
  );
  if (existingReceipt) {
    assertReceiptMatches(existingReceipt, plan);
    return { ...existingReceipt, idempotentReplay: true };
  }
  const progressPath = reconciliationProgressPath(
    input.controllerJobRootDir,
    plan.planSha256,
  );
  const progress = await optionalJson<StaleIntegrationReconciliationProgress>(
    progressPath,
  ) ?? {
    schemaVersion: 2,
    planSha256: plan.planSha256,
    entries: [],
  };
  if (progress.schemaVersion !== 2 || progress.planSha256 !== plan.planSha256 ||
    !Array.isArray(progress.entries)) {
    throw new Error("stale_integration_reconciliation_progress_invalid");
  }
  const plannedAttemptIds = new Set(plan.entries.map((entry) => entry.attemptId));
  const progressEntries = new Map<string, StaleIntegrationReconciliationProgressEntry>();
  for (const entry of progress.entries) {
    assertProgressEntry(entry, plannedAttemptIds);
    if (progressEntries.has(entry.attemptId)) {
      throw new Error("stale_integration_reconciliation_progress_invalid");
    }
    progressEntries.set(entry.attemptId, entry);
  }
  const completed = new Set(
    [...progressEntries.values()]
      .filter((entry) => entry.completed)
      .map((entry) => entry.attemptId),
  );
  for (const entry of plan.entries) {
    const rejectionReason = reconciliationRejectReason(plan.planSha256);
    let progressEntry = progressEntries.get(entry.attemptId);
    let bytes = await readHardenedFile(entry.attemptPath);
    if (progressEntry) {
      const postImage = decodeProgressPostImage(progressEntry);
      if (bytes.equals(postImage)) {
        assertRejectedPostImage({
          bytes,
          entry,
          plan,
          rejectionReason,
        });
        if (!progressEntry.completed) {
          progressEntry = { ...progressEntry, completed: true };
          progressEntries.set(entry.attemptId, progressEntry);
          completed.add(entry.attemptId);
          await persistProgress(progressPath, plan.planSha256, progressEntries);
        }
      } else if (progressEntry.completed) {
        throw new Error("stale_integration_reconciliation_progress_attempt_drift");
      }
    }
    if (!progressEntry?.completed) {
      const current = parseBoundAttempt(bytes, entry, plan);
      await assertEntryStillCurrent({ plan, entry, bytes, current });
      if (!progressEntry) {
        const rejected = markRejected(current, {
          reason: rejectionReason,
          now: new Date().toISOString(),
        });
        const postImage = serializeJsonFile(rejected);
        progressEntry = {
          attemptId: entry.attemptId,
          rejectedPostImageBase64: postImage.toString("base64"),
          rejectedPostImageSha256: sha256(postImage),
          completed: false,
        };
        progressEntries.set(entry.attemptId, progressEntry);
        await persistProgress(progressPath, plan.planSha256, progressEntries);
        if (input.crashAfterPreparedCount === progressEntries.size) {
          throw new Error("stale_integration_reconciliation_simulated_prepare_crash");
        }
      }
      const postImage = decodeProgressPostImage(progressEntry);
      const latestBytes = await readHardenedFile(entry.attemptPath);
      if (!latestBytes.equals(bytes)) {
        throw new Error("stale_integration_reconciliation_attempt_cas_mismatch");
      }
      await durableReplaceJsonFile({
        path: entry.attemptPath,
        value: JSON.parse(postImage.toString("utf8")) as IntegrationAttempt,
        ensureParent: false,
      });
      bytes = await readHardenedFile(entry.attemptPath);
      if (!bytes.equals(postImage)) {
        throw new Error("stale_integration_reconciliation_post_image_mismatch");
      }
      assertRejectedPostImage({ bytes, entry, plan, rejectionReason });
      progressEntry = { ...progressEntry, completed: true };
      progressEntries.set(entry.attemptId, progressEntry);
      completed.add(entry.attemptId);
      await persistProgress(progressPath, plan.planSha256, progressEntries);
    } else {
      completed.add(entry.attemptId);
    }
    if (input.crashAfterCompletedCount !== undefined &&
      completed.size === input.crashAfterCompletedCount) {
      throw new Error("stale_integration_reconciliation_simulated_crash");
    }
  }
  const receipt: StaleIntegrationReconciliationReceipt = {
    schemaVersion: 1,
    status: "completed",
    planSha256: plan.planSha256,
    controllerJobId: plan.controllerJobId,
    projectId: plan.projectId,
    reconciled: [...completed].sort(),
    completedAt: new Date().toISOString(),
  };
  await durablePublishJsonFile({
    path: reconciliationReceiptPath(input.controllerJobRootDir, plan.planSha256),
    value: receipt,
  });
  const stored = await optionalJson<StaleIntegrationReconciliationReceipt>(
    reconciliationReceiptPath(input.controllerJobRootDir, plan.planSha256),
  );
  if (!stored) throw new Error("stale_integration_reconciliation_receipt_missing");
  assertReceiptMatches(stored, plan);
  return { ...stored, idempotentReplay: false };
}

function assertProgressEntry(
  entry: StaleIntegrationReconciliationProgressEntry,
  plannedAttemptIds: ReadonlySet<string>,
): void {
  if (!isRecord(entry) || !nonEmptyString(entry.attemptId) ||
    !plannedAttemptIds.has(entry.attemptId) ||
    !nonEmptyString(entry.rejectedPostImageBase64) ||
    !sha256String(entry.rejectedPostImageSha256) ||
    typeof entry.completed !== "boolean") {
    throw new Error("stale_integration_reconciliation_progress_invalid");
  }
  decodeProgressPostImage(entry);
}

function decodeProgressPostImage(
  entry: StaleIntegrationReconciliationProgressEntry,
): Buffer {
  const bytes = Buffer.from(entry.rejectedPostImageBase64, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !==
    entry.rejectedPostImageBase64 || sha256(bytes) !==
    entry.rejectedPostImageSha256) {
    throw new Error("stale_integration_reconciliation_progress_post_image_invalid");
  }
  return bytes;
}

async function persistProgress(
  progressPath: string,
  planSha256: string,
  entries: ReadonlyMap<string, StaleIntegrationReconciliationProgressEntry>,
): Promise<void> {
  await durableReplaceJsonFile({
    path: progressPath,
    value: {
      schemaVersion: 2,
      planSha256,
      entries: [...entries.values()].sort((left, right) =>
        left.attemptId.localeCompare(right.attemptId)
      ),
    } satisfies StaleIntegrationReconciliationProgress,
  });
}

function parseBoundAttempt(
  bytes: Buffer,
  entry: StaleIntegrationReconciliationEntry,
  plan: StaleIntegrationReconciliationPlan,
): IntegrationAttempt {
  let attempt: IntegrationAttempt;
  try {
    attempt = JSON.parse(bytes.toString("utf8")) as IntegrationAttempt;
  } catch {
    throw new Error("stale_integration_reconciliation_attempt_structure_invalid");
  }
  assertAttemptStructure({
    attempt,
    attemptPath: entry.attemptPath,
    directoryName: sha256(Buffer.from(entry.attemptId)),
    attemptsRoot: join(
      plan.controllerJobRootDir,
      "project-integration",
      "integration-attempts",
    ),
    controllerJobId: plan.controllerJobId,
    projectId: plan.projectId,
  });
  if (attempt.attemptId !== entry.attemptId) {
    throw new Error("stale_integration_reconciliation_attempt_binding_noncanonical");
  }
  return attempt;
}

async function assertEntryStillCurrent(input: {
  readonly plan: StaleIntegrationReconciliationPlan;
  readonly entry: StaleIntegrationReconciliationEntry;
  readonly bytes: Buffer;
  readonly current: IntegrationAttempt;
}): Promise<void> {
  if (sha256(input.bytes) !== input.entry.attemptSha256 ||
    input.current.status !== input.entry.status) {
    throw new Error("stale_integration_reconciliation_attempt_cas_mismatch");
  }
  const currentEntry = await reconcileEntry({
    attempt: input.current,
    attemptPath: input.entry.attemptPath,
    attemptSha256: input.entry.attemptSha256,
    gitBinaryPath: input.plan.gitBinaryPath,
    controllerJobId: input.plan.controllerJobId,
    projectId: input.plan.projectId,
    registryRootDir: input.plan.registryRootDir,
    controllerJobRootDir: input.plan.controllerJobRootDir,
    targetWorkspaceRoots: input.plan.targetWorkspaceRoots,
    deniedRoots: input.plan.deniedRoots,
    allowedGitRemotes: input.plan.allowedGitRemotes,
    allowedBranches: input.plan.allowedBranches,
  });
  if (JSON.stringify(currentEntry) !== JSON.stringify(input.entry) ||
    !currentEntry.eligible) {
    throw new Error("stale_integration_reconciliation_entry_drift");
  }
}

function assertRejectedPostImage(input: {
  readonly bytes: Buffer;
  readonly entry: StaleIntegrationReconciliationEntry;
  readonly plan: StaleIntegrationReconciliationPlan;
  readonly rejectionReason: string;
}): void {
  const attempt = parseBoundAttempt(input.bytes, input.entry, input.plan);
  if (attempt.status !== IntegrationAttemptStatus.Rejected ||
    attempt.rejectReason !== input.rejectionReason ||
    !serializeJsonFile(attempt).equals(input.bytes)) {
    throw new Error("stale_integration_reconciliation_progress_post_image_invalid");
  }
}

function serializeJsonFile(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function reconcileEntry(input: {
  readonly attempt: IntegrationAttempt;
  readonly attemptPath: string;
  readonly attemptSha256: string;
  readonly gitBinaryPath: string;
  readonly controllerJobId: string;
  readonly projectId: string;
  readonly registryRootDir: string;
  readonly controllerJobRootDir: string;
  readonly targetWorkspaceRoots: readonly string[];
  readonly deniedRoots: readonly string[];
  readonly allowedGitRemotes: readonly string[];
  readonly allowedBranches: readonly string[];
}): Promise<StaleIntegrationReconciliationEntry> {
  assertSafeGitRemoteName(input.attempt.targetRemote, "targetRemote");
  assertSafeReconciliationTargetBranch(input.attempt.targetBranch);
  const base = {
    attemptId: input.attempt.attemptId,
    attemptPath: input.attemptPath,
    attemptSha256: input.attemptSha256,
    status: input.attempt.status,
    targetWorkspacePath: resolve(input.attempt.targetWorkspacePath),
    targetRemote: input.attempt.targetRemote,
    targetBranch: input.attempt.targetBranch,
  };
  if (input.attempt.controllerJobId !== input.controllerJobId ||
    input.attempt.projectId !== input.projectId
  ) return { ...base, eligible: false, refusalReason: "attempt_scope_mismatch" };
  if (!input.allowedGitRemotes.includes(input.attempt.targetRemote) ||
    !matchesAnyPattern(input.attempt.targetBranch, input.allowedBranches)) {
    return { ...base, eligible: false, refusalReason: "target_remote_branch_out_of_scope" };
  }
  if (!pathAllowed(input.attempt.targetWorkspacePath, input.targetWorkspaceRoots,
    input.deniedRoots)) {
    return { ...base, eligible: false, refusalReason: "target_workspace_out_of_scope" };
  }
  try {
    const workspace = await realpath(input.attempt.targetWorkspacePath);
    const canonicalRoots = await canonicalizeRoots(input.targetWorkspaceRoots);
    const canonicalDenied = await canonicalizeRoots(input.deniedRoots);
    if (!pathAllowed(workspace, canonicalRoots, canonicalDenied)) {
      return { ...base, eligible: false, refusalReason: "target_workspace_out_of_scope" };
    }
    const metadata = await lstat(workspace);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      return { ...base, eligible: false, refusalReason: "target_workspace_unsafe" };
    }
    const status = await git(input.gitBinaryPath, workspace, ["status", "--porcelain=v1", "-z"]);
    if (status.length > 0) {
      return { ...base, eligible: false, refusalReason: "target_workspace_dirty" };
    }
    const targetHead = text(await git(input.gitBinaryPath, workspace, ["rev-parse", "HEAD"]));
    const remoteRef = `refs/remotes/${input.attempt.targetRemote}/${input.attempt.targetBranch}`;
    const remoteBranchRef = `refs/heads/${input.attempt.targetBranch}`;
    const liveRemote = text(await git(input.gitBinaryPath, workspace, [
      "ls-remote", "--exit-code", "--refs", "--",
      input.attempt.targetRemote, remoteBranchRef,
    ]));
    const [remoteHead, remoteName, ...extra] = liveRemote.split(/\s+/);
    if (extra.length > 0 || !/^[a-f0-9]{40,64}$/.test(remoteHead ?? "") ||
      remoteName !== remoteBranchRef) {
      return { ...base, targetHead, remoteRef, eligible: false,
        refusalReason: "live_remote_head_invalid" };
    }
    const liveRemoteHead = remoteHead!;
    if (targetHead !== liveRemoteHead) {
      return { ...base, targetHead, remoteRef, remoteHead: liveRemoteHead, eligible: false,
        refusalReason: "target_not_canonical_remote_head" };
    }
    const patchPath = input.attempt.workerOutput.patchPath ??
      input.attempt.workerOutput.sourcePatchPath;
    if (!patchPath) return { ...base, targetHead, remoteRef,
      remoteHead: liveRemoteHead, eligible: false,
      refusalReason: "attempt_evidence_ambiguous" };
    const patch = await bindReviewedPatchEvidence({
      path: patchPath,
      registryRootDir: input.registryRootDir,
      controllerJobId: input.controllerJobId,
      projectId: input.projectId,
      attempt: input.attempt,
      deniedRoots: input.deniedRoots,
    });
    const patchBytes = patch.bytes;
    if (input.attempt.workerOutput.patchSha256 !== patch.evidence.sha256) {
      return { ...base, targetHead, remoteRef,
        remoteHead: liveRemoteHead, patchEvidence: patch.evidence, eligible: false,
        refusalReason: "attempt_patch_hash_mismatch" };
    }
    const commit = input.attempt.commitCandidate?.commitSha ??
      input.attempt.workerOutput.commitSha ?? input.attempt.merge?.sourceCommit;
    if (commit) assertSafeGitCommitSha(commit);
    if (commit && await isAncestor(input.gitBinaryPath, workspace, commit, targetHead)) {
      return { ...base, targetHead, remoteRef, remoteHead: liveRemoteHead,
        patchEvidence: patch.evidence, proof: "commit_incorporated", eligible: true };
    }
    if (await gitApplyCheck(input.gitBinaryPath, workspace, patchBytes, true)) {
      return { ...base, targetHead, remoteRef, remoteHead: liveRemoteHead,
        patchEvidence: patch.evidence, proof: "patch_incorporated", eligible: true };
    }
    if (await gitApplyCheck(input.gitBinaryPath, workspace, patchBytes, false)) {
      return { ...base, targetHead, remoteRef, remoteHead: liveRemoteHead,
        patchEvidence: patch.evidence, proof: "patch_absent", eligible: true };
    }
    return { ...base, targetHead, remoteRef,
      remoteHead: liveRemoteHead, patchEvidence: patch.evidence, eligible: false,
      refusalReason: "attempt_patch_partial_or_ambiguous" };
  } catch (error) {
    return { ...base, eligible: false,
      refusalReason: staleIntegrationReconciliationProofRefusal(error) };
  }
}

async function resolveGitBinary(): Promise<string> {
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(directory, "git");
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch {
      continue;
    }
  }
  throw new Error("stale_integration_reconciliation_git_unavailable");
}

async function git(path: string, cwd: string, args: readonly string[]): Promise<Buffer> {
  return (await execFileAsync(path, args, {
    cwd, encoding: "buffer", maxBuffer: 64 * 1024 * 1024, timeout: 60_000,
  })).stdout;
}

async function isAncestor(path: string, cwd: string, ancestor: string, head: string) {
  try {
    await git(path, cwd, ["merge-base", "--is-ancestor", ancestor, head]);
    return true;
  } catch {
    return false;
  }
}

async function gitApplyCheck(path: string, cwd: string, patch: Buffer, reverse: boolean) {
  const directory = await mkdtemp(join(tmpdir(), "stale-reconciliation-patch-"));
  const patchPath = join(directory, "evidence.patch");
  try {
    await writeFile(patchPath, patch, { mode: 0o600, flag: "wx" });
    await git(path, cwd, [
      "apply", ...(reverse ? ["--reverse"] : []), "--check", "--", patchPath,
    ]);
    return true;
  } catch {
    return false;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function bindReviewedPatchEvidence(input: {
  readonly path: string;
  readonly registryRootDir: string;
  readonly controllerJobId: string;
  readonly projectId: string;
  readonly attempt: IntegrationAttempt;
  readonly deniedRoots: readonly string[];
}): Promise<{
  readonly bytes: Buffer;
  readonly evidence: StaleIntegrationPatchEvidence;
}> {
  const reviewedRoot = resolve(reviewedWorkerOutputRoot(input.registryRootDir));
  const declaredPath = resolve(input.path);
  const components = relative(reviewedRoot, declaredPath).split(sep);
  if (components.length !== 2 || components[1] !== "output.patch" ||
    !/^[a-f0-9]{64}$/.test(components[0] ?? "")) {
    throw new Error("stale_integration_reconciliation_patch_outside_reviewed_store");
  }
  const reviewedOutputId = components[0]!;
  const store = new LocalReviewedWorkerOutputStore({ rootDir: reviewedRoot });
  const snapshot = await store.get(reviewedOutputId);
  if (!snapshot || snapshot.projectId !== input.projectId ||
    snapshot.controllerJobId !== input.controllerJobId ||
    snapshot.workerJobId !== input.attempt.workerJobId ||
    snapshot.workerJobId !== input.attempt.workerOutput.workerJobId ||
    resolve(snapshot.sourceWorkspacePath) !==
      resolve(input.attempt.sourceWorkspacePath) ||
    resolve(snapshot.sourceWorkspacePath) !==
      resolve(input.attempt.workerOutput.workspacePath) ||
    resolve(snapshot.patchPath) !== declaredPath ||
    snapshot.patchSha256 !== input.attempt.workerOutput.patchSha256 ||
    snapshot.baseCommit !== input.attempt.workerOutput.baseCommit ||
    !sameReviewedMergeBinding(snapshot.merge, input.attempt.merge) ||
    snapshot.reviewDecision.decision !== ReviewDecisionStatus.Approved ||
    JSON.stringify(snapshot.changedFiles) !==
      JSON.stringify(input.attempt.workerOutput.changedFiles) ||
    JSON.stringify(snapshot.reviewDecision) !==
      JSON.stringify(input.attempt.reviewDecision)) {
    throw new Error("stale_integration_reconciliation_reviewed_output_scope_mismatch");
  }
  const bound = await bindPatchEvidence({
    path: declaredPath,
    custodyRoots: [reviewedRoot],
    deniedRoots: input.deniedRoots,
  });
  const storedBytes = Buffer.from(await store.readPatch(snapshot), "utf8");
  if (!storedBytes.equals(bound.bytes) || snapshot.patchSha256 !== bound.evidence.sha256) {
    throw new Error("stale_integration_reconciliation_reviewed_output_patch_drift");
  }
  return {
    bytes: bound.bytes,
    evidence: {
      ...bound.evidence,
      reviewedOutputId,
      reviewedProjectId: snapshot.projectId,
      reviewedControllerJobId: snapshot.controllerJobId,
      reviewedWorkerJobId: snapshot.workerJobId,
    },
  };
}

function sameReviewedMergeBinding(
  reviewed: IntegrationAttempt["merge"],
  attempt: IntegrationAttempt["merge"],
): boolean {
  if (reviewed === undefined || attempt === undefined) {
    return reviewed === undefined && attempt === undefined;
  }
  return reviewed.sourceRemote === attempt.sourceRemote &&
    reviewed.sourceBranch === attempt.sourceBranch &&
    reviewed.sourceCommit === attempt.sourceCommit &&
    reviewed.expectedTargetCommit === attempt.expectedTargetCommit;
}

async function bindPatchEvidence(input: {
  readonly path: string;
  readonly custodyRoots: readonly string[];
  readonly deniedRoots: readonly string[];
}): Promise<{
  readonly bytes: Buffer;
  readonly evidence: Omit<
    StaleIntegrationPatchEvidence,
    | "reviewedOutputId"
    | "reviewedProjectId"
    | "reviewedControllerJobId"
    | "reviewedWorkerJobId"
  >;
}> {
  const declaredPath = resolve(input.path);
  const custodyRoots = uniqueResolved(input.custodyRoots);
  const deniedRoots = uniqueResolved(input.deniedRoots);
  if (!pathAllowed(declaredPath, custodyRoots, deniedRoots)) {
    throw new Error("stale_integration_reconciliation_patch_outside_custody");
  }
  const declaredMetadata = await lstat(declaredPath);
  if (!declaredMetadata.isFile() || declaredMetadata.isSymbolicLink()) {
    throw new Error("stale_integration_reconciliation_patch_unsafe");
  }
  const canonicalPath = await realpath(declaredPath);
  const canonicalCustodyRoots = await canonicalizeRoots(custodyRoots);
  const canonicalDeniedRoots = await canonicalizeRoots(deniedRoots);
  if (!pathAllowed(canonicalPath, canonicalCustodyRoots, canonicalDeniedRoots)) {
    throw new Error("stale_integration_reconciliation_patch_outside_custody");
  }
  const handle = await open(
    canonicalPath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > 64 * 1024 * 1024 ||
      metadata.dev !== declaredMetadata.dev ||
      metadata.ino !== declaredMetadata.ino) {
      throw new Error("stale_integration_reconciliation_patch_unsafe");
    }
    const bytes = await handle.readFile();
    return {
      bytes,
      evidence: {
        declaredPath,
        canonicalPath,
        device: metadata.dev,
        inode: metadata.ino,
        mode: metadata.mode,
        size: metadata.size,
        sha256: sha256(bytes),
      },
    };
  } finally {
    await handle.close();
  }
}

function unsignedPlan(plan: StaleIntegrationReconciliationPlan) {
  const { planSha256: _ignored, ...unsigned } = plan;
  return unsigned;
}

async function readPersistedPlan(
  controllerJobRootDir: string,
  expectedPlanSha256: string,
): Promise<StaleIntegrationReconciliationPlan> {
  if (!/^[a-f0-9]{64}$/.test(expectedPlanSha256)) {
    throw new Error("stale_integration_reconciliation_plan_hash_mismatch");
  }
  const value = await optionalJson<StaleIntegrationReconciliationPlan>(
    reconciliationPlanPath(controllerJobRootDir, expectedPlanSha256),
  );
  if (!value || value.schemaVersion !== 1 ||
    value.planSha256 !== expectedPlanSha256 || !Array.isArray(value.entries) ||
    sha256Json(unsignedPlan(value)) !== expectedPlanSha256) {
    throw new Error("stale_integration_reconciliation_plan_hash_mismatch");
  }
  assertUnsignedPlanStructure(unsignedPlan(value), controllerJobRootDir);
  return value;
}

function assertAttemptStructure(input: {
  readonly attempt: IntegrationAttempt;
  readonly attemptPath: string;
  readonly directoryName: string;
  readonly attemptsRoot: string;
  readonly controllerJobId: string;
  readonly projectId: string;
}): void {
  assertStaleIntegrationAttemptStructure({
    ...input,
    assertTargetBranch: assertSafeReconciliationTargetBranch,
  });
}

function assertUnsignedPlanStructure(
  plan: Omit<StaleIntegrationReconciliationPlan, "planSha256">,
  controllerJobRootDir: string,
): void {
  assertStaleIntegrationUnsignedPlanStructure(
    plan,
    controllerJobRootDir,
    assertSafeReconciliationTargetBranch,
  );
}

async function optionalJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse((await readHardenedFile(path)).toString("utf8")) as T;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
}

function reconciliationArtifactRoot(controllerJobRootDir: string): string {
  return join(
    controllerJobRootDir,
    "project-integration",
    "stale-attempt-reconciliation",
  );
}

function reconciliationPlanPath(root: string, sha: string): string {
  return join(reconciliationArtifactRoot(root), `${sha}.plan.json`);
}

function reconciliationProgressPath(root: string, sha: string): string {
  return join(reconciliationArtifactRoot(root), `${sha}.progress.json`);
}

function reconciliationReceiptPath(root: string, sha: string): string {
  return join(reconciliationArtifactRoot(root), `${sha}.receipt.json`);
}

function reconciliationRejectReason(planSha256: string): string {
  return `brokered stale lifecycle reconciliation ${planSha256}`;
}

function assertReceiptMatches(
  receipt: StaleIntegrationReconciliationReceipt,
  plan: StaleIntegrationReconciliationPlan,
): void {
  if (receipt.schemaVersion !== 1 || receipt.status !== "completed" ||
    receipt.planSha256 !== plan.planSha256 ||
    receipt.controllerJobId !== plan.controllerJobId ||
    receipt.projectId !== plan.projectId ||
    JSON.stringify(receipt.reconciled) !== JSON.stringify(
      plan.entries.map((entry) => entry.attemptId).sort()
    )) throw new Error("stale_integration_reconciliation_receipt_conflict");
}

function text(bytes: Buffer): string {
  return bytes.toString("utf8").trim();
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function readHardenedFile(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > 64 * 1024 * 1024) {
      throw new Error("stale_integration_reconciliation_evidence_unsafe");
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function uniqueResolved(values: readonly string[]): readonly string[] {
  return [...new Set(values.map((value) => resolve(value)))].sort();
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function assertSafeReconciliationTargetBranch(value: string): void {
  assertSafeGitRefName(value, "targetBranch");
  if (value.length === 0 || value === "@" || value.includes("@{") ||
    value.includes("\\") || value.split("/").some((component) =>
      component.length === 0 || component.startsWith(".") ||
      component.endsWith(".lock")
    )) {
    throw new Error("project_control_targetBranch_invalid");
  }
}

async function canonicalizeRoots(values: readonly string[]): Promise<readonly string[]> {
  return await Promise.all(values.map(async (root) => {
    try {
      return await realpath(root);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return resolve(root);
      throw error;
    }
  }));
}

function pathAllowed(
  path: string,
  roots: readonly string[],
  deniedRoots: readonly string[],
): boolean {
  const inside = (root: string) => {
    const child = relative(resolve(root), resolve(path));
    return child === "" || (child !== ".." && !child.startsWith(`..${sep}`));
  };
  return roots.some(inside) && !deniedRoots.some(inside);
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
