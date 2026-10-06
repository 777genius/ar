import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { readHostedDependencyRootFile, HostedDependencyRootFileRecipe } from "./hosted-dependency-root-file-reader";
import * as syncFs from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  isAbsolute,
  join,
  resolve,
} from "node:path";

import {
  detectSecretLikeContent,
  type RuntimeResultArtifact,
} from "@vioxen/subscription-runtime/worker-core";
import { readGitBlobBatch } from "@vioxen/subscription-runtime/worker-local";
import { LocalTerminalCheckpointAdmission } from "@vioxen/subscription-runtime/store-local-file";
import { assertGitPatchBlobsSecretSafe } from "./git-patch-secret-validator";
import { publishImmutableTextArtifact } from "./local-immutable-text-artifact";
import {
  CODEX_GOAL_CONTINUATION_WORKSPACE_FINGERPRINT_SCHEMA,
  type CodexGoalContinuationWorkspaceFingerprint,
} from "./codex-goal-continuation-workspace-fingerprint";
import {
  assertSafeHandoffId as assertSafeId,
  assertSafeHandoffRelativePath as assertSafeRelativePath,
  ensureHandoffTrailingNewline as ensureTrailingNewline,
  handoffPathInside as pathInside,
  isHandoffNodeError as isNodeError,
  sameHandoffPaths as sameStrings,
  sha256HandoffContent as sha256,
  stableHandoffJson as stableJson,
  uniqueSortedHandoffPaths as uniqueSorted,
} from "./codex-goal-handoff-artifact-guards";
import {
  assertHandoffGitHeadUnchanged as assertGitHeadUnchanged,
  handoffGitDiffNoIndex as gitDiffNoIndex,
  handoffGitNullPaths as gitNullPaths,
  handoffGitOutput as gitOutput,
  handoffGitText as gitText,
} from "./codex-goal-handoff-git-snapshot";
import {
  withHandoffWorktreeIndex,
} from "./codex-goal-handoff-worktree-index";
import { captureHandoffWorkspaceLayer } from
  "./codex-goal-handoff-workspace-layer";

import { resolveManagedDependencyGitContext, assertManagedDependencyGitContext,
  assertManagedDependencyGitAuthoredPath, readManagedDependencyGitBlobs, isManagedDependencySignedTaskId,
  type HostedDependencyRootPurposeContext, type HandoffGitSelection } from "./managed-dependency-git";

import { withHostedActivationFence } from "@vioxen/subscription-runtime/provider-codex";
import { HostedDependencyRootPurpose, assertCurrentHostedDependencyRootPurpose,
  HostedDependencyRootDescriptorRecipe, openCurrentHostedDependencyRootDescriptor } from "./hosted-dependency-root-purpose";

const maximumHandoffByteLimit = 64 * 1024 * 1024;

export const DEFAULT_HANDOFF_ARTIFACT_LIMITS = {
  maxChangedFiles: 256,
  maxFileBytes: 4 * 1024 * 1024,
  maxTotalFileBytes: 16 * 1024 * 1024,
  maxPatchBytes: 16 * 1024 * 1024,
} as const;
export type HandoffArtifactLimits = {
  readonly maxChangedFiles: number;
  readonly maxFileBytes: number;
  readonly maxTotalFileBytes: number;
  readonly maxPatchBytes: number;
};

export type CodexGoalHandoffArtifactManifest = {
  readonly schemaVersion: 1;
  readonly kind: "subscription-runtime-worker-handoff";
  readonly workerJobId: string;
  readonly taskId: string;
  readonly workspacePath: string;
  readonly jobRootDir: string;
  readonly baseCommit: string;
  readonly changedPaths: readonly string[];
  readonly provenance: {
    readonly generator: "subscription-runtime";
    readonly source: "terminal-worker-workspace";
    readonly baseCommit: string;
  };
  readonly artifacts: {
    readonly patch: HandoffArtifactDescriptor;
    readonly summary: HandoffArtifactDescriptor;
  };
};

export type HandoffArtifactDescriptor = {
  readonly path: string;
  readonly byteLength: number;
  readonly sha256: string;
};

export type MaterializedCodexGoalHandoffArtifacts = {
  readonly baseCommit: string;
  readonly changedPaths: readonly string[];
  readonly patchPath: string;
  readonly summaryPath: string;
  readonly manifestPath: string;
  readonly manifest: CodexGoalHandoffArtifactManifest;
  readonly artifacts: readonly RuntimeResultArtifact[];
};

export type CodexGoalHandoffPatchFingerprint = {
  readonly baseCommit: string;
  readonly changedPaths: readonly string[];
  readonly patchSha256: string;
};

export type CodexGoalExactWorkspacePatch = {
  readonly baseCommit: string;
  readonly changedPaths: readonly string[];
  readonly patch: string;
};

/**
 * The single exact serializer used by immutable handoffs and reviewed-output
 * snapshots. Keeping both consumers on this primitive makes patch hashes
 * interoperable for renames, staged changes, untracked files, and binaries.
 */
