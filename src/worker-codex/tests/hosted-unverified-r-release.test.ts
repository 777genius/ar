/** Release composition with projected physical ports; never Native qualification.
 * Original owner grammar/claim/Running/fence logic and Ready gate stay real. */
import { beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { DependencyConsumerLaunchKind, DependencyCustodyEvidenceKind, DependencyGenerationContinuityKind,
  parseDependencyOwner, type DependencyOwnerRecord } from "../../core/index";
import { claimDependencyConsumer, claimDependencyMaintenance, releaseDependencyMaintenance, DependencyReceiptState, markDependencyConsumerRunning, HostedCustodyPhase, HostedCustodyReservationState, type HostedCustodyEpoch } from "../../worker-core/index";
import { readOriginalHostedUnverifiedRPreservationCensusHistory, readOriginalHostedCompletedUnverifiedRPreservationHistory, captureOriginalHostedUnverifiedRPreservationIdle, readOriginalHostedUnverifiedRPreservationHistory, readOriginalHostedConsumerUnverifiedRPreservationHistory, observeOriginalHostedUnverifiedRTerminal, fenceOriginalHostedDependencyRSourceOwner, releaseOriginalHostedDependencyRSourceOwner } from "../hosted-dependency-generation-r-source-closure";
import { assertHostedReadonlyDependencyReadyPublication } from "../hosted-readonly-dependency-publication";
const f = vi.hoisted(() => ({ access:Symbol("projected TEST original module"), files:new Map<string,Buffer>(), owner:null as DependencyOwnerRecord|null,
  epoch:{} as Record<string,any>, material:{} as Record<string,any>, binding:{} as Record<string,any>, parent:{} as Record<string,any>,
  receipt:{} as Record<string,any>, ready:{} as Record<string,any>, admitted:{} as Record<string,any>, result:{} as Record<string,any>,
  ordinary:false,completed:undefined as any,parents:new Map<string,any>(),consumerContext:null as object|null, child:false, descriptorReads:0, currentReceipt:null as Record<string,unknown>|null, order:[] as string[], fail:"", crashAfterCas:false, providers:[] as Record<string,any>[] }));
const root="/var/lib/subscription-runtime-host-policy", enc=(v:unknown)=>Buffer.from(JSON.stringify(v)+"\n");
const pin=(path:string)=>{const bytes=f.files.get(path);if(!bytes)throw new Error("TEST missing protected record "+path);
  return {bytes,reference:{path,identity:{dev:"1",ino:String([...f.files.keys()].indexOf(path)+1)},sha256:createHash("sha256").update(bytes).digest("hex")}};};
vi.mock("../hosted-current-dependency-origin",()=>({CurrentHostedDependencyOriginKind:{Ordinary:"ordinary",ManagedReadonlyLocal:"managed_readonly_local"},assertOriginalHostedDependencyPhysicalRecordAccess:(a:symbol)=>{if(a!==f.access)throw Error("TEST foreign module");},
  releaseCurrentHostedReadonlyDependencySourceOwner:(fence:never)=>releaseOriginalHostedDependencyRSourceOwner(fence,f.access),
  assertOriginalHostedDependencyOperatorDescriptors:()=>{f.order.push("original-descriptors");f.descriptorReads++;if(f.fail==="owner-race" && f.descriptorReads===2)f.owner=parseDependencyOwner({...f.owner,revision:f.owner!.revision+1});if(f.fail==="operator-descriptors")throw Error("TEST unowned descriptor");}}));
vi.mock("../hosted-dependency-cold-custody-transfer",()=>({readOriginalHostedDependencyColdCustodyTransfer:()=>undefined}));
vi.mock("../hosted-dependency-active-maintenance",()=>({readOriginalHostedDependencyMaintenanceIdle:()=>undefined}));
vi.mock("../hosted-dependency-removal-context",()=>({readOriginalHostedDependencyRemoverScope:()=>undefined}));
vi.mock("../hosted-dependency-generation-native-scope",()=>({readOriginalHostedDependencyGenerationNativeScope:(context:object)=>{if(context!==f.consumerContext || !context)throw Error("TEST foreign consumer scope");f.order.push("consumer-scope");return {facts:f.ordinary?{kind:"ordinary",ordinary:{start:ordinaryStart()}}:{kind:"managed_readonly_local"}}; }}));
vi.mock("../hosted-dependency-generation-source-closure",()=>({readOriginalHostedDependencyGenerationBaselinePins:()=>{throw Error("TEST missing genuine Active baseline");}}));
vi.mock("../hosted-dependency-active-actor-facts",()=>({readHostedDependencyActiveActorFacts:()=>{throw Error("TEST unexpected Active actor");}}));
vi.mock("../hosted-dependency-generation-native-census",()=>({readOriginalHostedDependencyOperatorNativeCensus:()=>true}));
vi.mock("../../provider-codex/app-server/adapters/hosted-process-activation",()=>({assertHostedActivationFence:()=>{},assertHostedActivationOperator:()=>{},
  readHostedActivationBytes:(name:string)=>name==="host-activation.json"?enc({schemaVersion:1,installationId:id(1),hostId:"host",bootId:id(2),supervisorId:"1:2",generation:1,phase:"EXCLUSIVE",ordinaryOriginsSha256:"a".repeat(64),exclusiveEnrollmentSha256:"b".repeat(64),ordinaryStarts:[]}):undefined,
  decodeHostedActivationBytes:(bytes:Buffer)=>JSON.parse(bytes.toString())}));
vi.mock("../../provider-codex/app-server/adapters/hosted-fd-launch",()=>({assertHostedForegroundResult:(r:unknown)=>{if(r!==f.result)throw Error("TEST copied FDA");},
  readHostedForegroundLaunchObservation:()=>f.result}));
vi.mock("../../provider-codex/app-server/adapters/hosted-process-descriptors",()=>({assertHostedProcessDescriptors:()=>{if(f.fail==="raw-descriptors")throw Error("TEST raw descriptor boundary");}}));
vi.mock("../../provider-codex/app-server/adapters/hosted-dependency-workspace",()=>({hostedDependencyOwnerRoot:"/var/lib/subscription-runtime-host-policy/dependency-owners",
  hostedDependencyBindingName:()=>"dependency-workspaces/TEST-C.json",readHostedDependencyBinding:()=>f.binding,isHostedDependencyWorkspace:()=>true}));
vi.mock("../../provider-codex/app-server/adapters/hosted-dependency-origin",()=>({readHostedReadonlyDependencyStart:(_f:unknown,start:string)=>f.parents.get(start)??f.parent}));
vi.mock("../hosted-readonly-dependency-records",()=>({readHostedReadonlyDependencyMaterial:()=>f.material}));
vi.mock("../hosted-readonly-epoch-store",()=>({HostedReadonlyEpochStore:class{readEpoch(){return structuredClone(f.epoch);}}}));
vi.mock("../hosted-readonly-supervisor-host",()=>({HostedReadonlySupervisorHost:class{verifyReadonlyMaterial(){if(f.fail==="custody")throw Error("TEST custody changed");}}}));
vi.mock("../hosted-readonly-host-kernel",()=>({HostedReadonlyRuntimeRole:{Supervisor:"supervisor"},
  completionPath:(r:any)=>root+"/readonly-completed-"+r.startId+".json",
  completionBytes:(r:any,status=0)=>enc({schemaVersion:1,startId:r.startId,unit:r.unit,creatorId:r.creatorId,waitCompleted:true,waitStatus:status}),
  HostedReadonlyHostKernel:class{runtimeRole(){return "supervisor";}ordinaryRuntimeSession(){if(!f.ordinary)throw Error("TEST foreign ordinary session");f.order.push("ordinary-session");return {hostId:"host",bootId:f.fail==="ordinary-boot"?id(99):id(2),supervisorId:"1:2"};}session(){if(f.ordinary)throw Error("TEST R session in ordinary child");if(!f.child)throw Error("TEST not child");return {hostId:"host",bootId:id(2),supervisorId:"1:2"};}operatorSession(){if(f.child)throw Error("TEST supervisor session in child");return {hostId:"host",bootId:id(2),supervisorId:"1:2"};}
    fenceCreator(){if(f.ordinary)throw Error("TEST R creator session in ordinary child");f.order.push("fence");if(f.fail==="fence")throw Error("TEST fence unknown");}
    drainQueuedStart(){f.order.push("queue");if(f.fail==="queue")throw Error("TEST queue unknown");}
    confirmTerminalDescendants(){f.order.push("descendants");if(f.fail==="descendants")throw Error("TEST descendants live");}}}));
vi.mock("../../store-local-file/dependency-environment/local-dependency-owner-store",()=>({LocalDependencyOwnerStore:class{
  static open(){return new this();}read(){return structuredClone(f.owner);}close(){}
  compareAndSwap(_workspace:unknown,revision:number,next:DependencyOwnerRecord){if(f.owner?.revision!==revision)throw Error("TEST stale CAS");
    f.owner=parseDependencyOwner(next);f.order.push(next.owner?"owner-fenced":"owner-null");if(!next.owner&&f.crashAfterCas){f.crashAfterCas=false;throw Error("TEST crash after CAS");}return f.owner;}}}));
vi.mock("../hosted-dependency-legacy-reference-records",()=>({pinReferenceFile:(path:string)=>pin(path)}));
vi.mock("../hosted-readonly-inputs",()=>({readHostedPrivateBytes:(path:string)=>f.files.get(path)??null}));
vi.mock("../hosted-readonly-custody",()=>({readonlySupervisorRoot:"/var/lib/subscription-runtime-host-policy",createReadonlyPrivateRecord:(path:string,bytes:Buffer)=>{const old=f.files.get(path);
  if(old&&!old.equals(bytes))throw Error("TEST immutable collision");f.files.set(path,Buffer.from(bytes));}}));
vi.mock("../hosted-dependency-receipts",()=>({ensureHostedDependencyDirectory:()=>{},readHostedDependencyExistingCommittedReady:()=>f.ready,
  readHostedDependencyExistingCommittedUnverified:()=>f.receipt,readHostedDependencyEstablishedReceipt:()=>f.currentReceipt??f.receipt.receipt}));
vi.mock("../hosted-dependency-recovery-admission-facts",()=>({readHostedDependencyRecoveryAdmissionFacts:()=>f.admitted}));
vi.mock("../hosted-dependency-installer",()=>({assertHostedDependencyInstallerAttemptDrained:()=>{f.order.push("installer");if(f.fail==="installer")throw Error("TEST installer unknown");}}));
vi.mock("../hosted-managed-provider-failure-recovery",()=>({readOriginalHostedManagedProviderCreator:(_f:unknown,startId:string)=>{
  f.order.push("provider-creator");if(f.fail==="provider")throw Error("TEST provider unknown");return f.providers.find(p=>p.row.startId===startId);},
  readOriginalHostedManagedConsumerProviderDischargedReceipt:(context:object,_f:unknown,startId:string)=>{if(context!==f.consumerContext || !context)throw Error("TEST foreign provider context");f.order.push("consumer-provider-replay");return f.providers.find(p=>p.row.startId===startId);},
  readOriginalHostedManagedProviderDischargedReceipt:(_f:unknown,startId:string)=>{if(f.child)throw Error("TEST operator provider in child");f.order.push("provider-replay");if(f.fail==="provider")throw Error("TEST provider unknown");
    return f.providers.find(p=>p.row.startId===startId);}}));
// Project only the new defining selection reader. The R discharge, actual
// predecessor owner transitions and all immutable R record checks stay real.
vi.mock("../hosted-dependency-preservation-handoff",()=>({readHostedDependencyCompletedPreservation:()=>f.completed}));
vi.mock("../hosted-dependency-preservation-selection",()=>({
  HostedDependencyPreservationLineageKind:{ReadonlyUnverified:"readonly_unverified"},
  readHostedDependencyPreservationSelection:(binding:unknown,operationId:string)=>{
    if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(operationId))throw Error("TEST operation path");
    const selected=pin(root+"/dependency-preservation/"+operationId+".selection.json"),header=JSON.parse(selected.bytes.toString("utf8"));
    if(header.operationId!==operationId || !enc(header.binding).equals(enc(binding)))throw Error("TEST foreign selection");
    return {header,reference:selected.reference};
  },
}));
const id=(n:number)=>"00000000-0000-4000-8000-"+String(n).padStart(12,"0"), ref=(path:string)=>{if(!f.files.has(path))f.files.set(path,enc({path}));return pin(path).reference;};
const fence=undefined as never;
function start(n=3){
  const startId=id(n),outer={startId,creatorId:startId,unit:`subscription-runtime-outer-${startId}.service`,generation:n,state:HostedCustodyReservationState.Terminal};
  f.epoch={...f.epoch,phase:HostedCustodyPhase.Closed,generation:n+1,outerRuntime:outer,reservations:[]};
  f.parent={reference:ref(root+"/readonly-dependency-starts/"+startId+".json"),value:{...f.binding,workspace:f.binding.workspace,
    ...outer,hostId:"host",bootId:id(2),supervisorId:"1:2",candidateJobId:"TEST-C",readonlyJobId:"TEST-R",association:f.material.reference}};
  const attempt=claimDependencyConsumer({read:()=>f.owner,compareAndSwap:(_w,_r,next)=>f.owner=parseDependencyOwner(next)},f.binding.workspace,
    {kind:DependencyConsumerLaunchKind.ManagedReadonlyLocalV1,installationId:id(1),bootId:id(2),runtimeSha:"a".repeat(40),grantDigest:"b".repeat(64),
      startId,unit:outer.unit,association:f.material.reference,origin:f.parent.reference},id(100+n));
  const preclaimPath=root+"/dependency-reader-starts/"+startId+".json";
  f.files.set(preclaimPath,enc({version:1,kind:DependencyConsumerLaunchKind.ManagedReadonlyLocalV1,attempt,workspace:f.binding.workspace,
    origin:f.parent.reference,custody:f.material.reference,binding:pin(root+"/dependency-workspaces/TEST-C.json").reference,
    ownerRevision:f.owner!.revision,ownerSha256:createHash("sha256").update(enc(f.owner)).digest("hex"),receipt:{}}));
  f.files.set(root+"/dependency-reader-entries/"+startId+".json",enc({version:1,producer:pin(preclaimPath).reference,attempt}));
  const qualification=ref(root+"/dependency-tool-qualifications/"+startId+".json");
  // Use the actual fixed qualification record name, not a caller-selected path.
  return import("../../core/dependency-environment/dependency-tool-profile").then(({dependencyToolQualificationRecordName})=>{
    const q=ref(root+"/"+dependencyToolQualificationRecordName(startId));
    f.files.set(root+"/dependency-root-preparations/"+startId+".json",enc({version:4,attempt,custodyReference:f.material.reference,
      qualification:q,protectedProfile:qualification,config:{},configAncestors:[],durableHandoffRoot:{},scratchParent:{},
      authoredRoots:[],generatedRoots:[],sourceLookupAncestors:[],execution:{basis:"usable_unverified"},unverified:f.receipt.reference,unverifiedRevision:1}));
    markDependencyConsumerRunning({read:()=>f.owner,compareAndSwap:(_w,_r,next)=>f.owner=parseDependencyOwner(next)},f.binding.workspace,attempt,"10");
    f.files.set(root+"/readonly-completed-"+startId+".json",enc({schemaVersion:1,startId,unit:outer.unit,creatorId:startId,waitCompleted:true,waitStatus:0}));
    f.result={startId,unit:outer.unit,exitCode:0,closeStatus:0,invocationId:"c".repeat(32),proxyBirth:"42:10"};return attempt;
  });
}
async function provider(waitStatus=0){
  const start=f.epoch.outerRuntime.startId,row={startId:id(9),creatorId:id(9),unit:`subscription-runtime-hosted-${id(9)}.service`,state:HostedCustodyReservationState.Terminal},
    attempt=f.owner!.owner!.attempt,qualification=pin(root+"/"+(await import("../../core/dependency-environment/dependency-tool-profile")).dependencyToolQualificationRecordName(start)).reference,
    profile=ref(root+"/dependency-installer-profile.json"),birthPath=root+"/dependency-managed-provider-starts/"+row.startId+".json";
  f.epoch.reservations=[row];
  f.files.set(birthPath,enc({version:3,attempt,bootId:id(2),custodyReference:f.material.reference,executionJobId:"TEST-R",generation:f.epoch.outerRuntime.generation,
    hostId:"host",installationId:id(1),jobRootDir:"/TEST/job",logicalJobId:"TEST-C",originReference:f.parent.reference,parentStartId:start,
    protectedProfile:profile,providerStartId:row.startId,qualification,runtimeSha:"a".repeat(40),supervisorId:"1:2",unit:row.unit,workspace:f.binding.workspace,
    execution:{basis:"usable_unverified"},unverified:f.receipt.reference,unverifiedRevision:f.admitted.unverifiedRevision}));
  f.providers=[{row,attempt,parent:f.parent.reference,material:f.material.reference,
    preclaim:pin(root+"/dependency-reader-starts/"+start+".json").reference,entry:pin(root+"/dependency-reader-entries/"+start+".json").reference,
    preparation:pin(root+"/dependency-root-preparations/"+start+".json").reference,qualification,profile,birth:pin(birthPath).reference,
    completion:ref(root+"/dependency-managed-provider-completions/"+row.startId+".json"),receipt:{waitStatus,parentAttempt:attempt,providerReference:pin(birthPath).reference}}];
}
beforeEach(()=>{f.parents.clear();f.completed=undefined;f.ordinary=false;f.child=false;f.consumerContext=null;f.descriptorReads=0;f.currentReceipt=null;f.files.clear();f.order=[];f.fail="";f.crashAfterCas=false;f.providers=[];
  f.binding={version:2,jobId:"TEST-C",installationId:id(1),runtimeSha:"a".repeat(40),grantDigest:"b".repeat(64),jobRootDir:"/TEST/job",workspace:{canonicalPath:"/TEST/job/workspace",dev:"1",ino:"2"}};
  f.files.set(root+"/dependency-workspaces/TEST-C.json",enc(f.binding));
  f.material={reference:ref(root+"/readonly-dependency-associations/TEST.json"),evidence:{kind:DependencyCustodyEvidenceKind.ReadonlyLocalAdoptionV1,
    workspace:f.binding.workspace,candidate:{jobId:"TEST-C"},installation:{installationId:id(1)}},ready:{receipt:{installKey:"d".repeat(64)}}};
  f.owner=parseDependencyOwner({version:3,workspace:f.binding.workspace,revision:2,epoch:1,owner:null,custodyBinding:f.material.reference});
  f.epoch={schemaVersion:1,hostId:"host",bootId:id(2),supervisorId:"1:2",phase:HostedCustodyPhase.Closed,generation:1,revoked:false,
    identity:{jobId:"TEST-R",workspacePath:f.binding.workspace.canonicalPath},reservations:[]};
  f.receipt={reference:ref(root+"/dependency-receipt-history/1-2.unverified.json"),receipt:{reason:"baseline_missing",generation:"TEST-generation",tree:{dev:"1",ino:"3"}}};
  f.admitted={version:2,unverified:f.receipt.reference,unverifiedRevision:1};
});
it("authenticates initial legacy adoption, releases a real no-baseline Usable R, replays Ready and admits the next original attempt",async()=>{
  assertHostedReadonlyDependencyReadyPublication(fence,f.epoch as HostedCustodyEpoch);expect(f.owner!.owner).toBeNull();
  const first=await start();fenceOriginalHostedDependencyRSourceOwner(fence,f.result as never,f.access);
  assertHostedReadonlyDependencyReadyPublication(fence,f.epoch as HostedCustodyEpoch);expect(f.owner!.owner).toBeNull();
  expect(f.order.indexOf("installer")).toBeLessThan(f.order.indexOf("owner-null"));
  const released=structuredClone(f.owner);releaseOriginalHostedDependencyRSourceOwner(fence,f.access);expect(f.owner).toEqual(released);
  f.epoch.phase=HostedCustodyPhase.Ready;releaseOriginalHostedDependencyRSourceOwner(fence,f.access);expect(f.owner).toEqual(released);
  const second=await start(5);expect(second.epoch).toBeGreaterThan(first.epoch);
  fenceOriginalHostedDependencyRSourceOwner(fence,f.result as never,f.access);releaseOriginalHostedDependencyRSourceOwner(fence,f.access);expect(f.owner!.owner).toBeNull();
});
it("accepts authenticated BaselineMissing retirement while refusing a lost Active interval",async()=>{
  await start();f.ready={reference:ref(root+"/dependency-receipt-history/1-2.ready.json"),receipt:{generation:"TEST-generation",tree:{dev:"1",ino:"3"}}};
  f.owner=parseDependencyOwner({...f.owner,generationContinuity:{version:1,kind:DependencyGenerationContinuityKind.RetiredReadyV1,
    operationId:id(103),generation:"TEST-generation",readyRevision:1,unverifiedRevision:2,previousReady:f.ready.reference,retiredUnverified:f.receipt.reference}});
  f.admitted.unverifiedRevision=2;
  fenceOriginalHostedDependencyRSourceOwner(fence,f.result as never,f.access);releaseOriginalHostedDependencyRSourceOwner(fence,f.access);
  expect(f.owner!.owner).toBeNull();
  await start(5);f.receipt.receipt.reason="inputs_changed";
  expect(()=>fenceOriginalHostedDependencyRSourceOwner(fence,f.result as never,f.access)).toThrow();
});
it("recovers the exact durable release intent after owner-null CAS without reconstructing from null",async()=>{
  await start();fenceOriginalHostedDependencyRSourceOwner(fence,f.result as never,f.access);f.crashAfterCas=true;
  expect(()=>releaseOriginalHostedDependencyRSourceOwner(fence,f.access)).toThrow("TEST crash after CAS");expect(f.owner!.owner).toBeNull();
  expect(()=>releaseOriginalHostedDependencyRSourceOwner(fence,f.access)).not.toThrow();
  f.files.delete(root+"/dependency-unverified-r-releases/"+f.result.startId+".json");
  expect(()=>releaseOriginalHostedDependencyRSourceOwner(fence,f.access)).toThrow();
});
it.each(["queue","descendants","installer","provider"])("holds exact ownership when %s drain is unknown",async fail=>{
  await start();fenceOriginalHostedDependencyRSourceOwner(fence,f.result as never,f.access);const owner=structuredClone(f.owner);
  if(fail==="provider")await provider();f.fail=fail;
  expect(()=>releaseOriginalHostedDependencyRSourceOwner(fence,f.access)).toThrow();expect(f.owner).toEqual(owner);
});
it.each(["failed","cancelled","stale","copied"])("refuses %s FDA before any creator fence",async kind=>{
  await start();if(kind==="failed")f.result.exitCode=1;if(kind==="cancelled")f.result.closeStatus=-1;if(kind==="stale")f.result.startId=id(99);
  const owner=structuredClone(f.owner);expect(()=>fenceOriginalHostedDependencyRSourceOwner(fence,(kind==="copied"?{...f.result}:f.result) as never,f.access)).toThrow();
  expect(f.order).toEqual([]);expect(f.owner).toEqual(owner);
});
it.each(["custody","outer","owner","completion","qualification","RetiredEvicting"])("refuses changed %s without releasing",async kind=>{
  await start();fenceOriginalHostedDependencyRSourceOwner(fence,f.result as never,f.access);
  if(kind==="custody")f.material.reference={...f.material.reference,sha256:"f".repeat(64)};
  if(kind==="outer")f.epoch.outerRuntime.startId=id(99);
  if(kind==="owner")f.owner={...f.owner!,epoch:99};
  if(kind==="completion")f.files.delete(root+"/readonly-completed-"+f.result.startId+".json");
  if(kind==="qualification")f.files.delete(root+"/"+(await import("../../core/dependency-environment/dependency-tool-profile")).dependencyToolQualificationRecordName(f.result.startId));
  if(kind==="RetiredEvicting")f.owner=parseDependencyOwner({...f.owner,generationContinuity:{version:1,kind:DependencyGenerationContinuityKind.RetiredEvictingV1,
    operationId:id(103),generation:"TEST-generation",readyRevision:1,evictingRevision:2,previousReady:ref(root+"/TEST-ready.json"),
    retiredEvicting:ref(root+"/TEST-evicting.json"),baseline:ref(root+"/TEST-baseline.json"),writerBarrier:ref(root+"/TEST-barrier.json")}});
  const owner=structuredClone(f.owner);expect(()=>releaseOriginalHostedDependencyRSourceOwner(fence,f.access)).toThrow();expect(f.owner).toEqual(owner);
});

