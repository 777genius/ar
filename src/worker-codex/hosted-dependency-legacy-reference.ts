import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readdirSync, writeFileSync } from "node:fs";
import { DependencyOwnerKind, DependencyOwnerPhase, DependencyReceiptState as State, DependencyInstallProofKind as Proof,
  claimDependencyConsumer, assertDependencyMaintenance, releaseDependencyMaintenance, sameDependencyAttempt,
  type DependencyAttempt, type HostedOrdinaryStart, type HostedOrdinaryReservation } from "@vioxen/subscription-runtime/worker-core";
import { assertHostedActivationFence, withHostedActivationFence, type HostedActivationFence, CodexProviderEgressProfileId } from "@vioxen/subscription-runtime/provider-codex";
import { readHostedOrdinaryProcessOrigin } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { HostedDependencyReferenceKind, readHostedDependencyBinding, readHostedDependencyAttempt, assertHostedDependencyQualifiedInventory,
  assertHostedDependencyPhysicalWorkspace, hostedDependencyOwnerRoot, type HostedDependencyBinding } from "./hosted-dependency-workspace";
import { LocalDependencyOwnerStore } from "../store-local-file/dependency-environment/local-dependency-owner-store";
import { hostedDependencyInstallerRoot, readHostedDependencyInstallerProfile } from "./hosted-dependency-installer-recipe";
import { HostedDependencyInstallerRecipe as Recipe, qualifyHostedDependencyInstallerInputs } from "./hosted-dependency-installer-inputs";
import { assertHostedDependencyInstallerAttemptDrained } from "./hosted-dependency-installer";
import { readHostedDependencyReceipt, readHostedDependencyCommittedUnverified, readHostedDependencyCommittedReady,
  ensureHostedDependencyDirectory } from "./hosted-dependency-receipts";
import { materializeHostedDependencyAbsence, hasHostedDependencyFreshAbsence, readHostedDependencyKeyInputs,
  assertHostedDependencyKeyInputsCurrent, type HostedDependencyKeyInputs } from "./hosted-dependency-materialization";
import { assertHostedDependencyComparisonMaintenanceUnderFence, assertHostedDependencyComparisonQuiescent } from "./hosted-dependency-transactions";
import { HostedReadonlyHostKernel, ordinaryCompletionPath, ordinaryCompletionBytes } from "./hosted-readonly-host-kernel";
import type { CodexGoalRunConfig } from "./codex-goal-runner";
import { isHostedOrdinaryRuntime } from "./hosted-installation-activation";
import { referenceFailure as fail, referencePath, encodeReference as encode, referenceHash as hash, legacyComparisonRoot,
  pinReferenceFile, readFixedReference, writeReferenceOnce, readReferenceRelation, parseReferenceStart, parseReferenceEntry, parseReferenceResult,
  type ReferenceRelation, type ReferenceStart, type ReferenceEntry, type ReferenceResult, type ReferenceRelease } from "./hosted-dependency-legacy-reference-records";

import { DependencyInstallProfile } from "../worker-core/dependency-environment/domain/dependency-install-key";
import { DependencyLegacyComparisonRecipe } from "../worker-core/dependency-environment/domain/dependency-legacy-comparison";
import { openCapturedDependencySourceLinks } from "../worker-local/dependency-environment/dependency-source-binding";
import { copyHostedLegacyLocalReferenceInputs } from "./hosted-dependency-legacy-reference-inputs";

import { assertDependencySourceExposureCurrent, type DependencySourceExposure } from "../worker-local/dependency-environment/observe-dependency-tree";
import { LocalDependencySourceBindingStore } from "../worker-local/dependency-environment/dependency-source-binding";
import { assertHostedDependencyLocalOutputProof } from "./hosted-dependency-output-proof";

type Prepared = { readonly candidateBaseline:DependencySourceExposure; readonly relation: ReferenceRelation; readonly candidateInputs: HostedDependencyKeyInputs;
  readonly referenceInputs: HostedDependencyKeyInputs; sealed: boolean };
