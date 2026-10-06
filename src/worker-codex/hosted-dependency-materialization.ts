import { lstatSync, type BigIntStats } from "node:fs";
import { dirname } from "node:path";
import { DependencyAdmissionError, DependencyAdmissionFailure as Failure, DependencyInstallProofKind, DependencyReceiptState,
  DependencyTreeObservationStatus, sameDependencyTree,
  sameDependencyAttempt, type DependencyAttempt, type DependencyReceipt } from "@vioxen/subscription-runtime/worker-core";
import type { HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { withHostedActivationFence } from "@vioxen/subscription-runtime/provider-codex";
import { openHostedDependencyManifestPlacement } from "./hosted-dependency-manifest-placement";
import { observeDependencyTree, observeDependencyTreeWithPhysicalExposure, assertDependencySourceExposureCurrent, assertDependencyLocalRegistrySelectionAbsent, closeDependencySourceExposure, type DependencySourceExposure } from "../worker-local/dependency-environment/observe-dependency-tree";
import { readHostedDependencyBinding, type HostedDependencyBinding } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { readHostedPrivateBytes } from "./hosted-readonly-inputs";
import { HostedDependencyInstaller, assertHostedDependencyInstallerAttemptDrained } from "./hosted-dependency-installer";
import { hostedDependencyInstallerRoot } from "./hosted-dependency-installer-recipe";
import { qualifyHostedDependencyInstallerInputs } from "./hosted-dependency-installer-inputs";
import { normalizeCapturedDependencyOutput, publishCapturedDependencyOutput } from "./hosted-dependency-staged-output";
import { closeDependencySourceLinkSession, type DependencySourceLinkSession } from "../worker-local/dependency-environment/dependency-source-binding";
import { dependencyCoverageRevision, publishHostedDependencyReceipt, readHostedDependencyCommittedReady } from "./hosted-dependency-receipts";
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

/** Existing reference/generic callers never retain a cold qualification session. */
export async function materializeHostedDependencyAbsence(binding: HostedDependencyBinding, attempt: DependencyAttempt): Promise<void> {
  closeHostedDependencyColdHandoff(await materializeHostedDependencyAbsenceForToolEntry(binding, attempt));
}
/** Only this genuine closed install flow can mint the private same-attempt handoff. */
export async function materializeHostedDependencyAbsenceForToolEntry(binding: HostedDependencyBinding, attempt: DependencyAttempt): Promise<HostedDependencyColdHandoff | undefined> {
  const prepared = await materializeHostedDependencyLocalAbsence(binding, attempt);
  if (prepared.cold) {
    const { ready, observed, source, exposure } = prepared.cold;
    try { return retainCold(binding, attempt, prepared.inputs, ready, observed, source, exposure); }
    catch (error) { closeDependencySourceExposure(exposure); closeDependencySourceLinkSession(source); throw error; }
  }
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
  const final = await observeDependencyTreeWithPhysicalExposure({ workspacePath: binding.workspace.canonicalPath, treeName: "node_modules",
    expectedWorkspace: binding.workspace, expectedTree: normalized.tree, limits: hostedDependencyObservationLimits });
  let ownedFinalExposure = final.status === DependencyTreeObservationStatus.Complete ? final.exposure : undefined;
  try {
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
  if (!final.exposure) return undefined; // Optional retention bounds preserve the original fourth scan.
  const handoff = retainCold(binding, attempt, inputs, ready, final, undefined, final.exposure);
  ownedFinalExposure = undefined; return handoff;
  } finally { if (ownedFinalExposure) closeDependencySourceExposure(ownedFinalExposure); }
}


type Ready = Extract<DependencyReceipt, { state: DependencyReceiptState.Ready }>;
type FinalObservation = Extract<Awaited<ReturnType<typeof observeDependencyTree>>, { status: DependencyTreeObservationStatus.Complete }>;
/** Label copies and serialized DTOs have no authority: only publisher WeakMap. */
export type HostedDependencyColdHandoff = Readonly<{ startId: string }>;
type ColdState = {
  binding: HostedDependencyBinding; attempt: DependencyAttempt; inputs: HostedDependencyKeyInputs; ready: Ready;
  reference: ReturnType<typeof readHostedDependencyCommittedReady>["reference"]; observed: FinalObservation;
  installerMapping: Buffer; consumed: boolean;
  source?: DependencySourceLinkSession; exposure?: DependencySourceExposure;
};
const cold = new WeakMap<HostedDependencyColdHandoff, ColdState>();
function installerMapping(attempt: DependencyAttempt): Buffer {
  const path = `${hostedDependencyInstallerRoot}/attempt-${attempt.attemptId}.json`, bytes = readHostedPrivateBytes(path, 4096);
  if (!bytes) fail();
  const row = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as { startId?: unknown };
  if (typeof row.startId !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(row.startId) ||
      !bytes.equals(encode({ schemaVersion: 1, startId: row.startId, unit: `subscription-runtime-installer-${row.startId}.service`, attempt }))) fail();
  // Positive mapping closes the general drainer's intentional missing-map case.
  assertHostedDependencyInstallerAttemptDrained(attempt);
  if (!readHostedPrivateBytes(path, 4096)?.equals(bytes)) fail();
  return bytes;
}
function retainCold(binding: HostedDependencyBinding, attempt: DependencyAttempt, inputs: HostedDependencyKeyInputs,
  ready: Ready, observed: FinalObservation, source?: DependencySourceLinkSession, exposure?: DependencySourceExposure): HostedDependencyColdHandoff {
  const { committed, mapping } = withHostedActivationFence(fence => {
    assertOwnerUnderFence(fence, binding, attempt); assertHostedDependencyKeyInputsCurrent(binding, inputs);
    if (!encode(readHostedDependencyBinding(binding.jobId)).equals(encode(binding))) fail();
    const committed = readHostedDependencyCommittedReady(binding, ready.revision);
    if (ready.generation !== attempt.attemptId || !encode(ready.treeMeasurement).equals(encode(observed.measurement)) ||
        !encode(committed.receipt).equals(encode(ready)) || !matchesHostedDependencyReady(binding, ready, inputs) ||
        observed.digest !== ready.manifestDigest || !sameDependencyTree(observed.tree, ready.tree)) fail();
    if (!exposure) fail(Failure.UnsafeTree);
    if (source) assertDependencyLocalRegistrySelectionAbsent(exposure, source, binding.workspace, ready.tree);
    else assertDependencySourceExposureCurrent(exposure);
    return { committed, mapping: installerMapping(attempt) };
  });
  const handoff = Object.freeze({ startId: attempt.launch.startId });
  cold.set(handoff, { binding, attempt, inputs, ready, reference: committed.reference, observed, installerMapping: mapping, consumed: false, ...(source ? { source } : {}), ...(exposure ? { exposure } : {}) });
  return handoff;
}
/** One consumption; fresh protected reference and current exclusion must join.
 * Refusal never downgrades to an unproven scan shortcut or releases owner. */
export function consumeHostedDependencyColdHandoff(handoff: HostedDependencyColdHandoff, binding: HostedDependencyBinding,
  attempt: DependencyAttempt, inputs: HostedDependencyKeyInputs, ready: Ready): Pick<ColdState, "observed" | "source" | "exposure" | "reference"> {
  const state = cold.get(handoff); if (!state || state.consumed) fail(Failure.StaleAttempt);
  try {
    withHostedActivationFence(fence => {
      assertOwnerUnderFence(fence, binding, attempt);
      if (!installerMapping(attempt).equals(state.installerMapping)) fail(Failure.StaleAttempt);
      if (!sameDependencyAttempt(state.attempt, attempt) || !encode(readHostedDependencyBinding(binding.jobId)).equals(encode(binding)) || !encode(state.binding).equals(encode(binding)) ||
          !encode(state.ready).equals(encode(ready)) || !sameHostedDependencyKeyInputs(state.inputs, inputs) ||
          !encode(readHostedDependencyCommittedReady(binding, ready.revision).reference).equals(encode(state.reference))) fail(Failure.StaleAttempt);
      assertHostedDependencyKeyInputsCurrent(binding, state.inputs);
      if (!matchesHostedDependencyReady(binding, ready, inputs)) fail(Failure.UnsafeTree);
      if (!state.exposure) fail(Failure.UnsafeTree);
      if (state.source) assertDependencyLocalRegistrySelectionAbsent(state.exposure, state.source, binding.workspace, ready.tree);
      else assertDependencySourceExposureCurrent(state.exposure);
    });
    state.consumed = true;
    return { observed: state.observed, reference: state.reference, ...(state.source ? { source: state.source } : {}), ...(state.exposure ? { exposure: state.exposure } : {}) };
  } catch (error) { closeHostedDependencyColdHandoff(handoff); throw error; }
}
/** Rejoin the same consumed relation after qualifier awaits, before publication. */
export function assertHostedDependencyConsumedColdHandoff(handoff: HostedDependencyColdHandoff, fence: HostedActivationFence): void {
  const state = cold.get(handoff); if (!state?.consumed) fail(Failure.StaleAttempt);
  assertOwnerUnderFence(fence, state.binding, state.attempt);
  if (!installerMapping(state.attempt).equals(state.installerMapping) ||
      !encode(readHostedDependencyCommittedReady(state.binding, state.ready.revision).reference).equals(encode(state.reference))) fail(Failure.StaleAttempt);
}
export function closeHostedDependencyColdHandoff(handoff: HostedDependencyColdHandoff | undefined): void {
  if (!handoff) return;
  const state = cold.get(handoff); if (!state) return;
  cold.delete(handoff);
  if (state.consumed) return; // Qualifier owns and closes the transferred logical resources.
  if (state.exposure) closeDependencySourceExposure(state.exposure);
  if (state.source) closeDependencySourceLinkSession(state.source);
}
