import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, lstat, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { DependencyGenerationContinuityKind, DependencyConsumerLaunchKind, parseDependencyOwner } from "@vioxen/subscription-runtime/core";
import { captureDependencyConsumerPreclaim, assertDependencyPreclaimedConsumer } from "../../../worker-core/dependency-environment/application/preclaimed-dependency-consumer";
import { claimDependencyConsumer, markDependencyConsumerRunning } from "../../../worker-core/dependency-environment/application/dependency-consumer-ownership";
import { invalidateDependencyGeneration } from "../../../worker-core/dependency-environment/application/invalidate-dependency-generation";
import { DependencyOwnerPhase, DependencyOwnerKind, type DependencyOrdinaryLaunchBinding } from "../../../worker-core/dependency-environment/domain/dependency-owner";
import { DependencyReceiptState as State, DependencyInstallProofKind as Proof, DependencyPreservationKind as Preserve,
  DependencyUnverifiedReason as Reason, type DependencyReceipt } from "../../../worker-core/dependency-environment/domain/dependency-receipt";
import { LocalDependencyOwnerStore as Owners, dependencyOwnerStorageName } from "../local-dependency-owner-store";
import { LocalDependencyReceiptStore as Receipts, dependencyReceiptStorageName } from "../local-dependency-receipt-store";

// These TEST-only filesystem records exercise the inactive storage boundary,
// not host authority/installation/barrier provenance. No port returns a permit.
const launch: DependencyOrdinaryLaunchBinding = {
  installationId: "00000000-0000-4000-8000-000000000001", bootId: "00000000-0000-4000-8000-000000000002",
  startId: "00000000-0000-4000-8000-000000000003", runtimeSha: "a".repeat(40), grantDigest: "b".repeat(64),
  unit: "subscription-runtime-ordinary-00000000-0000-4000-8000-000000000003.service",
};
function refusal(call: () => unknown): string {
  try { call(); } catch (error) {
    if (error && typeof error === "object" && "reason" in error && typeof error.reason === "string") return error.reason;
    throw error;
  }
  throw new Error("TEST expected refusal");
}
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

