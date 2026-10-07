import { DependencyToolReadyReadStatus } from "../core/dependency-environment/dependency-tool-ready-reader";
import { parseDependencyToolAdmissionQualification } from "../core/dependency-environment/dependency-tool-execution";
import { readHostedDependencyUsableReceipt } from "./hosted-dependency-usable-receipt";
import { readCurrentHostedDependencyRootQualification } from "./hosted-dependency-tool-profile";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type BigIntStats } from "node:fs";
import { dirname } from "node:path";
import { DependencyOwnerPhase, sameDependencyAttempt, sameDependencyProtectedReference, type DependencyProtectedReference } from "@vioxen/subscription-runtime/core";
import { type HostedActivationFence, decodeHostedActivationBytes } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { LocalDependencyReceiptStore } from "../store-local-file/dependency-environment/local-dependency-receipt-store";
import { hostedDependencyReceiptHistoryRoot } from "../provider-codex/app-server/adapters/hosted-dependency-history-path";
import { DependencyReceiptState } from "@vioxen/subscription-runtime/worker-core";
import { DependencyToolReadyProvenanceKind } from "../core/dependency-environment/dependency-tool-ready-reader";
import { dependencyToolQualificationRecordName } from "../core/dependency-environment/dependency-tool-profile";
import { assertHostedDependencyRootGitProfile } from "../provider-codex/app-server/adapters/hosted-dependency-root-git-profile";
import { assertHostedDependencyRootGitConfigBytes } from "../provider-codex/app-server/adapters/hosted-dependency-root-git-config";
import { systemdObservationBudget } from "../provider-codex/app-server/adapters/systemd-service-arrays";
import { assertCurrentHostedDependencyAttempt, readCurrentHostedDependencyGenerationBaseline, readCurrentHostedOrdinaryDependencyReaderEntry, CurrentHostedDependencyOriginKind,
  type CurrentHostedDependencyOrigin } from "./hosted-current-dependency-origin";