// Only own actual captures under the two current Maintenance exclusions create
// this process-private reservation relation. A protected DTO cannot register it.
const prepared = new Map<string,Prepared>();
export enum HostedLegacyReferenceCompletionStatus { Completed="done" }
const owners = () => LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384});
function profileSha(): string { return hash(encode(readHostedDependencyInstallerProfile())); }
function absent(path: string): boolean {
  try {lstatSync(path);return false;} catch(e) {if ((e as NodeJS.ErrnoException).code === "ENOENT") return true;throw e;}
}
function semanticInputs(inputs: HostedDependencyKeyInputs) {
  if (inputs.recipe===Recipe.NpmLocalNoLifecycleV1) return {lockName:inputs.lockName,installKey:inputs.key.installKey,
    inputSha256:inputs.capture.closureDigest,profileSha256:inputs.profileSha256,closureDigest:inputs.capture.closureDigest,
    packageSha256:hash(inputs.packageBytes),lockSha256:hash(inputs.lockBytes)};
  const qualified = qualifyHostedDependencyInstallerInputs(inputs.packageBytes,inputs.lockBytes,inputs.lockName);
  return {lockName:inputs.lockName,installKey:inputs.key.installKey,inputSha256:qualified.sha256,profileSha256:profileSha(),
    closureDigest:inputs.capture.closureDigest,packageSha256:hash(inputs.packageBytes),lockSha256:hash(inputs.lockBytes)};
}
function same(a: unknown,b: unknown): boolean {return encode(a).equals(encode(b));}
function assertBindings(relation: ReferenceRelation): void {
  for (const b of [relation.candidate.binding,relation.reference.binding]) {
    if (!same(readHostedDependencyBinding(b.jobId),b)) fail();
    assertHostedDependencyPhysicalWorkspace(b);
  }
  assertHostedDependencyQualifiedInventory();
}
function assertCandidate(relation: ReferenceRelation): void {
  const store = owners();
  try {assertDependencyMaintenance(store,relation.candidate.binding.workspace,relation.candidate.maintenance);} finally {store.close();}
}
/** Finite physical copy; no original pack/scripts, no arbitrary directory tree.
 * Both actual owners and input sessions are rechecked around the synchronous
 * descriptor-anchored O_EXCL writes. No existing authored file is replaced. */
function copyRegistryInputs(binding: HostedDependencyBinding, inputs: HostedDependencyKeyInputs): void {
  const fd = openSync(binding.workspace.canonicalPath,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd,{bigint:true});
    if (!before.isDirectory() || String(before.dev) !== binding.workspace.dev || String(before.ino) !== binding.workspace.ino || before.uid !== 0n) fail();
    const names = readdirSync(`/proc/self/fd/${fd}`); if (names.length !== 1 || names[0] !== ".git") fail();
    for (const [name,bytes] of [["package.json",inputs.packageBytes],[inputs.lockName,inputs.lockBytes]] as const) {
      const child = openSync(`/proc/self/fd/${fd}/${name}`,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o644);
      try {const stat=fstatSync(child);if (!stat.isFile() || stat.uid!==0 || stat.nlink!==1) fail();writeFileSync(child,bytes);fsyncSync(child);} finally {closeSync(child);}
    }
    fsyncSync(fd); const after=lstatSync(binding.workspace.canonicalPath,{bigint:true});
    if (before.dev!==after.dev || before.ino!==after.ino) fail();
    assertHostedDependencyPhysicalWorkspace(binding);
  } finally {closeSync(fd);}
}
/** Operator preparation owns fresh captures and exclusions. Public identifiers
 * select enrolled roots; the genuine opaque original baseline is deny-only.
 * No second binding, Complete, key or callback is accepted. */
