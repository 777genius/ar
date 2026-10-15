import {beforeEach,expect,it,vi} from "vitest";
import {createHash} from "node:crypto";
import {DependencyConsumerLaunchKind} from "@vioxen/subscription-runtime/core";
import {DependencyInstallProfile} from "../../worker-core/dependency-environment/domain/dependency-install-key";
import {encodeDependencySourceBindingOutputBody} from "../../worker-core/dependency-environment/domain/dependency-source-binding-record";
import type {DependencyLocalOutputEvidence,DependencySourceBindingRecordV2} from "../../worker-core/dependency-environment/ports/dependency-source-binding";
const io=vi.hoisted(()=>({files:new Map<string,Buffer>(),drain:vi.fn(),reads:vi.fn()}));
vi.mock("node:fs",async original=>({...await original<typeof import("node:fs")>(),lstatSync:()=>({isDirectory:()=>true,uid:0n,mode:0o40700n,dev:8n,ino:90n})}));
vi.mock("../hosted-readonly-authority",()=>({assertReadonlyHostOperator:vi.fn()}));
vi.mock("../hosted-readonly-inputs",()=>({readHostedPrivateBytes:(path:string)=>io.files.get(path)}));
vi.mock("../hosted-dependency-installer",()=>({assertHostedDependencyInstallerAttemptDrained:io.drain}));
vi.mock("../../worker-local/dependency-environment/dependency-source-binding",async original=>({...await original<typeof import("../../worker-local/dependency-environment/dependency-source-binding")>(),readDependencyProtectedReference:io.reads}));
import {assertHostedDependencyLocalOutputProof} from "../hosted-dependency-output-proof";
import {hostedDependencyInstallerRoot} from "../hosted-dependency-installer-recipe";
const uuid=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const ref=(n:number)=>({path:`/TEST/protected-${n}`,identity:{dev:"8",ino:String(n)},sha256:String(n).repeat(64)});
const encode=(v:unknown)=>Buffer.from(JSON.stringify(v)+"\n");const sha=(v:Buffer)=>createHash("sha256").update(v).digest("hex");
function fixture(kind:"legacy"|"custody"|"managed",options:{startAttempt?:(attempt:unknown)=>unknown;completionStatus?:number;terminalIno?:string}={}){
 const launch={installationId:uuid(1),bootId:uuid(2),startId:uuid(3),runtimeSha:"a".repeat(40),grantDigest:"b".repeat(64),unit:`subscription-runtime-ordinary-${uuid(3)}.service`};
 const selected=kind==="legacy"?launch:{...launch,kind:kind==="custody"?DependencyConsumerLaunchKind.OrdinaryReadonlySuccessorV1:DependencyConsumerLaunchKind.ManagedReadonlyLocalV1,unit:kind==="managed"?`subscription-runtime-outer-${uuid(3)}.service`:launch.unit,association:ref(1),origin:ref(2)};
 const attempt={attemptId:uuid(4),epoch:2,launch:selected},startId=uuid(5),unit=`subscription-runtime-installer-${startId}.service`,directory=`${hostedDependencyInstallerRoot}/${startId}`,workspace={canonicalPath:"/TEST/workspace",dev:"8",ino:"9"},tree={dev:"8",ino:"10"};
 const start={schemaVersion:2,recipe:"npm_local_no_lifecycle_v1",startId,unit,workspace,attempt:options.startAttempt?options.startAttempt(attempt):attempt,installKey:"d".repeat(64),closureDigest:"e".repeat(64),inputSha256:"f".repeat(64),profileSha256:"a".repeat(64)};
 const put=(name:string,value:unknown)=>{const path=`${directory}/${name}`,bytes=encode(value);io.files.set(path,bytes);return {path,identity:{dev:"8",ino:String(100+io.files.size)},sha256:sha(bytes)};};
 const startRef=put("start.json",start),creator=put("creator.json",{TEST:"creator DATA only"}),completion=put("creator-completion.json",{schemaVersion:1,startId,startSha256:startRef.sha256,creatorSha256:creator.sha256,status:options.completionStatus??0,creatorWaitReturned:true}),terminal=put("terminal.json",{schemaVersion:1,startId,completionSha256:completion.sha256,emptySha256:"b".repeat(64),output:{dev:tree.dev,ino:options.terminalIno??tree.ino}});
 const directoryPin=(path:string,ino:string)=>({path,dev:"8",ino,mode:String(0o40700),mountId:"7"});
 const body={version:2 as const,profile:DependencyInstallProfile.TestNpmLocalNoLifecycleV1 as const,generation:attempt.attemptId,workspace,coverageRevision:"TEST-coverage",installKey:start.installKey,tree,manifestDigest:"c".repeat(64),operationId:attempt.attemptId,installerCompletionSha256:completion.sha256,closureDigest:start.closureDigest,sourceLinks:[],directories:[directoryPin("","9")],ancestors:[directoryPin("/","1"),directoryPin("/TEST","2")]};
 const evidence:DependencyLocalOutputEvidence={version:1,profile:body.profile,generation:body.generation,operationId:body.operationId,workspace,coverageRevision:body.coverageRevision,installKey:body.installKey,closureDigest:body.closureDigest,inputSha256:start.inputSha256,profileSha256:start.profileSha256,start:startRef,creator,completion,terminal,tree,manifestVersion:2,manifestDigest:body.manifestDigest,manifestPlacementRevision:"d".repeat(64),verifiedBindingSha256:sha(Buffer.from(encodeDependencySourceBindingOutputBody(body)))};
 const record:DependencySourceBindingRecordV2={...body,outputReference:put("verified-local-output.json",evidence)};
 const mappingPath=`${hostedDependencyInstallerRoot}/attempt-${attempt.attemptId}.json`;io.files.set(mappingPath,encode({schemaVersion:1,startId,unit,attempt}));return {record,attempt,mappingPath};
}
// Real record/evidence/binding parsers and the real hosted output adapter run.
// Protected IO and drain are DATA boundary doubles, never original/native proof.
beforeEach(()=>{io.files.clear();io.drain.mockReset();io.reads.mockReset().mockImplementation((reference:{path:string;sha256:string})=>{const bytes=io.files.get(reference.path);if(!bytes||sha(bytes)!==reference.sha256)throw new Error("TEST protected reference mismatch");return bytes;});});
it.each(["legacy","custody","managed"] as const)("keeps the exact %s mapping and start attempt through output proof and drain",kind=>{const f=fixture(kind);expect(()=>assertHostedDependencyLocalOutputProof(f.record)).not.toThrow();expect(io.drain).toHaveBeenCalledExactlyOnceWith(f.attempt);expect(io.reads).toHaveBeenCalledTimes(10);});
it("rejects an unknown mapping launch kind before drain",()=>{const f=fixture("custody"),value=JSON.parse(io.files.get(f.mappingPath)!.toString());value.attempt.launch.kind="caller-grant";io.files.set(f.mappingPath,encode(value));expect(()=>assertHostedDependencyLocalOutputProof(f.record)).toThrow();expect(io.drain).not.toHaveBeenCalled();});
it("rejects extra mapping launch keys before drain",()=>{const f=fixture("custody"),value=JSON.parse(io.files.get(f.mappingPath)!.toString());value.attempt.launch.callerGrant=true;io.files.set(f.mappingPath,encode(value));expect(()=>assertHostedDependencyLocalOutputProof(f.record)).toThrow();expect(io.drain).not.toHaveBeenCalled();});
it("rejects extra start launch keys even when its protected chain is rehashed",()=>{const f=fixture("custody",{startAttempt:attempt=>{const value=JSON.parse(JSON.stringify(attempt));value.launch.callerGrant=true;return value;}});expect(()=>assertHostedDependencyLocalOutputProof(f.record)).toThrow();expect(io.drain).not.toHaveBeenCalled();});
it("rejects a strict valid but spliced start attempt",()=>{const f=fixture("custody",{startAttempt:attempt=>({...JSON.parse(JSON.stringify(attempt)),epoch:3})});expect(()=>assertHostedDependencyLocalOutputProof(f.record)).toThrow();expect(io.drain).not.toHaveBeenCalled();});
it("preserves exact successful completion requirement",()=>{const f=fixture("custody",{completionStatus:1});expect(()=>assertHostedDependencyLocalOutputProof(f.record)).toThrow();expect(io.drain).not.toHaveBeenCalled();});
it("preserves terminal output tree identity join",()=>{const f=fixture("custody",{terminalIno:"11"});expect(()=>assertHostedDependencyLocalOutputProof(f.record)).toThrow();expect(io.drain).not.toHaveBeenCalled();});
it("propagates actual drain failure",()=>{const f=fixture("custody"),error=new Error("drain Held");io.drain.mockImplementation(()=>{throw error;});expect(()=>assertHostedDependencyLocalOutputProof(f.record)).toThrow(error);});
it("rechecks original mapping bytes after drain",()=>{const f=fixture("custody");io.drain.mockImplementation(()=>io.files.set(f.mappingPath,encode({changed:true})));expect(()=>assertHostedDependencyLocalOutputProof(f.record)).toThrow();expect(io.drain).toHaveBeenCalledOnce();});

