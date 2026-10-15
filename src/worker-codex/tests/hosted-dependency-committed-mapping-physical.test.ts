/** Original preservation runner + production prepared/committed mapping reader,
 * real opaque rename and owner CAS. Only native permission/path placement is
 * projected. Linux ROOT is required by the actual preservation adapter. */
import { randomUUID, createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { claimDependencyMaintenance, assertDependencyMaintenance, releaseDependencyMaintenance, claimDependencyConsumer,
  DependencyReceiptState as State, DependencyUnverifiedReason as Reason, type DependencyWorkspaceIdentity } from "../../worker-core/index";
import { LocalDependencyOwnerStore } from "../../store-local-file/dependency-environment/local-dependency-owner-store";
import { LocalDependencyReceiptStore } from "../../store-local-file/dependency-environment/local-dependency-receipt-store";
import { HostedDependencyPreservationRequestKind, HostedDependencyPreservationLineageKind, type HostedDependencyPreservationSelection } from "../hosted-dependency-preservation-selection";
import type { DependencyCommittedUnverifiedReceipt } from "../../worker-core/dependency-environment/ports/dependency-receipt-store";
const f=vi.hoisted(()=>({root:"",prefix:"",quarantine:"",owners:"",access:Symbol("TEST original issuer"),
  selection:undefined as HostedDependencyPreservationSelection|undefined,retired:undefined as DependencyCommittedUnverifiedReceipt|undefined,
  tamper:false,releases:0,begins:0}));
const virtualRoot="/var/lib/subscription-runtime-host-policy/dependency-preservation/";
function local(path:string){return path.startsWith(virtualRoot)?f.prefix+path.slice(path.indexOf(".prepared.json")>=0?path.indexOf(".prepared.json"):path.indexOf(".committed.json")):path;}
function encode(v:unknown){return Buffer.from(JSON.stringify(v)+"\n");}
function hash(v:Uint8Array){return createHash("sha256").update(v).digest("hex");}
function pin(path:string){const bytes=readFileSync(local(path)),s=lstatSync(local(path),{bigint:true});return {bytes,reference:{path,identity:{dev:String(s.dev),ino:String(s.ino)},sha256:hash(bytes)}};}
function owners(){return LocalDependencyOwnerStore.open({rootPath:f.owners,maxRecordBytes:16384});}
function assertOwner(){const s=owners();try{const selected=f.selection!,owner=selected.claimedOwner.owner;if(!owner || !("operationId" in owner.attempt))throw Error("TEST original owner missing");assertDependencyMaintenance(s,selected.binding.workspace,owner.attempt);}finally{s.close();}}
vi.mock("../hosted-dependency-preservation-selection",()=>({
  HostedDependencyPreservationRequestKind:{ExplicitReinstallation:"explicit_reinstallation"},
  HostedDependencyPreservationLineageKind:{OrdinaryUnverified:"ordinary_unverified"},
}));
vi.mock("../hosted-current-dependency-origin",()=>({assertOriginalHostedDependencyPhysicalRecordAccess:(access:symbol)=>{if(access!==f.access)throw Error("TEST foreign caller");}}));
vi.mock("../../provider-codex/app-server/adapters/hosted-process-activation",()=>({assertHostedActivationFence:()=>{},withHostedActivationFence:(fn:(v:unknown)=>unknown)=>fn({held:true})}));
vi.mock("../hosted-dependency-preservation-operator",()=>({
  beginOriginalHostedDependencyPreservation:()=>{f.begins++;assertOwner();return f.selection;},assertOriginalHostedDependencyPreservation:assertOwner,
  readOriginalHostedDependencyPreservationRetired:()=>f.retired,isOriginalHostedDependencyPreservationReleased:()=>false,
  readOriginalHostedDependencyPreservationDischargedUnits:()=>["TEST-projected-old.service"],
  releaseOriginalHostedDependencyPreservation:()=>{const s=owners();try{const selected=f.selection!,owner=selected.claimedOwner.owner;if(!owner || !("operationId" in owner.attempt))throw Error("TEST missing maintenance");releaseDependencyMaintenance(s,selected.binding.workspace,owner.attempt);f.releases++;}finally{s.close();}},
}));
vi.mock("../hosted-dependency-materialization",()=>({hostedDependencyObservationLimits:{maxEntries:128,maxTotalBytes:65536,maxManifestBytes:65536,maxDurationMs:30000}}));
vi.mock("../hosted-dependency-reference-veto",()=>({DependencyReferenceEffect:{Eviction:"eviction"},assertHostedDependencyReferenceVeto:()=>{}}));
vi.mock("../hosted-readonly-host-kernel",()=>({readHostedReadonlyHostInventory:()=>({units:[]})}));
vi.mock("../hosted-dependency-scratch-layout",()=>({readHostedDependencyScratchLayout:()=>({quarantine:f.quarantine})}));
vi.mock("../hosted-readonly-inputs",()=>({readHostedPrivateBytes:(path:string)=>existsSync(local(path))?readFileSync(local(path)):null}));
vi.mock("../hosted-readonly-custody",()=>({createReadonlyPrivateRecord:(path:string,bytes:Buffer)=>{
  path=local(path);if(existsSync(path)){if(!readFileSync(path).equals(bytes))throw Error("TEST immutable mapping conflict");return;}writeFileSync(path,bytes,{mode:0o600,flag:"wx"});
}}));
vi.mock("../hosted-dependency-legacy-reference-records",()=>({encodeReference:encode,pinReferenceFile:pin}));
vi.mock("../hosted-dependency-receipts",()=>({dependencyCoverageRevision:(b:unknown)=>hash(encode(b)),readHostedDependencyCommittedUnverified:()=>f.retired}));
vi.mock("../../worker-local/dependency-environment/dependency-tree-effects",async original=>{
  const actual=await original<typeof import("../../worker-local/dependency-environment/dependency-tree-effects")>();return {...actual,
    openDependencyTreePreservation:async(...args:Parameters<typeof actual.openDependencyTreePreservation>)=>{const operation=await actual.openDependencyTreePreservation(...args);return {...operation,close:async()=>{
      const result=await operation.close();if(f.tamper){f.tamper=false;const path=f.prefix+".committed.json",value=JSON.parse(readFileSync(path,"utf8")) as Record<string,unknown>;
        writeFileSync(path,encode({...value,inventoryDigest:"0".repeat(64)}));}return result;
    }};}};
});
import { runOriginalHostedDependencyPreservation } from "../hosted-dependency-preservation-effect";
import { readHostedDependencyCommittedPreservation } from "../hosted-dependency-preservation";
async function identity(path:string):Promise<DependencyWorkspaceIdentity>{const s=lstatSync(path,{bigint:true});return {canonicalPath:path,dev:String(s.dev),ino:String(s.ino)};}
describe.skipIf(process.platform!=="linux" || process.getuid?.()!==0)("original committed mapping physical refusal, projected native authority",()=>{
  // Regression: a rename/destination existence is mistaken for a valid mapping
  // and releases original owner or repairs an unknown commit during recovery.
  it("fences original owner across tampered committed mapping after opaque inode rename",async()=>{
    const root=await realpath(await mkdtemp(join(tmpdir(),"TEST-mapping-physical-")));f.root=root;f.prefix=join(root,"mapping");f.quarantine=join(root,"quarantine");f.owners=join(root,"owners");
    const workspacePath=join(root,"workspace"),treePath=join(workspacePath,"node_modules"),receiptRoot=join(root,"receipts");
    for(const path of [f.quarantine,f.owners,workspacePath,receiptRoot])await mkdir(path,{mode:0o700});await mkdir(treePath);
    const opaque=Buffer.from([0,255,254,13,10]),rawName=Buffer.concat([Buffer.from(treePath+"/"),Buffer.from([0xff,0xfe])]);
    await writeFile(rawName,opaque,{mode:0o751});await symlink("../missing-TEST-target",join(treePath,"unknown-link"));await writeFile(join(workspacePath,"source"),"TEST authored source\n");
    const workspace=await identity(workspacePath),tree=await identity(treePath),operationId=randomUUID(),installationId=randomUUID();
    const binding:HostedDependencyPreservationSelection["binding"]={version:1,jobId:"TEST-mapping",jobRootDir:root,workspace,installationId,runtimeSha:"a".repeat(40),grantDigest:"b".repeat(64)};
    const store=owners(),receipts=LocalDependencyReceiptStore.open({rootPath:receiptRoot,maxRecordBytes:16384,maxHistorySteps:16});
    try{
      claimDependencyMaintenance(store,workspace,{installationId,runtimeSha:binding.runtimeSha,grantDigest:binding.grantDigest,bootId:randomUUID(),inventoryDigest:"c".repeat(64),supervisorId:"123:456"},operationId);
      const claimedOwner=store.read(workspace)!;
      receipts.compareAndSwap(workspace,null,{version:1,revision:1,generation:randomUUID(),workspace,coverageRevision:hash(encode(binding)),state:State.Unverified,reason:Reason.BaselineMissing,tree:{dev:tree.dev,ino:tree.ino}});f.retired=receipts.getCommittedUnverified(workspace,1);
      f.selection={version:1,kind:HostedDependencyPreservationRequestKind.ExplicitReinstallation,operationId,binding,claimedOwner,
        destinationParent:await identity(f.quarantine),sourceTree:{dev:tree.dev,ino:tree.ino},
        prior:{owner:{...claimedOwner,owner:null},receipt:f.retired},
        lineage:{kind:HostedDependencyPreservationLineageKind.OrdinaryUnverified,start:f.retired.reference,final:f.retired.reference}};
      const originalOwner=store.read(workspace),originalReceipt=receipts.read(workspace);f.releases=0;f.begins=0;f.tamper=true;
      await expect(runOriginalHostedDependencyPreservation("TEST-mapping",false,f.access)).rejects.toThrow("hosted_dependency_preservation_held");
      const target=join(f.quarantine,"dependency-"+operationId),commit=readFileSync(f.prefix+".committed.json"),prepared=readFileSync(f.prefix+".prepared.json");
      expect(existsSync(treePath)).toBe(false);expect(await identity(target)).toEqual({...tree,canonicalPath:target});
      const retainedName=Buffer.concat([Buffer.from(target+"/"),Buffer.from([0xff,0xfe])]);expect(readFileSync(retainedName)).toEqual(opaque);expect(lstatSync(retainedName).mode&0o777).toBe(0o751);
      expect(()=>readHostedDependencyCommittedPreservation(binding,f.retired!.receipt,randomUUID())).toThrow("hosted_dependency_preservation_held");
      await expect(runOriginalHostedDependencyPreservation("TEST-mapping",true,f.access)).rejects.toThrow();
      expect(store.read(workspace)).toEqual(originalOwner);expect(receipts.read(workspace)).toEqual(originalReceipt);expect(f.releases).toBe(0);expect(f.begins).toBe(2);
      expect(()=>claimDependencyConsumer(store,workspace,{installationId,bootId:randomUUID(),runtimeSha:binding.runtimeSha,grantDigest:binding.grantDigest,startId:randomUUID(),unit:"TEST-new-consumer.service"},randomUUID())).toThrow("busy");
      expect(store.read(workspace)).toEqual(originalOwner);expect(readFileSync(f.prefix+".committed.json")).toEqual(commit);expect(readFileSync(f.prefix+".prepared.json")).toEqual(prepared);
      expect(await identity(target)).toEqual({...tree,canonicalPath:target});expect(readFileSync(retainedName)).toEqual(opaque);expect(readFileSync(join(workspacePath,"source"),"utf8")).toBe("TEST authored source\n");
    }finally{store.close();receipts.close();await rm(root,{recursive:true,force:true});}
  });
});