it.each(["reserved","old-generation","revoked","live-unrelated"])("refuses %s epoch after a durable release",async kind=>{
  await start();fenceOriginalHostedDependencyRSourceOwner(fence,f.result as never,f.access);releaseOriginalHostedDependencyRSourceOwner(fence,f.access);
  if(kind==="reserved")f.epoch.outerRuntime.state=HostedCustodyReservationState.Reserved;
  if(kind==="old-generation")f.epoch.generation=f.epoch.outerRuntime.generation;
  if(kind==="revoked")f.epoch.revoked=true;
  if(kind==="live-unrelated")f.epoch.reservations=[{startId:id(99),state:HostedCustodyReservationState.Reserved}];
  const owner=structuredClone(f.owner);expect(()=>releaseOriginalHostedDependencyRSourceOwner(fence,f.access)).toThrow();expect(f.owner).toEqual(owner);
});

it.each([0,7])("retains success/failure provider completion (%s) through initial release and durable replay",async status=>{
  await start();await provider(status);fenceOriginalHostedDependencyRSourceOwner(fence,f.result as never,f.access);
  assertHostedReadonlyDependencyReadyPublication(fence,f.epoch as HostedCustodyEpoch);expect(f.owner!.owner).toBeNull();
  expect(f.order).toContain("provider-creator");expect(f.order).toContain("provider-replay");
  const owner=structuredClone(f.owner);assertHostedReadonlyDependencyReadyPublication(fence,f.epoch as HostedCustodyEpoch);expect(f.owner).toEqual(owner);
});
it("never falls back from an Active baseline into an unverified release",async()=>{
  await start();const reference=ref(root+"/TEST-baseline.json");
  f.owner=parseDependencyOwner({...f.owner,generationContinuity:{version:1,kind:DependencyGenerationContinuityKind.BaselineAuthenticatedV1,
    operationId:id(103),generation:"TEST-generation",readyRevision:1,previousReady:ref(root+"/TEST-ready.json"),baseline:reference,writerBarrier:ref(root+"/TEST-barrier.json")}});
  // The existing Active path may fence its actual consumer before the baseline
  // is read. It must retain that owner and refuse release through this no-Active
  // fixture, whose original baseline reader deliberately rejects missing facts.
  fenceOriginalHostedDependencyRSourceOwner(fence,f.result as never,f.access);
  expect(f.owner!.owner).not.toBeNull();
  expect(()=>releaseOriginalHostedDependencyRSourceOwner(fence,f.access)).toThrow("TEST missing genuine Active baseline");
  expect(f.owner!.owner).not.toBeNull();
  expect([...f.files.keys()].some(path=>path.includes("dependency-unverified-r-"))).toBe(false);
});

