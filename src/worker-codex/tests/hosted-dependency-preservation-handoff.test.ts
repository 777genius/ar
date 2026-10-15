// Original stage facts are projected with the other protected ports in this composition test.
vi.mock("../../provider-codex/app-server/adapters/hosted-full-backing-stage",()=>({
  FullBackingInstallationContract:{OriginalParentProcV1:"original_full_parent_proc_v1"},
  readOriginalHostedDependencyBackingStage:()=>({schemaVersion:1,runtimeSha:"a".repeat(40)})}));
import { DependencyToolProfileId, DependencyToolTransformCache, dependencyToolPins } from "../../core/dependency-environment/dependency-tool-profile";
/** Portable orchestration/history projection only. Physical ownership/native
 * collectors are projected; actual Linux rename/fsync tests are separate. */
import { createHash } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { DependencyOwnerKind, DependencyOwnerPhase, DependencyGenerationContinuityKind, parseDependencyOwner,
  type DependencyOwnerRecord } from "../../core/index";
import { DependencyReceiptState as State, DependencyUnverifiedReason as Reason, DependencyInstallProofKind,
  type DependencyReceipt } from "../../worker-core/index";
const f=vi.hoisted(()=>({files:new Map<string,Buffer>(),receipts:new Map<number,unknown>(),owner:null as DependencyOwnerRecord|null,
  events:[] as string[],native:true,source:false,access:Symbol("TEST defining original"),failAfterCas:false}));
const root="/var/lib/subscription-runtime-host-policy",enc=(v:unknown)=>Buffer.from(JSON.stringify(v)+"\n"),hash=(b:Uint8Array)=>createHash("sha256").update(b).digest("hex");
const pin=(path:string)=>{const bytes=f.files.get(path);if(!bytes)throw Error("TEST missing protected record");return {bytes,reference:{path,identity:{dev:"7",ino:"25"},sha256:hash(bytes)}};};
vi.mock("node:fs",async original=>{const real=await original<typeof import("node:fs")>();return {...real,
  readdirSync:()=>[...f.files.keys()].filter(p=>p.startsWith(root+"/dependency-preservation/")).map(p=>p.slice(p.lastIndexOf("/")+1)),
  lstatSync:(path:string)=>{if(path.endsWith("/node_modules")){if(f.source)return {isDirectory:()=>true,isSymbolicLink:()=>false};throw Object.assign(Error("TEST absent"),{code:"ENOENT"});}
    return {dev:"7",ino:path.endsWith("dependency-quarantine")?"10":"11",uid:0n,mode:0o700n,isDirectory:()=>true};}};});
vi.mock("../hosted-readonly-inputs",()=>({readHostedPrivateBytes:(path:string)=>f.files.get(path)??null}));
vi.mock("../hosted-dependency-legacy-reference-records",()=>({pinReferenceFile:(path:string)=>pin(path),encodeReference:(v:unknown)=>enc(v),
  writeReferenceOnce:(path:string,value:unknown)=>{if(f.files.has(path))throw Object.assign(Error("TEST one-shot record"),{code:"EEXIST"});f.files.set(path,enc(value));}}));
vi.mock("../hosted-readonly-custody",async original=>({...await original<typeof import("../hosted-readonly-custody")>(),createReadonlyPrivateRecord:(path:string,bytes:Buffer)=>{const old=f.files.get(path);if(old&&!old.equals(bytes))throw Error("TEST immutable conflict");f.events.push("record:"+path.split(".").at(-2));f.files.set(path,bytes);}}));
vi.mock("../hosted-current-dependency-origin",()=>({CurrentHostedDependencyOriginKind:{Ordinary:"ordinary",ManagedReadonlyLocal:"readonly"},
  assertOriginalHostedDependencyPhysicalRecordAccess:(access:symbol)=>{if(access!==f.access)throw Error("TEST foreign lexical caller");},
  isHostedManagedReadonlyOuterRuntime:()=>false,enterCurrentHostedOrdinaryDependencyReader:()=>{},readCurrentHostedDependencyOrigin:()=>({TEST:"projected actual scope"}),
  assertCurrentHostedDependencyOrigin:()=>({kind:"ordinary",ordinary:{profileId:CodexProviderEgressProfileId.TestNpmQualification,start:{jobId:binding.jobId,jobRootDir:binding.jobRootDir,workspacePath:binding.workspace.canonicalPath,grantSha256:binding.grantDigest,installationId:binding.installationId},reservation:{startId:launch.startId}}}),
  consumeCurrentHostedOrdinaryDependencyExecution:()=>f.owner!.owner!.attempt,armCurrentHostedDependencyGenerationBarrier:()=>{},readHostedDependencyRootGitConfigPin:()=>{},
  assertCurrentHostedDependencyAttempt:()=>({binding,attempt:f.owner!.owner!.attempt}),markCurrentHostedDependencyGenerationRunning:()=>{f.events.push("running");}}));
