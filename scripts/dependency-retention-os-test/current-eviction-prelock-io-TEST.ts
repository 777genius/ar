/** TEST-only finite receipt adapter denial. It grants no native authority and
 * creates/removes no mutex. The original transaction owns every state/effect. */
import assert from "node:assert/strict";
import fs, { openSync, constants, closeSync, fstatSync, lstatSync, realpathSync, readlinkSync, readFileSync, readSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const trustedOpen = fs.openSync;
const mutexFlags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
const identity = (s: {dev:number|bigint;ino:number|bigint}) => ({dev:String(s.dev),ino:String(s.ino)});
function held(): never { throw new Error("TEST_eviction_prelock_adapter_HOLD"); }
function mount(fd:number):string {
  const info=trustedOpen(`/proc/self/fdinfo/${fd}`,constants.O_RDONLY|constants.O_NOFOLLOW),bytes=Buffer.alloc(4097);let length=0;
  try {while(length<bytes.length){const n=readSync(info,bytes,length,bytes.length-length,null);if(n===0)break;length+=n;}assert(length<=4096);}finally{closeSync(info);}
  const text=bytes.subarray(0,length).toString("utf8"),match=/^mnt_id:\s+([0-9]+)$/m.exec(text);assert(match);return match[1]!;
}
function assertEvictionPrelockBuiltinRestored():void {
  if(fs.openSync!==trustedOpen || openSync!==trustedOpen)held();
}
type EvictionPrelockAnchor = Readonly<{path:string;dev:string;ino:string;mount:string;key:string}>;
/** No retained descriptor crosses an original operator/native boundary. */
function captureEvictionPrelockAnchor(path:string,key:string):EvictionPrelockAnchor {
  assertEvictionPrelockBuiltinRestored();assert.equal(process.platform,"linux");assert(/^[1-9][0-9]*-[1-9][0-9]*$/.test(key));
  assert.equal(realpathSync(path),path);const fd=trustedOpen(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try {const s=fstatSync(fd);assert(s.isDirectory() && s.uid===0 && (s.mode&0o7777)===0o700);
    assert.deepEqual(identity(lstatSync(path)),identity(s));return Object.freeze({path,...identity(s),mount:mount(fd),key});
  }finally{closeSync(fd);}
}
/** One original operation interval. Only a candidate open is exposed as DATA;
 * a private synchronous factual reader authenticates the exact renamed state.
 * There is no public callback, phase selector or production hook. */
class EvictionPrelockDenial {
  private active=false;
  private inspecting=false;
  private count=0;
  private readonly injected=Object.assign(new Error("TEST_injected_eviction_receipt_prelock_EIO"),{code:"EIO"});
  private readonly wrapper:typeof fs.openSync;
  constructor(private readonly anchor:EvictionPrelockAnchor, private readonly renamedFacts:()=>boolean) {
    this.wrapper=(path,flags,mode)=>{
      if(!this.active || fs.openSync!==this.wrapper || openSync!==this.wrapper)held();
      const match=typeof path==="string" && flags===mutexFlags && mode===0o600 ?
        /^\/proc\/self\/fd\/([0-9]+)\/([1-9][0-9]*-[1-9][0-9]*)\.lock$/.exec(path):null;
      if(!match || match[2]!==anchor.key)return trustedOpen(path,flags,mode);
      if(this.inspecting || this.count!==0)held();
      this.inspecting=true;
      try {
        this.assertAnchor(Number(match[1]));
        if(!this.renamedFacts())return trustedOpen(path,flags,mode);
        this.assertAnchor(Number(match[1]));this.count++;
        this.close(); // Restore both builtin views BEFORE the private EIO.
        throw this.injected;
      } catch(error) {this.close();throw error;} finally {this.inspecting=false;}
    };
  }
  private assertAnchor(fd:number):void {
    const s=fstatSync(fd);assert(s.isDirectory() && s.uid===0 && (s.mode&0o7777)===0o700);
    assert.deepEqual(identity(s),{dev:this.anchor.dev,ino:this.anchor.ino});
    assert.deepEqual(identity(lstatSync(this.anchor.path)),identity(s));
    assert.equal(readlinkSync(`/proc/self/fd/${fd}`),this.anchor.path);assert.equal(realpathSync(this.anchor.path),this.anchor.path);
    assert.equal(mount(fd),this.anchor.mount);
  }
  assertInjected(error:unknown):void {assert.equal(error,this.injected);assert.equal(this.count,1);assert(!this.active);assertEvictionPrelockBuiltinRestored();}
  arm():void {assert(!this.active && this.count===0);assertEvictionPrelockBuiltinRestored();this.active=true;fs.openSync=this.wrapper;syncBuiltinESMExports();assert.equal(openSync,this.wrapper);}
  close():void {if(this.active){const foreign=fs.openSync!==this.wrapper || openSync!==this.wrapper;
    fs.openSync=trustedOpen;syncBuiltinESMExports();this.active=false;assertEvictionPrelockBuiltinRestored();if(foreign)held();}}
}

/** The original auxiliary C/operator realm owns this one eviction. No path,
 * phase, injector, issuer or effect callback is accepted from its caller. */
export async function runCurrentPositiveEvictionPrelockRecovery(
  roots:import("./current-cold-hot-root.js").CurrentOrdinaryRoots,
  entry:Awaited<ReturnType<typeof import("./current-full-entry.js").runCurrentOrdinaryEntry>>,deadline:number) {
  const {assertRootScope,assertPreparedCurrentConfiguredAuth,isPreparedCurrentPositiveAuxiliary}=await import("./current-cold-hot-root.js");
  const {positiveAcceptanceRemaining}=await import("./current-positive-acceptance-roster.js");
  const remaining=()=>positiveAcceptanceRemaining(deadline);remaining();assert(isPreparedCurrentPositiveAuxiliary(roots));assertRootScope(roots);assertPreparedCurrentConfiguredAuth(roots);
  const {withHostedActivationFence}=await import("../../dist/provider-codex/app-server/adapters/hosted-process-activation.js");
  const {assertCurrentClosedEntry}=await import("./current-closed-entry.js");
  withHostedActivationFence(fence=>assertCurrentClosedEntry(fence,roots.jobRoot,entry.result));
  const {readEvictRestoreReady,readLegacyEvictRestoreAbsent,assertPathAbsent,assertRetainedEvictionProof,assertLegacyRenamedEvidenceData}=await import("./current-evict-restore-readback.js");
  const {captureCurrentCompletedOutputData,assertCurrentCompletedOutputData}=await import("./current-explicit-preservation.js");
  const {captureEvictRestoreSentinels,assertEvictRestoreSentinels}=await import("./current-evict-restore-sentinels.js");
  const {HostedInstallationActivationStore,readHostedInstallationActivation}=await import("../../dist/worker-codex/hosted-installation-activation.js");
  const {DependencyReceiptState:State,DependencyInstallProofKind}=await import("../../dist/worker-core/index.js");
  const {DependencyOwnerKind,DependencyOwnerPhase,DependencyGenerationContinuityKind:Continuity,isDependencyCustodyObject,parseDependencyOwner}=await import("../../dist/core/index.js");
  const {LocalDependencyReceiptStore}=await import("../../dist/store-local-file/dependency-environment/local-dependency-receipt-store.js");
  const {LocalDependencyOwnerStore}=await import("../../dist/store-local-file/dependency-environment/local-dependency-owner-store.js");
  const {hostedDependencyOwnerRoot,readHostedDependencyBinding}=await import("../../dist/provider-codex/app-server/adapters/hosted-dependency-workspace.js");
  const {hostedDependencyReceiptHistoryRoot}=await import("../../dist/provider-codex/app-server/adapters/hosted-dependency-history-path.js");
  const {pinReferenceFile}=await import("../../dist/worker-codex/hosted-dependency-legacy-reference-records.js");
  const {assertHostedDependencyLegacyComparedReady}=await import("../../dist/worker-codex/hosted-dependency-legacy-comparison-record.js");
  const {readHostedDependencyScratchLayout,HostedDependencyScratchLayoutKind}=await import("../../dist/worker-codex/hosted-dependency-scratch-layout.js");
  const {readHostedDependencyEvictionEnabled}=await import("../../dist/worker-codex/hosted-dependency-eviction-enabled-policy.js");
  const root="/var/lib/subscription-runtime-host-policy",binding=readHostedDependencyBinding(roots.candidateJobId);assert(binding && binding.version===2);
  assert.equal(binding.runtimeSha,roots.sourceSha);const layout=readHostedDependencyScratchLayout(binding.runtimeSha);assert.equal(layout.kind,HostedDependencyScratchLayoutKind.OriginalFull);
  const ready=readEvictRestoreReady(roots);assert(ready.receipt.provenance.kind===DependencyInstallProofKind.LegacyCompared);
  const comparisonEvidenceId=ready.receipt.provenance.comparisonEvidenceId;
  const comparison=assertHostedDependencyLegacyComparedReady({...ready.receipt,provenance:ready.receipt.provenance});assert(comparison.version===2);
  assert.equal(readHostedInstallationActivation().installation.runtimeSha,roots.sourceSha);assert.equal(readHostedDependencyEvictionEnabled(),true);
  const ownerRead=()=>{const s=LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384});try{return s.read(binding.workspace);}finally{s.close();}};
  const previous=ownerRead();assert(previous && previous.version!==1 && previous.owner===null && previous.generationContinuity?.kind===Continuity.BaselineAuthenticatedV1);
  const baseline=previous.generationContinuity;
  const source=pinReferenceFile(`${root}/dependency-generation-source-closures/${entry.observation.startId}.json`,65536);
  assert.equal(source.reference.sha256,entry.observation.sourceClosedSha256);
  const idle=pinReferenceFile(`${root}/dependency-generation-idle-closures/${binding.workspace.dev}-${binding.workspace.ino}/${previous.revision}.json`,16384);
  const refs=[source.reference,idle.reference,previous.generationContinuity.baseline,previous.generationContinuity.writerBarrier,
    pinReferenceFile(`${root}/dependency-retention-policy.json`,4096).reference,ready.reference,comparison.candidateSourceBinding];
  const stableReferences=()=>{for(const ref of refs)assert.deepEqual(pinReferenceFile(ref.path,262144).reference,ref);};stableReferences();
  const completed=await captureCurrentCompletedOutputData(roots,entry.result),sentinels=captureEvictRestoreSentinels(roots);
  const key=`${binding.workspace.dev}-${binding.workspace.ino}`,anchor=captureEvictionPrelockAnchor(hostedDependencyReceiptHistoryRoot,key);
  const mutex=anchor.path+"/"+key+".lock";assertPathAbsent(mutex);
  type Pin=ReturnType<typeof pinReferenceFile>["reference"];
  let interrupted:Readonly<{operationId:string;owner:NonNullable<ReturnType<typeof ownerRead>>;evicting:Pin;header:Pin;renamed:Pin;maintenance:Pin;trash:string}>|undefined;
  // Synchronous bounded store/record reads only. No production authority or
  // native descriptor census runs with the publisher's receipt-root FD open.
  const facts=()=>{
    remaining();stableReferences();assertPathAbsent(mutex);
    const receipts=LocalDependencyReceiptStore.open({rootPath:anchor.path,maxRecordBytes:16384,maxHistorySteps:2048});
    let committed:ReturnType<typeof receipts.getCommittedEvicting>;
    try {const current=receipts.read(binding.workspace);
      if(current?.state===State.Ready){assert.deepEqual(current,ready.receipt);assert(!interrupted);return false;}
      assert(current?.state===State.Evicting);committed=receipts.getCommittedEvicting(binding.workspace,ready.receipt.revision+1);assert.deepEqual(committed.receipt,current);
    }finally{receipts.close();}
    const evicting=committed.receipt;assert.equal(evicting.revision,ready.receipt.revision+1);assert.equal(evicting.generation,ready.receipt.generation);
    assert.equal(evicting.installKey,ready.receipt.installKey);assert.equal(evicting.manifestDigest,ready.receipt.manifestDigest);assert.deepEqual(evicting.tree,ready.receipt.tree);
    const owner=ownerRead();assert(owner && owner.version!==1 && owner.owner?.kind===DependencyOwnerKind.Maintenance);
    const slot=owner.generationContinuity;assert(slot?.kind===Continuity.RetiredEvictingV1);
    const operationId=owner.owner.attempt.operationId;assert.equal(operationId,evicting.operationId);assert.equal(slot.operationId,operationId);assert.equal(slot.generation,ready.receipt.generation);
    assert.equal(slot.readyRevision,ready.receipt.revision);assert.equal(slot.evictingRevision,evicting.revision);
    assert.deepEqual(slot.previousReady,ready.reference);assert.deepEqual(slot.retiredEvicting,committed.reference);
    assert.deepEqual(slot.baseline,baseline.baseline);assert.deepEqual(slot.writerBarrier,baseline.writerBarrier);
    const path=`${root}/dependency-transactions/${operationId}`,header=pinReferenceFile(path+".json",32768),h:unknown=JSON.parse(header.bytes.toString("utf8"));
    assert(isDependencyCustodyObject(h,"attempt,ready,trash,version") && h.version===1);assert.deepEqual(h.ready,ready.receipt);
    assert.deepEqual(h.attempt,owner.owner.attempt);assert.deepEqual(h.trash,evicting.trash);
    const maintenance=pinReferenceFile(`${root}/dependency-generation-maintenance/${operationId}.json`,65536),m:unknown=JSON.parse(maintenance.bytes.toString("utf8"));
    assert(isDependencyCustodyObject(m,"binding,claimed,idle,previous,sourceClosed,version") && m.version===1);
    assert.deepEqual(m.binding,binding);assert.deepEqual(m.previous,previous);assert.deepEqual(m.sourceClosed,source.reference);assert.deepEqual(m.idle,idle.reference);
    const claimed=parseDependencyOwner(m.claimed);assert.equal(owner.owner.phase,DependencyOwnerPhase.ExclusiveMutation);
    assert.deepEqual(claimed,{...previous,revision:previous.revision+1,epoch:previous.epoch+1,owner:owner.owner});
    assert.deepEqual(owner,{...claimed,revision:claimed.revision+1,generationContinuity:slot});
    assertPathAbsent(roots.workspace+"/node_modules");const parent=evicting.trash.destinationParent;
    assert.equal(parent.canonicalPath,layout.trash);assert.deepEqual(identity(lstatSync(parent.canonicalPath)),{dev:parent.dev,ino:parent.ino});
    assert.equal(evicting.trash.destinationName,"dependency-"+operationId);const trash=parent.canonicalPath+"/"+evicting.trash.destinationName;
    const tree=lstatSync(trash);assert(tree.isDirectory() && !tree.isSymbolicLink());assert.deepEqual(identity(tree),ready.receipt.tree);
    const renamed=pinReferenceFile(path+".renamed.json",16384);
    assertLegacyRenamedEvidenceData(renamed.bytes,{version:3,operationId,workspace:binding.workspace,epoch:owner.owner.attempt.epoch,tree:ready.receipt.tree,
      trash:evicting.trash,manifestDigest:ready.receipt.manifestDigest,headerSha256:header.reference.sha256,
      comparisonEvidenceId,sourceBinding:comparison.candidateSourceBinding});
    const value={operationId,owner,evicting:committed.reference,header:header.reference,renamed:renamed.reference,maintenance:maintenance.reference,trash};
    if(interrupted)assert.deepEqual(value,interrupted);else interrupted=Object.freeze(value);
    stableReferences();assertPathAbsent(mutex);return true;
  };
  const store=new HostedInstallationActivationStore(),denial=new EvictionPrelockDenial(anchor,facts);
  store.resumeOrdinary();remaining();denial.arm();let originalError:unknown;
  try {await store.evictDependencyCandidate({jobId:roots.candidateJobId,revision:ready.receipt.revision,generation:ready.receipt.generation,installKey:ready.receipt.installKey});}
  catch(error){originalError=error;}finally{denial.close();}
  denial.assertInjected(originalError);assert(interrupted);assert(facts());assertCurrentCompletedOutputData(completed);assertEvictRestoreSentinels(roots,sentinels);
  remaining();const evicted=await store.recoverDependencyEviction(roots.candidateJobId);remaining();
  const proof=readLegacyEvictRestoreAbsent(roots,ready);assert.equal(proof.absent.receipt.operationId,interrupted.operationId);
  assert.deepEqual(proof.evicting.reference,interrupted.evicting);assert.deepEqual(proof.header,interrupted.header);assert.deepEqual(proof.renamed,interrupted.renamed);assert.equal(proof.trash,interrupted.trash);
  assertRetainedEvictionProof(proof);assertPathAbsent(mutex);stableReferences();assertCurrentCompletedOutputData(completed);assertEvictRestoreSentinels(roots,sentinels);
  const released=ownerRead();assert(released?.owner===null);
  await assert.rejects(store.recoverDependencyEviction(roots.candidateJobId),error=>error instanceof Error && error.message==="dependency_transaction_unresolved");
  assert.deepEqual(ownerRead(),released);assert.deepEqual(readLegacyEvictRestoreAbsent(roots,ready),proof);assertRetainedEvictionProof(proof);assertPathAbsent(mutex);stableReferences();assertCurrentCompletedOutputData(completed);assertEvictRestoreSentinels(roots,sentinels);assertEvictionPrelockBuiltinRestored();remaining();
  return Object.freeze({evicted,recovery:Object.freeze({kind:"TEST_injected_adapter_prelock_EIO_then_original_recovery",triggerCount:1,operationId:interrupted.operationId,
    evicting:interrupted.evicting,absent:proof.absent.reference,header:interrupted.header,renamed:interrupted.renamed,maintenance:interrupted.maintenance,
    originalTree:ready.receipt.tree,sourceClosed:source.reference,idle:idle.reference,completed,secondRecovery:"no_Maintenance_refused_unchanged"})});
}