export async function prepareHostedLegacyReference(candidateJobId: string, referenceJobId: string, operationId: string, candidateBaseline:DependencySourceExposure) {
  assertDependencySourceExposureCurrent(candidateBaseline);
  referencePath(operationId,"reference"); if (prepared.has(operationId) || prepared.size>=128) fail();
  const actual = withHostedActivationFence(fence => {
    const candidate = assertHostedDependencyComparisonMaintenanceUnderFence(fence,candidateJobId,readMaintenance(candidateJobId,operationId));
    const reference = assertHostedDependencyComparisonMaintenanceUnderFence(fence,referenceJobId,readMaintenance(referenceJobId,operationId));
    if (candidate.binding.version===3 || reference.binding.version!==3 || reference.binding.reference.operationId!==operationId ||
        candidate.binding.installationId!==reference.binding.installationId || candidate.binding.workspace.canonicalPath===reference.binding.workspace.canonicalPath ||
        candidate.binding.workspace.dev===reference.binding.workspace.dev && candidate.binding.workspace.ino===reference.binding.workspace.ino ||
        reference.activation.ordinaryStarts.some(row => {
          const bytes = pinReferenceFile(`/var/lib/subscription-runtime-host-policy/ordinary-starts/${row.startId}.json`);
          return JSON.parse(bytes.bytes.toString("utf8")).workspacePath===reference.binding.workspace.canonicalPath;
        }) || !hasHostedDependencyFreshAbsence(reference.binding) || readHostedDependencyReceipt(reference.binding) ||
        !absent(reference.binding.workspace.canonicalPath+"/node_modules")) fail();
    assertHostedActivationFence(fence); return {candidate,reference};
  });
  const cm=readMaintenance(candidateJobId,operationId),rm=readMaintenance(referenceJobId,operationId);
  assertHostedDependencyComparisonQuiescent(candidateJobId,cm); assertHostedDependencyComparisonQuiescent(referenceJobId,rm);
  const candidateInputs=await readHostedDependencyKeyInputs(actual.candidate.binding);assertDependencySourceExposureCurrent(candidateBaseline);
  const inputs=semanticInputs(candidateInputs);
  withHostedActivationFence(fence => {
    assertHostedDependencyComparisonMaintenanceUnderFence(fence,candidateJobId,cm);assertHostedDependencyComparisonMaintenanceUnderFence(fence,referenceJobId,rm);
    assertHostedDependencyKeyInputsCurrent(actual.candidate.binding,candidateInputs);
    const kind=actual.reference.binding.version===3?actual.reference.binding.reference.kind:fail();
    if (candidateInputs.recipe===Recipe.NpmLocalNoLifecycleV1) {
      if (kind!==HostedDependencyReferenceKind.LegacyLocalNoLifecycleV1) fail();
      copyHostedLegacyLocalReferenceInputs(actual.reference.binding,candidateInputs);
    } else {if (kind!==HostedDependencyReferenceKind.LegacyRegistryV1) fail();copyRegistryInputs(actual.reference.binding,candidateInputs);}
    assertHostedDependencyKeyInputsCurrent(actual.candidate.binding,candidateInputs);
  });
  const referenceInputs=await readHostedDependencyKeyInputs(actual.reference.binding);assertDependencySourceExposureCurrent(candidateBaseline);
  assertHostedDependencyKeyInputsCurrent(actual.candidate.binding,candidateInputs);
  if (!same(semanticInputs(referenceInputs),inputs)) fail();
  const receipt=readHostedDependencyReceipt(actual.candidate.binding); if (receipt?.state!==State.Unverified) fail();
  const original=readHostedDependencyCommittedUnverified(actual.candidate.binding,receipt.revision);
  const referenceBinding=actual.reference.binding;if (referenceBinding.version!==3) fail();
  const fields={operationId,candidate:{binding:actual.candidate.binding,maintenance:cm,original},
    reference:{binding:referenceBinding,staging:rm},inputs};
  const relation:ReferenceRelation=candidateInputs.recipe===Recipe.NpmLocalNoLifecycleV1?
    {...fields,version:2,recipe:DependencyLegacyComparisonRecipe.NpmLocalNoLifecycleV1,profile:DependencyInstallProfile.TestNpmLocalNoLifecycleV1}:{...fields,version:1};
  withHostedActivationFence(fence => {
    assertHostedDependencyComparisonMaintenanceUnderFence(fence,candidateJobId,cm);assertHostedDependencyComparisonMaintenanceUnderFence(fence,referenceJobId,rm);
    assertHostedDependencyKeyInputsCurrent(actual.candidate.binding,candidateInputs);assertHostedDependencyKeyInputsCurrent(actual.reference.binding,referenceInputs);
    ensureHostedDependencyDirectory(legacyComparisonRoot); writeReferenceOnce(referencePath(operationId,"reference"),relation);
    assertDependencySourceExposureCurrent(candidateBaseline);
    prepared.set(operationId,{candidateBaseline,relation,candidateInputs,referenceInputs,sealed:false});
  });
  return readReferenceRelation(operationId).reference;
}
function readMaintenance(jobId: string,operationId: string) {
  const binding=readHostedDependencyBinding(jobId);if (!binding) fail();const store=owners();
  try {const current=store.read(binding.workspace);if (current?.owner?.kind!==DependencyOwnerKind.Maintenance || current.owner.attempt.operationId!==operationId) fail();return current.owner.attempt;}
  finally {store.close();}
}
/** Invoked before reserve publishes anything, then again under the same final
 * start/submit fence. Only this process's genuine prepared copy can reserve. */
