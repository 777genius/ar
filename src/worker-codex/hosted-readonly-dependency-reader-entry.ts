import { DependencyToolReadyReadStatus } from "../core/dependency-environment/dependency-tool-ready-reader";
import { readCurrentHostedDependencyRootQualification } from "./hosted-dependency-tool-profile";
import { readHostedDependencyUsableReceipt } from "./hosted-dependency-usable-receipt";
import { createHash, randomUUID } from "node:crypto";
import { DependencyConsumerLaunchKind, DependencyOwnerPhase, isDependencyConsumerOwner, parseDependencyOwner,
  sameDependencyAttempt, sameDependencyProtectedReference, sameDependencyWorkspace, type DependencyAttempt,
  type DependencyProtectedReference, type DependencyWorkspaceIdentity } from "@vioxen/subscription-runtime/core";
import { assertDependencyPreclaimedConsumer, claimDependencyConsumer, HostedCustodyPhase, HostedCustodyReservationState,
  parseHostedCustodyEpoch, DependencyReceiptState } from "@vioxen/subscription-runtime/worker-core";
import { assertHostedActivationFence, readHostedActivationBytes, decodeHostedActivationBytes, type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { readHostedReadonlyDependencyStart } from "../provider-codex/app-server/adapters/hosted-dependency-origin";
import { claimCurrentHostedReadonlyDependencyGeneration, assertCurrentHostedDependencyAttempt, CurrentHostedDependencyOriginKind, type CurrentHostedDependencyOrigin } from "./hosted-current-dependency-origin";
import { hostedDependencyOwnerRoot, hostedDependencyBindingName, readHostedDependencyBinding } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { LocalDependencyOwnerStore } from "../store-local-file/dependency-environment/local-dependency-owner-store";
import { createReadonlyPrivateRecord } from "./hosted-readonly-custody";
import { readHostedPrivateBytes } from "./hosted-readonly-inputs";
import { pinReferenceFile } from "./hosted-dependency-legacy-reference-records";
import { readHostedReadonlyDependencyMaterial } from "./hosted-readonly-dependency-records";
import { ensureHostedDependencyDirectory, readHostedDependencyEstablishedReceipt, readHostedDependencyCommittedReady,
  readHostedDependencyCommittedAbsent, readHostedDependencyCommittedUnverified } from "./hosted-dependency-receipts";

const root = "/var/lib/subscription-runtime-host-policy", starts = root+"/dependency-reader-starts", entries = root+"/dependency-reader-entries", ready = root+"/dependency-reader-ready";
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)+"\n");
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function invalid(): never { throw new Error("hosted_readonly_dependency_preclaim_unresolved"); }
type ReaderStart = Readonly<{ version:1; kind:DependencyConsumerLaunchKind.ManagedReadonlyLocalV1;
  origin:DependencyProtectedReference; binding:DependencyProtectedReference; custody:DependencyProtectedReference;
  workspace:DependencyWorkspaceIdentity; attempt:DependencyAttempt; ownerRevision:number; ownerSha256:string;
  receipt:Readonly<{state:DependencyReceiptState.Ready|DependencyReceiptState.Absent|DependencyReceiptState.Unverified;
    revision:number;reference:DependencyProtectedReference}> }>;
function currentOwner(workspace: DependencyWorkspaceIdentity) {
  const name = `dependency-owners/${workspace.dev}-${workspace.ino}`;
  if (readHostedActivationBytes(name+".lock")) invalid(); const bytes = readHostedActivationBytes(name+".json");
  if (!bytes || bytes.length > 16384 || readHostedActivationBytes(name+".lock")) invalid();
  const owner = parseDependencyOwner(decodeHostedActivationBytes(bytes));
  if (!sameDependencyWorkspace(owner.workspace,workspace)) invalid(); return owner;
}
function protectedPin(path: string, maximum: number) {
  if (!readHostedPrivateBytes(path,maximum)) invalid(); return pinReferenceFile(path,maximum);
}
/** Fixed genuine supervisor producer, called after its own outer reservation and
 * immutable start publication, BEFORE the sole synchronous child submission.
 * It cannot select a request job/path or return an executor/permission callback. */
