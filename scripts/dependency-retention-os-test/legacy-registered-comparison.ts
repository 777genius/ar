/** Native TEST bridge, not a launcher or fixture authority. Caller must already
 * have registered a NEW distinct TEST pair with the original enrollment issuer
 * and genuine ordinary births/current native profile. CLOSED registration alone
 * will be refused by the original producer. Never call this on the real25. */
import assert from "node:assert/strict";
import { lstatSync } from "node:fs";
import { HostedInstallationActivationStore } from "../../dist/worker-codex/hosted-installation-activation.js";
import { HostedLegacyComparisonOutcome } from "../../dist/worker-codex/hosted-dependency-legacy-comparison.js";
import { assertHostedDependencyPhysicalWorkspace, hostedDependencyJobRoot, readHostedDependencyBinding,
  HostedDependencyReferenceKind } from "../../dist/provider-codex/app-server/adapters/hosted-dependency-workspace.js";
import { withHostedActivationFence } from "../../dist/provider-codex/app-server/adapters/hosted-process-activation.js";
import { readHostedDependencyEstablishedReceipt } from "../../dist/worker-codex/hosted-dependency-receipts.js";
import { assertHostedDependencyLegacyComparedReady } from "../../dist/worker-codex/hosted-dependency-legacy-comparison-record.js";
import { DependencyInstallProofKind, DependencyReceiptState } from "../../dist/worker-core/index.js";
import { DependencyTreeObservationStatus as Observed } from "../../dist/worker-core/dependency-environment/domain/dependency-tree-manifest.js";
import { captureDependencyPhysicalTreeExposure, assertDependencySourceExposureCurrent, closeDependencySourceExposure }
  from "../../dist/worker-local/dependency-environment/observe-dependency-tree.js";

export enum LegacyRegisteredExpectation { Compared = "compared", PreservedMismatch = "preserved_mismatch" }
import { hostedDependencyObservationLimits as limits } from "../../dist/worker-codex/hosted-dependency-materialization.js";
function ownTest(jobId: string): void {
  assert.equal(process.platform, "linux"); assert.equal(process.getuid!(), 0); assert.equal(process.geteuid!(), 0);
  assert(/^TEST-os-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.exec(jobId)?.[0] === jobId);
  const root = hostedDependencyJobRoot(jobId);
  for (const path of [root, root + "/workspace"]) {
    const stat = lstatSync(path);
    assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === 0 && stat.gid === 0 && !(stat.mode & 0o077));
  }
}

/** EXACT original producer consumes the genuine reference install. No npm call,
 * copied tree, injected Complete result, permission callback or receipt writer.
 * This bridge does not enroll/activate jobs and has no retry loop. */
export async function assertRegisteredLegacyComparison(candidateJobId: string, referenceJobId: string,
  expectation: LegacyRegisteredExpectation) {
  ownTest(candidateJobId); ownTest(referenceJobId); assert.notEqual(candidateJobId, referenceJobId);
  assert(expectation === LegacyRegisteredExpectation.Compared || expectation === LegacyRegisteredExpectation.PreservedMismatch);
  const selected = withHostedActivationFence(() => {
    const candidate = readHostedDependencyBinding(candidateJobId), reference = readHostedDependencyBinding(referenceJobId);
    assert(candidate && candidate.version === 2); assert(reference && reference.version === 3);
    assert.equal(reference.reference.kind, HostedDependencyReferenceKind.LegacyLocalNoLifecycleV1);
    assertHostedDependencyPhysicalWorkspace(candidate); assertHostedDependencyPhysicalWorkspace(reference);
    assert.notEqual(candidate.workspace.canonicalPath, reference.workspace.canonicalPath);
    assert(candidate.workspace.dev !== reference.workspace.dev || candidate.workspace.ino !== reference.workspace.ino);
    const prior = readHostedDependencyEstablishedReceipt(candidate);
    // Test a NEW legacy precursor; AlreadyReady cannot bypass the independent install.
    assert(!prior || prior.state === DependencyReceiptState.Unverified);
    const tree = lstatSync(candidate.workspace.canonicalPath + "/node_modules", { bigint: true });
    assert(tree.isDirectory() && !tree.isSymbolicLink());
    return { candidate, expectedRevision: prior?.revision ?? null, tree: { dev: String(tree.dev), ino: String(tree.ino) } };
  });
  const capture = await captureDependencyPhysicalTreeExposure({ workspace: selected.candidate.workspace, expectedTree: selected.tree, limits });
  assert.equal(capture.status, Observed.Complete);
  if (capture.status !== Observed.Complete) throw new Error("TEST_legacy_original_physical_capture_incomplete");
  try {
    assertDependencySourceExposureCurrent(capture.exposure);
    const result = await new HostedInstallationActivationStore().compareLegacyDependency({ candidateJobId, referenceJobId,
      expectedRevision: selected.expectedRevision });
    // Retain the pre-install physical baseline; the test never resets it to current bytes.
    assertDependencySourceExposureCurrent(capture.exposure);
    return withHostedActivationFence(() => {
      const current = readHostedDependencyBinding(candidateJobId); assert(current && current.version === 2);
      assertHostedDependencyPhysicalWorkspace(current); assert.deepEqual(current.workspace, selected.candidate.workspace);
      const receipt = readHostedDependencyEstablishedReceipt(current);
      if (expectation === LegacyRegisteredExpectation.PreservedMismatch) {
        assert.equal(result.outcome, HostedLegacyComparisonOutcome.Mismatch);
        assert(receipt && receipt.state === DependencyReceiptState.Unverified);
        assert.deepEqual(receipt.tree, selected.tree);
        return { outcome: LegacyRegisteredExpectation.PreservedMismatch, candidatePreserved: true, legacyComparedPublished: false } as const;
      }
      assert.equal(result.outcome, HostedLegacyComparisonOutcome.Compared);
      assert(receipt && receipt.state === DependencyReceiptState.Ready && receipt.provenance.kind === DependencyInstallProofKind.LegacyCompared);
      const actual = assertHostedDependencyLegacyComparedReady({ ...receipt, provenance: receipt.provenance });
      assert.equal(actual.version, 2); assert.deepEqual(receipt.tree, selected.tree);
      return { outcome: LegacyRegisteredExpectation.Compared, candidatePreserved: true,
        legacyComparedPublished: true, comparisonVersion: actual.version, readyRevision: receipt.revision,
        referenceInstallation:{start:actual.reference.start,completion:actual.reference.completion,terminal:actual.reference.terminal,output:actual.reference.output} } as const;
    });
  } finally { closeDependencySourceExposure(capture.exposure); }
}
