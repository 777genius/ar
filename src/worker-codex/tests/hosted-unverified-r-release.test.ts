/** Release composition with projected physical ports; never Native qualification.
 * Original owner grammar/claim/Running/fence logic and Ready gate stay real. */
import { beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { DependencyConsumerLaunchKind, DependencyCustodyEvidenceKind, DependencyGenerationContinuityKind,
  parseDependencyOwner, type DependencyOwnerRecord } from "../../core/index";
import { claimDependencyConsumer, markDependencyConsumerRunning, HostedCustodyPhase, HostedCustodyReservationState, type HostedCustodyEpoch } from "../../worker-core/index";
import { observeOriginalHostedUnverifiedRTerminal, fenceOriginalHostedDependencyRSourceOwner, releaseOriginalHostedDependencyRSourceOwner } from "../hosted-dependency-generation-r-source-closure";
import { assertHostedReadonlyDependencyReadyPublication } from "../hosted-readonly-dependency-publication";
const f = vi.hoisted(() => ({ access:Symbol("projected TEST original module"), files:new Map<string,Buffer>(), owner:null as DependencyOwnerRecord|null,
  epoch:{} as Record<string,any>, material:{} as Record<string,any>, binding:{} as Record<string,any>, parent:{} as Record<string,any>,
  receipt:{} as Record<string,any>, ready:{} as Record<string,any>, admitted:{} as Record<string,any>, result:{} as Record<string,any>,
  order:[] as string[], fail:"", crashAfterCas:false, providers:[] as Record<string,any>[] }));
const root="/var/lib/subscription-runtime-host-policy", enc=(v:unknown)=>Buffer.from(JSON.stringify(v)+"\n");
const pin=(path:string)=>{const bytes=f.files.get(path);if(!bytes)throw new Error("TEST missing protected record "+path);
  return {bytes,reference:{path,identity:{dev:"1",ino:String([...f.files.keys()].indexOf(path)+1)},sha256:createHash("sha256").update(bytes).digest("hex")}};};
vi.mock("../hosted-current-dependency-origin",()=>({assertOriginalHostedDependencyPhysicalRecordAccess:(a:symbol)=>{if(a!==f.access)throw Error("TEST foreign module");},
  releaseCurrentHostedReadonlyDependencySourceOwner:(fence:never)=>releaseOriginalHostedDependencyRSourceOwner(fence,f.access)}));
vi.mock("../hosted-dependency-cold-custody-transfer",()=>({readOriginalHostedDependencyColdCustodyTransfer:()=>undefined}));
vi.mock("../hosted-dependency-active-maintenance",()=>({readOriginalHostedDependencyMaintenanceIdle:()=>undefined}));
vi.mock("../hosted-dependency-removal-context",()=>({readOriginalHostedDependencyRemoverScope:()=>undefined}));
vi.mock("../hosted-dependency-generation-native-scope",()=>({readOriginalHostedDependencyGenerationNativeScope:()=>{throw Error("TEST unexpected Active scope");}}));
vi.mock("../hosted-dependency-generation-source-closure",()=>({readOriginalHostedDependencyGenerationBaselinePins:()=>{throw Error("TEST missing genuine Active baseline");}}));
vi.mock("../hosted-dependency-active-actor-facts",()=>({readHostedDependencyActiveActorFacts:()=>{throw Error("TEST unexpected Active actor");}}));
vi.mock("../hosted-dependency-generation-native-census",()=>({readOriginalHostedDependencyOperatorNativeCensus:()=>true}));
vi.mock("../../provider-codex/app-server/adapters/hosted-process-activation",()=>({assertHostedActivationFence:()=>{},assertHostedActivationOperator:()=>{},
  readHostedActivationBytes:(name:string)=>name==="host-activation.json"?enc({schemaVersion:1,installationId:id(1),hostId:"host",bootId:id(2),supervisorId:"1:2",generation:1,phase:"EXCLUSIVE",ordinaryOriginsSha256:"a".repeat(64),exclusiveEnrollmentSha256:"b".repeat(64),ordinaryStarts:[]}):undefined,
  decodeHostedActivationBytes:(bytes:Buffer)=>JSON.parse(bytes.toString())}));
vi.mock("../../provider-codex/app-server/adapters/hosted-fd-launch",()=>({assertHostedForegroundResult:(r:unknown)=>{if(r!==f.result)throw Error("TEST copied FDA");},
  readHostedForegroundLaunchObservation:()=>f.result}));
vi.mock("../../provider-codex/app-server/adapters/hosted-process-descriptors",()=>({assertHostedProcessDescriptors:()=>{}}));
vi.mock("../../provider-codex/app-server/adapters/hosted-dependency-workspace",()=>({hostedDependencyOwnerRoot:"/var/lib/subscription-runtime-host-policy/dependency-owners",
  hostedDependencyBindingName:()=>"dependency-workspaces/TEST-C.json",readHostedDependencyBinding:()=>f.binding,isHostedDependencyWorkspace:()=>true}));
vi.mock("../../provider-codex/app-server/adapters/hosted-dependency-origin",()=>({readHostedReadonlyDependencyStart:()=>f.parent}));
vi.mock("../hosted-readonly-dependency-records",()=>({readHostedReadonlyDependencyMaterial:()=>f.material}));
vi.mock("../hosted-readonly-epoch-store",()=>({HostedReadonlyEpochStore:class{readEpoch(){return structuredClone(f.epoch);}}}));
vi.mock("../hosted-readonly-supervisor-host",()=>({HostedReadonlySupervisorHost:class{verifyReadonlyMaterial(){if(f.fail==="custody")throw Error("TEST custody changed");}}}));
vi.mock("../hosted-readonly-host-kernel",()=>({HostedReadonlyRuntimeRole:{Supervisor:"supervisor"},
  completionPath:(r:any)=>root+"/readonly-completed-"+r.startId+".json",
  completionBytes:(r:any,status=0)=>enc({schemaVersion:1,startId:r.startId,unit:r.unit,creatorId:r.creatorId,waitCompleted:true,waitStatus:status}),
  HostedReadonlyHostKernel:class{runtimeRole(){return "supervisor";}operatorSession(){return {hostId:"host",bootId:id(2),supervisorId:"1:2"};}
    fenceCreator(){f.order.push("fence");if(f.fail==="fence")throw Error("TEST fence unknown");}
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
  readHostedDependencyExistingCommittedUnverified:()=>f.receipt,readHostedDependencyEstablishedReceipt:()=>f.receipt.receipt}));
vi.mock("../hosted-dependency-recovery-admission-facts",()=>({readHostedDependencyRecoveryAdmissionFacts:()=>f.admitted}));
vi.mock("../hosted-dependency-installer",()=>({assertHostedDependencyInstallerAttemptDrained:()=>{f.order.push("installer");if(f.fail==="installer")throw Error("TEST installer unknown");}}));
vi.mock("../hosted-managed-provider-failure-recovery",()=>({readOriginalHostedManagedProviderCreator:(_f:unknown,startId:string)=>{
  f.order.push("provider-creator");if(f.fail==="provider")throw Error("TEST provider unknown");return f.providers.find(p=>p.row.startId===startId);},
  readOriginalHostedManagedProviderDischargedReceipt:(_f:unknown,startId:string)=>{f.order.push("provider-replay");if(f.fail==="provider")throw Error("TEST provider unknown");
    return f.providers.find(p=>p.row.startId===startId);}}));
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
beforeEach(()=>{f.files.clear();f.order=[];f.fail="";f.crashAfterCas=false;f.providers=[];
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