export function preclaimHostedReadonlyDependencyReader(fence: HostedActivationFence, startId: string): void {
  assertHostedActivationFence(fence);
  const epochBytes = readHostedActivationBytes("readonly-epoch.json"); if (!epochBytes) invalid();
  const epoch = parseHostedCustodyEpoch(decodeHostedActivationBytes(epochBytes)), outer = epoch.outerRuntime;
  if (epoch.phase !== HostedCustodyPhase.Ready || epoch.revoked || !outer || outer.state !== HostedCustodyReservationState.Reserved ||
      outer.startId !== startId || outer.generation !== epoch.generation) invalid();
  const material = readHostedReadonlyDependencyMaterial(fence,epoch.identity), start = readHostedReadonlyDependencyStart(fence,startId);
  const binding = readHostedDependencyBinding(material.evidence.candidate.jobId);
  if (!binding || binding.version !== 2 || !sameDependencyWorkspace(binding.workspace,material.evidence.workspace) ||
      !sameDependencyProtectedReference(start.value.association,material.reference) || start.value.generation !== epoch.generation ||
      start.value.unit !== outer.unit || start.value.readonlyJobId !== epoch.identity.jobId) invalid();
  const bindingPin = protectedPin(root+"/"+hostedDependencyBindingName(binding.jobId),16384);
  if (!bindingPin.bytes.equals(encode(binding)) || !sameDependencyProtectedReference(bindingPin.reference,material.evidence.candidate.binding)) invalid();
  const activeClaim=claimCurrentHostedReadonlyDependencyGeneration(fence,startId);
  const store = LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384});
  try {
    const before = store.read(binding.workspace);
    if (!before || before.version !== 3 || (!activeClaim && before.owner!==null) ||
        (activeClaim && (!isDependencyConsumerOwner(before.owner) || !sameDependencyAttempt(before.owner.attempt,activeClaim.attempt))) ||
        !sameDependencyProtectedReference(before.custodyBinding,material.reference)) invalid();
    const attempt = activeClaim?.attempt ?? claimDependencyConsumer(store,binding.workspace,{installationId:start.value.installationId,bootId:start.value.bootId,
      runtimeSha:start.value.runtimeSha,grantDigest:start.value.grantDigest,startId,unit:outer.unit,
      kind:DependencyConsumerLaunchKind.ManagedReadonlyLocalV1,association:material.reference,origin:start.reference},randomUUID());
    const held = store.read(binding.workspace);
    if (!held || held.version !== 3 || held.revision !== before.revision+(activeClaim?0:1) || !isDependencyConsumerOwner(held.owner) ||
        held.owner.phase !== DependencyOwnerPhase.ExclusiveMutation || !sameDependencyAttempt(held.owner.attempt,attempt)) invalid();
    const receipt = readHostedDependencyEstablishedReceipt(binding); if (!receipt) invalid();
    const committed = receipt.state === DependencyReceiptState.Ready ? readHostedDependencyCommittedReady(binding,receipt.revision) :
      receipt.state === DependencyReceiptState.Absent ? readHostedDependencyCommittedAbsent(binding,receipt.revision) :
      receipt.state === DependencyReceiptState.Unverified ? readHostedDependencyCommittedUnverified(binding,receipt.revision) : invalid();
    if (!encode(committed.receipt).equals(encode(receipt))) invalid();
    const record: ReaderStart = {version:1,kind:DependencyConsumerLaunchKind.ManagedReadonlyLocalV1,origin:start.reference,
      binding:bindingPin.reference,custody:material.reference,workspace:binding.workspace,attempt,ownerRevision:held.revision,
      ownerSha256:hash(encode(held)),receipt:{state:committed.receipt.state,revision:committed.receipt.revision,reference:committed.reference}};
    ensureHostedDependencyDirectory(starts); const path = `${starts}/${startId}.json`;
    createReadonlyPrivateRecord(path,encode(record)); if (!protectedPin(path,16384).bytes.equals(encode(record))) invalid();
    if (!readHostedActivationBytes("readonly-epoch.json")?.equals(epochBytes) || !encode(store.read(binding.workspace)).equals(encode(held)) ||
        !encode(readHostedDependencyEstablishedReceipt(binding)).equals(encode(receipt))) invalid();
  } finally { store.close(); }
}
/** Current owner and the independently issued start authenticate the protected
 * producer leaf. This is not a parser-issued permit or a second admission. */