/** Fixed local I/O self-check, never a caller-configurable fault API. No native
 * actor, receipt, state transition or authority is fabricated by these checks. */
export async function selfCheckEvictionPrelockBuiltinIO():Promise<void> {
  const {mkdtempSync,rmSync}=await import("node:fs"),{tmpdir}=await import("node:os");
  const path=realpathSync(mkdtempSync(tmpdir()+"/TEST-prelock-builtin-"));
  const anchor:EvictionPrelockAnchor={path,dev:"1",ino:"1",mount:"1",key:"1-2"};
  const denial=new EvictionPrelockDenial(anchor,()=>held());
  try {
    denial.arm();assert.notEqual(openSync,trustedOpen);assert.equal(fs.openSync,openSync);
    const fd=openSync(path+"/ordinary", "wx",0o600);closeSync(fd);assert.equal(readFileSync(path+"/ordinary").length,0);
    denial.close();assertEvictionPrelockBuiltinRestored();
    const replacement:typeof fs.openSync=(p,f,m)=>trustedOpen(p,f,m);
    fs.openSync=replacement;syncBuiltinESMExports();assert.throws(()=>new EvictionPrelockDenial(anchor,()=>false).arm(),/TEST_eviction_prelock_adapter_HOLD/);
    fs.openSync=trustedOpen;syncBuiltinESMExports();
    const late=new EvictionPrelockDenial(anchor,()=>false);late.arm();fs.openSync=replacement;syncBuiltinESMExports();
    assert.throws(()=>late.close(),/TEST_eviction_prelock_adapter_HOLD/);assertEvictionPrelockBuiltinRestored();
    assert.throws(()=>denial.assertInjected(Object.assign(new Error("different"),{code:"EIO"})));
  }finally{denial.close();fs.openSync=trustedOpen;syncBuiltinESMExports();rmSync(path,{recursive:true});}
}
/** ROOT/Linux only: real proc-FD routing, finite denial, initial-lock delegation,
 * mismatch/matcher-failure restoration and no retained adapter descriptor. */
