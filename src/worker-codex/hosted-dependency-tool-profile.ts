import { assertCurrentHostedDependencyExecutionAdmission } from "./hosted-current-dependency-origin";
import { prepareCurrentHostedDependencyGenerationSourceRetirement, holdCurrentHostedDependencyGenerationSourceUse, readCurrentHostedDependencyGenerationBaseline, captureCurrentHostedDependencyGenerationInputs, bindCurrentHostedDependencyGenerationQualifier, findOriginalHostedDependencyGenerationState } from "./hosted-current-dependency-origin";
import { types } from "node:util";
import { createHash } from "node:crypto";
import { DependencyToolExecutionBasis, DependencyToolQualificationKind, parseDependencyToolUsableExecution, parseDependencyToolBaselineExecution,
  parseDependencyToolAdmissionQualification, dependencyToolAdmittedGuestConfig, type DependencyToolUsableExecution,
  type DependencyToolBaselineExecution, type DependencyToolAdmissionQualification } from "../core/dependency-environment/dependency-tool-execution";
import { DependencyToolOperation } from "../core/dependency-environment/dependency-tool-profile";
import { DependencyToolReadyReadStatus, type DependencyToolReadyRead } from "../core/dependency-environment/dependency-tool-ready-reader";
import { readHostedDependencyUsableReceipt } from "./hosted-dependency-usable-receipt";
import { closeSync, constants, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { DependencyAdmissionError, DependencyAdmissionFailure, DependencyOwnerPhase, sameDependencyAttempt, sameDependencyProtectedReference,
  DependencyToolReadyProvenanceKind, type DependencyToolReadyFacts, type DependencyToolSourceRoot, type DependencyWorkspaceIdentity, type DependencyAttempt } from "@vioxen/subscription-runtime/core";
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
  readRetainedHostedDependencyAttemptFacts, retireCurrentHostedDependencyWarmReady, invalidateCurrentHostedDependencyOrigin, CurrentHostedDependencyOriginKind, isHostedManagedReadonlyOuterRuntime,
  type CurrentHostedDependencyOrigin, type CurrentHostedDependencyOriginFacts } from "./hosted-current-dependency-origin";
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
type EntryCommon = {
  binding: HostedDependencyBinding; attempt: DependencyAttempt; inputs: HostedDependencyKeyInputs;
  context: CurrentHostedDependencyOrigin; startName: string; startBytes: Buffer; qualification: QualificationPin;
  readonlySources: readonly DependencyToolSourceRoot[]; exposure?: DependencySourceExposure;
  phase: DependencyOwnerPhase.ExclusiveMutation | DependencyOwnerPhase.Running; closed: boolean;
};
type ReadyEntryState=EntryCommon & {kind:DependencyToolReadyReadStatus.Ready;receipt:Ready;
  coldReference?:ReturnType<typeof readHostedDependencyCommittedReady>["reference"];
  placement:Awaited<ReturnType<typeof openHostedDependencyManifestPlacement>>};
type UsableEntryState=EntryCommon & {kind:DependencyToolReadyReadStatus.Usable;
  receipt:ReturnType<typeof readHostedDependencyUsableReceipt>["receipt"]["receipt"];
  execution:DependencyToolUsableExecution};
type BaselineEntryState=EntryCommon & {kind:DependencyToolReadyReadStatus.Baseline;receipt:Ready;execution:DependencyToolBaselineExecution};
type EntryState=ReadyEntryState|UsableEntryState|BaselineEntryState;
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

/** Closed input snapshot only, no issuer/permit. Reject caller accessors,
 * proxies, toJSON/iterator hooks before matching the actual protected binding.
 */
