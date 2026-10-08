import { CurrentHostedDependencyOriginKind, requiresCurrentHostedDependencyRootPurpose, readCurrentHostedDependencyOrigin, assertCurrentHostedDependencyAttempt, assertOriginalHostedDependencyColdProducer, readOriginalHostedDependencyColdSelection, materializeCurrentHostedDependencyColdTree, installCurrentHostedDependencyColdTree,
  consumeCurrentHostedDependencyColdHandoff, assertCurrentHostedDependencyConsumedColdHandoff, closeCurrentHostedDependencyColdHandoff,
  type CurrentHostedDependencyOrigin } from "./hosted-current-dependency-origin";
import { readHostedFdProfile } from "../provider-codex/app-server/adapters/hosted-fd-observation";
import type { HostedDependencyColdResult } from "./hosted-dependency-cold-materialization-state";
import { lstatSync, type BigIntStats } from "node:fs";
import { dirname } from "node:path";
import { DependencyAdmissionError, DependencyAdmissionFailure as Failure, DependencyInstallProofKind, DependencyReceiptState,
  DependencyTreeObservationStatus, DependencyOwnerPhase, sameDependencyTree,
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
export async function materializeHostedDependencyAbsenceForToolEntry(binding: HostedDependencyBinding, attempt: DependencyAttempt,capturedOrigin?:CurrentHostedDependencyOrigin): Promise<HostedDependencyColdHandoff | undefined> {
  const context=capturedOrigin ?? withHostedActivationFence(fence=>readCurrentHostedDependencyOrigin(fence));
  withHostedActivationFence(fence=>{
    const actual=assertCurrentHostedDependencyAttempt(context,fence,DependencyOwnerPhase.ExclusiveMutation);
    if(!sameDependencyAttempt(actual.attempt,attempt) || !encode(actual.binding).equals(encode(binding)))fail(Failure.StaleAttempt);
  });
  if (!requiresCurrentHostedDependencyRootPurpose()) {
    await produceFreshDependencyTree(context);
    return undefined;
  }
  withHostedActivationFence(fence => {
    assertCurrentHostedDependencyAttempt(context, fence, DependencyOwnerPhase.ExclusiveMutation);
    if (!readHostedFdProfile()) fail();
  });
  return materializeCurrentHostedDependencyColdTree(context);
}
/** Fixed physical producer called only by the original-map issuer. The internal
 * symbol is never exported, and successful return cannot register provenance. */
export async function produceOriginalHostedDependencyColdTree(context:CurrentHostedDependencyOrigin,access:symbol):Promise<HostedDependencyColdResult|undefined> {
  withHostedActivationFence(fence => assertOriginalHostedDependencyColdProducer(context, fence, access));
  return produceFreshDependencyTree(context, access);
}
/** A nonselected V1 origin gets a fresh installation, never a retained cold
 * capability. The symbol branch still authenticates through the original map. */
function assertFreshProducer(context: CurrentHostedDependencyOrigin, fence: HostedActivationFence, access?: symbol) {
  if (access !== undefined) return assertOriginalHostedDependencyColdProducer(context, fence, access);
  const actual = assertCurrentHostedDependencyAttempt(context, fence, DependencyOwnerPhase.ExclusiveMutation);
  if (actual.facts.kind !== CurrentHostedDependencyOriginKind.Ordinary || actual.binding.version !== 1) fail();
  assertOwnerUnderFence(fence, actual.binding, actual.attempt, context);
  return actual;
}
async function produceFreshDependencyTree(context: CurrentHostedDependencyOrigin, access?: symbol): Promise<HostedDependencyColdResult | undefined> {
  const { binding, attempt } = withHostedActivationFence(fence => assertFreshProducer(context, fence, access));
  const prepared = await materializeHostedDependencyLocalAbsence(binding, attempt, access === undefined ? undefined : context, access);
  if (prepared.cold) {
    const { ready, observed, source, exposure } = prepared.cold;
    if (access === undefined) {
      try {
        withHostedActivationFence(fence => {
          assertFreshProducer(context, fence);
          assertHostedDependencyKeyInputsCurrent(binding, prepared.inputs);
          if (!matchesHostedDependencyReady(binding, ready, prepared.inputs)) fail();
        });
        return undefined;
      } finally { closeDependencySourceExposure(exposure); closeDependencySourceLinkSession(source); }
    }
    try { return retainPhysicalCold(binding, attempt, prepared.inputs, ready, observed, source, exposure,context,access); }
    catch (error) { closeDependencySourceExposure(exposure); closeDependencySourceLinkSession(source); throw error; }
  }
  const { inputs, installing } = prepared, generation = installing.generation;
  const base = { version: installing.version, revision: installing.revision, generation, workspace: installing.workspace, coverageRevision: installing.coverageRevision };
  const expectedInstallerInputs = qualifyHostedDependencyInstallerInputs(Buffer.from(inputs.capture.packageBytes),
    Buffer.from(inputs.capture.lockBytes), inputs.lockName);
  const completed = access === undefined ? await new HostedDependencyInstaller().install({
    workspace: binding.workspace, attempt, lockName: inputs.lockName,
    packageBytes: Buffer.from(inputs.capture.packageBytes), lockBytes: Buffer.from(inputs.capture.lockBytes),
  }) : await installCurrentHostedDependencyColdTree(context, access);
  assertOwner(binding, attempt,context); assertHostedDependencyInstallerAttemptDrained(attempt);
  if (completed.lockName !== inputs.lockName || completed.inputSha256 !== expectedInstallerInputs.sha256) fail();
  const staged = await observeDependencyTree({ workspacePath: dirname(completed.output.canonicalPath), treeName: "node_modules",
    expectedTree: completed.output, limits: hostedDependencyObservationLimits });
  if (staged.status !== DependencyTreeObservationStatus.Complete) fail(Failure.UnsafeTree);
  withHostedActivationFence(fence=>{assertFreshProducer(context,fence,access);normalizeCapturedDependencyOutput(staged,0);});
  const normalized = await observeDependencyTree({ workspacePath: staged.workspace.canonicalPath, treeName: "node_modules",
    expectedWorkspace: staged.workspace, expectedTree: staged.tree, limits: hostedDependencyObservationLimits });
  if (normalized.status !== DependencyTreeObservationStatus.Complete || normalized.digest !== staged.digest) fail(Failure.UnsafeTree);
  if (!sameHostedDependencyKeyInputs(inputs, await readHostedDependencyKeyInputs(binding))) fail();
  withHostedActivationFence(fence => {
    assertFreshProducer(context,fence,access); assertOwnerUnderFence(fence, binding, attempt,context);
    assertHostedDependencyInstallerAttemptDrained(attempt);
    assertHostedDependencyKeyInputsCurrent(binding, inputs);
    publishCapturedDependencyOutput(normalized, binding.workspace);
  });
  withHostedActivationFence(fence=>assertFreshProducer(context,fence,access));
  const final = await observeDependencyTreeWithPhysicalExposure({ workspacePath: binding.workspace.canonicalPath, treeName: "node_modules",
    expectedWorkspace: binding.workspace, expectedTree: normalized.tree, limits: hostedDependencyObservationLimits });
  let ownedFinalExposure = final.status === DependencyTreeObservationStatus.Complete ? final.exposure : undefined;
  try {
  if (final.status !== DependencyTreeObservationStatus.Complete || final.digest !== normalized.digest ||
      !sameHostedDependencyKeyInputs(inputs, await readHostedDependencyKeyInputs(binding))) fail(Failure.UnsafeTree);
  withHostedActivationFence(fence=>assertFreshProducer(context,fence,access));
  const blobs = await openHostedDependencyManifestPlacement();
  try {withHostedActivationFence(fence=>assertFreshProducer(context,fence,access));
    if (await blobs.put(final.canonicalBytes) !== final.digest) fail();
  } finally { await blobs.close(); }
  withHostedActivationFence(fence=>assertFreshProducer(context,fence,access));
  const proofBinding = { generation, workspace: binding.workspace, coverageRevision: base.coverageRevision,
    installKey: inputs.key.installKey, tree: final.tree, manifestDigest: final.digest };
  const ready: DependencyReceipt = { ...base, revision: base.revision + 1, state: DependencyReceiptState.Ready, ...proofBinding,
    treeMeasurement: final.measurement,
    provenance: { ...proofBinding, kind: DependencyInstallProofKind.CompletedInstall, operationId: generation,
      verificationEvidenceId: final.digest, installerDrainEvidenceId: completed.completionSha256 } };
  withHostedActivationFence(fence => {
    assertFreshProducer(context,fence,access); assertOwnerUnderFence(fence, binding, attempt,context);
    assertHostedDependencyInstallerAttemptDrained(attempt);
    assertHostedDependencyKeyInputsCurrent(binding, inputs);
    if (!matchesHostedDependencyReady(binding, ready, inputs)) fail();
    blobs.assertCurrent(fence);
    publishHostedDependencyReceipt(binding, installing.revision, ready);
  });
  if (access === undefined || !final.exposure) return undefined; // Optional retention bounds preserve the original fourth scan.
  const handoff = retainPhysicalCold(binding, attempt, inputs, ready, final, undefined, final.exposure,context,access);
  ownedFinalExposure = undefined; return handoff;
  } finally { if (ownedFinalExposure) closeDependencySourceExposure(ownedFinalExposure); }
}


type Ready = Extract<DependencyReceipt, { state: DependencyReceiptState.Ready }>;
type FinalObservation = Extract<Awaited<ReturnType<typeof observeDependencyTree>>, { status: DependencyTreeObservationStatus.Complete }>;
/** Copies/serialized labels carry no original-map association. */
export type HostedDependencyColdHandoff = Readonly<{startId:string}>;
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
/** Fixed actual installer mapping read; returned bytes are factual only. The
 * lexical original access is required before the first protected record IO. */
export function readOriginalHostedDependencyColdInstallerMapping(context:CurrentHostedDependencyOrigin,fence:HostedActivationFence,access:symbol):Buffer {
  const actual=readOriginalHostedDependencyColdSelection(context,fence,access);
  const bytes=installerMapping(actual.attempt);
  readOriginalHostedDependencyColdSelection(context,fence,access);
  return bytes;
}
function retainPhysicalCold(binding: HostedDependencyBinding, attempt: DependencyAttempt, inputs: HostedDependencyKeyInputs,
  ready: Ready, observed: FinalObservation, source: DependencySourceLinkSession|undefined, exposure: DependencySourceExposure|undefined,
  context:CurrentHostedDependencyOrigin,access:symbol):HostedDependencyColdResult {
  const { committed, mapping } = withHostedActivationFence(fence => {
    assertOriginalHostedDependencyColdProducer(context,fence,access); assertOwnerUnderFence(fence, binding, attempt,context); assertHostedDependencyKeyInputsCurrent(binding, inputs);
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
  if(!exposure) fail(Failure.UnsafeTree);
  return {inputs,ready,reference:committed.reference,observed,installerMapping:mapping,exposure,...(source?{source}:{})};
}
/** Every dispatch resolves the facade through the SAME original map. */
export function consumeHostedDependencyColdHandoff(handoff:HostedDependencyColdHandoff,binding:HostedDependencyBinding,
  attempt:DependencyAttempt,inputs:HostedDependencyKeyInputs,ready:Ready):Pick<HostedDependencyColdResult,"observed"|"reference"|"exposure"|"source"> {
  return consumeCurrentHostedDependencyColdHandoff(handoff,binding,attempt,inputs,ready);
}
export function assertHostedDependencyConsumedColdHandoff(handoff:HostedDependencyColdHandoff,fence:HostedActivationFence):void {
  assertCurrentHostedDependencyConsumedColdHandoff(handoff,fence);
}
export function closeHostedDependencyColdHandoff(handoff:HostedDependencyColdHandoff|undefined):void {
  closeCurrentHostedDependencyColdHandoff(handoff);
}