export async function selfCheckEvictionPrelockAnchoredIO():Promise<void> {
  assert.equal(process.platform,"linux");assert.equal(process.getuid?.(),0);
  const {mkdtempSync,rmSync,unlinkSync,readdirSync}=await import("node:fs"),{tmpdir}=await import("node:os");
  const path=realpathSync(mkdtempSync(tmpdir()+"/TEST-prelock-anchor-")),anchor=captureEvictionPrelockAnchor(path,"1-2");
  const fd=trustedOpen(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW),target=`/proc/self/fd/${fd}/1-2.lock`;
  const before=readdirSync("/proc/self/fd").sort();let renamed=false;
  const denial=new EvictionPrelockDenial(anchor,()=>renamed);
  try {
    denial.arm();const initial=openSync(target,mutexFlags,0o600);closeSync(initial);
    const lock=lstatSync(path+"/1-2.lock");assert(lock.isFile() && lock.nlink===1);unlinkSync(path+"/1-2.lock");
    renamed=true;
    for(const [flags,mode] of [[mutexFlags^constants.O_NOFOLLOW,0o600],[mutexFlags,0o640]] as const){
      const delegated=openSync(target,flags,mode),owned=fstatSync(delegated);closeSync(delegated);
      assert.deepEqual(identity(lstatSync(path+"/1-2.lock")),identity(owned));unlinkSync(path+"/1-2.lock");
    }
    let caught:unknown;try{openSync(target,mutexFlags,0o600);}catch(error){caught=error;}
    denial.assertInjected(caught);assert.throws(()=>denial.arm());assert.throws(()=>lstatSync(path+"/1-2.lock"),{code:"ENOENT"});assertEvictionPrelockBuiltinRestored();
    const ownFailure=new Error("TEST_private_matcher_refusal"),failed=new EvictionPrelockDenial(anchor,()=>{throw ownFailure;});
    failed.arm();assert.throws(()=>openSync(target,mutexFlags,0o600),error=>error===ownFailure);failed.close();assertEvictionPrelockBuiltinRestored();
    const wrong=new EvictionPrelockDenial({...anchor,ino:"999999999999999"},()=>true);
    wrong.arm();assert.throws(()=>openSync(target,mutexFlags,0o600));wrong.close();assertEvictionPrelockBuiltinRestored();
    assert.throws(()=>lstatSync(path+"/1-2.lock"),{code:"ENOENT"});assert.deepEqual(readdirSync("/proc/self/fd").sort(),before);
  }finally{denial.close();assertEvictionPrelockBuiltinRestored();closeSync(fd);rmSync(path,{recursive:true});}
}
