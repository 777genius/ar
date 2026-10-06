import { closeSync, constants, fsyncSync, openSync, writeFileSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DependencyOwnerPhase, isDependencyConsumerOwner, sameDependencyAttempt, sameDependencyProtectedReference,
  sameDependencyWorkspace, type DependencyProtectedReference } from "@vioxen/subscription-runtime/core";
import { assertDependencyPreclaimedConsumer, captureDependencyConsumerPreclaim, claimDependencyConsumer,
  HostedActivationPhase, HostedCustodyReservationState, parseHostedOrdinaryStart, DependencyReceiptState, type DependencyConsumerPreclaim } from "@vioxen/subscription-runtime/worker-core";
import { assertHostedActivationFence, decodeHostedActivationBytes, readHostedActivationBytes, type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { assertHostedDependencyPhysicalWorkspace, assertHostedDependencyQualifiedInventory, hostedDependencyOwnerRoot,
  hostedDependencyBindingName, readHostedDependencyBinding, type HostedDependencyBinding } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { assertHostedDependencyParentRecipe, assertHostedDependencyParentEnvironment } from "../provider-codex/app-server/adapters/hosted-dependency-parent-recipe";
import { LocalDependencyOwnerStore } from "../store-local-file/dependency-environment/local-dependency-owner-store";
import { createReadonlyPrivateRecord } from "./hosted-readonly-custody";
import { readHostedPrivateBytes } from "./hosted-readonly-inputs";
import { readHostedOrdinaryBirth, readHostedOrdinaryRuntime } from "./hosted-installation-activation";
import { HostedReadonlyHostKernel, readHostedReadonlyHostInventory } from "./hosted-readonly-host-kernel";
import { pinReferenceFile } from "./hosted-dependency-legacy-reference-records";
import { ensureHostedDependencyDirectory, readHostedDependencyEstablishedReceipt, readHostedDependencyCommittedReady,
  readHostedDependencyCommittedAbsent, readHostedDependencyCommittedUnverified } from "./hosted-dependency-receipts";
import { assertHostedDependencyInstallerAttemptDrained } from "./hosted-dependency-installer";
import { assertCurrentHostedDependencyAttempt, CurrentHostedDependencyOriginKind, type CurrentHostedDependencyOrigin } from "./hosted-current-dependency-origin";
import { readCurrentHostedDependencySignedParentRecipe } from "./hosted-dependency-current-facts";

const root = "/var/lib/subscription-runtime-host-policy";
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)+"\n");
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export enum HostedOrdinaryDependencyReaderKind { OrdinaryDependencyReaderV1 = "ordinary_dependency_reader_v1" }
type ReceiptPin = Readonly<{state:DependencyReceiptState.Ready|DependencyReceiptState.Absent|DependencyReceiptState.Unverified;
  revision:number;reference:DependencyProtectedReference}> | null;
type ReaderStart = Readonly<{version:1;kind:HostedOrdinaryDependencyReaderKind;origin:DependencyProtectedReference;
  binding:DependencyProtectedReference;recipeSha256:string;preclaim:DependencyConsumerPreclaim;receipt:ReceiptPin}>;
function invalid():never { throw new Error("hosted_ordinary_dependency_preclaim_unresolved"); }
function startName(id:string):string {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) invalid(); return `ordinary-starts/${id}.json`;
}
function pin(name:string,maximum=16384) {
  const path = `${root}/${name}`, bytes = readHostedPrivateBytes(path,maximum); if (!bytes) invalid();
  const selected = pinReferenceFile(path,maximum); if (!selected.bytes.equals(bytes)) invalid(); return selected;
}
function receiptPin(binding:HostedDependencyBinding):ReceiptPin {
  const receipt = readHostedDependencyEstablishedReceipt(binding); if (!receipt) return null;
  if (receipt.state!==DependencyReceiptState.Ready && receipt.state!==DependencyReceiptState.Absent && receipt.state!==DependencyReceiptState.Unverified) invalid();
  const committed = receipt.state === DependencyReceiptState.Ready ? readHostedDependencyCommittedReady(binding,receipt.revision) :
    receipt.state === DependencyReceiptState.Absent ? readHostedDependencyCommittedAbsent(binding,receipt.revision) :
    receipt.state === DependencyReceiptState.Unverified ? readHostedDependencyCommittedUnverified(binding,receipt.revision) : invalid();
  if (!encode(committed.receipt).equals(encode(receipt))) invalid();
  return {state:receipt.state,revision:receipt.revision,reference:committed.reference};
}
/** Before publishing the selected new parent: actual prior same-workspace
 * submitters must already have positive completion, queue and descendants proof.
 * Ambiguous or live prior writers remain held. No PID-absence/TTL exception. */