export async function captureCodexGoalExactWorkspacePatch(input: {
  readonly workspacePath: string;
  readonly gitBinaryPath?: HandoffGitSelection;
  readonly expectedBaseCommit?: string;
  readonly limits?: Partial<HandoffArtifactLimits>;
  readonly scanSecretContent?: boolean;
  readonly enforceSingleWorkspaceLayer?: boolean;
  readonly testHooks?: {
    readonly afterSafetyScan?: (scan: 1 | 2) => Promise<void>;
    readonly afterPatchSnapshot?: (snapshot: 1 | 2) => Promise<void>;
  };
}): Promise<CodexGoalExactWorkspacePatch | null> {
  const managedContext = resolveManagedDependencyGitContext(input.workspacePath, input.gitBinaryPath);
  if (managedContext !== undefined) {
    if (input.testHooks !== undefined) throw new Error("dependency_host_git_unsupported");
    input = { ...input, gitBinaryPath: managedContext };
  }
  const workspacePath = await canonicalOwnedDirectory(
    input.workspacePath,
    "handoff_workspace",
  );
  return await captureStableHandoffPatch({
    workspacePath,
    ...(input.gitBinaryPath === undefined
      ? {}
      : { gitBinaryPath: input.gitBinaryPath }),
    limits: handoffArtifactLimits(input.limits),
    ...(input.expectedBaseCommit
      ? { expectedBaseCommit: input.expectedBaseCommit }
      : {}),
    ...(input.scanSecretContent === undefined
      ? {}
      : { scanSecretContent: input.scanSecretContent }),
    ...(input.enforceSingleWorkspaceLayer === undefined
      ? {}
      : { enforceSingleWorkspaceLayer: input.enforceSingleWorkspaceLayer }),
    ...(input.testHooks ? { testHooks: input.testHooks } : {}),
  });
}

/** Read-only fingerprint using the exact serializer and safety checks of handoff materialization. */
export async function captureCodexGoalHandoffPatchFingerprint(input: {
  readonly workspacePath: string;
  readonly gitBinaryPath?: HandoffGitSelection;
  readonly expectedBaseCommit?: string;
  readonly limits?: Partial<HandoffArtifactLimits>;
}): Promise<CodexGoalHandoffPatchFingerprint | null> {
  const snapshot = await captureCodexGoalExactWorkspacePatch({
    workspacePath: input.workspacePath,
    ...(input.gitBinaryPath === undefined ? {} : { gitBinaryPath: input.gitBinaryPath }),
    ...(input.limits ? { limits: input.limits } : {}),
    ...(input.expectedBaseCommit
      ? { expectedBaseCommit: input.expectedBaseCommit }
      : {}),
  });
  return snapshot
    ? {
        baseCommit: snapshot.baseCommit,
        changedPaths: snapshot.changedPaths,
        patchSha256: sha256(snapshot.patch),
      }
    : null;
}

/** Hash-only evidence for continuing the same isolated workspace. Never a publishable handoff. */
export async function captureCodexGoalContinuationWorkspaceFingerprint(input: {
  readonly workspacePath: string;
  readonly gitBinaryPath?: HandoffGitSelection;
  readonly expectedBaseCommit?: string;
  readonly limits?: Partial<HandoffArtifactLimits>;
}): Promise<CodexGoalContinuationWorkspaceFingerprint | null> {
  const snapshot = await captureCodexGoalExactWorkspacePatch({
    workspacePath: input.workspacePath,
    ...(input.gitBinaryPath === undefined ? {} : { gitBinaryPath: input.gitBinaryPath }),
    ...(input.limits ? { limits: input.limits } : {}),
    scanSecretContent: false,
    ...(input.expectedBaseCommit
      ? { expectedBaseCommit: input.expectedBaseCommit }
      : {}),
  });
  return snapshot
    ? {
        schema: CODEX_GOAL_CONTINUATION_WORKSPACE_FINGERPRINT_SCHEMA,
        baseCommit: snapshot.baseCommit,
        changedPaths: snapshot.changedPaths,
        sha256: continuationWorkspaceFingerprint(snapshot),
      }
    : null;
}

export async function materializeCodexGoalHandoffArtifacts(input: {
  readonly workerJobId: string;
  readonly taskId: string;
  readonly workspacePath: string;
  readonly jobRootDir: string;
  readonly expectedBaseCommit?: string;
  readonly limits?: Partial<HandoffArtifactLimits>;
  readonly testHooks?: {
    readonly afterSafetyScan?: (scan: 1 | 2) => Promise<void>;
    readonly afterPatchSnapshot?: (snapshot: 1 | 2) => Promise<void>;
  };
}): Promise<MaterializedCodexGoalHandoffArtifacts | null> {
  const managedContext = resolveManagedDependencyGitContext(input.workspacePath);
  if (managedContext !== undefined) {
    const scope = assertManagedDependencyGitContext(managedContext);
    if (input.workerJobId !== scope.logicalJobId || input.taskId !== scope.logicalTaskId || input.jobRootDir !== scope.jobRootDir ||
        input.testHooks !== undefined) throw new Error("handoff_protected_scope_mismatch");
    return materializeCodexGoalHandoffArtifactsAdmitted({ ...input, managedContext });
  }
  return new LocalTerminalCheckpointAdmission(input.jobRootDir).withWriter(
    () => materializeCodexGoalHandoffArtifactsAdmitted(input),
  );
}

