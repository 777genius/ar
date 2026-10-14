import type { DependencyTreeIdentity, DependencyWorkspaceIdentity } from "./dependency-receipt";

export enum DependencyConsumerState {
  Idle = "idle", Pending = "pending", Running = "running",
  ExclusiveMutation = "exclusive_mutation", Unknown = "unknown",
}
// No timestamps/PIDs/jobId takeover. Only fenced, authenticated admission can change live ownership.
export type DependencyConsumerObservation =
  | { readonly state: DependencyConsumerState.Idle }
  | { readonly state: DependencyConsumerState.Pending; readonly attemptId: string }
  | { readonly state: DependencyConsumerState.Running | DependencyConsumerState.ExclusiveMutation;
      readonly attemptId: string; readonly fence: number; readonly ownershipEvidenceId: string }
  | { readonly state: DependencyConsumerState.Unknown };

export enum DependencyTreeObservationState { Present = "present", Absent = "absent", Unknown = "unknown" }
export enum DependencyTreeSafety { Safe = "safe", RequiresPreservation = "requires_preservation" }
export enum DependencyAbsenceKind { KnownFresh = "known_fresh", ObservedMissing = "observed_missing" }
export type DependencyTreeObservation =
  | { readonly state: DependencyTreeObservationState.Present; readonly tree: DependencyTreeIdentity;
      readonly safety: DependencyTreeSafety; readonly availableCapabilities: readonly string[] }
  | { readonly state: DependencyTreeObservationState.Absent; readonly absence: DependencyAbsenceKind }
  | { readonly state: DependencyTreeObservationState.Unknown };

export type DependencyInspectionInput = {
  readonly workspace: DependencyWorkspaceIdentity;
  readonly coverageRevision: string;
  readonly currentInstallKey: string;
  // Supplied by the trusted needs-deps profile, never inferred from package names/JS vs TS.
  readonly requiredCapabilities: readonly string[];
  readonly consumer: DependencyConsumerObservation;
  readonly tree: DependencyTreeObservation;
  // null means no protected receipt; malformed/unresolved receipts never become legacy reuse.
  readonly receipt: unknown;
};

export enum DependencyInspectionOutcome {
  Reused = "reused", UnverifiedReuse = "unverified_reuse", NeedsInstall = "needs_install",
  Busy = "busy", Unknown = "unknown", Conflict = "conflict", RequiresPreservation = "requires_preservation",
}
export enum DependencyInspectionReason {
  ReadyIdentityMatched = "ready_identity_matched", BaselineMissing = "baseline_missing",
  TreeChanged = "tree_changed", InputsChanged = "inputs_changed", CoverageChanged = "coverage_changed",
  FreshAbsence = "fresh_absence", CommittedAbsence = "committed_absence", UnprovenAbsence = "unproven_absence",
  ActiveOwner = "active_owner", UnknownConsumer = "unknown_consumer", UnresolvedOperation = "unresolved_operation",
  InvalidReceipt = "invalid_receipt", WorkspaceChanged = "workspace_changed", UnexpectedTree = "unexpected_tree",
  ReceiptTreeMissing = "receipt_tree_missing", UnsafeTree = "unsafe_tree",
  MissingCapabilities = "missing_capabilities", UnknownTree = "unknown_tree",
}

// A read-only decision, never an admission/eviction token or proof of unchanged content.
export type DependencyInspectionDecision = {
  readonly outcome: DependencyInspectionOutcome;
  readonly reason: DependencyInspectionReason;
};