// A terminal observer must not release ownership or turn revoked admission live.
it("observes the exact discharged final FDA after revoke without changing owner or records",async()=>{
  await start();await provider();fenceOriginalHostedDependencyRSourceOwner(fence,f.result as never,f.access);
  releaseOriginalHostedDependencyRSourceOwner(fence,f.access);f.epoch.revoked=true;
  const owner=structuredClone(f.owner),files=[...f.files].map(([path,bytes])=>[path,bytes.toString("hex")]);
  const actual=observeOriginalHostedUnverifiedRTerminal(fence,f.result as never,f.access);
  expect(actual.startId).toBe(f.result.startId);expect(actual.release.path).toContain("dependency-unverified-r-releases/");
  expect(f.owner).toEqual(owner);expect([...f.files].map(([path,bytes])=>[path,bytes.toString("hex")])).toEqual(files);
  expect(()=>releaseOriginalHostedDependencyRSourceOwner(fence,f.access)).toThrow();
});
it.each(["not-closed","not-revoked","stale-outer","missing-intent","different-fda","copied-fda","queue","descendants","installer","provider"])("holds revoked terminal observation on %s",async kind=>{
  await start();await provider();fenceOriginalHostedDependencyRSourceOwner(fence,f.result as never,f.access);
  releaseOriginalHostedDependencyRSourceOwner(fence,f.access);f.epoch.revoked=true;
  if(kind==="not-closed")f.epoch.phase=HostedCustodyPhase.Ready;
  if(kind==="not-revoked")f.epoch.revoked=false;
  if(kind==="stale-outer")f.epoch.outerRuntime.startId=id(99);
  if(kind==="missing-intent")f.files.delete(root+"/dependency-unverified-r-releases/"+f.result.startId+".json");
  if(kind==="different-fda")f.result.invocationId="f".repeat(32);
  if(["queue","descendants","installer","provider"].includes(kind))f.fail=kind;
  const owner=structuredClone(f.owner);
  expect(()=>observeOriginalHostedUnverifiedRTerminal(fence,(kind==="copied-fda"?{...f.result}:f.result) as never,f.access)).toThrow();
  expect(f.owner).toEqual(owner);
});

