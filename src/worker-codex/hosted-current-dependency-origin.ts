import { openOriginalHostedDependencyRootDescriptorMaterial, openOriginalHostedManagedProviderDescriptorMaterial } from "./hosted-dependency-root-descriptor-opener";
import { finishOriginalHostedDependencyColdTree, revokeOriginalHostedDependencyColdState } from "./hosted-dependency-cold-controller";
import { HostedDependencyColdPhase, HostedDependencyColdInstallerPhase, type HostedDependencyColdState } from "./hosted-dependency-cold-materialization-state";
import { DependencyAdmissionError, DependencyAdmissionFailure } from "@vioxen/subscription-runtime/worker-core";
import { withHostedActivationFence } from "./hosted-dependency-activation";
import { observedProcessCgroup } from "./hosted-readonly-observations";
import { assertHostedDependencyRetirementOwnerFacts, assertHostedDependencyRetirementSuccessorFacts } from "./hosted-dependency-retirement-facts";
import { createOriginalHostedSessionRuntimeComposition, type OriginalHostedSessionRuntimeCompositionInput } from "./hosted-managed-dependency-runtime-composition";
import { OriginalHostedOrdinaryProviderTerminal } from "./hosted-ordinary-provider-terminal-view";
import { publishOriginalHostedOrdinaryProviderCompletion, assertOriginalHostedOrdinaryProviderCompletion } from "./hosted-ordinary-provider-completion-record";
import { HostedInstallationActivationStore } from "./hosted-installation-activation";
import { readOriginalHostedOrdinaryProviderBirthFacts } from "./hosted-ordinary-dependency-provider-facts";
import { formHostedDependencyRootScopeFacts } from "./hosted-dependency-root-scope-facts";
import { readOriginalHostedDependencyRootPreparation, readOriginalHostedDependencyRootReady as currentRootReady } from "./hosted-dependency-root-physical-selection";
import { consumeHostedOrdinaryDependencyPreclaim, readHostedOrdinaryDependencyPreclaim, readHostedOrdinaryDependencyReaderEntry } from "./hosted-ordinary-dependency-reader";
import { copyBoundedHostedByteInput } from "./hosted-bounded-byte-input";
import { captureManagedSessionArtifactFacts, captureManagedSessionMaterializationInput, captureManagedSessionWriteIntent, assertManagedSessionCredentialWritebackFacts, assertManagedSessionDischargedFacts as assertSessionExecutionUseDischarged } from "./hosted-managed-dependency-session-artifact-facts";
import { formManagedDependencyProviderStartFacts } from "./hosted-managed-provider-start-facts";
import { formManagedDependencyHomePreparationFacts } from "./hosted-managed-dependency-home-recipe-facts";
import { assertHostedDependencyRootDirectoryPinFacts as assertDirectory, assertHostedDependencyRootDescriptorCensus as assertRootPurposeDescriptors } from "./hosted-dependency-root-physical-facts";
import { requiresCurrentHostedDependencyRootPurpose as classifyCurrentHostedDependencyRootPurpose, isHostedManagedReadonlyOuterRuntime, collectCurrentHostedOrdinaryDependencyOrigin, rootIdentity, currentSessionModelExecutable, readHostedDependencyAttemptFacts as attemptFromFacts } from "./hosted-dependency-current-facts";
import { publishCurrentHostedManagedDependencyProvider } from "./hosted-managed-provider-start-record";
import { publishOriginalHostedManagedProviderTerminal } from "./hosted-managed-provider-completion-record";
import { OriginalHostedDependencyRootPurpose as RootPurposeFacade } from "./hosted-dependency-root-purpose-view";
import { writeOriginalHostedDependencySessionAuth as writeCurrentHostedDependencySessionAuth, snapshotOriginalHostedDependencySessionAuth as snapshotCurrentHostedDependencySessionAuth, snapshotOriginalHostedDependencySessionAuthWithHeldFence } from "./hosted-managed-dependency-session-auth";
import { collectOriginalHostedDependencySessionModelsAfterDrain } from "./hosted-managed-dependency-model-probe";
import { formManagedSessionModelProbeCommand, formManagedSessionRefreshCommand } from "./hosted-managed-dependency-session-command-facts";
import { codexAuthJsonFromArtifact, sessionArtifactFromCodexAuthJson } from "../provider-codex/codex-auth-json-codec";
import { SessionExecutionUseDisposition, type SessionExecutionUse, type SessionExecutionLifecyclePort, type LeaseStorePort, type SessionStorePort, type SessionArtifact, type RedactorPort } from "@vioxen/subscription-runtime/core";
import { ManagedSessionUsePhase, ManagedSessionModelCatalogEvidence, type RootPurposeState } from "./hosted-managed-dependency-session-state";
import { OriginalHostedDependencySessionHome as ManagedSessionHomeFacade } from "./hosted-managed-dependency-home-view";
import { freezeFacts } from "./hosted-dependency-immutable-facts";
import { OriginalHostedDependencyRootDescriptor as RootDescriptor } from "./hosted-dependency-root-resource-view";
import { awaitPrivateManagedProviderClose, HostedManagedProviderWaitDeadline } from "./hosted-managed-provider-wait-deadline";
import { preparePhysicalOriginalHostedDependencySessionHome } from "./hosted-managed-dependency-home-preparation";
import { readHostedDependencyRootDirectoryPin, assertHostedDependencyRootDescriptorMaterial, closePhysicalHostedDependencyRootDescriptor } from "./hosted-dependency-root-physical-facts";
export { readHostedDependencyRootDirectoryPin } from "./hosted-dependency-root-physical-facts";
import { collectActualHostedManagedReadonlyOrigin } from "./hosted-managed-readonly-origin-collector";
import { createHostedManagedDependencySdkView } from "./hosted-managed-dependency-sdk-view";
import { hostedManagedDependencyProviderInvocation, bindHostedDependencyToolChild, abandonHostedDependencyToolInvocation, assertHostedManagedDependencyToolRelease } from "./hosted-managed-dependency-tool-plan";
import { sameHostedDependencyStatFacts as sameStat } from "./hosted-dependency-stat-facts";
import { spawnHostedFdChild, hostedFdLaunch } from "../provider-codex/app-server/adapters/hosted-fd-launch";
import { retryHostedFenceAcquisition } from "../provider-codex/app-server/adapters/hosted-fd-fence";
import { signalHostedSystemdUnit, type CodexAppServerChildProcess } from "../provider-codex/app-server/adapters/node-app-server-process";
import { formManagedProviderWaitFacts } from "./hosted-managed-provider-wait-facts";
import { createHash } from "node:crypto";
import { codexProviderEgressEnv, codexProviderEgressPolicy, CodexProviderEgressProfileId } from "../provider-codex/codex-provider-egress-policy";
import { collectUnitInvocation } from "./hosted-readonly-linux-collector";
import { type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readSync, writeFileSync, type BigIntStats } from "node:fs";
import { dirname } from "node:path";
import { DependencyToolReadyProvenanceKind, DependencyOwnerPhase, isDependencyConsumerOwner, parseDependencyOwner, sameDependencyProtectedReference, sameDependencyWorkspace, sameDependencyAttempt, parseDependencyGenerationContinuityInvalidation, type DependencyProtectedReference } from "@vioxen/subscription-runtime/core";
import { HostedCustodyReservationState } from "../worker-core/hosted-custody/domain/hosted-custody-epoch";
import { assertHostedActivationFence, assertHostedActivationOperator, decodeHostedActivationBytes, readHostedActivationBytes, readHostedOrdinaryProcessOrigin, readHostedOrdinaryProviderFacts, HostedOrdinaryProviderReadPhase, type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { type HostedDependencyBinding } from "./hosted-dependency-workspace";
import { assertHostedProcessDescriptors } from "../provider-codex/app-server/adapters/hosted-process-descriptors";
import { assertHostedRetainedToolDescriptors, type HostedRetainedToolFiles } from "../provider-codex/app-server/adapters/hosted-retained-tool-files";
import { observeHostedFdProcess } from "../provider-codex/app-server/adapters/hosted-fd-observation";
import { systemdObservationBudget } from "../provider-codex/app-server/adapters/systemd-service-arrays";
import { assertHostedFdProcess, HostedFdLaunchKind } from "../provider-codex/app-server/adapters/hosted-fd-child";
import { hostedDependencySystemdRunExecutable } from "../provider-codex/app-server/adapters/hosted-dependency-systemd-command";
import { LocalDependencyReceiptStore } from "../store-local-file/dependency-environment/local-dependency-receipt-store";
import { LocalDependencyOwnerStore } from "../store-local-file/dependency-environment/local-dependency-owner-store";
import { invalidateDependencyGeneration } from "../worker-core/dependency-environment/application/invalidate-dependency-generation";
import { DependencyUnverifiedReason, DependencyReceiptState } from "../worker-core/dependency-environment/domain/dependency-receipt";
import { hostedDependencyReceiptHistoryRoot } from "../provider-codex/app-server/adapters/hosted-dependency-history-path";
import { dependencyToolQualificationRecordName, dependencyToolGuestConfig, dependencyToolGuestConfigPath, parseDependencyToolQualification } from "../core/dependency-environment/dependency-tool-profile";
import { HostedDependencyRootDescriptorRecipe } from "../provider-codex/app-server/adapters/hosted-dependency-root-descriptor-material";
export { HostedDependencyRootDescriptorRecipe } from "../provider-codex/app-server/adapters/hosted-dependency-root-descriptor-material";
import { HostedDependencyRootOriginKind, HostedDependencyRootPurpose, isHostedDependencySignedTaskId, type HostedDependencyManagedGitScope, type HostedDependencyRootScope, type HostedDependencyManagedProviderFacts, type HostedDependencyRootDirectoryPin, type HostedDependencyRootPreparationRecord } from "../provider-codex/app-server/adapters/hosted-dependency-root-purpose-record";
export { HostedDependencyRootPurpose, isHostedDependencySignedTaskId } from "../provider-codex/app-server/adapters/hosted-dependency-root-purpose-record";
export type { HostedDependencyManagedGitScope, HostedDependencyRootScope, HostedDependencyRootDirectoryPin } from "../provider-codex/app-server/adapters/hosted-dependency-root-purpose-record";
const root = "/var/lib/subscription-runtime-host-policy", transport = "/run/user/0/subscription-runtime-host-policy";
const brand: unique symbol = Symbol("hosted.current.dependency.origin");
export type CurrentHostedDependencyOrigin = Readonly<{ [brand]: true }>;
export enum CurrentHostedDependencyOriginKind { Ordinary = "ordinary", ManagedReadonlyLocal = "managed_readonly_local" }
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
function invalid(): never { throw new Error("hosted_dependency_current_origin_unresolved"); }
const contexts = new WeakMap<CurrentHostedDependencyOrigin, { digest: string; facts: CurrentHostedDependencyOriginFacts; scope?: HostedRetainedToolFiles; rootPurpose?: RootPurposeState; ordinaryEntry?: Readonly<{attempt: ReturnType<typeof attemptFromFacts>["attempt"]; producer:DependencyProtectedReference; entry:DependencyProtectedReference}>; ordinaryAdmitted?:boolean; cold?:HostedDependencyColdState }>();
let currentEntryOrigin:CurrentHostedDependencyOrigin|undefined;
/** PRIVATE selected-path reader. Only names derived below from independently pinned start/installation are used; no exported arbitrary-path read port. */
function selectedFile(path: string, maximum: number, privateFile = true) {
  if (!/^\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/.test(path) || path.split("/").some(p => p === "." || p === "..")) invalid();
  const ancestors: { path: string; stat: BigIntStats }[] = [];
  for (let p = dirname(path);; p = dirname(p)) {
    const stat = lstatSync(p, { bigint: true });
    if (!stat.isDirectory() || stat.uid !== 0n || (stat.mode & 0o022n) ||
        (privateFile && p === dirname(path) && (stat.mode & 0o077n))) invalid();
    ancestors.push({ path: p, stat }); if (p === "/") break;
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true }), entry = lstatSync(path, { bigint: true });
    if (!before.isFile() || before.uid !== 0n || before.nlink !== 1n || (before.mode & (privateFile ? 0o077n : 0o022n)) ||
        before.size < 1n || before.size > BigInt(maximum) || !sameStat(before,entry)) invalid();
    const bytes = Buffer.alloc(Number(before.size) + 1); let length = 0;
    while (length < bytes.length) { const count = readSync(fd,bytes,length,bytes.length-length,length); if (!count) break; length += count; }
    if (BigInt(length) !== before.size || !sameStat(before,fstatSync(fd,{bigint:true})) || !sameStat(before,lstatSync(path,{bigint:true}))) invalid();
    for (const p of ancestors) { const now = lstatSync(p.path,{bigint:true});
      if (!now.isDirectory() || now.dev !== p.stat.dev || now.ino !== p.stat.ino || now.uid !== p.stat.uid || now.mode !== p.stat.mode) invalid(); }
    const data = bytes.subarray(0,length), reference: DependencyProtectedReference = { path,
      identity:{dev:String(before.dev),ino:String(before.ino)},sha256:hash(data) };
    return { bytes:data, reference };
  } finally { closeSync(fd); }
}
function fixed(name: string, maximum = 65536) { return selectedFile(`${root}/${name}`,maximum); }
function material(expected: DependencyProtectedReference, path: string, maximum = 262144, privateFile = true) {
  if (expected.path !== path) invalid(); const pin = selectedFile(path,maximum,privateFile);
  if (!sameDependencyProtectedReference(pin.reference,expected)) invalid(); return pin;
}
function assertSelectedDescriptors(scope:HostedRetainedToolFiles|undefined, purpose:RootPurposeState|undefined):void {
  if (purpose?.descriptors.size) { if (scope !== undefined) invalid(); assertRootPurposeDescriptors([...purpose.descriptors.values()]); }
  else if (scope === undefined) assertHostedProcessDescriptors(); else assertHostedRetainedToolDescriptors(scope);
}
function selectedSnapshot(fence: HostedActivationFence, scope?: HostedRetainedToolFiles, rootPurpose?: RootPurposeState,cold?:HostedDependencyColdState) {
  assertHostedActivationFence(fence); assertHostedActivationOperator();
  // Only the same privately retained actual FDA Installer role participates.
  // Generic/regular FD census is unchanged; no supplied descriptor exemptions.
  if(cold?.installerFrame && cold.installerPhase!==HostedDependencyColdInstallerPhase.Waited) {
    const frame=cold.installerFrame;assertHostedFdProcess(frame.child,frame.unit,HostedFdLaunchKind.Installer,frame.command,frame.args);
  }
  const group = observedProcessCgroup(readFileSync("/proc/self/cgroup","utf8"));
  if (/^0::\/subscription\.slice\/subscription-runtime\.slice\/subscription-runtime-hosted\.slice\/subscription-runtime-ordinary-[a-f0-9-]{36}\.service$/.test(group)) {
    assertSelectedDescriptors(scope,rootPurpose);
    const before = collectCurrentHostedOrdinaryDependencyOrigin(fence);
    assertSelectedDescriptors(scope,rootPurpose);
    const after = collectCurrentHostedOrdinaryDependencyOrigin(fence);
    if (before.digest !== after.digest) invalid(); return after;
  }
  const before = collectActualHostedManagedReadonlyOrigin(fence);
  assertSelectedDescriptors(scope,rootPurpose);
  const after = collectActualHostedManagedReadonlyOrigin(fence);
  if (after.digest !== before.digest) invalid();
  return after;
}
export type CurrentHostedDependencyOriginFacts = ReturnType<typeof selectedSnapshot>["facts"];
/** Fixed process/history identity only; consumers still join actual owner. */
export function readCurrentHostedDependencyOrigin(fence: HostedActivationFence, scope?: HostedRetainedToolFiles): CurrentHostedDependencyOrigin {
  if (currentEntryOrigin) { const retained = contexts.get(currentEntryOrigin);
    if (!retained?.ordinaryEntry || scope !== undefined) invalid();
    assertCurrentHostedDependencyOrigin(currentEntryOrigin,fence); return currentEntryOrigin; }
  const selected = selectedSnapshot(fence,scope), context = Object.freeze({[brand]:true as const});
  contexts.set(context,{digest:selected.digest,facts:freezeFacts(selected.facts),...(scope ? {scope}: {})}); return context;
}
export function assertCurrentHostedDependencyOrigin(context: CurrentHostedDependencyOrigin, fence: HostedActivationFence): CurrentHostedDependencyOriginFacts {
  const retained = contexts.get(context); if (!retained) invalid();
  const current = selectedSnapshot(fence,retained.scope,retained.rootPurpose,retained.cold); if (current.digest !== retained.digest) invalid(); return current.facts;
}
/** Classification after preparation uses the SAME original authority and FD
 * associations, rather than falling back to the generic strict descriptor view. */
