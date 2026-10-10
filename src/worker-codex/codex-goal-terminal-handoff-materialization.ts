import type { RuntimeResultArtifact } from "@vioxen/subscription-runtime/worker-core";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { CodexGoalContinuationWorkspaceFingerprint } from "./codex-goal-continuation-workspace-fingerprint";
import {
  captureCodexGoalContinuationWorkspaceFingerprint,
} from "./codex-goal-handoff-artifacts";
import { materializeDurableCodexGoalHandoffPacket } from
  "./codex-goal-durable-handoff-packet";
import { readLocalGitHeadCommit } from "./codex-goal-git-revision";
import { sanitizeNodeDependencyEnvironment } from "./dependency-environment-safety";
import { resolveManagedDependencyGitContext, assertManagedDependencyGitContext,
  type HostedDependencyRootPurposeContext } from "./managed-dependency-git";
import { readHostedDependencyRootFile, HostedDependencyRootFileRecipe } from "./hosted-dependency-root-file-reader";

export type TerminalCodexGoalHandoffMaterialization = {
  readonly artifacts: readonly RuntimeResultArtifact[];
  readonly changedPaths?: readonly string[];
  readonly errorCode?: string;
  readonly continuationFingerprint?: CodexGoalContinuationWorkspaceFingerprint;
  readonly packetPath?: string;
  readonly manifestSha256?: string;
  readonly baseCommit?: string;
  readonly indexSha256?: string;
  readonly worktreeSha256?: string;
  readonly headRelativeSha256?: string;
  readonly untrackedArchiveSha256?: string;
};

export function assertDirtyTerminalHandoffAvailable(
  changedFiles: readonly string[],
  handoff: TerminalCodexGoalHandoffMaterialization | null,
  artifacts: readonly { readonly path?: string }[],
): void {
  if (changedFiles.length === 0) return;
  if (!handoff?.packetPath || !handoff.manifestSha256 || artifacts.length === 0) {
    throw new Error(
      `dirty_terminal_handoff_unavailable:${handoff?.errorCode ?? "unknown"}`,
    );
  }
}

export async function materializeReconciledTerminalCodexGoalHandoff(input: {
  readonly config: Parameters<typeof tryMaterializeTerminalCodexGoalHandoff>[0];
  readonly changedFiles: readonly string[];
  readonly publicationAuthority?: TerminalHandoffPublicationAuthority;
}): Promise<{
  readonly handoff: TerminalCodexGoalHandoffMaterialization | null;
  readonly artifacts: readonly RuntimeResultArtifact[];
  readonly changedPaths: readonly string[];
  readonly baseCommit: string | undefined;
}> {
  const managedContext = resolveManagedDependencyGitContext(input.config.workspacePath, input.config.managedContext);
  if (managedContext !== undefined) assertTerminalScope(input.config, managedContext);
  const currentHeadCommit = await readLocalGitHeadCommit(input.config.workspacePath, managedContext);
  const handoff = input.changedFiles.length === 0
    ? null
    : await tryMaterializeTerminalCodexGoalHandoff({
        ...input.config,
        ...(managedContext === undefined ? {} : { managedContext }),
        ...(currentHeadCommit === undefined
          ? {}
          : { expectedHeadCommit: currentHeadCommit }),
      }, input.publicationAuthority);
  const artifacts = handoff?.artifacts ?? [];
  assertDirtyTerminalHandoffAvailable(input.changedFiles, handoff, artifacts);
  return {
    handoff,
    artifacts,
    changedPaths: handoff?.changedPaths ?? input.changedFiles,
    baseCommit: handoff?.baseCommit ?? currentHeadCommit,
  };
}