async function materializeCodexGoalHandoffArtifactsAdmitted(input: {
  readonly managedContext?: HostedDependencyRootPurposeContext;
  readonly workerJobId: string;
  readonly taskId: string;
  readonly workspacePath: string;
  readonly jobRootDir: string;
  readonly expectedBaseCommit?: string;
  readonly limits?: Partial<HandoffArtifactLimits>;
  readonly testHooks?: {
    readonly afterSafetyScan?: (scan: 1 | 2) => Promise<void>;
    readonly afterPatchSnapshot?: (snapshot: 1 | 2) => Promise<void>;
  };
}): Promise<MaterializedCodexGoalHandoffArtifacts | null> {
  assertSafeId(input.workerJobId, "worker_job_id");
  if (input.managedContext === undefined) assertSafeId(input.taskId, "task_id");
  else if (!isManagedDependencySignedTaskId(input.taskId)) throw new Error("task_id_invalid");
  const limits = handoffArtifactLimits(input.limits);
  const workspacePath = await canonicalOwnedDirectory(
    input.workspacePath,
    "handoff_workspace",
  );
  if (input.managedContext === undefined) await mkdir(input.jobRootDir, { recursive: true, mode: 0o700 });
  const jobRootDir = await canonicalOwnedDirectory(
    input.jobRootDir,
    "handoff_job_root",
  );
  const outputRoot = input.managedContext === undefined ? jobRootDir : assertManagedDependencyGitContext(input.managedContext).durableHandoffRoot.canonicalPath;
  const snapshot = await captureCodexGoalExactWorkspacePatch({
    workspacePath,
    ...(input.managedContext === undefined ? {} : { gitBinaryPath: input.managedContext }),
    limits,
    ...(input.expectedBaseCommit
      ? { expectedBaseCommit: input.expectedBaseCommit }
      : {}),
    ...(input.testHooks ? { testHooks: input.testHooks } : {}),
  });
  if (!snapshot) return null;
  const { baseCommit, changedPaths, patch } = snapshot;
  const generation = sha256(patch);
  const artifactPrefix = `${input.taskId}.${generation}.handoff`;
  const patchPath = join(outputRoot, `${artifactPrefix}.patch`);
  const summaryPath = join(outputRoot, `${artifactPrefix}.summary.json`);
  const manifestPath = join(outputRoot, `${artifactPrefix}.manifest.json`);
  const totalFileBytes = await assertExactPatchSecretSafe({
    workspacePath,
    jobRootDir,
    ...(input.managedContext === undefined ? {} : { gitBinaryPath: input.managedContext }),
    baseCommit,
    patch,
    changedPaths,
    limits,
  });
  await assertGitHeadUnchanged(workspacePath, baseCommit, input.managedContext);

  const patchDescriptor = descriptor(patchPath, patch);
  const summary = stableJson({
    schemaVersion: 1,
    kind: "subscription-runtime-worker-handoff-summary",
    workerJobId: input.workerJobId,
    taskId: input.taskId,
    workspacePath,
    baseCommit,
    changedPaths,
    changedFileCount: changedPaths.length,
    totalFileBytes,
    patch: patchDescriptor,
  });
  const summaryDescriptor = descriptor(summaryPath, summary);
  const manifest: CodexGoalHandoffArtifactManifest = {
    schemaVersion: 1,
    kind: "subscription-runtime-worker-handoff",
    workerJobId: input.workerJobId,
    taskId: input.taskId,
    workspacePath,
    jobRootDir,
    baseCommit,
    changedPaths,
    provenance: {
      generator: "subscription-runtime",
      source: "terminal-worker-workspace",
      baseCommit,
    },
    artifacts: {
      patch: patchDescriptor,
      summary: summaryDescriptor,
    },
  };
  const manifestText = stableJson(manifest);

  await publishExactFile(patchPath, patch, input.managedContext);
  await publishExactFile(summaryPath, summary, input.managedContext);
  await publishExactFile(manifestPath, manifestText, input.managedContext);
  return {
    baseCommit,
    changedPaths,
    patchPath,
    summaryPath,
    manifestPath,
    manifest,
    artifacts: [
      runtimeArtifact("patch", patchDescriptor),
      runtimeArtifact("summary", summaryDescriptor),
      runtimeArtifact("manifest", descriptor(manifestPath, manifestText)),
    ],
  };
}