async function originalIdleForPreservation(withProvider=true) {
  f.epoch.requirement="test_managed_qualification";
  f.epoch.identity={jobId:"TEST-R",jobRootDir:"/TEST/job",workspacePath:f.binding.workspace.canonicalPath,runtimeSha:"a".repeat(40),
    ...Object.fromEntries(["runtimeManifestSha256","issuerDeploymentDigest","policySha256","reviewSha256","stageSha256","grantSha256"].map(key=>[key,"d".repeat(64)]))};
  f.receipt.receipt.state=DependencyReceiptState.Unverified;
  const original=await start();if(withProvider)await provider();
  fenceOriginalHostedDependencyRSourceOwner(fence,f.result as never,f.access);releaseOriginalHostedDependencyRSourceOwner(fence,f.access);
  const idle=captureOriginalHostedUnverifiedRPreservationIdle(fence,f.access),operationId=id(801),selectionPath=root+"/dependency-preservation/"+operationId+".selection.json";
  const maintenance=claimDependencyMaintenance({read:()=>f.owner,compareAndSwap:(_w,_r,next)=>f.owner=parseDependencyOwner(next)},f.binding.workspace,
    {installationId:id(1),bootId:id(2),runtimeSha:"a".repeat(40),grantDigest:"b".repeat(64),supervisorId:"1:2",inventoryDigest:"e".repeat(64)},operationId);
  f.files.set(selectionPath,enc({operationId,binding:f.binding,prior:{owner:idle.previous,receipt:structuredClone(f.receipt)},claimedOwner:f.owner,
    lineage:{kind:"readonly_unverified",release:idle.release,fda:idle.fda}}));
  return {idle,original,operationId,selectionPath,maintenance};
}
it("authenticates original no-Active R history after real Maintenance advances owner epoch and current receipt changes",async()=>{
  const own=await originalIdleForPreservation();f.currentReceipt={state:DependencyReceiptState.Installing,revision:2};
  const before=structuredClone(f.owner),files=[...f.files].map(([path,bytes])=>[path,bytes.toString("hex")]);
  const proof=readOriginalHostedUnverifiedRPreservationHistory(fence,own.operationId,f.access);
  expect(proof.previous).toEqual(own.idle.previous);expect(proof.attempt).toEqual(own.original);
  expect(proof.release).toEqual(own.idle.release);expect(proof.fda).toEqual(own.idle.fda);
  expect(proof.units).toEqual([f.result.unit,f.providers[0]!.row.unit]);expect(f.order).toContain("provider-replay");
  expect(f.owner).toEqual(before);expect([...f.files].map(([path,bytes])=>[path,bytes.toString("hex")])).toEqual(files);
  expect(()=>captureOriginalHostedUnverifiedRPreservationIdle(fence,f.access)).toThrow();
});
it("revalidates old sources beside a new current Consumer/Reserved outer using original effect descriptor dispatch",async()=>{
  const own=await originalIdleForPreservation();
  const store={read:()=>f.owner,compareAndSwap:(_w:unknown,_r:unknown,next:DependencyOwnerRecord)=>f.owner=parseDependencyOwner(next)};
  releaseDependencyMaintenance(store,f.binding.workspace,own.maintenance);
  const nextOuter={...f.epoch.outerRuntime,startId:id(901),unit:`subscription-runtime-outer-${id(901)}.service`,generation:f.epoch.generation+1,state:HostedCustodyReservationState.Reserved};
  const launch={...own.original.launch,startId:nextOuter.startId,unit:nextOuter.unit};
  claimDependencyConsumer(store,f.binding.workspace,launch,id(902));
  f.epoch={...f.epoch,phase:HostedCustodyPhase.Ready,generation:nextOuter.generation,outerRuntime:nextOuter};
  f.currentReceipt={state:DependencyReceiptState.Ready,revision:3};f.fail="raw-descriptors";
  const owner=structuredClone(f.owner);expect(readOriginalHostedUnverifiedRPreservationHistory(fence,own.operationId,f.access).attempt).toEqual(own.original);
  expect(f.owner).toEqual(owner);expect(f.order).toContain("original-descriptors");
});
it("uses genuine lexical consumer scope and child session for historical census, refusing copied scope",async()=>{
  const own=await originalIdleForPreservation();f.child=true;f.consumerContext=Object.freeze({});
  const owner=structuredClone(f.owner),context=f.consumerContext as never;
  expect(readOriginalHostedConsumerUnverifiedRPreservationHistory(context,fence,own.operationId,f.access).attempt).toEqual(own.original);
  expect(f.order.filter(v=>v==="consumer-scope")).toHaveLength(4);expect(f.order).toContain("consumer-provider-replay");expect(f.owner).toEqual(owner);
  expect(()=>readOriginalHostedConsumerUnverifiedRPreservationHistory({} as never,fence,own.operationId,f.access)).toThrow("foreign consumer scope");
  expect(()=>readOriginalHostedUnverifiedRPreservationHistory(fence,own.operationId,f.access)).toThrow("supervisor session in child");
});
it.each(["revoked","old-generation","custody","predecessor","missing-selection","missing-entry","missing-provider","reserved-provider","subset-providers","foreign-FDA-body","queue","descendants","installer","provider","operator-descriptors"])("holds historical no-Active facts for %s without changing current Maintenance",async kind=>{
  const own=await originalIdleForPreservation();
  const mutate=(path:string,fn:(value:any)=>void)=>{const v=JSON.parse(f.files.get(path)!.toString("utf8"));fn(v);f.files.set(path,enc(v));};
  if(kind==="revoked")f.epoch.revoked=true;
  if(kind==="old-generation")f.epoch.generation=f.epoch.outerRuntime.generation;
  if(kind==="custody")f.material.reference={...f.material.reference,sha256:"f".repeat(64)};
  if(kind==="predecessor")mutate(own.selectionPath,v=>v.prior.owner.revision++);
  if(kind==="missing-selection")f.files.delete(own.selectionPath);
  if(kind==="missing-entry")f.files.delete(root+"/dependency-reader-entries/"+f.result.startId+".json");
  if(kind==="missing-provider")f.files.delete(root+"/dependency-managed-provider-starts/"+f.providers[0]!.row.startId+".json");
  if(kind==="reserved-provider")f.epoch.reservations[0].state=HostedCustodyReservationState.Reserved;
  if(kind==="subset-providers"){
    mutate(own.idle.release.path,v=>v.providers=[]);mutate(own.selectionPath,v=>v.lineage.release=pin(own.idle.release.path).reference);
  }
  if(kind==="foreign-FDA-body"){
    mutate(own.idle.fda.path,v=>v.identity.jobId="TEST-foreign");
    mutate(own.idle.release.path,v=>v.fda=pin(own.idle.fda.path).reference);
    mutate(own.selectionPath,v=>{v.lineage.fda=pin(own.idle.fda.path).reference;v.lineage.release=pin(own.idle.release.path).reference;});
  }
  if(["queue","descendants","installer","provider","operator-descriptors"].includes(kind))f.fail=kind;
  const owner=structuredClone(f.owner);expect(()=>readOriginalHostedUnverifiedRPreservationHistory(fence,own.operationId,f.access)).toThrow();expect(f.owner).toEqual(owner);
});

