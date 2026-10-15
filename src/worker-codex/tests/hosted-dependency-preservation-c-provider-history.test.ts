/** Real original provider-history composition; protected filesystem/native
 * ports are projected and cannot issue custody or native qualification. */
import {createHash} from "node:crypto";
import {beforeEach,expect,it,vi} from "vitest";
import {DependencyConsumerLaunchKind,DependencyCustodyEvidenceKind,parseDependencyOwner} from "../../core/index";
import {HostedActivationPhase,HostedCustodyReservationState as Row} from "../../worker-core/index";
import {dependencyToolQualificationRecordName} from "../../core/dependency-environment/dependency-tool-profile";
const f=vi.hoisted(()=>({files:new Map<string,Buffer>(),fds:new Map<number,{path:string;position:number}>(),nextFd:10,access:Symbol("TEST lexical"),context:{},
  material:undefined as any,epoch:undefined as any,owner:undefined as any,activation:undefined as any,drains:[] as string[],fail:""}));
const root="/var/lib/subscription-runtime-host-policy",id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const enc=(v:unknown)=>Buffer.from(JSON.stringify(v)+"\n"),hash=(v:Uint8Array)=>createHash("sha256").update(v).digest("hex");
const parentId=id(3),providerId=id(4),workspace={canonicalPath:"/TEST/old/workspace",dev:"7",ino:"9"},
  binding={version:2,jobId:"TEST-old",jobRootDir:"/TEST/old",workspace,installationId:id(1),runtimeSha:"a".repeat(40),grantDigest:"b".repeat(64)},
  attempt={attemptId:id(5),epoch:2,launch:{installationId:id(1),bootId:id(2),runtimeSha:binding.runtimeSha,grantDigest:binding.grantDigest,startId:parentId,unit:`subscription-runtime-ordinary-${parentId}.service`}},
  parent={schemaVersion:1,installationId:id(1),jobId:binding.jobId,jobRootDir:binding.jobRootDir,workspacePath:workspace.canonicalPath,activationGeneration:1,
    bootId:id(2),supervisorId:"12:34",originSha256:"c".repeat(64),unit:attempt.launch.unit,controlGroup:"/TEST/old",creatorId:"TEST-creator",creatorPidBirth:"12:34",grantSha256:binding.grantDigest},
  provider={...parent,activationGeneration:2,unit:`subscription-runtime-hosted-${providerId}.service`,controlGroup:`/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/subscription-runtime-hosted-${providerId}.service`};
const recipe={TEST:"original recipe"},inventory={supervisorUnit:"TEST-supervisor",units:[{name:"TEST-supervisor",controlGroup:"/TEST/supervisor"}],ordinaryCreators:[{creatorId:parent.creatorId,jobId:binding.jobId,jobRootDir:binding.jobRootDir,workspacePath:workspace.canonicalPath,launch:recipe}]};
const inode=(path:string)=>BigInt("0x"+hash(Buffer.from(path)).slice(0,10));
const reference=(path:string)=>({path,identity:{dev:"7",ino:String(inode(path))},sha256:hash(f.files.get(path)!)});
function stat(path:string){const bytes=f.files.get(path),directory=!bytes;return {dev:7n,ino:inode(path),uid:0n,gid:0n,mode:directory?0o700n:0o600n,nlink:1n,size:BigInt(bytes?.length??0),mtimeNs:1n,ctimeNs:1n,isDirectory:()=>directory,isFile:()=>!directory};}
function pathOf(path:string){const match=/^\/proc\/self\/fd\/(\d+)(\/.*)?$/.exec(path);if(!match)return path;const fd=f.fds.get(Number(match[1]));if(!fd)throw Error("TEST unknown fd");return fd.path==="/"?(match[2]??"/"):fd.path+(match[2]??"");}
function actual(){return {installation:{installationId:id(1),runtimeSha:binding.runtimeSha,inventorySha256:hash(enc(inventory))},activation:f.activation,originSha256:parent.originSha256,birth:{jobRootDir:binding.jobRootDir,workspacePath:workspace.canonicalPath}};}
vi.mock("node:fs",async original=>({...await original<typeof import("node:fs")>(),
  openSync:(path:string)=>{const fd=f.nextFd++;f.fds.set(fd,{path:pathOf(path),position:0});return fd;},closeSync:(fd:number)=>{f.fds.delete(fd);},
  fstatSync:(fd:number)=>stat(f.fds.get(fd)!.path),lstatSync:(path:string)=>{if(/^\/proc\/\d+$/.test(path))throw Object.assign(Error("TEST waited proxy"),{code:"ENOENT"});return stat(pathOf(path));},
  readSync:(fd:number,target:Buffer,offset:number,length:number)=>{const own=f.fds.get(fd)!,bytes=f.files.get(own.path);if(!bytes)throw Error("TEST missing protected file");const count=bytes.copy(target,offset,own.position,own.position+length);own.position+=count;return count;},
}));
vi.mock("../hosted-dependency-root-physical-facts",()=>({rootDescriptorPhysicalInfo:()=>({mountId:"1",flags:1}),readHostedDependencyRootDirectoryPin:()=>({mountId:"1"})}));
vi.mock("../hosted-current-dependency-origin",()=>({CurrentHostedDependencyOriginKind:{Ordinary:"ordinary",ManagedReadonlyLocal:"readonly"},assertOriginalHostedDependencyPhysicalRecordAccess:(a:symbol)=>{if(a!==f.access)throw Error("TEST foreign access");},assertOriginalHostedDependencyOperatorDescriptors:()=>{}}));
vi.mock("../hosted-dependency-generation-native-scope",()=>({readOriginalHostedDependencyGenerationNativeScope:(context:unknown)=>{if(context!==f.context || f.fail==="scope")throw Error("TEST copied scope");return {facts:{kind:"readonly"}};}}));
vi.mock("../../provider-codex/app-server/adapters/hosted-process-activation",()=>({assertHostedActivationFence:()=>{},assertHostedActivationOperator:()=>{},decodeHostedActivationBytes:(v:Buffer)=>JSON.parse(v.toString()),readHostedActivationBytes:(name:string)=>name==="host-activation.json"?enc(f.activation):f.files.get(root+"/"+name)}));
vi.mock("../../provider-codex/app-server/adapters/hosted-process-descriptors",()=>({assertHostedProcessDescriptors:()=>{}}));
vi.mock("../../provider-codex/app-server/adapters/hosted-dependency-workspace",()=>({hostedDependencyBindingName:()=>"binding.json",readHostedDependencyBinding:()=>binding}));
vi.mock("../hosted-installation-activation",()=>({readHostedOrdinaryBirth:()=>{if(f.activation.phase!=="ordinary")throw Error("TEST live Ordinary required");return actual();}}));
vi.mock("../hosted-installation-origin-facts",()=>({readRetainedOrdinaryBirth:()=>actual()}));
vi.mock("../hosted-dependency-parent-recipe",()=>({readHostedDependencyParentRecipe:()=>{}}));
vi.mock("../hosted-readonly-host-kernel",()=>({readHostedReadonlyHostInventory:()=>inventory,HostedReadonlyHostKernel:class{
  session(){return {hostId:"host",bootId:id(2),supervisorId:"12:34"};}operatorSession(){return this.session();}ordinaryCreatorBirth(){return parent.creatorPidBirth;}
  drainOrdinaryQueue(){f.drains.push("queue");if(f.fail==="queue")throw Error("TEST queue");}confirmOrdinaryDescendants(){f.drains.push("descendants");if(f.fail==="descendants")throw Error("TEST descendants");}}}));
