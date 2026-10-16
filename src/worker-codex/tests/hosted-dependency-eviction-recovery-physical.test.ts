/** Production recovery predicates over real files/stores/manifest/rename.
 * Current-origin/native/source-history/manager facts are explicitly projected;
 * this fixture is not a successful installer or authentic current C lineage. */
import { randomUUID, createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DependencyReceiptState as State, DependencyInstallProofKind as Proof, DependencyPreservationKind as Preserve,
  DependencyTreeObservationStatus as Observed, DependencyGenerationContinuityKind as Continuity,
  claimDependencyConsumer, fenceDependencyConsumer, claimDependencyMaintenance, assertDependencyMaintenance,
  type DependencyReceipt, type DependencyWorkspaceIdentity, type DependencyMaintenanceAttempt } from "../../worker-core/index";
import { DependencyToolProfileId, DependencyToolTransformCache, dependencyToolPins } from "../../core/dependency-environment/dependency-tool-profile";
import type { HostedDependencyBinding } from "../../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { LocalDependencyOwnerStore } from "../../store-local-file/dependency-environment/local-dependency-owner-store";
import { LocalDependencyReceiptStore } from "../../store-local-file/dependency-environment/local-dependency-receipt-store";
import { LocalDependencyManifestBlobStore } from "../../store-local-file/dependency-environment/local-dependency-manifest-blob-store";
import { observeDependencyTree } from "../../worker-local/dependency-environment/observe-dependency-tree";
const f=vi.hoisted(()=>({root:"",owners:"",receipts:"",blobs:"",trash:"",installers:"",header:"",renamed:"",op:"",
  binding:undefined as HostedDependencyBinding|undefined,attempt:undefined as DependencyMaintenanceAttempt|undefined,
  key:"",authorityReads:0,maintenanceReads:0,sourceHistoryReads:0,sourceAdmissions:0,keys:0,observed:[] as {status:Observed;digest:string|null}[],
  publishes:0,releases:0,renames:0,vetoes:0,evidenceReads:0}));
const operations="/var/lib/subscription-runtime-host-policy/dependency-transactions/";
const limits={maxEntries:128,maxTotalBytes:65536,maxManifestBytes:65536,maxDurationMs:30000};
const enc=(v:unknown)=>Buffer.from(JSON.stringify(v)+"\n");
const hash=(v:Uint8Array)=>createHash("sha256").update(v).digest("hex");
function selected(){if(!f.binding)throw Error("TEST missing projected binding");return f.binding;}
function local(path:string){if(path===operations+f.op+".json")return f.header;if(path===operations+f.op+".renamed.json")return f.renamed;return path;}
function owners(){return LocalDependencyOwnerStore.open({rootPath:f.owners,maxRecordBytes:16384,
  // Native completion/continuous exclusion is the projected upstream port;
  // the store still enforces the actual typed transition and durable CAS.
  generationBaselineVerifier:{assertGenerationBaselineTransition:()=>{}}});}
function receipts(){return LocalDependencyReceiptStore.open({rootPath:f.receipts,maxRecordBytes:16384,maxHistorySteps:32,
  localInstallVerifier:{assertCompletedLocalInstall:()=>{}}});}
function pin(path:string){const bytes=readFileSync(path),s=lstatSync(path,{bigint:true});return {path,identity:{dev:String(s.dev),ino:String(s.ino)},sha256:hash(bytes)};}
vi.mock("node:fs",async original=>{const actual=await original<typeof import("node:fs")>();return {...actual,
  // Exact selected protected-header placement only; the metadata is the real
  // owned file's stat. No walker/rename/observer or synthetic stat is supplied.
  lstatSync:new Proxy(actual.lstatSync,{apply(target,thisArg,args:unknown[]){return Reflect.apply(target,thisArg,
    args[0]===operations+f.op+".json"?[f.header,...args.slice(1)]:args);}})};});