it("zero-provider historical facts still require the exact original direct qualification",async()=>{
  const own=await originalIdleForPreservation(false);
  expect(readOriginalHostedUnverifiedRPreservationHistory(fence,own.operationId,f.access).units).toEqual([f.result.unit]);
  const {dependencyToolQualificationRecordName}=await import("../../core/dependency-environment/dependency-tool-profile");
  f.files.delete(root+"/"+dependencyToolQualificationRecordName(f.result.startId));
  expect(()=>readOriginalHostedUnverifiedRPreservationHistory(fence,own.operationId,f.access)).toThrow();
});
it("rejoins actual current owner after historical native observation",async()=>{
  const own=await originalIdleForPreservation();f.fail="owner-race";
  expect(()=>readOriginalHostedUnverifiedRPreservationHistory(fence,own.operationId,f.access)).toThrow();
  expect(f.descriptorReads).toBe(2);
});

function ordinaryStart(){return {schemaVersion:1,installationId:id(1),jobId:"TEST-current-C",jobRootDir:"/TEST/current-C",workspacePath:"/TEST/current-C/workspace",activationGeneration:1,
  bootId:id(2),supervisorId:"1:2",originSha256:"a".repeat(64),unit:`subscription-runtime-ordinary-${id(990)}.service`,controlGroup:"/TEST/current-C",creatorId:id(990),creatorPidBirth:"1:2",grantSha256:"b".repeat(64)};}