import {parseDependencyConsumerAttempt} from "@vioxen/subscription-runtime/core";
it.each(["legacy","custody","managed"] as const)("strict DATA parser retains current %s shape",kind=>{const f=fixture(kind);expect(parseDependencyConsumerAttempt(f.attempt)).toEqual(f.attempt);});
it("strict DATA parser rejects unknown launch kind",()=>{const f=fixture("custody");expect(()=>parseDependencyConsumerAttempt({...f.attempt,launch:{...f.attempt.launch,kind:"unknown"}})).toThrow();});
it("strict DATA parser rejects zero and unsafe epochs",()=>{const f=fixture("legacy");for(const epoch of [0,-1,Number.MAX_SAFE_INTEGER+1])expect(()=>parseDependencyConsumerAttempt({...f.attempt,epoch})).toThrow();});
it("strict DATA parser rejects a getter without invoking it",()=>{const f=fixture("custody"),getter=vi.fn(()=>f.attempt.launch);const value={...f.attempt};Object.defineProperty(value,"launch",{enumerable:true,get:getter});expect(()=>parseDependencyConsumerAttempt(value)).toThrow();expect(getter).not.toHaveBeenCalled();});
it("strict DATA parser rejects malformed protected reference",()=>{const f=fixture("custody");expect(()=>parseDependencyConsumerAttempt({...f.attempt,launch:{...f.attempt.launch,origin:{path:"/TEST",identity:{dev:"8",ino:"2"},sha256:"bad"}}})).toThrow();});
it("strict DATA parser rejects mismatched unit and start",()=>{const f=fixture("managed");expect(()=>parseDependencyConsumerAttempt({...f.attempt,launch:{...f.attempt.launch,unit:`subscription-runtime-outer-${uuid(8)}.service`}})).toThrow();});
