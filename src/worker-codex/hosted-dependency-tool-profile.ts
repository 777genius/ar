import { closeSync, constants, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { DependencyAdmissionError, DependencyAdmissionFailure, DependencyOwnerPhase, sameDependencyAttempt,
  DependencyToolReadyProvenanceKind, type DependencyToolReadyFacts, type DependencyToolSourceRoot, type DependencyAttempt } from "@vioxen/subscription-runtime/core";
import { DependencyInstallProofKind, DependencyReceiptState, DependencyTreeObservationStatus, type DependencyReceipt } from "@vioxen/subscription-runtime/worker-core";
import { withHostedActivationFence } from "@vioxen/subscription-runtime/provider-codex";
import { dependencyToolCachePath, dependencyToolGuestConfig, dependencyToolPins, dependencyToolQualificationRecordName,
  parseDependencyToolProfile, parseDependencyToolQualification,
  type DependencyToolGuestConfig, type DependencyToolProfile, type DependencyToolQualification } from "../core/dependency-environment/dependency-tool-profile";
import { assertHostedDependencyToolProfileFiles as assertProfileFiles } from "./hosted-dependency-tool-profile-files";
export { createHostedDependencyToolProfile } from "./hosted-dependency-tool-profile-files";
import { assertHostedActivationFence, readHostedActivationBytes, decodeHostedActivationBytes,
  type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { readCurrentHostedDependencyOrigin, assertCurrentHostedDependencyOrigin, assertCurrentHostedDependencyAttempt,
  readRetainedHostedDependencyAttemptFacts, invalidateCurrentHostedDependencyOrigin, CurrentHostedDependencyOriginKind, isHostedManagedReadonlyOuterRuntime,
  type CurrentHostedDependencyOrigin, type CurrentHostedDependencyOriginFacts } from "../provider-codex/app-server/adapters/hosted-current-dependency-origin";
import { readHostedDependencyBinding, type HostedDependencyBinding } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { observeDependencyTree, observeDependencyTreeWithLocalRegistrySelection, assertDependencyLocalRegistrySelectionAbsent, captureDependencyLocalRootOnlySourceExposure, assertDependencySourceExposureCurrent,
  closeDependencySourceExposure, type DependencySourceExposure } from "../worker-local/dependency-environment/observe-dependency-tree";
import { dependencySourceLinkProof, openCapturedDependencySourceLinks, closeDependencySourceLinkSession,
  readDependencySourceLinkSession, capturedDependencySourceBindingOutputBody, capturedDependencyLegacyLocalSourceFields } from "../worker-local/dependency-environment/dependency-source-binding";
import { encodeDependencySourceBindingOutputBody } from "../worker-core/dependency-environment/domain/dependency-source-binding-record";
import { encodeDependencyTreeManifest } from "../worker-core/dependency-environment/domain/dependency-tree-manifest";
import { HostedDependencyInstallerRecipe } from "./hosted-dependency-installer-inputs";
import { readHostedDependencyCommittedReady, readHostedDependencyEstablishedReceipt } from "./hosted-dependency-receipts";
import { openHostedDependencyManifestPlacement } from "./hosted-dependency-manifest-placement";
import { readHostedDependencyKeyInputs, readHostedDependencyReceipt, assertHostedDependencyKeyInputsCurrent, sameHostedDependencyKeyInputs,
  hostedDependencyObservationLimits, matchesHostedDependencyReady, consumeHostedDependencyColdHandoff, assertHostedDependencyConsumedColdHandoff, type HostedDependencyColdHandoff } from "./hosted-dependency-materialization";
import { isHostedOrdinaryRuntime } from "./hosted-installation-activation";
import type { HostedDependencyKeyInputs } from "./hosted-dependency-materialization-context";

import { openHostedDependencyReadySourceLinks, readHostedDependencyComparedSourceProof } from "./hosted-dependency-ready-source-links";

import { assertHostedDependencyLegacyComparedReady } from "./hosted-dependency-legacy-comparison-record";

const policyRoot = "/var/lib/subscription-runtime-host-policy";
const encode = (v: unknown): Buffer => Buffer.from(JSON.stringify(v) + "\n");
type Ready = Extract<DependencyReceipt, { state: DependencyReceiptState.Ready }>;
type QualificationPin = ReturnType<typeof readQualification>;
/** A structural lookalike has no authority: only this qualifier registers it. */
export type HostedDependencyQualifiedToolEntry = Readonly<{ startId: string }>;
type EntryState = {
  binding: HostedDependencyBinding; attempt: DependencyAttempt; inputs: HostedDependencyKeyInputs; receipt: Ready;
  context: CurrentHostedDependencyOrigin; startName: string; startBytes: Buffer; qualification: QualificationPin;
  readonlySources: readonly DependencyToolSourceRoot[]; exposure?: DependencySourceExposure;
  coldReference?: ReturnType<typeof readHostedDependencyCommittedReady>["reference"];
  placement: Awaited<ReturnType<typeof openHostedDependencyManifestPlacement>>;
  phase: DependencyOwnerPhase.ExclusiveMutation | DependencyOwnerPhase.Running; closed: boolean;
};
const entries = new WeakMap<HostedDependencyQualifiedToolEntry, EntryState>();
let currentQualifiedEntry: HostedDependencyQualifiedToolEntry | undefined;
function selectedStart(facts: CurrentHostedDependencyOriginFacts) {
  return facts.kind === CurrentHostedDependencyOriginKind.ManagedReadonlyLocal ?
    {name:facts.originReference.path.slice(policyRoot.length+1),bytes:encode(facts.start)} :
    {name:`ordinary-starts/${facts.ordinary.reservation.startId}.json`,bytes:encode(facts.ordinary.start)};
}
// Exact supported registry distributions, sourced from the reviewed root lock.
// This is additional qualification, never a substitute for the full byte proof.
const toolDistributionIntegrity = Object.freeze({
  vite: "sha512-h9bXPmJichP5fLmVQo3PyaGSDE2n3aPuomeAlVRm0JLmt4rY6zmPKd59HYI4LNW8oTK7tlTsuC7l/m7awx9Jcw==",
  vitest: "sha512-flY6ScbCIt9HThs+C5HS7jvGOB560DJtk/Z15IQROTA6zEy49Nh8T/dofWTQL+n3vswqn87sbJNiuqw1SDp5Ig==",
});

/** v1 has no capability; v2 is strict at the protected provider binding parser. */
export function hostedDependencyToolProfile(binding: HostedDependencyBinding): DependencyToolProfile | undefined {
  const value: unknown = binding;
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const v = value as Record<string, unknown>;
  if (v.version === 1) return undefined;
  if (v.version !== 2) fail();
  const profile = parseDependencyToolProfile(v.toolProfile);
  if (profile.cache.canonicalPath !== dependencyToolCachePath(binding.jobRootDir)) fail();
  return profile;
}

/** N3-only current byte qualification, not generic Ready hot attestation.
 * All awaits are bracketed by actual ExclusiveMutation owner/fence checks.
 */
export async function qualifyHostedDependencyToolClosure(binding: HostedDependencyBinding, attempt: DependencyAttempt, coldHandoff?: HostedDependencyColdHandoff, capturedOrigin?: CurrentHostedDependencyOrigin): Promise<HostedDependencyQualifiedToolEntry | undefined> {
  const profile = hostedDependencyToolProfile(binding); if (!profile) return;
  const context = capturedOrigin ?? withHostedActivationFence(fence => readCurrentHostedDependencyOrigin(fence));
  const assertExclusive = () => withHostedActivationFence(fence => {
    const actual = assertCurrentHostedDependencyAttempt(context,fence,DependencyOwnerPhase.ExclusiveMutation);
    if (!sameDependencyAttempt(actual.attempt,attempt) || !encode(actual.binding).equals(encode(binding))) fail(); return actual.facts;
  });
  const origin = assertExclusive(), selected = selectedStart(origin), startName = selected.name;
  const startBytes = readHostedActivationBytes(startName);
  if (!startBytes || !selected.bytes.equals(startBytes)) fail();
  assertProfileFiles(profile, binding.jobRootDir);
  const before = await readHostedDependencyKeyInputs(binding); assertExclusive();
  const receipt = readHostedDependencyReceipt(binding);
  if (!receipt || receipt.state !== DependencyReceiptState.Ready || !matchesHostedDependencyReady(binding, receipt, before)) fail(DependencyAdmissionFailure.NeedsInstall);
  const local = receipt.provenance.kind === DependencyInstallProofKind.CompletedLocalInstallV1 || verifiedLocalComparison(receipt);
  if (local ? before.recipe !== HostedDependencyInstallerRecipe.NpmLocalNoLifecycleV1 :
      !verifiedRegistry(receipt) || before.recipe !== HostedDependencyInstallerRecipe.NpmRegistryNoScriptsV1) fail();
  const source = openHostedDependencyReadySourceLinks(receipt);
  let exposure: DependencySourceExposure | undefined, nodeModulesExposure: DependencySourceExposure | undefined;
  let capturedSource: ReturnType<typeof openCapturedDependencySourceLinks> | undefined;
  let coldReference: ReturnType<typeof readHostedDependencyCommittedReady>["reference"] | undefined;
  try {
  const readonlySources = currentSources(before, receipt);
  const deadline = performance.now() + hostedDependencyObservationLimits.maxDurationMs;
  const placement = await openHostedDependencyManifestPlacement();
  let manifest: Uint8Array;
  try { assertExclusive(); manifest = await placement.get(receipt.manifestDigest); assertExclusive(); }
  finally { await placement.close(); assertExclusive(); }
  const observationInput = { workspacePath: binding.workspace.canonicalPath, treeName: "node_modules",
    expectedWorkspace: binding.workspace, expectedTree: receipt.tree, limits: { ...hostedDependencyObservationLimits, maxDurationMs: Math.floor(deadline - performance.now()) },
    ...(source ? { sourceLinkSession: source } : {}) } as const;
  if (local && !coldHandoff) {
    if (before.recipe !== HostedDependencyInstallerRecipe.NpmLocalNoLifecycleV1 || !source) fail();
    capturedSource = openCapturedDependencySourceLinks(before.capture);
  }
  let observed: Awaited<ReturnType<typeof observeDependencyTree>>;
  if (coldHandoff) {
    const final = consumeHostedDependencyColdHandoff(coldHandoff, binding, attempt, before, receipt);
    coldReference = final.reference;
    observed = final.observed; capturedSource = final.source; nodeModulesExposure = final.exposure;
    if (local && (!capturedSource || !nodeModulesExposure || !source)) fail(DependencyAdmissionFailure.UnsafeTree);
    if (!nodeModulesExposure || (!local && capturedSource)) fail(DependencyAdmissionFailure.UnsafeTree);
  } else if (capturedSource && source) {
    const localObserved = await observeDependencyTreeWithLocalRegistrySelection({ ...observationInput,
      sourceLinkSession: capturedSource, protectedSourceLinkSession: source });
    if (localObserved.status === DependencyTreeObservationStatus.Complete) nodeModulesExposure = localObserved.exposure;
    observed = localObserved;
  } else observed = await observeDependencyTree(observationInput);
  assertExclusive();
  if (observed.status !== DependencyTreeObservationStatus.Complete || observed.digest !== receipt.manifestDigest ||
      !Buffer.from(manifest).equals(observed.canonicalBytes)) fail(DependencyAdmissionFailure.UnsafeTree);
  if (source && !Buffer.from(encodeDependencyTreeManifest(observed.entries,
      readDependencySourceLinkSession(source, binding.workspace, "node_modules"))).equals(observed.canonicalBytes)) fail(DependencyAdmissionFailure.UnsafeTree);
  if (readonlySources.length) {
    const remaining = { maxEntries: hostedDependencyObservationLimits.maxEntries - observed.entries.length,
      maxTotalBytes: hostedDependencyObservationLimits.maxTotalBytes - Number(observed.totalBytes),
      maxManifestBytes: hostedDependencyObservationLimits.maxManifestBytes - observed.canonicalBytes.length,
      maxDurationMs: Math.floor(deadline - performance.now()) };
    if ([remaining.maxEntries, remaining.maxTotalBytes, remaining.maxManifestBytes, remaining.maxDurationMs]
        .some(value => !Number.isSafeInteger(value) || value <= 0)) fail(DependencyAdmissionFailure.UnsafeTree);
    const captured = await captureDependencyLocalRootOnlySourceExposure({ roots: readonlySources.map(root => ({
      parentPath: dirname(root.canonicalPath), name: root.canonicalPath.slice(dirname(root.canonicalPath).length + 1), expectedTree: root.identity })), limits: remaining });
    assertExclusive();
    if (captured.status !== DependencyTreeObservationStatus.Complete) fail(DependencyAdmissionFailure.UnsafeTree);
    exposure = captured.exposure;
  }
  assertInstalledPins(binding.workspace.canonicalPath, profile, before.lockBytes);
  const after = await readHostedDependencyKeyInputs(binding); assertExclusive();
  if (!sameHostedDependencyKeyInputs(before, after)) fail();
  const qualification = parseDependencyToolQualification({ version: 1, kind: "n3-authenticated-tool-closure",
    installationId: binding.installationId, runtimeSha: binding.runtimeSha, grantDigest: binding.grantDigest,
    workspace: binding.workspace, startId: attempt.launch.startId, attemptId: attempt.attemptId, epoch: attempt.epoch,
    readyRevision: receipt.revision, installKey: receipt.installKey, tree: observed.tree, manifestDigest: observed.digest, profile,
    measurement: { entries: observed.entries.length, bytes: observed.totalBytes, durationMs: Number(observed.measurement.observedScanDurationMs) } });
  withHostedActivationFence(fence => {
    const current = assertCurrentHostedDependencyAttempt(context,fence,DependencyOwnerPhase.ExclusiveMutation);
    if (!sameDependencyAttempt(current.attempt,attempt) || !encode(current.binding).equals(encode(binding)) ||
        !encode(readHostedDependencyReceipt(binding)).equals(encode(receipt))) fail();
    assertHostedDependencyKeyInputsCurrent(binding, before); placement.assertCurrent(fence);
    if (coldHandoff) assertHostedDependencyConsumedColdHandoff(coldHandoff, fence);
    if (coldReference && !encode(readHostedDependencyCommittedReady(binding, receipt.revision).reference).equals(encode(coldReference))) fail(DependencyAdmissionFailure.StaleAttempt);
    if (!encode(currentSources(before, receipt)).equals(encode(readonlySources))) fail();
    if (exposure) assertDependencySourceExposureCurrent(exposure);
    if (local && (!nodeModulesExposure || !capturedSource)) fail(DependencyAdmissionFailure.UnsafeTree);
    if (nodeModulesExposure && capturedSource) assertDependencyLocalRegistrySelectionAbsent(nodeModulesExposure, capturedSource,
      binding.workspace, observed.tree, Math.floor(deadline - performance.now()));
    else if (nodeModulesExposure) assertDependencySourceExposureCurrent(nodeModulesExposure, Math.floor(deadline - performance.now()));
    assertProfileFiles(profile, binding.jobRootDir);
    const currentTree = lstatSync(`${binding.workspace.canonicalPath}/node_modules`, { bigint: true });
    if (!currentTree.isDirectory() || String(currentTree.dev) !== observed.tree.dev || String(currentTree.ino) !== observed.tree.ino) fail();
    // Fixed actual start ID only. Collision is held evidence, never adoption.
    const path = join(policyRoot, dependencyToolQualificationRecordName(attempt.launch.startId));
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, encode(qualification)); fsyncSync(fd); } finally { closeSync(fd); }
    const parent = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(parent); } finally { closeSync(parent); }
  });
  const pin = readQualification(attempt);
  if (!encode(pin.qualification).equals(encode(qualification))) fail();
  const entry = Object.freeze({ startId: attempt.launch.startId });
  entries.set(entry, { binding, attempt, inputs: before, receipt, context, startName, startBytes, qualification: pin,
    readonlySources, placement, ...(coldReference ? { coldReference } : {}), ...(exposure ? { exposure } : {}), phase: DependencyOwnerPhase.ExclusiveMutation, closed: false });
  currentQualifiedEntry = entry;
  exposure = undefined; // The one private entry now owns the logical baseline.
  return entry;
  } finally {
    if (nodeModulesExposure) closeDependencySourceExposure(nodeModulesExposure);
    if (capturedSource) closeDependencySourceLinkSession(capturedSource);
    if (source) closeDependencySourceLinkSession(source);
    if (exposure) closeDependencySourceExposure(exposure);
  }
}

