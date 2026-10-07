import type { DependencyInstallProfile } from "../domain/dependency-install-key";
import type { DependencyLogicalSourceLink } from "../domain/dependency-tree-manifest";
import type { DependencyInstallProofKind, DependencyProofBinding, DependencyReceipt, DependencyReceiptState } from "../domain/dependency-receipt";

export type DependencySourceDirectoryPin = {
  readonly path: string; readonly dev: string; readonly ino: string; readonly mode: string; readonly mountId: string;
};
export type DependencySourceBindingRecord = DependencyProofBinding & {
  readonly version: 1; readonly profile: DependencyInstallProfile.TestNpmLocalNoLifecycleV1;
  readonly operationId: string; readonly installerCompletionSha256: string; readonly closureDigest: string;
  readonly sourceLinks: readonly DependencyLogicalSourceLink[];
  readonly directories: readonly DependencySourceDirectoryPin[];
  readonly ancestors: readonly DependencySourceDirectoryPin[];
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