export function requiresCurrentHostedDependencyRootPurpose():boolean {
  if (!currentEntryOrigin) return classifyCurrentHostedDependencyRootPurpose();
  return withHostedActivationFence(fence => { const retained = contexts.get(currentEntryOrigin!); if (!retained?.ordinaryEntry) invalid();
    const actual = assertCurrentHostedDependencyOrigin(currentEntryOrigin!,fence); if (actual.kind !== CurrentHostedDependencyOriginKind.Ordinary) invalid(); return true; });
}
export function readCurrentHostedOrdinaryDependencyReaderEntry(context:CurrentHostedDependencyOrigin,fence:HostedActivationFence,phase:DependencyOwnerPhase) {
  const retained = contexts.get(context); if (!retained?.ordinaryEntry || currentEntryOrigin !== context) invalid();
  const actual = readHostedOrdinaryDependencyReaderEntry(context,fence,phase);
  if (!sameDependencyAttempt(actual.attempt,retained.ordinaryEntry.attempt) || !sameDependencyProtectedReference(actual.producer,retained.ordinaryEntry.producer) ||
      !sameDependencyProtectedReference(actual.entry,retained.ordinaryEntry.entry)) invalid(); return actual;
}
/** Fixed actual C entry before layout/auth/source effects. The lexical pointer
 * only refers back to the original map; it has no independent grant state. */
export function enterCurrentHostedOrdinaryDependencyReader():void {
  if (isHostedManagedReadonlyOuterRuntime() || !requiresCurrentHostedDependencyRootPurpose()) return;
  withHostedActivationFence(fence => {
    if (currentEntryOrigin) { const retained = contexts.get(currentEntryOrigin);
      if (!retained?.ordinaryEntry) invalid(); assertCurrentHostedDependencyOrigin(currentEntryOrigin,fence); return; }
    const context = readCurrentHostedDependencyOrigin(fence), facts = assertCurrentHostedDependencyOrigin(context,fence);
    if (facts.kind !== CurrentHostedDependencyOriginKind.Ordinary) invalid();
    const entry = consumeHostedOrdinaryDependencyPreclaim(context,fence), retained = contexts.get(context); if (!retained) invalid();
    retained.ordinaryEntry = freezeFacts(entry); currentEntryOrigin = context;
  });
}
/** Once actual execution admission, distinct from idempotent internal layout
 * calls. A second task entry cannot reuse the first reader's claim. */
