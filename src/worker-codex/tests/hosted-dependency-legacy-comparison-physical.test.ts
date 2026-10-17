/** Real comparison orchestration/FD walking and local durable adapters.
 * Original host enrollment/reference launch facts are projected: no native grant,
 * authentic ordinary installation or native closure is established by this file. */
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { claimDependencyMaintenance, assertDependencyMaintenance, releaseDependencyMaintenance,
  DependencyReceiptState as State, DependencyInstallProofKind as Proof, DependencyPreservationKind as Preserve,
  DependencyUnverifiedReason as Reason, DependencyTreeObservationStatus as Observed,
  type DependencyReceipt, type DependencyMaintenanceAttempt, type DependencyWorkspaceIdentity } from "../../worker-core/index";
import { LocalDependencyOwnerStore } from "../../store-local-file/dependency-environment/local-dependency-owner-store";
import { LocalDependencyReceiptStore } from "../../store-local-file/dependency-environment/local-dependency-receipt-store";
import { LocalDependencyManifestBlobStore } from "../../store-local-file/dependency-environment/local-dependency-manifest-blob-store";
import { observeDependencyTree } from "../../worker-local/dependency-environment/observe-dependency-tree";
import { HostedDependencyInstallerRecipe as Recipe } from "../hosted-dependency-installer-inputs";
import { HostedDependencyReferenceKind, type HostedDependencyBinding } from "../../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { DependencyNpmLockName, DependencyInstallArchitecture, DependencyLibcFamily, DependencyToolRootKind,
  type DependencyTestNpmToolchain } from "../../worker-core/dependency-environment/domain/dependency-install-key";
import { captureNpmInstallInputs, revalidateNpmInstallInputs, NpmInputCaptureStatus,
  type QualifiedNpmInstallInputs } from "../../worker-local/dependency-environment/capture-npm-install-inputs";
import { buildTestNpmDependencyInstallKey } from "../../worker-local/dependency-environment/build-test-npm-dependency-install-key";
const tools:DependencyTestNpmToolchain={nodePath:"/opt/node/bin/node",nodeSha256:"a".repeat(64),nodeVersion:"v22.18.0",nodeAbi:"127",platform:"linux",arch:DependencyInstallArchitecture.X64,
  npmCliPath:"/opt/node/lib/node_modules/npm/bin/npm-cli.js",npmSha256:"b".repeat(64),npmVersion:"10.9.3",npmRootPath:"/opt/node/lib/node_modules/npm",npmRootSha256:"c".repeat(64),
  libc:{family:DependencyLibcFamily.Glibc,version:"2.36",path:"/usr/lib/libc.so.6",sha256:"d".repeat(64)},toolRoots:[{path:"/usr/lib/libc.so.6",sha256:"d".repeat(64),kind:DependencyToolRootKind.File}]};
const f=vi.hoisted(()=>({root:"",owners:"",receipts:"",blobs:"",op:"",bindings:new Map<string,HostedDependencyBinding>(),
  claims:new Map<string,DependencyMaintenanceAttempt>(),result:undefined as unknown,relation:undefined as unknown,launched:0,closed:0}));