function currentSources(inputs: HostedDependencyKeyInputs, receipt: Ready): readonly DependencyToolSourceRoot[] {
  if (verifiedRegistry(receipt)) {
    if (inputs.recipe !== HostedDependencyInstallerRecipe.NpmRegistryNoScriptsV1) fail();
    return Object.freeze([]);
  }
  if (inputs.recipe !== HostedDependencyInstallerRecipe.NpmLocalNoLifecycleV1) fail();
  const compared = verifiedLocalComparison(receipt);
  if (!compared && receipt.provenance.kind !== DependencyInstallProofKind.CompletedLocalInstallV1) fail();
  const protectedSession = openHostedDependencyReadySourceLinks(receipt);
  if (!protectedSession) fail();
  let capturedSession: ReturnType<typeof openCapturedDependencySourceLinks> | undefined;
  try {
    capturedSession = openCapturedDependencySourceLinks(inputs.capture);
    const binding = { generation: receipt.generation, workspace: receipt.workspace, coverageRevision: receipt.coverageRevision,
      installKey: receipt.installKey, tree: receipt.tree, manifestDigest: receipt.manifestDigest };
    const record = compared ? readHostedDependencyComparedSourceProof(protectedSession).record : dependencySourceLinkProof(protectedSession).record;
    if (compared) {
      const proof = readHostedDependencyComparedSourceProof(protectedSession), mapping = proof.record;
      // Capture-derived facts contain no fabricated candidate completion.
      const expected = capturedDependencyLegacyLocalSourceFields(inputs.capture);
      if (!encode(mapping.candidate).equals(encode(binding)) || mapping.closureDigest !== expected.closureDigest ||
          !encode(mapping.sourceLinks).equals(encode(expected.sourceLinks)) || !encode(mapping.directories).equals(encode(expected.directories)) ||
          !encode(mapping.ancestors).equals(encode(expected.ancestors))) fail(DependencyAdmissionFailure.UnsafeTree);
    } else {
      const installed = dependencySourceLinkProof(protectedSession).record;
      if (installed.version !== 2) fail();
      const expected = capturedDependencySourceBindingOutputBody(inputs.capture, binding, installed.installerCompletionSha256);
      const { outputReference: _outputReference, ...body } = installed;
      if (encodeDependencySourceBindingOutputBody(expected) !== encodeDependencySourceBindingOutputBody(body)) fail(DependencyAdmissionFailure.UnsafeTree);
    }
    if (!encode(readDependencySourceLinkSession(capturedSession, receipt.workspace, "node_modules"))
        .equals(encode(readDependencySourceLinkSession(protectedSession, receipt.workspace, "node_modules")))) fail(DependencyAdmissionFailure.UnsafeTree);
    const roots = [...new Set(record.sourceLinks.map(link => link.sourcePath))].sort().map(path => {
      const pin = record.directories.find(directory => directory.path === path);
      if (!pin || !path) fail();
      return Object.freeze({ canonicalPath: join(receipt.workspace.canonicalPath, path), identity: Object.freeze({ dev: pin.dev, ino: pin.ino }) });
    });
    if (roots.length > 128 || roots.some((root, index) => roots.slice(index + 1).some(other => other.canonicalPath.startsWith(root.canonicalPath + "/")))) fail();
    return Object.freeze(roots);
  } finally {
    if (capturedSession) closeDependencySourceLinkSession(capturedSession);
    closeDependencySourceLinkSession(protectedSession);
  }
}
function readQualification(attempt: DependencyAttempt) {
  const name = dependencyToolQualificationRecordName(attempt.launch.startId), path = join(policyRoot, name);
  const before = lstatSync(path, { bigint: true }), bytes = readHostedActivationBytes(name);
  if (!bytes) fail();
  const qualification = parseDependencyToolQualification(decodeHostedActivationBytes(bytes)), after = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n || before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode ||
      before.ctimeNs !== after.ctimeNs || before.mtimeNs !== after.mtimeNs || !encode(qualification).equals(bytes)) fail();
  return { qualification, bytes, dev: before.dev, ino: before.ino, ctimeNs: before.ctimeNs, mtimeNs: before.mtimeNs };
}
function entryState(entry: HostedDependencyQualifiedToolEntry): EntryState {
  const state = entries.get(entry); if (!state || state.closed) fail(DependencyAdmissionFailure.StaleAttempt); return state;
}
function currentEntry(state: EntryState, phase: DependencyOwnerPhase.ExclusiveMutation | DependencyOwnerPhase.Running): DependencyToolReadyFacts {
  const { binding, attempt, inputs, receipt } = state;
  const actual = readRetainedHostedDependencyAttemptFacts(state.context,phase);
  if (!encode(readHostedDependencyBinding(binding.jobId)).equals(encode(binding)) ||
      !readHostedActivationBytes(state.startName)?.equals(state.startBytes) ||
      !sameDependencyAttempt(actual.attempt,attempt) || !encode(actual.binding).equals(encode(binding)) ||
      !encode(readHostedDependencyEstablishedReceipt(binding)).equals(encode(receipt))) fail(DependencyAdmissionFailure.StaleAttempt);
  assertHostedDependencyKeyInputsCurrent(binding, inputs);
  if (state.coldReference && !encode(readHostedDependencyCommittedReady(binding, receipt.revision).reference).equals(encode(state.coldReference))) fail(DependencyAdmissionFailure.StaleAttempt);
  state.placement.assertClosedCurrent();
  if (!encode(currentSources(inputs, receipt)).equals(encode(state.readonlySources))) fail(DependencyAdmissionFailure.UnsafeTree);
  if (state.exposure) assertDependencySourceExposureCurrent(state.exposure);
  const pin = readQualification(attempt), tree = lstatSync(join(binding.workspace.canonicalPath, "node_modules"), { bigint: true });
  if (!pin.bytes.equals(state.qualification.bytes) || pin.dev !== state.qualification.dev || pin.ino !== state.qualification.ino ||
      pin.ctimeNs !== state.qualification.ctimeNs || pin.mtimeNs !== state.qualification.mtimeNs ||
      !tree.isDirectory() || String(tree.dev) !== receipt.tree.dev || String(tree.ino) !== receipt.tree.ino) fail();
  assertProfileFiles(pin.qualification.profile, binding.jobRootDir);
  const identity = { workspace: receipt.workspace, coverageRevision: receipt.coverageRevision, revision: receipt.revision,
    installKey: receipt.installKey, tree: receipt.tree, manifestDigest: receipt.manifestDigest };
  if (receipt.provenance.kind === DependencyInstallProofKind.CompletedLocalInstallV1) return Object.freeze({ ...identity,
    provenance: Object.freeze({ kind: DependencyToolReadyProvenanceKind.LocalCompleted, sourceBinding: receipt.provenance.sourceBinding, readonlySources: state.readonlySources }) });
  if (receipt.provenance.kind === DependencyInstallProofKind.LegacyCompared) {
    const comparison = assertHostedDependencyLegacyComparedReady({ ...receipt, provenance: receipt.provenance });
    if (comparison.version === 2) return Object.freeze({ ...identity, provenance: Object.freeze({
      kind: DependencyToolReadyProvenanceKind.LocalCompared, comparisonEvidenceId: receipt.provenance.comparisonEvidenceId,
      sourceBinding: comparison.candidateSourceBinding, readonlySources: state.readonlySources }) });
  }
  if (!verifiedRegistry(receipt)) fail();
  return Object.freeze({ ...identity, provenance: Object.freeze({ kind: DependencyToolReadyProvenanceKind.RegistryCompleted }) });
}
/** Called under the genuine final fence, after all temporary descriptors close. */
export function assertHostedDependencyQualifiedToolEntry(entry: HostedDependencyQualifiedToolEntry, fence: HostedActivationFence,
  phase: DependencyOwnerPhase.ExclusiveMutation | DependencyOwnerPhase.Running): void {
  const state = entryState(entry); assertHostedActivationFence(fence);
  const actual = assertCurrentHostedDependencyAttempt(state.context,fence,phase);
  if (state.phase !== phase || !sameDependencyAttempt(actual.attempt,state.attempt) || !selectedStart(actual.facts).bytes.equals(state.startBytes)) fail(DependencyAdmissionFailure.StaleAttempt);
  state.placement.assertCurrent(fence);
  currentEntry(state, phase);
}
/** Reads the one baseline; it cannot capture a replacement or mint a handle. */
export function readHostedDependencyQualifiedToolEntry(entry: HostedDependencyQualifiedToolEntry): DependencyToolReadyFacts {
  const state = entryState(entry); if (state.phase !== DependencyOwnerPhase.Running) fail(DependencyAdmissionFailure.StaleAttempt);
  return currentEntry(state, DependencyOwnerPhase.Running);
}
/** Only genuine Running CAS/readback changes the private logical phase. */
export function markHostedDependencyQualifiedToolEntryRunning(entry: HostedDependencyQualifiedToolEntry, fence: HostedActivationFence): void {
  const state = entryState(entry); assertHostedActivationFence(fence);
  const actual = assertCurrentHostedDependencyAttempt(state.context,fence,DependencyOwnerPhase.Running);
  if (state.phase !== DependencyOwnerPhase.ExclusiveMutation || !sameDependencyAttempt(actual.attempt,state.attempt) || !selectedStart(actual.facts).bytes.equals(state.startBytes)) fail(DependencyAdmissionFailure.StaleAttempt);
  state.placement.assertCurrent(fence);
  currentEntry(state, DependencyOwnerPhase.Running); state.phase = DependencyOwnerPhase.Running;
}
/** Logical revocation on uncertain/terminal use. Never releases durable owner;
 * the existing supervisor must still prove queue/provider/installer drain. */
