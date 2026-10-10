import type { DependencyAttempt, DependencyProtectedReference, DependencyWorkspaceIdentity } from "@vioxen/subscription-runtime/core";
import type { HostedDependencyRootGitProfile } from "./hosted-dependency-root-git-profile";

/** Factual signed identity grammar only. JavaScript's $ also matches before a
 * final newline; require the matched bytes to equal the complete identity. */
export function isHostedDependencySignedTaskId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return /^[A-Za-z0-9_@.-]{1,128}$/.exec(value)?.[0] === value;
}

/** Host adapter facts. This record/type/parser is never an effect permit. */
export enum HostedDependencyRootPurpose {
  ManagedGitReadV1 = "managed_git_read_v1",
  DependencySourceCleanupV1 = "dependency_source_cleanup_v1",
  SessionRefreshV1 = "session_refresh_v1",
}
export type HostedDependencyRootDirectoryPin = Readonly<{ canonicalPath: string; dev: string; ino: string; mountId: string }>;
export type HostedDependencyRootScope = Readonly<{
  logicalJobId: string; logicalTaskId: string; executionJobId: string; jobRootDir: string;
  workspace: DependencyWorkspaceIdentity; attempt: DependencyAttempt;
  ownerRevision: number; custodyReference: DependencyProtectedReference;
}>;
export type HostedDependencyManagedGitScope = HostedDependencyRootScope & Readonly<{
  rootGit: HostedDependencyRootGitProfile; protectedProfile: DependencyProtectedReference;
  durableHandoffRoot: HostedDependencyRootDirectoryPin; scratchParent: HostedDependencyRootDirectoryPin;
  authoredRoots: readonly HostedDependencyRootDirectoryPin[]; generatedRoots: readonly HostedDependencyRootDirectoryPin[];
  sourceLookupAncestors: readonly HostedDependencyRootDirectoryPin[];
}>;
export type HostedDependencyRootPreparationRecord = Readonly<{
  version: 1; attempt: DependencyAttempt; custodyReference: DependencyProtectedReference;
  qualification: DependencyProtectedReference; ready: DependencyProtectedReference; readyRevision: number;
  protectedProfile: DependencyProtectedReference; config: DependencyProtectedReference;
  configAncestors: readonly HostedDependencyRootDirectoryPin[];
  durableHandoffRoot: HostedDependencyRootDirectoryPin; scratchParent: HostedDependencyRootDirectoryPin;
  authoredRoots: readonly HostedDependencyRootDirectoryPin[]; generatedRoots: readonly HostedDependencyRootDirectoryPin[];
  sourceLookupAncestors: readonly HostedDependencyRootDirectoryPin[];
}>;