it("ordinary lexical context rechecks exact zero outer completion and native drains without R session",async()=>{
  const own=await originalIdleForPreservation();f.child=true;f.ordinary=true;f.consumerContext=Object.freeze({});
  expect(readOriginalHostedConsumerUnverifiedRPreservationHistory(f.consumerContext as never,fence,own.operationId,f.access).attempt).toEqual(own.original);
  expect(f.order).toContain("ordinary-session");expect(f.order).toContain("consumer-provider-replay");
  expect(()=>readOriginalHostedConsumerUnverifiedRPreservationHistory({} as never,fence,own.operationId,f.access)).toThrow("foreign consumer scope");
});
it.each(["ordinary-boot","completion-conflict","queue","descendants"])("ordinary historical facts hold %s instead of borrowing creator permission",async change=>{
  const own=await originalIdleForPreservation();f.child=true;f.ordinary=true;f.consumerContext=Object.freeze({});f.fail=change;
  if(change==="completion-conflict")f.files.set(root+"/readonly-completed-"+f.result.startId+".json",enc({forged:true}));
  expect(()=>readOriginalHostedConsumerUnverifiedRPreservationHistory(f.consumerContext as never,fence,own.operationId,f.access)).toThrow();
});
async function completedPreservation(){
  const own=await originalIdleForPreservation(),startId=id(950),attempt={...own.original,attemptId:id(951),epoch:f.owner!.epoch+1,launch:{...own.original.launch,startId,unit:`subscription-runtime-outer-${startId}.service`}},
    outer={...f.epoch.outerRuntime,startId,unit:attempt.launch.unit,creatorId:startId,generation:f.epoch.generation+1,state:HostedCustodyReservationState.Terminal};
  f.epoch={...f.epoch,revoked:true,phase:HostedCustodyPhase.Closed,generation:outer.generation+1,outerRuntime:outer};
  const record=(path:string,v:unknown)=>{f.files.set(path,enc(v));return pin(path).reference;};
  const parent={...f.parent.value,startId,unit:outer.unit,creatorId:outer.creatorId,generation:outer.generation};
  const parentRef=record(root+"/dependency-readonly-starts/"+startId+".json",parent);f.parents.set(startId,{value:parent,reference:parentRef});
  const claimed=parseDependencyOwner({...f.owner,revision:f.owner!.revision+1,epoch:attempt.epoch,owner:{kind:"consumer",phase:"exclusive_mutation",attempt}});
  const header=JSON.parse(f.files.get(own.selectionPath)!.toString("utf8")),ready={receipt:{TEST:"new Ready"},reference:record(root+"/TEST-new-ready.json",{TEST:"new Ready"})};
  f.completed={selection:header,consumer:{claimed},ready};
  const preclaim=record(root+"/dependency-reader-starts/"+startId+".json",{version:1,kind:DependencyConsumerLaunchKind.ManagedReadonlyLocalV1,attempt,binding:pin(root+"/dependency-workspaces/TEST-C.json").reference,custody:f.material.reference,origin:parentRef,workspace:f.binding.workspace,ownerRevision:1,ownerSha256:"a".repeat(64),receipt:{}});
  record(root+"/dependency-reader-entries/"+startId+".json",{version:1,producer:preclaim,attempt});
  const pending=record(root+"/dependency-generation-barriers/pending/"+attempt.attemptId+".json",{}),barrier=record(root+"/dependency-generation-barriers/"+attempt.attemptId+".json",{}),
    baseline=record(root+"/dependency-generation-baselines/"+attempt.attemptId+".json",{version:1,actors:[],attempt,barrier,binding:f.binding,inputClosureDigest:"a".repeat(64),installerMappingSha256:"b".repeat(64),ready:ready.receipt,readyReference:ready.reference}),
    qualification=record(root+"/"+(await import("../../core/dependency-environment/dependency-tool-profile")).dependencyToolQualificationRecordName(startId),{}),retirement=record(root+"/dependency-generation-source-retirements/"+startId+".json",{version:1,attempt,binding:f.binding,pending,barrier,baseline,lifecycle:"runtime_never_configured",qualification});
  record(root+"/readonly-completed-"+startId+".json",{schemaVersion:1,startId,unit:outer.unit,creatorId:outer.creatorId,waitCompleted:true,waitStatus:0});
  record(root+"/dependency-attempt-fences/"+startId+".json",{version:1,startId,attemptId:attempt.attemptId,epoch:attempt.epoch});
  const closurePath=root+"/dependency-generation-source-closures/"+startId+".json";
  record(closurePath,{version:2,attempt,barrier,baseline,binding:f.binding,identity:f.epoch.identity,outer,parent:parentRef,pending,providers:[],retirement});
  return {...own,closurePath,baseline};
}
it("completed fixed history rejoins genuine new source closure after revocation while live B still refuses",async()=>{
  const own=await completedPreservation(),owner=structuredClone(f.owner);
  expect(readOriginalHostedUnverifiedRPreservationCensusHistory(fence,own.operationId,f.access).attempt).toEqual(own.original);
  expect(()=>readOriginalHostedUnverifiedRPreservationHistory(fence,own.operationId,f.access)).toThrow();expect(f.owner).toEqual(owner);
});
it.each(["missing-completion-proof","missing-new-closure","wrong-ready","not-revoked","reserved-final","stale-final-closure","provider-live"])("completed history refuses %s",async change=>{
  const own=await completedPreservation();
  if(change==="missing-completion-proof")f.completed=undefined;if(change==="missing-new-closure")f.files.delete(own.closurePath);
  if(change==="wrong-ready")f.completed.ready.receipt={TEST:"foreign Ready"};if(change==="not-revoked")f.epoch.revoked=false;
  if(change==="reserved-final")f.epoch.outerRuntime.state=HostedCustodyReservationState.Reserved;
  if(change==="stale-final-closure"){f.epoch.outerRuntime.generation++;f.epoch.generation+=2;}if(change==="provider-live")f.epoch.reservations[0].state=HostedCustodyReservationState.Reserved;
  expect(()=>readOriginalHostedCompletedUnverifiedRPreservationHistory(fence,own.operationId,f.access)).toThrow();
});

it("completed revoked history remains readable in unrelated genuine ordinary census with both old outer proofs",async()=>{
  const own=await completedPreservation();f.child=true;f.ordinary=true;f.consumerContext=Object.freeze({});
  expect(readOriginalHostedUnverifiedRPreservationCensusHistory(fence,own.operationId,f.access,f.consumerContext as never).attempt).toEqual(own.original);
  expect(f.order).toContain("ordinary-session");expect(f.order).toContain("consumer-provider-replay");
});
