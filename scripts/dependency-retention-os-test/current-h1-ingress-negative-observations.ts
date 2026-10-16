/** Original H1 factual denials only. No correlation, issuer, child or grant. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import type { CurrentColdHotRoots } from "./current-cold-hot-root.js";
export enum H1IngressNegativeSite { Recipe="unregistered_recipe", Cwd="unregistered_cwd", Stale="stale_ready_revision" }
export enum H1LiveNegativeStatus { Observed="actual_live_owner_observed_busy_call_unproved", Unproved="live_window_unobserved" }
type Launch=Readonly<{command:string;args:readonly string[];cwd:string}>;
const root="/var/lib/subscription-runtime-host-policy";
const encode=(v:unknown)=>Buffer.from(JSON.stringify(v)+"\n");
const digest=(v:unknown)=>createHash("sha256").update(encode(v)).digest("hex");
/** Finite DATA tuples. The real original inventory is selected independently. */
export function h1UnregisteredIngressTuples(launch:Launch) {
  assert(launch.command.startsWith("/") && launch.cwd.startsWith("/") && launch.args.length>0);
  return Object.freeze([
    Object.freeze({site:H1IngressNegativeSite.Recipe,command:launch.command,args:[...launch.args,"--TEST-unregistered-rollback"],cwd:launch.cwd}),
    Object.freeze({site:H1IngressNegativeSite.Cwd,command:launch.command,args:[...launch.args],cwd:launch.cwd+"/packages/live"}),
  ]);
}
export function h1StaleRevision(revision:number):number {assert(Number.isSafeInteger(revision) && revision>0 && revision<Number.MAX_SAFE_INTEGER);return revision+1;}
const observations=new WeakMap<CurrentColdHotRoots,Readonly<{ingress:readonly Readonly<{site:H1IngressNegativeSite;beforeSha256:string;afterSha256:string}>[]}>>();
async function runtime(roots:CurrentColdHotRoots,deadline:number) {
  const {assertRootScope}=await import("./current-cold-hot-root.js");
  const {withHostedActivationFence,isHostedActivationFenceBusy}=await import("../../dist/provider-codex/app-server/adapters/hosted-process-activation.js");
  const {HostedInstallationActivationStore,readHostedInstallationActivation}=await import("../../dist/worker-codex/hosted-installation-activation.js");
  const {HostedReadonlyHostKernel,readHostedReadonlyHostInventory}=await import("../../dist/worker-codex/hosted-readonly-host-kernel.js");
  const {pinReferenceFile}=await import("../../dist/worker-codex/hosted-dependency-legacy-reference-records.js");
  const {readHostedDependencyBinding,hostedDependencyOwnerRoot}=await import("../../dist/provider-codex/app-server/adapters/hosted-dependency-workspace.js");
  const {LocalDependencyOwnerStore}=await import("../../dist/store-local-file/dependency-environment/local-dependency-owner-store.js");
  const {readHostedDependencyEstablishedReceipt}=await import("../../dist/worker-codex/hosted-dependency-receipts.js");
  const store=new HostedInstallationActivationStore();
  const bound=()=>{assert(Number.isFinite(deadline) && performance.now()<deadline);};
  function names(path:string) {if(!existsSync(path))return null;const s=lstatSync(path);assert(s.isDirectory() && !s.isSymbolicLink() && s.uid===0);const rows=readdirSync(path).sort();assert(rows.length<=4096);return rows;}
  function captureFacts() {
    bound();assertRootScope(roots);new HostedReadonlyHostKernel().operatorSession();
    const binding=readHostedDependencyBinding(roots.candidateJobId);assert(binding && binding.version===2);assert.equal(binding.runtimeSha,roots.sourceSha);
    const actual=readHostedInstallationActivation();assert.equal(actual.installation.runtimeSha,roots.sourceSha);
    const owners=LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384});
    const owner=(()=>{try{return owners.read(binding.workspace);}finally{owners.close();}})();
    const tree=(()=>{try{const t=lstatSync(roots.workspace+"/node_modules",{bigint:true});assert(t.isDirectory() && !t.isSymbolicLink());return {dev:String(t.dev),ino:String(t.ino),mtimeNs:String(t.mtimeNs),ctimeNs:String(t.ctimeNs)};}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;return null;}})();
    const receipt=readHostedDependencyEstablishedReceipt(binding);
    const fixed=["readonly-inventory.json","host-installation.json","dependency-retention-policy.json"].map(name=>pinReferenceFile(root+"/"+name,1024*1024).reference);
    const value={binding,owner,receipt,tree,fixed,
      activation:actual,installers:names(root+"/dependency-installers"),transactions:names(root+"/dependency-transactions")};
    bound();return value;
  }
  // Admission denials retain the original full exclusive inventory gate.
  function captureIdleDenial() {new HostedReadonlyHostKernel().verifyExclusiveInventory();return captureFacts();}
  // Read-only live facts deliberately do not run schema4's idle admission scan.
  // This snapshot never grants reservation, maintenance, release or an effect.
  function captureLiveFacts() {return captureFacts();}
  return {store,bound,captureIdleDenial,captureLiveFacts,withHostedActivationFence,isHostedActivationFenceBusy,readHostedReadonlyHostInventory};
}
/** Called once before the original first C reservation. Exact known refusal,
 * unchanged original protected state, no unsafe negative retry. */