vi.mock("../../provider-codex/app-server/adapters/hosted-process-activation",()=>({withHostedActivationFence:(fn:(v:unknown)=>unknown)=>fn({held:true}),
  readHostedActivationBytes:()=>null,decodeHostedActivationBytes:(b:Buffer)=>JSON.parse(b.toString("utf8")) as unknown}));
vi.mock("../hosted-current-dependency-origin",()=>({
  readCurrentHostedDependencyMaintenanceAuthority:()=>{f.authorityReads++;const b=selected();return {binding:b,installation:{installationId:b.installationId,runtimeSha:b.runtimeSha,inventorySha256:"c".repeat(64)},
    activation:{ordinaryStarts:[]},session:{bootId:"00000000-0000-4000-8000-000000000002",supervisorId:"123:456"}};},
  assertCurrentHostedDependencyMaintenance:(_f:unknown,_job:string,attempt:DependencyMaintenanceAttempt)=>{f.maintenanceReads++;const s=owners();try{
    const value=assertDependencyMaintenance(s,selected().workspace,attempt);expect(value.version).toBe(2);
    expect(value.version!==1 && value.generationContinuity?.kind).toBe(Continuity.RetiredEvictingV1);
  }finally{s.close();}},
  releaseCurrentHostedDependencyMaintenance:()=>{f.releases++;throw Error("TEST unexpected release");},
  renameCurrentHostedDependencyMaintenanceTree:()=>{f.renames++;throw Error("TEST unexpected second rename");},
}));
vi.mock("../../provider-codex/app-server/adapters/hosted-dependency-workspace",()=>({get hostedDependencyOwnerRoot(){return f.owners;},readHostedDependencyBinding:selected}));
vi.mock("../hosted-dependency-scratch-layout",()=>({readHostedDependencyScratchLayout:()=>({trash:f.trash})}));
vi.mock("../hosted-dependency-ready-source-links",()=>({
  assertHostedDependencyReadySourceHistory:(ready:Extract<DependencyReceipt,{state:State.Ready}>)=>{
    f.sourceHistoryReads++;expect(ready.provenance.kind).toBe(Proof.CompletedLocalInstallV1);},
  // There are no source links in this physical tree. Only upstream source
  // admission is projected; no opaque session/private issuer is forged.
  openHostedDependencyReadySourceLinks:()=>{f.sourceAdmissions++;return undefined;},
}));
vi.mock("../hosted-dependency-receipts",()=>({readHostedDependencyReceipt:()=>{const s=receipts();try{return s.read(selected().workspace);}finally{s.close();}},
  publishHostedDependencyReceipt:(b:HostedDependencyBinding,r:number,next:DependencyReceipt)=>{f.publishes++;const s=receipts();try{return s.compareAndSwap(b.workspace,r,next);}finally{s.close();}},
  readHostedDependencyCommittedAbsent:(b:HostedDependencyBinding,r:number)=>{const s=receipts();try{return s.getCommittedAbsent(b.workspace,r);}finally{s.close();}},
}));
vi.mock("../hosted-readonly-inputs",()=>({readHostedPrivateBytes:(path:string,max:number)=>{
  if(path===operations+f.op+".close-unresolved.json")return null;
  expect([operations+f.op+".json",operations+f.op+".renamed.json"]).toContain(path);
  if(path.endsWith(".renamed.json"))f.evidenceReads++;
  const bytes=readFileSync(local(path));expect(bytes.length).toBeLessThanOrEqual(max);return bytes;
}}));
vi.mock("../hosted-dependency-materialization",()=>({hostedDependencyObservationLimits:{maxEntries:128,maxTotalBytes:65536,maxManifestBytes:65536,maxDurationMs:30000},
  readHostedDependencyKeyInputs:async()=>{f.keys++;return {key:{installKey:hash(readFileSync(join(f.root,"package.json")))}};},
  sameHostedDependencyKeyInputs:(a:{key:{installKey:string}},b:{key:{installKey:string}})=>a.key.installKey===b.key.installKey,
}));
vi.mock("../hosted-dependency-manifest-placement",()=>({openHostedDependencyManifestPlacement:async()=>{
  const s=await LocalDependencyManifestBlobStore.open({rootPath:f.blobs,maxManifestBytes:65536,maxStoredBytes:1048576,maxBlobs:8});
  return {get:(v:string)=>s.get(v),close:()=>s.close(),assertCurrent:()=>{throw Error("TEST unexpected publication fence");}};
}}));
vi.mock("../hosted-readonly-host-kernel",()=>({HostedReadonlyHostKernel:class{},readHostedReadonlyHostInventory:()=>({units:[]})}));
vi.mock("../hosted-dependency-installer-recipe",()=>({get hostedDependencyInstallerRoot(){return f.installers;}}));
vi.mock("../hosted-dependency-reference-veto",()=>({DependencyReferenceEffect:{Eviction:"eviction"},assertHostedDependencyReferenceVeto:()=>{f.vetoes++;}}));
vi.mock("../hosted-readonly-custody",async original=>({...await original<typeof import("../hosted-readonly-custody")>(),createReadonlyPrivateRecord:()=>{f.publishes++;throw Error("TEST unexpected record publication");}}));
vi.mock("../../worker-local/dependency-environment/observe-dependency-tree",async original=>{
  const actual=await original<typeof import("../../worker-local/dependency-environment/observe-dependency-tree")>();return {...actual,
    observeDependencyDirectoryRoot:async(...args:Parameters<typeof actual.observeDependencyDirectoryRoot>)=>{
      const result=await actual.observeDependencyDirectoryRoot(...args);f.observed.push({status:result.status,digest:result.status===Observed.Complete?result.digest:null});return result;
    }};
});
import { recoverHostedDependencyEviction } from "../hosted-dependency-transactions";
async function identity(path:string):Promise<DependencyWorkspaceIdentity>{const s=lstatSync(path,{bigint:true});return {canonicalPath:path,dev:String(s.dev),ino:String(s.ino)};}
async function fixture(both:boolean){
  f.root=await realpath(await mkdtemp(join(tmpdir(),"TEST-current-eviction-recovery-")));
  for(const name of ["owners","receipts","blobs","trash","installers","workspace"]){await mkdir(join(f.root,name),{mode:0o700});}
  f.owners=join(f.root,"owners");f.receipts=join(f.root,"receipts");f.blobs=join(f.root,"blobs");f.trash=join(f.root,"trash");f.installers=join(f.root,"installers");
  f.op=randomUUID();f.header=join(f.root,"header.json");f.renamed=join(f.root,"renamed.json");
  const workspace=await identity(join(f.root,"workspace")),source=join(workspace.canonicalPath,"node_modules");await mkdir(source,{mode:0o750});
  await writeFile(join(source,"opaque"),Buffer.from([0,255,1,128,10]),{mode:0o640});await chmod(join(source,"opaque"),0o640);
  for(const name of ["source","state","output","credentials"])await writeFile(join(f.root,name),enc({TEST:name}),{mode:0o600});
  await writeFile(join(f.root,"package.json"),enc({name:"TEST-recovery",private:true}),{mode:0o600});f.key=hash(readFileSync(join(f.root,"package.json")));
  f.binding={version:2,jobId:"TEST-recovery",jobRootDir:f.root,workspace,installationId:randomUUID(),runtimeSha:"a".repeat(40),grantDigest:"b".repeat(64),
    toolProfile:{version:1,profileId:DependencyToolProfileId.ViteVitestConfigFreeV1,pins:dependencyToolPins,cache:await identity(f.root),
      node:{path:join(f.root,"package.json"),sha256:f.key},helper:{path:join(f.root,"package.json"),sha256:f.key},readonlyFiles:[],testFiles:[],
      optimizerDependencies:[],transformCache:DependencyToolTransformCache.Temporary}};
  const observed=await observeDependencyTree({workspacePath:workspace.canonicalPath,treeName:"node_modules",limits});expect(observed.status).toBe(Observed.Complete);
  if(observed.status!==Observed.Complete)throw Error("TEST incomplete original physical tree");
  const blobs=await LocalDependencyManifestBlobStore.open({rootPath:f.blobs,maxManifestBytes:65536,maxStoredBytes:1048576,maxBlobs:8});try{await blobs.put(observed.canonicalBytes);}finally{await blobs.close();}
  const generation=randomUUID(),coverageRevision=hash(enc(selected())),base={version:1 as const,generation,workspace,coverageRevision};
  const sourceBinding=join(f.root,"source-binding.json");await writeFile(sourceBinding,enc({TEST:"projected upstream local completion/source history"}),{mode:0o600});
  const s=receipts();let ready:Extract<DependencyReceipt,{state:State.Ready}>;
  try{s.compareAndSwap(workspace,null,{...base,revision:1,state:State.Installing,operationId:generation,requestedKey:f.key,
    preservation:{kind:Preserve.KnownFreshAbsence,generation,workspace,coverageRevision,operationId:generation,absenceEvidenceId:"TEST-projected-prior-absence"}});
    ready={...base,revision:2,state:State.Ready,installKey:f.key,tree:observed.tree,manifestDigest:observed.digest,
      provenance:{kind:Proof.CompletedLocalInstallV1,generation,workspace,coverageRevision,installKey:f.key,tree:observed.tree,manifestDigest:observed.digest,
        operationId:generation,verificationEvidenceId:observed.digest,installerDrainEvidenceId:"c".repeat(64),sourceBinding:pin(sourceBinding)}};
    s.compareAndSwap(workspace,1,ready);
    const o=owners();try{
      const consumer=claimDependencyConsumer(o,workspace,{installationId:selected().installationId,runtimeSha:selected().runtimeSha,grantDigest:selected().grantDigest,
        bootId:"00000000-0000-4000-8000-000000000002",startId:randomUUID(),unit:"TEST-projected-current.service"},generation);
      for(const name of ["baseline","barrier"])await writeFile(join(f.root,name+".json"),enc({TEST:name}),{mode:0o600});
      const current=o.read(workspace)!;o.compareAndSwap(workspace,current.revision,{...current,version:2,revision:current.revision+1,
        generationContinuity:{version:1,kind:Continuity.BaselineAuthenticatedV1,operationId:generation,generation,readyRevision:2,
          previousReady:s.getCommittedReady(workspace,2).reference,baseline:pin(join(f.root,"baseline.json")),writerBarrier:pin(join(f.root,"barrier.json"))}});
      fenceDependencyConsumer(o,workspace,consumer);const fenced=o.read(workspace)!;o.compareAndSwap(workspace,fenced.revision,{...fenced,revision:fenced.revision+1,owner:null});
      f.attempt=claimDependencyMaintenance(o,workspace,{installationId:selected().installationId,runtimeSha:selected().runtimeSha,grantDigest:selected().grantDigest,
        bootId:"00000000-0000-4000-8000-000000000002",inventoryDigest:"c".repeat(64),supervisorId:"123:456"},f.op);
      const trash={operationId:f.op,originalTree:observed.tree,destinationParent:await identity(f.trash),destinationName:"dependency-"+f.op};
      s.compareAndSwap(workspace,2,{...base,revision:3,state:State.Evicting,operationId:f.op,installKey:f.key,tree:observed.tree,manifestDigest:observed.digest,trash});
      const claimed=o.read(workspace)!;if(claimed.version===1 || claimed.generationContinuity?.kind!==Continuity.BaselineAuthenticatedV1)throw Error("TEST missing actual baseline CAS");
      o.compareAndSwap(workspace,claimed.revision,{...claimed,revision:claimed.revision+1,generationContinuity:{...claimed.generationContinuity,
        kind:Continuity.RetiredEvictingV1,operationId:f.op,evictingRevision:3,retiredEvicting:s.getCommittedEvicting(workspace,3).reference}});
      const header={version:1,attempt:f.attempt,ready,trash};await writeFile(f.header,enc(header),{mode:0o600});
      const target=join(f.trash,trash.destinationName);await rename(source,target);expect(await identity(target)).toMatchObject(observed.tree);
      if(both){await mkdir(source);await writeFile(join(source,"unknown"),Buffer.from([255,2,0]),{mode:0o600});}
      await writeFile(f.renamed,enc({version:2,operationId:f.op,workspace,epoch:f.attempt.epoch,tree:observed.tree,trash,manifestDigest:observed.digest,
        headerSha256:both?hash(enc(header)):"0".repeat(64),sourceBinding:ready.provenance.kind===Proof.CompletedLocalInstallV1?ready.provenance.sourceBinding:null}),{mode:0o600});
      return {workspace,source,target,tree:observed.tree,manifestDigest:observed.digest};
    }finally{o.close();}
  }finally{s.close();}
}
function snapshot(){
  const paths:string[]=[];function walk(path:string){paths.push(path);if(lstatSync(path).isDirectory())for(const name of readdirSync(path).sort())walk(join(path,name));}
  walk(f.root);return paths.map(path=>{const s=lstatSync(path,{bigint:true});return {path,dev:String(s.dev),ino:String(s.ino),mode:String(s.mode),
    uid:String(s.uid),gid:String(s.gid),nlink:String(s.nlink),bytes:s.isDirectory()?null:readFileSync(path)};});
}
describe.skipIf(process.platform!=="linux" || process.getuid?.()!==0)("current recovery real negative predicates, projected upstream authority",()=>{
  // Regression: current recovery treats two physical roots as an interrupted
  // rename it may repair, deleting/renaming unknown bytes or releasing owner.
  it("reaches current both-roots conflict with real Evicting and preserves every file and held owner",async()=>{
    await check(true);
  });
  // Regression: current recovery accepts changed retained renamed evidence after
  // real detached Complete observation, publishing Absent or releasing owner.
  it("reaches changed renamed-v2 evidence after real complete trash observation without publication",async()=>{
    await check(false);
  });
});
async function check(both:boolean){
  try{const x=await fixture(both);const before=snapshot();
    f.authorityReads=f.maintenanceReads=f.sourceHistoryReads=f.sourceAdmissions=f.keys=f.publishes=f.releases=f.renames=f.vetoes=f.evidenceReads=0;f.observed=[];
    await expect(recoverHostedDependencyEviction(selected().jobId)).rejects.toThrow("dependency_transaction_unresolved");
    expect(f.authorityReads).toBeGreaterThan(1);expect(f.maintenanceReads).toBeGreaterThan(0);expect(f.sourceHistoryReads).toBe(3);expect(f.sourceAdmissions).toBe(2);
    expect(f.keys).toBe(both?0:2);expect(f.observed).toEqual(both?[]:[{status:Observed.Complete,digest:x.manifestDigest}]);
    expect(f.evidenceReads).toBe(both?0:1);expect(f.vetoes).toBe(both?0:1);
    expect([f.publishes,f.releases,f.renames]).toEqual([0,0,0]);expect(snapshot()).toEqual(before);
    expect(await identity(x.target)).toMatchObject(x.tree);expect(existsSync(x.source)).toBe(both);
    const o=owners(),s=receipts();try{expect(o.read(x.workspace)?.owner).not.toBeNull();expect(s.read(x.workspace)?.state).toBe(State.Evicting);}finally{o.close();s.close();}
  }finally{if(f.root)await rm(f.root,{recursive:true,force:true});}
}