async function captureStableHandoffPatch(input: {
  readonly workspacePath: string;
  readonly gitBinaryPath?: HandoffGitSelection;
  readonly expectedBaseCommit?: string;
  readonly limits: HandoffArtifactLimits;
  readonly scanSecretContent?: boolean;
  readonly enforceSingleWorkspaceLayer?: boolean;
  readonly testHooks?: {
    readonly afterSafetyScan?: (scan: 1 | 2) => Promise<void>;
    readonly afterPatchSnapshot?: (snapshot: 1 | 2) => Promise<void>;
  };
}): Promise<{
  readonly baseCommit: string;
  readonly changedPaths: readonly string[];
  readonly patch: string;
} | null> {
  const { workspacePath, limits } = input;
  const baseCommit = await gitText(workspacePath, [
    "rev-parse",
    "--verify",
    "HEAD",
  ], undefined, input.gitBinaryPath);
  if (input.expectedBaseCommit && input.expectedBaseCommit !== baseCommit) {
    throw new Error("handoff_base_commit_mismatch");
  }
  const workspaceLayer = input.enforceSingleWorkspaceLayer === false
    ? undefined
    : await captureHandoffWorkspaceLayer(workspacePath, input.gitBinaryPath);
  const managedContext = resolveManagedDependencyGitContext(workspacePath, input.gitBinaryPath);
  return withHandoffWorktreeIndex({
    ...(managedContext === undefined ? {} : { managedContext }),
    initialize: async (worktreeIndexEnv) => {
      // A clean synthetic index has no skip-worktree or assume-unchanged bits,
      // so every tracked worktree byte remains visible to snapshot reads.
      await gitOutput(
        workspacePath,
        ["read-tree", baseCommit],
        1024 * 1024,
        worktreeIndexEnv,
        input.gitBinaryPath,
      );
    },
    operation: async (worktreeIndexEnv) => {
      const changedPaths = await gitChangedPaths(
        workspacePath,
        baseCommit,
        limits.maxChangedFiles,
        worktreeIndexEnv,
        input.gitBinaryPath,
      );
      if (changedPaths.length === 0) {
        await assertGitHeadUnchanged(workspacePath, baseCommit, input.gitBinaryPath);
        const confirmed = await gitChangedPaths(workspacePath, baseCommit,
          limits.maxChangedFiles, worktreeIndexEnv, input.gitBinaryPath);
        if (confirmed.length !== 0) {
          throw new Error("handoff_workspace_changed_during_materialization");
        }
        return null;
      }
      await assertSafeChangedFiles({
        workspacePath,
        changedPaths,
        baseCommit,
        limits,
        scanSecretContent: input.scanSecretContent !== false,
        ...(input.gitBinaryPath === undefined
          ? {}
          : { gitBinaryPath: input.gitBinaryPath }),
      });
      await input.testHooks?.afterSafetyScan?.(1);
      const patch = await buildDeterministicPatch({
        workspacePath,
        changedPaths,
        baseCommit,
        limits,
        worktreeIndexEnv,
        ...(input.gitBinaryPath === undefined
          ? {}
          : { gitBinaryPath: input.gitBinaryPath }),
      });
      await input.testHooks?.afterPatchSnapshot?.(1);
      await assertGitHeadUnchanged(workspacePath, baseCommit, input.gitBinaryPath);
      if (workspaceLayer !== undefined) {
        const confirmedWorkspaceLayer = await captureHandoffWorkspaceLayer(
          workspacePath,
          input.gitBinaryPath,
        );
        if (workspaceLayer !== confirmedWorkspaceLayer) {
          throw new Error("handoff_workspace_changed_during_materialization");
        }
      }
      const confirmedChangedPaths = await gitChangedPaths(
        workspacePath,
        baseCommit,
        limits.maxChangedFiles,
        worktreeIndexEnv,
        input.gitBinaryPath,
      );
      if (!sameStrings(changedPaths, confirmedChangedPaths)) {
        throw new Error("handoff_workspace_changed_during_materialization");
      }
      await assertSafeChangedFiles({
        workspacePath,
        changedPaths: confirmedChangedPaths,
        baseCommit,
        limits,
        scanSecretContent: input.scanSecretContent !== false,
        ...(input.gitBinaryPath === undefined
          ? {}
          : { gitBinaryPath: input.gitBinaryPath }),
      });
      await input.testHooks?.afterSafetyScan?.(2);
      const confirmedPatch = await buildDeterministicPatch({
        workspacePath,
        changedPaths: confirmedChangedPaths,
        baseCommit,
        limits,
        worktreeIndexEnv,
        ...(input.gitBinaryPath === undefined
          ? {}
          : { gitBinaryPath: input.gitBinaryPath }),
      });
      await input.testHooks?.afterPatchSnapshot?.(2);
      await assertGitHeadUnchanged(workspacePath, baseCommit, input.gitBinaryPath);
      if (patch !== confirmedPatch) {
        throw new Error("handoff_workspace_changed_during_materialization");
      }
      return { baseCommit, changedPaths, patch };
    },
  });
}

function handoffArtifactLimits(
  overrides: Partial<HandoffArtifactLimits> | undefined,
): HandoffArtifactLimits {
  const limits = { ...DEFAULT_HANDOFF_ARTIFACT_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    const maximum =
      name === "maxChangedFiles"
        ? DEFAULT_HANDOFF_ARTIFACT_LIMITS.maxChangedFiles
        : maximumHandoffByteLimit;
    if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
      throw new Error(`handoff_limit_invalid:${name}`);
    }
  }
  return limits;
}