/** Trusted runtime adapter dependencies; never part of serialized run config. */
export type TerminalHandoffPublicationDependencies = {
  readonly assertTerminalHandoffPublicationAuthorized?: () => Promise<void>;
  readonly withTerminalHandoffPublicationAuthority?: <T>(effect: () => Promise<T>) => Promise<T>;
};
export type TerminalHandoffPublicationAuthority = {
  readonly assertPublicationAuthorized: () => Promise<void>;
  readonly withPublicationAuthority?: <T>(effect: () => Promise<T>) => Promise<T>;
};
export async function tryMaterializeTerminalCodexGoalHandoff(input: {
  readonly managedContext?: HostedDependencyRootPurposeContext;
  readonly jobId?: string;
  readonly jobRootDir: string;
  readonly durableHandoffRootDir?: string;
  readonly taskId: string;
  readonly workspacePath: string;
  readonly expectedBaseCommit?: string;
  readonly expectedHeadCommit?: string;
}, trusted?: TerminalHandoffPublicationAuthority): Promise<TerminalCodexGoalHandoffMaterialization> {
  const effect = async (): Promise<TerminalCodexGoalHandoffMaterialization> => {
  let managedContext: HostedDependencyRootPurposeContext | undefined;
  try {
    await trusted?.assertPublicationAuthorized();
    managedContext = resolveManagedDependencyGitContext(input.workspacePath, input.managedContext);
    if (managedContext !== undefined) assertTerminalScope(input, managedContext);
    // Dependency bootstrap may create worktree-local links to a shared cache.
    // They are execution infrastructure, never authored output. Remove only
    // dependency roots proven unsafe by the bounded dependency scanner before
    // freezing the terminal workspace. All other symlinks still fail closed in
    // handoff materialization.
    if (managedContext === undefined) await sanitizeNodeDependencyEnvironment({ workspacePath: input.workspacePath });
    // Protected packet output is nonmutating: removedPaths stays empty. It
    // neither scans generated NM nor retires a Ready baseline for serialization.
    else sanitizeManagedTerminalOutput(managedContext);
    const expectedBaseCommit = input.expectedBaseCommit ??
      await recordedRunStartBaseCommit(input.jobRootDir, input.taskId, managedContext);
    const materialized = await materializeDurableCodexGoalHandoffPacket({
      workerJobId: input.jobId ?? (managedContext === undefined ? input.taskId : assertManagedDependencyGitContext(managedContext).logicalJobId),
      ...(managedContext === undefined ? {} : { managedContext }),
      taskId: input.taskId,
      workspacePath: input.workspacePath,
      durableRootDir: resolveDurableHandoffRoot(
        input.durableHandoffRootDir,
        input.jobRootDir,
      ),
      ...(trusted ? { publicationAuthority: trusted } : {}),
      ...(expectedBaseCommit === undefined
        ? {}
        : { expectedBaseCommit }),
      ...(input.expectedHeadCommit === undefined
        ? {}
        : { expectedHeadCommit: input.expectedHeadCommit }),
    });
    return materialized === null
      ? {
          artifacts: [],
          errorCode: "handoff_patch_empty_for_dirty_workspace",
        }
      : {
          artifacts: materialized.artifacts,
          changedPaths: materialized.changedPaths,
          packetPath: materialized.packetPath,
          manifestSha256: materialized.manifestSha256,
          baseCommit: materialized.manifest.git.base,
          indexSha256: materialized.manifest.layers.index.sha256,
          worktreeSha256: materialized.manifest.layers.worktree.sha256,
          ...(materialized.manifest.layers.headRelative
            ? { headRelativeSha256: materialized.manifest.layers.headRelative.sha256 }
            : {}),
          untrackedArchiveSha256: materialized.manifest.untracked.archive.sha256,
        };
  } catch (error) {
    const errorCode = safeHandoffMaterializationErrorCode(error);
    const continuationFingerprint = errorCode === "handoff_raw_secret_rejected"
      ? await tryCaptureContinuationFingerprint({ ...input, ...(managedContext === undefined ? {} : { managedContext }) })
      : undefined;
    return {
      artifacts: [],
      errorCode,
      ...(continuationFingerprint
        ? {
            continuationFingerprint,
            changedPaths: continuationFingerprint.changedPaths,
          }
        : {}),
    };
  }
  };
  return trusted?.withPublicationAuthority ? await trusted.withPublicationAuthority(effect) : await effect();
}