export function assertHostedOrdinaryDependencyWriterBoundary(fence:HostedActivationFence,jobId:string):void {
  assertHostedActivationFence(fence); const actual = readHostedOrdinaryBirth(jobId), binding = readHostedDependencyBinding(jobId);
  if (binding?.version !== 2) return;
  if (binding.installationId !== actual.installation.installationId || binding.runtimeSha !== actual.installation.runtimeSha ||
      binding.workspace.canonicalPath !== actual.birth.workspacePath || binding.jobRootDir !== actual.birth.jobRootDir) invalid();
  assertHostedDependencyQualifiedInventory(); assertHostedDependencyPhysicalWorkspace(binding);
  const kernel = new HostedReadonlyHostKernel(), session = kernel.operatorSession();
  if (session.bootId !== actual.activation.bootId || session.supervisorId !== actual.activation.supervisorId) invalid();
  for (const row of actual.activation.ordinaryStarts) {
    const prior = pin(startName(row.startId)), start = parseHostedOrdinaryStart(decodeHostedActivationBytes(prior.bytes));
    if (start.workspacePath !== binding.workspace.canonicalPath) continue;
    if (start.installationId !== binding.installationId || start.bootId !== actual.activation.bootId || start.unit !== row.unit ||
        start.originSha256 !== row.originSha256 || start.activationGeneration !== row.generation ||
        row.state !== HostedCustodyReservationState.Terminal) invalid();
    kernel.fenceOrdinaryCreator(row,actual.activation.bootId,prior.reference.sha256);
    kernel.drainOrdinaryQueue(row); kernel.confirmOrdinaryDescendants(row);
    if (row.unit.startsWith("subscription-runtime-ordinary-")) {
      const reader = readHostedPrivateBytes(`${root}/dependency-reader-starts/${row.startId}.json`,16384);
      if (reader) { const record = parseReaderStart(reader);
        if (!sameDependencyProtectedReference(record.origin,prior.reference) || !sameDependencyWorkspace(record.preclaim.workspace,binding.workspace)) invalid();
        assertHostedDependencyInstallerAttemptDrained(record.preclaim.attempt);
      }
    }
  }
}
/** Existing inspected producer invokes this after its exact parent reservation
 * and immutable start, before synchronous OS submission. The supplied startId
 * only selects the producer's actual start, never a workspace or permission. */