vi.mock("../hosted-dependency-activation",()=>({withHostedActivationFence:(fn:(value:unknown)=>unknown)=>fn({held:true})}));
vi.mock("../hosted-installation-activation",()=>({isHostedOrdinaryRuntime:()=>true}));
vi.mock("../hosted-dependency-workspace",async original=>({...await original<typeof import("../hosted-dependency-workspace")>(),
  isHostedDependencyWorkspace:(path:string)=>path===binding.workspace.canonicalPath,readHostedDependencyBinding:()=>binding,
  assertHostedDependencyQualifiedInventory:()=>{},assertHostedDependencyPhysicalWorkspace:()=>{},assertHostedDependencyStartAllowed:()=>{}}));
vi.mock("../../provider-codex/app-server/adapters/hosted-dependency-workspace",async original=>({...await original<typeof import("../../provider-codex/app-server/adapters/hosted-dependency-workspace")>(),
  readHostedDependencyBinding:()=>binding,isHostedDependencyWorkspace:(path:string)=>path===binding.workspace.canonicalPath,
  assertHostedDependencyQualifiedInventory:()=>{},assertHostedDependencyPhysicalWorkspace:()=>{},assertHostedDependencyStartAllowed:()=>{}}));
vi.mock("../hosted-dependency-materialization",()=>({readHostedDependencyReceipt:()=>f.receipts.get(Math.max(...f.receipts.keys())),
  materializeHostedDependencyAbsenceForToolEntry:async()=>{f.events.push("installer-port");return {};},closeHostedDependencyColdHandoff:()=>{}}));
vi.mock("../hosted-dependency-tool-profile",()=>({qualifyHostedDependencyToolClosure:async()=>({TEST:"qualifier port"}),assertHostedDependencyQualifiedToolEntry:()=>{},markHostedDependencyQualifiedToolEntryRunning:()=>{}}));
vi.mock("../hosted-readonly-dependency-reader-entry",()=>({publishHostedReadonlyDependencyReaderReady:()=>{}}));
vi.mock("../hosted-dependency-root-preparation",()=>({prepareHostedDependencyRootHelpers:()=>{}}));
vi.mock("../../worker-local/dependency-environment/observe-dependency-tree",async original=>({...await original<typeof import("../../worker-local/dependency-environment/observe-dependency-tree")>(),observeDependencyTree:async()=>{f.events.push("inventory");throw Error("TEST unexpected inventory");}}));
vi.mock("../../provider-codex/app-server/adapters/hosted-process-activation",()=>({assertHostedActivationFence:()=>{}}));
vi.mock("../hosted-dependency-preservation-operator",()=>({readOriginalHostedDependencyPreservationHistory:()=>{f.events.push("history");}}));
vi.mock("../hosted-dependency-generation-native-census",()=>({readOriginalHostedDependencyOperatorNativeCensus:()=>{f.events.push("native");return f.native;}}));
vi.mock("../../store-local-file/dependency-environment/local-dependency-owner-store",()=>({LocalDependencyOwnerStore:class{
  static open(){return new this();}read(){return structuredClone(f.owner);}close(){}
  compareAndSwap(_w:unknown,revision:number,next:DependencyOwnerRecord){if(f.owner?.revision!==revision)throw Error("TEST stale owner");
    f.events.push("owner-cas");f.owner=parseDependencyOwner(next);if(f.failAfterCas){f.failAfterCas=false;throw Error("TEST crash after consumer CAS");}return f.owner;}}}));