async function gitChangedPaths(
  workspacePath: string,
  baseCommit: string,
  maxChangedFiles: number,
  worktreeIndexEnv: NodeJS.ProcessEnv,
  gitBinaryPath?: HandoffGitSelection,
): Promise<readonly string[]> {
  const [tracked, untracked, stagedAdditions] = await Promise.all([
    gitNullPaths(workspacePath, [
      "diff",
      "--no-ext-diff",
      "--name-only",
      "--no-renames",
      "-z",
      baseCommit,
      "--",
    ], worktreeIndexEnv, gitBinaryPath),
    gitNullPaths(workspacePath, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ], worktreeIndexEnv, gitBinaryPath),
    gitLiveIndexAddedPaths(workspacePath, baseCommit, gitBinaryPath),
  ]);
  // A forced-ignored addition can remain in the live index after its worktree
  // file is removed. The patch represents final worktree bytes, not that index.
  const presentStagedAdditions: string[] = [];
  for (const stagedPath of stagedAdditions.map(assertSafeRelativePath)) {
    const absolute = resolve(workspacePath, stagedPath);
    if (!pathInside(workspacePath, absolute)) throw new Error("handoff_changed_path_escape");
    try {
      await lstat(absolute);
      presentStagedAdditions.push(stagedPath);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
  }
  const changed = uniqueSorted([...tracked, ...untracked, ...presentStagedAdditions]
    .map(assertSafeRelativePath));
  if (changed.length > maxChangedFiles) {
    throw new Error("handoff_changed_file_limit_exceeded");
  }
  return changed;
}

async function gitLiveIndexAddedPaths(
  workspacePath: string,
  baseCommit: string,
  gitBinaryPath?: HandoffGitSelection,
): Promise<readonly string[]> {
  // Forced additions can match .gitignore. The synthetic HEAD index cannot
  // see them, and --others --exclude-standard deliberately omits them.
  return gitNullPaths(workspacePath, [
    "diff", "--cached", "--no-ext-diff", "--name-only", "--no-renames",
    "--diff-filter=A", "-z", baseCommit, "--",
  ], undefined, gitBinaryPath);
}