export function readHostedReadonlyDependencyPreclaim(context: CurrentHostedDependencyOrigin, fence: HostedActivationFence,
  phase = DependencyOwnerPhase.ExclusiveMutation) {
  const actual = assertCurrentHostedDependencyAttempt(context,fence,phase);
  if (actual.facts.kind !== CurrentHostedDependencyOriginKind.ManagedReadonlyLocal) invalid();
  const {facts,binding,attempt} = actual, pin = protectedPin(`${starts}/${facts.start.startId}.json`,16384);
  const value = JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(pin.bytes)) as ReaderStart;
  if (!value || Object.keys(value).sort().join(",") !== "attempt,binding,custody,kind,origin,ownerRevision,ownerSha256,receipt,version,workspace" ||
      value.version !== 1 || value.kind !== DependencyConsumerLaunchKind.ManagedReadonlyLocalV1 || !encode(value).equals(pin.bytes) ||
      !sameDependencyAttempt(value.attempt,attempt) || !sameDependencyWorkspace(value.workspace,binding.workspace) ||
      !sameDependencyProtectedReference(value.origin,facts.originReference) || !sameDependencyProtectedReference(value.custody,facts.association.reference) ||
      !sameDependencyProtectedReference(value.binding,facts.association.evidence.candidate.binding)) invalid();
  const selectedReceipt = phase === DependencyOwnerPhase.Running ? readReadyReceipt(attempt,pin.reference) : value.receipt;
  const receipt = readHostedDependencyEstablishedReceipt(binding);
  if (!selectedReceipt || Object.keys(selectedReceipt).sort().join(",") !== "reference,revision,state" || !receipt ||
      receipt.state !== selectedReceipt.state || receipt.revision !== selectedReceipt.revision) invalid();
  const committed = receipt.state === DependencyReceiptState.Ready ? readHostedDependencyCommittedReady(binding,receipt.revision) :
    receipt.state === DependencyReceiptState.Absent ? readHostedDependencyCommittedAbsent(binding,receipt.revision) :
    receipt.state === DependencyReceiptState.Unverified ? readHostedDependencyCommittedUnverified(binding,receipt.revision) : invalid();
  if (!sameDependencyProtectedReference(committed.reference,selectedReceipt.reference)) invalid();
  const owner = currentOwner(binding.workspace);
  if (owner.version !== 3 || !isDependencyConsumerOwner(owner.owner) || !sameDependencyAttempt(owner.owner.attempt,attempt) || owner.owner.phase !== phase) invalid();
  if (phase === DependencyOwnerPhase.ExclusiveMutation && (owner.revision !== value.ownerRevision || hash(encode(owner)) !== value.ownerSha256)) invalid();
  if (phase === DependencyOwnerPhase.Running) {
    const entry = readHostedPrivateBytes(`${entries}/${facts.start.startId}.json`,4096);
    if (!entry || !entry.equals(encode({version:1,producer:pin.reference,attempt}))) invalid();
  }
  return Object.freeze({...actual,producer:pin.reference,preclaim:Object.freeze({version:1 as const,
    workspace:value.workspace,attempt:value.attempt,ownerRevision:value.ownerRevision,ownerSha256:value.ownerSha256})});
}
/** One O_EXCL entry consumes only the producer's actual current exclusive claim.
 * Replay/copy/stale owner fails before package/config/Git/provider work. */
