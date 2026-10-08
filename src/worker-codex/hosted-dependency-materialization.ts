import { lstatSync, type BigIntStats } from "node:fs";
import { dirname } from "node:path";
import { DependencyAdmissionError, DependencyAdmissionFailure as Failure, DependencyInstallProofKind, DependencyReceiptState,
  DependencyTreeObservationStatus, sameDependencyTree,
  type DependencyAttempt, type DependencyReceipt } from "@vioxen/subscription-runtime/worker-core";
import { withHostedActivationFence } from "@vioxen/subscription-runtime/provider-codex";
import { openHostedDependencyManifestPlacement } from "./hosted-dependency-manifest-placement";
import { observeDependencyTree } from "../worker-local/dependency-environment/observe-dependency-tree";
import type { HostedDependencyBinding } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { readHostedPrivateBytes } from "./hosted-readonly-inputs";
import { HostedDependencyInstaller, assertHostedDependencyInstallerAttemptDrained } from "./hosted-dependency-installer";
import { qualifyHostedDependencyInstallerInputs } from "./hosted-dependency-installer-inputs";
import { normalizeCapturedDependencyOutput, publishCapturedDependencyOutput } from "./hosted-dependency-staged-output";
import { dependencyCoverageRevision, publishHostedDependencyReceipt } from "./hosted-dependency-receipts";
export { dependencyCoverageRevision, readHostedDependencyReceipt } from "./hosted-dependency-receipts";
import { assertHostedDependencyMaterializationOwner as assertOwner, assertHostedDependencyMaterializationOwnerUnderFence as assertOwnerUnderFence,
  hostedDependencyObservationLimits, readHostedDependencyKeyInputs, assertHostedDependencyKeyInputsCurrent,
  sameHostedDependencyKeyInputs, type HostedDependencyKeyInputs } from "./hosted-dependency-materialization-context";
import { materializeHostedDependencyLocalAbsence } from "./hosted-dependency-local-materialization";
export { hostedDependencyObservationLimits, HostedDependencyInputCaptureError, readHostedDependencyKeyInputs,
  assertHostedDependencyKeyInputsCurrent, sameHostedDependencyKeyInputs, type HostedDependencyKeyInputs } from "./hosted-dependency-materialization-context";
const root = "/var/lib/subscription-runtime-host-policy";
const encode = (value: unknown): Buffer => Buffer.from(JSON.stringify(value) + "\n");
function fail(reason = Failure.Unsupported): never { throw new DependencyAdmissionError(reason); }
function identity(stat: BigIntStats) { return { dev: String(stat.dev), ino: String(stat.ino) }; }

export function hasHostedDependencyFreshAbsence(binding: HostedDependencyBinding): boolean {
  try { lstatSync(`${root}/dependency-fresh-absence`); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; }
  return readHostedPrivateBytes(`${root}/dependency-fresh-absence/${binding.workspace.dev}-${binding.workspace.ino}.json`, 4096)
    ?.equals(encode({ version: 1, workspace: binding.workspace, coverageRevision: dependencyCoverageRevision(binding) })) ?? false;
}

/** Small hot reuse check: actual current input key, physical root and required
 * read/write capabilities. This is reuse, never a whole-tree unchanged proof. */
export function matchesHostedDependencyReady(binding: HostedDependencyBinding, receipt: DependencyReceipt, inputs: HostedDependencyKeyInputs): boolean {
  if (receipt.state !== DependencyReceiptState.Ready) fail();
  const tree = lstatSync(binding.workspace.canonicalPath + "/node_modules", { bigint: true });
  return tree.isDirectory() && sameDependencyTree(identity(tree), receipt.tree) && tree.uid === 0n &&
    (tree.mode & 0o700n) === 0o700n && receipt.installKey === inputs.key.installKey;
}