export async function observeOriginalH1UnregisteredIngress(roots:CurrentColdHotRoots,deadline:number) {
  assert(!observations.has(roots));const r=await runtime(roots,deadline);
  const ingress=r.withHostedActivationFence(fence=>{
    const rows=r.readHostedReadonlyHostInventory().ordinaryCreators.filter(row=>row.jobId===roots.candidateJobId && row.creatorId===roots.candidateJobId && row.jobRootDir===roots.jobRoot && row.workspacePath===roots.workspace);
    assert.equal(rows.length,1);const before=r.captureIdleDenial();
    return h1UnregisteredIngressTuples(rows[0]!.launch).map(tuple=>{
      assert.throws(()=>r.store.reserveOrdinaryRuntime(fence,tuple.command,tuple.args,tuple.cwd),error=>error instanceof Error && error.message==="hosted_activation_evidence_invalid");
      const after=r.captureIdleDenial();assert.deepEqual(after,before);return Object.freeze({site:tuple.site,beforeSha256:digest(before),afterSha256:digest(after)});
    });
  });observations.set(roots,{ingress});return ingress;
}
/** Public async eviction owns its own fence. This idle stale selector is safe:
 * wrong revision must refuse before ownership even when the owner is released. */
export async function observeOriginalH1StaleSelection(roots:CurrentColdHotRoots,deadline:number,live:Awaited<ReturnType<typeof observeOriginalH1LiveHot>>) {
  const held=observations.get(roots);assert(held);const r=await runtime(roots,deadline);
  const {DependencyReceiptState}=await import("../../dist/worker-core/index.js");
  const before=r.withHostedActivationFence(()=>r.captureIdleDenial());assert(before.receipt?.state===DependencyReceiptState.Ready);
  assert(before.owner && before.owner.owner===null);const ready=before.receipt;
  await assert.rejects(r.store.evictDependencyCandidate({jobId:roots.candidateJobId,generation:ready.generation,revision:h1StaleRevision(ready.revision),installKey:ready.installKey}),error=>error instanceof Error && error.message==="dependency_transaction_unresolved");
  const after=r.withHostedActivationFence(()=>r.captureIdleDenial());assert.deepEqual(after,before);
  return Object.freeze({schemaVersion:1,sourceSha:roots.sourceSha,jobId:roots.candidateJobId,ingress:held.ingress,
    stale:{site:H1IngressNegativeSite.Stale,beforeSha256:digest(before),afterSha256:digest(after)},
    live,historicalExecutable:"not_executed",nativeAllReaders:"unproved"});
}

/** Factual native observation ONLY. Correct async eviction cannot safely share
 * this observation fence: its defining public API acquires a new fence. Never
 * race an actual completed/released hot owner with a destructive valid request. */
