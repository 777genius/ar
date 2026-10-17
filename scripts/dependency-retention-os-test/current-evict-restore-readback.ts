import { readHostedDependencyScratchLayout } from "../../dist/worker-codex/hosted-dependency-scratch-layout.js";
import { assertHostedDependencyLegacyComparedReady } from "../../dist/worker-codex/hosted-dependency-legacy-comparison-record.js";
/** Assertions over original stored facts. No issuer, owner CAS or authority DTO. */
import assert from "node:assert/strict";
import { lstatSync } from "node:fs";
import { DependencyReceiptState, DependencyInstallProofKind, parseHostedOrdinaryStart } from "../../dist/worker-core/index.js";
import { DependencyGenerationContinuityKind, isDependencyCustodyObject, isDependencyProtectedReference }
  from "../../dist/core/index.js";
import { withHostedActivationFence } from "../../dist/provider-codex/app-server/adapters/hosted-process-activation.js";
import { readHostedForegroundLaunchObservation } from "../../dist/provider-codex/app-server/adapters/hosted-fd-launch.js";
import { readHostedDependencyBinding, hostedDependencyBindingName, hostedDependencyOwnerRoot }
  from "../../dist/provider-codex/app-server/adapters/hosted-dependency-workspace.js";
import { LocalDependencyOwnerStore } from "../../dist/store-local-file/dependency-environment/local-dependency-owner-store.js";
import { readHostedDependencyEstablishedReceipt, readHostedDependencyExistingCommittedReady,
  readHostedDependencyExistingCommittedEvicting, readHostedDependencyCommittedAbsent }
  from "../../dist/worker-codex/hosted-dependency-receipts.js";
import { pinReferenceFile } from "../../dist/worker-codex/hosted-dependency-legacy-reference-records.js";
import { HostedOrdinaryDependencyReaderKind } from "../../dist/worker-codex/hosted-ordinary-dependency-reader.js";
import { assertRootScope, type CurrentOrdinaryRoots, type CurrentColdHotRoots } from "./current-cold-hot-root.js";
import { readHostedReadonlyDependencyStart } from "../../dist/provider-codex/app-server/adapters/hosted-dependency-origin.js";
import { DependencyConsumerLaunchKind } from "../../dist/core/index.js";
import { type runCurrentReadonlyEntry } from "./current-full-r-entry.js";
import { type runCurrentOrdinaryEntry } from "./current-full-entry.js";
const policyRoot="/var/lib/subscription-runtime-host-policy";
const encode=(value:unknown)=>Buffer.from(JSON.stringify(value)+"\n");
function binding(roots:CurrentOrdinaryRoots) {
  assertRootScope(roots);const value=readHostedDependencyBinding(roots.candidateJobId);
  assert(value && value.version===2);assert.deepEqual(value.workspace,roots.workspaceIdentity);return value;
}
export function assertPathAbsent(path:string) {
  try {lstatSync(path);} catch(error) {if((error as NodeJS.ErrnoException).code==="ENOENT")return;throw error;}
  assert.fail("TEST expected actual absent path");
}
export function readEvictRestoreReady(roots:CurrentOrdinaryRoots) {
  return withHostedActivationFence(fence=>{
    const selected=binding(roots),receipt=readHostedDependencyEstablishedReceipt(selected);
    assert(receipt && receipt.state===DependencyReceiptState.Ready);
    const committed=readHostedDependencyExistingCommittedReady(fence,selected,receipt.revision);assert.deepEqual(committed.receipt,receipt);
    const tree=lstatSync(roots.workspace+"/node_modules",{bigint:true});assert(tree.isDirectory() && !tree.isSymbolicLink());
    assert.deepEqual(receipt.tree,{dev:String(tree.dev),ino:String(tree.ino)});return committed;
  });
}
/** Real protected Evicting successor, released RetiredEvicting owner and exact
 * historical header/source mapping are checked BEFORE the remover is called. */