const limits={maxEntries:128,maxTotalBytes:65536,maxManifestBytes:65536,maxDurationMs:30000};
function enc(v:unknown){return Buffer.from(JSON.stringify(v)+"\n");}
function hash(v:Uint8Array){return createHash("sha256").update(v).digest("hex");}
function binding(job:string){const b=f.bindings.get(job);if(!b)throw Error("TEST missing enrollment");return b;}
function ownerStore(){return LocalDependencyOwnerStore.open({rootPath:f.owners,maxRecordBytes:16384});}
function receipts(){return LocalDependencyReceiptStore.open({rootPath:f.receipts,maxRecordBytes:16384,maxHistorySteps:32});}
function coverage(b:HostedDependencyBinding){return hash(enc(b));}
function pin(path:string){const bytes=readFileSync(path),s=lstatSync(path,{bigint:true});return {bytes,reference:{path,identity:{dev:String(s.dev),ino:String(s.ino)},sha256:hash(bytes)}};}
function ref(name:string){return pin(join(f.root,name)).reference;}
vi.mock("../../provider-codex/app-server/adapters/hosted-process-activation",()=>({withHostedActivationFence:(fn:(v:unknown)=>unknown)=>fn({held:true}),assertHostedActivationFence:()=>{}}));
vi.mock("../hosted-installation-activation",()=>({HostedInstallationActivationStore:class{dependencyMaintenanceAuthority(_f:unknown,job:string){return {binding:binding(job)};}}}));
vi.mock("../../provider-codex/app-server/adapters/hosted-dependency-workspace",async original=>({...await original<typeof import("../../provider-codex/app-server/adapters/hosted-dependency-workspace")>(),get hostedDependencyOwnerRoot(){return f.owners;}}));
vi.mock("../hosted-dependency-transactions",()=>({
  claimHostedDependencyComparisonMaintenance:(job:string,operationId:string)=>{const s=ownerStore();try{const b=binding(job),existing=f.claims.get(job);if(existing){assertDependencyMaintenance(s,b.workspace,existing);return existing;}
    const attempt=claimDependencyMaintenance(s,b.workspace,{installationId:b.installationId,runtimeSha:b.runtimeSha,grantDigest:b.grantDigest,
      bootId:"00000000-0000-4000-8000-000000000002",inventoryDigest:"c".repeat(64),supervisorId:"123:456"},operationId);f.claims.set(job,attempt);return attempt;}finally{s.close();}},
  assertHostedDependencyComparisonMaintenanceUnderFence:(_f:unknown,job:string,attempt:DependencyMaintenanceAttempt)=>{const s=ownerStore();try{assertDependencyMaintenance(s,binding(job).workspace,attempt);}finally{s.close();}},
  assertHostedDependencyComparisonQuiescent:()=>{},
}));
// Project protected namespace selection only; receipt CAS/history is real.
vi.mock("../hosted-dependency-receipts",()=>({dependencyCoverageRevision:coverage,
  readHostedDependencyReceipt:(b:HostedDependencyBinding)=>{const s=receipts();try{return s.read(b.workspace);}finally{s.close();}},
  publishHostedDependencyReceipt:(b:HostedDependencyBinding,r:number|null,next:DependencyReceipt)=>{const s=receipts();try{return s.compareAndSwap(b.workspace,r,next);}finally{s.close();}},
  readHostedDependencyCommittedUnverified:(b:HostedDependencyBinding,r:number)=>{const s=receipts();try{return s.getCommittedUnverified(b.workspace,r);}finally{s.close();}},
  readHostedDependencyCommittedReady:(b:HostedDependencyBinding,r:number)=>{const s=receipts();try{return s.getCommittedReady(b.workspace,r);}finally{s.close();}},
}));
// Project protected profile/namespace selection; real leaf input FD capture,
// revalidation and canonical complete-key calculation remain production code.
function key(capture:QualifiedNpmInstallInputs){return buildTestNpmDependencyInstallKey({packageBytes:capture.packageBytes,lockBytes:capture.lockBytes,lockName:capture.lockName,toolchain:tools,maxInputBytes:16384,maxCanonicalBytes:16384});}
async function inputs(b:HostedDependencyBinding){
  const capture=await captureNpmInstallInputs({workspacePath:b.workspace.canonicalPath,expectedWorkspace:b.workspace,maxInputBytes:16384,maxDurationMs:30000});
  if(capture.status!==NpmInputCaptureStatus.Qualified)throw Error("TEST real input capture refused");
  return {recipe:Recipe.NpmRegistryNoScriptsV1,capture,key:key(capture)};
}
vi.mock("../hosted-dependency-materialization",()=>({
  hostedDependencyObservationLimits:{maxEntries:128,maxTotalBytes:65536,maxManifestBytes:65536,maxDurationMs:30000},
  readHostedDependencyKeyInputs:inputs,
  assertHostedDependencyKeyInputsCurrent:(_b:HostedDependencyBinding,v:Awaited<ReturnType<typeof inputs>>)=>{
    if(revalidateNpmInstallInputs({capture:v.capture,maxDurationMs:30000}).status!==NpmInputCaptureStatus.Qualified || key(v.capture).installKey!==v.key.installKey)throw Error("TEST actual inputs drifted");
  },
}));
vi.mock("../hosted-dependency-manifest-placement",()=>({openHostedDependencyManifestPlacement:async()=>{
  const s=await LocalDependencyManifestBlobStore.open({rootPath:f.blobs,maxManifestBytes:65536,maxStoredBytes:1048576,maxBlobs:8});
  return {put:(v:Uint8Array)=>s.put(v),close:()=>s.close(),assertCurrent:()=>{}};
}}));
vi.mock("../hosted-dependency-legacy-reference",()=>({
  prepareHostedLegacyReference:async()=>{const s=receipts();try{f.relation={candidate:{original:s.getCommittedUnverified(binding("candidate").workspace,1)},inputs:{inputSha256:"d".repeat(64),profileSha256:"e".repeat(64)}};}finally{s.close();}return ref("relation.json");},
  assertHostedLegacyReferenceSourcesCurrent:()=>{},closeHostedLegacyReferencePreparation:()=>{f.closed=1;},
}));
vi.mock("../hosted-readonly-host-kernel",()=>({readHostedReadonlyHostInventory:()=>({ordinaryCreators:[{jobId:"reference",launch:{command:"TEST-projected-reference",args:[],cwd:f.root}}]})}));
vi.mock("../hosted-readonly-foreground",()=>({runHostedRuntimeForeground:async()=>{f.launched++;const s=ownerStore();try{releaseDependencyMaintenance(s,binding("reference").workspace,f.claims.get("reference")!);f.claims.delete("reference");}finally{s.close();}return 0;}}));
vi.mock("../hosted-foreground-result",()=>({hostedForegroundExitCode:(v:number)=>v}));
vi.mock("../hosted-dependency-legacy-reference-records",()=>({encodeReference:enc,referenceFailure:()=>{throw Error("TEST reference unresolved");},
  readReferenceRelation:()=>({value:f.relation}),referencePath:(_op:string,name:string)=>join(f.root,name+".json"),pinReferenceFile:pin,
  parseReferenceResult:(v:unknown)=>v,writeReferenceOnce:()=>{throw Error("TEST unexpected Ready comparison");},
}));
vi.mock("../hosted-dependency-legacy-reference-history",()=>({readHostedDependencyLegacyReferenceHistory:()=>({result:f.result,refs:{referenceRelease:ref("reference-release.json")}})}));
import { compareHostedLegacyDependency, HostedLegacyComparisonOutcome as Outcome } from "../hosted-dependency-legacy-comparison";
async function identity(path:string):Promise<DependencyWorkspaceIdentity>{const s=lstatSync(path,{bigint:true});return {canonicalPath:path,dev:String(s.dev),ino:String(s.ino)};}
async function fixture(kind:"content"|"mode"|"external"){
  f.root=await realpath(await mkdtemp(join(tmpdir(),"TEST-legacy-comparison-physical-")));f.owners=join(f.root,"owners");f.receipts=join(f.root,"receipts");f.blobs=join(f.root,"blobs");
  for(const path of [f.owners,f.receipts,f.blobs])await mkdir(path,{mode:0o700});f.op=randomUUID();f.bindings.clear();f.claims.clear();f.launched=0;f.closed=0;
  const installationId=randomUUID();
  for(const job of ["candidate","reference"]){const path=join(f.root,job);await mkdir(path);await mkdir(join(path,"node_modules"));
    await writeFile(join(path,"node_modules","module.js"),job==="candidate"&&kind==="content"?"unknown authored content\n":"pristine installed bytes\n",{mode:0o644});
    await chmod(join(path,"node_modules","module.js"),job==="candidate"&&kind==="mode"?0o755:0o644);
    for(const name of ["source","state","output","credentials"])await writeFile(join(path,name),"TEST "+name+" sentinel\n");
    const pkg={name:"test-legacy-physical",version:"1.0.0",dependencies:{sample:"1.0.0"}};
    await writeFile(join(path,"package.json"),enc(pkg));
    await writeFile(join(path,"package-lock.json"),enc({name:pkg.name,version:pkg.version,lockfileVersion:3,requires:true,packages:{"":pkg,"node_modules/sample":{version:"1.0.0",resolved:"https://registry.npmjs.org/sample/-/sample-1.0.0.tgz",integrity:`sha512-${"A".repeat(86)}==`}}}));
    const common={jobId:job,jobRootDir:path,workspace:await identity(path),installationId,runtimeSha:"a".repeat(40),grantDigest:"b".repeat(64)};
    // Selection is the explicit projected enrollment boundary. No parse/grant assertion is claimed.
    f.bindings.set(job,(job==="candidate"?{...common,version:1}:{...common,version:3,reference:{kind:HostedDependencyReferenceKind.LegacyRegistryV1,operationId:f.op}}));
  }
  if(kind==="external")await symlink(join(f.root,"candidate","source"),join(f.root,"candidate","node_modules","external"));
  for(const name of ["relation.json","reference-release.json"])await writeFile(join(f.root,name),enc({TEST:name}),{mode:0o600});
  const b=binding("reference"),tree=await observeDependencyTree({workspacePath:b.workspace.canonicalPath,treeName:"node_modules",limits});
  if(tree.status!==Observed.Complete)throw Error("TEST reference physical observation incomplete");
  const generation=randomUUID(),key=(await inputs(b)).key.installKey,base={version:1 as const,generation,workspace:b.workspace,coverageRevision:coverage(b)};
  const s=receipts();try{s.compareAndSwap(b.workspace,null,{...base,revision:1,state:State.Installing,operationId:generation,requestedKey:key,
    preservation:{kind:Preserve.KnownFreshAbsence,generation,workspace:b.workspace,coverageRevision:coverage(b),operationId:generation,absenceEvidenceId:"TEST-projected-fresh-reference"}});
    s.compareAndSwap(b.workspace,1,{...base,revision:2,state:State.Ready,installKey:key,tree:tree.tree,manifestDigest:tree.digest,
      provenance:{kind:Proof.CompletedInstall,generation,workspace:b.workspace,coverageRevision:coverage(b),installKey:key,tree:tree.tree,manifestDigest:tree.digest,operationId:generation,verificationEvidenceId:"TEST-projected-install",installerDrainEvidenceId:"TEST-projected-drain"}});
    const committed=s.getCommittedReady(b.workspace,2);
    f.result={version:1,installKey:key,reference:{generation,coverageRevision:coverage(b),tree:tree.tree,manifestDigest:tree.digest,output:committed.reference}};
  }finally{s.close();}
  await writeFile(join(f.root,"reference-result.json"),enc(f.result),{mode:0o600});
  const originalTree=await identity(join(binding("candidate").workspace.canonicalPath,"node_modules"));
  const snapshots=(kind==="external"?["module.js","external"]:["module.js"]).map(name=>{
    const path=join(originalTree.canonicalPath,name),stat=lstatSync(path,{bigint:true});
    return {path,stat,bytes:stat.isSymbolicLink()?undefined:readFileSync(path),target:stat.isSymbolicLink()?readlinkSync(path):undefined};
  });
  return {originalTree,snapshots,async close(){await rm(f.root,{recursive:true,force:true});}};
}
describe.skipIf(process.platform!=="linux")("legacy comparison real temporary trees, projected host authority",()=>{
  // Regression: complete same-key differences accidentally normalize unknown
  // candidate bytes/mode, or publish Ready instead of the factual mismatch.
  it.each(["content","mode"] as const)("retains %s-only difference and commits only Unverified",async kind=>{
    const x=await fixture(kind);try{
      const result=await compareHostedLegacyDependency({candidateJobId:"candidate",referenceJobId:"reference",expectedRevision:null});
      expect(result.outcome).toBe(Outcome.Mismatch);expect(result).toMatchObject({held:false});expect(f.launched).toBe(1);expect(f.closed).toBe(1);
      const s=receipts();try{expect(s.read(binding("candidate").workspace)).toMatchObject({state:State.Unverified,reason:Reason.BaselineMissing,revision:1});}finally{s.close();}
      await unchanged(x);const owners=ownerStore();try{for(const job of ["candidate","reference"])expect(owners.read(binding(job).workspace)?.owner).toBeNull();}finally{owners.close();}
    }finally{await x.close();}
  });
  // Regression: an external link grants Complete/Ready or launches a reference
  // despite the physical walker being unable to establish a closed candidate.
  it("holds external-link candidate without launch, reset, or Ready",async()=>{
    const x=await fixture("external");try{
      const s=receipts();try{s.compareAndSwap(binding("candidate").workspace,null,{version:1,revision:1,generation:randomUUID(),workspace:binding("candidate").workspace,coverageRevision:coverage(binding("candidate")),state:State.Unverified,tree:{dev:x.originalTree.dev,ino:x.originalTree.ino},reason:Reason.BaselineMissing});}finally{s.close();}
      const before=receipts();let retained:DependencyReceipt|null;try{retained=before.read(binding("candidate").workspace);}finally{before.close();}
      expect(await compareHostedLegacyDependency({candidateJobId:"candidate",referenceJobId:"reference",expectedRevision:1})).toMatchObject({outcome:Outcome.Incomplete,held:true});expect(f.launched).toBe(0);
      const after=receipts();try{expect(after.read(binding("candidate").workspace)).toEqual(retained);}finally{after.close();}
      await unchanged(x);const owners=ownerStore();try{for(const job of ["candidate","reference"])expect(owners.read(binding(job).workspace)?.owner).not.toBeNull();}finally{owners.close();}
    }finally{await x.close();}
  });
});
async function unchanged(x:Awaited<ReturnType<typeof fixture>>){
  expect(await identity(x.originalTree.canonicalPath)).toEqual(x.originalTree);
  for(const old of x.snapshots){const now=lstatSync(old.path,{bigint:true});expect([now.dev,now.ino,now.mode]).toEqual([old.stat.dev,old.stat.ino,old.stat.mode]);if(old.target!==undefined)expect(readlinkSync(old.path)).toBe(old.target);else expect(readFileSync(old.path)).toEqual(old.bytes);}
  for(const name of ["source","state","output","credentials"])expect(readFileSync(join(binding("candidate").workspace.canonicalPath,name),"utf8")).toBe("TEST "+name+" sentinel\n");
}