function captureQualificationData(value:unknown):unknown {
  let remaining=512,characters=65536;
  function capture(value:unknown,depth:number):unknown {
    if(--remaining<0 || depth>12)fail();
    if(value===null || typeof value==="boolean")return value;
    if(typeof value==="string"){if(value.length>4096 || (characters-=value.length)<0)fail();return value;}
    if(typeof value==="number"){if(!Number.isSafeInteger(value))fail();return value;}
    if(typeof value!=="object" || types.isProxy(value))fail();
    const array=Array.isArray(value),prototype=Object.getPrototypeOf(value);
    if(array ? prototype!==Array.prototype : prototype!==Object.prototype && prototype!==null)fail();
    const descriptors=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(descriptors);
    if(keys.length>128 || keys.some(key=>typeof key!=="string"))fail();
    if(array) {
      const length=descriptors.length;if(!length || !("value" in length) || !Number.isSafeInteger(length.value) || length.value<0 || length.value>128 || keys.length!==length.value+1)fail();
      const result:unknown[]=[];
      for(let i=0;i<length.value;i++){const pin=descriptors[String(i)];if(!pin || !("value" in pin) || !pin.enumerable)fail();result.push(capture(pin.value,depth+1));}
      return Object.freeze(result);
    }
    const result:Record<string,unknown>=Object.create(null);
    for(const key of keys){const pin=descriptors[String(key)];if(!pin || !("value" in pin) || !pin.enumerable || key==="toJSON")fail();result[String(key)]=capture(pin.value,depth+1);}
    return Object.freeze(result);
  }
  return capture(value,0);
}

/** Cold N3 byte qualification or truthful current Usable facts, never HOT byte attestation.
 * All awaits are bracketed by actual ExclusiveMutation owner/fence checks.
 */
export async function qualifyHostedDependencyToolClosure(binding: HostedDependencyBinding, attempt: DependencyAttempt, coldHandoff?: HostedDependencyColdHandoff, capturedOrigin?: CurrentHostedDependencyOrigin): Promise<HostedDependencyQualifiedToolEntry | undefined> {
  const context = capturedOrigin ?? withHostedActivationFence(fence => readCurrentHostedDependencyOrigin(fence));
  // Actual origin first; caller binding/profile fields never select physical IO.
  const original=withHostedActivationFence(fence=>assertCurrentHostedDependencyExecutionAdmission(context,fence));
  if(!encode(captureQualificationData(binding)).equals(encode(original.binding)) ||
    !encode(captureQualificationData(attempt)).equals(encode(original.attempt)))fail(DependencyAdmissionFailure.StaleAttempt);
  withHostedActivationFence(fence=>assertCurrentHostedDependencyExecutionAdmission(context,fence));
  binding=original.binding;attempt=original.attempt;
  const profile=hostedDependencyToolProfile(binding);if(!profile)return;
  const assertExclusive = () => withHostedActivationFence(fence => {
    const actual = assertCurrentHostedDependencyExecutionAdmission(context,fence);
    if (!sameDependencyAttempt(actual.attempt,attempt) || !encode(actual.binding).equals(encode(binding))) fail(); return actual.facts;
  });
  const origin = assertExclusive(), selected = selectedStart(origin), startName = selected.name;
  const startBytes = readHostedActivationBytes(startName);
  if (!startBytes || !selected.bytes.equals(startBytes)) fail();
  assertProfileFiles(profile, binding.jobRootDir);
  const before = await captureCurrentHostedDependencyGenerationInputs(context); assertExclusive();
  let receipt = readHostedDependencyReceipt(binding);
  if (binding.version===2 && !coldHandoff) {
    if(receipt?.state===DependencyReceiptState.Ready) {
      const baseline=withHostedActivationFence(fence=>readCurrentHostedDependencyGenerationBaseline(context,fence));
      if(baseline && before.key.installKey===baseline.ready.receipt.installKey &&
          before.capture.closureDigest===baseline.pins.baseline.inputClosureDigest)return qualifyWarmToolClosure(binding,attempt,context,startName,startBytes,profile,before);
      retireCurrentHostedDependencyWarmReady(context);
    }
    receipt=withHostedActivationFence(fence=>{assertCurrentHostedDependencyAttempt(context,fence,DependencyOwnerPhase.ExclusiveMutation);
      return readHostedDependencyEstablishedReceipt(binding);});
    if(receipt?.state===DependencyReceiptState.Unverified)
      return qualifyWarmToolClosure(binding,attempt,context,startName,startBytes,profile,before);
  }
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
  if (pin.qualification.version!==1 || !encode(pin.qualification).equals(encode(qualification))) fail();
  const entry = Object.freeze({ startId: attempt.launch.startId });
  entries.set(entry, { kind:DependencyToolReadyReadStatus.Ready, binding, attempt, inputs: before, receipt, context, startName, startBytes, qualification: pin,
    readonlySources, placement, ...(coldReference ? { coldReference } : {}), ...(exposure ? { exposure } : {}), phase: DependencyOwnerPhase.ExclusiveMutation, closed: false });
  currentQualifiedEntry = entry;
  try{withHostedActivationFence(fence=>bindCurrentHostedDependencyGenerationQualifier(context,fence));}
  catch(error){entries.delete(entry);if(currentQualifiedEntry===entry)currentQualifiedEntry=undefined;
    holdCurrentHostedDependencyGenerationSourceUse(context);throw error;}
  exposure = undefined; // The one private entry now owns the logical baseline.
  return entry;
  } finally {
    if (nodeModulesExposure) closeDependencySourceExposure(nodeModulesExposure);
    if (capturedSource) closeDependencySourceLinkSession(capturedSource);
    if (source) closeDependencySourceLinkSession(source);
    if (exposure) closeDependencySourceExposure(exposure);
  }
}