export function preclaimHostedOrdinaryDependencyReader(fence:HostedActivationFence,startId:string):void {
  assertHostedActivationFence(fence); const original = pin(startName(startId)), start = parseHostedOrdinaryStart(decodeHostedActivationBytes(original.bytes));
  const actual = readHostedOrdinaryBirth(start.jobId), binding = readHostedDependencyBinding(start.jobId);
  if (binding?.version !== 2) return;
  const kernel = new HostedReadonlyHostKernel(), session = kernel.operatorSession();
  const row = actual.activation.ordinaryStarts.find(value => value.startId === startId);
  if (!row || row.state !== HostedCustodyReservationState.Reserved || row.generation !== start.activationGeneration ||
      row.unit !== start.unit || row.creatorId !== start.creatorId || row.originSha256 !== start.originSha256 ||
      start.creatorPidBirth !== kernel.ordinaryCreatorBirth() || session.bootId !== start.bootId || session.supervisorId !== start.supervisorId ||
      actual.activation.generation !== row.generation || actual.originSha256 !== start.originSha256 ||
      actual.birth.workspacePath !== start.workspacePath || actual.birth.jobRootDir !== start.jobRootDir ||
      binding.installationId !== start.installationId || binding.runtimeSha !== actual.installation.runtimeSha ||
      binding.workspace.canonicalPath !== start.workspacePath || binding.jobRootDir !== start.jobRootDir || binding.grantDigest !== start.grantSha256) invalid();
  assertHostedDependencyQualifiedInventory(); assertHostedDependencyPhysicalWorkspace(binding);
  const inventory = readHostedReadonlyHostInventory(), inventoryBytes = readHostedActivationBytes("readonly-inventory.json");
  if (!inventoryBytes || hash(inventoryBytes) !== actual.installation.inventorySha256) invalid();
  const creators = inventory.ordinaryCreators.filter(value => value.creatorId === start.creatorId && value.jobId === start.jobId &&
    value.workspacePath === start.workspacePath && value.jobRootDir === start.jobRootDir);
  if (creators.length !== 1) invalid(); const recipe = creators[0]!.launch;
  assertHostedDependencyParentRecipe(recipe.args,binding.jobRootDir,binding.workspace.canonicalPath);
  const bindingPin = pin(hostedDependencyBindingName(binding.jobId)); if (!bindingPin.bytes.equals(encode(binding))) invalid();
  // The genuine history store distinguishes factual null from broken history;
  // no project/NM traversal occurs here. Capture before opening the owner store.
  const receipt = receiptPin(binding);
  const store = LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384});
  let preclaim:DependencyConsumerPreclaim;
  try {
    const before = store.read(binding.workspace); if (before && before.version !== 2) invalid();
    const attempt = claimDependencyConsumer(store,binding.workspace,{installationId:binding.installationId,bootId:start.bootId,
      runtimeSha:binding.runtimeSha,grantDigest:binding.grantDigest,startId,unit:start.unit},randomUUID());
    preclaim = captureDependencyConsumerPreclaim(store,binding.workspace,attempt);
  } finally { store.close(); }
  const record:ReaderStart = {version:1,kind:HostedOrdinaryDependencyReaderKind.OrdinaryDependencyReaderV1,
    origin:original.reference,binding:bindingPin.reference,recipeSha256:hash(encode(recipe)),preclaim,receipt};
  ensureHostedDependencyDirectory(`${root}/dependency-reader-starts`);
  createReadonlyPrivateRecord(`${root}/dependency-reader-starts/${startId}.json`,encode(record));
  if (!pin(`dependency-reader-starts/${startId}.json`).bytes.equals(encode(record)) ||
      !pin(startName(startId)).bytes.equals(original.bytes) || !pin(hostedDependencyBindingName(binding.jobId)).bytes.equals(bindingPin.bytes) ||
      !encode(receiptPin(binding)).equals(encode(receipt))) invalid();
  const owner = LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384});
  try { assertDependencyPreclaimedConsumer(owner,binding.workspace,preclaim); } finally { owner.close(); }
}
function parseReaderStart(bytes:Buffer):ReaderStart {
  const record = decodeHostedActivationBytes(bytes) as ReaderStart;
  if (!record || Object.keys(record).sort().join(",") !== "binding,kind,origin,preclaim,receipt,recipeSha256,version" ||
      record.version !== 1 || record.kind !== HostedOrdinaryDependencyReaderKind.OrdinaryDependencyReaderV1 ||
      !/^[a-f0-9]{64}$/.test(record.recipeSha256) || !encode(record).equals(bytes)) invalid(); return record;
}
/** Actual original context authenticates the immutable producer. This does not
 * construct a context, root purpose, session use or process from record data. */