// Red regressions: reused producer digest becomes later owner authority, missing
// actual verifier creates a publication, or historical reference resets current.
describe.skipIf(process.platform !== "linux")("inactive generation/preclaim storage", () => {
  it("matches actual preclaim and refuses altered digest, new revision and Running", async () => {
    const f = await fixture();
    try {
      const attempt = claimDependencyConsumer(f.owners, f.workspace, launch, randomUUID());
      const preclaim = captureDependencyConsumerPreclaim(f.owners, f.workspace, attempt);
      expect(assertDependencyPreclaimedConsumer(f.owners, f.workspace, preclaim).revision).toBe(preclaim.ownerRevision);
      expect(refusal(() => assertDependencyPreclaimedConsumer(f.owners, f.workspace, { ...preclaim, ownerSha256: "c".repeat(64) }))).toBe("stale_attempt");
      const current = f.owners.read(f.workspace)!;
      f.owners.compareAndSwap(f.workspace, current.revision, { ...current, revision: current.revision + 1 });
      expect(refusal(() => assertDependencyPreclaimedConsumer(f.owners, f.workspace, preclaim))).toBe("stale_attempt");
      const fresh = captureDependencyConsumerPreclaim(f.owners, f.workspace, attempt);
      expect(fresh.ownerRevision).toBe(current.revision + 1);
      markDependencyConsumerRunning(f.owners, f.workspace, attempt);
      expect(refusal(() => assertDependencyPreclaimedConsumer(f.owners, f.workspace, fresh))).toBe("stale_attempt");
      expect(await readFile(join(f.workspace.canonicalPath, "authored"), "utf8")).toBe("TEST preserve bytes");
    } finally { await f.close(); }
  });
  it("cannot publish an invalidation slot without the actual trusted verifier or mint Active", async () => {
    const f = await fixture();
    try {
      const association = { path: join(f.ownerRoot, "TEST-association.json"), identity: f.tree, sha256: "d".repeat(64) };
      const origin = { ...association, path: join(f.ownerRoot, "TEST-origin.json"), sha256: "e".repeat(64) };
      // v2->v3 data migration is already allowed only while idle. This is not a
      // fabricated qualified origin or actual contained runtime invocation.
      f.owners.compareAndSwap(f.workspace, null, parseDependencyOwner({ version: 2, workspace: f.workspace, revision: 1, epoch: 1, owner: null }));
      f.owners.compareAndSwap(f.workspace, 1, parseDependencyOwner({ version: 3, workspace: f.workspace, revision: 2, epoch: 1, owner: null, custodyBinding: association }));
      const id = randomUUID(), attempt = { attemptId: id, epoch: 2, launch: { ...launch, kind: DependencyConsumerLaunchKind.ManagedReadonlyLocalV1,
        association, origin, unit: `subscription-runtime-outer-${launch.startId}.service` } };
      const held = parseDependencyOwner({ version: 3, workspace: f.workspace, revision: 3, epoch: 2, custodyBinding: association,
        owner: { kind: DependencyOwnerKind.Consumer, phase: DependencyOwnerPhase.ExclusiveMutation, attempt } });
      f.owners.compareAndSwap(f.workspace, 2, held);
      const committed = publishLogicalReady(f);
      f.receipts.compareAndSwap(f.workspace, 2, unverified(f, 3));
      const retired = f.receipts.getCommittedUnverified(f.workspace, 3);
      const generationContinuity = { version: 1, kind: DependencyGenerationContinuityKind.RetiredReadyV1, operationId: id,
        generation: committed.receipt.generation, readyRevision: 2, unverifiedRevision: 3, previousReady: committed.reference, retiredUnverified: retired.reference };
      const path = join(f.ownerRoot, dependencyOwnerStorageName(f.workspace)), before = await readFile(path), records = await readdir(f.ownerRoot);
      expect(refusal(() => f.owners.compareAndSwap(f.workspace, 3, parseDependencyOwner({ ...held, revision: 4, generationContinuity })))).toBe("invalid_record");
      expect(await readFile(path)).toEqual(before); expect(await readdir(f.ownerRoot)).toEqual(records);
      expect(() => parseDependencyOwner({ ...held, revision: 4, generationContinuity: { ...generationContinuity, kind: "active" } })).toThrow();
      expect(() => parseDependencyOwner({ version: 1, workspace: f.workspace, revision: 4, epoch: 2, owner: null, generationContinuity })).toThrow();
      expect(f.receipts.getCommittedReady(f.workspace, 2)).toEqual(committed);
    } finally { await f.close(); }
  });
  it.each([Reason.TreeChanged,Reason.BaselineMissing] as const)("ordinary v2 %s retirement preserves the held attempt and survives the next claim", async (reason) => {
    const f=await fixture();
    try {
      const attempt=claimDependencyConsumer(f.owners,f.workspace,launch,randomUUID()), held=f.owners.read(f.workspace)!;
      const ready=publishLogicalReady(f), historical=await readFile(ready.reference.path);
      let receiptChecks=0,ownerChecks=0;
      f.receipts.close(); f.owners.close();
      f.receipts=Receipts.open({rootPath:f.receiptRoot,maxRecordBytes:16384,maxHistorySteps:16,generationReceiptVerifier:{
        assertReadyRetirement({previousReady,previousReference,proposedUnverified}) {
          receiptChecks++; expect(previousReady).toEqual(ready.receipt); expect(previousReference).toEqual(ready.reference);
          expect(f.owners.read(f.workspace)).toEqual(held); expect(proposedUnverified.revision).toBe(3);
        }, assertFactualUnverified() { throw new Error("TEST unexpected factual publication"); },
      }});
      f.owners=Owners.open({rootPath:f.ownerRoot,maxRecordBytes:16384,generationRetirementVerifier:{
        assertGenerationRetirement({previousOwner,proposedOwner,invalidation}) {
          ownerChecks++; expect(previousOwner).toEqual(held); expect(proposedOwner.version).toBe(2);
          expect(proposedOwner.owner).toEqual(held.owner); expect(proposedOwner.epoch).toBe(held.epoch);
          expect(invalidation.previousReady).toEqual(ready.reference);
          expect(f.receipts.getCommittedUnverified(f.workspace,3).reference).toEqual(invalidation.retiredUnverified);
        },
      }});
      const result=invalidateDependencyGeneration({owners:f.owners,receipts:f.receipts,workspace:f.workspace,
        expectedOwnerRevision:held.revision,expectedReceiptRevision:ready.receipt.revision,reason});
      expect(result.retired.receipt.reason).toBe(reason);expect(result.retired.receipt.tree).toEqual(ready.receipt.tree);
      expect(receiptChecks).toBe(1); expect(ownerChecks).toBe(1); expect(result.owner.version).toBe(2);
      expect(result.owner.owner).toEqual(held.owner); expect(result.owner.generationContinuity?.operationId).toBe(attempt.attemptId);
      expect("custodyBinding" in result.owner).toBe(false); expect(await readFile(ready.reference.path)).toEqual(historical);
      const {generationContinuity:slot,...withoutSlot}=result.owner;
      expect(refusal(()=>f.owners.compareAndSwap(f.workspace,result.owner.revision,
        {...withoutSlot,revision:result.owner.revision+1}))).toBe("invalid_record");
      expect(f.owners.read(f.workspace)).toEqual(result.owner); expect(slot?.kind).toBe(DependencyGenerationContinuityKind.RetiredReadyV1);
      const fenced=parseDependencyOwner({...result.owner,revision:result.owner.revision+1,
        owner:{kind:DependencyOwnerKind.Consumer,phase:DependencyOwnerPhase.Fenced,attempt}});
      f.owners.compareAndSwap(f.workspace,result.owner.revision,fenced);
      f.owners.compareAndSwap(f.workspace,fenced.revision,{...fenced,revision:fenced.revision+1,owner:null});
      const next=claimDependencyConsumer(f.owners,f.workspace,launch,randomUUID()), selected=f.owners.read(f.workspace)!;
      expect(next.attemptId).not.toBe(attempt.attemptId); expect(next.epoch).toBe(attempt.epoch+1);
      expect(selected.version).toBe(2); expect("custodyBinding" in selected).toBe(false);
      if (selected.version===1) throw new Error("TEST unexpected legacy owner");
      expect(selected.generationContinuity).toEqual(result.owner.generationContinuity);
      expect(f.receipts.read(f.workspace)?.state).toBe(State.Unverified); expect(ownerChecks).toBe(1);
    } finally { await f.close(); }
  });
  it("BaselineMissing cannot replace the physical tree or call the factual verifier",async()=>{
    const f=await fixture();
    try {
      const ready=publishLogicalReady(f);let checks=0;
      const history=await readFile(ready.reference.path);
      f.receipts.close();f.receipts=Receipts.open({rootPath:f.receiptRoot,maxRecordBytes:16384,maxHistorySteps:16,
        generationReceiptVerifier:{assertFactualUnverified(){throw new Error("TEST unexpected creation");},assertReadyRetirement(){checks++;}}});
      expect(()=>f.receipts.retireReady(f.workspace,ready.receipt.revision,ready.reference,
        {...unverified(f,3),tree:{...f.tree,ino:String(BigInt(f.tree.ino)+1n)}})).toThrow();
      expect(checks).toBe(0);expect(f.receipts.read(f.workspace)).toEqual(ready.receipt);
      expect(await readFile(ready.reference.path)).toEqual(history);
    }finally{await f.close();}
  });
  it("uncertain ordinary v2 retirement leaves the same held owner after the receipt committed", async () => {
    const f=await fixture();
    try {
      claimDependencyConsumer(f.owners,f.workspace,launch,randomUUID()); const held=f.owners.read(f.workspace)!;
      const ready=publishLogicalReady(f); f.receipts.close(); f.owners.close();
      f.receipts=Receipts.open({rootPath:f.receiptRoot,maxRecordBytes:16384,maxHistorySteps:16,generationReceiptVerifier:{
        assertReadyRetirement({previousReady,previousReference}) {
          expect(previousReady).toEqual(ready.receipt); expect(previousReference).toEqual(ready.reference);
          expect(f.owners.read(f.workspace)).toEqual(held);
        }, assertFactualUnverified() { throw new Error("TEST unexpected factual publication"); },
      }});
      f.owners=Owners.open({rootPath:f.ownerRoot,maxRecordBytes:16384,generationRetirementVerifier:{
        assertGenerationRetirement() { throw new Error("TEST uncertain original completion"); },
      }});
      expect(refusal(()=>invalidateDependencyGeneration({owners:f.owners,receipts:f.receipts,workspace:f.workspace,
        expectedOwnerRevision:held.revision,expectedReceiptRevision:ready.receipt.revision,reason:Reason.TreeChanged}))).toBe("invalid_record");
      expect(f.owners.read(f.workspace)).toEqual(held); expect(f.receipts.read(f.workspace)?.state).toBe(State.Unverified);
      expect(f.receipts.getCommittedReady(f.workspace,2)).toEqual(ready);
      expect(refusal(()=>claimDependencyConsumer(f.owners,f.workspace,launch,randomUUID()))).toBe("busy");
      expect(await readFile(join(f.workspace.canonicalPath,"authored"),"utf8")).toBe("TEST preserve bytes");
    } finally { await f.close(); }
  });
  it("ordinary v2 cannot mint, discard or change a retirement while replacing its held owner", async () => {
    const f=await fixture();
    try {
      const attempt=claimDependencyConsumer(f.owners,f.workspace,launch,randomUUID()), held=f.owners.read(f.workspace)!;
      const ready=publishLogicalReady(f); f.receipts.compareAndSwap(f.workspace,2,unverified(f,3));
      const retired=f.receipts.getCommittedUnverified(f.workspace,3),generationContinuity={version:1,
        kind:DependencyGenerationContinuityKind.RetiredReadyV1,operationId:attempt.attemptId,generation:ready.receipt.generation,
        readyRevision:2,unverifiedRevision:3,previousReady:ready.reference,retiredUnverified:retired.reference};
      const path=join(f.ownerRoot,dependencyOwnerStorageName(f.workspace)),before=await readFile(path);
      expect(refusal(()=>f.owners.compareAndSwap(f.workspace,held.revision,
        parseDependencyOwner({...held,revision:held.revision+1,generationContinuity})))).toBe("invalid_record");
      expect(await readFile(path)).toEqual(before); expect(f.owners.read(f.workspace)).toEqual(held);
      f.owners.close(); let checks=0;
      f.owners=Owners.open({rootPath:f.ownerRoot,maxRecordBytes:16384,generationRetirementVerifier:{
        assertGenerationRetirement() { checks++; throw new Error("TEST verifier refuses unavailable original authority"); },
      }});
      for (const owner of [null,{kind:DependencyOwnerKind.Consumer,phase:DependencyOwnerPhase.ExclusiveMutation,
        attempt:{...attempt,attemptId:randomUUID()}}]) {
        expect(()=>f.owners.compareAndSwap(f.workspace,held.revision,
          parseDependencyOwner({...held,revision:held.revision+1,owner,generationContinuity}))).toThrow();
      }
      expect(checks).toBe(0); expect(await readFile(path)).toEqual(before);
      expect(refusal(()=>f.owners.compareAndSwap(f.workspace,held.revision,
        parseDependencyOwner({...held,revision:held.revision+1,generationContinuity})))).toBe("invalid_record");
      expect(checks).toBe(1); expect(await readFile(path)).toEqual(before);
    } finally { await f.close(); }
  });
  it("missing producer cannot retire Ready or intake factual Unverified; old history stays immutable", async () => {
    const f = await fixture();
    try {
      const committed = publishLogicalReady(f), path = join(f.receiptRoot, dependencyReceiptStorageName(f.workspace));
      const before = await readFile(path), records = await readdir(f.receiptRoot), historical = await readFile(committed.reference.path);
      expect(refusal(() => f.receipts.retireReady(f.workspace, 2, committed.reference, unverified(f, 3)))).toBe("invalid_transition");
      expect(await readFile(path)).toEqual(before); expect(await readdir(f.receiptRoot)).toEqual(records);
      f.receipts.compareAndSwap(f.workspace, 2, unverified(f, 3));
      expect(f.receipts.getCommittedUnverified(f.workspace, 3).receipt.state).toBe(State.Unverified);
      expect(f.receipts.getCommittedReady(f.workspace, 2)).toEqual(committed);
      expect(await readFile(committed.reference.path)).toEqual(historical);
      expect(refusal(() => f.receipts.retireReady(f.workspace, 2, committed.reference, unverified(f, 3)))).toBe("stale_revision");
    } finally { await f.close(); }
    const empty = await fixture();
    try {
      expect(refusal(() => empty.receipts.publishFactualUnverified(empty.workspace, unverified(empty)))).toBe("invalid_transition");
      expect(await readdir(empty.receiptRoot)).toEqual([]);
      // Existing factual generic CAS remains shape/storage facts only.
      empty.receipts.compareAndSwap(empty.workspace, null, unverified(empty));
      const committed = empty.receipts.getCommittedUnverified(empty.workspace, 1);
      expect(committed.receipt.state).toBe(State.Unverified); expect("provenance" in committed.receipt).toBe(false);
      await unlink(join(empty.receiptRoot, dependencyReceiptStorageName(empty.workspace)));
      expect(refusal(() => empty.receipts.publishFactualUnverified(empty.workspace, unverified(empty)))).toBe("corrupt");
      expect(await readFile(committed.reference.path)).toEqual(Buffer.from(JSON.stringify(committed.receipt) + "\n"));
    } finally { await empty.close(); }
  });
});