export function consumeCurrentHostedOrdinaryDependencyExecution(fence:HostedActivationFence) {
  const context = currentEntryOrigin, retained = context && contexts.get(context);
  if (!context || !retained?.ordinaryEntry || retained.ordinaryAdmitted) invalid();
  const actual = readHostedOrdinaryDependencyPreclaim(context,fence);
  if (!sameDependencyAttempt(actual.attempt,retained.ordinaryEntry.attempt) ||
      !sameDependencyProtectedReference(actual.producer,retained.ordinaryEntry.producer)) invalid();
  material(retained.ordinaryEntry.entry,`${root}/dependency-reader-entries/${actual.attempt.launch.startId}.json`,4096);
  retained.ordinaryAdmitted = true; return actual.attempt;
}
export function invalidateCurrentHostedDependencyOrigin(context: CurrentHostedDependencyOrigin): void {
  const retained = contexts.get(context); let failure: unknown;
  try {revokeOriginalHostedDependencyColdState(context,rootInternalAccess);}catch(error){failure=error;}
  const provider = retained?.rootPurpose?.provider;
  if (provider?.child) { provider.stopping = true;
    try { hostedFdLaunch(provider.child).invalidate(); } catch (error) { failure = error; }
  }
  // Resource revocation is cleanup only. Delete authority even if physical close
  // fails, so no failed revocation can leave a future helper permit alive.
  try { for (const descriptor of [...(retained?.rootPurpose?.descriptors.keys() ?? [])]) {
    try { descriptor.close(); } catch (error) { failure ??= error; }
  } } finally { contexts.delete(context); if (currentEntryOrigin === context) currentEntryOrigin = undefined; if (currentRootOrigin === context) currentRootOrigin = undefined; }
  if (failure !== undefined) throw failure;
}
export type CurrentHostedManagedDependencyProvider = HostedDependencyManagedProviderFacts;
function managedProviderBirth(context: CurrentHostedDependencyOrigin, fence: HostedActivationFence, unit: string): CurrentHostedManagedDependencyProvider {
  const retained = contexts.get(context); if (!retained?.rootPurpose) invalid();
  assertCurrentHostedDependencyRootPurpose(retained.rootPurpose.managed,HostedDependencyRootPurpose.ManagedGitReadV1,fence);
  const actual = assertCurrentHostedDependencyAttempt(context,fence,DependencyOwnerPhase.Running);
  if (!sameDependencyAttempt(actual.attempt,retained.rootPurpose.record.attempt)) invalid();
  const match = /^subscription-runtime-hosted-([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\.service$/.exec(unit);
  if (!match || match[0] !== unit) invalid(); const providerStartId = match[1]!;
  if (actual.facts.kind===CurrentHostedDependencyOriginKind.Ordinary) return readOriginalHostedOrdinaryProviderBirthFacts(context,fence,unit);
  const ready = currentRootReady(context,fence);
  if (!encode(ready).equals(encode(retained.rootPurpose.ready))) invalid();
  const record = retained.rootPurpose.record;
  return formManagedDependencyProviderStartFacts(actual,providerStartId,record,ready);
}
export function readCurrentHostedManagedDependencyProviderParent(context: CurrentHostedDependencyOrigin, fence: HostedActivationFence) {
  const state = contexts.get(context)?.rootPurpose; if (!state) invalid();
  assertCurrentHostedDependencyRootPurpose(state.managed,HostedDependencyRootPurpose.ManagedGitReadV1,fence);
  const actual = assertCurrentHostedDependencyAttempt(context,fence);
  if (actual.facts.kind === CurrentHostedDependencyOriginKind.Ordinary) readCurrentHostedOrdinaryDependencyReaderEntry(context,fence,DependencyOwnerPhase.Running);
  return Object.freeze({binding:actual.binding,attempt:actual.attempt,facts:actual.facts});
}
export function readOriginalHostedManagedProviderBirthFacts(context:CurrentHostedDependencyOrigin,fence:HostedActivationFence,unit:string) {
  return managedProviderBirth(context,fence,unit);
}
export { publishCurrentHostedManagedDependencyProvider } from "./hosted-managed-provider-start-record";
/** Fresh running parent and owned reservation; returned facts grant no child. */
export function readCurrentHostedManagedDependencyProvider(context: CurrentHostedDependencyOrigin, fence: HostedActivationFence, unit: string) {
  const current = managedProviderBirth(context,fence,unit), pin = fixed(`dependency-managed-provider-starts/${current.providerStartId}.json`,16384);
  if (!pin.bytes.equals(encode(current))) invalid();
  const after = managedProviderBirth(context,fence,unit); if (!encode(after).equals(pin.bytes)) invalid();
  return Object.freeze({value:current,reference:pin.reference});
}
/** The original-map entry owns the fixed cold invocation before any final
 * observation. No caller observation/Ready setter or second provenance map. */
export async function materializeCurrentHostedDependencyColdTree(context:CurrentHostedDependencyOrigin):Promise<Readonly<{startId:string}>|undefined> {
  if(!contexts.has(context))coldInvalid();
  withHostedActivationFence(fence=>{
    const actual=assertCurrentHostedDependencyAttempt(context,fence,DependencyOwnerPhase.ExclusiveMutation),retained=contexts.get(context);
    if(!retained || retained.cold) coldInvalid();
    retained.cold={phase:HostedDependencyColdPhase.Producing,binding:actual.binding,attempt:actual.attempt};
  });
  return finishOriginalHostedDependencyColdTree(context,rootInternalAccess);
}
export { assertOriginalHostedDependencyColdProducer, readOriginalHostedDependencyColdSelection } from "./hosted-dependency-cold-controller";
/** Internal association access only; no caller can create/replace a capture,
 * Plan or child through this function or obtain the lexical access symbol. */
export function findOriginalHostedDependencyColdState(context:CurrentHostedDependencyOrigin,access:symbol):HostedDependencyColdState|undefined {
  if(access!==rootInternalAccess)coldInvalid();return contexts.get(context)?.cold;
}
export function readOriginalHostedDependencyColdInstallerState(context:CurrentHostedDependencyOrigin,access:symbol):HostedDependencyColdState {
  if(access!==rootInternalAccess)coldInvalid();const state=contexts.get(context)?.cold;if(!state)coldInvalid();return state;
}
export { finishOriginalHostedDependencyColdInstaller as installCurrentHostedDependencyColdTree } from "./hosted-dependency-cold-controller";
export { consumeCurrentHostedDependencyColdHandoff, assertCurrentHostedDependencyConsumedColdHandoff,
  closeCurrentHostedDependencyColdHandoff } from "./hosted-dependency-cold-handoff-view";
function coldInvalid():never {throw new DependencyAdmissionError(DependencyAdmissionFailure.StaleAttempt);}

/** Fixed provider resources belong solely to the original-origin entry. */
export function prepareCurrentHostedManagedDependencyProviderTools(context: CurrentHostedDependencyOrigin, fence: HostedActivationFence, unit: string) {
  const selected = readCurrentHostedManagedDependencyProvider(context,fence,unit), state = contexts.get(context)?.rootPurpose;
  if (!state || state.provider) invalid();
  assertCurrentHostedDependencyRootPurpose(state.managed,HostedDependencyRootPurpose.ManagedGitReadV1,fence);
  const providerRoot = `${root}/dependency-provider-roots/${selected.value.providerStartId}`;
  const rootPin = readHostedDependencyRootDirectoryPin(providerRoot), stat = lstatSync(providerRoot);
  if (stat.uid !== 0 || stat.gid !== 0 || (stat.mode & 0o7777) !== 0o700) invalid();
  const qualification = material(state.record.qualification,`${root}/${dependencyToolQualificationRecordName(selected.value.parentStartId)}`,16384);
  const q = parseDependencyToolQualification(decodeHostedActivationBytes(qualification.bytes));
  const capsulePath = providerRoot+dependencyToolGuestConfigPath, bytes = encode(dependencyToolGuestConfig(q));
  const parentPin = readHostedDependencyRootDirectoryPin(dirname(capsulePath));
  if (!dirname(capsulePath).startsWith(providerRoot+"/") || parentPin.dev !== rootPin.dev || parentPin.mountId !== rootPin.mountId) invalid();
  const fd = openSync(capsulePath,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try { writeFileSync(fd,bytes); fsyncSync(fd); } finally { closeSync(fd); }
  const parentFd = openSync(dirname(capsulePath),constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try { fsyncSync(parentFd); } finally { closeSync(parentFd); }
  const opened: RootDescriptor[] = [];
  try {
    const associate = (path: string) => {
      const physical = openOriginalHostedManagedProviderDescriptorMaterial(context,fence,unit,path,rootInternalAccess);
      const resource = new RootDescriptor(context,physical,rootInternalAccess); state.descriptors.set(resource,physical);
      opened.push(resource); Object.freeze(resource); return resource;
    };
    const record = associate(state.record.qualification.path);
    const capsule = associate(capsulePath);
    if ((fstatSync(record.fd).mode & 0o7777) !== 0o600 || (fstatSync(capsule.fd).mode & 0o7777) !== 0o600 ||
        !readManagedProviderDescriptor(record.fd).equals(qualification.bytes) || !readManagedProviderDescriptor(capsule.fd).equals(bytes)) invalid();
    state.provider = {unit,reference:selected.reference,root:rootPin,qualification:freezeFacts(q),ready:state.record.providerReady,record,capsule,capsulePath};
    return readCurrentHostedManagedDependencyProviderTools(context,fence,unit);
  } catch (error) { delete state.provider; for (const resource of opened.reverse()) resource.close(); throw error; }
}
/** Finite-root facts rejoin before/after use; no caller ReadyReader. */
export function readCurrentHostedManagedDependencyProviderTools(context: CurrentHostedDependencyOrigin, fence: HostedActivationFence, unit: string) {
  const selected = readCurrentHostedManagedDependencyProvider(context,fence,unit), state = contexts.get(context)?.rootPurpose;
  const provider = state?.provider;
  if (!state || !provider || provider.unit !== unit || !sameDependencyProtectedReference(provider.reference,selected.reference) ||
      !encode(readHostedDependencyRootDirectoryPin(provider.root.canonicalPath)).equals(encode(provider.root))) invalid();
  const qualification = material(state.record.qualification,`${root}/${dependencyToolQualificationRecordName(selected.value.parentStartId)}`,16384);
  if (!readManagedProviderDescriptor(provider.record.fd).equals(qualification.bytes) || !encode(provider.qualification).equals(qualification.bytes) ||
      !readManagedProviderDescriptor(provider.capsule.fd).equals(encode(dependencyToolGuestConfig(provider.qualification)))) invalid();
  if (provider.child) {
    if (!provider.command || !provider.args) invalid();
    assertHostedFdProcess(provider.child,unit,HostedFdLaunchKind.Provider,provider.command,provider.args);
  }
  const after = readCurrentHostedManagedDependencyProvider(context,fence,unit);
  if (!sameDependencyProtectedReference(after.reference,provider.reference)) invalid();
  return Object.freeze({qualification:provider.qualification,ready:provider.ready,capsulePath:provider.capsulePath,
    provider:selected.value,reference:selected.reference});
}
/** Original-map fixed spawn owns the Plan/FDA child; no registration DTO. */
export function spawnCurrentHostedManagedDependencyProvider(context: CurrentHostedDependencyOrigin, fence: HostedActivationFence, unit: string,
  input: Readonly<{command:string;args:readonly string[];cwd:string;env:Readonly<Record<string,string>>}>): CodexAppServerChildProcess {
  const session = contexts.get(context)?.rootPurpose?.sessionHome;
  if (!session || session.purpose !== HostedDependencyRootPurpose.ManagedGitReadV1) invalid();
  return spawnManagedProvider(context,fence,unit,input);
}
function spawnManagedProvider(context: CurrentHostedDependencyOrigin, fence: HostedActivationFence, unit: string, input: Readonly<{command:string;args:readonly string[];cwd:string;env:Readonly<Record<string,string>>}>): CodexAppServerChildProcess {
  readCurrentHostedManagedDependencyProviderParent(context,fence);
  const home = readCurrentHostedDependencyProviderSessionHome(context,fence,input.env.HOME,input.env.CODEX_HOME);
  const selected = Object.freeze({...input,args:Object.freeze([...input.args]),env:Object.freeze({...input.env,HOME:home.home,CODEX_HOME:home.codexHome})});
  const invocation = hostedManagedDependencyProviderInvocation(fence,unit,selected,context);
  if (!invocation || invocation.systemdUnit !== unit || invocation.stdinBootstrap === undefined) invalid();
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    retainCurrentHostedManagedDependencyProviderInvocation(context,fence,invocation);
    const retained = contexts.get(context)!.rootPurpose!;
    if (!retained.sessionHome?.leased || !retained.provider || retained.provider.home) invalid();
    retained.provider.home = retained.sessionHome; retained.provider.executionUse=currentSessionExecutionUse(context,undefined,fence).use;
    if (retained.provider.executionUse.home!==retained.sessionHome.facade) invalid();
    retained.provider.spawnAttempted = true;
    child = spawnHostedFdChild(invocation.command,invocation.args,{cwd:input.cwd,detached:true},unit,HostedFdLaunchKind.Provider);
    bindCurrentHostedManagedDependencyProviderChild(context,invocation,child); bindHostedDependencyToolChild(invocation,child);
    return managedProviderProcessFacade(context,child);
  } catch (error) {
    if (child) { hostedFdLaunch(child).invalidate(); child.kill("SIGTERM"); }
    abandonHostedDependencyToolInvocation(invocation); throw error;
  }
}
export function observeCurrentHostedManagedDependencyProviderFrame(context: CurrentHostedDependencyOrigin, unit: string): Promise<void> {
  const provider = contexts.get(context)?.rootPurpose?.provider;
  if (!provider || provider.unit !== unit || !provider.child || provider.stopping) invalid();
  return hostedFdLaunch(provider.child).observe().then(() => {
    // Manager birth is captured before any provider byte is released.
    const invocationId = collectUnitInvocation(unit);
    if (contexts.get(context)?.rootPurpose?.provider !== provider || provider.invocationId || provider.stopping) invalid();
    provider.invocationId = invocationId;
  });
}
export function remainingCurrentHostedManagedDependencyProviderSetup(context: CurrentHostedDependencyOrigin, unit: string): number {
  const provider = contexts.get(context)?.rootPurpose?.provider;
  if (!provider || provider.unit !== unit || !provider.child) invalid();
  return hostedFdLaunch(provider.child).remainingSetupMs();
}
export function releaseCurrentHostedManagedDependencyProviderFrame(context: CurrentHostedDependencyOrigin, fence: HostedActivationFence, unit: string): void {
  const selected = readCurrentHostedManagedDependencyProviderTools(context,fence,unit), provider = contexts.get(context)?.rootPurpose?.provider;
  if (!provider || !provider.child || provider.stopping || !provider.invocationId || collectUnitInvocation(unit) !== provider.invocationId ||
      !provider.invocation || !("stdinBootstrap" in provider.invocation) || typeof provider.invocation.stdinBootstrap !== "string") invalid();
  const child = provider.child, assertCurrent = () => {
    readCurrentHostedManagedDependencyProviderTools(context,fence,unit);
    if (contexts.get(context)?.rootPurpose?.provider !== provider || collectUnitInvocation(unit) !== provider.invocationId) invalid();
    assertHostedManagedDependencyToolRelease(child,fence);
    readCurrentHostedManagedDependencyProviderTools(context,fence,unit);
  };
  hostedFdLaunch(child).release(fence,provider.invocation.stdinBootstrap,false,assertCurrent);
  if (!sameDependencyProtectedReference(selected.reference,provider.reference)) invalid();
}
export function invalidateCurrentHostedManagedDependencyProvider(context: CurrentHostedDependencyOrigin, unit: string): void {
  const provider = contexts.get(context)?.rootPurpose?.provider;
  if (!provider || provider.unit !== unit || !provider.child) invalid();
  provider.stopping=true; hostedFdLaunch(provider.child).invalidate();
}
function retainCurrentHostedManagedDependencyProviderInvocation(context: CurrentHostedDependencyOrigin, fence: HostedActivationFence, invocation: Readonly<{command:string;args:readonly string[];systemdUnit?:string}>): void {
  const unit = invocation.systemdUnit; if (!unit) invalid(); readCurrentHostedManagedDependencyProviderTools(context,fence,unit);
  const provider = contexts.get(context)?.rootPurpose?.provider;
  if (!provider || provider.invocation || invocation.command !== hostedDependencySystemdRunExecutable ||
      !invocation.args.includes(`--unit=${unit}`) || !invocation.args.includes(`--property=RootDirectory=${provider.root.canonicalPath}`)) invalid();
  provider.invocation = invocation; provider.command = invocation.command; provider.args = Object.freeze([...invocation.args]);
}
function bindCurrentHostedManagedDependencyProviderChild(context: CurrentHostedDependencyOrigin, invocation: object, child: ChildProcess): void {
  const provider = contexts.get(context)?.rootPurpose?.provider;
  if (!provider || provider.invocation !== invocation || provider.child || !provider.command || !provider.args) invalid();
  assertHostedFdProcess(child,provider.unit,HostedFdLaunchKind.Provider,provider.command,provider.args);
  const proxyPid = child.pid; if (typeof proxyPid !== "number" || !Number.isSafeInteger(proxyPid) || proxyPid <= 0) invalid();
  provider.child = child; provider.proxyPid = proxyPid; provider.proxyBirth = observeHostedFdProcess(proxyPid).birth; provider.proxyClosed = false;
  // The source PID is captured by the fixed producer before the child escapes.
  // Close events alone grant nothing: discharge also requires actual PID absence,
  // creator receipt, owned terminal reservation, queue and recursive cgroup facts.
  provider.wait = new Promise(resolve => child.once("close",(code,signal) => {
    provider.proxyCode = code; provider.proxySignal = signal; provider.proxyClosed = true; resolve();
  }));
}
/** Immutable facts from the exact original private native child. No status DTO or completion grant enters. */
export function readOriginalHostedManagedProviderWaitFacts(context:CurrentHostedDependencyOrigin,fence:HostedActivationFence,unit:string) {
  const parent = readCurrentHostedManagedDependencyProviderParent(context,fence), state = contexts.get(context)?.rootPurpose, provider = state?.provider;
  if (!state || !provider || provider.unit !== unit || !provider.child) invalid();
  return formManagedProviderWaitFacts(parent,provider,state.sessionHome,currentSessionExecutionUse(context,undefined,fence).use);
}
export function closeCurrentHostedManagedDependencyProviderTools(context: CurrentHostedDependencyOrigin, unit: string): void {
  const state = contexts.get(context)?.rootPurpose, provider = state?.provider;
  if (!state || !provider) return; if (provider.unit !== unit) invalid();
  if (!provider.child) {
    if (provider.spawnAttempted) invalid();
    provider.capsule.close(); provider.record.close(); delete state.provider; return;
  }
  const parent=withHostedActivationFence(fence=>readCurrentHostedManagedDependencyProviderParent(context,fence));
  if (parent.facts.kind===CurrentHostedDependencyOriginKind.Ordinary) {
    withHostedActivationFence(fence=>{
      const current=readCurrentHostedManagedDependencyProviderParent(context,fence); if (current.facts.kind!==CurrentHostedDependencyOriginKind.Ordinary) invalid();
      provider.stopping=true; hostedFdLaunch(provider.child!).invalidate();
      const row=current.facts.ordinary.activation.ordinaryStarts.find(value=>value.unit===unit); if (!row) invalid();
      if (row.state===HostedCustodyReservationState.Reserved) provider.ordinaryCompletion=publishOriginalHostedOrdinaryProviderCompletion(context,fence,unit);
      else if (row.state!==HostedCustodyReservationState.Terminal || !provider.ordinaryCompletion) invalid();
      if (!provider.ordinaryTerminal) {const terminal=new OriginalHostedOrdinaryProviderTerminal(context,rootInternalAccess); Object.freeze(terminal); provider.ordinaryTerminal=terminal;}
      new HostedInstallationActivationStore().publishScopedTerminal(fence,provider.ordinaryTerminal);
      readOriginalHostedOrdinaryProviderTerminal(provider.ordinaryTerminal,fence);
      provider.capsule.close(); provider.record.close();
      if (contexts.get(context)?.rootPurpose!==state || state.provider!==provider) invalid();
      delete state.provider; readCurrentHostedManagedDependencyProviderParent(context,fence);
    }); return;
  }
  withHostedActivationFence(fence=>{
    provider.stopping=true; hostedFdLaunch(provider.child!).invalidate();
    publishOriginalHostedManagedProviderTerminal(context,fence,unit);
    if (contexts.get(context)?.rootPurpose!==state || state.provider!==provider) invalid();
    provider.capsule.close();provider.record.close();delete state.provider;
    readCurrentHostedManagedDependencyProviderParent(context,fence);
  });
}
export function readOriginalHostedOrdinaryProviderTerminal(token:OriginalHostedOrdinaryProviderTerminal,fence:HostedActivationFence) {
  assertHostedActivationFence(fence); const context=OriginalHostedOrdinaryProviderTerminal.resolve(token,rootInternalAccess);
  const state=contexts.get(context)?.rootPurpose,provider=state?.provider,receipt=provider?.ordinaryCompletion;
  if (!provider || provider.ordinaryTerminal!==token || !receipt || !provider.stopping || !provider.child || !provider.proxyClosed ||
      !provider.executionUse || currentSessionExecutionUse(context,undefined,fence).use!==provider.executionUse) invalid();
  const actual=readCurrentHostedManagedDependencyProviderParent(context,fence); if (actual.facts.kind!==CurrentHostedDependencyOriginKind.Ordinary) invalid();
  const row=actual.facts.ordinary.activation.ordinaryStarts.find(value=>value.startId===receipt.provider.startId);
  if (!row || row.unit!==provider.unit || row.generation!==receipt.provider.generation) invalid();
  const phase=row.state===HostedCustodyReservationState.Reserved ? HostedOrdinaryProviderReadPhase.Reserved :
    row.state===HostedCustodyReservationState.Terminal ? HostedOrdinaryProviderReadPhase.OwnTerminal : invalid();
  assertOriginalHostedOrdinaryProviderCompletion(context,fence,provider.unit,receipt,phase); return receipt;
}
export function assertCurrentHostedManagedDependencyCapsuleCopy(context: CurrentHostedDependencyOrigin, fence: HostedActivationFence, unit: string, fd: number): void {
  // The fixed FDA reader owns a temporary contained FD; no collector runs until it closes. This comparison registers no descriptor.
  assertHostedActivationFence(fence); readRetainedHostedDependencyAttemptFacts(context,DependencyOwnerPhase.Running);
  const provider = contexts.get(context)?.rootPurpose?.provider; if (!provider) invalid();
  if (provider.unit !== unit) invalid();
  const retained = fstatSync(provider.capsule.fd,{bigint:true}), actual = fstatSync(fd,{bigint:true});
  if (!sameStat(retained,actual) || !readManagedProviderDescriptor(fd).equals(encode(dependencyToolGuestConfig(provider.qualification)))) invalid();
}
function readManagedProviderDescriptor(fd: number): Buffer {
  const before = fstatSync(fd,{bigint:true}); if (!before.isFile() || before.size < 1n || before.size > 16384n) invalid();
  const bytes = Buffer.alloc(Number(before.size)+1); let length = 0;
  while (length < bytes.length) { const count = readSync(fd,bytes,length,bytes.length-length,length); if (!count) break; length += count; }
  if (BigInt(length) !== before.size || !sameStat(before,fstatSync(fd,{bigint:true}))) invalid(); return bytes.subarray(0,length);
}
export { isHostedManagedReadonlyOuterRuntime, isCurrentHostedDependencyManagedReadonlyOrigin } from "./hosted-dependency-current-facts";
/** Actual latest owner read AFTER the expensive current-origin collection. A factual returned attempt is not an enqueue permit; final frame reasserts. */
export function assertCurrentHostedDependencyAttempt(context: CurrentHostedDependencyOrigin, fence: HostedActivationFence, phase: DependencyOwnerPhase = DependencyOwnerPhase.Running) {
  return attemptFromFacts(assertCurrentHostedDependencyOrigin(context,fence),phase);
}
/** Metadata-only current owner fact for an already private-qualified read model. It cannot mint an origin/qualifier or authorize effects: every submission uses assertCurrentHostedDependencyAttempt under the actual fresh fence/collector. */
export function readRetainedHostedDependencyAttemptFacts(context: CurrentHostedDependencyOrigin, phase: DependencyOwnerPhase = DependencyOwnerPhase.Running) {
  const retained = contexts.get(context); if (!retained) invalid(); return attemptFromFacts(retained.facts,phase);
}
const rootInternalAccess = Symbol("hosted.root.internal.access");
function resolveRootPurpose(context:RootPurposeFacade,purpose:HostedDependencyRootPurpose,access:symbol) {
  if (access !== rootInternalAccess) invalid(); const origin = RootPurposeFacade.origin(context,purpose,access);
  const retained = contexts.get(origin), state = retained?.rootPurpose;
  if (!retained || !state || (purpose === HostedDependencyRootPurpose.ManagedGitReadV1 ? state.managed : purpose === HostedDependencyRootPurpose.SessionRefreshV1 ? state.refresh : state.cleanup) !== context) invalid();
  return {origin,state};
}
export type HostedDependencyRootPurposeContext = RootPurposeFacade;

export type HostedDependencyRootDescriptor = RootDescriptor;
export function readOriginalHostedDependencyRootDescriptor(resource: RootDescriptor): number {
  const {origin,material} = RootDescriptor.resolve(resource,rootInternalAccess), state = contexts.get(origin)?.rootPurpose;
  if (!state || state.descriptors.get(resource) !== material || material.closed) invalid();
  if (!sameDependencyAttempt(readRetainedHostedDependencyAttemptFacts(origin,DependencyOwnerPhase.Running).attempt,state.record.attempt)) invalid();
  return material.fd;
}
export function closeOriginalHostedDependencyRootDescriptor(resource: RootDescriptor): void {
  const {origin,material} = RootDescriptor.resolve(resource,rootInternalAccess); if (material.closed) return;
  const state = contexts.get(origin)?.rootPurpose;
  if (state && state.descriptors.get(resource) !== material) invalid();
  try { closePhysicalHostedDependencyRootDescriptor(material); material.closed = true; state?.descriptors.delete(resource); }
  catch (error) { contexts.delete(origin); if (currentRootOrigin === origin) currentRootOrigin = undefined; throw error; }
}
let currentRootOrigin: CurrentHostedDependencyOrigin | undefined;
const encode = (value: unknown): Buffer => Buffer.from(JSON.stringify(value)+"\n");
function currentOwnerForRoot(binding: HostedDependencyBinding) {
  const name = `dependency-owners/${binding.workspace.dev}-${binding.workspace.ino}`;
  if (readHostedActivationBytes(name+".lock")) invalid(); const owner = parseDependencyOwner(decodeHostedActivationBytes(fixed(name+".json",16384).bytes));
  if (readHostedActivationBytes(name+".lock") || !sameDependencyWorkspace(owner.workspace,binding.workspace)) invalid(); return owner;
}
/** No DTO inputs. Loads the sole trusted qualifier's fixed protected record and actual Ready before Running; provenance lives in the original origin map. */
export function prepareCurrentHostedDependencyRootPurpose(context: CurrentHostedDependencyOrigin, fence: HostedActivationFence): void {
  const retained = contexts.get(context); if (!retained || retained.rootPurpose) invalid();
  const preparation = readOriginalHostedDependencyRootPreparation(context,fence,DependencyOwnerPhase.ExclusiveMutation), managed = new RootPurposeFacade(context,HostedDependencyRootPurpose.ManagedGitReadV1,rootInternalAccess);
  retained.rootPurpose = {...preparation,managed,descriptors:new Map()}; currentRootOrigin = context;
}
export function captureCurrentHostedDependencyRootPurpose(purpose: HostedDependencyRootPurpose): HostedDependencyRootPurposeContext {
  if (!currentRootOrigin) invalid(); const origin = currentRootOrigin, state = contexts.get(origin)?.rootPurpose; if (!state) invalid();
  if (purpose === HostedDependencyRootPurpose.ManagedGitReadV1) return state.managed;
  if (purpose === HostedDependencyRootPurpose.SessionRefreshV1) {
    return withHostedActivationFence(fence => {
      if (!state.sessionHome?.leased || state.provider) invalid();
      sessionHome(state.sessionHome.facade,fence);
      return state.refresh ??= new RootPurposeFacade(origin,purpose,rootInternalAccess);
    });
  }
  if (purpose !== HostedDependencyRootPurpose.DependencySourceCleanupV1 || state.cleanup) invalid();
  // Source hygiene captures current Ready while genuinely exclusive; a historical pointer cannot resurrect a retired baseline.
  return withHostedActivationFence(fence => {
    const current = assertCurrentHostedDependencyAttempt(origin,fence,DependencyOwnerPhase.ExclusiveMutation);
    if (!sameDependencyAttempt(current.attempt,state.record.attempt) || !encode(currentRootReady(origin,fence,DependencyOwnerPhase.ExclusiveMutation)).equals(encode(state.ready))) invalid();
    state.cleanup = new RootPurposeFacade(origin,purpose,rootInternalAccess); return state.cleanup;
  });
}
function rootScope(context: RootPurposeFacade, purpose: HostedDependencyRootPurpose, fence: HostedActivationFence, phase: DependencyOwnerPhase) {
  const {origin,state} = resolveRootPurpose(context,purpose,rootInternalAccess), actual = assertCurrentHostedDependencyAttempt(origin,fence,phase);
  const {binding,attempt,facts} = actual, owner = currentOwnerForRoot(binding);
  const entry=facts.kind===CurrentHostedDependencyOriginKind.Ordinary ? readCurrentHostedOrdinaryDependencyReaderEntry(origin,fence,phase) : undefined;
  material(state.reference,`${root}/dependency-root-preparations/${attempt.launch.startId}.json`,65536);
  const scope=formHostedDependencyRootScopeFacts(actual,owner,state.record,phase,rootIdentity(facts,binding),entry);
  return {origin,state,actual,owner,scope};
}
export function assertCurrentHostedDependencyRootPurpose(context: HostedDependencyRootPurposeContext, purpose: HostedDependencyRootPurpose.ManagedGitReadV1 | HostedDependencyRootPurpose.SessionRefreshV1, fence: HostedActivationFence): HostedDependencyManagedGitScope {
  const remaining = systemdObservationBudget(), held = rootScope(context,purpose,fence,DependencyOwnerPhase.Running);
  if (!encode(currentRootReady(held.origin,fence)).equals(encode(held.state.ready))) invalid();
  const physical = readOriginalHostedDependencyRootPreparation(held.origin,fence,DependencyOwnerPhase.Running);
  if (!encode(physical.record).equals(encode(held.state.record)) || !sameDependencyProtectedReference(physical.reference,held.state.reference)) invalid();
  const after = assertCurrentHostedDependencyAttempt(held.origin,fence,DependencyOwnerPhase.Running);
  if (!sameDependencyAttempt(after.attempt,held.actual.attempt) || !encode(currentOwnerForRoot(after.binding)).equals(encode(held.owner)) ||
      !encode(currentRootReady(held.origin,fence)).equals(encode(held.state.ready)) || remaining() <= 0) invalid();
  const record = held.state.record;
  return Object.freeze({...held.scope,rootGit:physical.rootGit,protectedProfile:record.protectedProfile,durableHandoffRoot:record.durableHandoffRoot,
    scratchParent:record.scratchParent,authoredRoots:record.authoredRoots,generatedRoots:record.generatedRoots,sourceLookupAncestors:record.sourceLookupAncestors});
}
/** Sole original-map descriptor association; no supplied FD/pins. */
export function openCurrentHostedDependencyRootDescriptor(context: HostedDependencyRootPurposeContext, fence: HostedActivationFence, recipe: HostedDependencyRootDescriptorRecipe, path: string): HostedDependencyRootDescriptor {
  const {origin,state} = resolveRootPurpose(context,HostedDependencyRootPurpose.ManagedGitReadV1,rootInternalAccess);
  assertCurrentHostedDependencyRootPurpose(context,HostedDependencyRootPurpose.ManagedGitReadV1,fence);
  if (state.descriptors.size >= 256) invalid();
  const material = openOriginalHostedDependencyRootDescriptorMaterial(origin,fence,recipe,path,rootInternalAccess), descriptor = new RootDescriptor(origin,material,rootInternalAccess);
  Object.freeze(descriptor);
  state.descriptors.set(descriptor,material);
  try { assertCurrentHostedDependencyRootPurpose(context,HostedDependencyRootPurpose.ManagedGitReadV1,fence); return descriptor; }
  catch (error) { descriptor.close(); throw error; }
}
export function assertCurrentHostedDependencyRetiredReady(context: HostedDependencyRootPurposeContext, fence: HostedActivationFence): HostedDependencyRootScope {
  const held = rootScope(context,HostedDependencyRootPurpose.DependencySourceCleanupV1,fence,DependencyOwnerPhase.ExclusiveMutation);
  assertHostedDependencyRetirementOwnerFacts(held.state.record,held.owner);
  if (held.owner.version === 1 || !held.owner.generationContinuity) invalid();
  const slot = parseDependencyGenerationContinuityInvalidation(held.owner.generationContinuity), ready = held.state.ready;
  const store = LocalDependencyReceiptStore.open({rootPath:hostedDependencyReceiptHistoryRoot,maxRecordBytes:16384,maxHistorySteps:2048});
  try {
    const current = store.read(held.actual.binding.workspace);
    if (!current || current.state !== DependencyReceiptState.Unverified || current.revision !== ready.receipt.revision+1 || current.generation !== ready.receipt.generation ||
        slot.operationId !== held.actual.attempt.attemptId || slot.readyRevision !== ready.receipt.revision || slot.unverifiedRevision !== current.revision ||
        slot.generation !== ready.receipt.generation || !sameDependencyProtectedReference(slot.previousReady,ready.reference)) invalid();
    const previous = store.getCommittedReady(held.actual.binding.workspace,ready.receipt.revision), retired = store.getCommittedUnverified(held.actual.binding.workspace,current.revision);
    if (!encode(previous).equals(encode(ready)) || !encode(retired.receipt).equals(encode(current)) || !sameDependencyProtectedReference(retired.reference,slot.retiredUnverified)) invalid();
  } finally { store.close(); }
  const after = assertCurrentHostedDependencyAttempt(held.origin,fence,DependencyOwnerPhase.ExclusiveMutation);
  if (!sameDependencyAttempt(after.attempt,held.actual.attempt) || !encode(currentOwnerForRoot(after.binding)).equals(encode(held.owner))) invalid();
  return held.scope;
}
/** One concrete retirement producer under the actual synchronous host fence. Store verifier inputs are the stores' own captured predecessor facts. Neither callbacks, baseline records nor expected revisions arrive from the caller. An uncertain receipt/CAS is held, never released or implicitly retried. */
export function retireCurrentHostedDependencySourceCleanup(context: HostedDependencyRootPurposeContext, reason: DependencyUnverifiedReason.TreeChanged | DependencyUnverifiedReason.InputsChanged): void {
  resolveRootPurpose(context,HostedDependencyRootPurpose.DependencySourceCleanupV1,rootInternalAccess);
  withHostedActivationFence(fence => {
    const held = rootScope(context,HostedDependencyRootPurpose.DependencySourceCleanupV1,fence,DependencyOwnerPhase.ExclusiveMutation);
    assertHostedDependencyRetirementOwnerFacts(held.state.record,held.owner);
    if ((reason !== DependencyUnverifiedReason.TreeChanged && reason !== DependencyUnverifiedReason.InputsChanged) ||
        !encode(currentRootReady(held.origin,fence,DependencyOwnerPhase.ExclusiveMutation)).equals(encode(held.state.ready))) invalid();
    // No collectors run with store FDs open. The same genuine fence brackets publication/readback; owner verifier uses its own CAS predecessor.
    const assertRetained = () => {
      assertHostedActivationFence(fence);
      const resolved = resolveRootPurpose(context,HostedDependencyRootPurpose.DependencySourceCleanupV1,rootInternalAccess);
      if (resolved.origin !== held.origin || resolved.state !== held.state) invalid();
    };
    const receipts = LocalDependencyReceiptStore.open({rootPath:hostedDependencyReceiptHistoryRoot,maxRecordBytes:16384,maxHistorySteps:2048,
      generationReceiptVerifier:{
        assertReadyRetirement({previousReady,previousReference,proposedUnverified}) {
          assertRetained(); const owner = currentOwnerForRoot(held.actual.binding);
          if (!encode(owner).equals(encode(held.owner)) || !encode(previousReady).equals(encode(held.state.ready.receipt)) ||
              !sameDependencyProtectedReference(previousReference,held.state.ready.reference) || proposedUnverified.revision !== previousReady.revision+1 ||
              proposedUnverified.generation !== previousReady.generation || proposedUnverified.reason !== reason ||
              !sameDependencyWorkspace(proposedUnverified.workspace,held.actual.binding.workspace)) invalid();
        },
        assertFactualUnverified() { invalid(); },
      }});
    let owners: LocalDependencyOwnerStore | undefined;
    try {
      owners = LocalDependencyOwnerStore.open({rootPath:root+"/dependency-owners",maxRecordBytes:16384,
        generationRetirementVerifier:{assertGenerationRetirement({previousOwner,proposedOwner,invalidation}) {
          assertRetained();
          if (!encode(previousOwner).equals(encode(held.owner))) invalid();
          assertHostedDependencyRetirementSuccessorFacts(held.state.record,previousOwner,proposedOwner,invalidation,
            held.actual.attempt.attemptId,held.state.ready);
          const current = receipts.read(held.actual.binding.workspace);
          if (!current || current.state !== DependencyReceiptState.Unverified || current.revision !== invalidation.unverifiedRevision ||
              current.generation !== invalidation.generation || current.reason !== reason) invalid();
          const committed = receipts.getCommittedUnverified(held.actual.binding.workspace,current.revision);
          if (!encode(committed.receipt).equals(encode(current)) || !sameDependencyProtectedReference(committed.reference,invalidation.retiredUnverified)) invalid();
        }}});
      invalidateDependencyGeneration({owners,receipts,workspace:held.actual.binding.workspace,expectedOwnerRevision:held.owner.revision,
        expectedReceiptRevision:held.state.ready.receipt.revision,reason});
    } finally { try { owners?.close(); } finally { receipts.close(); } }
    assertCurrentHostedDependencyRetiredReady(context,fence);
  });
}
/** Protected config facts only, bounded retained FD and root ancestry. Actual issuer/admission selects workspace first; this function cannot mint a purpose. */
export { readHostedDependencyRootGitConfigPin } from "./hosted-dependency-current-facts";
/** Fixed factual IO selector; only the original lexical access can select its
 * record. It neither opens a descriptor nor registers supplied physical facts. */
export function readOriginalHostedDependencyDescriptorOpening(context:CurrentHostedDependencyOrigin,fence:HostedActivationFence,access:symbol) {
  if(access!==rootInternalAccess)invalid();const state=contexts.get(context)?.rootPurpose;if(!state)invalid();
  return {scope:assertCurrentHostedDependencyRootPurpose(state.managed,HostedDependencyRootPurpose.ManagedGitReadV1,fence),record:state.record};
}
export function assertOriginalHostedSessionRuntimeCompositionAccess(context:CurrentHostedDependencyOrigin,access:symbol):void { if (access!==rootInternalAccess || !contexts.get(context)?.rootPurpose || contexts.get(context)!.rootPurpose!.sessionRuntime) invalid(); }
/** Fixed actual stores and driver. No supplied StorePort, constructor or terminal DTO. */
export function createCurrentHostedDependencySessionRuntime(context: CurrentHostedDependencyOrigin, input: OriginalHostedSessionRuntimeCompositionInput) {
  if (!contexts.get(context)?.rootPurpose) invalid();
  input = Object.freeze({...input,options:Object.freeze({...input.options})});
  const retained=contexts.get(context)?.rootPurpose; if (!retained || retained.sessionRuntime) invalid();
  const composition=createOriginalHostedSessionRuntimeComposition(context,input,rootInternalAccess);
  if (contexts.get(context)?.rootPurpose!==retained || retained.sessionRuntime) invalid();
  const state={state:retained,...composition}, {physical,managedRunStore,materializer,driver}=composition;
  const lifecycle: SessionExecutionLifecyclePort = Object.freeze({begin:async () => {
    const selected = sessionRuntime(context), previous = selected.runtime.tail; let unlock!: () => void;
    selected.runtime.tail = new Promise(resolve => { unlock = resolve; }); await previous;
    const actual = sessionRuntime(context); if (actual.runtime !== selected.runtime || actual.runtime.use || actual.runtime.idleWrites) invalid();
    const handle:SessionExecutionUse = Object.freeze({complete:() => completeSessionExecutionUse(context,handle)});
    actual.runtime.use = {handle,unlock,phase:ManagedSessionUsePhase.Begun}; return handle;
  }});
  const acquire = physical.leaseStore.acquire.bind(physical.leaseStore), finalize = physical.leaseStore.finalize.bind(physical.leaseStore),
    start = physical.leaseStore.markWritebackStarted.bind(physical.leaseStore), commit = physical.leaseStore.markWritebackCommitted.bind(physical.leaseStore),
    release = physical.leaseStore.release.bind(physical.leaseStore), read = physical.sessionStore.read.bind(physical.sessionStore),
    write = physical.sessionStore.write.bind(physical.sessionStore), remove = physical.sessionStore.delete.bind(physical.sessionStore);
  const owned = (leaseId?:string) => { const selected = currentSessionExecutionUse(context);
    if (selected.use.credentialUnknown || selected.use.acquiring || selected.use.writing ||
        leaseId !== undefined && selected.use.lease?.leaseId !== leaseId) invalid(); return selected; };
  const checked = (selected:ReturnType<typeof currentSessionExecutionUse>) => {
    const now = currentSessionExecutionUse(context); if (now.runtime !== selected.runtime || now.use !== selected.use) invalid(); return now; };
  const leaseStore:LeaseStorePort = Object.freeze<LeaseStorePort>({leaseStoreId:physical.leaseStore.leaseStoreId,capabilities:physical.leaseStore.capabilities,
    acquire:async input => { input = Object.freeze({...input}); const selected = owned(); if (selected.use.lease || selected.use.account && selected.use.account !== input.providerInstanceId || selected.use.restoredHash && selected.use.restoredHash !== input.restoredGenerationHash) invalid(); selected.use.acquiring = true;
      try { const result = await acquire(input); checked(selected); delete selected.use.acquiring;
        if (result.status === "granted") selected.use.lease = {leaseId:result.leaseId,providerInstanceId:input.providerInstanceId,restoredHash:input.restoredGenerationHash,terminal:false};
        return result;
      } catch (error) { selected.use.credentialUnknown = true; throw error; } },
    finalize:async input => { input = Object.freeze({...input}); const selected = owned(input.leaseId); assertSessionExecutionUseDischarged(selected); if (selected.use.lease!.restoredHash !== input.restoredGenerationHash) invalid();
      try { const result = await finalize(input); checked(selected); if (result.leaseId !== input.leaseId || result.restoredGenerationHash !== input.restoredGenerationHash) invalid(); return result; }
      catch (error) { selected.use.credentialUnknown = true; throw error; } },
    markWritebackStarted:async input => { input = Object.freeze({...input}); const selected = owned(input.leaseId); assertSessionExecutionUseDischarged(selected);
      try { await start(input); checked(selected); } catch (error) { selected.use.credentialUnknown = true; throw error; } },
    markWritebackCommitted:async input => { input = Object.freeze({...input}); const selected = owned(input.leaseId); assertSessionExecutionUseDischarged(selected);
      const snapshot = selected.use.snapshot; if (!snapshot || snapshot.hash !== input.nextGenerationHash || snapshot.hash !== selected.use.lease!.restoredHash && (selected.use.writeStatus !== "accepted" && selected.use.writeStatus !== "idempotent_replay" || selected.use.writebackKey !== input.idempotencyKey)) invalid();
      try { const result = await commit(input); checked(selected);
        if (result.status === "committed" || result.status === "idempotent_replay") selected.use.lease!.terminal = true; return result;
      } catch (error) { selected.use.credentialUnknown = true; throw error; } },
    release:async input => { input = Object.freeze({...input}); const selected = owned(input.leaseId); assertSessionExecutionUseDischarged(selected);
      if (selected.use.phase !== ManagedSessionUsePhase.Begun || selected.use.home) assertManagedSessionCredentialWritebackFacts(selected.use);
      try { await release(input); checked(selected); selected.use.lease!.terminal = true; }
      catch (error) { selected.use.credentialUnknown = true; throw error; } },
  });
  const sessionStore:SessionStorePort = Object.freeze<SessionStorePort>({storeId:physical.sessionStore.storeId,custody:physical.sessionStore.custody,capabilities:physical.sessionStore.capabilities,
    read:async input => { input = Object.freeze({...input}); const selected = sessionRuntime(context), result = await read(input);
      if (sessionRuntime(context).runtime !== selected.runtime) invalid();
      if (result) { const captured = captureManagedSessionArtifactFacts(result.artifact); if (result.providerInstanceId !== input.providerInstanceId || result.generationHash !== captured.hash) invalid(); selected.runtime.sessionReads.set(result.artifact,{account:input.providerInstanceId,hash:captured.hash}); } return result; },
    write:async input => { input = Object.freeze({...input}); const selected = sessionRuntime(context), use = selected.runtime.use;
      if (use) { const ownedUse = use.writePending ? currentSessionExecutionUse(context) : owned();
        if (ownedUse.use !== use || use.credentialUnknown || use.acquiring || use.writeRetrying || use.writePending && (!use.writing || !use.pendingWrite)) invalid();
        assertSessionExecutionUseDischarged(ownedUse);
        const captured = captureManagedSessionWriteIntent(input,use); input = captured.input; use.pendingWrite = captured.intent;
        if (use.writePending) use.writeRetrying = true; use.writing = true;
      } else { if (selected.state.sessionHome?.leased || selected.state.provider || selected.state.preparingHome) invalid(); selected.runtime.idleWrites++; }
      try { const result = await write(input); const after = sessionRuntime(context);
        if (after.runtime !== selected.runtime || after.runtime.use !== use) invalid();
        if (use) { if (result.status !== "stale_generation" && result.generationHash !== use.pendingWrite!.hash) invalid(); delete use.writeRetrying;
          if (result.status === "accepted" || result.status === "idempotent_replay") { delete use.writing; delete use.writePending; } else use.writePending = true;
          use.writeStatus = result.status; use.writebackKey = input.idempotencyKey; } else selected.runtime.idleWrites--; return result;
      } catch (error) { if (use) { delete use.writeRetrying; use.writePending = true; } throw error; } },
    delete:async input => { input = Object.freeze({...input}); const selected = sessionRuntime(context);
      if (selected.runtime.use || selected.runtime.idleWrites || selected.state.sessionHome?.leased || selected.state.provider) invalid();
      selected.runtime.idleWrites++; try { await remove(input); if (sessionRuntime(context).runtime !== selected.runtime) invalid(); selected.runtime.idleWrites--; }
      catch (error) { throw error; } },
  });
  state.state.sessionRuntime = {originKind:withHostedActivationFence(fence => assertCurrentHostedDependencyOrigin(context,fence).kind),lifecycle,driver,materializer,sessionStore,leaseStore,model:state.model,stateRoot:state.stateRoot,sessionRoot:state.sessionRoot,tail:Promise.resolve(),idleWrites:0,sessionReads:new WeakMap()};
  sessionRuntime(context); return Object.freeze({sessionStore,leaseStore,managedRunStore,agentDriver:driver,materializer,sessionExecutionLifecycle:lifecycle});
}
function sessionRuntime(context:CurrentHostedDependencyOrigin, heldFence?:HostedActivationFence) {
  const read = (fence:HostedActivationFence) => { const state = contexts.get(context)?.rootPurpose;
    if (!state?.sessionRuntime) invalid(); readCurrentHostedManagedDependencyProviderParent(context,fence);
    for (const pin of [state.sessionRuntime.stateRoot,state.sessionRuntime.sessionRoot]) {
      assertDirectory(pin); const stat = lstatSync(pin.canonicalPath);
      if (stat.uid !== 0 || stat.gid !== 0 || (stat.mode & 0o7777) !== 0o700) invalid();
    }
    return {state,runtime:state.sessionRuntime}; };
  return heldFence ? read(heldFence) : withHostedActivationFence(read);
}
function currentSessionExecutionUse(context:CurrentHostedDependencyOrigin, handle?:SessionExecutionUse, fence?:HostedActivationFence) {
  const retained = contexts.get(context)?.rootPurpose?.sessionRuntime, use = retained?.use;
  if (!retained || !use || use.phase === ManagedSessionUsePhase.Complete || handle !== undefined && use.handle !== handle) invalid();
  const selected = sessionRuntime(context,fence); if (selected.runtime !== retained || selected.runtime.use !== use) invalid(); return {...selected,use};
}
async function completeSessionExecutionUse(context:CurrentHostedDependencyOrigin, handle:SessionExecutionUse):Promise<SessionExecutionUseDisposition> {
  const selected = currentSessionExecutionUse(context,handle), {runtime,use} = selected;
  if (use.credentialUnknown || use.acquiring || use.writing || use.lease && !use.lease.terminal) invalid();
  if (runtime.driver.retainsSessionExecutionUse(handle)) {
    if (use.phase !== ManagedSessionUsePhase.Active || !use.materialized || use.materialized.sessionExecutionUse !== handle ||
        !use.home || selected.state.sessionHome?.facade !== use.home || !selected.state.sessionHome.leased) invalid();
    return SessionExecutionUseDisposition.Retained;
  }
  assertSessionExecutionUseDischarged(selected);
  if (selected.use.phase !== ManagedSessionUsePhase.Begun || selected.use.home) assertManagedSessionCredentialWritebackFacts(selected.use);
  if (currentSessionExecutionUse(context,handle).use !== use) invalid();
  use.phase = ManagedSessionUsePhase.Complete; runtime.retired = use; delete runtime.use; use.unlock(); return SessionExecutionUseDisposition.Discharged;
}
/** Only the original fixed composition can admit its exact materialization. */
export function materializeCurrentHostedDependencySession(context:CurrentHostedDependencyOrigin, input:Readonly<{session:SessionArtifact;redactor:RedactorPort;sessionExecutionUse?:SessionExecutionUse}>) {
  if (!contexts.get(context)?.rootPurpose) invalid();
  input = captureManagedSessionMaterializationInput(input); const selected = currentSessionExecutionUse(context,input.sessionExecutionUse), {use} = selected;
  if (use.phase !== ManagedSessionUsePhase.Begun || use.home || use.materialized) invalid();
  const artifact = input.session, provenance = selected.runtime.sessionReads.get(artifact); if (!provenance) invalid();
  const captured = captureManagedSessionArtifactFacts(artifact); if (captured.hash !== provenance.hash || use.lease && (use.lease.providerInstanceId !== provenance.account || use.lease.restoredHash !== captured.hash)) invalid();
  if (currentSessionExecutionUse(context,input.sessionExecutionUse).use !== use) invalid(); use.account = provenance.account; use.restoredHash = captured.hash; use.phase = ManagedSessionUsePhase.Preparing;
  const cache = selected.state.sessionCache?.facade; if (!cache) invalid();
  const home = leaseCurrentHostedDependencySessionHome(cache); use.home = home;
  const auth = codexAuthJsonFromArtifact(captured.artifact); input.redactor.registerSecret(auth,"codex-auth-json");
  writeCurrentHostedDependencySessionAuth(home,auth);
  const paths = withHostedActivationFence(fence => readCurrentHostedDependencySessionHome(home,fence));
  const materialized = Object.freeze({home:paths.home,codexHome:paths.codexHome,sessionExecutionUse:use.handle,
    sessionHash:hash(auth),env:Object.freeze({HOME:paths.home,CODEX_HOME:paths.codexHome,...codexProviderEgressEnv(codexProviderEgressPolicy(selected.runtime.originKind === CurrentHostedDependencyOriginKind.Ordinary ? CodexProviderEgressProfileId.TestNpmQualification : CodexProviderEgressProfileId.TestManagedQualification))}),
    snapshotSession:async () => { currentSessionExecutionUse(context,use.handle);
      if (use.phase !== ManagedSessionUsePhase.Active || use.materialized !== materialized) invalid();
      try { await drainCurrentHostedDependencySessionProvider(home); currentSessionExecutionUse(context,use.handle);
        const artifact = sessionArtifactFromCodexAuthJson(snapshotCurrentHostedDependencySessionAuth(home)); use.snapshot = {artifact,hash:captureManagedSessionArtifactFacts(artifact).hash}; return artifact; }
      catch (error) { use.credentialUnknown = true; throw error; } },
    release:async () => {
      if (use.release) return await use.release;
      const before = currentSessionExecutionUse(context,use.handle);
      if (before.use !== use || use.materialized !== materialized || use.credentialUnknown) invalid();
      if (use.phase === ManagedSessionUsePhase.Released) { assertSessionExecutionUseDischarged(before); return; }
      if (use.phase !== ManagedSessionUsePhase.Active) invalid();
      const pending = (async () => { await releaseCurrentHostedDependencySessionHome(home);
        const after = currentSessionExecutionUse(context,use.handle); if (after.use !== use || after.use.phase !== ManagedSessionUsePhase.Released) invalid(); })();
      use.release = pending;
      try { await pending; } catch (error) {
        try { const after = currentSessionExecutionUse(context,use.handle);
          if (after.use === use && use.materialized === materialized && !use.credentialUnknown && (use.phase === ManagedSessionUsePhase.Active || use.phase === ManagedSessionUsePhase.Released) && use.release === pending) delete use.release;
        } catch { /* Unknown original owner keeps the failed release held. */ }
        throw error;
      }
    },
  });
  use.materialized = materialized; use.phase = ManagedSessionUsePhase.Active; return materialized;
}
export function readCurrentHostedDependencyExecutionUseHome(context:CurrentHostedDependencyOrigin, handle:SessionExecutionUse):CurrentHostedDependencySessionHome {
  const selected = currentSessionExecutionUse(context,handle);
  if (!selected.use.home || selected.use.phase !== ManagedSessionUsePhase.Active) invalid(); return selected.use.home;
}
export function prepareCurrentHostedDependencySessionCache(context:CurrentHostedDependencyOrigin):void {
  if (!contexts.get(context)?.rootPurpose) invalid(); withHostedActivationFence(fence => createCurrentHostedDependencySessionHome(context,fence));
}
export type CurrentHostedDependencySessionHome = ManagedSessionHomeFacade;
export function assertOriginalHostedDependencySessionHomeIdentity(home: CurrentHostedDependencySessionHome): void {
  const context = ManagedSessionHomeFacade.origin(home,rootInternalAccess), state = contexts.get(context)?.rootPurpose;
  if (!state || state.sessionHome?.facade !== home && state.sessionCache?.facade !== home) invalid();
}
function sessionHome(home: CurrentHostedDependencySessionHome, fence: HostedActivationFence) {
  const context = ManagedSessionHomeFacade.origin(home,rootInternalAccess), state = contexts.get(context)?.rootPurpose;
  if (!state || state.sessionHome?.facade !== home && state.sessionCache?.facade !== home) invalid();
  const selected = state.sessionHome?.facade === home ? state.sessionHome : state.sessionCache; if (!selected) invalid();
  const actual = readCurrentHostedManagedDependencyProviderParent(context,fence);
  for (const pin of [selected.root,selected.home,selected.codexHome,selected.emptyWorkdir]) {
    assertDirectory(pin); const stat = lstatSync(pin.canonicalPath);
    if (stat.uid !== 0 || stat.gid !== 0 || (stat.mode & 0o7777) !== 0o700) invalid();
  }
  if (!material(selected.config,selected.codexHome.canonicalPath+"/config.toml",65536).bytes.equals(selected.configBytes)) invalid();
  return {context,state,actual,home:selected};
}
/** Fixed current R/C selection BEFORE any auth writer or session bootstrap. */
export function createCurrentHostedDependencySessionHome(context: CurrentHostedDependencyOrigin, fence: HostedActivationFence): CurrentHostedDependencySessionHome {
  const actual = readCurrentHostedManagedDependencyProviderParent(context,fence), state = contexts.get(context)?.rootPurpose;
  if (!state || state.provider) invalid();
  if (state.sessionCache) { sessionHome(state.sessionCache.facade,fence); return state.sessionCache.facade; }
  if (state.preparingHome) invalid();
  const facade = new ManagedSessionHomeFacade(context,rootInternalAccess); state.preparingHome = facade;
  const physical = preparePhysicalOriginalHostedDependencySessionHome(facade,fence);
  const after = readCurrentHostedDependencyHomePreparation(facade,fence);
  if (!sameDependencyAttempt(after.attempt,actual.attempt) || contexts.get(context)?.rootPurpose !== state) invalid();
  state.sessionCache = {facade,...physical,leased:false,purpose:HostedDependencyRootPurpose.ManagedGitReadV1}; delete state.preparingHome; Object.freeze(facade);
  sessionHome(facade,fence); return facade;
}
/** Fixed pending-home recipe, available only to the original issuer's unescaped facade. It accepts no path, pins, state, flags, callback or config override. */
export function readCurrentHostedDependencyHomePreparation(home: CurrentHostedDependencySessionHome, fence: HostedActivationFence) {
  const context = ManagedSessionHomeFacade.origin(home,rootInternalAccess), state = contexts.get(context)?.rootPurpose;
  if (!state || state.preparingHome !== home || state.sessionCache || state.provider) invalid();
  const actual = readCurrentHostedManagedDependencyProviderParent(context,fence);
  const qualification = material(state.record.qualification,`/var/lib/subscription-runtime-host-policy/${dependencyToolQualificationRecordName(actual.attempt.launch.startId)}`,16384);
  return formManagedDependencyHomePreparationFacts(qualification.bytes,actual.binding.jobRootDir,actual.attempt,actual.facts.kind===CurrentHostedDependencyOriginKind.Ordinary ? CodexProviderEgressProfileId.TestNpmQualification : CodexProviderEgressProfileId.TestManagedQualification);
}
/** Factual selected paths only; an arbitrary DTO cannot register a lease/home. */
export function readCurrentHostedDependencySessionHome(home: CurrentHostedDependencySessionHome, fence: HostedActivationFence) {
  const held = sessionHome(home,fence); if (!held.home.leased) invalid();
  return Object.freeze({home:held.home.home.canonicalPath,codexHome:held.home.codexHome.canonicalPath,emptyWorkdir:held.home.emptyWorkdir.canonicalPath});
}
export function assertCurrentHostedDependencySessionAuthWritable(home: CurrentHostedDependencySessionHome, fence: HostedActivationFence) {
  const held = sessionHome(home,fence); if (!held.home.leased || held.state.provider) invalid();
  return Object.freeze({...readCurrentHostedDependencySessionHome(home,fence),attempt:held.actual.attempt});
}
export { writeOriginalHostedDependencySessionAuth as writeCurrentHostedDependencySessionAuth,
  snapshotOriginalHostedDependencySessionAuth as snapshotCurrentHostedDependencySessionAuth } from "./hosted-managed-dependency-session-auth";
export function readCurrentHostedDependencyProviderSessionHome(context: CurrentHostedDependencyOrigin, fence: HostedActivationFence, home: string | undefined, codexHome: string | undefined) {
  const state = contexts.get(context)?.rootPurpose;
  if (!state?.sessionHome) invalid();
  const selected = sessionHome(state.sessionHome.facade,fence);
  if (!selected.home.leased || home !== selected.home.home.canonicalPath || codexHome !== selected.home.codexHome.canonicalPath) invalid();
  return Object.freeze({...readCurrentHostedDependencySessionHome(selected.home.facade,fence),refresh:selected.home.purpose === HostedDependencyRootPurpose.SessionRefreshV1});
}
/** Mid-job slot release drains only the original map's exact FDA provider, never the still-live C/outer creator. A failed discharge keeps the lease held. */
export async function drainCurrentHostedDependencySessionProvider(home: CurrentHostedDependencySessionHome): Promise<void> {
  assertOriginalHostedDependencySessionHomeIdentity(home);
  const held = withHostedActivationFence(fence => sessionHome(home,fence));
  if (!held.home.leased) invalid();
  const provider = held.state.provider;
  if (provider) {
    if (provider.home !== held.home || !provider.child || !provider.wait) invalid();
    // Stop closes future capability; only actual discharge releases this account/home. Failed slots never become idle in finally.
    if (!provider.proxyClosed) { if (!provider.facade) invalid(); signalCurrentHostedManagedDependencyProviderView(held.context,provider.facade,"SIGTERM"); }
    await awaitPrivateManagedProviderClose(provider.wait,HostedManagedProviderWaitDeadline.Release); await provider.inputTail;
    await retryHostedFenceAcquisition(() => closeCurrentHostedManagedDependencyProviderTools(held.context,provider.unit),5000);
  }
}
export async function releaseCurrentHostedDependencySessionHome(home: CurrentHostedDependencySessionHome): Promise<void> {
  assertOriginalHostedDependencySessionHomeIdentity(home);
  const held = withHostedActivationFence(fence => sessionHome(home,fence));
  await drainCurrentHostedDependencySessionProvider(home);
  await retryHostedFenceAcquisition(() => withHostedActivationFence(fence => {
    const after = sessionHome(home,fence);
    if (after.home !== held.home || after.state.provider || !sameDependencyAttempt(after.actual.attempt,held.actual.attempt)) invalid();
    const use = after.state.sessionRuntime?.use;
    if (!use || use.home !== home || use.phase !== ManagedSessionUsePhase.Active || !use.snapshot || use.credentialUnknown) invalid();
    after.home.leased = false; use.phase = ManagedSessionUsePhase.Released;
  }),5000);
}
function leaseCurrentHostedDependencySessionHome(home: CurrentHostedDependencySessionHome): CurrentHostedDependencySessionHome {
  assertOriginalHostedDependencySessionHomeIdentity(home);
  return withHostedActivationFence(fence => {
    const held = sessionHome(home,fence);
    if (held.state.sessionCache !== held.home || held.state.sessionHome?.leased || held.state.provider) invalid();
    const facade = new ManagedSessionHomeFacade(held.context,rootInternalAccess); Object.freeze(facade);
    held.state.sessionHome = {...held.home,facade,leased:true,purpose:HostedDependencyRootPurpose.ManagedGitReadV1};
    return facade;
  });
}
function managedProviderProcessFacade(context: CurrentHostedDependencyOrigin, child: ChildProcessWithoutNullStreams): CodexAppServerChildProcess {
  const provider = contexts.get(context)?.rootPurpose?.provider;
  if (!provider || provider.child !== child || provider.facade) invalid();
  const facade = createHostedManagedDependencySdkView(context,child); provider.facade = facade; return facade;
}
/** Both enqueue and deferred physical IO resolve the same original entry. */
export function writeCurrentHostedManagedDependencyProviderView(context: CurrentHostedDependencyOrigin, view: CodexAppServerChildProcess, chunk?: string | Uint8Array): boolean { return enqueueManagedProviderInput(context,view,chunk); }
function enqueueManagedProviderInput(context:CurrentHostedDependencyOrigin,view:CodexAppServerChildProcess,chunk?:string|Uint8Array,fence?:HostedActivationFence):boolean {
  const provider = contexts.get(context)?.rootPurpose?.provider;
  if (!provider?.child || provider.facade !== view || provider.inputEnding) invalid();
  if (fence) assertManagedProviderInput(context,view,fence); else withHostedActivationFence(held => assertManagedProviderInput(context,view,held));
  const launch = hostedFdLaunch(provider.child), limit = launch.providerInputByteLimit(), remaining = limit-(provider.inputBytes ?? 0);
  const bytes = chunk === undefined ? undefined : typeof chunk === "string" ? chunk : copyBoundedHostedByteInput(chunk,remaining);
  const length = bytes === undefined ? 0 : typeof bytes === "string" ? Buffer.byteLength(bytes) : bytes.byteLength;
  if ((provider.inputBytes ?? 0)+length > limit) { provider.stopping = true; launch.invalidate(); invalid(); }
  provider.inputBytes = (provider.inputBytes ?? 0)+length; if (bytes === undefined) provider.inputEnding = true;
  provider.inputPending=(provider.inputPending ?? 0)+1;
  provider.inputTail = (provider.inputTail ?? Promise.resolve()).then(async () => {
    await launch.awaitReleasedProviderInput();
    let completion:Promise<void>|undefined;
    withHostedActivationFence(fence => {
      assertManagedProviderInput(context,view,fence);
      completion = launch.writeReleasedProviderInput(bytes); void completion.catch(() => {}); // Handle immediately; await the SAME promise after fence release.
    }); await completion;
  }).catch(error => {
    provider.stopping = true; launch.invalidate();
    provider.child!.stdin!.destroy(error instanceof Error ? error : new Error("hosted_dependency_provider_input_denied"));
  }).finally(() => { provider.inputBytes = (provider.inputBytes ?? length)-length; provider.inputPending=(provider.inputPending ?? 1)-1; });
  return provider.inputBytes < limit;
}
function assertManagedProviderInput(context: CurrentHostedDependencyOrigin, view: CodexAppServerChildProcess, fence: HostedActivationFence): void {
  const state = contexts.get(context)?.rootPurpose, provider = state?.provider, home = state?.sessionHome;
  if (!state || !provider?.child || provider.facade !== view || provider.stopping || provider.proxyClosed ||
      !home?.leased || provider.home !== home) invalid();
  const selected = home.purpose === HostedDependencyRootPurpose.SessionRefreshV1 ? state.refresh : state.managed;
  if (!selected) invalid(); assertCurrentHostedDependencyRootPurpose(selected,home.purpose,fence);
  readCurrentHostedManagedDependencyProviderTools(context,fence,provider.unit);
  if (contexts.get(context)?.rootPurpose !== state || state.provider !== provider || provider.stopping || provider.proxyClosed) invalid();
}
/** Fixed original-map dispatch refuses counterfeit SDK views. */
export function signalCurrentHostedManagedDependencyProviderView(context: CurrentHostedDependencyOrigin, view: CodexAppServerChildProcess, signal: NodeJS.Signals): void {
  const provider = contexts.get(context)?.rootPurpose?.provider;
  if (!provider?.child || provider.facade !== view) invalid();
  provider.stopping = true; hostedFdLaunch(provider.child).invalidate(); if (provider.proxyClosed) return;
  withHostedActivationFence(fence => {
    const actual = readCurrentHostedManagedDependencyProviderParent(context,fence), reservation = actual.facts.kind===CurrentHostedDependencyOriginKind.Ordinary ?
      actual.facts.ordinary.activation.ordinaryStarts.find(row=>row.unit===provider.unit) : actual.facts.epoch.reservations.find(row=>row.unit===provider.unit);
    if (contexts.get(context)?.rootPurpose?.provider !== provider || !reservation || reservation.state !== HostedCustodyReservationState.Reserved ||
        provider.invocationId && collectUnitInvocation(provider.unit) !== provider.invocationId) invalid();
    signalHostedSystemdUnit(provider.unit,signal); // Fixed owned unit request, never PID-only completion proof.
  });
}
/** Fixed session bootstrap. Actual home/map selection precedes command construction. */
export function readCurrentHostedDependencySessionRefreshParent(home: CurrentHostedDependencySessionHome, fence: HostedActivationFence) {
  const held = sessionHome(home,fence); if (!held.home.leased || held.state.provider) invalid();
  return held.actual;
}
export function readCurrentHostedDependencySessionModelProbeView(home:CurrentHostedDependencySessionHome):CodexAppServerChildProcess {
  const held = withHostedActivationFence(fence => sessionHome(home,fence)), provider = held.state.provider;
  if (!held.home.leased || !provider?.modelProbe || provider.home !== held.home || !provider.facade || provider.stopping) invalid(); return provider.facade;
}
export async function ensureCurrentHostedDependencySessionModel(home:CurrentHostedDependencySessionHome):Promise<void> {
  const held = withHostedActivationFence(fence => sessionHome(home,fence));
  const selected = currentSessionExecutionUse(held.context); if (selected.use.home !== home || selected.use.phase !== ManagedSessionUsePhase.Active) invalid();
  const authSha256 = hash(snapshotCurrentHostedDependencySessionAuth(home)), executable = currentSessionModelExecutable();
  // CLI catalog provenance is unavailable; observed membership never proves online entitlement.
  const cached = selected.use.modelCatalogObserved;
  if (cached && cached.model === selected.runtime.model && cached.authSha256 === authSha256 &&
      sameDependencyProtectedReference(cached.profile,held.state.record.protectedProfile) && sameDependencyProtectedReference(cached.executable,executable)) return;
  const models=await collectOriginalHostedDependencySessionModelsAfterDrain(home);
  const after=withHostedActivationFence(fence=>sessionHome(home,fence));
  if (currentSessionExecutionUse(held.context).use!==selected.use || after.state.provider || !after.home.leased ||
      !sameDependencyProtectedReference(currentSessionModelExecutable(),executable)) invalid();
  if (!models.includes(selected.runtime.model)) throw new Error("hosted_dependency_session_model_unavailable");
  selected.use.modelCatalogObserved=Object.freeze({kind:ManagedSessionModelCatalogEvidence.CatalogObservedCandidate,model:selected.runtime.model,authSha256:hash(snapshotCurrentHostedDependencySessionAuth(home)),
    profile:after.state.record.protectedProfile,executable});
}
export function spawnCurrentHostedDependencySessionModelProbe(home:CurrentHostedDependencySessionHome,fence:HostedActivationFence,unit:string):CodexAppServerChildProcess {
  const held = sessionHome(home,fence); if (!held.home.leased || held.state.provider || currentSessionExecutionUse(held.context,undefined,fence).use.home !== home) invalid();
  const purpose = held.state.refresh ??= new RootPurposeFacade(held.context,HostedDependencyRootPurpose.SessionRefreshV1,rootInternalAccess);
  assertCurrentHostedDependencyRootPurpose(purpose,HostedDependencyRootPurpose.SessionRefreshV1,fence); held.home.purpose = HostedDependencyRootPurpose.SessionRefreshV1;
  const paths = readCurrentHostedDependencySessionHome(home,fence); publishCurrentHostedManagedDependencyProvider(held.context,fence,unit);
  const view = spawnManagedProvider(held.context,fence,unit,formManagedSessionModelProbeCommand(paths,process.env.PATH!));
  held.state.provider!.modelProbe = true; return view;
}
export function spawnCurrentHostedDependencySessionRefresh(home: CurrentHostedDependencySessionHome, fence: HostedActivationFence, unit: string): CodexAppServerChildProcess {
  const held = sessionHome(home,fence); if (!held.home.leased || held.state.provider) invalid();
  const purpose = held.state.refresh ??= new RootPurposeFacade(held.context,HostedDependencyRootPurpose.SessionRefreshV1,rootInternalAccess);
  assertCurrentHostedDependencyRootPurpose(purpose,HostedDependencyRootPurpose.SessionRefreshV1,fence);
  held.home.purpose = HostedDependencyRootPurpose.SessionRefreshV1;
  const use = currentSessionExecutionUse(held.context,undefined,fence), available = use.use.modelCatalogObserved;
  if (use.use.home !== home || !available || available.model !== use.runtime.model ||
      available.authSha256 !== hash(snapshotOriginalHostedDependencySessionAuthWithHeldFence(home,fence)) ||
      !sameDependencyProtectedReference(available.profile,held.state.record.protectedProfile) ||
      !sameDependencyProtectedReference(available.executable,currentSessionModelExecutable())) invalid();
  const paths = readCurrentHostedDependencySessionHome(home,fence);
  publishCurrentHostedManagedDependencyProvider(held.context,fence,unit);
  const view = spawnManagedProvider(held.context,fence,unit,formManagedSessionRefreshCommand(paths,use.runtime.model,process.env.PATH ?? "/usr/bin:/bin"));
  const child = originalSessionProvider(home,unit).provider.child; if (!child?.stdout || !child.stderr) invalid();
  child.stdout.on("data",() => {}); child.stderr.on("data",() => {}); return view;
}
function originalSessionProvider(home:CurrentHostedDependencySessionHome,unit:string) {
  assertOriginalHostedDependencySessionHomeIdentity(home); const context = ManagedSessionHomeFacade.origin(home,rootInternalAccess);
  const state = contexts.get(context)?.rootPurpose, provider = state?.provider;
  if (!state?.sessionHome || state.sessionHome.facade !== home || !provider || provider.home !== state.sessionHome || provider.unit !== unit) invalid(); return {context,provider};
}
export function observeCurrentHostedDependencySessionRefreshFrame(home:CurrentHostedDependencySessionHome,unit:string):Promise<void> {
  return observeCurrentHostedManagedDependencyProviderFrame(originalSessionProvider(home,unit).context,unit);
}
export function releaseCurrentHostedDependencySessionRefreshFrame(home: CurrentHostedDependencySessionHome, fence: HostedActivationFence, unit: string): void {
  const held = sessionHome(home,fence); if (held.home.purpose !== HostedDependencyRootPurpose.SessionRefreshV1 || held.state.provider?.home !== held.home) invalid();
  releaseCurrentHostedManagedDependencyProviderFrame(held.context,fence,unit);
  if (held.state.provider!.modelProbe) return;
  const view = held.state.provider!.facade; if (!view) invalid();
  enqueueManagedProviderInput(held.context,view,"Respond with OK only.",fence);
  enqueueManagedProviderInput(held.context,view,undefined,fence);
}
export function invalidateCurrentHostedDependencySessionRefresh(home:CurrentHostedDependencySessionHome,unit:string):void {
  invalidateCurrentHostedManagedDependencyProvider(originalSessionProvider(home,unit).context,unit);
}
export async function finishCurrentHostedDependencySessionRefresh(home: CurrentHostedDependencySessionHome): Promise<void> {
  assertOriginalHostedDependencySessionHomeIdentity(home);
  const held = withHostedActivationFence(fence => sessionHome(home,fence)), provider = held.state.provider;
  if (!held.home.leased || held.home.purpose !== HostedDependencyRootPurpose.SessionRefreshV1 || !provider?.wait || provider.home !== held.home) invalid();
  await awaitPrivateManagedProviderClose(provider.wait,HostedManagedProviderWaitDeadline.SessionRefresh); await provider.inputTail;
  await retryHostedFenceAcquisition(() => closeCurrentHostedManagedDependencyProviderTools(held.context,provider.unit),5000);
  if (provider.proxyCode !== 0) throw new Error("hosted_dependency_session_refresh_failed");
}
/** No credential lease transition can precede the genuine provider/home drain. */
export function assertCurrentHostedDependencySessionLeaseDischarged(home: CurrentHostedDependencySessionHome): void {
  assertOriginalHostedDependencySessionHomeIdentity(home);
  withHostedActivationFence(fence => { const held = sessionHome(home,fence); if (held.state.sessionHome?.leased || held.state.provider) invalid(); });
}
export function requestStopCurrentHostedDependencySessionRefresh(home: CurrentHostedDependencySessionHome): void {
  assertOriginalHostedDependencySessionHomeIdentity(home);
  const selected = withHostedActivationFence(fence => { const held = sessionHome(home,fence), provider = held.state.provider;
    if (!provider || provider.home !== held.home || held.home.purpose !== HostedDependencyRootPurpose.SessionRefreshV1 || !provider.child) invalid();
    if (!provider.facade) invalid(); return {context:held.context,facade:provider.facade};
  });
  signalCurrentHostedManagedDependencyProviderView(selected.context,selected.facade,"SIGTERM");
}