function readOrdinaryReaderSelection(context:CurrentHostedDependencyOrigin,fence:HostedActivationFence,phase:DependencyOwnerPhase) {
  const actual = assertCurrentHostedDependencyAttempt(context,fence,phase);
  if (actual.facts.kind !== CurrentHostedDependencyOriginKind.Ordinary || actual.binding.version !== 2) invalid();
  const {attempt,binding,facts} = actual, producer = pin(`dependency-reader-starts/${attempt.launch.startId}.json`);
  const record = parseReaderStart(producer.bytes), original = pin(startName(attempt.launch.startId));
  const bindingPin = pin(hostedDependencyBindingName(binding.jobId)), recipe = readCurrentHostedDependencySignedParentRecipe(facts);
  if (!record.preclaim || record.preclaim.version !== 1 || Object.keys(record.preclaim).sort().join(",") !== "attempt,ownerRevision,ownerSha256,version,workspace" ||
      !Number.isSafeInteger(record.preclaim.ownerRevision) || record.preclaim.ownerRevision < 1 || !/^[a-f0-9]{64}$/.test(record.preclaim.ownerSha256) ||
      !sameDependencyAttempt(record.preclaim.attempt,attempt) || !sameDependencyWorkspace(record.preclaim.workspace,binding.workspace) ||
      !sameDependencyProtectedReference(record.origin,original.reference) || !original.bytes.equals(encode(facts.ordinary.start)) ||
      !sameDependencyProtectedReference(record.binding,bindingPin.reference) || !bindingPin.bytes.equals(encode(binding)) ||
      hash(encode(recipe)) !== record.recipeSha256) invalid();
  return Object.freeze({...actual,producer:producer.reference,origin:original.reference,record});
}
export function readHostedOrdinaryDependencyPreclaim(context:CurrentHostedDependencyOrigin,fence:HostedActivationFence) {
  const actual = readOrdinaryReaderSelection(context,fence,DependencyOwnerPhase.ExclusiveMutation), store = LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384});
  try { assertDependencyPreclaimedConsumer(store,actual.binding.workspace,actual.record.preclaim); } finally { store.close(); }
  if (!encode(receiptPin(actual.binding)).equals(encode(actual.record.receipt))) invalid(); return actual;
}
/** Historical preclaim is immutable provenance after real consumption, not a
 * demand that later legitimate receipt/Running CAS keep its old revision. */