export async function materializeHostedDependencyAbsence(binding: HostedDependencyBinding, attempt: DependencyAttempt): Promise<void> {
  const prepared = await materializeHostedDependencyLocalAbsence(binding, attempt); if (!prepared) return;
  const { inputs, installing } = prepared, generation = installing.generation;
  const base = { version: installing.version, revision: installing.revision, generation, workspace: installing.workspace, coverageRevision: installing.coverageRevision };
  const expectedInstallerInputs = qualifyHostedDependencyInstallerInputs(Buffer.from(inputs.capture.packageBytes),
    Buffer.from(inputs.capture.lockBytes), inputs.lockName);
  const completed = await new HostedDependencyInstaller().install({ workspace: binding.workspace, attempt,
    lockName: inputs.lockName, packageBytes: inputs.packageBytes, lockBytes: inputs.lockBytes });
  assertOwner(binding, attempt); assertHostedDependencyInstallerAttemptDrained(attempt);
  if (completed.lockName !== inputs.lockName || completed.inputSha256 !== expectedInstallerInputs.sha256) fail();
  const staged = await observeDependencyTree({ workspacePath: dirname(completed.output.canonicalPath), treeName: "node_modules",
    expectedTree: completed.output, limits: hostedDependencyObservationLimits });
  if (staged.status !== DependencyTreeObservationStatus.Complete) fail(Failure.UnsafeTree);
  normalizeCapturedDependencyOutput(staged, 0);
  const normalized = await observeDependencyTree({ workspacePath: staged.workspace.canonicalPath, treeName: "node_modules",
    expectedWorkspace: staged.workspace, expectedTree: staged.tree, limits: hostedDependencyObservationLimits });
  if (normalized.status !== DependencyTreeObservationStatus.Complete || normalized.digest !== staged.digest) fail(Failure.UnsafeTree);
  if (!sameHostedDependencyKeyInputs(inputs, await readHostedDependencyKeyInputs(binding))) fail();
  withHostedActivationFence(fence => {
    assertOwnerUnderFence(fence, binding, attempt);
    assertHostedDependencyInstallerAttemptDrained(attempt);
    assertHostedDependencyKeyInputsCurrent(binding, inputs);
    publishCapturedDependencyOutput(normalized, binding.workspace);
  });
  const final = await observeDependencyTree({ workspacePath: binding.workspace.canonicalPath, treeName: "node_modules",
    expectedWorkspace: binding.workspace, expectedTree: normalized.tree, limits: hostedDependencyObservationLimits });
  if (final.status !== DependencyTreeObservationStatus.Complete || final.digest !== normalized.digest ||
      !sameHostedDependencyKeyInputs(inputs, await readHostedDependencyKeyInputs(binding))) fail(Failure.UnsafeTree);
  const blobs = await openHostedDependencyManifestPlacement();
  try { if (await blobs.put(final.canonicalBytes) !== final.digest) fail(); } finally { await blobs.close(); }
  const proofBinding = { generation, workspace: binding.workspace, coverageRevision: base.coverageRevision,
    installKey: inputs.key.installKey, tree: final.tree, manifestDigest: final.digest };
  const ready: DependencyReceipt = { ...base, revision: base.revision + 1, state: DependencyReceiptState.Ready, ...proofBinding,
    treeMeasurement: final.measurement,
    provenance: { ...proofBinding, kind: DependencyInstallProofKind.CompletedInstall, operationId: generation,
      verificationEvidenceId: final.digest, installerDrainEvidenceId: completed.completionSha256 } };
  withHostedActivationFence(fence => {
    assertOwnerUnderFence(fence, binding, attempt);
    assertHostedDependencyInstallerAttemptDrained(attempt);
    assertHostedDependencyKeyInputsCurrent(binding, inputs);
    if (!matchesHostedDependencyReady(binding, ready, inputs)) fail();
    blobs.assertCurrent(fence);
    publishHostedDependencyReceipt(binding, installing.revision, ready);
  });
}