async function assertSafeChangedFiles(input: {
  readonly workspacePath: string;
  readonly changedPaths: readonly string[];
  readonly baseCommit: string;
  readonly limits: HandoffArtifactLimits;
  readonly scanSecretContent: boolean;
  readonly gitBinaryPath?: HandoffGitSelection;
}): Promise<number> {
  let totalBytes = 0;
  const currentBlobs = new Map<string, Buffer>();
  for (const changedPath of input.changedPaths) {
    assertNonSensitivePath(changedPath);
    assertNoRawSecret(Buffer.from(changedPath), changedPath);
    const managedContext = resolveManagedDependencyGitContext(input.workspacePath, input.gitBinaryPath);
    if (managedContext !== undefined) assertManagedDependencyGitAuthoredPath(managedContext, changedPath);
    const path = resolve(input.workspacePath, changedPath);
    if (!pathInside(input.workspacePath, path)) {
      throw new Error("handoff_changed_path_escape");
    }
    let currentBytes: Buffer | undefined;
    try {
      if (managedContext !== undefined) {
        currentBytes = readHostedDependencyRootFile(managedContext, {
          recipe: HostedDependencyRootFileRecipe.AuthoredSourceV1, path: changedPath,
          maxFileBytes: input.limits.maxFileBytes, remainingTotalBytes: input.limits.maxTotalFileBytes - totalBytes,
        });
      } else {
        const item = await lstat(path);
        if (item.isSymbolicLink()) throw new Error("handoff_symlink_rejected");
        if (!item.isFile()) throw new Error("handoff_special_file_rejected");
        const canonical = await realpath(path);
        if (!pathInside(input.workspacePath, canonical)) {
          throw new Error("handoff_changed_path_escape");
        }
        if (item.size > input.limits.maxFileBytes) {
          throw new Error("handoff_file_byte_limit_exceeded");
        }
        const remainingTotalBytes = input.limits.maxTotalFileBytes - totalBytes;
        if (item.size > remainingTotalBytes) {
          throw new Error("handoff_total_byte_limit_exceeded");
        }
        const handle = await open(
          canonical,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          const opened = await handle.stat();
          if (!opened.isFile()) throw new Error("handoff_special_file_rejected");
          if (opened.size > input.limits.maxFileBytes) {
            throw new Error("handoff_file_byte_limit_exceeded");
          }
          if (opened.size > remainingTotalBytes) {
            throw new Error("handoff_total_byte_limit_exceeded");
          }
          if (
            opened.dev !== item.dev ||
            opened.ino !== item.ino ||
            opened.size !== item.size ||
            opened.mtimeMs !== item.mtimeMs
          ) {
            throw new Error("handoff_changed_file_unstable");
          }
          currentBytes = await readExactBoundedFile(handle, opened.size);
          const confirmed = await handle.stat();
          if (
            confirmed.size !== opened.size ||
            confirmed.mtimeMs !== opened.mtimeMs
          ) {
            throw new Error("handoff_changed_file_unstable");
          }
        } finally {
          await handle.close();
        }
      }
      currentBlobs.set(changedPath, currentBytes);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
    if (currentBytes !== undefined) {
      totalBytes += currentBytes.byteLength;
      if (totalBytes > input.limits.maxTotalFileBytes) {
        throw new Error("handoff_total_byte_limit_exceeded");
      }
      if (input.scanSecretContent) assertNoRawSecret(currentBytes, changedPath);
    }
  }
  const baseObjects = await gitBaseBlobObjects({
    workspacePath: input.workspacePath,
    baseCommit: input.baseCommit,
    changedPaths: input.changedPaths,
    ...(input.gitBinaryPath === undefined
      ? {}
      : { gitBinaryPath: input.gitBinaryPath }),
  });
  const objectIds = [
    ...new Set(
      input.changedPaths.flatMap((path) => {
        const objectId = baseObjects.get(path);
        return objectId === undefined ? [] : [objectId];
      }),
    ),
  ];
  let objectBlobs: readonly (Buffer | undefined)[] = [];
  try {
    objectBlobs =
      objectIds.length === 0
        ? []
        : typeof input.gitBinaryPath === "object"
          ? await readManagedDependencyGitBlobs(input.gitBinaryPath, {
              objectNames: objectIds, maxBlobBytes: input.limits.maxFileBytes,
              maxTotalBytes: input.limits.maxTotalFileBytes - totalBytes,
            })
          : await readGitBlobBatch({
            workspacePath: input.workspacePath,
            objectNames: objectIds,
            maxBlobBytes: input.limits.maxFileBytes,
            maxTotalBytes: input.limits.maxTotalFileBytes - totalBytes,
            noReplaceObjects: true,
            ...(typeof input.gitBinaryPath === "string" ? { gitBinaryPath: input.gitBinaryPath } : {}),
          });
  } catch (error) {
    throw handoffGitBlobError(error);
  }
  const bytesByObject = new Map<string, Buffer>();
  for (const [index, objectId] of objectIds.entries()) {
    const bytes = objectBlobs[index];
    if (bytes === undefined) throw new Error("handoff_base_blob_missing");
    bytesByObject.set(objectId, bytes);
  }
  for (const changedPath of input.changedPaths) {
    const objectId = baseObjects.get(changedPath);
    const baseBytes =
      objectId === undefined ? undefined : bytesByObject.get(objectId);
    if (
      currentBlobs.get(changedPath) === undefined &&
      baseBytes === undefined
    ) {
      throw new Error("handoff_changed_blob_missing");
    }
    if (baseBytes === undefined) continue;
    totalBytes += baseBytes.byteLength;
    if (totalBytes > input.limits.maxTotalFileBytes) {
      throw new Error("handoff_total_byte_limit_exceeded");
    }
    if (input.scanSecretContent) assertNoRawSecret(baseBytes, changedPath);
  }
  return totalBytes;
}

function continuationWorkspaceFingerprint(input: {
  readonly baseCommit: string;
  readonly changedPaths: readonly string[];
  readonly patch: string;
}): string {
  const hash = createHash("sha256");
  hash.update(CODEX_GOAL_CONTINUATION_WORKSPACE_FINGERPRINT_SCHEMA);
  hash.update("\0");
  hash.update(input.baseCommit);
  for (const path of input.changedPaths) hash.update(`\0${path}`);
  hash.update("\0");
  hash.update(input.patch);
  return hash.digest("hex");
}

async function readExactBoundedFile(
  handle: Awaited<ReturnType<typeof open>>,
  declaredSize: number,
): Promise<Buffer> {
  const contents = Buffer.allocUnsafe(declaredSize);
  let offset = 0;
  while (offset < declaredSize) {
    const { bytesRead } = await handle.read(
      contents,
      offset,
      declaredSize - offset,
      offset,
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  const overflow = Buffer.allocUnsafe(1);
  const { bytesRead: overflowBytes } = await handle.read(
    overflow,
    0,
    1,
    offset,
  );
  if (overflowBytes !== 0 || offset !== declaredSize) {
    throw new Error("handoff_changed_file_unstable");
  }
  return contents;
}

async function gitBaseBlobObjects(input: {
  readonly workspacePath: string;
  readonly baseCommit: string;
  readonly changedPaths: readonly string[];
  readonly gitBinaryPath?: HandoffGitSelection;
}): Promise<ReadonlyMap<string, string>> {
  const treeOutput = await gitOutput(
    input.workspacePath,
    ["ls-tree", "-z", input.baseCommit, "--", ...input.changedPaths],
    2 * 1024 * 1024,
    undefined,
    input.gitBinaryPath,
  );
  const requested = new Set(input.changedPaths);
  const objects = new Map<string, string>();
  for (const entry of treeOutput.split("\0").filter(Boolean)) {
    const separator = entry.indexOf("\t");
    const metadata = entry.slice(0, separator).split(" ");
    const listedPath = entry.slice(separator + 1);
    const [mode, type, objectId] = metadata;
    if (
      separator < 0 ||
      !requested.has(listedPath) ||
      objects.has(listedPath) ||
      (mode !== "100644" && mode !== "100755") ||
      type !== "blob" ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(objectId ?? "")
    ) {
      throw new Error("handoff_base_blob_entry_invalid");
    }
    objects.set(listedPath, objectId as string);
  }
  return objects;
}

function handoffGitBlobError(error: unknown): Error {
  if (error instanceof Error) {
    if (error.message.includes("blob_limit")) {
      return new Error("handoff_file_byte_limit_exceeded");
    }
    if (
      error.message.includes("total_limit") ||
      error.message.includes("output_limit")
    ) {
      return new Error("handoff_total_byte_limit_exceeded");
    }
  }
  return new Error("handoff_base_blob_unreadable");
}

async function buildDeterministicPatch(input: {
  readonly workspacePath: string;
  readonly changedPaths: readonly string[];
  readonly baseCommit: string;
  readonly limits: HandoffArtifactLimits;
  readonly worktreeIndexEnv: NodeJS.ProcessEnv;
  readonly gitBinaryPath?: HandoffGitSelection;
}): Promise<string> {
  const addedPaths = new Set([
    ...await gitNullPaths(input.workspacePath, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ], input.worktreeIndexEnv, input.gitBinaryPath),
    ...await gitLiveIndexAddedPaths(input.workspacePath, input.baseCommit,
      input.gitBinaryPath),
  ]);
  const trackedPatch = await gitOutput(
    input.workspacePath,
    [
      "diff",
      "--no-ext-diff",
      "--binary",
      "--no-renames",
      input.baseCommit,
      "--",
    ],
    input.limits.maxPatchBytes,
    input.worktreeIndexEnv,
    input.gitBinaryPath,
  );
  const parts = trackedPatch ? [ensureTrailingNewline(trackedPatch)] : [];
  let byteLength = Buffer.byteLength(trackedPatch);
  for (const changedPath of input.changedPaths.filter((path) =>
    addedPaths.has(path),
  )) {
    const remaining = input.limits.maxPatchBytes - byteLength;
    if (remaining <= 0) throw new Error("handoff_patch_byte_limit_exceeded");
    const item = await gitDiffNoIndex(
      input.workspacePath,
      changedPath,
      remaining,
      input.gitBinaryPath,
    );
    const normalized = ensureTrailingNewline(item);
    byteLength += Buffer.byteLength(normalized);
    if (byteLength > input.limits.maxPatchBytes) {
      throw new Error("handoff_patch_byte_limit_exceeded");
    }
    parts.push(normalized);
  }
  const patch = parts.join("");
  if (!patch.trim()) throw new Error("handoff_patch_empty_for_dirty_workspace");
  return patch;
}

export async function assertExactPatchSecretSafe(input: {
  readonly gitBinaryPath?: HandoffGitSelection;
  readonly workspacePath: string;
  readonly jobRootDir: string;
  readonly baseCommit: string;
  readonly patch: string;
  readonly changedPaths: readonly string[];
  readonly limits?: Partial<HandoffArtifactLimits>;
}): Promise<number> {
  try {
    const limits = handoffArtifactLimits(input.limits);
    return await assertGitPatchBlobsSecretSafe({
      workspacePath: input.workspacePath,
      ...(input.gitBinaryPath === undefined ? {} : { gitBinaryPath: input.gitBinaryPath }),
      baseCommit: input.baseCommit,
      patch: input.patch,
      changedPaths: input.changedPaths,
      tempRootDir: input.jobRootDir,
      maxFileBytes: limits.maxFileBytes,
      maxTotalFileBytes: limits.maxTotalFileBytes,
    });
  } catch (error) {
    throw handoffPatchValidationError(error);
  }
}

function handoffPatchValidationError(error: unknown): Error {
  if (error instanceof Error) {
    if (error.message.startsWith("git_patch_secret_like_content:")) {
      return new Error(
        error.message.replace(
          "git_patch_secret_like_content:",
          "handoff_raw_secret_rejected:",
        ),
      );
    }
    if (error.message === "git_patch_secret_file_limit_exceeded") {
      return new Error("handoff_file_byte_limit_exceeded");
    }
    if (error.message === "git_patch_secret_total_limit_exceeded") {
      return new Error("handoff_total_byte_limit_exceeded");
    }
    if (error.message === "git_patch_secret_changed_paths_mismatch") {
      return new Error("handoff_patch_changed_paths_mismatch");
    }
    if (error.message === "git_patch_secret_changed_blob_missing") {
      return new Error("handoff_changed_blob_missing");
    }
  }
  return new Error("handoff_patch_validation_failed");
}

async function publishExactFile(path: string, content: string, managedContext?: HostedDependencyRootPurposeContext): Promise<void> {
  if (managedContext !== undefined) {
    publishProtectedTextArtifact(managedContext, path, content); return;
  }
  await publishImmutableTextArtifact({
    path,
    content,
    existingPathUnsafeError: "handoff_artifact_existing_path_unsafe",
    contentMismatchError: "handoff_artifact_content_mismatch",
  });
}

async function canonicalOwnedDirectory(
  path: string,
  label: string,
): Promise<string> {
  const item = await lstat(path);
  if (item.isSymbolicLink() || !item.isDirectory()) {
    throw new Error(`${label}_unsafe`);
  }
  return await realpath(path);
}

function assertNonSensitivePath(path: string): void {
  const lower = path.toLowerCase();
  const name = basename(lower);
  if (
    name === "auth.json" ||
    name === ".env" ||
    name.startsWith(".env.") ||
    name === ".npmrc" ||
    name === ".pypirc" ||
    name === "credentials" ||
    name === "credentials.json" ||
    lower.includes("/.ssh/") ||
    lower.startsWith(".ssh/")
  ) {
    throw new Error("handoff_sensitive_path_rejected");
  }
}

function assertNoRawSecret(content: Buffer, path: string): void {
  if (detectSecretLikeContent(content, { filePath: path }) !== undefined) {
    throw new Error(`handoff_raw_secret_rejected:${path}`);
  }
}

function descriptor(path: string, content: string): HandoffArtifactDescriptor {
  return {
    path,
    byteLength: Buffer.byteLength(content),
    sha256: sha256(content),
  };
}

function runtimeArtifact(
  kind: string,
  item: HandoffArtifactDescriptor,
): RuntimeResultArtifact {
  return { kind, ...item };
}

function publishProtectedTextArtifact(context: HostedDependencyRootPurposeContext, path: string, content: string): void {
  withHostedActivationFence(fence => {
    const scope = assertCurrentHostedDependencyRootPurpose(context, HostedDependencyRootPurpose.ManagedGitReadV1, fence);
    const root = scope.durableHandoffRoot.canonicalPath, name = basename(path);
    if (path !== join(root, name) || !name.startsWith(scope.logicalTaskId + ".") ||
        !isManagedDependencySignedTaskId(scope.logicalTaskId) ||
        !/^[a-f0-9]{64}\.handoff\.(?:patch|summary\.json|manifest\.json)$/.test(name.slice(scope.logicalTaskId.length + 1))) throw new Error("handoff_protected_scope_mismatch");
    const bytes = Buffer.from(content);
    if (bytes.length > maximumHandoffByteLimit) throw new Error("handoff_total_byte_limit_exceeded");
    const parent = syncFs.lstatSync(root, { bigint: true });
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.dev.toString() !== scope.durableHandoffRoot.dev ||
        parent.ino.toString() !== scope.durableHandoffRoot.ino || parent.uid !== 0n || parent.gid !== 0n ||
        (parent.mode & 0o7777n) !== 0o700n || syncFs.realpathSync(root) !== root) throw new Error("handoff_artifact_existing_path_unsafe");
    const verifyReadback = (): void => {
      const resource = openCurrentHostedDependencyRootDescriptor(context, fence, HostedDependencyRootDescriptorRecipe.DurableFileV1, path);
      const existing = resource.fd;
      try {
        const item = syncFs.fstatSync(existing, { bigint: true });
        if (!item.isFile() || item.nlink !== 1n || item.uid !== 0n || item.gid !== 0n || item.dev !== parent.dev ||
            (item.mode & 0o7777n) !== 0o600n || item.size !== BigInt(bytes.length)) throw new Error("handoff_artifact_existing_path_unsafe");
        assertCurrentHostedDependencyRootPurpose(context, HostedDependencyRootPurpose.ManagedGitReadV1, fence);
        const actual = Buffer.alloc(bytes.length); let offset = 0;
        while (offset < actual.length) { const count = syncFs.readSync(existing, actual, offset, actual.length - offset, offset);
          if (count === 0) throw new Error("handoff_artifact_content_mismatch"); offset += count; }
        const after = syncFs.fstatSync(existing, { bigint: true }), named = syncFs.lstatSync(path, { bigint: true });
        if (syncFs.readSync(existing, Buffer.alloc(1), 0, 1, offset) !== 0 || !actual.equals(bytes) ||
            item.dev !== after.dev || item.ino !== after.ino || item.size !== after.size || item.mtimeNs !== after.mtimeNs || named.dev !== after.dev ||
            named.ino !== after.ino || named.size !== after.size || named.mtimeNs !== after.mtimeNs ||
            named.nlink !== 1n || named.mode !== after.mode) throw new Error("handoff_artifact_content_mismatch");
        assertCurrentHostedDependencyRootPurpose(context, HostedDependencyRootPurpose.ManagedGitReadV1, fence);
      } finally { resource.close(); }
    };
    let fd: number;
    try { fd = syncFs.openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
      verifyReadback(); return;
    }
    try {
      syncFs.writeFileSync(fd, bytes); syncFs.fsyncSync(fd);
    } finally { syncFs.closeSync(fd); }
    verifyReadback();
    const parentResource = openCurrentHostedDependencyRootDescriptor(context, fence, HostedDependencyRootDescriptorRecipe.DirectoryV1, root);
    try { syncFs.fsyncSync(parentResource.fd); } finally { parentResource.close(); }
    assertCurrentHostedDependencyRootPurpose(context, HostedDependencyRootPurpose.ManagedGitReadV1, fence);
  });
}
