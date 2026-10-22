import {beforeEach,expect,it,vi} from "vitest";
import {createHash} from "node:crypto";
import {DependencyConsumerLaunchKind} from "@vioxen/subscription-runtime/core";
import type {DependencySourceBindingRecord,DependencySourceBindingCompletionVerifier} from "../../worker-core/dependency-environment/ports/dependency-source-binding";
const io=vi.hoisted(()=>({files:new Map<string,Buffer>(),drain:vi.fn()}));
vi.mock("node:fs",async original=>({...await original<typeof import("node:fs")>(),mkdirSync:vi.fn(),lstatSync:()=>({isDirectory:()=>true,isSymbolicLink:()=>false,uid:0,mode:0o700}),openSync:()=>900,fsyncSync:vi.fn(),closeSync:vi.fn()}));
vi.mock("../hosted-readonly-authority",()=>({assertReadonlyHostOperator:vi.fn()}));
vi.mock("../hosted-readonly-inputs",()=>({readHostedPrivateBytes:(path:string)=>io.files.get(path)}));
vi.mock("../hosted-dependency-installer",()=>({assertHostedDependencyInstallerAttemptDrained:io.drain}));
vi.mock("../../worker-local/dependency-environment/dependency-source-binding",async original=>({...await original<typeof import("../../worker-local/dependency-environment/dependency-source-binding")>(),LocalDependencySourceBindingStore:class {
 constructor(_root:string,readonly completion:DependencySourceBindingCompletionVerifier){}
 publish(record:DependencySourceBindingRecord){this.completion.assertInstallerCompletion(record);}
}}));
import {publishHostedDependencySourceBinding} from "../hosted-dependency-receipts";
import {hostedDependencyInstallerRoot} from "../hosted-dependency-installer-recipe";
const uuid=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const ref=(n:number)=>({path:`/TEST/protected-${n}`,identity:{dev:"8",ino:String(n)},sha256:String(n).repeat(64)});
const encode=(v:unknown)=>Buffer.from(JSON.stringify(v)+"\n");const hash=(v:Buffer)=>createHash("sha256").update(v).digest("hex");
function fixture(kind:"legacy"|"custody"|"managed"){
 const launch={installationId:uuid(1),bootId:uuid(2),startId:uuid(3),runtimeSha:"a".repeat(40),grantDigest:"b".repeat(64),unit:`subscription-runtime-ordinary-${uuid(3)}.service`};
 const selected=kind==="legacy"?launch:{...launch,kind:kind==="custody"?DependencyConsumerLaunchKind.OrdinaryReadonlySuccessorV1:DependencyConsumerLaunchKind.ManagedReadonlyLocalV1,unit:kind==="managed"?`subscription-runtime-outer-${uuid(3)}.service`:launch.unit,association:ref(1),origin:ref(2)};
 const attempt={attemptId:uuid(4),epoch:2,launch:selected},startId=uuid(5),unit=`subscription-runtime-installer-${startId}.service`,directory=`${hostedDependencyInstallerRoot}/${startId}`,workspace={canonicalPath:"/TEST/workspace",dev:"8",ino:"9"};
 const start={schemaVersion:2,recipe:"npm_local_no_lifecycle_v1",startId,unit,workspace,attempt,installKey:"d".repeat(64),closureDigest:"e".repeat(64),inputSha256:"f".repeat(64),profileSha256:"a".repeat(64)};
 const creator=encode({TEST:"creator DATA only"}),startBytes=encode(start),completion=encode({schemaVersion:1,startId,startSha256:hash(startBytes),creatorSha256:hash(creator),status:0,creatorWaitReturned:true});
 const mappingPath=`${hostedDependencyInstallerRoot}/attempt-${attempt.attemptId}.json`;
 io.files.set(mappingPath,encode({schemaVersion:1,startId,unit,attempt}));io.files.set(`${directory}/start.json`,startBytes);io.files.set(`${directory}/creator.json`,creator);io.files.set(`${directory}/creator-completion.json`,completion);
 // This focused DATA fixture invokes the real adapter completion callback via
 // a store test double. It does not prove store/output/original physical authority.
 const record={generation:attempt.attemptId,workspace,installKey:start.installKey,closureDigest:start.closureDigest,installerCompletionSha256:hash(completion)} as DependencySourceBindingRecord;
 return {record,attempt,start,directory,mappingPath};
}
beforeEach(()=>{io.files.clear();io.drain.mockReset();});
it.each(["legacy","custody","managed"] as const)("keeps the exact %s attempt through completion and drain",kind=>{const f=fixture(kind);expect(()=>publishHostedDependencySourceBinding(f.record)).not.toThrow();expect(io.drain).toHaveBeenCalledExactlyOnceWith(f.attempt);});
it("rejects an extra launch key before drain",()=>{const f=fixture("custody");const value=JSON.parse(io.files.get(f.mappingPath)!.toString());value.attempt.launch.callerGrant=true;io.files.set(f.mappingPath,encode(value));expect(()=>publishHostedDependencySourceBinding(f.record)).toThrow();expect(io.drain).not.toHaveBeenCalled();});
it("rejects another mapping generation before drain",()=>{const f=fixture("custody");const value=JSON.parse(io.files.get(f.mappingPath)!.toString());value.attempt.attemptId=uuid(6);io.files.set(f.mappingPath,encode(value));expect(()=>publishHostedDependencySourceBinding(f.record)).toThrow();expect(io.drain).not.toHaveBeenCalled();});
it("rejects a start attempt splice before drain",()=>{const f=fixture("custody");f.start.attempt={...f.attempt,epoch:3};io.files.set(`${f.directory}/start.json`,encode(f.start));expect(()=>publishHostedDependencySourceBinding(f.record)).toThrow();expect(io.drain).not.toHaveBeenCalled();});
it("propagates actual drain failure",()=>{const f=fixture("custody"),error=new Error("drain Held");io.drain.mockImplementation(()=>{throw error;});expect(()=>publishHostedDependencySourceBinding(f.record)).toThrow(error);});