function usableSources(inputs:HostedDependencyKeyInputs,workspace:DependencyWorkspaceIdentity) {
  if(inputs.recipe===HostedDependencyInstallerRecipe.NpmRegistryNoScriptsV1)
    return {roots:Object.freeze([]) as readonly DependencyToolSourceRoot[],ancestors:Object.freeze([Object.freeze({canonicalPath:workspace.canonicalPath,identity:Object.freeze({dev:workspace.dev,ino:workspace.ino})})])};
  const fields=capturedDependencyLegacyLocalSourceFields(inputs.capture);
  const roots=[...new Set(fields.sourceLinks.map(link=>link.sourcePath))].sort().map(relative=>{
    const pin=fields.directories.find(value=>value.path===relative);if(!pin || !relative)fail();
    return Object.freeze({canonicalPath:join(workspace.canonicalPath,relative),identity:Object.freeze({dev:pin.dev,ino:pin.ino})});
  });
  const ancestors=fields.ancestors.map(pin=>Object.freeze({canonicalPath:join(workspace.canonicalPath,pin.path),identity:Object.freeze({dev:pin.dev,ino:pin.ino})}));
  if(roots.length>128 || ancestors.length>128 || roots.some((root,index)=>roots.slice(index+1).some(other=>other.canonicalPath.startsWith(root.canonicalPath+"/"))))fail();
  return {roots:Object.freeze(roots),ancestors:Object.freeze(ancestors)};
}
/** Fixed genuine qualifier branch. It captures current source inputs/exposure,
 * finite capability identities and Unverified history, never NM content bytes.
 * The unchanged global Plan metadata/link guards still run before every launch.
 */