async function recordedRunStartBaseCommit(
  jobRootDir: string,
  taskId: string,
  managedContext?: HostedDependencyRootPurposeContext,
): Promise<string | undefined> {
  try {
    const lines = (managedContext === undefined ? await readFile(
      join(jobRootDir, `${taskId}.events.jsonl`),
      "utf8",
    ) : readHostedDependencyRootFile(managedContext, { recipe: HostedDependencyRootFileRecipe.TaskEventsV1 }).toString("utf8")).split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line) as {
        readonly event?: unknown;
        readonly attributes?: { readonly baseCommit?: unknown };
      };
      if (event.event === "runner_starting" &&
        typeof event.attributes?.baseCommit === "string" &&
        event.attributes.baseCommit.trim()) {
        return event.attributes.baseCommit.trim();
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return undefined;
}
export function terminalCodexGoalHandoffResultDetails(
  handoff: TerminalCodexGoalHandoffMaterialization | null,
): Readonly<Record<string, string>> {
  return {
    ...(handoff?.errorCode ? { handoffArtifactError: handoff.errorCode } : {}),
    ...(handoff?.continuationFingerprint
      ? {
          continuationWorkspaceFingerprintSchema:
            handoff.continuationFingerprint.schema,
          continuationWorkspaceFingerprintSha256:
            handoff.continuationFingerprint.sha256,
        }
      : {}),
    ...(handoff?.packetPath ? { handoffPacketPath: handoff.packetPath } : {}),
    ...(handoff?.manifestSha256
      ? { handoffManifestSha256: handoff.manifestSha256 }
      : {}),
    ...(handoff?.indexSha256 ? { handoffIndexSha256: handoff.indexSha256 } : {}),
    ...(handoff?.worktreeSha256
      ? { handoffWorktreeSha256: handoff.worktreeSha256 }
      : {}),
    ...(handoff?.headRelativeSha256
      ? { handoffHeadRelativeSha256: handoff.headRelativeSha256 }
      : {}),
    ...(handoff?.untrackedArchiveSha256
      ? { handoffUntrackedArchiveSha256: handoff.untrackedArchiveSha256 }
      : {}),
  };
}

function resolveDurableHandoffRoot(
  value: string | undefined,
  jobRootDir: string,
): string {
  if (value === undefined) return join(jobRootDir, "durable-handoffs");
  if (!value.trim()) throw new Error("handoff_durable_root_required");
  return value;
}

export function terminalCodexGoalHandoffEvidence(
  handoff: TerminalCodexGoalHandoffMaterialization | null,
): readonly string[] {
  return [
    ...(handoff?.errorCode
      ? [`handoff_artifact_materialization_failed:${handoff.errorCode}`]
      : []),
    ...(handoff?.continuationFingerprint
      ? ["continuation_workspace_fingerprint_captured"]
      : []),
  ];
}

async function tryCaptureContinuationFingerprint(input: {
  readonly workspacePath: string;
  readonly managedContext?: HostedDependencyRootPurposeContext;
  readonly expectedBaseCommit?: string;
}): Promise<CodexGoalContinuationWorkspaceFingerprint | undefined> {
  try {
    return (await captureCodexGoalContinuationWorkspaceFingerprint({ ...input,
      ...(input.managedContext === undefined ? {} : { gitBinaryPath: input.managedContext }) })) ??
      undefined;
  } catch {
    return undefined;
  }
}

function safeHandoffMaterializationErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const code = message.split(":", 1)[0] ?? "";
  return /^handoff_[a-z0-9_]+$/.test(code)
    ? code
    : "handoff_artifact_materialization_failed";
}

function assertTerminalScope(input: { readonly jobId?: string; readonly jobRootDir: string;
  readonly workspacePath: string; readonly taskId: string; readonly durableHandoffRootDir?: string },
  context: HostedDependencyRootPurposeContext): void {
  const scope = assertManagedDependencyGitContext(context, input.workspacePath);
  if (input.jobRootDir !== scope.jobRootDir || input.taskId !== scope.logicalTaskId ||
      input.jobId !== undefined && input.jobId !== scope.logicalJobId ||
      input.durableHandoffRootDir !== undefined && input.durableHandoffRootDir !== scope.durableHandoffRoot.canonicalPath)
    throw new Error("handoff_protected_scope_mismatch");
}

function sanitizeManagedTerminalOutput(context: HostedDependencyRootPurposeContext): Readonly<{ removedPaths: readonly string[] }> {
  assertManagedDependencyGitContext(context);
  return Object.freeze({ removedPaths: Object.freeze([]) });
}
