import type { DependencyToolUsableExecution } from "../../../core/dependency-environment/dependency-tool-execution";
import type { DependencyAttempt, DependencyProtectedReference, DependencyWorkspaceIdentity } from "@vioxen/subscription-runtime/core";
import type { HostedDependencyRootGitProfile } from "./hosted-dependency-root-git-profile";
import type { DependencyToolReadyFacts } from "../../../core/dependency-environment/dependency-tool-ready-reader";

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
export enum HostedDependencyRootOriginKind { ManagedReadonlyLocalV1 = "managed_readonly_local_v1", OrdinaryDependencyReaderV1 = "ordinary_dependency_reader_v1" }
export type HostedDependencyRootScope = Readonly<{
  logicalJobId: string; logicalTaskId: string; executionJobId: string; jobRootDir: string;
  workspace: DependencyWorkspaceIdentity; attempt: DependencyAttempt;
  ownerRevision: number;
}> & (Readonly<{originKind:HostedDependencyRootOriginKind.ManagedReadonlyLocalV1;custodyReference:DependencyProtectedReference}> |
  Readonly<{originKind:HostedDependencyRootOriginKind.OrdinaryDependencyReaderV1;originReference:DependencyProtectedReference;
    readerProducer:DependencyProtectedReference;readerEntry:DependencyProtectedReference}>);
export type HostedDependencyManagedGitScope = HostedDependencyRootScope & Readonly<{
  rootGit: HostedDependencyRootGitProfile; protectedProfile: DependencyProtectedReference;
  durableHandoffRoot: HostedDependencyRootDirectoryPin; scratchParent: HostedDependencyRootDirectoryPin;
  authoredRoots: readonly HostedDependencyRootDirectoryPin[]; generatedRoots: readonly HostedDependencyRootDirectoryPin[];
  sourceLookupAncestors: readonly HostedDependencyRootDirectoryPin[];
}>;
type HostedDependencyRootPreparationCommon = Readonly<{
  attempt: DependencyAttempt; qualification: DependencyProtectedReference;
  protectedProfile: DependencyProtectedReference; config: DependencyProtectedReference;
  configAncestors: readonly HostedDependencyRootDirectoryPin[];
  durableHandoffRoot: HostedDependencyRootDirectoryPin; scratchParent: HostedDependencyRootDirectoryPin;
  authoredRoots: readonly HostedDependencyRootDirectoryPin[]; generatedRoots: readonly HostedDependencyRootDirectoryPin[];
  sourceLookupAncestors: readonly HostedDependencyRootDirectoryPin[];
}>;
type HostedDependencyOrdinaryPreparationLineage=Readonly<{originReference:DependencyProtectedReference;
  readerProducer:DependencyProtectedReference;readerEntry:DependencyProtectedReference}>;
export type HostedDependencyReadyRootPreparation = HostedDependencyRootPreparationCommon & Readonly<{
  providerReady:DependencyToolReadyFacts;ready:DependencyProtectedReference;readyRevision:number;
}> & (Readonly<{version:2;custodyReference:DependencyProtectedReference}> |
  Readonly<{version:3}>&HostedDependencyOrdinaryPreparationLineage);
export type HostedDependencyUsableRootPreparation = HostedDependencyRootPreparationCommon & Readonly<{
  execution:DependencyToolUsableExecution;unverified:DependencyProtectedReference;unverifiedRevision:number;
}> & (Readonly<{version:4;custodyReference:DependencyProtectedReference}> |
  Readonly<{version:5}>&HostedDependencyOrdinaryPreparationLineage);
export type HostedDependencyRootPreparationRecord=HostedDependencyReadyRootPreparation|HostedDependencyUsableRootPreparation;

/** Fixed actual provider birth readback; factual data is not a registration permit. */
type HostedDependencyProviderBirthCommon=Readonly<{
  installationId:string;runtimeSha:string;hostId:string;bootId:string;supervisorId:string;generation:number;
  unit:string;providerStartId:string;parentStartId:string;logicalJobId:string;executionJobId:string;jobRootDir:string;
  workspace:DependencyWorkspaceIdentity;attempt:DependencyAttempt;originReference:DependencyProtectedReference;
  qualification:DependencyProtectedReference;protectedProfile:DependencyProtectedReference;
}>;
type HostedDependencyOrdinaryProviderLineage=Readonly<{
  originKind:HostedDependencyRootOriginKind.OrdinaryDependencyReaderV1;parentGeneration:number;
  ordinaryProviderReference:DependencyProtectedReference;readerProducer:DependencyProtectedReference;readerEntry:DependencyProtectedReference;
  ordinaryRelation:Readonly<{version:1;parentStartId:string;attemptId:string;epoch:number;providerStartId:string;startDigest:string;unit:string}>;
}>;
export type HostedDependencyManagedProviderFacts=HostedDependencyProviderBirthCommon & (
  | Readonly<{ready:DependencyProtectedReference;readyRevision:number}> &
    (Readonly<{version:1;custodyReference:DependencyProtectedReference}>|Readonly<{version:2}>&HostedDependencyOrdinaryProviderLineage)
  | Readonly<{execution:DependencyToolUsableExecution;unverified:DependencyProtectedReference;unverifiedRevision:number}> &
    (Readonly<{version:3;custodyReference:DependencyProtectedReference}>|Readonly<{version:4}>&HostedDependencyOrdinaryProviderLineage)
);