export function readEvictRestoreAbsent(roots:CurrentOrdinaryRoots,ready:ReturnType<typeof readEvictRestoreReady>) {return readAbsent(roots,ready,false);}
export function readLegacyEvictRestoreAbsent(roots:CurrentOrdinaryRoots,ready:ReturnType<typeof readEvictRestoreReady>) {return readAbsent(roots,ready,true);}
function readAbsent(roots:CurrentOrdinaryRoots,ready:ReturnType<typeof readEvictRestoreReady>,legacy:boolean) {
  return withHostedActivationFence(fence=>{
    const selected=binding(roots),latest=readHostedDependencyEstablishedReceipt(selected);
    assert(latest && latest.state===DependencyReceiptState.Absent);assert.equal(latest.revision,ready.receipt.revision+2);
    const absent=readHostedDependencyCommittedAbsent(selected,latest.revision);assert.deepEqual(absent.receipt,latest);
    const evicting=readHostedDependencyExistingCommittedEvicting(fence,selected,ready.receipt.revision+1),proof=latest.evictionCommit;
    assert.equal(evicting.receipt.operationId,latest.operationId);assert.equal(latest.generation,ready.receipt.generation);
    assert.equal(latest.installKey,ready.receipt.installKey);assert.equal(proof.manifestDigest,ready.receipt.manifestDigest);
    assert.deepEqual(proof.tree,ready.receipt.tree);assert.deepEqual(proof.trash,evicting.receipt.trash);
    assert.deepEqual(evicting.receipt.tree,ready.receipt.tree);assert.equal(evicting.receipt.installKey,ready.receipt.installKey);
    assert.equal(proof.trash.destinationParent.canonicalPath,readHostedDependencyScratchLayout(selected.runtimeSha).trash);
    assert.equal(proof.trash.destinationName,"dependency-"+latest.operationId);
    const parent=lstatSync(proof.trash.destinationParent.canonicalPath,{bigint:true});
    assert(parent.isDirectory() && !parent.isSymbolicLink());assert.equal(String(parent.dev),proof.trash.destinationParent.dev);
    assert.equal(String(parent.ino),proof.trash.destinationParent.ino);
    const trash=proof.trash.destinationParent.canonicalPath+"/"+proof.trash.destinationName,tree=lstatSync(trash,{bigint:true});
    assert(tree.isDirectory() && !tree.isSymbolicLink());assert.deepEqual({dev:String(tree.dev),ino:String(tree.ino)},proof.tree);
    assertPathAbsent(roots.workspace+"/node_modules");
    const owners=LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384});
    try {
      const owner=owners.read(selected.workspace);assert(owner && owner.version!==1 && owner.owner===null);
      const slot=owner.generationContinuity;assert(slot && slot.kind===DependencyGenerationContinuityKind.RetiredEvictingV1);
      assert.equal(slot.operationId,latest.operationId);assert.equal(slot.generation,latest.generation);
      assert.equal(slot.readyRevision,ready.receipt.revision);assert.equal(slot.evictingRevision,evicting.receipt.revision);
      assert.deepEqual(slot.previousReady,ready.reference);assert.deepEqual(slot.retiredEvicting,evicting.reference);
    } finally {owners.close();}
    const operation=policyRoot+"/dependency-transactions/"+latest.operationId;
    const header=pinReferenceFile(operation+".json",32768),row:unknown=JSON.parse(header.bytes.toString("utf8"));
    assert(isDependencyCustodyObject(row,"attempt,ready,trash,version") && row.version===1);
    assert(encode(row).equals(header.bytes));assert.deepEqual(row.ready,ready.receipt);assert.deepEqual(row.trash,proof.trash);
    assert(row.attempt!==null && typeof row.attempt==="object" && "operationId" in row.attempt && "epoch" in row.attempt);
    assert.equal(row.attempt.operationId,latest.operationId);
    const renamed=pinReferenceFile(operation+".renamed.json",16384);
    assert.equal(renamed.reference.sha256,proof.commitEvidenceId);
    if(legacy){
      assert(ready.receipt.provenance.kind===DependencyInstallProofKind.LegacyCompared);
      const comparison=assertHostedDependencyLegacyComparedReady({...ready.receipt,provenance:ready.receipt.provenance});assert.equal(comparison.version,2);
      assert(comparison.version===2);
      assertLegacyRenamedEvidenceData(renamed.bytes,{version:3,operationId:latest.operationId,workspace:latest.workspace,
        epoch:row.attempt.epoch,tree:proof.tree,trash:proof.trash,manifestDigest:proof.manifestDigest,
        headerSha256:header.reference.sha256,comparisonEvidenceId:ready.receipt.provenance.comparisonEvidenceId,sourceBinding:comparison.candidateSourceBinding});
    }else{
      // Existing installed proof remains exact; legacy never passes this branch.
      assert(ready.receipt.provenance.kind===DependencyInstallProofKind.CompletedLocalInstallV1);
      assert.deepEqual(JSON.parse(renamed.bytes.toString("utf8")),{version:2,operationId:latest.operationId,workspace:latest.workspace,
        epoch:row.attempt.epoch,tree:proof.tree,trash:proof.trash,manifestDigest:proof.manifestDigest,
        headerSha256:header.reference.sha256,sourceBinding:ready.receipt.provenance.sourceBinding});
    }
    return Object.freeze({absent,evicting,header:header.reference,renamed:renamed.reference,trash,operation});
  });
}
export function assertRetainedEvictionProof(proof:ReturnType<typeof readEvictRestoreAbsent>) {
  for(const reference of [proof.absent.reference,proof.evicting.reference,proof.header,proof.renamed])
    assert.deepEqual(pinReferenceFile(reference.path,32768).reference,reference);
}
/** Joins the producer's actual Absent capture before OS submission to the new
 * original FDA/result/provider final reader. Caller IDs alone never suffice. */
