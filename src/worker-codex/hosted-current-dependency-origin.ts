import { copyBoundedHostedByteInput } from "./hosted-bounded-byte-input";
import { captureManagedSessionArtifactFacts, captureManagedSessionMaterializationInput } from "./hosted-managed-dependency-session-artifact-facts";
import { formManagedDependencyProviderStartFacts } from "./hosted-managed-provider-start-facts";
import { formManagedDependencyHomePreparationFacts } from "./hosted-managed-dependency-home-recipe-facts";
import { assertHostedDependencyRootDirectoryPinFacts as assertDirectory } from "./hosted-dependency-root-physical-facts";
import { rootIdentity, currentSessionModelExecutable, readHostedDependencyAttemptFacts as attemptFromFacts } from "./hosted-dependency-current-facts";
import { publishCurrentHostedManagedDependencyProvider } from "./hosted-managed-provider-start-record";
import { publishOriginalHostedManagedProviderCompletion } from "./hosted-managed-provider-completion-record";
import { OriginalHostedDependencyRootPurpose as RootPurposeFacade } from "./hosted-dependency-root-purpose-view";
import { prepareOriginalHostedSessionRuntimeFacts } from "./hosted-managed-dependency-runtime-recipe-facts";
import { assertRootQualificationFacts, assertRootConfigAncestorFacts, parseRootPreparationFacts } from "./hosted-dependency-root-provenance-facts";
import { writeOriginalHostedDependencySessionAuth as writeCurrentHostedDependencySessionAuth, snapshotOriginalHostedDependencySessionAuth as snapshotCurrentHostedDependencySessionAuth, snapshotOriginalHostedDependencySessionAuthWithHeldFence } from "./hosted-managed-dependency-session-auth";
import { collectOriginalHostedDependencySessionModels } from "./hosted-managed-dependency-model-probe";
import { HostedReadonlySupervisorHost } from "./hosted-readonly-supervisor-host";
import { codexAppServerProcessArgs } from "../provider-codex/app-server/application/app-server-process-args";
import { createLocalFileBackendRuntimeAdapters } from "../store-local-file/session-custody/application/local-file-backend-adapters";
import { createFixedCodexAgentDriver } from "./file-backend-codex-agent-driver-factory";
import { LocalFileManagedRunStore } from "./file-backend-codex-managed-run-store";
import { HostedManagedDependencySessionMaterializer } from "./hosted-managed-dependency-session-materializer";
import { codexAuthJsonFromArtifact, sessionArtifactFromCodexAuthJson } from "../provider-codex/codex-auth-json-codec";
import { codexProviderEgressEnv } from "../provider-codex/codex-provider-egress-policy";
import { CodexJsonAgentDriver } from "../provider-codex/codex-json-agent-driver";
import { SessionExecutionUseDisposition, type SessionExecutionUse, type SessionExecutionLifecyclePort, type LeaseStorePort, type SessionStorePort, type SessionArtifact, type RedactorPort } from "@vioxen/subscription-runtime/core";
import { ManagedSessionUsePhase, ManagedSessionModelCatalogEvidence, type ManagedSessionRuntimeState } from "./hosted-managed-dependency-session-state";
import { assertHostedDependencyRootDirectoryFacts } from "./hosted-dependency-root-record-facts";
import { OriginalHostedDependencySessionHome as ManagedSessionHomeFacade } from "./hosted-managed-dependency-home-view";
import { freezeFacts } from "./hosted-dependency-immutable-facts";
import { OriginalHostedDependencyRootDescriptor as RootDescriptor } from "./hosted-dependency-root-resource-view";
import { awaitPrivateManagedProviderClose, HostedManagedProviderWaitDeadline } from "./hosted-managed-provider-wait-deadline";
import { preparePhysicalOriginalHostedDependencySessionHome } from "./hosted-managed-dependency-home-preparation";
import { sameRootDescriptorStat as sameStat, readHostedDependencyRootDirectoryPin, rootDescriptorPhysicalInfo as info, sameRootDescriptorDirectory as sameDirectory, sameRootDescriptorFile as sameFile, assertHostedDependencyRootDescriptorMaterial, closePhysicalHostedDependencyRootDescriptor } from "./hosted-dependency-root-physical-facts";
export { readHostedDependencyRootDirectoryPin } from "./hosted-dependency-root-physical-facts";
import type { ManagedProviderState, ManagedSessionHomeState } from "./hosted-managed-dependency-session-state";
import { collectActualHostedManagedReadonlyOrigin } from "./hosted-managed-readonly-origin-collector";
import { createHostedManagedDependencySdkView } from "./hosted-managed-dependency-sdk-view";
import { selectHostedDependencyRootDescriptorPath } from "./hosted-dependency-root-descriptor-selection";
import { hostedManagedDependencyProviderInvocation, bindHostedDependencyToolChild, abandonHostedDependencyToolInvocation, assertHostedManagedDependencyToolRelease } from "./hosted-managed-dependency-tool-plan";
import { spawnHostedFdChild, hostedFdLaunch } from "../provider-codex/app-server/adapters/hosted-fd-launch";
import { retryHostedFenceAcquisition } from "../provider-codex/app-server/adapters/hosted-fd-fence";
import { signalHostedSystemdUnit, type CodexAppServerChildProcess } from "../provider-codex/app-server/adapters/node-app-server-process";
import { buildCodexRefreshBootstrapPlan } from "../provider-codex/codex-cli-domain";
import { createHash } from "node:crypto";
import { codexProviderEgressPolicy, CodexProviderEgressProfileId } from "../provider-codex/codex-provider-egress-policy";
import { HostedReadonlyEpochStore } from "./hosted-readonly-epoch-store";
import { collectUnitInvocation } from "./hosted-readonly-linux-collector";
import { type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync, writeFileSync, type BigIntStats } from "node:fs";
import { dirname } from "node:path";
import { DependencyOwnerPhase, isDependencyConsumerOwner, parseDependencyOwner, sameDependencyProtectedReference, sameDependencyWorkspace, sameDependencyAttempt, parseDependencyGenerationContinuityInvalidation, type DependencyProtectedReference } from "@vioxen/subscription-runtime/core";
import { terminalHostedCustodyStart, HostedCustodyReservationState, DependencyReceiptState } from "@vioxen/subscription-runtime/worker-core";
import { assertHostedActivationFence, assertHostedActivationOperator, decodeHostedActivationBytes, readHostedActivationBytes, readHostedOrdinaryProcessOrigin, withHostedActivationFence, type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { type HostedDependencyBinding } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { assertHostedProcessDescriptors } from "../provider-codex/app-server/adapters/hosted-process-descriptors";
import { assertHostedRetainedToolDescriptors, type HostedRetainedToolFiles } from "../provider-codex/app-server/adapters/hosted-retained-tool-files";
import { observeHostedFdProcess } from "../provider-codex/app-server/adapters/hosted-fd-observation";
import { systemdObservationBudget } from "../provider-codex/app-server/adapters/systemd-service-arrays";
import { assertHostedFdProcess, HostedFdLaunchKind } from "../provider-codex/app-server/adapters/hosted-fd-child";
import { hostedDependencySystemdRunExecutable } from "../provider-codex/app-server/adapters/hosted-dependency-systemd-command";
import { LocalDependencyReceiptStore } from "../store-local-file/dependency-environment/local-dependency-receipt-store";
import { LocalDependencyOwnerStore } from "../store-local-file/dependency-environment/local-dependency-owner-store";
import { invalidateDependencyGeneration } from "../worker-core/dependency-environment/application/invalidate-dependency-generation";
import { DependencyUnverifiedReason } from "../worker-core/dependency-environment/domain/dependency-receipt";
import { hostedDependencyReceiptHistoryRoot } from "../provider-codex/app-server/adapters/hosted-dependency-history-path";
import { dependencyToolQualificationRecordName, dependencyToolGuestConfig, dependencyToolGuestConfigPath, parseDependencyToolQualification } from "../core/dependency-environment/dependency-tool-profile";
import { assertHostedDependencyRootGitProfile } from "../provider-codex/app-server/adapters/hosted-dependency-root-git-profile";
import { assertHostedDependencyRootGitConfigBytes } from "../provider-codex/app-server/adapters/hosted-dependency-root-git-config";
import { HostedDependencyRootDescriptorRecipe, type HostedDependencyRootDescriptorAnchor, type HostedDependencyRootDescriptorMaterial } from "../provider-codex/app-server/adapters/hosted-dependency-root-descriptor-material";
export { HostedDependencyRootDescriptorRecipe } from "../provider-codex/app-server/adapters/hosted-dependency-root-descriptor-material";
import { HostedDependencyRootPurpose, isHostedDependencySignedTaskId, type HostedDependencyManagedGitScope, type HostedDependencyRootScope, type HostedDependencyManagedProviderFacts, type HostedDependencyRootDirectoryPin, type HostedDependencyRootPreparationRecord } from "../provider-codex/app-server/adapters/hosted-dependency-root-purpose-record";
export { HostedDependencyRootPurpose, isHostedDependencySignedTaskId } from "../provider-codex/app-server/adapters/hosted-dependency-root-purpose-record";
export type { HostedDependencyManagedGitScope, HostedDependencyRootScope, HostedDependencyRootDirectoryPin } from "../provider-codex/app-server/adapters/hosted-dependency-root-purpose-record";
const root = "/var/lib/subscription-runtime-host-policy", transport = "/run/user/0/subscription-runtime-host-policy";
const brand: unique symbol = Symbol("hosted.current.dependency.origin");
export type CurrentHostedDependencyOrigin = Readonly<{ [brand]: true }>;
export enum CurrentHostedDependencyOriginKind { Ordinary = "ordinary", ManagedReadonlyLocal = "managed_readonly_local" }
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
function invalid(): never { throw new Error("hosted_dependency_current_origin_unresolved"); }
const contexts = new WeakMap<CurrentHostedDependencyOrigin, { digest: string; facts: CurrentHostedDependencyOriginFacts; scope?: HostedRetainedToolFiles; rootPurpose?: RootPurposeState }>();
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
function selectedSnapshot(fence: HostedActivationFence, scope?: HostedRetainedToolFiles, rootPurpose?: RootPurposeState) {
  assertHostedActivationFence(fence); assertHostedActivationOperator();
  const group = readFileSync("/proc/self/cgroup","utf8").trim();
  if (/^0::\/subscription\.slice\/subscription-runtime\.slice\/subscription-runtime-hosted\.slice\/subscription-runtime-ordinary-[a-f0-9-]{36}\.service$/.test(group)) {
    const ordinary = readHostedOrdinaryProcessOrigin(fence,scope);
    return { digest:hash(JSON.stringify(ordinary)), facts:Object.freeze({kind:CurrentHostedDependencyOriginKind.Ordinary,ordinary}) };
  }
  const before = collectActualHostedManagedReadonlyOrigin(fence);
  // Descriptor authority stays solely in this actual original-map entry.
  if (rootPurpose?.descriptors.size) {
    if (scope !== undefined) invalid(); assertRootPurposeDescriptors(rootPurpose);
  } else if (scope === undefined) assertHostedProcessDescriptors(); else assertHostedRetainedToolDescriptors(scope);
  const after = collectActualHostedManagedReadonlyOrigin(fence);
  if (after.digest !== before.digest) invalid();
  return after;
}
export type CurrentHostedDependencyOriginFacts = ReturnType<typeof selectedSnapshot>["facts"];
/** Fixed process/history identity only; consumers still join actual owner. */
export function readCurrentHostedDependencyOrigin(fence: HostedActivationFence, scope?: HostedRetainedToolFiles): CurrentHostedDependencyOrigin {
  const selected = selectedSnapshot(fence,scope), context = Object.freeze({[brand]:true as const});
  contexts.set(context,{digest:selected.digest,facts:freezeFacts(selected.facts),...(scope ? {scope}: {})}); return context;
}
export function assertCurrentHostedDependencyOrigin(context: CurrentHostedDependencyOrigin, fence: HostedActivationFence): CurrentHostedDependencyOriginFacts {
  const retained = contexts.get(context); if (!retained) invalid();
  const current = selectedSnapshot(fence,retained.scope,retained.rootPurpose); if (current.digest !== retained.digest) invalid(); return current.facts;
}
export function invalidateCurrentHostedDependencyOrigin(context: CurrentHostedDependencyOrigin): void {
  const retained = contexts.get(context); let failure: unknown;
  const provider = retained?.rootPurpose?.provider;
  if (provider?.child) { provider.stopping = true;
    try { hostedFdLaunch(provider.child).invalidate(); } catch (error) { failure = error; }
  }
  // Resource revocation is cleanup only. Delete authority even if physical close
  // fails, so no failed revocation can leave a future helper permit alive.
  try { for (const descriptor of [...(retained?.rootPurpose?.descriptors.keys() ?? [])]) {
    try { descriptor.close(); } catch (error) { failure ??= error; }
  } } finally { contexts.delete(context); if (currentRootOrigin === context) currentRootOrigin = undefined; }
  if (failure !== undefined) throw failure;
}
export type CurrentHostedManagedDependencyProvider = HostedDependencyManagedProviderFacts;
function managedProviderBirth(context: CurrentHostedDependencyOrigin, fence: HostedActivationFence, unit: string): CurrentHostedManagedDependencyProvider {
  const retained = contexts.get(context); if (!retained?.rootPurpose) invalid();
  assertCurrentHostedDependencyRootPurpose(retained.rootPurpose.managed,HostedDependencyRootPurpose.ManagedGitReadV1,fence);
  const actual = assertCurrentHostedDependencyAttempt(context,fence,DependencyOwnerPhase.Running);
  if (actual.facts.kind !== CurrentHostedDependencyOriginKind.ManagedReadonlyLocal ||
      !sameDependencyAttempt(actual.attempt,retained.rootPurpose.record.attempt)) invalid();
  const match = /^subscription-runtime-hosted-([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\.service$/.exec(unit);
  if (!match || match[0] !== unit) invalid(); const providerStartId = match[1]!;
  const facts = actual.facts, epoch = facts.epoch;
  const reservation = epoch.reservations.find(row => row.unit === unit);
  if (!reservation || reservation.startId !== providerStartId || reservation.creatorId !== providerStartId ||
      reservation.state !== HostedCustodyReservationState.Reserved || epoch.generation !== facts.start.generation ||
      epoch.identity.jobId !== facts.start.readonlyJobId || epoch.identity.workspacePath !== actual.binding.workspace.canonicalPath ||
      epoch.identity.jobRootDir !== actual.binding.jobRootDir) invalid();
  const ready = currentRootReady(actual.binding);
  if (!encode(ready).equals(encode(retained.rootPurpose.ready))) invalid();
  const record = retained.rootPurpose.record;
  return formManagedDependencyProviderStartFacts(actual,providerStartId,record,ready);
}
export function readCurrentHostedManagedDependencyProviderParent(context: CurrentHostedDependencyOrigin, fence: HostedActivationFence) {
  const state = contexts.get(context)?.rootPurpose; if (!state) invalid();
  assertCurrentHostedDependencyRootPurpose(state.managed,HostedDependencyRootPurpose.ManagedGitReadV1,fence);
  const actual = assertCurrentHostedDependencyAttempt(context,fence);
  if (actual.facts.kind !== CurrentHostedDependencyOriginKind.ManagedReadonlyLocal) invalid();
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
/** Fixed provider resources belong solely to the original-origin entry. */
export function prepareCurrentHostedManagedDependencyProviderTools(context: CurrentHostedDependencyOrigin, fence: HostedActivationFence, unit: string) {
  const selected = readCurrentHostedManagedDependencyProvider(context,fence,unit), state = contexts.get(context)?.rootPurpose;
  if (!state || state.provider) invalid();
  const scope = assertCurrentHostedDependencyRootPurpose(state.managed,HostedDependencyRootPurpose.ManagedGitReadV1,fence);
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
    const associate = (path: string, pin: HostedDependencyRootDirectoryPin) => {
      const physical = openHostedDependencyRootDescriptorMaterial(scope,HostedDependencyRootDescriptorRecipe.DurableFileV1,path,
        {directory:false,maximum:16384,root:pin});
      const resource = new RootDescriptor(context,physical,rootInternalAccess); state.descriptors.set(resource,physical);
      opened.push(resource); Object.freeze(resource); return resource;
    };
    const record = associate(state.record.qualification.path,readHostedDependencyRootDirectoryPin(dirname(state.record.qualification.path)));
    const capsule = associate(capsulePath,rootPin);
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
    retained.provider.home = retained.sessionHome;
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
  hostedFdLaunch(provider.child).invalidate();
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
  if (!Number.isSafeInteger(child.pid) || child.pid! <= 0) invalid();
  provider.child = child; provider.proxyPid = child.pid; provider.proxyBirth = observeHostedFdProcess(child.pid!).birth; provider.proxyClosed = false;
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
  if (!state || !provider || provider.unit !== unit || !provider.child || !provider.proxyClosed || !provider.proxyPid ||
      !provider.proxyBirth || !provider.invocationId || provider.proxySignal !== null || !Number.isInteger(provider.proxyCode) ||
      provider.proxyCode === null || provider.proxyCode === undefined || provider.proxyCode < 0 || provider.proxyCode > 255) invalid();
  return freezeFacts({parent,reference:provider.reference,pid:provider.proxyPid,birth:provider.proxyBirth,
    invocationId:provider.invocationId,waitStatus:provider.proxyCode});
}
export function closeCurrentHostedManagedDependencyProviderTools(context: CurrentHostedDependencyOrigin, unit: string): void {
  const state = contexts.get(context)?.rootPurpose, provider = state?.provider;
  if (!state || !provider) return; if (provider.unit !== unit) invalid();
  if (!provider.child) {
    if (provider.spawnAttempted) invalid();
    provider.capsule.close(); provider.record.close(); delete state.provider; return;
  }
  const store = new HostedReadonlyEpochStore();
  withHostedActivationFence(fence => store.withHeldFence(fence,() => {
    const completed = publishOriginalHostedManagedProviderCompletion(context,fence,unit);
    if (contexts.get(context)?.rootPurpose !== state || state.provider !== provider) invalid();
    const current = readCurrentHostedManagedDependencyProviderParent(context,fence);
    if (!sameDependencyAttempt(current.attempt,completed.parent.attempt) || !encode(current.facts.epoch).equals(encode(completed.parent.facts.epoch))) invalid();
    store.publishEpoch(terminalHostedCustodyStart(current.facts.epoch,completed.reservation.startId));
    provider.capsule.close(); provider.record.close(); delete state.provider;
    readCurrentHostedManagedDependencyProviderParent(context,fence);
  }));
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
export { isHostedManagedReadonlyOuterRuntime, isCurrentHostedDependencyManagedReadonlyOrigin, requiresCurrentHostedDependencyRootPurpose } from "./hosted-dependency-current-facts";
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
type RootPurposeState = {
  readonly record: HostedDependencyRootPreparationRecord; readonly reference: DependencyProtectedReference;
  readonly ready: ReturnType<LocalDependencyReceiptStore["getCommittedReady"]>;
  readonly managed: RootPurposeFacade; cleanup?: RootPurposeFacade; refresh?: RootPurposeFacade;
  readonly descriptors: Map<RootDescriptor, HostedDependencyRootDescriptorMaterial>;
  provider?: ManagedProviderState; sessionHome?: ManagedSessionHomeState; sessionCache?: ManagedSessionHomeState; preparingHome?: ManagedSessionHomeFacade; sessionRuntime?: ManagedSessionRuntimeState;
};
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
function assertRootPurposeDescriptors(state: RootPurposeState): void {
  if (state.descriptors.size > 256) invalid();
  for (const material of state.descriptors.values()) assertHostedDependencyRootDescriptorMaterial(material);
  for (const fd of [0,1,2]) { const stat = fstatSync(fd); if (!stat.isFIFO() && !stat.isSocket()) invalid(); }
  const names = readdirSync("/proc/self/fd"); if (names.length > 512) invalid();
  for (const name of names) {
    if (!/^(?:0|[1-9][0-9]{0,5})$/.test(name)) invalid(); const fd = Number(name); if (fd <= 2) continue;
    try {
      const stat = fstatSync(fd); if (!stat.isFile() && !stat.isDirectory()) continue;
      const associated = [...state.descriptors.values()].find(material => material.fd === fd ||
        [...material.ancestors,...material.dependencies].some(anchor => anchor.fd === fd));
      if (!associated) invalid(); assertHostedDependencyRootDescriptorMaterial(associated);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EBADF") throw error; }
  }
}
let currentRootOrigin: CurrentHostedDependencyOrigin | undefined;
const encode = (value: unknown): Buffer => Buffer.from(JSON.stringify(value)+"\n");
function currentOwnerForRoot(binding: HostedDependencyBinding) {
  const name = `dependency-owners/${binding.workspace.dev}-${binding.workspace.ino}`;
  if (readHostedActivationBytes(name+".lock")) invalid(); const owner = parseDependencyOwner(decodeHostedActivationBytes(fixed(name+".json",16384).bytes));
  if (readHostedActivationBytes(name+".lock") || !sameDependencyWorkspace(owner.workspace,binding.workspace)) invalid(); return owner;
}
function currentRootReady(binding: HostedDependencyBinding) {
  const store = LocalDependencyReceiptStore.open({rootPath:hostedDependencyReceiptHistoryRoot,maxRecordBytes:16384,maxHistorySteps:2048});
  try {
    const receipt = store.read(binding.workspace); if (!receipt || receipt.state !== DependencyReceiptState.Ready) invalid();
    const committed = store.getCommittedReady(binding.workspace,receipt.revision);
    if (!encode(committed.receipt).equals(encode(receipt))) invalid(); return freezeFacts(committed);
  } finally { store.close(); }
}
function readRootPreparation(context: CurrentHostedDependencyOrigin, fence: HostedActivationFence) {
  const actual = assertCurrentHostedDependencyAttempt(context,fence,DependencyOwnerPhase.ExclusiveMutation), {binding,attempt,facts} = actual;
  if (facts.kind !== CurrentHostedDependencyOriginKind.ManagedReadonlyLocal || binding.version !== 2) invalid();
  const selected = fixed(`dependency-root-preparations/${attempt.launch.startId}.json`,65536);
  const record = parseRootPreparationFacts(selected.bytes,attempt,facts.association.reference);
  const ready = currentRootReady(binding);
  if (record.readyRevision !== ready.receipt.revision || !sameDependencyProtectedReference(record.ready,ready.reference)) invalid();
  assertRootPhysicalRecord(record,facts,binding,attempt);
  const after = assertCurrentHostedDependencyAttempt(context,fence,DependencyOwnerPhase.ExclusiveMutation);
  if (!sameDependencyAttempt(after.attempt,attempt) || !encode(currentRootReady(binding)).equals(encode(ready))) invalid();
  return {record:freezeFacts(record),reference:freezeFacts(selected.reference),ready};
}
function assertRootPhysicalRecord(record: HostedDependencyRootPreparationRecord, facts: CurrentHostedDependencyOriginFacts, binding: HostedDependencyBinding, attempt: ReturnType<typeof attemptFromFacts>["attempt"], remaining = systemdObservationBudget()) {
  const identity = rootIdentity(facts,binding);
  assertHostedDependencyRootDirectoryFacts(record,binding,identity.durable,attempt.launch.startId);
  const qualification = material(record.qualification,`${root}/${dependencyToolQualificationRecordName(attempt.launch.startId)}`,16384), q = parseDependencyToolQualification(decodeHostedActivationBytes(qualification.bytes));
  assertRootQualificationFacts(record,binding,attempt,q,currentRootReady(binding).receipt);
  const sourceBinding = record.providerReady.provenance.sourceBinding;
  material({path:sourceBinding.path,identity:sourceBinding.identity,sha256:sourceBinding.sha256},sourceBinding.path,262144);
  const profile = material(record.protectedProfile,`${root}/dependency-installer-profile.json`,16384);
  const decoded = decodeHostedActivationBytes(profile.bytes) as Record<string,unknown>;
  if (decoded.schemaVersion !== 2) invalid(); const rootGit = assertHostedDependencyRootGitProfile(decoded.rootGit,remaining);
  const config = material(record.config,`${binding.workspace.canonicalPath}/.git/config`,65536,false);
  assertHostedDependencyRootGitConfigBytes(config.bytes);
  assertRootConfigAncestorFacts(record,binding);
  if (remaining() <= 0) invalid(); return {identity,rootGit};
}
/** No DTO inputs. Loads the sole trusted qualifier's fixed protected record and actual Ready before Running; provenance lives in the original origin map. */
export function prepareCurrentHostedDependencyRootPurpose(context: CurrentHostedDependencyOrigin, fence: HostedActivationFence): void {
  const retained = contexts.get(context); if (!retained || retained.rootPurpose) invalid();
  const preparation = readRootPreparation(context,fence), managed = new RootPurposeFacade(context,HostedDependencyRootPurpose.ManagedGitReadV1,rootInternalAccess);
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
    if (!sameDependencyAttempt(current.attempt,state.record.attempt) || !encode(currentRootReady(current.binding)).equals(encode(state.ready))) invalid();
    state.cleanup = new RootPurposeFacade(origin,purpose,rootInternalAccess); return state.cleanup;
  });
}
function rootScope(context: RootPurposeFacade, purpose: HostedDependencyRootPurpose, fence: HostedActivationFence, phase: DependencyOwnerPhase) {
  const {origin,state} = resolveRootPurpose(context,purpose,rootInternalAccess), actual = assertCurrentHostedDependencyAttempt(origin,fence,phase);
  const {binding,attempt,facts} = actual, owner = currentOwnerForRoot(binding);
  if (facts.kind !== CurrentHostedDependencyOriginKind.ManagedReadonlyLocal || owner.version !== 3 || !isDependencyConsumerOwner(owner.owner) ||
      !sameDependencyAttempt(owner.owner.attempt,attempt) || owner.owner.phase !== phase || !sameDependencyAttempt(attempt,state.record.attempt) ||
      !sameDependencyProtectedReference(owner.custodyBinding,state.record.custodyReference)) invalid();
  material(state.reference,`${root}/dependency-root-preparations/${attempt.launch.startId}.json`,65536);
  const identity = rootIdentity(facts,binding), scope: HostedDependencyRootScope = freezeFacts({logicalJobId:binding.jobId,logicalTaskId:identity.logicalTaskId,
    executionJobId:identity.executionJobId,jobRootDir:binding.jobRootDir,workspace:binding.workspace,attempt,ownerRevision:owner.revision,custodyReference:owner.custodyBinding});
  return {origin,state,actual,owner,scope};
}
export function assertCurrentHostedDependencyRootPurpose(context: HostedDependencyRootPurposeContext, purpose: HostedDependencyRootPurpose.ManagedGitReadV1 | HostedDependencyRootPurpose.SessionRefreshV1, fence: HostedActivationFence): HostedDependencyManagedGitScope {
  const remaining = systemdObservationBudget(), held = rootScope(context,purpose,fence,DependencyOwnerPhase.Running);
  if (!encode(currentRootReady(held.actual.binding)).equals(encode(held.state.ready))) invalid();
  const physical = assertRootPhysicalRecord(held.state.record,held.actual.facts,held.actual.binding,held.actual.attempt,remaining);
  const after = assertCurrentHostedDependencyAttempt(held.origin,fence,DependencyOwnerPhase.Running);
  if (!sameDependencyAttempt(after.attempt,held.actual.attempt) || !encode(currentOwnerForRoot(after.binding)).equals(encode(held.owner)) ||
      !encode(currentRootReady(after.binding)).equals(encode(held.state.ready)) || remaining() <= 0) invalid();
  const record = held.state.record;
  return Object.freeze({...held.scope,rootGit:physical.rootGit,protectedProfile:record.protectedProfile,durableHandoffRoot:record.durableHandoffRoot,
    scratchParent:record.scratchParent,authoredRoots:record.authoredRoots,generatedRoots:record.generatedRoots,sourceLookupAncestors:record.sourceLookupAncestors});
}
/** Sole original-map descriptor association; no supplied FD/pins. */
export function openCurrentHostedDependencyRootDescriptor(context: HostedDependencyRootPurposeContext, fence: HostedActivationFence, recipe: HostedDependencyRootDescriptorRecipe, path: string): HostedDependencyRootDescriptor {
  const {origin,state} = resolveRootPurpose(context,HostedDependencyRootPurpose.ManagedGitReadV1,rootInternalAccess);
  const scope = assertCurrentHostedDependencyRootPurpose(context,HostedDependencyRootPurpose.ManagedGitReadV1,fence);
  if (state.descriptors.size >= 256) invalid();
  const material = openHostedDependencyRootDescriptorMaterial(scope,recipe,path), descriptor = new RootDescriptor(origin,material,rootInternalAccess);
  Object.freeze(descriptor);
  state.descriptors.set(descriptor,material);
  try { assertCurrentHostedDependencyRootPurpose(context,HostedDependencyRootPurpose.ManagedGitReadV1,fence); return descriptor; }
  catch (error) { descriptor.close(); throw error; }
}
export function assertCurrentHostedDependencyRetiredReady(context: HostedDependencyRootPurposeContext, fence: HostedActivationFence): HostedDependencyRootScope {
  const held = rootScope(context,HostedDependencyRootPurpose.DependencySourceCleanupV1,fence,DependencyOwnerPhase.ExclusiveMutation);
  if (held.owner.version !== 3 || !held.owner.generationContinuity) invalid();
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
    if ((reason !== DependencyUnverifiedReason.TreeChanged && reason !== DependencyUnverifiedReason.InputsChanged) ||
        !encode(currentRootReady(held.actual.binding)).equals(encode(held.state.ready))) invalid();
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
          if (!encode(previousOwner).equals(encode(held.owner)) || proposedOwner.revision !== previousOwner.revision+1 ||
              !encode(proposedOwner.owner).equals(encode(previousOwner.owner)) || proposedOwner.epoch !== previousOwner.epoch ||
              !sameDependencyProtectedReference(proposedOwner.custodyBinding,held.state.record.custodyReference) ||
              invalidation.operationId !== held.actual.attempt.attemptId || invalidation.readyRevision !== held.state.ready.receipt.revision ||
              invalidation.unverifiedRevision !== held.state.ready.receipt.revision+1 || invalidation.generation !== held.state.ready.receipt.generation ||
              !sameDependencyProtectedReference(invalidation.previousReady,held.state.ready.reference)) invalid();
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
function denied(): never { throw new Error("hosted_dependency_root_descriptor_denied"); }
function openHostedDependencyRootDescriptorMaterial(scope: HostedDependencyManagedGitScope, recipe: HostedDependencyRootDescriptorRecipe, path: string,
  fixedSelection?: Readonly<{directory:false;maximum:number;root:HostedDependencyRootDirectoryPin}>): HostedDependencyRootDescriptorMaterial {
  const selection = fixedSelection ?? selectHostedDependencyRootDescriptorPath(scope,recipe,path), descriptors: number[] = [], ancestors: HostedDependencyRootDescriptorAnchor[] = [], dependencies: HostedDependencyRootDescriptorAnchor[] = [];
  let retained = false;
  try {
    let parent = openSync("/",constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW); descriptors.push(parent);
    let physical = "/", actual = fstatSync(parent,{bigint:true});
    if (!sameDirectory(actual,lstatSync("/",{bigint:true})) || actual.uid !== 0n || actual.gid !== 0n || (actual.mode & 0o022n)) denied();
    const segments = path === "/" ? [] : path.slice(1).split("/");
    for (let index = 0; index < segments.length; index++) {
      ancestors.push(Object.freeze({fd:parent,path:physical,stat:actual,...info(parent)}));
      const last = index === segments.length-1, directory = !last || selection.directory;
      const named = `/proc/self/fd/${parent}/${segments[index]!}`, before = lstatSync(named,{bigint:true});
      const fd = openSync(named,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK|(directory ? constants.O_DIRECTORY:0));
      descriptors.push(fd); physical = physical === "/" ? "/"+segments[index]! : physical+"/"+segments[index]!;
      actual = fstatSync(fd,{bigint:true});
      if (!(directory ? sameDirectory(actual,before):sameFile(actual,before)) || actual.uid !== 0n || actual.gid !== 0n ||
          (actual.mode & 0o022n) || realpathSync(`/proc/self/fd/${fd}`) !== physical ||
          !(directory ? sameDirectory(actual,lstatSync(named,{bigint:true})):sameFile(actual,lstatSync(named,{bigint:true})))) denied();
      parent = fd;
    }
    const fd = parent, openedInfo = info(fd);
    if (!selection.directory && (!actual.isFile() || actual.nlink !== 1n || actual.size < 0n || actual.size > BigInt(selection.maximum))) denied();
    if (selection.root) {
      const rootPath = recipe === HostedDependencyRootDescriptorRecipe.TaskEventsV1 ? scope.jobRootDir : selection.root.canonicalPath;
      const anchor = path === rootPath ? {stat:actual,mountId:openedInfo.mountId} : ancestors.find(pin => pin.path === rootPath);
      if (!anchor || anchor.stat.dev.toString() !== selection.root.dev ||
        anchor.mountId !== selection.root.mountId || actual.dev.toString() !== selection.root.dev || openedInfo.mountId !== selection.root.mountId) denied();
      if (recipe !== HostedDependencyRootDescriptorRecipe.TaskEventsV1 && anchor.stat.ino.toString() !== selection.root.ino) denied();
      if (selection.directory && ((path === scope.scratchParent.canonicalPath || path.startsWith(scope.scratchParent.canonicalPath+"/")) || (path === scope.durableHandoffRoot.canonicalPath || path.startsWith(scope.durableHandoffRoot.canonicalPath+"/"))) &&
          (actual.mode & 0o7777n) !== 0o700n) denied();
      if (recipe === HostedDependencyRootDescriptorRecipe.TaskEventsV1) {
        const child = openSync(`/proc/self/fd/${descriptors[ancestors.findIndex(pin => pin.path === rootPath)]!}/durable-handoffs`,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
        descriptors.push(child); const durable = fstatSync(child,{bigint:true}), childInfo = info(child);
        if (durable.dev.toString() !== selection.root.dev || durable.ino.toString() !== selection.root.ino || childInfo.mountId !== selection.root.mountId ||
            durable.uid !== 0n || durable.gid !== 0n || (durable.mode & 0o7777n) !== 0o700n ||
            !sameDirectory(durable,lstatSync(selection.root.canonicalPath,{bigint:true})) || realpathSync(`/proc/self/fd/${child}`) !== selection.root.canonicalPath) denied();
        dependencies.push(Object.freeze({fd:child,path:selection.root.canonicalPath,stat:durable,...childInfo}));
      }
    }
    const result = {fd,path,directory:selection.directory,stat:actual,...openedInfo,ancestors:Object.freeze(ancestors),dependencies:Object.freeze(dependencies),closed:false};
    assertHostedDependencyRootDescriptorMaterial(result); retained = true; return result;
  } finally { if (!retained) for (const fd of descriptors.reverse()) closeSync(fd); }
}
/** Fixed actual stores and driver. No supplied StorePort, constructor or terminal DTO. */
export function createCurrentHostedDependencySessionRuntime(context: CurrentHostedDependencyOrigin, input: Omit<Parameters<typeof createFixedCodexAgentDriver>[0], "managedSession" | "managedRunStore"> & {readonly redactor:RedactorPort}) {
  if (!contexts.get(context)?.rootPurpose) invalid();
  input = Object.freeze({...input,options:Object.freeze({...input.options})});
  const state = withHostedActivationFence(fence => {
    const actual = readCurrentHostedManagedDependencyProviderParent(context,fence), selected = contexts.get(context)?.rootPurpose;
    if (!selected || selected.sessionRuntime) invalid();
    const physical = prepareOriginalHostedSessionRuntimeFacts(context,fence,input.options);
    readCurrentHostedManagedDependencyProviderParent(context,fence);
    return {state:selected,...physical};
  });
  const physical = createLocalFileBackendRuntimeAdapters({providerId:"codex",rootDir:state.root+"/sessions",
    encryptionKey:input.options.encryptionKey,metadata:{adapter:"file-backend-codex-worker"}});
  const managedRunStore = new LocalFileManagedRunStore(state.root+"/managed-runs",input.redactor);
  const materializer = new HostedManagedDependencySessionMaterializer(context);
  const driver = createFixedCodexAgentDriver({...input,managedRunStore,managedSession:materializer});
  if (!(driver instanceof CodexJsonAgentDriver)) invalid(); Object.freeze(driver);
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
  const leaseStore:LeaseStorePort = Object.freeze({leaseStoreId:physical.leaseStore.leaseStoreId,capabilities:physical.leaseStore.capabilities,
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
      try { await release(input); checked(selected); selected.use.lease!.terminal = true; }
      catch (error) { selected.use.credentialUnknown = true; throw error; } },
  });
  const sessionStore:SessionStorePort = Object.freeze({storeId:physical.sessionStore.storeId,custody:physical.sessionStore.custody,capabilities:physical.sessionStore.capabilities,
    read:async input => { input = Object.freeze({...input}); const selected = sessionRuntime(context), result = await read(input);
      if (sessionRuntime(context).runtime !== selected.runtime) invalid();
      if (result) { const captured = captureManagedSessionArtifactFacts(result.artifact); if (result.providerInstanceId !== input.providerInstanceId || result.generationHash !== captured.hash) invalid(); selected.runtime.sessionReads.set(result.artifact,{account:input.providerInstanceId,hash:captured.hash}); } return result; },
    write:async input => { input = Object.freeze({...input}); const selected = sessionRuntime(context), use = selected.runtime.use;
      if (use) { const ownedUse = owned(); assertSessionExecutionUseDischarged(ownedUse); if (use.account !== input.providerInstanceId || !use.snapshot || use.snapshot.artifact !== input.nextArtifact) invalid(); const captured = captureManagedSessionArtifactFacts(input.nextArtifact); if (captured.hash !== use.snapshot.hash) invalid(); input = {...input,nextArtifact:captured.artifact};
        if (use.lease && (use.lease.leaseId !== input.leaseId || use.lease.providerInstanceId !== input.providerInstanceId)) invalid(); use.writing = true;
      } else { if (selected.state.sessionHome?.leased || selected.state.provider || selected.state.preparingHome) invalid(); selected.runtime.idleWrites++; }
      try { const result = await write(input); const after = sessionRuntime(context);
        if (after.runtime !== selected.runtime || after.runtime.use !== use) invalid();
        if (use) { if (result.status !== "stale_generation" && result.generationHash !== use.snapshot!.hash) invalid(); delete use.writing; use.writeStatus = result.status; use.writebackKey = input.idempotencyKey; } else selected.runtime.idleWrites--; return result;
      } catch (error) { if (use) use.credentialUnknown = true; throw error; } },
    delete:async input => { input = Object.freeze({...input}); const selected = sessionRuntime(context);
      if (selected.runtime.use || selected.runtime.idleWrites || selected.state.sessionHome?.leased || selected.state.provider) invalid();
      selected.runtime.idleWrites++; try { await remove(input); if (sessionRuntime(context).runtime !== selected.runtime) invalid(); selected.runtime.idleWrites--; }
      catch (error) { throw error; } },
  });
  state.state.sessionRuntime = {lifecycle,driver,materializer,sessionStore,leaseStore,model:state.model,stateRoot:state.stateRoot,sessionRoot:state.sessionRoot,tail:Promise.resolve(),idleWrites:0,sessionReads:new WeakMap()};
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
function assertSessionExecutionUseDischarged(selected:ReturnType<typeof currentSessionExecutionUse>):void {
  const {state,use} = selected;
  if (use.phase === ManagedSessionUsePhase.Begun && !use.home && !state.preparingHome && !state.sessionHome?.leased && !state.provider) return;
  if (use.phase !== ManagedSessionUsePhase.Released || !use.home || state.sessionHome?.facade !== use.home || state.sessionHome.leased || state.provider || state.preparingHome) invalid();
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
  if (use.phase !== ManagedSessionUsePhase.Begun && !use.lease && (!use.writeStatus && runtime.driver.sessionExecutionNeedsWriteback(handle) !== false)) invalid();
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
    sessionHash:hash(auth),env:Object.freeze({HOME:paths.home,CODEX_HOME:paths.codexHome,...codexProviderEgressEnv(codexProviderEgressPolicy(CodexProviderEgressProfileId.TestManagedQualification))}),
    snapshotSession:async () => { currentSessionExecutionUse(context,use.handle);
      if (use.phase !== ManagedSessionUsePhase.Active || use.materialized !== materialized) invalid();
      try { await drainCurrentHostedDependencySessionProvider(home); currentSessionExecutionUse(context,use.handle);
        const artifact = sessionArtifactFromCodexAuthJson(snapshotCurrentHostedDependencySessionAuth(home)); use.snapshot = {artifact,hash:captureManagedSessionArtifactFacts(artifact).hash}; return artifact; }
      catch (error) { use.credentialUnknown = true; throw error; } },
    release:() => use.release ??= (async () => { const before = currentSessionExecutionUse(context,use.handle);
      if (before.use !== use || use.materialized !== materialized || use.phase !== ManagedSessionUsePhase.Active) invalid();
      await releaseCurrentHostedDependencySessionHome(home); const after = currentSessionExecutionUse(context,use.handle);
      if (after.use !== use || use.phase !== ManagedSessionUsePhase.Released) invalid(); })(),
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
  return formManagedDependencyHomePreparationFacts(qualification.bytes,actual.binding.jobRootDir,actual.attempt);
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
    await awaitPrivateManagedProviderClose(provider.wait,HostedManagedProviderWaitDeadline.Release);
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
    if (!use || use.home !== home || use.phase !== ManagedSessionUsePhase.Active) invalid();
    after.home.leased = false; use.phase = ManagedSessionUsePhase.Released;
  }),5000);
}
function leaseCurrentHostedDependencySessionHome(home: CurrentHostedDependencySessionHome): CurrentHostedDependencySessionHome {
  assertOriginalHostedDependencySessionHomeIdentity(home);
  return withHostedActivationFence(fence => {
    const held = sessionHome(home,fence);
    if (held.state.sessionCache !== held.home || held.state.sessionHome?.leased || held.state.provider) invalid();
    const facade = Object.freeze(new ManagedSessionHomeFacade(held.context,rootInternalAccess));
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
  }).finally(() => { provider.inputBytes = (provider.inputBytes ?? length)-length; });
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
    const actual = readCurrentHostedManagedDependencyProviderParent(context,fence), reservation = actual.facts.epoch.reservations.find(row => row.unit === provider.unit);
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
  new HostedReadonlySupervisorHost().startDependencySessionModelProbe(home);
  try {
    const models = await collectOriginalHostedDependencySessionModels(home);
    const beforeDrain = withHostedActivationFence(fence => sessionHome(home,fence));
    if (currentSessionExecutionUse(held.context).use !== selected.use || beforeDrain.state.provider?.home !== held.home || !beforeDrain.state.provider.modelProbe) invalid();
    await drainCurrentHostedDependencySessionProvider(home);
    const after = withHostedActivationFence(fence => sessionHome(home,fence));
    if (currentSessionExecutionUse(held.context).use !== selected.use || after.state.provider || !after.home.leased ||
        !sameDependencyProtectedReference(currentSessionModelExecutable(),executable)) invalid();
    if (!models.includes(selected.runtime.model)) throw new Error("hosted_dependency_session_model_unavailable");
    selected.use.modelCatalogObserved = Object.freeze({kind:ManagedSessionModelCatalogEvidence.CatalogObservedCandidate,model:selected.runtime.model,authSha256:hash(snapshotCurrentHostedDependencySessionAuth(home)),
      profile:after.state.record.protectedProfile,executable});
  } catch (error) { await drainCurrentHostedDependencySessionProvider(home); throw error; }
}
export function spawnCurrentHostedDependencySessionModelProbe(home:CurrentHostedDependencySessionHome,fence:HostedActivationFence,unit:string):CodexAppServerChildProcess {
  const held = sessionHome(home,fence); if (!held.home.leased || held.state.provider || currentSessionExecutionUse(held.context,undefined,fence).use.home !== home) invalid();
  const purpose = held.state.refresh ??= new RootPurposeFacade(held.context,HostedDependencyRootPurpose.SessionRefreshV1,rootInternalAccess);
  assertCurrentHostedDependencyRootPurpose(purpose,HostedDependencyRootPurpose.SessionRefreshV1,fence); held.home.purpose = HostedDependencyRootPurpose.SessionRefreshV1;
  const paths = readCurrentHostedDependencySessionHome(home,fence); publishCurrentHostedManagedDependencyProvider(held.context,fence,unit);
  const view = spawnManagedProvider(held.context,fence,unit,Object.freeze({command:"codex",args:codexAppServerProcessArgs({bypassHookTrust:true}),cwd:paths.emptyWorkdir,
    env:Object.freeze({PATH:process.env.PATH!,HOME:paths.home,CODEX_HOME:paths.codexHome,CI:"1",SUBSCRIPTION_RUNTIME_SANDBOX_KIND:"hosted-codex-job"})}));
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
  const paths = readCurrentHostedDependencySessionHome(home,fence), plan = buildCodexRefreshBootstrapPlan({codexBinaryPath:"codex",tempHome:paths.home,
    tempCodexHome:paths.codexHome,emptyWorkingDirectory:paths.emptyWorkdir,authJsonPath:paths.codexHome+"/auth.json",model:use.runtime.model});
  publishCurrentHostedManagedDependencyProvider(held.context,fence,unit);
  const view = spawnManagedProvider(held.context,fence,unit,Object.freeze({...plan,env:Object.freeze({PATH:process.env.PATH ?? "/usr/bin:/bin",HOME:plan.env.HOME!,CODEX_HOME:plan.env.CODEX_HOME!,REVIEWROUTER_CODEX_AUTH_PATH:plan.env.REVIEWROUTER_CODEX_AUTH_PATH!,CI:"1",SUBSCRIPTION_RUNTIME_SANDBOX_KIND:"hosted-codex-job"})}));
  const child = held.state.provider?.child; if (!child?.stdout || !child.stderr) invalid();
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
  await awaitPrivateManagedProviderClose(provider.wait,HostedManagedProviderWaitDeadline.SessionRefresh);
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
