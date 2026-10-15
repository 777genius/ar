import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, lstat, readFile, readdir, rm, rename, writeFile } from "node:fs/promises";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { DependencyGenerationContinuityKind, parseDependencyOwner } from "@vioxen/subscription-runtime/core";
import { claimDependencyConsumer } from "../../../worker-core/dependency-environment/application/dependency-consumer-ownership";
import { type DependencyOrdinaryLaunchBinding } from "../../../worker-core/dependency-environment/domain/dependency-owner";
import { DependencyReceiptState as State, DependencyInstallProofKind as Proof, DependencyPreservationKind as Preserve,
  DependencyUnverifiedReason as Reason, type DependencyReceipt } from "../../../worker-core/dependency-environment/domain/dependency-receipt";
import { LocalDependencyOwnerStore as Owners } from "../local-dependency-owner-store";
import { LocalDependencyReceiptStore as Receipts, dependencyReceiptStorageName } from "../local-dependency-receipt-store";

// These TEST-only filesystem records exercise the inactive storage boundary,
// not host authority/installation/barrier provenance. No port returns a permit.
const launch: DependencyOrdinaryLaunchBinding = {
  installationId: "00000000-0000-4000-8000-000000000001", bootId: "00000000-0000-4000-8000-000000000002",
  startId: "00000000-0000-4000-8000-000000000003", runtimeSha: "a".repeat(40), grantDigest: "b".repeat(64),
  unit: "subscription-runtime-ordinary-00000000-0000-4000-8000-000000000003.service",
};
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hot-continuity-TEST-")));
  const ownerRoot = join(root, "owners"), receiptRoot = join(root, "receipts"), workspacePath = join(root, "workspace");
  await mkdir(ownerRoot, { mode: 0o700 }); await mkdir(receiptRoot, { mode: 0o700 }); await mkdir(workspacePath);
  await mkdir(join(workspacePath, "node_modules")); await writeFile(join(workspacePath, "authored"), "TEST preserve bytes");
  const stat = await lstat(workspacePath, { bigint: true }), treeStat = await lstat(join(workspacePath, "node_modules"), { bigint: true });
  const workspace = { canonicalPath: workspacePath, dev: String(stat.dev), ino: String(stat.ino) };
  const tree = { dev: String(treeStat.dev), ino: String(treeStat.ino) };
  const owners = Owners.open({ rootPath: ownerRoot, maxRecordBytes: 16384 });
  const receipts = Receipts.open({ rootPath: receiptRoot, maxRecordBytes: 16384, maxHistorySteps: 16 });
  return { root, ownerRoot, receiptRoot, workspace, tree, owners, receipts,
    async close() { this.owners.close(); this.receipts.close(); await rm(root, { recursive: true, force: true }); } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function publishLogicalReady(f: Fixture) {
  const base = { version: 1 as const, generation: "TEST-generation", workspace: f.workspace, coverageRevision: "TEST-coverage" };
  const install: DependencyReceipt = { ...base, revision: 1, state: State.Installing, operationId: "TEST-install",
    requestedKey: "a".repeat(64), preservation: { kind: Preserve.KnownFreshAbsence, generation: base.generation,
      workspace: f.workspace, coverageRevision: base.coverageRevision, operationId: "TEST-install", absenceEvidenceId: "TEST-absence" } };
  f.receipts.compareAndSwap(f.workspace, null, install);
  const binding = { generation: base.generation, workspace: f.workspace, coverageRevision: base.coverageRevision,
    installKey: "a".repeat(64), tree: f.tree, manifestDigest: "b".repeat(64) };
  const ready: Extract<DependencyReceipt, { state: State.Ready }> = { ...base, revision: 2, state: State.Ready,
    installKey: binding.installKey, tree: f.tree, manifestDigest: binding.manifestDigest,
    provenance: { ...binding, kind: Proof.CompletedInstall, operationId: "TEST-install",
      verificationEvidenceId: "TEST-verified", installerDrainEvidenceId: "TEST-drained" } };
  f.receipts.compareAndSwap(f.workspace, 1, ready);
  return f.receipts.getCommittedReady(f.workspace, 2);
}
function unverified(f: Fixture, revision = 1) {
  return { version: 1 as const, revision, generation: "TEST-generation", workspace: f.workspace, coverageRevision: "TEST-coverage",
    state: State.Unverified as const, tree: f.tree, reason: Reason.BaselineMissing };
}

// Real Linux storage tests only. TEST verifier checks captured filesystem facts;
// it supplies no host issuer, native completion or installation authority.
function treeNow(f: Fixture) {
  const st=lstatSync(join(f.workspace.canonicalPath,"node_modules"),{bigint:true});
  return {dev:String(st.dev),ino:String(st.ino)};
}
function explicit(f: Fixture, revision: number) {
  return {...unverified(f,revision),tree:treeNow(f),reason:Reason.ExplicitOperatorReinstallation};
}
async function authorize(f: Fixture, previous: ReturnType<Fixture["receipts"]["getCommittedReady"]> | ReturnType<Fixture["receipts"]["getCommittedUnverified"]>) {
  const capturedTree=treeNow(f),source=join(f.workspace.canonicalPath,"authored"),capturedSource=await readFile(source);
  f.receipts.close();
  f.receipts=Receipts.open({rootPath:f.receiptRoot,maxRecordBytes:16384,maxHistorySteps:16,explicitReinstallationVerifier:{
    assertExplicitReinstallation({previousReceipt,previousReference,proposedUnverified}) {
      expect(previousReceipt).toEqual(previous.receipt);expect(previousReference).toEqual(previous.reference);
      expect(proposedUnverified.tree).toEqual(capturedTree);expect(treeNow(f)).toEqual(capturedTree);
      expect(readFileSync(source)).toEqual(capturedSource);
    },
  }});
}
describe.skipIf(process.platform!=="linux")("explicit operator storage retirement",()=>{
  it.each(["pristine","changed","replaced"])("retires %s actual tree without changing bytes or original Ready evidence",async mode=>{
    const f=await fixture();try {
      const ready=publishLogicalReady(f),history=await readFile(ready.reference.path),tree=join(f.workspace.canonicalPath,"node_modules");
      if(mode==="changed")await writeFile(join(tree,"changed"),"actual changed bytes");
      if(mode==="replaced"){await rename(tree,join(f.workspace.canonicalPath,"previous-tree"));await mkdir(tree);await writeFile(join(tree,"replacement"),"actual replacement bytes");}
      await authorize(f,ready);const currentTree=treeNow(f),before=await readFile(join(f.workspace.canonicalPath,"authored"));
      const result=f.receipts.retireForExplicitReinstallation(f.workspace,2,ready.reference,explicit(f,3));
      expect(result.receipt.reason).toBe(Reason.ExplicitOperatorReinstallation);expect(result.receipt.tree).toEqual(currentTree);
      expect(f.receipts.read(f.workspace)).toEqual(result.receipt);expect(f.receipts.getCommittedReady(f.workspace,2)).toEqual(ready);
      expect(await readFile(ready.reference.path)).toEqual(history);expect(treeNow(f)).toEqual(currentTree);
      expect(await readFile(join(f.workspace.canonicalPath,"authored"))).toEqual(before);
      if(mode==="changed")expect(await readFile(join(tree,"changed"),"utf8")).toBe("actual changed bytes");
      if(mode==="replaced"){expect(currentTree).not.toEqual(ready.receipt.tree);expect(await readFile(join(tree,"replacement"),"utf8")).toBe("actual replacement bytes");}
    }finally{await f.close();}
  });
  it("retains original RetiredReady adjacency when explicit successor follows already-Unverified",async()=>{
    const f=await fixture();try {
      const attempt=claimDependencyConsumer(f.owners,f.workspace,launch,randomUUID()),held=f.owners.read(f.workspace)!,ready=publishLogicalReady(f);
      f.receipts.compareAndSwap(f.workspace,2,unverified(f,3));const retired=f.receipts.getCommittedUnverified(f.workspace,3);
      const slot={version:1,kind:DependencyGenerationContinuityKind.RetiredReadyV1,operationId:attempt.attemptId,generation:ready.receipt.generation,
        readyRevision:2,unverifiedRevision:3,previousReady:ready.reference,retiredUnverified:retired.reference};
      f.owners.close();f.owners=Owners.open({rootPath:f.ownerRoot,maxRecordBytes:16384,generationRetirementVerifier:{assertGenerationRetirement(){}}});
      f.owners.compareAndSwap(f.workspace,held.revision,parseDependencyOwner({...held,revision:held.revision+1,generationContinuity:slot}));
      const owner=f.owners.read(f.workspace),readyBytes=await readFile(ready.reference.path),retiredBytes=await readFile(retired.reference.path);
      await authorize(f,retired);const result=f.receipts.retireForExplicitReinstallation(f.workspace,3,retired.reference,explicit(f,4));
      expect(result.receipt.revision).toBe(4);expect(result.receipt.reason).toBe(Reason.ExplicitOperatorReinstallation);
      expect(f.owners.read(f.workspace)).toEqual(owner);const after=f.owners.read(f.workspace);
      if(!after || after.version===1)throw Error("TEST expected continuity owner");expect(after.generationContinuity).toEqual(slot);
      expect(f.receipts.getCommittedUnverified(f.workspace,3)).toEqual(retired);expect(f.receipts.getCommittedReady(f.workspace,2)).toEqual(ready);
      expect(await readFile(ready.reference.path)).toEqual(readyBytes);expect(await readFile(retired.reference.path)).toEqual(retiredBytes);
    }finally{await f.close();}
  });
  it("generic publication and old retirement cannot borrow configured explicit verifier",async()=>{
    const f=await fixture();try {
      const ready=publishLogicalReady(f);await authorize(f,ready);const next=explicit(f,3),before=await readFile(join(f.receiptRoot,dependencyReceiptStorageName(f.workspace))),names=await readdir(f.receiptRoot);
      for(const call of [()=>f.receipts.compareAndSwap(f.workspace,2,next),()=>f.receipts.retireReady(f.workspace,2,ready.reference,next),()=>f.receipts.publishFactualUnverified(f.workspace,next)])expect(()=>call()).toThrow();
      expect(f.receipts.read(f.workspace)).toEqual(ready.receipt);expect(await readFile(join(f.receiptRoot,dependencyReceiptStorageName(f.workspace)))).toEqual(before);
      expect(await readdir(f.receiptRoot)).toEqual(names);
    }finally{await f.close();}
  });
  it.each(["missing-issuer","forged-issuer","changed-reference","changed-generation","changed-coverage","changed-source","changed-tree"])("refuses %s without receipt or filesystem mutation",async mode=>{
    const f=await fixture();try {
      const ready=publishLogicalReady(f);if(mode!=="missing-issuer")await authorize(f,ready);
      if(mode==="forged-issuer"){f.receipts.close();f.receipts=Receipts.open({rootPath:f.receiptRoot,maxRecordBytes:16384,maxHistorySteps:16,
        explicitReinstallationVerifier:{assertExplicitReinstallation(){return true as never;}}});}
      const next=explicit(f,3);if(mode==="changed-generation")next.generation="TEST-other-generation";if(mode==="changed-coverage")next.coverageRevision="TEST-other-coverage";if(mode==="changed-source")await writeFile(join(f.workspace.canonicalPath,"authored"),"changed after capture");
      if(mode==="changed-tree"){const tree=join(f.workspace.canonicalPath,"node_modules");await rename(tree,join(f.workspace.canonicalPath,"retained-tree"));await mkdir(tree);}
      const ref=mode==="changed-reference"?{...ready.reference,sha256:"f".repeat(64)}:ready.reference;
      const names=await readdir(f.receiptRoot),head=await readFile(join(f.receiptRoot,dependencyReceiptStorageName(f.workspace))),source=await readFile(join(f.workspace.canonicalPath,"authored")),tree=treeNow(f);
      expect(()=>f.receipts.retireForExplicitReinstallation(f.workspace,2,ref,next)).toThrow();
      expect(f.receipts.read(f.workspace)).toEqual(ready.receipt);expect(await readdir(f.receiptRoot)).toEqual(names);
      expect(await readFile(join(f.receiptRoot,dependencyReceiptStorageName(f.workspace)))).toEqual(head);
      expect(await readFile(join(f.workspace.canonicalPath,"authored"))).toEqual(source);expect(treeNow(f)).toEqual(tree);
    }finally{await f.close();}
  });
});