export function assertSameRootFinalGateRestore(roots:CurrentOrdinaryRoots,old:ReturnType<typeof readEvictRestoreReady>,
  proof:ReturnType<typeof readEvictRestoreAbsent>,entry:Awaited<ReturnType<typeof runCurrentOrdinaryEntry>>) {
  const selected=binding(roots),native=readHostedForegroundLaunchObservation(entry.result);
  const start=pinReferenceFile(policyRoot+"/ordinary-starts/"+native.startId+".json",65536);
  const actual=parseHostedOrdinaryStart(JSON.parse(start.bytes.toString("utf8")));
  assert.equal(actual.jobId,roots.candidateJobId);assert.equal(actual.workspacePath,roots.workspace);
  assert.equal(actual.jobRootDir,roots.jobRoot);
  assert.equal(actual.unit,"subscription-runtime-ordinary-"+native.startId+".service");assert.equal(actual.unit,native.unit);
  const record=pinReferenceFile(policyRoot+"/dependency-reader-starts/"+native.startId+".json",16384);
  assert.deepEqual(record.reference,entry.observation.preclaim);
  const row:unknown=JSON.parse(record.bytes.toString("utf8"));
  assert(isDependencyCustodyObject(row,"binding,kind,origin,preclaim,receipt,recipeSha256,version"));
  assert(row.version===1 && row.kind===HostedOrdinaryDependencyReaderKind.OrdinaryDependencyReaderV1 && encode(row).equals(record.bytes));
  assert(isDependencyProtectedReference(row.origin) && isDependencyProtectedReference(row.binding));
  assert.deepEqual(row.origin,start.reference);assert.deepEqual(row.binding,pinReferenceFile(policyRoot+"/"+hostedDependencyBindingName(selected.jobId),16384).reference);
  assert.deepEqual(row.receipt,{state:DependencyReceiptState.Absent,revision:proof.absent.receipt.revision,reference:proof.absent.reference});
  assert(isDependencyCustodyObject(row.preclaim,"attempt,ownerRevision,ownerSha256,version,workspace") && row.preclaim.version===1);
  assert.deepEqual(row.preclaim.workspace,roots.workspaceIdentity);
  assert(isDependencyCustodyObject(row.preclaim.attempt,"attemptId,epoch,launch"));
  assert.equal(row.preclaim.attempt.attemptId,entry.observation.attemptId);assert.equal(String(row.preclaim.attempt.epoch),entry.observation.epoch);
  assert.deepEqual(row.preclaim.attempt.launch,{bootId:actual.bootId,grantDigest:selected.grantDigest,installationId:selected.installationId,
    runtimeSha:selected.runtimeSha,startId:native.startId,unit:native.unit});
  const restored=readEvictRestoreReady(roots);assert.equal(restored.receipt.revision,proof.absent.receipt.revision+2);
  assert.equal(restored.receipt.generation,entry.observation.attemptId);assert.notEqual(restored.receipt.generation,old.receipt.generation);
  assert.equal(restored.receipt.installKey,old.receipt.installKey);assertRetainedEvictionProof(proof);
  // Inode reuse after actual unlink is possible. A distinct generation and
  // authenticated fresh install are required; unequal inode numbers are not.
  return Object.freeze({readerSha256:record.reference.sha256,selectedAbsent:proof.absent.reference,
    restoredReady:restored.reference,generation:restored.receipt.generation});
}

