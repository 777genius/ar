import type { DependencyTreeIdentity, DependencyWorkspaceIdentity } from "@vioxen/subscription-runtime/core";
export { sameDependencyTree, sameDependencyWorkspace, type DependencyTreeIdentity, type DependencyWorkspaceIdentity } from "@vioxen/subscription-runtime/core";

export enum DependencyReceiptState {
  Unverified = "unverified",
  Installing = "installing",
  Ready = "ready",
  Evicting = "evicting",
  Absent = "absent",
}

export enum DependencyUnverifiedReason {
  BaselineMissing = "baseline_missing",
  TreeChanged = "tree_changed",
  InputsChanged = "inputs_changed",
}


export type DependencyReceiptBase = {
  readonly version: 1;
  readonly revision: number;
  readonly generation: string;
  readonly workspace: DependencyWorkspaceIdentity;
  readonly coverageRevision: string;
};

export type DependencyProofBinding = {
  readonly generation: string;
  readonly workspace: DependencyWorkspaceIdentity;
  readonly coverageRevision: string;
  readonly installKey: string;
  readonly tree: DependencyTreeIdentity;
  readonly manifestDigest: string;
};

export enum DependencyInstallProofKind {
  CompletedInstall = "completed_install",
  CompletedLocalInstallV1 = "completed_local_install_v1",
  LegacyCompared = "legacy_compared",
}

export type DependencySourceBindingReference = {
  readonly path: string; readonly identity: DependencyTreeIdentity; readonly sha256: string;
};

// Evidence IDs refer to authenticated protected records, never worker-written claims.
export type DependencyInstallProof = DependencyProofBinding & (
  | { readonly kind: DependencyInstallProofKind.CompletedInstall; readonly operationId: string;
      readonly verificationEvidenceId: string; readonly installerDrainEvidenceId: string }
  | { readonly kind: DependencyInstallProofKind.CompletedLocalInstallV1; readonly operationId: string;
      readonly verificationEvidenceId: string; readonly installerDrainEvidenceId: string;
      readonly sourceBinding: DependencySourceBindingReference }
  | { readonly kind: DependencyInstallProofKind.LegacyCompared; readonly referenceInstallationId: string;
      readonly comparisonEvidenceId: string }
);

export enum DependencyPreservationKind {
  KnownFreshAbsence = "known_fresh_absence",
  CommittedPreservation = "committed_preservation",
  CommittedAbsence = "committed_absence",
}

export type DependencyPreservationProof = {
  readonly generation: string;
  readonly workspace: DependencyWorkspaceIdentity;
  readonly coverageRevision: string;
  readonly operationId: string;
} & (
  | { readonly kind: DependencyPreservationKind.KnownFreshAbsence; readonly absenceEvidenceId: string }
  | { readonly kind: DependencyPreservationKind.CommittedPreservation;
      readonly originalTree: DependencyTreeIdentity; readonly preservedTree: DependencyTreeIdentity;
      readonly destinationParent: DependencyWorkspaceIdentity; readonly destinationName: string;
      readonly mappingDigest: string; readonly commitEvidenceId: string }
  | { readonly kind: DependencyPreservationKind.CommittedAbsence;
      readonly prior: { readonly generation: string; readonly revision: number; readonly operationId: string;
        readonly installKey: string; readonly tree: DependencyTreeIdentity; readonly manifestDigest: string; readonly commitEvidenceId: string;
        readonly receipt: { readonly path: string; readonly identity: DependencyTreeIdentity; readonly sha256: string } } }
);

export type DependencyTrashIntent = {
  readonly operationId: string;
  readonly originalTree: DependencyTreeIdentity;
  readonly destinationParent: DependencyWorkspaceIdentity;
  readonly destinationName: string;
};

export type DependencyEvictionProof = DependencyProofBinding & {
  readonly operationId: string;
  readonly trash: DependencyTrashIntent;
  readonly commitEvidenceId: string;
};

export type DependencyReceipt = DependencyReceiptBase & (
  | { readonly state: DependencyReceiptState.Unverified; readonly tree: DependencyTreeIdentity;
      readonly reason: DependencyUnverifiedReason }
  | { readonly state: DependencyReceiptState.Installing; readonly operationId: string;
      readonly requestedKey: string; readonly preservation: DependencyPreservationProof }
  | { readonly state: DependencyReceiptState.Ready; readonly installKey: string;
      readonly tree: DependencyTreeIdentity; readonly manifestDigest: string;
      readonly provenance: DependencyInstallProof }
  | { readonly state: DependencyReceiptState.Evicting; readonly operationId: string;
      readonly installKey: string; readonly tree: DependencyTreeIdentity;
      readonly manifestDigest: string; readonly trash: DependencyTrashIntent }
  | { readonly state: DependencyReceiptState.Absent; readonly operationId: string;
      readonly installKey: string; readonly evictionCommit: DependencyEvictionProof }
);