export function invalidateHostedDependencyQualifiedToolEntry(entry: HostedDependencyQualifiedToolEntry | undefined): void {
  if (!entry) return;
  const state = entries.get(entry); if (!state || state.closed) return;
  state.closed = true; if (currentQualifiedEntry === entry) currentQualifiedEntry = undefined;
  // Revocation of the genuine qualifier also revokes every facade of its SAME
  // origin. A legal Ready retirement does not pass through this invalidator.
  invalidateCurrentHostedDependencyOrigin(state.context);
  if (state.exposure) closeDependencySourceExposure(state.exposure);
}

/** Resolve config only from a protected qualification plus the genuine Running
 * owner. The shared provider launch must independently validate these facts.
 */
export function readAdmittedHostedDependencyToolConfig(workspacePath: string | undefined,
  entry?: HostedDependencyQualifiedToolEntry): DependencyToolGuestConfig | undefined {
  if ((!isHostedOrdinaryRuntime() && !isHostedManagedReadonlyOuterRuntime()) || workspacePath === undefined) return undefined;
  return withHostedActivationFence(fence => {
    if (!entry) {
      const context = readCurrentHostedDependencyOrigin(fence), facts = assertCurrentHostedDependencyOrigin(context,fence);
      if (facts.kind === CurrentHostedDependencyOriginKind.ManagedReadonlyLocal) fail();
      if (!readHostedDependencyBinding(String(facts.ordinary.start.jobId))) return undefined;
    }
    const context = entry ? entryState(entry).context : readCurrentHostedDependencyOrigin(fence);
    const actual = assertCurrentHostedDependencyAttempt(context,fence), binding = actual.binding;
    const profile = hostedDependencyToolProfile(binding); if (!profile) return undefined;
    if (workspacePath !== binding.workspace.canonicalPath) fail();
    const attempt = actual.attempt;
    const q = readQualification(attempt).qualification;
    if (entry) assertHostedDependencyQualifiedToolEntry(entry, fence, DependencyOwnerPhase.Running);
    assertQualification(q, binding, attempt, entry); assertProfileFiles(profile, binding.jobRootDir);
    return dependencyToolGuestConfig(q);
  });
}
export function hostedDependencyToolInstruction(config: DependencyToolGuestConfig, entry?: HostedDependencyQualifiedToolEntry): string {
  const quote = (v: string) => `'${v.replaceAll("'", `'\\''`)}'`;
  const command = `${quote(config.profile.node.path)} ${quote(config.profile.helper.path)}`;
  const local = entry && [DependencyToolReadyProvenanceKind.LocalCompleted, DependencyToolReadyProvenanceKind.LocalCompared].includes(readHostedDependencyQualifiedToolEntry(entry).provenance.kind);
  return ["This admitted task supports config-free Node checks and dependency optimization.",
    `Run ${command} optimize or ${command} test using the native exec tool.`,
    `Registered test files: ${config.profile.testFiles.join(", ")}. Registered optimizer dependencies: ${config.profile.optimizerDependencies.join(", ")}.`,
    local ? "Root node_modules and linked local source roots are read-only for this registered TEST consumer. Edit linked source only between fully drained entries; the next entry observes those edits without reinstalling. Other source/output edits follow task permissions." :
      "Root node_modules is read-only for this consumer. Source/output edits follow the task permissions. Dependency installation, patching, and writes into node_modules are unsupported during this consumer.",
    "This command uses a fixed qualified tool profile and does not load user Vite/Vitest config. Do not substitute custom config or flags."].join("\n");
}
function assertQualification(q: DependencyToolQualification, binding: HostedDependencyBinding, attempt: DependencyAttempt,
  entry?: HostedDependencyQualifiedToolEntry): void {
  const receipt = entry ? readHostedDependencyEstablishedReceipt(binding) : readHostedDependencyReceipt(binding), tree = lstatSync(`${binding.workspace.canonicalPath}/node_modules`, { bigint: true });
  if (q.installationId !== binding.installationId || q.runtimeSha !== binding.runtimeSha || q.grantDigest !== binding.grantDigest ||
      !encode(q.workspace).equals(encode(binding.workspace)) || q.startId !== attempt.launch.startId || q.attemptId !== attempt.attemptId || q.epoch !== attempt.epoch ||
      !receipt || receipt.state !== DependencyReceiptState.Ready ||
      (!verifiedRegistry(receipt) &&
        ((receipt.provenance.kind !== DependencyInstallProofKind.CompletedLocalInstallV1 && !verifiedLocalComparison(receipt)) || !entry)) ||
      q.readyRevision !== receipt.revision || q.installKey !== receipt.installKey || q.manifestDigest !== receipt.manifestDigest ||
      q.tree.dev !== receipt.tree.dev || q.tree.ino !== receipt.tree.ino || !tree.isDirectory() || String(tree.dev) !== q.tree.dev || String(tree.ino) !== q.tree.ino ||
      !encode(q.profile).equals(encode(hostedDependencyToolProfile(binding)))) fail();
}
/** Every projection reauthenticates the fixed immutable comparison evidence. */
function verifiedRegistry(receipt: Ready): boolean {
  if (receipt.provenance.kind === DependencyInstallProofKind.CompletedInstall) return true;
  if (receipt.provenance.kind !== DependencyInstallProofKind.LegacyCompared) return false;
  return assertHostedDependencyLegacyComparedReady({ ...receipt, provenance: receipt.provenance }).version === 1;
}
function verifiedLocalComparison(receipt: Ready): boolean {
  return receipt.provenance.kind === DependencyInstallProofKind.LegacyCompared &&
    assertHostedDependencyLegacyComparedReady({ ...receipt, provenance: receipt.provenance }).version === 2;
}
function assertInstalledPins(workspace: string, profile: DependencyToolProfile, lockBytes: Uint8Array): void {
  const lock: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(lockBytes));
  if (!lock || typeof lock !== "object" || Array.isArray(lock) || !("packages" in lock) ||
      !lock.packages || typeof lock.packages !== "object" || Array.isArray(lock.packages)) fail();
  const packages = lock.packages as Record<string, unknown>;
  for (const [name, version] of Object.entries(dependencyToolPins)) {
    const entry = packages[`node_modules/${name}`];
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || !("version" in entry) || entry.version !== version ||
        !("resolved" in entry) || entry.resolved !== `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz` ||
        !("integrity" in entry) || entry.integrity !== toolDistributionIntegrity[name as keyof typeof toolDistributionIntegrity]) fail();
    const path = join(workspace, "node_modules", name, "package.json"), stat = lstatSync(path);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 256 * 1024 || realpathSync(path) !== path) fail();
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object" || !("name" in value) || value.name !== name || !("version" in value) || value.version !== version) fail();
  }
  for (const dependency of profile.optimizerDependencies) {
    const path = join(workspace, "node_modules", dependency);
    if (!lstatSync(path).isDirectory() || realpathSync(path) !== path) fail();
  }
}
function fail(reason = DependencyAdmissionFailure.Unsupported): never { throw new DependencyAdmissionError(reason); }

/** B root-purpose preparation reads only this actual completed qualifier, before
 * Running. No path/config/entry setter or caller-shaped scope can register it. */
export function readCurrentHostedDependencyRootQualification(fence: HostedActivationFence) {
  if (!currentQualifiedEntry) fail(DependencyAdmissionFailure.StaleAttempt);
  const state = entryState(currentQualifiedEntry);
  assertHostedDependencyQualifiedToolEntry(currentQualifiedEntry,fence,state.phase);
  return Object.freeze({context:state.context,binding:state.binding,attempt:state.attempt,inputs:state.inputs,receipt:state.receipt,
    readonlySources:state.readonlySources,phase:state.phase});
}