export function readHostedOrdinaryDependencyReaderEntry(context:CurrentHostedDependencyOrigin,fence:HostedActivationFence,phase:DependencyOwnerPhase) {
  const actual = readOrdinaryReaderSelection(context,fence,phase), entry = pin(`dependency-reader-entries/${actual.attempt.launch.startId}.json`,4096);
  if (!entry.bytes.equals(encode({version:1,producer:actual.producer,attempt:actual.attempt}))) invalid();
  return Object.freeze({...actual,entry:entry.reference});
}
/** O_EXCL once-entry, before selected layout/auth/Git/dependency/source IO. */
export function consumeHostedOrdinaryDependencyPreclaim(context:CurrentHostedDependencyOrigin,fence:HostedActivationFence) {
  const actual = readHostedOrdinaryDependencyPreclaim(context,fence);
  ensureHostedDependencyDirectory(`${root}/dependency-reader-entries`);
  const name = `dependency-reader-entries/${actual.attempt.launch.startId}.json`;
  const bytes = encode({version:1,producer:actual.producer,attempt:actual.attempt});
  const path = `${root}/${name}`;
  const fd = openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try { writeFileSync(fd,bytes); fsyncSync(fd); } finally { closeSync(fd); }
  for (let parent=dirname(path);;parent=dirname(parent)) {
    const directory = openSync(parent,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
    try { fsyncSync(directory); } finally { closeSync(directory); } if (parent === "/") break;
  }
  const entry = pin(name,4096); if (!entry.bytes.equals(bytes)) invalid();
  readHostedOrdinaryDependencyPreclaim(context,fence); return Object.freeze({attempt:actual.attempt,producer:actual.producer,entry:entry.reference});
}

/** Before first foreground frame and again before bootstrap executes the signed
 * CLI: actual supervisor or actual matching ordinary unit selects this fixed
 * start. No entry is consumed in the separate bootstrap process. */
function readReservedOrdinaryDependencyReader(fence:HostedActivationFence,startId:string) {
  assertHostedActivationFence(fence); const original=pin(startName(startId)),start=parseHostedOrdinaryStart(decodeHostedActivationBytes(original.bytes));
  const actual=readHostedOrdinaryBirth(start.jobId),binding=readHostedDependencyBinding(start.jobId); if (binding?.version!==2) return undefined;
  const kernel=new HostedReadonlyHostKernel(),group=readFileSync("/proc/self/cgroup","utf8").trim();
  const session=group===`0::${start.controlGroup}` ? kernel.ordinaryRuntimeSession(start) : kernel.operatorSession();
  const row=actual.activation.ordinaryStarts.find(value=>value.startId===startId);
  if (actual.activation.phase!==HostedActivationPhase.Ordinary || !row || row.state!==HostedCustodyReservationState.Reserved ||
      row.generation!==start.activationGeneration || row.unit!==start.unit || row.creatorId!==start.creatorId || row.originSha256!==start.originSha256 ||
      binding.installationId!==start.installationId || binding.runtimeSha!==actual.installation.runtimeSha || binding.grantDigest!==start.grantSha256 ||
      actual.originSha256!==start.originSha256 || binding.jobRootDir!==start.jobRootDir || binding.workspace.canonicalPath!==start.workspacePath ||
      session.bootId!==start.bootId || session.supervisorId!==start.supervisorId) invalid();
  if (group===`0::${start.controlGroup}`) {
    const runtime=readHostedOrdinaryRuntime(fence);
    if (!encode(runtime.start).equals(original.bytes) || runtime.reservation.startId!==startId) invalid();
  } else if (start.creatorPidBirth!==kernel.ordinaryCreatorBirth()) invalid();
  const recordPin=pin(`dependency-reader-starts/${startId}.json`),record=parseReaderStart(recordPin.bytes),bindingPin=pin(hostedDependencyBindingName(binding.jobId));
  const inventory=readHostedReadonlyHostInventory(),inventoryBytes=readHostedActivationBytes("readonly-inventory.json");
  if (!inventoryBytes || hash(inventoryBytes)!==actual.installation.inventorySha256) invalid();
  const creators=inventory.ordinaryCreators.filter(value=>value.creatorId===start.creatorId && value.jobId===binding.jobId &&
    value.jobRootDir===binding.jobRootDir && value.workspacePath===binding.workspace.canonicalPath);
  if (creators.length!==1) invalid(); const launch=creators[0]!.launch;
  assertHostedDependencyParentRecipe(launch.args,binding.jobRootDir,binding.workspace.canonicalPath);
  if (!sameDependencyProtectedReference(record.origin,original.reference) || !sameDependencyProtectedReference(record.binding,bindingPin.reference) ||
      !bindingPin.bytes.equals(encode(binding)) || record.recipeSha256!==hash(encode(launch)) ||
      record.preclaim.attempt.launch.startId!==startId || record.preclaim.attempt.launch.unit!==row.unit ||
      record.preclaim.attempt.launch.installationId!==binding.installationId || record.preclaim.attempt.launch.bootId!==start.bootId ||
      record.preclaim.attempt.launch.runtimeSha!==binding.runtimeSha || record.preclaim.attempt.launch.grantDigest!==binding.grantDigest) invalid();
  const owner=LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384});
  try { assertDependencyPreclaimedConsumer(owner,binding.workspace,record.preclaim); } finally { owner.close(); }
  if (!encode(receiptPin(binding)).equals(encode(record.receipt)) || !pin(startName(startId)).bytes.equals(original.bytes)) invalid();
  assertHostedDependencyPhysicalWorkspace(binding); return {binding,launch,producer:recordPin.reference};
}
export function readHostedOrdinaryDependencyParentFrame(fence:HostedActivationFence,startId:string,frame:string|Buffer) {
  const selected=readReservedOrdinaryDependencyReader(fence,startId); if (!selected) return undefined;
  const data=decodeHostedActivationBytes(Buffer.from(frame)) as Record<string,unknown>;
  if (!data || Object.keys(data).sort().join(",")!=="env,schemaVersion" || data.schemaVersion!==1 || !data.env || typeof data.env!=="object" || Array.isArray(data.env)) invalid();
  assertHostedDependencyParentEnvironment(data.env as Record<string,string>,selected.binding.jobRootDir);
  readReservedOrdinaryDependencyReader(fence,startId); return selected;
}
export function assertHostedOrdinaryDependencyBootstrap(fence:HostedActivationFence):void {
  const runtime=readHostedOrdinaryRuntime(fence); readReservedOrdinaryDependencyReader(fence,runtime.reservation.startId);
}