export function consumeHostedReadonlyDependencyPreclaim(context: CurrentHostedDependencyOrigin, fence: HostedActivationFence): DependencyAttempt {
  const actual = readHostedReadonlyDependencyPreclaim(context,fence);
  const store = LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384});
  let attempt: DependencyAttempt;
  try {
    const held = assertDependencyPreclaimedConsumer(store,actual.binding.workspace,actual.preclaim);
    if (!isDependencyConsumerOwner(held.owner)) invalid(); attempt = held.owner.attempt;
    ensureHostedDependencyDirectory(entries);
    createReadonlyPrivateRecord(`${entries}/${attempt.launch.startId}.json`,encode({version:1,producer:actual.producer,attempt}));
  } finally { store.close(); }
  // The durable claim/once-entry stay held; no directory descriptor is inherited
  // by the final genuine process collector.
  readHostedReadonlyDependencyPreclaim(context,fence); return attempt;
}

function readReadyReceipt(attempt: DependencyAttempt, producer: DependencyProtectedReference): ReaderStart["receipt"] {
  const bytes = readHostedPrivateBytes(`${ready}/${attempt.launch.startId}.json`,8192); if (!bytes) invalid();
  const record = JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));
  if (!record || Object.keys(record).sort().join(",") !== "attempt,producer,receipt,version" || record.version !== 1 ||
      !encode(record).equals(bytes) || !sameDependencyAttempt(record.attempt,attempt) || !sameDependencyProtectedReference(record.producer,producer) ||
      (record.receipt?.state!==DependencyReceiptState.Ready && record.receipt?.state!==DependencyReceiptState.Unverified)) invalid();
  return record.receipt;
}
/** Actual completed tool entry producer before Running, including cold Ready
 * and truthful warm Usable. Unverified does not gain a Ready attestation.
 * The immutable initial producer stays untouched. No receipt/reference argument.
 */
export function publishHostedReadonlyDependencyReaderReady(context: CurrentHostedDependencyOrigin, fence: HostedActivationFence): void {
  const actual = assertCurrentHostedDependencyAttempt(context,fence,DependencyOwnerPhase.ExclusiveMutation);
  if (actual.facts.kind !== CurrentHostedDependencyOriginKind.ManagedReadonlyLocal) return;
  const {binding,attempt,facts} = actual, producer = protectedPin(`${starts}/${facts.start.startId}.json`,16384);
  const original = JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(producer.bytes)) as ReaderStart;
  if (!sameDependencyAttempt(original.attempt,attempt) || !sameDependencyProtectedReference(original.origin,facts.originReference) ||
      !sameDependencyProtectedReference(original.custody,facts.association.reference) || !sameDependencyWorkspace(original.workspace,binding.workspace)) invalid();
  const consumed = readHostedPrivateBytes(`${entries}/${attempt.launch.startId}.json`,4096);
  if (!consumed?.equals(encode({version:1,producer:producer.reference,attempt}))) invalid();
  const qualified=readCurrentHostedDependencyRootQualification(fence);
  if(qualified.context!==context || !sameDependencyAttempt(qualified.attempt,attempt))invalid();
  const receipt=readHostedDependencyEstablishedReceipt(binding);
  if(!receipt || !encode(receipt).equals(encode(qualified.receipt)))invalid();
  const committed=qualified.status===DependencyToolReadyReadStatus.Ready ? readHostedDependencyCommittedReady(binding,qualified.receipt.revision) :
    readHostedDependencyUsableReceipt(context,fence,DependencyOwnerPhase.ExclusiveMutation).receipt;
  if(!encode(committed.receipt).equals(encode(receipt)))invalid();
  ensureHostedDependencyDirectory(ready);
  const record = {version:1,producer:producer.reference,attempt,receipt:{state:receipt.state,revision:receipt.revision,reference:committed.reference}};
  createReadonlyPrivateRecord(`${ready}/${attempt.launch.startId}.json`,encode(record));
  const fresh = assertCurrentHostedDependencyAttempt(context,fence,DependencyOwnerPhase.ExclusiveMutation);
  if (!sameDependencyAttempt(fresh.attempt,attempt) || !encode(readHostedDependencyEstablishedReceipt(binding)).equals(encode(receipt)) ||
      !encode(readReadyReceipt(attempt,producer.reference)).equals(encode(record.receipt))) invalid();
}