import { assertHostedDependencyRootDirectoryFacts } from "./hosted-dependency-root-record-facts";
import { rootIdentity } from "./hosted-dependency-current-facts";
import { sameRootDescriptorStat as sameStat } from "./hosted-dependency-root-physical-facts";
import { assertRootQualificationFacts, assertRootConfigAncestorFacts, parseRootPreparationFacts, parseOrdinaryRootPreparationFacts } from "./hosted-dependency-root-provenance-facts";
const root = "/var/lib/subscription-runtime-host-policy";
const hash = (bytes:Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const encode = (value:unknown) => Buffer.from(JSON.stringify(value)+"\n");
function invalid():never { throw new Error("hosted_dependency_current_origin_unresolved"); }
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
export function readOriginalHostedDependencyRootReady(context:CurrentHostedDependencyOrigin,fence:HostedActivationFence,
  phase:DependencyOwnerPhase.ExclusiveMutation|DependencyOwnerPhase.Running=DependencyOwnerPhase.Running) {
  const actual=assertCurrentHostedDependencyAttempt(context,fence,phase),{binding}=actual;
  const receipts=LocalDependencyReceiptStore.open({rootPath:hostedDependencyReceiptHistoryRoot,maxRecordBytes:16384,maxHistorySteps:2048});
  let committed:ReturnType<LocalDependencyReceiptStore["getCommittedReady"]>;
  try { const current=receipts.read(binding.workspace); if (!current || current.state!==DependencyReceiptState.Ready) invalid();
    committed=receipts.getCommittedReady(binding.workspace,current.revision); if (!encode(current).equals(encode(committed.receipt))) invalid();
  } finally { receipts.close(); }
  if (!sameDependencyAttempt(assertCurrentHostedDependencyAttempt(context,fence,phase).attempt,actual.attempt)) invalid();
  return committed;
}
/** Fixed current-origin physical read model. No record/path/profile/FD DTO or
 * callback is accepted. All selected material comes from the actual parent and
 * immutable preparation/qualification under the genuine original context. */
export function readOriginalHostedDependencyRootPreparation(context:CurrentHostedDependencyOrigin,fence:HostedActivationFence,
  phase:DependencyOwnerPhase.ExclusiveMutation|DependencyOwnerPhase.Running) {
  const remaining = systemdObservationBudget();
  const actual = assertCurrentHostedDependencyAttempt(context,fence,phase), {binding,attempt,facts} = actual;
  if (binding.version !== 2) invalid(); const selected = fixed(`dependency-root-preparations/${attempt.launch.startId}.json`,65536);
  const record = facts.kind === CurrentHostedDependencyOriginKind.ManagedReadonlyLocal ? parseRootPreparationFacts(selected.bytes,attempt,facts.association.reference) :
    parseOrdinaryRootPreparationFacts(selected.bytes,attempt,readCurrentHostedOrdinaryDependencyReaderEntry(context,fence,phase));
  const qualified=record.version===2 || record.version===3 ? undefined : readCurrentHostedDependencyRootQualification(fence);
  if(record.version!==2 && record.version!==3) {
    const status=record.version===6 || record.version===7 ? DependencyToolReadyReadStatus.Baseline : DependencyToolReadyReadStatus.Usable;
    if(!qualified || qualified.status!==status ||
      qualified.context!==context || qualified.phase!==phase || !sameDependencyAttempt(qualified.attempt,attempt) ||
      !encode(qualified.binding).equals(encode(binding)) || !encode(qualified.execution).equals(encode(record.execution)))invalid();
  }
  const committed=currentPreparationReceipt(context,fence,phase,record);
  if(qualified && !encode(qualified.receipt).equals(encode(committed.receipt)))invalid();
  const selectedReference=record.version===2 || record.version===3 ? record.ready :
    record.version===6 || record.version===7 ? record.baselineReady : record.unverified;
  const selectedRevision=record.version===2 || record.version===3 ? record.readyRevision :
    record.version===6 || record.version===7 ? record.baselineReadyRevision : record.unverifiedRevision;
  if(selectedRevision!==committed.receipt.revision || !sameDependencyProtectedReference(selectedReference,committed.reference))invalid();
  const identity = rootIdentity(facts,binding); assertHostedDependencyRootDirectoryFacts(record,binding,identity.durable,attempt.launch.startId);
  const qualification = material(record.qualification,`${root}/${dependencyToolQualificationRecordName(attempt.launch.startId)}`,16384);
  const q = parseDependencyToolAdmissionQualification(decodeHostedActivationBytes(qualification.bytes)); assertRootQualificationFacts(record,binding,attempt,q,committed.receipt);
  if((record.version===2 || record.version===3) && record.providerReady.provenance.kind!==DependencyToolReadyProvenanceKind.RegistryCompleted) {
    const source = record.providerReady.provenance.sourceBinding;
    material({path:source.path,identity:source.identity,sha256:source.sha256},source.path,262144);
  } else if((record.version===2 || record.version===3) && (record.version!==3 || facts.kind!==CurrentHostedDependencyOriginKind.Ordinary))invalid();
  const profile = material(record.protectedProfile,`${root}/dependency-installer-profile.json`,16384);
  const decoded = decodeHostedActivationBytes(profile.bytes) as Record<string,unknown>;
  if (decoded.schemaVersion !== 2) invalid(); const rootGit = assertHostedDependencyRootGitProfile(decoded.rootGit,remaining);
  assertHostedDependencyRootGitConfigBytes(material(record.config,`${binding.workspace.canonicalPath}/.git/config`,65536,false).bytes);
  assertRootConfigAncestorFacts(record,binding);
  const after = assertCurrentHostedDependencyAttempt(context,fence,phase);
  const rechecked=currentPreparationReceipt(context,fence,phase,record);
  if(!sameDependencyAttempt(after.attempt,attempt) || !encode(rechecked).equals(encode(committed)) ||
    !fixed(`dependency-root-preparations/${attempt.launch.startId}.json`,65536).bytes.equals(selected.bytes) || remaining()<=0)invalid();
  const common={reference:selected.reference,identity,rootGit};
  if(record.version===2 || record.version===3) {
    if(committed.receipt.state!==DependencyReceiptState.Ready)invalid();
    const ready=readOriginalHostedDependencyRootReady(context,fence,phase);
    return {...common,admission:DependencyToolReadyReadStatus.Ready as const,record,ready};
  }
  const latest=readCurrentHostedDependencyRootQualification(fence);
  if((record.version===6 || record.version===7 ? latest.status!==DependencyToolReadyReadStatus.Baseline : latest.status!==DependencyToolReadyReadStatus.Usable) ||
    latest.status===DependencyToolReadyReadStatus.Ready || latest.context!==context || latest.phase!==phase ||
    !sameDependencyAttempt(latest.attempt,attempt) || !encode(latest.binding).equals(encode(binding)) ||
    !encode(latest.receipt).equals(encode(committed.receipt)) || !encode(latest.execution).equals(encode(record.execution)))invalid();
  if(record.version===6 || record.version===7) {
    const baseline=readCurrentHostedDependencyGenerationBaseline(context,fence);if(!baseline)invalid();
    return {...common,admission:DependencyToolReadyReadStatus.Baseline as const,record,baselineReady:baseline.ready};
  }
  const unverified=readHostedDependencyUsableReceipt(context,fence,phase).receipt;
  return {...common,admission:DependencyToolReadyReadStatus.Usable as const,record,unverified};
}
function currentPreparationReceipt(context:CurrentHostedDependencyOrigin,fence:HostedActivationFence,
  phase:DependencyOwnerPhase.ExclusiveMutation|DependencyOwnerPhase.Running,
  record:import("../provider-codex/app-server/adapters/hosted-dependency-root-purpose-record").HostedDependencyRootPreparationRecord) {
  if(record.version===2 || record.version===3)return readOriginalHostedDependencyRootReady(context,fence,phase);
  if(record.version===6 || record.version===7) {
    const baseline=readCurrentHostedDependencyGenerationBaseline(context,fence);if(!baseline)invalid();return baseline.ready;
  }
  return readHostedDependencyUsableReceipt(context,fence,phase).receipt;
}