async function qualifyWarmToolClosure(binding:HostedDependencyBinding,attempt:DependencyAttempt,context:CurrentHostedDependencyOrigin,
  startName:string,startBytes:Buffer,profile:DependencyToolProfile,before:HostedDependencyKeyInputs):Promise<HostedDependencyQualifiedToolEntry> {
  const baseline=withHostedActivationFence(fence=>readCurrentHostedDependencyGenerationBaseline(context,fence));
  const readCurrent=(fence:HostedActivationFence,phase:DependencyOwnerPhase.ExclusiveMutation|DependencyOwnerPhase.Running)=>{
    if(!baseline)return readHostedDependencyUsableReceipt(context,fence,phase);
    const current=readCurrentHostedDependencyGenerationBaseline(context,fence);
    if(!current || !encode(current.slot).equals(encode(baseline.slot)) || !encode(current.ready).equals(encode(baseline.ready)) ||
        current.pins.baseline.inputClosureDigest!==before.capture.closureDigest || current.ready.receipt.installKey!==before.key.installKey)fail();
    return {binding:current.binding,attempt:current.attempt,receipt:current.ready,tree:current.tree};
  };
  const first=withHostedActivationFence(fence=>readCurrent(fence,DependencyOwnerPhase.ExclusiveMutation));
  if(!sameDependencyAttempt(first.attempt,attempt) || !encode(first.binding).equals(encode(binding)))fail();
  const source=usableSources(before,binding.workspace);
  let exposure:DependencySourceExposure|undefined;
  try {
    if(source.roots.length) {
      const captured=await captureDependencyLocalRootOnlySourceExposure({roots:source.roots.map(root=>({parentPath:dirname(root.canonicalPath),
        name:root.canonicalPath.slice(dirname(root.canonicalPath).length+1),expectedTree:root.identity})),limits:hostedDependencyObservationLimits});
      if(captured.status===DependencyTreeObservationStatus.Complete)exposure=captured.exposure;
      withHostedActivationFence(fence=>assertCurrentHostedDependencyAttempt(context,fence,DependencyOwnerPhase.ExclusiveMutation));
      if(captured.status!==DependencyTreeObservationStatus.Complete)fail(DependencyAdmissionFailure.UnsafeTree);
    }
    assertInstalledPins(binding.workspace.canonicalPath,profile,before.lockBytes);
    const after=await readHostedDependencyKeyInputs(binding);
    const execution=withHostedActivationFence(fence=>{
      const current=readCurrent(fence,DependencyOwnerPhase.ExclusiveMutation);
      if(!sameDependencyAttempt(current.attempt,attempt) || !encode(current.receipt).equals(encode(first.receipt)) ||
        !sameHostedDependencyKeyInputs(before,after) || !encode(usableSources(before,binding.workspace)).equals(encode(source)) ||
        !readHostedActivationBytes(startName)?.equals(startBytes))fail();
      assertHostedDependencyKeyInputsCurrent(binding,before);assertProfileFiles(profile,binding.jobRootDir);
      assertInstalledPins(binding.workspace.canonicalPath,profile,before.lockBytes);
      if(exposure)assertDependencySourceExposureCurrent(exposure);
      const common={version:2 as const,basis:DependencyToolExecutionBasis.UsableUnverified,
        workspace:binding.workspace,tree:{dev:current.tree.dev,ino:current.tree.ino},installationId:binding.installationId,
        runtimeSha:binding.runtimeSha,grantDigest:binding.grantDigest,bindingSha256:createHash("sha256").update(encode(binding)).digest("hex"),
        startId:attempt.launch.startId,attemptId:attempt.attemptId,epoch:attempt.epoch,receipt:current.receipt.reference,
        receiptRevision:current.receipt.receipt.revision,currentInstallKey:before.key.installKey,inputClosureDigest:before.capture.closureDigest,
        profile,capabilities:[DependencyToolOperation.Optimize,DependencyToolOperation.Test],sourceRoots:source.roots,sourceLookupAncestors:source.ancestors};
      if(!baseline)return parseDependencyToolUsableExecution(common);
      if(current.receipt.receipt.state!==DependencyReceiptState.Ready)fail();
      return parseDependencyToolBaselineExecution({...common,basis:DependencyToolExecutionBasis.BaselineAuthenticated,
        baseline:{ready:readyFacts(current.receipt.receipt,source.roots),readyReference:current.receipt.reference,
          continuity:baseline.slot.baseline,measurement:baseline.qualification.measurement}});
    });
    const qualification=parseDependencyToolAdmissionQualification(execution.basis===DependencyToolExecutionBasis.BaselineAuthenticated ?
      {version:3,kind:DependencyToolQualificationKind.BaselineAuthenticatedV3,execution} :
      {version:2,kind:DependencyToolQualificationKind.UsableUnverifiedV2,execution});
    const qualificationBytes=encode(qualification);if(qualificationBytes.length>16384)fail();
    withHostedActivationFence(fence=>{
      const current=readCurrent(fence,DependencyOwnerPhase.ExclusiveMutation);
      if(!encode(current.receipt).equals(encode(first.receipt)))fail();assertHostedDependencyKeyInputsCurrent(binding,before);
      if(exposure)assertDependencySourceExposureCurrent(exposure);assertProfileFiles(profile,binding.jobRootDir);
      assertInstalledPins(binding.workspace.canonicalPath,profile,before.lockBytes);
      const path=join(policyRoot,dependencyToolQualificationRecordName(attempt.launch.startId));
      const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
      try{writeFileSync(fd,qualificationBytes);fsyncSync(fd);}finally{closeSync(fd);}
      const parent=openSync(dirname(path),constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
      try{fsyncSync(parent);}finally{closeSync(parent);}
      readCurrent(fence,DependencyOwnerPhase.ExclusiveMutation);
    });
    const pin=readQualification(attempt);if(!encode(pin.qualification).equals(encode(qualification)))fail();
    const entry=Object.freeze({startId:attempt.launch.startId});
    const common={binding,attempt,context,startName,startBytes,qualification:pin,inputs:before,readonlySources:source.roots,
      ...(exposure?{exposure}:{}),phase:DependencyOwnerPhase.ExclusiveMutation as const,closed:false};
    if(execution.basis===DependencyToolExecutionBasis.BaselineAuthenticated) {
      if(first.receipt.receipt.state!==DependencyReceiptState.Ready)fail();
      entries.set(entry,{...common,kind:DependencyToolReadyReadStatus.Baseline,receipt:first.receipt.receipt,execution});
    } else {
      if(first.receipt.receipt.state!==DependencyReceiptState.Unverified)fail();
      entries.set(entry,{...common,kind:DependencyToolReadyReadStatus.Usable,receipt:first.receipt.receipt,execution});
    }
    currentQualifiedEntry=entry;
    try{withHostedActivationFence(fence=>bindCurrentHostedDependencyGenerationQualifier(context,fence));}
    catch(error){entries.delete(entry);if(currentQualifiedEntry===entry)currentQualifiedEntry=undefined;
      holdCurrentHostedDependencyGenerationSourceUse(context);throw error;}
    exposure=undefined;return entry;
  }finally{if(exposure)closeDependencySourceExposure(exposure);}
}
function currentAdmission(state:EntryState,fence:HostedActivationFence|undefined,
  phase:DependencyOwnerPhase.ExclusiveMutation|DependencyOwnerPhase.Running):DependencyToolReadyRead {
  if(state.kind===DependencyToolReadyReadStatus.Ready)return Object.freeze({status:DependencyToolReadyReadStatus.Ready,facts:currentReadyEntry(state,phase)});
  const e=state.execution;
  const baseline=state.kind===DependencyToolReadyReadStatus.Baseline ? (fence ? readCurrentHostedDependencyGenerationBaseline(state.context,fence) :
    withHostedActivationFence(current=>readCurrentHostedDependencyGenerationBaseline(state.context,current))) : undefined;
  if(state.kind===DependencyToolReadyReadStatus.Baseline && (!baseline ||
      !sameDependencyProtectedReference(baseline.slot.baseline,state.execution.baseline.continuity) ||
      baseline.pins.baseline.inputClosureDigest!==state.inputs.capture.closureDigest))fail();
  const current=state.kind===DependencyToolReadyReadStatus.Baseline ? (()=>{if(!baseline)fail();return {binding:baseline.binding,attempt:baseline.attempt,receipt:baseline.ready,tree:baseline.tree};})() :
    fence ? readHostedDependencyUsableReceipt(state.context,fence,phase) : currentUsableReadModel(state,phase);
  if(!sameDependencyAttempt(current.attempt,state.attempt) || !encode(current.binding).equals(encode(state.binding)) ||
    !encode(current.receipt.receipt).equals(encode(state.receipt)) || !encode(current.receipt.reference).equals(encode(e.receipt)) ||
    current.tree.dev!==e.tree.dev || current.tree.ino!==e.tree.ino || !readHostedActivationBytes(state.startName)?.equals(state.startBytes))fail();
  assertHostedDependencyKeyInputsCurrent(state.binding,state.inputs);
  if(state.inputs.key.installKey!==e.currentInstallKey || state.inputs.capture.closureDigest!==e.inputClosureDigest ||
    !encode(usableSources(state.inputs,state.binding.workspace)).equals(encode({roots:e.sourceRoots,ancestors:e.sourceLookupAncestors})))fail();
  if(state.exposure)assertDependencySourceExposureCurrent(state.exposure);
  const q=readQualification(state.attempt);
  if(!q.bytes.equals(state.qualification.bytes) || q.dev!==state.qualification.dev || q.ino!==state.qualification.ino ||
    q.ctimeNs!==state.qualification.ctimeNs || q.mtimeNs!==state.qualification.mtimeNs || q.qualification.version!== (state.kind===DependencyToolReadyReadStatus.Baseline?3:2) ||
    !encode(q.qualification.execution).equals(encode(e)))fail();
  assertProfileFiles(e.profile,state.binding.jobRootDir);
  assertInstalledPins(state.binding.workspace.canonicalPath,e.profile,state.inputs.lockBytes);
  if(state.kind===DependencyToolReadyReadStatus.Baseline) {
    if(fence)readCurrentHostedDependencyGenerationBaseline(state.context,fence);
    return Object.freeze({status:DependencyToolReadyReadStatus.Baseline,execution:state.execution});
  }
  if(fence)readHostedDependencyUsableReceipt(state.context,fence,phase);
  return Object.freeze({status:DependencyToolReadyReadStatus.Usable,execution:state.execution});
}
/** This metadata read model starts with the retained ORIGINAL context. It
 * cannot grant execution; every physical effect uses the actual fenced assert.
 */
function currentUsableReadModel(state:UsableEntryState,phase:DependencyOwnerPhase.ExclusiveMutation|DependencyOwnerPhase.Running) {
  const actual=readRetainedHostedDependencyAttemptFacts(state.context,phase);
  if(!encode(readHostedDependencyBinding(state.binding.jobId)).equals(encode(state.binding)))fail();
  const receipt=readHostedDependencyEstablishedReceipt(state.binding);
  if(!receipt || receipt.state!==DependencyReceiptState.Unverified || !encode(receipt).equals(encode(state.receipt)))fail();
  const tree=lstatSync(join(state.binding.workspace.canonicalPath,"node_modules"),{bigint:true});
  if(!tree.isDirectory() || tree.uid!==0n || tree.gid!==0n || (tree.mode&0o700n)!==0o700n)fail();
  return {binding:actual.binding,attempt:actual.attempt,receipt:{receipt,reference:state.execution.receipt},tree:{dev:String(tree.dev),ino:String(tree.ino)}};
}
export function readHostedDependencyQualifiedToolAdmission(entry:HostedDependencyQualifiedToolEntry):DependencyToolReadyRead {
  const state=entryState(entry);if(state.phase!==DependencyOwnerPhase.Running)fail();
  return currentAdmission(state,undefined,DependencyOwnerPhase.Running);
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
  const qualification = parseDependencyToolAdmissionQualification(decodeHostedActivationBytes(bytes)), after = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n || before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode ||
      before.ctimeNs !== after.ctimeNs || before.mtimeNs !== after.mtimeNs || !encode(qualification).equals(bytes)) fail();
  return { qualification, bytes, dev: before.dev, ino: before.ino, ctimeNs: before.ctimeNs, mtimeNs: before.mtimeNs };
}
function entryState(entry: HostedDependencyQualifiedToolEntry): EntryState {
  const state = entries.get(entry); if (!state || state.closed) fail(DependencyAdmissionFailure.StaleAttempt); return state;
}
function currentReadyEntry(state: ReadyEntryState, phase: DependencyOwnerPhase.ExclusiveMutation | DependencyOwnerPhase.Running): DependencyToolReadyFacts {
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
  if(pin.qualification.version!==1)fail();
  assertProfileFiles(pin.qualification.profile, binding.jobRootDir);
  return readyFacts(receipt,state.readonlySources);
}
function readyFacts(receipt:Ready,readonlySources:readonly DependencyToolSourceRoot[]):DependencyToolReadyFacts {
  const identity = { workspace: receipt.workspace, coverageRevision: receipt.coverageRevision, revision: receipt.revision,
    installKey: receipt.installKey, tree: receipt.tree, manifestDigest: receipt.manifestDigest };
  if (receipt.provenance.kind === DependencyInstallProofKind.CompletedLocalInstallV1) return Object.freeze({ ...identity,
    provenance: Object.freeze({ kind: DependencyToolReadyProvenanceKind.LocalCompleted, sourceBinding: receipt.provenance.sourceBinding, readonlySources: readonlySources }) });
  if (receipt.provenance.kind === DependencyInstallProofKind.LegacyCompared) {
    const comparison = assertHostedDependencyLegacyComparedReady({ ...receipt, provenance: receipt.provenance });
    if (comparison.version === 2) return Object.freeze({ ...identity, provenance: Object.freeze({
      kind: DependencyToolReadyProvenanceKind.LocalCompared, comparisonEvidenceId: receipt.provenance.comparisonEvidenceId,
      sourceBinding: comparison.candidateSourceBinding, readonlySources: readonlySources }) });
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
  if(state.kind===DependencyToolReadyReadStatus.Ready)state.placement.assertCurrent(fence);
  currentAdmission(state,fence,phase);
}
/** Reads the one baseline; it cannot capture a replacement or mint a handle. */
export function readHostedDependencyQualifiedToolEntry(entry: HostedDependencyQualifiedToolEntry): DependencyToolReadyFacts {
  const state = entryState(entry); if (state.phase !== DependencyOwnerPhase.Running) fail(DependencyAdmissionFailure.StaleAttempt);
  if(state.kind!==DependencyToolReadyReadStatus.Ready)fail();
  return currentReadyEntry(state, DependencyOwnerPhase.Running);
}
/** Only genuine Running CAS/readback changes the private logical phase. */
export function markHostedDependencyQualifiedToolEntryRunning(entry: HostedDependencyQualifiedToolEntry, fence: HostedActivationFence): void {
  const state = entryState(entry); assertHostedActivationFence(fence);
  const actual = assertCurrentHostedDependencyAttempt(state.context,fence,DependencyOwnerPhase.Running);
  if (state.phase !== DependencyOwnerPhase.ExclusiveMutation || !sameDependencyAttempt(actual.attempt,state.attempt) || !selectedStart(actual.facts).bytes.equals(state.startBytes)) fail(DependencyAdmissionFailure.StaleAttempt);
  if(state.kind===DependencyToolReadyReadStatus.Ready)state.placement.assertCurrent(fence);
  currentAdmission(state,fence,DependencyOwnerPhase.Running); state.phase = DependencyOwnerPhase.Running;
}
/** Logical revocation on uncertain/terminal use. Never releases durable owner;
 * the existing supervisor must still prove queue/provider/installer drain. */
export function invalidateHostedDependencyQualifiedToolEntry(entry: HostedDependencyQualifiedToolEntry | undefined): void {
  if (!entry) return;
  const state = entries.get(entry); if (!state || state.closed) return;
  if(state.phase===DependencyOwnerPhase.Running || state.phase===DependencyOwnerPhase.ExclusiveMutation) {
    try { withHostedActivationFence(fence=>{currentAdmission(state,fence,state.phase);prepareCurrentHostedDependencyGenerationSourceRetirement(state.context,fence);}); }
    catch { holdCurrentHostedDependencyGenerationSourceUse(state.context); }
  }
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
    if(q.version===1)assertQualification(q,binding,attempt,entry);
    else {
      if(!entry)fail();const state=entryState(entry);if(state.kind!==DependencyToolReadyReadStatus.Usable && state.kind!==DependencyToolReadyReadStatus.Baseline)fail();
      currentAdmission(state,fence,DependencyOwnerPhase.Running);
      if(!encode(q.execution).equals(encode(state.execution)))fail();
    }
    assertProfileFiles(profile,binding.jobRootDir);return dependencyToolAdmittedGuestConfig(q);
  });
}
export function hostedDependencyToolInstruction(config: DependencyToolGuestConfig, entry?: HostedDependencyQualifiedToolEntry): string {
  const quote = (v: string) => `'${v.replaceAll("'", `'\\''`)}'`;
  const command = `${quote(config.profile.node.path)} ${quote(config.profile.helper.path)}`;
  const admitted=entry ? readHostedDependencyQualifiedToolAdmission(entry) : undefined;
  const local=(admitted?.status===DependencyToolReadyReadStatus.Usable || admitted?.status===DependencyToolReadyReadStatus.Baseline) ? admitted.execution.sourceRoots.length>0 :
    admitted?.status===DependencyToolReadyReadStatus.Ready && [DependencyToolReadyProvenanceKind.LocalCompleted,DependencyToolReadyProvenanceKind.LocalCompared].includes(admitted.facts.provenance.kind);
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
export type HostedDependencyRootQualification=Readonly<{
  context:CurrentHostedDependencyOrigin;binding:HostedDependencyBinding;attempt:DependencyAttempt;inputs:HostedDependencyKeyInputs;
  readonlySources:readonly DependencyToolSourceRoot[];phase:DependencyOwnerPhase.ExclusiveMutation|DependencyOwnerPhase.Running;
}> & (Readonly<{status:DependencyToolReadyReadStatus.Ready;receipt:Ready;providerReady:DependencyToolReadyFacts}> |
  Readonly<{status:DependencyToolReadyReadStatus.Usable;receipt:UsableEntryState["receipt"];execution:DependencyToolUsableExecution}> |
  Readonly<{status:DependencyToolReadyReadStatus.Baseline;receipt:Ready;execution:DependencyToolBaselineExecution}>);
export function readCurrentHostedDependencyRootQualification(fence:HostedActivationFence):HostedDependencyRootQualification {
  if(!currentQualifiedEntry)fail(DependencyAdmissionFailure.StaleAttempt);
  const state=entryState(currentQualifiedEntry);assertHostedDependencyQualifiedToolEntry(currentQualifiedEntry,fence,state.phase);
  const common={context:state.context,binding:state.binding,attempt:state.attempt,inputs:state.inputs,readonlySources:state.readonlySources,phase:state.phase};
  if(state.kind===DependencyToolReadyReadStatus.Ready)return Object.freeze({...common,status:DependencyToolReadyReadStatus.Ready,
    receipt:state.receipt,providerReady:currentReadyEntry(state,state.phase)});
  currentAdmission(state,fence,state.phase);
  if(state.kind===DependencyToolReadyReadStatus.Baseline)return Object.freeze({...common,status:DependencyToolReadyReadStatus.Baseline,receipt:state.receipt,execution:state.execution});
  return Object.freeze({...common,status:DependencyToolReadyReadStatus.Usable,receipt:state.receipt,execution:state.execution});
}

/** Internal fixed original-map association. No entry/exposure/input/ref DTO can
 * register a warm use; only this module's actual completed private entry counts. */
export function readOriginalHostedDependencyQualifiedBaselineSourceUse(context:CurrentHostedDependencyOrigin,fence:HostedActivationFence,access:symbol): {inputs:HostedDependencyKeyInputs;execution:DependencyToolUsableExecution|DependencyToolBaselineExecution;exposure?:DependencySourceExposure;qualification:ReturnType<typeof readHostedDependencyCommittedReady>["reference"]} {
  const generation=findOriginalHostedDependencyGenerationState(context,access);if(!generation || !currentQualifiedEntry)fail();
  const state=entryState(currentQualifiedEntry);if(state.context!==context || (state.kind!==DependencyToolReadyReadStatus.Baseline && state.kind!==DependencyToolReadyReadStatus.Usable) || state.phase!==DependencyOwnerPhase.ExclusiveMutation)fail();
  currentAdmission(state,fence,state.phase);
  const pin=state.qualification;
  return {inputs:state.inputs,execution:state.execution,...(state.exposure?{exposure:state.exposure}:{}),
    qualification:{path:join(policyRoot,dependencyToolQualificationRecordName(state.attempt.launch.startId)),identity:{dev:String(pin.dev),ino:String(pin.ino)},sha256:createHash("sha256").update(pin.bytes).digest("hex")}};
}

/** Actual completed cold qualifier only. Its authored-source exposure is owned
 * by this private entry; the consumed NM observation is never a live-use grant. */
export function readOriginalHostedDependencyQualifiedColdSourceUse(context:CurrentHostedDependencyOrigin,fence:HostedActivationFence,access:symbol): {inputs:HostedDependencyKeyInputs;exposure?:DependencySourceExposure;qualification:ReturnType<typeof readHostedDependencyCommittedReady>["reference"]} {
  const generation=findOriginalHostedDependencyGenerationState(context,access);if(!generation || !currentQualifiedEntry)fail();
  const state=entryState(currentQualifiedEntry);if(state.context!==context || state.kind!==DependencyToolReadyReadStatus.Ready || state.phase!==DependencyOwnerPhase.ExclusiveMutation)fail();
  assertCurrentHostedDependencyAttempt(context,fence,state.phase);currentReadyEntry(state,state.phase);
  const pin=state.qualification;
  return {inputs:state.inputs,...(state.exposure?{exposure:state.exposure}:{}),
    qualification:{path:join(policyRoot,dependencyToolQualificationRecordName(state.attempt.launch.startId)),identity:{dev:String(pin.dev),ino:String(pin.ino)},sha256:createHash("sha256").update(pin.bytes).digest("hex")}};
}
