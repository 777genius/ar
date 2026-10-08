/** Storage receipts describe authority; only a trusted adapter enforces it. */
export enum JobStorageIntentKind {
  NoResume = "no-resume",
  Continuation = "continuation",
}
export enum JobStorageHomeStateRequirement {
  NoneRequired = "none-required",
}
export type JobStorageIntent =
  | { readonly kind: JobStorageIntentKind.NoResume; readonly homeStateRequirement: JobStorageHomeStateRequirement.NoneRequired }
  | { readonly kind: JobStorageIntentKind.Continuation; readonly sessionId: string };

export type JobStorageIdentity = {
  readonly jobId: string;
  readonly generationId: string;
  readonly receiptSha256: string;
};
export type JobStorageLayout = {
  readonly jobRoot: string;
  readonly workspace: string;
  readonly state: string;
  readonly home: string;
  readonly tmp: string;
};
export type JobStorageAdmissionReceipt = JobStorageIdentity & {
  readonly schemaVersion: 1;
  readonly intent: JobStorageIntent;
  readonly taskId: string;
  readonly attemptId: string;
  readonly producerId: JobStorageProducer;
  readonly providerBindingSha256: string;
  readonly layout: JobStorageLayout;
  readonly machineId: string;
  readonly filesystemUuid: string;
  readonly device: string;
  readonly mountSource: string;
  readonly fsRoot: string;
  readonly namespaceId: string;
  readonly pinId: string;
};
export enum JobStorageProducer {
  CodexGoalRunner = "codex-goal-runner",
}
export enum JobStorageCapabilityStatus {
  Verified = "verified",
  Unsupported = "unsupported",
  Unknown = "unknown",
}
export enum JobStorageUnavailableCapability {
  NativeLifetime = "native-lifetime",
  OneShotDisposal = "one-shot-disposal",
}
export class JobStorageCapabilityUnavailableError extends Error {
  readonly status = JobStorageCapabilityStatus.Unsupported;
  constructor(readonly capability: JobStorageUnavailableCapability) {
    super(capability === JobStorageUnavailableCapability.NativeLifetime
      ? "job_storage_lifetime_authority_required" : "job_storage_one_shot_disposal_unqualified");
    this.name = "JobStorageCapabilityUnavailableError";
  }
}
export enum JobStorageSettlementStatus {
  Active = "active",
  Resumable = "resumable",
  Closed = "closed",
}
export type JobStorageSettlement = JobStorageIdentity & {
  readonly revision: number;
  readonly intent: JobStorageIntent;
  readonly status: JobStorageSettlementStatus;
};
export enum SourceRecoveryFacet {
  GitObjects = "git-objects",
  Refs = "refs",
  Reflogs = "reflogs",
  Stash = "stash",
  Index = "index",
  Staged = "staged",
  Worktree = "worktree",
  UntrackedIncludingIgnored = "untracked-including-ignored",
  Dependencies = "dependencies",
}
/** Independent verifier inventories the restored snapshot, not a patch packet. */
export type SourceRecoveryCoverage = {
  readonly sourceManifestSha256: string;
  readonly inventorySha256: string;
  readonly facets: Readonly<Record<SourceRecoveryFacet, JobStorageCapabilityStatus>>;
};
export type JobStorageHandoffVerification =
  | { readonly status: JobStorageCapabilityStatus.Unsupported | JobStorageCapabilityStatus.Unknown }
  | {
      readonly status: JobStorageCapabilityStatus.Verified;
      readonly identity: JobStorageIdentity;
      readonly settlementRevision: number;
      readonly source: SourceRecoveryCoverage;
      readonly outputManifestSha256: string;
      readonly evidenceManifestSha256: string;
      readonly independentDestinationId: string;
      readonly readbackReceiptSha256: string;
    };
export type JobStorageDrainVerification =
  | { readonly status: JobStorageCapabilityStatus.Unsupported | JobStorageCapabilityStatus.Unknown }
  | {
      readonly status: JobStorageCapabilityStatus.Verified;
      readonly identity: JobStorageIdentity;
      readonly settlementRevision: number;
      readonly nativeFenceSha256: string;
    };

export function sameJobStorageIdentity(a: JobStorageIdentity, b: JobStorageIdentity): boolean {
  return a.jobId === b.jobId && a.generationId === b.generationId && a.receiptSha256 === b.receiptSha256;
}
export function assertJobStorageIntent(intent: JobStorageIntent): void {
  if (!intent || (intent.kind !== JobStorageIntentKind.NoResume && intent.kind !== JobStorageIntentKind.Continuation) ||
      (intent.kind === JobStorageIntentKind.NoResume && ("sessionId" in intent || intent.homeStateRequirement !== JobStorageHomeStateRequirement.NoneRequired)) ||
      (intent.kind === JobStorageIntentKind.Continuation &&
        (typeof intent.sessionId !== "string" || !intent.sessionId.trim() || intent.sessionId !== intent.sessionId.trim()))) {
    throw new Error("job_storage_intent_invalid");
  }
}
export function assertJobStorageIdentity(identity: JobStorageIdentity): void {
  if (![identity.jobId, identity.generationId].every(value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)) ||
      !/^[a-f0-9]{64}$/.test(identity.receiptSha256)) throw new Error("job_storage_identity_invalid");
}
export function completeSourceRecoveryCoverage(source: SourceRecoveryCoverage): boolean {
  return /^[a-f0-9]{64}$/.test(source.sourceManifestSha256) && /^[a-f0-9]{64}$/.test(source.inventorySha256) &&
    Object.values(SourceRecoveryFacet).every(facet => source.facets[facet] === JobStorageCapabilityStatus.Verified);
}