vi.mock("../hosted-readonly-linux-collector",()=>({collectProcessBirth:()=>parent.creatorPidBirth,collectProcessCgroup:()=>"0::/TEST/supervisor",collectUnitNotFound:()=>true}));
vi.mock("../hosted-readonly-epoch-store",()=>({HostedReadonlyEpochStore:class{readEpoch(){return structuredClone(f.epoch);}}}));
vi.mock("../hosted-readonly-dependency-records",()=>({readHostedReadonlyDependencyMaterial:()=>f.material}));
vi.mock("../hosted-readonly-inputs",()=>({readHostedPrivateBytes:(path:string)=>f.files.get(path)??null}));
vi.mock("../hosted-dependency-root-provenance-facts",()=>({parseOrdinaryRootPreparationFacts:()=>({qualification:reference(root+"/"+dependencyToolQualificationRecordName(parentId)),protectedProfile:reference(root+"/dependency-installer-profile.json")})}));
vi.mock("../hosted-dependency-recovery-admission-facts",()=>({readHostedDependencyRecoveryAdmissionFacts:()=>({version:2,execution:{TEST:"original"},unverified:reference(root+"/TEST-unverified.json"),unverifiedRevision:1})}));
import {readOriginalHostedConsumerProviderCompletionForFinal,readHostedOrdinaryProviderCompletionForFinal} from "../hosted-ordinary-provider-failure-recovery";
const fence={held:true as const},put=(name:string,value:unknown)=>{f.files.set(root+"/"+name,enc(value));return reference(root+"/"+name);};
beforeEach(()=>{f.files.clear();f.fds.clear();f.nextFd=10;f.drains=[];f.fail="";
  f.activation={schemaVersion:1,installationId:id(1),hostId:"host",bootId:id(2),supervisorId:"12:34",generation:3,phase:HostedActivationPhase.Exclusive,ordinaryOriginsSha256:"a".repeat(64),exclusiveEnrollmentSha256:"b".repeat(64),ordinaryStarts:[
    {startId:parentId,unit:parent.unit,creatorId:parent.creatorId,originSha256:parent.originSha256,generation:1,state:Row.Terminal},
    {startId:providerId,unit:provider.unit,creatorId:parent.creatorId,originSha256:parent.originSha256,generation:2,state:Row.Terminal}]};
  put("readonly-inventory.json",inventory);const bindingRef=put("binding.json",binding),parentRef=put(`ordinary-starts/${parentId}.json`,parent),providerRef=put(`ordinary-starts/${providerId}.json`,provider);
  const custody=put("TEST-custody.json",{TEST:"original cold custody"});f.epoch={identity:{jobId:"TEST-currentR"},hostId:"host",bootId:id(2),supervisorId:"12:34"};
  f.material={reference:custody,evidence:{kind:DependencyCustodyEvidenceKind.ReadonlyColdBaselineAdoptionV2,candidate:{jobId:binding.jobId,binding:bindingRef},workspace}};
  const currentStart=id(6),currentOrigin=put("TEST-currentR-origin.json",{TEST:"projected original R"});
  f.owner=parseDependencyOwner({version:3,workspace,revision:8,epoch:4,owner:{kind:"consumer",phase:"running",attempt:{attemptId:id(7),epoch:4,launch:{...attempt.launch,kind:DependencyConsumerLaunchKind.ManagedReadonlyLocalV1,startId:currentStart,unit:`subscription-runtime-outer-${currentStart}.service`,association:custody,origin:currentOrigin}}},custodyBinding:custody});put("dependency-owners/7-9.json",f.owner);
  put(`ordinary-completed/${parentId}.json`,{schemaVersion:1,startId:parentId,startSha256:parentRef.sha256,waitStatus:0});put(`ordinary-completed/${providerId}.json`,{schemaVersion:1,startId:providerId,startSha256:providerRef.sha256,waitStatus:0});
  put(`dependency-attempt-fences/${parentId}.json`,{version:1,startId:parentId,attemptId:attempt.attemptId,epoch:attempt.epoch});
  const producer=put(`dependency-reader-starts/${parentId}.json`,{version:1,kind:"ordinary_dependency_reader_v1",origin:parentRef,binding:bindingRef,preclaim:{version:1,workspace,attempt,ownerRevision:2,ownerSha256:"d".repeat(64)},receipt:null,recipeSha256:hash(enc(recipe))}),entry=put(`dependency-reader-entries/${parentId}.json`,{version:1,producer,attempt});
  put(`dependency-root-preparations/${parentId}.json`,{});const qualification=put(dependencyToolQualificationRecordName(parentId),{}),profile=put("dependency-installer-profile.json",{schemaVersion:2}),unverified=put("TEST-unverified.json",{}),
    relation={version:1,parentStartId:parentId,providerStartId:providerId,attemptId:attempt.attemptId,epoch:attempt.epoch,unit:provider.unit,startDigest:providerRef.sha256};put(`dependency-provider-attempts/${providerId}.json`,relation);
  const birth=put(`dependency-managed-provider-starts/${providerId}.json`,{version:4,originKind:"ordinary_dependency_reader_v1",installationId:id(1),runtimeSha:binding.runtimeSha,hostId:"host",bootId:id(2),supervisorId:"12:34",generation:2,parentGeneration:1,unit:provider.unit,providerStartId:providerId,parentStartId:parentId,logicalJobId:binding.jobId,executionJobId:binding.jobId,jobRootDir:binding.jobRootDir,workspace,attempt,originReference:parentRef,ordinaryProviderReference:providerRef,readerProducer:producer,readerEntry:entry,ordinaryRelation:relation,execution:{TEST:"original"},unverified,unverifiedRevision:1,qualification,protectedProfile:profile});
  put(`dependency-ordinary-provider-completions/${providerId}.json`,{schemaVersion:2,parentAttempt:attempt,unit:provider.unit,providerStartId:providerId,providerReference:birth,ordinaryProviderReference:providerRef,parentReference:parentRef,relation,invocationId:"e".repeat(32),proxyBirth:"56:78",waitStatus:0,home:{canonicalPath:binding.jobRootDir+"/home/codex-session-cache/dependency-"+attempt.attemptId,dev:"7",ino:"21",mountId:"1"},use:{accountId:"TEST-account",restoredHash:"f".repeat(64)},terminal:null});
});
const read=()=>readOriginalHostedConsumerProviderCompletionForFinal(f.context as never,fence,providerId,reference(root+`/ordinary-starts/${providerId}.json`).sha256,f.access);
it("original same-workspace current R v3 scope reauthenticates retained C provider and exact native drains",()=>{expect(read().attempt.epoch).toBe(attempt.epoch);expect(f.drains).toEqual(["queue","descendants"]);expect(f.fds.size).toBe(0);});
it.each(["custody","epoch","binding","reserved","scope","queue","descendants"])("refuses historical C provider %s drift",change=>{
  if(change==="custody")f.material.reference={...f.material.reference,sha256:"0".repeat(64)};if(change==="epoch")f.epoch.bootId=id(99);
  if(change==="binding")f.material.evidence.candidate.binding={...f.material.evidence.candidate.binding,sha256:"0".repeat(64)};
  if(change==="reserved")f.activation.ordinaryStarts[0].state=Row.Reserved;f.fail=change;expect(read).toThrow();expect(f.fds.size).toBe(0);
});
it("raw live API cannot borrow private v3 history even in Ordinary phase",()=>{f.activation.phase=HostedActivationPhase.Ordinary;f.activation.exclusiveEnrollmentSha256=null;
  expect(()=>readHostedOrdinaryProviderCompletionForFinal(fence,providerId,reference(root+`/ordinary-starts/${providerId}.json`).sha256)).toThrow();});