export function assertHostedLegacyReferenceReservationPrepared(fence:HostedActivationFence,binding:HostedDependencyBinding):void {
  assertHostedActivationFence(fence); if (binding.version!==3) return;
  const own=prepared.get(binding.reference.operationId);if (!own || own.sealed) fail();
  const protectedRelation=readReferenceRelation(binding.reference.operationId);
  if (!same(protectedRelation.value,own.relation) || !same(binding,own.relation.reference.binding)) fail();
  assertBindings(own.relation);assertCandidate(own.relation);assertDependencySourceExposureCurrent(own.candidateBaseline);
  const store=owners();try {assertDependencyMaintenance(store,binding.workspace,own.relation.reference.staging);} finally {store.close();}
  assertHostedDependencyKeyInputsCurrent(own.relation.candidate.binding,own.candidateInputs);assertHostedDependencyKeyInputsCurrent(binding,own.referenceInputs);
  if (!same(semanticInputs(own.referenceInputs),own.relation.inputs) || !absent(binding.workspace.canonicalPath+"/node_modules") ||
      readHostedDependencyReceipt(binding) || !hasHostedDependencyFreshAbsence(binding)) fail();
}
/** Same own original copy/candidate physical sessions, retained through the
 * real foreground wait. No late capture or claimed DTO resets the baseline. */
export function assertHostedLegacyReferenceSourcesCurrent(fence:HostedActivationFence,operationId:string):void {
  assertHostedActivationFence(fence);const own=prepared.get(operationId);if (!own || !own.sealed) fail();
  if (!same(readReferenceRelation(operationId).value,own.relation)) fail();assertBindings(own.relation);assertCandidate(own.relation);assertDependencySourceExposureCurrent(own.candidateBaseline);
  assertHostedDependencyKeyInputsCurrent(own.relation.candidate.binding,own.candidateInputs);
  assertHostedDependencyKeyInputsCurrent(own.relation.reference.binding,own.referenceInputs);
  if (!same(semanticInputs(own.referenceInputs),own.relation.inputs)) fail();
}
/** Returns only a genuine independently captured reference source session.
 * Operation selects the private relation; no DTO or candidate tree is accepted. */