vi.mock("../../store-local-file/dependency-environment/local-dependency-receipt-store",()=>({LocalDependencyReceiptStore:class{
  static open(){return new this();}getCommittedInstalling(_w:unknown,r:number){return {receipt:f.receipts.get(r),reference:{path:"/TEST/installing",identity:{dev:"7",ino:"30"},sha256:"d".repeat(64)}};}close(){}}}));
vi.mock("../hosted-dependency-receipts",()=>({dependencyCoverageRevision:()=>"c".repeat(64),hostedDependencyReceiptHistoryRoot:"/var/lib/subscription-runtime-host-policy/dependency-receipt-history",
  readHostedDependencyEstablishedReceipt:()=>f.receipts.get(Math.max(...f.receipts.keys()))??null,
  readHostedDependencyExistingCommittedReady:(_f:unknown,_b:unknown,r:number)=>committed(r),
  readHostedDependencyExistingCommittedUnverified:(_f:unknown,_b:unknown,r:number)=>committed(r),
  readHostedDependencyCommittedUnverified:(_b:unknown,r:number)=>committed(r)}));
import { HostedDependencyPreservationLineageKind as Kind, HostedDependencyPreservationRequestKind,
  hostedDependencyPreservationSelectionPath,hostedDependencyPreservationSelectionIndexPath,readHostedDependencyPreservationSelections,
  type HostedDependencyPreservationSelection } from "../hosted-dependency-preservation-selection";