/** Actual first R preclaim captured the SAME committed Absent before submission;
 * historical public V2 candidate is not reported as the current Ready. */
export function assertSameRootReadonlyFinalGateRestore(roots:CurrentColdHotRoots,old:ReturnType<typeof readEvictRestoreReady>,
  proof:ReturnType<typeof readEvictRestoreAbsent>,entry:Awaited<ReturnType<typeof runCurrentReadonlyEntry>> | Awaited<ReturnType<typeof runCurrentOrdinaryEntry>>) {
  const native=readHostedForegroundLaunchObservation(entry.result),record=pinReferenceFile(`${policyRoot}/dependency-reader-starts/${native.startId}.json`,16384),v:unknown=JSON.parse(record.bytes.toString("utf8"));
  assert.deepEqual(record.reference,entry.observation.preclaim);
  assert(isDependencyCustodyObject(v,"attempt,binding,custody,kind,origin,ownerRevision,ownerSha256,receipt,version,workspace") && v.version===1 && encode(v).equals(record.bytes));
  assert.equal(v.kind,DependencyConsumerLaunchKind.ManagedReadonlyLocalV1);assert.deepEqual(v.workspace,roots.workspaceIdentity);
  const start=withHostedActivationFence(fence=>readHostedReadonlyDependencyStart(fence,native.startId));
  assert.equal(start.value.readonlyJobId,roots.readonlyJobId);assert.equal(start.value.candidateJobId,roots.candidateJobId);
  assert.equal(start.value.unit,native.unit);assert.deepEqual(v.origin,start.reference);assert.deepEqual(v.custody,start.value.association);
  assert.deepEqual(v.receipt,{state:DependencyReceiptState.Absent,revision:proof.absent.receipt.revision,reference:proof.absent.reference});
  assert(isDependencyCustodyObject(v.attempt,"attemptId,epoch,launch"));assert.equal(v.attempt.attemptId,entry.observation.attemptId);assert.equal(String(v.attempt.epoch),entry.observation.epoch);
  assert(isDependencyCustodyObject(v.attempt.launch,"association,bootId,grantDigest,installationId,kind,origin,runtimeSha,startId,unit"));
  assert.equal(v.attempt.launch.kind,DependencyConsumerLaunchKind.ManagedReadonlyLocalV1);assert.equal(v.attempt.launch.startId,native.startId);
  assert.deepEqual(v.attempt.launch.association,start.value.association);assert.deepEqual(v.attempt.launch.origin,start.reference);
  const restored=readEvictRestoreReady(roots);assert.equal(restored.receipt.revision,proof.absent.receipt.revision+2);
  assert.equal(restored.receipt.generation,entry.observation.attemptId);assert.notEqual(restored.receipt.generation,old.receipt.generation);
  assert.equal(restored.receipt.installKey,old.receipt.installKey);assertRetainedEvictionProof(proof);
  return Object.freeze({readerSha256:record.reference.sha256,selectedAbsent:proof.absent.reference,restoredReady:restored.reference,generation:restored.receipt.generation});
}

/** Pure DATA equality only; the caller above FIRST authenticates the original
 * comparison and protected Ready/header. This helper issues no proof/grant. */
export function assertLegacyRenamedEvidenceData(bytes:Uint8Array,expected:Readonly<{version:3;operationId:string;workspace:unknown;epoch:unknown;
    tree:unknown;trash:unknown;manifestDigest:string;headerSha256:string;comparisonEvidenceId:string;sourceBinding:unknown}>) {
  assert(bytes.byteLength>0 && bytes.byteLength<=16384);
  const value:unknown=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));
  assert.deepEqual(value,expected);assert(encode(value).equals(Buffer.from(bytes)));
}