export function openHostedLegacyReferenceSourceLinks(operationId:string) {
  const own=prepared.get(operationId);if (!own || !own.sealed || own.referenceInputs.recipe!==Recipe.NpmLocalNoLifecycleV1 || own.relation.version!==2) fail();
  assertHostedDependencyKeyInputsCurrent(own.relation.reference.binding,own.referenceInputs);
  return openCapturedDependencySourceLinks(own.referenceInputs.capture);
}
/** Logical invalidation only; never releases a durable owner or a kernel gate. */
export function closeHostedLegacyReferencePreparation(operationId:string):void {prepared.delete(operationId);}
export function sealHostedLegacyReferenceStart(fence:HostedActivationFence,binding:HostedDependencyBinding,start:HostedOrdinaryStart,row:HostedOrdinaryReservation):void {
  if (binding.version!==3) return;assertHostedLegacyReferenceReservationPrepared(fence,binding);
  const own=prepared.get(binding.reference.operationId);if (!own) fail();
  const relation=readReferenceRelation(binding.reference.operationId),ordinary=pinReferenceFile(`/var/lib/subscription-runtime-host-policy/ordinary-starts/${row.startId}.json`);
  if (!ordinary.bytes.equals(encode(start)) || start.workspacePath!==binding.workspace.canonicalPath || row.unit!==start.unit ||
      row.generation!==start.activationGeneration || row.originSha256!==start.originSha256 || row.creatorId!==start.creatorId) fail();
  const seal:ReferenceStart={version:1,operationId:relation.value.operationId,relation:relation.reference,startId:row.startId,start:ordinary.reference,reservation:row};
  writeReferenceOnce(referencePath(seal.operationId,"reference-start"),seal);
  const store=owners();try {assertCandidate(own.relation);releaseDependencyMaintenance(store,binding.workspace,own.relation.reference.staging);} finally {store.close();}
  own.sealed=true;
}
function actualEntry(fence:HostedActivationFence,config:CodexGoalRunConfig) {
  const origin=readHostedOrdinaryProcessOrigin(fence),binding=readHostedDependencyBinding(String(origin.start.jobId));
  if (!binding || binding.version!==3) return undefined;
  // Dependency-only reference purpose cannot discard an explicit NEW policy.
  if (config.storage !== undefined || config.sessionHomeProfile !== undefined) fail();
  if (origin.profileId!==CodexProviderEgressProfileId.TestNpmQualification || origin.start.jobId!==(config.jobId??config.taskId) ||
      origin.start.jobRootDir!==config.jobRootDir || origin.start.workspacePath!==config.workspacePath || config.childLifetime ||
      config.checkpointPublisherSocketPath || config.allowDangerFullAccess || config.providerSandboxMode==="danger-full-access" ||
      (config.executionEngine??"app-server-goal")!=="app-server-goal" || config.runtimeHomeRootDir!==undefined && config.runtimeHomeRootDir!==binding.jobRootDir+"/home") fail();
  const relation=readReferenceRelation(binding.reference.operationId),sealPin=pinReferenceFile(referencePath(binding.reference.operationId,"reference-start"));
  const seal=parseReferenceStart(JSON.parse(sealPin.bytes.toString("utf8")));
  if (seal.operationId!==binding.reference.operationId || !encode(seal).equals(sealPin.bytes) || !same(seal.relation,relation.reference) || !same(binding,relation.value.reference.binding) ||
      seal.startId!==origin.reservation.startId || !same(seal.reservation,origin.reservation) ||
      seal.start.path!==`/var/lib/subscription-runtime-host-policy/ordinary-starts/${seal.startId}.json` ||
      !same(pinReferenceFile(seal.start.path).reference,seal.start) || !pinReferenceFile(seal.start.path).bytes.equals(encode(origin.start))) fail();
  assertBindings(relation.value);assertCandidate(relation.value);
  for (const [owner,b] of [[relation.value.candidate.maintenance,relation.value.candidate.binding],[relation.value.reference.staging,binding]] as const) {
    if (owner.host.bootId!==origin.start.bootId || owner.host.supervisorId!==origin.start.supervisorId || owner.host.inventoryDigest!==origin.installation.inventorySha256 ||
        owner.host.installationId!==origin.installation.installationId || owner.host.runtimeSha!==origin.installation.runtimeSha || owner.host.grantDigest!==b.grantDigest) fail();
  }
  return {origin,binding,relation,seal,sealRef:sealPin.reference};
}
/** CLI-only closed handler. A generic runner never accepts this purpose. No
 * SafeExecutionRunResult/task/attempt journal or provider completion is invented. */