import { readHostedDependencyPendingPreservations,assertHostedDependencyPreservationAdmission,readHostedDependencyCompletedPreservation } from "../hosted-dependency-preservation-handoff";
import { claimOriginalHostedDependencyPreservedConsumer } from "../hosted-dependency-preservation-consumer";
import { hostedDependencyPreservationPath,hostedDependencyPreservationCommit,readHostedDependencyPreparedPreservation,readHostedDependencyCommittedPreservation } from "../hosted-dependency-preservation";
import { gzipSync } from "node:zlib";
import { CodexProviderEgressProfileId } from "../../provider-codex/index";
import { admitHostedDependencyEntry } from "../hosted-dependency-admission";
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`,jobRoot=root+"/dependency-test-jobs/jobs/TEST-selection";
const binding={version:2 as const,jobId:"TEST-selection",jobRootDir:jobRoot,workspace:{canonicalPath:jobRoot+"/workspace",dev:"7",ino:"9"},installationId:id(1),runtimeSha:"a".repeat(40),grantDigest:"b".repeat(64),
  toolProfile:{version:1 as const,profileId:DependencyToolProfileId.ViteVitestConfigFreeV1,pins:dependencyToolPins,testFiles:["x.test.ts"],optimizerDependencies:["vite"],transformCache:DependencyToolTransformCache.Temporary,
    cache:{canonicalPath:jobRoot+"/tool-cache/"+DependencyToolProfileId.ViteVitestConfigFreeV1,dev:"7",ino:"41"},node:{path:"/TEST/node",sha256:"a".repeat(64)},helper:{path:"/TEST/0",sha256:"a".repeat(64)},readonlyFiles:Array.from({length:7},(_,n)=>({path:`/TEST/${n}`,sha256:"a".repeat(64)}))}};
const fence={held:true as const},tree={dev:"7",ino:"11"},launch={installationId:id(1),bootId:id(2),runtimeSha:binding.runtimeSha,grantDigest:binding.grantDigest,startId:id(10),unit:`subscription-runtime-ordinary-${id(10)}.service`};
let selection:HostedDependencyPreservationSelection,old:Extract<DependencyReceipt,{state:State.Ready}>,retired:Extract<DependencyReceipt,{state:State.Unverified}>;
function committed(r:number){const receipt=f.receipts.get(r);if(!receipt)throw Error("TEST missing committed receipt");return {receipt,reference:{path:`/TEST/receipt-${r}`,identity:{dev:"7",ino:String(100+r)},sha256:hash(enc(receipt))}};}
beforeEach(()=>{
  f.files.clear();f.receipts.clear();f.events=[];f.native=true;f.source=false;f.failAfterCas=false;
  const base={version:1 as const,generation:"TEST-old",workspace:binding.workspace,coverageRevision:"c".repeat(64)},proof={generation:base.generation,workspace:base.workspace,coverageRevision:base.coverageRevision,tree,installKey:"d".repeat(64),manifestDigest:"e".repeat(64)};
  old={...base,revision:2,state:State.Ready,...proof,provenance:{...proof,kind:DependencyInstallProofKind.CompletedInstall,operationId:"TEST-install",verificationEvidenceId:"TEST-verify",installerDrainEvidenceId:"TEST-drain"}};
  retired={version:1,revision:3,generation:base.generation,workspace:base.workspace,coverageRevision:base.coverageRevision,state:State.Unverified,tree,reason:Reason.ExplicitOperatorReinstallation};f.receipts.set(2,old);
  const prior=parseDependencyOwner({version:2,workspace:binding.workspace,revision:8,epoch:2,owner:null}),attempt={operationId:id(3),epoch:3,host:{installationId:id(1),bootId:id(2),supervisorId:"1:2",runtimeSha:binding.runtimeSha,inventoryDigest:"f".repeat(64),grantDigest:binding.grantDigest}},
    claimed=parseDependencyOwner({...prior,revision:9,epoch:3,owner:{kind:DependencyOwnerKind.Maintenance,phase:DependencyOwnerPhase.ExclusiveMutation,attempt}});
  selection={version:1,kind:HostedDependencyPreservationRequestKind.ExplicitReinstallation,operationId:id(3),binding,prior:{owner:prior,receipt:committed(2) as {receipt:typeof old;reference:ReturnType<typeof committed>["reference"]}},claimedOwner:claimed,
    sourceTree:tree,destinationParent:{canonicalPath:root+"/dependency-quarantine",dev:"7",ino:"10"},lineage:{kind:Kind.OrdinaryUnverified,start:{path:"/TEST/start",identity:tree,sha256:"a".repeat(64)},final:{path:"/TEST/final",identity:tree,sha256:"b".repeat(64)}}};
  f.files.set(hostedDependencyPreservationSelectionPath(id(3)),enc(selection));f.owner=prior;
});
function activate(){f.files.set(hostedDependencyPreservationSelectionIndexPath(binding,2),enc({version:1,selection:pin(hostedDependencyPreservationSelectionPath(id(3))).reference}));}
function release(){
  f.receipts.set(3,retired);const prior=selection.claimedOwner,previous=parseDependencyOwner({...prior,revision:10,generationContinuity:{version:1,kind:DependencyGenerationContinuityKind.RetiredReadyV1,operationId:id(3),generation:old.generation,readyRevision:2,unverifiedRevision:3,previousReady:committed(2).reference,retiredUnverified:committed(3).reference}}),
    fenced=parseDependencyOwner({...previous,revision:11,owner:{...previous.owner!,phase:DependencyOwnerPhase.Fenced}}),released=parseDependencyOwner({...fenced,revision:12,owner:null});
  f.files.set(hostedDependencyPreservationSelectionPath(id(3))+".release.json",enc({version:1,selection:pin(hostedDependencyPreservationSelectionPath(id(3))).reference,previous,fenced,released}));
  const inventory=enc({version:1,entries:["TEST projected actual opaque inventory"]}),path=root+`/dependency-quarantine/${id(3)}.inventory.json.gz`,bytes=gzipSync(inventory);f.files.set(path,bytes);
  const header={version:1,binding,attempt:prior.owner!.attempt,previous:committed(3),trash:{operationId:id(3),originalTree:tree,destinationParent:selection.destinationParent,destinationName:`dependency-${id(3)}`},inventory:{reference:pin(path).reference,digest:hash(inventory),logicalBytes:"23",entries:1}};
  const prefix=hostedDependencyPreservationPath(binding,3);f.files.set(prefix+".prepared.json",enc(header));f.files.set(prefix+".committed.json",enc(hostedDependencyPreservationCommit(readHostedDependencyPreparedPreservation(binding,retired))));f.owner=released;
}
it("unindexed orphan has no activation; index vetoes old Ready before receipt mutation or generic claim",()=>{
  expect(readHostedDependencyPreservationSelections(binding)).toEqual([]);
  expect(()=>readHostedDependencyCompletedPreservation(fence,binding,selection.operationId)).toThrow();activate();
  expect(readHostedDependencyPendingPreservations(fence,binding)).toHaveLength(1);
  expect(()=>assertHostedDependencyPreservationAdmission(fence,binding)).toThrow();
  expect(()=>claimOriginalHostedDependencyPreservedConsumer(fence,binding,launch,f.access)).toThrow();expect(f.events).not.toContain("owner-cas");expect(f.receipts.get(2)).toEqual(old);
});
it("ordinary Unverified is also vetoed by an index before the explicit reason exists",()=>{
  const current={version:1 as const,revision:2,generation:old.generation,workspace:old.workspace,coverageRevision:old.coverageRevision,state:State.Unverified as const,tree,reason:Reason.BaselineMissing};
  f.receipts.set(2,current);selection={...selection,prior:{...selection.prior,receipt:committed(2) as {receipt:typeof current;reference:ReturnType<typeof committed>["reference"]}}};
  f.files.set(hostedDependencyPreservationSelectionPath(id(3)),enc(selection));activate();
  expect(readHostedDependencyPendingPreservations(fence,binding)).toHaveLength(1);expect(()=>claimOriginalHostedDependencyPreservedConsumer(fence,binding,launch,f.access)).toThrow();
  expect(f.events).not.toContain("owner-cas");expect(f.receipts.get(2)).toEqual(current);
});
it.each(["missing-selection","corrupt-index","changed-selection"])("holds %s without generic fallback",change=>{
  activate();if(change==="missing-selection")f.files.delete(hostedDependencyPreservationSelectionPath(id(3)));
  if(change==="corrupt-index")f.files.set(hostedDependencyPreservationSelectionIndexPath(binding,2),enc({version:1,selection:true}));
  if(change==="changed-selection")f.files.set(hostedDependencyPreservationSelectionPath(id(3)),enc({...selection,operationId:id(99)}));
  expect(()=>readHostedDependencyPendingPreservations(fence,binding)).toThrow();expect(f.events).not.toContain("owner-cas");
});
it("original consumer is selected only after committed mapping and exact release, before its CAS",()=>{
  activate();release();const claim=claimOriginalHostedDependencyPreservedConsumer(fence,binding,launch,f.access)!;
  expect(claim.attempt.launch).toEqual(launch);expect(f.events.indexOf("record:consumer")).toBeLessThan(f.events.indexOf("owner-cas"));
  expect(()=>assertHostedDependencyPreservationAdmission(fence,binding)).not.toThrow();
  expect(()=>claimOriginalHostedDependencyPreservedConsumer(fence,binding,launch,Symbol("forged"))).toThrow();
});
it.each(["uncommitted","stale-owner","live-native","source-conflict"])("refuses %s before installer admission",change=>{
  activate();release();if(change==="uncommitted")f.files.delete(hostedDependencyPreservationPath(binding,3)+".committed.json");
  if(change==="stale-owner")f.owner=parseDependencyOwner({...f.owner,revision:f.owner!.revision+1});if(change==="live-native")f.native=false;
  if(change==="source-conflict")f.source=true;
  expect(()=>claimOriginalHostedDependencyPreservedConsumer(fence,binding,launch,f.access)).toThrow();expect(f.events).not.toContain("owner-cas");
});
it("crash after Consumer CAS resumes the same immutable original consumer, never another UUID",()=>{
  activate();release();f.failAfterCas=true;expect(()=>claimOriginalHostedDependencyPreservedConsumer(fence,binding,launch,f.access)).toThrow();const captured=structuredClone(f.owner);
  const claim=claimOriginalHostedDependencyPreservedConsumer(fence,binding,launch,f.access)!;expect(f.owner).toEqual(captured);expect(claim.attempt).toEqual(f.owner!.owner!.attempt);
  expect(f.events.filter(v=>v==="owner-cas")).toHaveLength(1);expect(()=>assertHostedDependencyPreservationAdmission(fence,binding)).not.toThrow();
});
it("only exact adjacent committed Installing/Ready history closes the immutable old index",()=>{
  activate();release();const claim=claimOriginalHostedDependencyPreservedConsumer(fence,binding,launch,f.access)!,generation=claim.attempt.attemptId,
    preservation=readHostedDependencyCommittedPreservation(binding,retired,generation)!,base={version:1 as const,generation,workspace:binding.workspace,coverageRevision:retired.coverageRevision},
    installing={...base,revision:4,state:State.Installing as const,operationId:generation,requestedKey:old.installKey,preservation},
    ready={...old,revision:5,generation,provenance:{...old.provenance,generation,kind:DependencyInstallProofKind.CompletedInstall as const,operationId:generation,verificationEvidenceId:"TEST-new",installerDrainEvidenceId:"TEST-new-drained"}};
  f.receipts.set(4,installing);expect(readHostedDependencyPendingPreservations(fence,binding)).toHaveLength(1);
  expect(readHostedDependencyCompletedPreservation(fence,binding,selection.operationId)).toBeUndefined();
  f.receipts.set(5,ready);f.source=true;expect(readHostedDependencyPendingPreservations(fence,binding)).toEqual([]);
  expect(readHostedDependencyCompletedPreservation(fence,binding,selection.operationId)?.consumer.claimed.owner?.attempt).toEqual(claim.attempt);
  const consumerPath=hostedDependencyPreservationSelectionPath(selection.operationId)+".consumer.json",originalConsumer=f.files.get(consumerPath)!,forged=JSON.parse(originalConsumer.toString());
  forged.previous.revision+=2;forged.claimed.revision+=2;f.files.set(consumerPath,enc(forged));
  expect(()=>readHostedDependencyCompletedPreservation(fence,binding,selection.operationId)).toThrow();f.files.set(consumerPath,originalConsumer);
  f.receipts.set(4,{...installing,preservation:{...preservation,mappingDigest:"f".repeat(64)}});expect(()=>readHostedDependencyPendingPreservations(fence,binding)).toThrow();
});

// Actual original foreground admission and real protected selection/mapping
// guards. Host scope/qualifier/installer ports remain explicit projections;
// this proves source composition/order, never native install qualification.
it("original foreground selects its installer port only after real committed preservation admission",async()=>{
  activate();release();const claim=claimOriginalHostedDependencyPreservedConsumer(fence,binding,launch,f.access)!;
  const config={workspacePath:binding.workspace.canonicalPath,jobRootDir:binding.jobRootDir,jobId:binding.jobId,taskId:binding.jobId} as Parameters<typeof admitHostedDependencyEntry>[0];
  const prefix=hostedDependencyPreservationPath(binding,3),commit=f.files.get(prefix+".committed.json")!;
  f.files.delete(prefix+".committed.json");await expect(admitHostedDependencyEntry(config)).rejects.toThrow();expect(f.events).not.toContain("installer-port");
  f.files.set(prefix+".committed.json",commit);const entry=await admitHostedDependencyEntry(config);
  expect(entry?.attempt).toEqual(claim.attempt);expect(f.events.indexOf("installer-port")).toBeGreaterThan(f.events.indexOf("owner-cas"));expect(f.events).toContain("running");
});

it("ordinary existing Unverified foreground reuse without explicit activated intent keeps inventory and installer count zero",async()=>{
  const receipt={version:1 as const,revision:2,generation:old.generation,workspace:old.workspace,coverageRevision:old.coverageRevision,state:State.Unverified as const,tree,reason:Reason.BaselineMissing};
  f.receipts.set(2,receipt);f.source=true;const previous=f.owner!,attempt={attemptId:id(42),epoch:previous.epoch+1,launch};
  f.owner=parseDependencyOwner({...previous,revision:previous.revision+1,epoch:attempt.epoch,owner:{kind:DependencyOwnerKind.Consumer,phase:DependencyOwnerPhase.ExclusiveMutation,attempt}});
  const entry=await admitHostedDependencyEntry({workspacePath:binding.workspace.canonicalPath,jobRootDir:binding.jobRootDir,jobId:binding.jobId,taskId:binding.jobId} as Parameters<typeof admitHostedDependencyEntry>[0]);
  expect(entry?.attempt).toEqual(attempt);expect(f.events).not.toContain("inventory");expect(f.events).not.toContain("installer-port");expect(f.receipts.get(2)).toEqual(receipt);
});