export async function observeOriginalH1LiveHot(roots:CurrentColdHotRoots,deadline:number,coldStartId:string) {
  const r=await runtime(roots,deadline);
  const {DependencyOwnerKind,DependencyOwnerPhase,HostedCustodyReservationState,parseHostedOrdinaryStart}=await import("../../dist/worker-core/index.js");
  const {pinReferenceFile}=await import("../../dist/worker-codex/hosted-dependency-legacy-reference-records.js");
  const {collectUnitShow,collectProcessBirth,collectProcessCgroup,withScopedCollectionBudget}=await import("../../dist/worker-codex/hosted-readonly-linux-collector.js");
  const end=Math.min(deadline,performance.now()+1500);
  while(performance.now()+20<end) {
    const observed=(()=>{try{return r.withHostedActivationFence(()=>{
      const before=r.captureLiveFacts(),owner=before.owner;
      if(owner?.owner?.kind!==DependencyOwnerKind.Consumer || owner.owner.phase!==DependencyOwnerPhase.Running || owner.owner.attempt.launch.startId===coldStartId)return undefined;
      const attempt=owner.owner.attempt,start=pinReferenceFile(root+"/ordinary-starts/"+attempt.launch.startId+".json",65536);
      const value=parseHostedOrdinaryStart(JSON.parse(start.bytes.toString("utf8")));
      assert.equal(value.jobId,roots.candidateJobId);assert.equal(value.workspacePath,roots.workspace);assert.equal(value.unit,attempt.launch.unit);
      assert.equal(value.installationId,before.binding.installationId);assert.equal(value.bootId,attempt.launch.bootId);
      const reservations=before.activation.activation.ordinaryStarts.filter(row=>row.startId===attempt.launch.startId);assert.equal(reservations.length,1);
      const reservation=reservations[0]!;assert.equal(reservation.state,HostedCustodyReservationState.Reserved);assert.equal(reservation.unit,value.unit);
      assert.equal(reservation.creatorId,roots.candidateJobId);assert.equal(reservation.originSha256,value.originSha256);assert.equal(reservation.generation,value.activationGeneration);
      const available=Math.floor(end-performance.now());if(available<1)return undefined;
      const native=withScopedCollectionBudget(available,()=>{
        const unit=collectUnitShow(value.unit);assert.equal(unit.ControlGroup,value.controlGroup);
        if(!unit.MainPID || unit.MainPID==="0")return undefined;
        try {const birth=collectProcessBirth(unit.MainPID);assert.equal(collectProcessCgroup(unit.MainPID),"0::"+value.controlGroup);
          assert.equal(collectProcessBirth(unit.MainPID),birth);return {birth,unit:value.unit,group:value.controlGroup};
        }catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return undefined;throw error;}
      });
      if(!native)return undefined;const after=r.captureLiveFacts();assert.deepEqual(after,before);
      assert.deepEqual(pinReferenceFile(start.reference.path,65536).reference,start.reference);
      return Object.freeze({status:H1LiveNegativeStatus.Observed,attemptedCorrectEviction:false,busyCall:"unproved",startId:attempt.launch.startId,
        ownerSha256:digest(owner),startSha256:start.reference.sha256,nativeSha256:digest(native)});
    });}catch(error){if(!r.isHostedActivationFenceBusy(error))throw error;return undefined;}})();
    if(observed)return observed;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  return Object.freeze({status:H1LiveNegativeStatus.Unproved,attemptedCorrectEviction:false,busyCall:"unproved"});
}
/** Protected factual checkpoint only; not consulted by any runtime issuer. */
export async function retainOriginalH1IngressNegatives(roots:CurrentColdHotRoots,deadline:number,value:Awaited<ReturnType<typeof observeOriginalH1StaleSelection>>) {
  const r=await runtime(roots,deadline);
  const {createReadonlyPrivateRecord}=await import("../../dist/worker-codex/hosted-readonly-custody.js");
  const {pinReferenceFile}=await import("../../dist/worker-codex/hosted-dependency-legacy-reference-records.js");
  return r.withHostedActivationFence(()=>{r.bound();assert.equal(value.jobId,roots.candidateJobId);assert.equal(value.sourceSha,roots.sourceSha);
    assertH1IngressNegativeRecord(value,roots.sourceSha,roots.candidateJobId);
    const path=root+"/current-h1-ingress-negative-observations.json",bytes=encode(value);assert(bytes.length<=16384);
    createReadonlyPrivateRecord(path,bytes);const selected=pinReferenceFile(path,16384);assert(selected.bytes.equals(bytes));return selected.reference;});
}

/** Finite record syntax, never grants closure/admission from copied DATA. */
export function assertH1IngressNegativeRecord(value:unknown,sourceSha:string,jobId:string):void {
  assert(value && typeof value==="object" && !Array.isArray(value));const v=value as Record<string,unknown>;
  assert.equal(Object.keys(v).sort().join(","),"historicalExecutable,ingress,jobId,live,nativeAllReaders,schemaVersion,sourceSha,stale");
  assert.equal(v.schemaVersion,1);assert.equal(v.sourceSha,sourceSha);assert.equal(v.jobId,jobId);
  assert.equal(v.historicalExecutable,"not_executed");assert.equal(v.nativeAllReaders,"unproved");
  const check=(x:unknown,site:H1IngressNegativeSite)=>{assert(x && typeof x==="object");const r=x as Record<string,unknown>;
    assert.equal(Object.keys(r).sort().join(","),"afterSha256,beforeSha256,site");assert.equal(r.site,site);
    assert(typeof r.beforeSha256==="string" && /^[a-f0-9]{64}$/.test(r.beforeSha256));assert.equal(r.afterSha256,r.beforeSha256);};
  assert(Array.isArray(v.ingress) && v.ingress.length===2);check(v.ingress[0],H1IngressNegativeSite.Recipe);check(v.ingress[1],H1IngressNegativeSite.Cwd);check(v.stale,H1IngressNegativeSite.Stale);
  assert(v.live && typeof v.live==="object");const live=v.live as Record<string,unknown>;
  assert(live.status===H1LiveNegativeStatus.Observed || live.status===H1LiveNegativeStatus.Unproved);
  assert.equal(live.attemptedCorrectEviction,false);assert.equal(live.busyCall,"unproved");
  const keys=live.status===H1LiveNegativeStatus.Observed?"attemptedCorrectEviction,busyCall,nativeSha256,ownerSha256,startId,startSha256,status":"attemptedCorrectEviction,busyCall,status";
  assert.equal(Object.keys(live).sort().join(","),keys);
  if(live.status===H1LiveNegativeStatus.Observed){assert(typeof live.startId==="string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(live.startId));for(const key of ["nativeSha256","ownerSha256","startSha256"])assert(typeof live[key]==="string" && /^[a-f0-9]{64}$/.test(live[key]));}
}