export async function tryRunHostedLegacyReference(config:CodexGoalRunConfig) {
  if (!isHostedOrdinaryRuntime()) return undefined;
  const selected=withHostedActivationFence(fence => {
    const actual=actualEntry(fence,config);if (!actual) return undefined;
    if (!hasHostedDependencyFreshAbsence(actual.binding) || readHostedDependencyReceipt(actual.binding) || !absent(actual.binding.workspace.canonicalPath+"/node_modules")) fail();
    const store=owners();try {
      const attempt=claimDependencyConsumer(store,actual.binding.workspace,{installationId:actual.binding.installationId,bootId:String(actual.origin.start.bootId),
        runtimeSha:actual.binding.runtimeSha,grantDigest:actual.binding.grantDigest,startId:actual.seal.startId,unit:String(actual.origin.start.unit)},randomUUID());
      const entry:ReferenceEntry={version:1,operationId:actual.relation.value.operationId,relation:actual.relation.reference,referenceStart:actual.sealRef,attempt};
      const entryRef=writeReferenceOnce(referencePath(entry.operationId,"reference-entry"),entry);return {...actual,attempt,entryRef};
    } finally {store.close();}
  });
  if (!selected) return undefined;
  const inputs=await readHostedDependencyKeyInputs(selected.binding);if (!same(semanticInputs(inputs),selected.relation.value.inputs)) fail();
  withHostedActivationFence(fence => {
    const actual=actualEntry(fence,config);if (!actual || !same(actual.sealRef,selected.sealRef)) fail();
    const entry=readFixedReference(selected.entryRef,referencePath(selected.relation.value.operationId,"reference-entry"),v => parseReferenceEntry(v,selected.binding.workspace));
    if (!sameDependencyAttempt(entry.attempt,selected.attempt) || !sameDependencyAttempt(readHostedDependencyAttempt(selected.binding,
        actual.origin.start,actual.seal.startId,DependencyOwnerPhase.ExclusiveMutation),selected.attempt)) fail();
    assertHostedDependencyKeyInputsCurrent(selected.binding,inputs);
  });
  await materializeHostedDependencyAbsence(selected.binding,selected.attempt);
  const result=withHostedActivationFence(fence => {
    const actual=actualEntry(fence,config);if (!actual || !same(actual.sealRef,selected.sealRef)) fail();
    if (!sameDependencyAttempt(readHostedDependencyAttempt(selected.binding,actual.origin.start,actual.seal.startId,DependencyOwnerPhase.ExclusiveMutation),selected.attempt)) fail();
    assertHostedDependencyKeyInputsCurrent(selected.binding,inputs);if (!same(semanticInputs(inputs),selected.relation.value.inputs)) fail();
    const ready=readHostedDependencyReceipt(selected.binding);
    if (ready?.state!==State.Ready || (selected.relation.value.version===2?ready.provenance.kind!==Proof.CompletedLocalInstallV1:ready.provenance.kind!==Proof.CompletedInstall) || ready.generation!==selected.attempt.attemptId || ready.installKey!==inputs.key.installKey) fail();
    if (ready.provenance.kind!==Proof.CompletedInstall && ready.provenance.kind!==Proof.CompletedLocalInstallV1) fail();
    const output=readHostedDependencyCommittedReady(selected.binding,ready.revision),mapping=pinReferenceFile(`${hostedDependencyInstallerRoot}/attempt-${selected.attempt.attemptId}.json`,4096);
    const mapped:unknown=JSON.parse(mapping.bytes.toString("utf8"));
    if (!mapped || typeof mapped!=="object" || Array.isArray(mapped) || !('startId' in mapped) || typeof mapped.startId!=="string" ||
        !/^[a-f0-9-]{36}$/.test(mapped.startId)) fail();
    assertHostedDependencyInstallerAttemptDrained(selected.attempt);
    const directory=`${hostedDependencyInstallerRoot}/${mapped.startId}`,start=pinReferenceFile(directory+"/start.json"),creator=pinReferenceFile(directory+"/creator.json"),
      completion=pinReferenceFile(directory+"/creator-completion.json"),terminal=pinReferenceFile(directory+"/terminal.json");
    const retained=JSON.parse(start.bytes.toString("utf8")),finished=JSON.parse(terminal.bytes.toString("utf8"));
    if ((selected.relation.value.version===2?retained.schemaVersion!==2 || retained.recipe!==Recipe.NpmLocalNoLifecycleV1 || retained.installKey!==inputs.key.installKey || retained.closureDigest!==inputs.capture.closureDigest:retained.schemaVersion!==1 || retained.recipe!==Recipe.NpmRegistryNoScriptsV1) || retained.inputSha256!==selected.relation.value.inputs.inputSha256 ||
        retained.profileSha256!==selected.relation.value.inputs.profileSha256 || !same(retained.attempt,selected.attempt) ||
        !same(retained.workspace,selected.binding.workspace) || finished.startId!==mapped.startId || !same(finished.output,ready.tree) ||
        ready.provenance.installerDrainEvidenceId!==completion.reference.sha256 || ready.provenance.verificationEvidenceId!==ready.manifestDigest) fail();
    const common={workspace:ready.workspace,generation:ready.generation,coverageRevision:ready.coverageRevision,tree:ready.tree,
      manifestDigest:ready.manifestDigest,installationId:mapped.startId,output:output.reference,mapping:mapping.reference,
      start:start.reference,creator:creator.reference,completion:completion.reference,terminal:terminal.reference};
    const fields={operationId:selected.relation.value.operationId,relation:selected.relation.reference,referenceStart:selected.sealRef,
      referenceEntry:selected.entryRef,installKey:inputs.key.installKey,inputSha256:retained.inputSha256 as string,profileSha256:retained.profileSha256 as string};
    let body:ReferenceResult;
    if (selected.relation.value.version===2) {
      if (inputs.recipe!==Recipe.NpmLocalNoLifecycleV1 || ready.provenance.kind!==Proof.CompletedLocalInstallV1) fail();
      const source=new LocalDependencySourceBindingStore("/var/lib/subscription-runtime-host-policy/dependency-source-bindings",{assertInstallerCompletion:fail})
        .readInstalledHistory(ready.provenance.sourceBinding);
      if (source.version!==2 || source.closureDigest!==inputs.capture.closureDigest || source.generation!==ready.generation ||
          source.coverageRevision!==ready.coverageRevision || source.installKey!==ready.installKey || source.manifestDigest!==ready.manifestDigest ||
          !same(source.workspace,ready.workspace) || !same(source.tree,ready.tree) || source.installerCompletionSha256!==completion.reference.sha256) fail();
      assertHostedDependencyLocalOutputProof(source);
      body={...fields,version:2,recipe:DependencyLegacyComparisonRecipe.NpmLocalNoLifecycleV1,profile:DependencyInstallProfile.TestNpmLocalNoLifecycleV1,
        closureDigest:inputs.capture.closureDigest,reference:{...common,manifestVersion:2,sourceBinding:ready.provenance.sourceBinding}};
    } else {body={...fields,version:1,reference:{...common,manifestVersion:1}};}
    const proof=writeReferenceOnce(referencePath(body.operationId,"reference-result"),body);
    return {operationId:body.operationId,proof};
  });
  return Object.freeze({status:HostedLegacyReferenceCompletionStatus.Completed,changedFiles:[],evidence:[result.proof.sha256],blockers:[],
    nextAction:"Await genuine supervisor drain and independent legacy comparison.",details:{dependencyReferenceOperationId:result.operationId}});
}
/** Called only by the existing retained supervisor release method. It performs
 * positive live kernel checks again and writes after actual null-owner release;
 * CLI zero exit or a supplied completion DTO cannot issue this leaf. */
