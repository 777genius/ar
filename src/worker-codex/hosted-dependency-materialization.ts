import { createHash } from "node:crypto";
import { lstatSync, type BigIntStats } from "node:fs";
import { dirname } from "node:path";
import { DependencyAdmissionError, DependencyAdmissionFailure as Failure, DependencyInstallProofKind,
  DependencyPreservationKind, DependencyReceiptState,
  DependencyTreeObservationStatus, sameDependencyTree, sameDependencyAttempt,
  type DependencyAttempt, type DependencyReceipt } from "@vioxen/subscription-runtime/worker-core";
import { withHostedActivationFence } from "@vioxen/subscription-runtime/provider-codex";
import { readHostedOrdinaryProcessOrigin, type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { DependencyOwnerPhase } from "@vioxen/subscription-runtime/worker-core";
import { openHostedDependencyManifestPlacement } from "./hosted-dependency-manifest-placement";
import { buildTestNpmDependencyInstallKey } from "../worker-local/dependency-environment/build-test-npm-dependency-install-key";
import { captureNpmInstallInputs, revalidateNpmInstallInputs, NpmInputCaptureStatus,
  type NpmInputRevalidation, type QualifiedNpmInstallInputs } from "../worker-local/dependency-environment/capture-npm-install-inputs";
import { observeDependencyTree } from "../worker-local/dependency-environment/observe-dependency-tree";
import { readHostedDependencyAttempt, type HostedDependencyBinding } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { readHostedPrivateBytes } from "./hosted-readonly-inputs";
import { HostedDependencyInstaller, assertHostedDependencyInstallerAttemptDrained } from "./hosted-dependency-installer";
import { qualifyHostedDependencyInstallerInputs } from "./hosted-dependency-installer-inputs";
import { readHostedDependencyInstallerProfile } from "./hosted-dependency-installer-recipe";
import { normalizeCapturedDependencyOutput, publishCapturedDependencyOutput } from "./hosted-dependency-staged-output";
import { dependencyCoverageRevision, readHostedDependencyReceipt, publishHostedDependencyReceipt,
  readHostedDependencyCommittedAbsent } from "./hosted-dependency-receipts";
export { dependencyCoverageRevision, readHostedDependencyReceipt } from "./hosted-dependency-receipts";

export const hostedDependencyObservationLimits = { maxEntries: 100000, maxTotalBytes: 2 * 1024 * 1024 * 1024,
  maxManifestBytes: 32 * 1024 * 1024, maxDurationMs: 30000 } as const;
const root = "/var/lib/subscription-runtime-host-policy";
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const encode = (value: unknown): Buffer => Buffer.from(JSON.stringify(value) + "\n");
function fail(reason = Failure.Unsupported): never { throw new DependencyAdmissionError(reason); }
function assertOwnerUnderFence(fence: HostedActivationFence, binding: HostedDependencyBinding, attempt: DependencyAttempt): void {
  const origin = readHostedOrdinaryProcessOrigin(fence);
  const held = readHostedDependencyAttempt(binding, origin.start, String(origin.reservation.startId), DependencyOwnerPhase.ExclusiveMutation);
  if (!sameDependencyAttempt(held, attempt)) fail(Failure.StaleAttempt);
  if (origin.start.workspacePath !== binding.workspace.canonicalPath) fail();
}
function assertOwner(binding: HostedDependencyBinding, attempt: DependencyAttempt): void {
  withHostedActivationFence(fence => assertOwnerUnderFence(fence, binding, attempt));
}
function identity(stat: BigIntStats) { return { dev: String(stat.dev), ino: String(stat.ino) }; }
export class HostedDependencyInputCaptureError extends DependencyAdmissionError {
  constructor(readonly captureFailure: Exclude<NpmInputRevalidation, { status: NpmInputCaptureStatus.Qualified }>) {
    super(Failure.Unsupported);
  }
}
function capturedKey(capture: QualifiedNpmInstallInputs) {
  const { schemaVersion: _version, networkInputs: _networkInputs, privilegeDropper: _privilegeDropper,
    recipeRevision: _recipeRevision, ...toolchain } = readHostedDependencyInstallerProfile();
  return buildTestNpmDependencyInstallKey({ packageBytes: capture.packageBytes, lockBytes: capture.lockBytes, lockName: capture.lockName,
    toolchain, maxInputBytes: 16 * 1024 * 1024, maxCanonicalBytes: 128 * 1024 });
}
export async function readHostedDependencyKeyInputs(binding: HostedDependencyBinding) {
  const capture = await captureNpmInstallInputs({ workspacePath: binding.workspace.canonicalPath, expectedWorkspace: binding.workspace,
    maxInputBytes: 16 * 1024 * 1024, maxDurationMs: 30000 });
  if (capture.status !== NpmInputCaptureStatus.Qualified) throw new HostedDependencyInputCaptureError(capture);
  if (capture.packageBytes.length > 8 * 1024 * 1024 || capture.lockBytes.length > 8 * 1024 * 1024) fail();
  return { capture, lockName: capture.lockName, packageBytes: Buffer.from(capture.packageBytes), lockBytes: Buffer.from(capture.lockBytes),
    key: capturedKey(capture) };
}
export type HostedDependencyKeyInputs = Awaited<ReturnType<typeof readHostedDependencyKeyInputs>>;
/** Required under the caller's actual final host fence, not a nominal callback. */
export function assertHostedDependencyKeyInputsCurrent(binding: HostedDependencyBinding, inputs: HostedDependencyKeyInputs): void {
  if (inputs.capture.workspace.canonicalPath !== binding.workspace.canonicalPath ||
      !sameDependencyTree(inputs.capture.workspace, binding.workspace)) fail();
  const current = revalidateNpmInstallInputs({ capture: inputs.capture, maxDurationMs: 30000 });
  if (current.status !== NpmInputCaptureStatus.Qualified) throw new HostedDependencyInputCaptureError(current);
  if (capturedKey(inputs.capture).installKey !== inputs.key.installKey) fail();
}
export function sameHostedDependencyKeyInputs(before: HostedDependencyKeyInputs, after: HostedDependencyKeyInputs): boolean {
  return before.key.installKey === after.key.installKey && before.capture.closureDigest === after.capture.closureDigest &&
    before.lockName === after.lockName && JSON.stringify(before.capture.packageFile) === JSON.stringify(after.capture.packageFile) &&
    JSON.stringify(before.capture.lockFile) === JSON.stringify(after.capture.lockFile);
}

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
  assertOwner(binding, attempt);
  const previous = readHostedDependencyReceipt(binding);
  const absence = previous ? null : readHostedPrivateBytes(`${root}/dependency-fresh-absence/${binding.workspace.dev}-${binding.workspace.ino}.json`, 4096);
  const expectedAbsence = encode({ version: 1, workspace: binding.workspace, coverageRevision: dependencyCoverageRevision(binding) });
  if (previous ? previous.state !== DependencyReceiptState.Absent : !absence?.equals(expectedAbsence)) fail();
  const committed = previous ? readHostedDependencyCommittedAbsent(binding, previous.revision) : null;
  const inputs = await readHostedDependencyKeyInputs(binding), generation = attempt.attemptId;
  const base = { version: 1 as const, revision: (previous?.revision ?? 0) + 1, generation, workspace: binding.workspace, coverageRevision: dependencyCoverageRevision(binding) };
  const installing: DependencyReceipt = { ...base, state: DependencyReceiptState.Installing, operationId: generation,
    requestedKey: inputs.key.installKey, preservation: committed ? { kind: DependencyPreservationKind.CommittedAbsence,
      generation, workspace: binding.workspace, coverageRevision: base.coverageRevision, operationId: generation,
      prior: { generation: committed.receipt.generation, revision: committed.receipt.revision, operationId: committed.receipt.operationId,
        installKey: committed.receipt.installKey, tree: committed.receipt.evictionCommit.tree,
        manifestDigest: committed.receipt.evictionCommit.manifestDigest, commitEvidenceId: committed.receipt.evictionCommit.commitEvidenceId,
        receipt: committed.reference } } : { kind: DependencyPreservationKind.KnownFreshAbsence,
      generation, workspace: binding.workspace, coverageRevision: base.coverageRevision, operationId: generation,
      absenceEvidenceId: hash(absence ?? fail()) } };
  withHostedActivationFence(fence => {
    assertOwnerUnderFence(fence, binding, attempt);
    assertHostedDependencyKeyInputsCurrent(binding, inputs);
    try { lstatSync(binding.workspace.canonicalPath + "/node_modules"); fail(); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    publishHostedDependencyReceipt(binding, previous?.revision ?? null, installing);
  });
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
