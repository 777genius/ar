import { sdkRecipe } from "../../provider-codex/tests/hosted-dependency-sdk-recipe.fixture";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { HostedInventoryCategory, type HostedInventoryV5 } from "../../core/host-infrastructure/host-inventory";
import { readCurrentHostedDependencySignedParentRecipe } from "../hosted-dependency-current-facts";
import { CurrentHostedDependencyOriginKind, type CurrentHostedDependencyOriginFacts } from "../hosted-current-dependency-origin";
const state = vi.hoisted(() => ({ root: "", snapshots: new Map<string, Buffer>() }));
const policy = "/var/lib/subscription-runtime-host-policy";
vi.mock("../hosted-readonly-inputs", async original => ({ ...await original<typeof import("../hosted-readonly-inputs")>(),
  readHostedPrivateBytes: (path: string) => state.snapshots.get(path) }));
vi.mock("node:fs", async original => {
  const real = await original<typeof import("node:fs")>();
  const local = (p: string) => p.startsWith(policy + "/") ? state.root + p.slice(policy.length) :
    [policy,"/var/lib","/var","/"].includes(p) ? state.root : p;
  const stat = <T extends { uid:number|bigint }>(s:T):T => Object.assign(Object.create(Object.getPrototypeOf(s)),s,
    {uid:typeof s.uid === "bigint" ? 0n : 0});
  return { ...real,
    lstatSync: (p:string,o?:{bigint?:boolean}) => stat(real.lstatSync(local(p),o as {bigint:true})),
    fstatSync: (fd:number,o?:{bigint?:boolean}) => stat(real.fstatSync(fd,o as {bigint:true})),
    openSync: (p:string,flags:number) => real.openSync(local(p),flags),
  };
});
const job="/var/lib/subscription-runtime-host-policy/dependency-test-jobs/jobs/TEST-parent",workspace=job+"/workspace";
const launch={command:process.execPath,args:["/fixture/codex-goal-cli.js","run","--task-id","TEST-reader","--job-root",job,
  "--workspace",workspace,"--prompt",job+"/prompt","--auth-root",job+"/auth"],cwd:workspace};
function inventory(count=300):HostedInventoryV5 {
  const units=Array.from({length:count},(_,i)=>({category:i===0?HostedInventoryCategory.Supervisor:HostedInventoryCategory.Borrowed,
    name:`fixture-${i}.service`,aliases:[],controlGroup:`/fixture-${i}.service`,fragmentPath:`/fixture/fixture-${i}.service`,
    fragmentSha256:"a".repeat(64),dropIns:[],loadState:"loaded",activeState:i===0?"active":"inactive",unitFileState:"static",
    invocationId:i===0?"c".repeat(32):"",mainPidBirth:i===0?"100:200":null,job:"",delegate:false as const}));
  return {schemaVersion:5,hostId:"d".repeat(32),bootId:"11111111-1111-1111-1111-111111111111",supervisorUnit:units[0]!.name,units,
    cgroups:[{path:"",parent:null,ownerUnit:null,dev:"1",ino:"1",members:[]},...units.map((u,i)=>({path:u.controlGroup,parent:"",ownerUnit:u.name,
      dev:"1",ino:String(i+2),members:i===0?[{birth:"100:200",controlGroup:u.controlGroup}]:[]}))],activators:[],
    supervisor:{birth:"100:200",executable:{path:process.execPath,sha256:"e".repeat(64)},bootstrap:{path:"/fixture/bootstrap.js",sha256:"f".repeat(64)},
      operationId:"11111111-1111-1111-1111-111111111111",workEndEpochMs:1000,cleanupEndEpochMs:2000},
    ordinaryCreators:[{creatorId:"fixture",jobId:"TEST-parent",jobRootDir:job,workspacePath:workspace,launch}],disabledCreators:[],runtimeLaunch:launch,
    systemBusInfrastructure:{},collectorProfile:{path:policy+"/fd-collector-profile.v1.json",sha256:"a".repeat(64)}};
}
function facts(value:unknown):CurrentHostedDependencyOriginFacts {
  const bytes=Buffer.from(JSON.stringify(value)+"\n");writeFileSync(state.root+"/readonly-inventory.json",bytes,{mode:0o600});
  return {kind:CurrentHostedDependencyOriginKind.Ordinary,ordinary:{installation:{inventorySha256:createHash("sha256").update(bytes).digest("hex")},
    start:{creatorId:"fixture",jobId:"TEST-parent",jobRootDir:job,workspacePath:workspace}}} as unknown as CurrentHostedDependencyOriginFacts;
}
let originalEnvironment:NodeJS.ProcessEnv;
beforeEach(()=>{state.snapshots.clear();state.root=mkdtempSync(tmpdir()+"/pr271-reader-seam-");originalEnvironment={...process.env};
 for(const key of Object.keys(process.env))delete process.env[key];process.env.PATH="/usr/bin:/bin";});
afterEach(()=>{for(const key of Object.keys(process.env))delete process.env[key];Object.assign(process.env,originalEnvironment);rmSync(state.root,{recursive:true,force:true});});
describe("selected original revision5 dependency reader",()=>{
 it("reads a full revision5 inventory above the legacy ceiling and retains the signed task recipe",()=>{
  const selected=facts(inventory());expect(readCurrentHostedDependencySignedParentRecipe(selected)).toEqual(launch);
 });
 it("keeps the raw installed SDK tuple for original producer digest equality",()=>{
  const raw = sdkRecipe(state.snapshots, job), value = inventory(2);
  const selected = facts({...value,ordinaryCreators:[{...value.ordinaryCreators[0]!,launch:raw}],runtimeLaunch:raw});
  expect(readCurrentHostedDependencySignedParentRecipe(selected)).toEqual(raw);
 });
 it("rejects malformed5 and a changed installed inventory hash",()=>{
  expect(()=>readCurrentHostedDependencySignedParentRecipe(facts({...inventory(2),foreign:true}))).toThrow();
  const selected=facts(inventory(2));writeFileSync(state.root+"/readonly-inventory.json",Buffer.from(JSON.stringify(inventory(3))+"\n"));
  expect(()=>readCurrentHostedDependencySignedParentRecipe(selected)).toThrow();
 });
});