export function retainHostedLegacyReferenceRelease(fence:HostedActivationFence,start:HostedOrdinaryStart,row:HostedOrdinaryReservation):void {
  assertHostedActivationFence(fence);const binding=readHostedDependencyBinding(start.jobId);if (binding?.version!==3) return;
  const op=binding.reference.operationId,relation=readReferenceRelation(op);assertBindings(relation.value);assertCandidate(relation.value);
  const sealPin=pinReferenceFile(referencePath(op,"reference-start")),seal=parseReferenceStart(JSON.parse(sealPin.bytes.toString("utf8"))),
    entryPin=pinReferenceFile(referencePath(op,"reference-entry")),entry=parseReferenceEntry(JSON.parse(entryPin.bytes.toString("utf8")),binding.workspace),
    resultPin=pinReferenceFile(referencePath(op,"reference-result")),result=parseReferenceResult(JSON.parse(resultPin.bytes.toString("utf8")));
  const ordinary=pinReferenceFile(`/var/lib/subscription-runtime-host-policy/ordinary-starts/${row.startId}.json`),completion=pinReferenceFile(ordinaryCompletionPath(row.startId),4096),
    fenced=pinReferenceFile(`/var/lib/subscription-runtime-host-policy/dependency-attempt-fences/${row.startId}.json`,4096);
  if (seal.operationId!==op || entry.operationId!==op || result.operationId!==op || !same(entry.relation,relation.reference) || !same(entry.referenceStart,sealPin.reference) ||
      !encode(seal).equals(sealPin.bytes) || !encode(entry).equals(entryPin.bytes) || !encode(result).equals(resultPin.bytes) || !same(seal.relation,relation.reference) ||
      !same(seal.reservation,row) || !same(seal.start,ordinary.reference) || !ordinary.bytes.equals(encode(start)) ||
      !same(result.referenceEntry,entryPin.reference) || !same(result.referenceStart,sealPin.reference) || !same(result.relation,relation.reference) ||
      result.reference.generation!==entry.attempt.attemptId || !same(result.reference.workspace,binding.workspace) ||
      !completion.bytes.equals(ordinaryCompletionBytes(row.startId,ordinary.reference.sha256)) ||
      !fenced.bytes.equals(encode({version:1,startId:row.startId,attemptId:entry.attempt.attemptId,epoch:entry.attempt.epoch}))) fail();
  const kernel=new HostedReadonlyHostKernel(),session=kernel.operatorSession();if (session.bootId!==start.bootId || session.supervisorId!==start.supervisorId) fail();
  kernel.fenceOrdinaryCreator(row,start.bootId,ordinary.reference.sha256);kernel.drainOrdinaryQueue(row);kernel.confirmOrdinaryDescendants(row);
  pinReferenceFile(`${hostedDependencyInstallerRoot}/attempt-${entry.attempt.attemptId}.json`,4096);assertHostedDependencyInstallerAttemptDrained(entry.attempt);
  const store=owners();try {
    const owner=store.read(binding.workspace);if (!owner || owner.version!==2 || owner.owner!==null || owner.epoch!==entry.attempt.epoch) fail();
    const released:ReferenceRelease={version:1,operationId:op,referenceResult:resultPin.reference,attempt:entry.attempt,startId:row.startId,
      ordinaryStart:ordinary.reference,ordinaryCompletion:completion.reference,attemptFence:fenced.reference,ownerRevision:owner.revision};
    writeReferenceOnce(referencePath(op,"reference-release"),released);
  } finally {store.close();}
}
