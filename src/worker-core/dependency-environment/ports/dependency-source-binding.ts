import type { DependencyInstallProfile } from "../domain/dependency-install-key";
import type { DependencyLogicalSourceLink } from "../domain/dependency-tree-manifest";
import type { DependencyInstallProofKind, DependencyProofBinding, DependencyReceipt, DependencyReceiptState, DependencySourceBindingReference } from "../domain/dependency-receipt";

export type DependencySourceDirectoryPin = {
  readonly path: string; readonly dev: string; readonly ino: string; readonly mode: string; readonly mountId: string;
};
export type DependencySourceBindingFields = DependencyProofBinding & {
  readonly profile: DependencyInstallProfile.TestNpmLocalNoLifecycleV1;
  readonly operationId: string; readonly installerCompletionSha256: string; readonly closureDigest: string;
  readonly sourceLinks: readonly DependencyLogicalSourceLink[];
  readonly directories: readonly DependencySourceDirectoryPin[];
  readonly ancestors: readonly DependencySourceDirectoryPin[];
};
// V1 remains an exact legacy/TEST shape, with no hosted-output fallback. A real
// hosted reader requires V2 and its independently issued protected reference.
export type DependencySourceBindingRecordV1 = DependencySourceBindingFields & { readonly version: 1 };
export type DependencySourceBindingOutputBody = DependencySourceBindingFields & { readonly version: 2 };
export type DependencySourceBindingRecordV2 = DependencySourceBindingOutputBody & {
  readonly outputReference: DependencySourceBindingReference;
};
export type DependencySourceBindingRecord = DependencySourceBindingRecordV1 | DependencySourceBindingRecordV2;
export type DependencyLocalOutputEvidence = {
  readonly version: 1; readonly profile: DependencyInstallProfile.TestNpmLocalNoLifecycleV1;
  readonly generation: string; readonly operationId: string; readonly workspace: DependencyProofBinding["workspace"];
  readonly coverageRevision: string; readonly installKey: string; readonly closureDigest: string;
  readonly inputSha256: string; readonly profileSha256: string;
  readonly start: DependencySourceBindingReference; readonly creator: DependencySourceBindingReference;
  readonly completion: DependencySourceBindingReference; readonly terminal: DependencySourceBindingReference;
  readonly tree: DependencyProofBinding["tree"]; readonly manifestVersion: 2; readonly manifestDigest: string;
  readonly manifestPlacementRevision: string; readonly verifiedBindingSha256: string;
};
export type DependencyCompletedLocalReady = Extract<DependencyReceipt, { state: DependencyReceiptState.Ready }> & {
  readonly provenance: Extract<Extract<DependencyReceipt, { state: DependencyReceiptState.Ready }>["provenance"],
    { kind: DependencyInstallProofKind.CompletedLocalInstallV1 }>;
};
// Shape-valid DTOs are not proof. The trusted composition injects a protected
// reader that authenticates the immutable reference and complete Ready chain.
export interface DependencyLocalInstallProofVerifier {
  assertCompletedLocalInstall(receipt: DependencyCompletedLocalReady): void;
}
export interface DependencySourceBindingCompletionVerifier {
  assertInstallerCompletion(record: DependencySourceBindingRecord): void;
}
// The trusted composition independently authenticates immutable output evidence
// under installer custody: generation/workspace/coverage/key/closure/completion,
// actual tree identity, complete manifest digest, derived source links and
// original source/ancestor physical pins.
// Matching caller DTOs or a genuine completion alone cannot implement this port.
export interface DependencySourceBindingOutputVerifier {
  assertVerifiedOutput(record: DependencySourceBindingRecord): void;
}

/** Separate comparison mapping. It makes no candidate installer claim. */
export enum DependencyLegacyLocalSourceBindingKind { LegacyLocalComparedSourceV1 = "legacy_local_compared_source_v1" }
export type DependencyLegacyLocalSourceBindingRecord = {
  readonly version: 1; readonly kind: DependencyLegacyLocalSourceBindingKind.LegacyLocalComparedSourceV1;
  readonly profile: DependencyInstallProfile.TestNpmLocalNoLifecycleV1; readonly operationId: string;
  readonly candidate: DependencyProofBinding;
  readonly original: { readonly receipt: Extract<DependencyReceipt, { state: DependencyReceiptState.Unverified }>;
    readonly reference: DependencySourceBindingReference };
  readonly referenceOutput: DependencySourceBindingReference; readonly closureDigest: string;
  readonly sourceLinks: readonly DependencyLogicalSourceLink[];
  readonly directories: readonly DependencySourceDirectoryPin[]; readonly ancestors: readonly DependencySourceDirectoryPin[];
};
export type DependencyLegacyComparedReady = Extract<DependencyReceipt, { state: DependencyReceiptState.Ready }> & {
  readonly provenance: Extract<Extract<DependencyReceipt, { state: DependencyReceiptState.Ready }>["provenance"],
    { kind: DependencyInstallProofKind.LegacyCompared }>;
};
/** Immutable history only. The implementation must authenticate comparison,
 * original predecessor, actual completed reference output and this mapping. */
export type DependencyLegacyLocalDetachedTarget = { readonly workspace: DependencyProofBinding["workspace"];
  readonly name: string; readonly reference: DependencySourceBindingReference };
export interface DependencyLegacyLocalSourceVerifier {
  assertReferenceOutput(record: DependencyLegacyLocalSourceBindingRecord): void;
  assertDetachedTarget?(receipt: DependencyLegacyComparedReady, record: DependencyLegacyLocalSourceBindingRecord, target: DependencyLegacyLocalDetachedTarget): void;
  assertComparedSource(receipt: DependencyLegacyComparedReady, record: DependencyLegacyLocalSourceBindingRecord,
    reference: DependencySourceBindingReference): void;
}
