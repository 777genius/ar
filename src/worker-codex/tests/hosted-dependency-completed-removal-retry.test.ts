import * as fs from "node:fs";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { DependencyOwnerKind, DependencyOwnerPhase, parseDependencyOwner } from "@vioxen/subscription-runtime/core";

const state=vi.hoisted(()=>({root:"",owner:undefined as unknown,proof:undefined as unknown,history:undefined as unknown,effects:[] as string[],events:[] as string[],failIdleSync:false,faultObserved:false}));
const policy="/var/lib/subscription-runtime-host-policy/dependency-transactions/";
vi.mock("node:fs",async()=>{
  const actual=await vi.importActual<typeof import("node:fs")>("node:fs");
  return {...actual,fsyncSync:(fd:number)=>{
    const path=actual.readlinkSync(`/proc/self/fd/${fd}`),idle=state.root+"/1-3-23.removal-idle.json";
    if(state.failIdleSync && path===idle){state.faultObserved=true;throw Object.assign(new Error("TEST_idle_fsync_fault"),{code:"EIO"});}
    actual.fsyncSync(fd);
    if(path===idle)state.events.push("idle-file-fsync");
    else if(path===state.root)state.events.push("idle-parent-fsync");
  }};
});
const fixtureNames=new Set(["1-3-23.removal-idle.json","12345678-1234-4234-8234-123456789abc.remove.lock",
  ...["claim","actor","retirement","session-closed"].map(kind=>"23456789-1234-4234-8234-123456789abc.removal-"+kind+".json")]);
function physical(path:string) {
  if(!state.root)throw new Error("TEST fixture not initialized");
  const original=path.startsWith(policy),prefix=original?policy:state.root+"/",name=path.slice(prefix.length);
  if(!path.startsWith(prefix) || !fixtureNames.has(name))throw new Error("TEST unknown protected path");
  return original?state.root+"/"+name:path;
}
vi.mock("../hosted-readonly-inputs",async()=>{
  const actual=await vi.importActual<typeof import("../hosted-readonly-inputs")>("../hosted-readonly-inputs");
  return {...actual,readHostedPrivateBytes:(path:string,max:number)=>actual.readHostedPrivateBytes(physical(path),max)};
});
vi.mock("../hosted-readonly-custody",async()=>{
  const actual=await vi.importActual<typeof import("../hosted-readonly-custody")>("../hosted-readonly-custody");
  return {...actual,createReadonlyPrivateRecord:(path:string,bytes:Buffer)=>actual.createReadonlyPrivateRecord(physical(path),bytes)};
});
vi.mock("../hosted-dependency-legacy-reference-records",async()=>{
  const actual=await vi.importActual<typeof import("../hosted-dependency-legacy-reference-records")>("../hosted-dependency-legacy-reference-records");
  return {...actual,pinReferenceFile:(path:string,max?:number)=>{
    const pin=actual.pinReferenceFile(physical(path),max);return {...pin,reference:{...pin.reference,path}};
  },writeReferenceOnce:(path:string,value:unknown)=>({...actual.writeReferenceOnce(physical(path),value),path})};
});
// Only the preceding authenticated authority/manager boundaries are inert fixtures.
// The actual completion retry, protected bytes, nofollow pin and exclusive writer run.
vi.mock("../hosted-current-dependency-origin",()=>({assertOriginalHostedDependencyPhysicalRecordAccess:()=>{}}));
vi.mock("../../provider-codex/app-server/adapters/hosted-process-activation",()=>({assertHostedActivationFence:()=>{}}));
vi.mock("../hosted-dependency-generation-native-census",()=>({readOriginalHostedDependencyOperatorNativeCensus:()=>true}));
vi.mock("../hosted-readonly-host-kernel",()=>({HostedReadonlyHostKernel:class{operatorSession(){return {};}}}));
vi.mock("../hosted-dependency-removal-history",()=>({readOriginalHostedDependencyRemovalRetirement:()=>state.proof,readOriginalHostedDependencyRemovalIdle:()=>{throw new Error("unexpected idle-owner path");}}));
vi.mock("../hosted-dependency-transactions",async()=>{
  const actual=await vi.importActual<typeof import("../hosted-dependency-transactions")>("../hosted-dependency-transactions");
  return {...actual,readOriginalHostedDependencyRemovalCommittedHistoryWithFence:()=>state.history};
});
vi.mock("../hosted-dependency-removal-lock-release",()=>({
  confirmOriginalHostedDependencyRemovalLockReleased:()=>{state.events.push("release");state.effects.push("confirm");},
  unlinkOriginalHostedDependencyRemovalLock:()=>{state.events.push("release");state.effects.push("unlink");}
}));
vi.mock("../../store-local-file/dependency-environment/local-dependency-owner-store",()=>({LocalDependencyOwnerStore:{open:()=>({
  read:()=>state.owner,close:()=>{},compareAndSwap:(_workspace:unknown,revision:number,next:{revision:number})=>{
    expect((state.owner as {revision:number}).revision).toBe(revision);state.events.push("owner-cas");state.effects.push("owner-cas");state.owner=next;return next;
  }
})}}));
import { tryReleaseOriginalHostedDependencyCompletedRemoval } from "../hosted-dependency-removal-ownership";
import { pinReferenceFile, writeReferenceOnce, encodeReference } from "../hosted-dependency-legacy-reference-records";
import { HostedDependencyRemovalRecordKind as Kind } from "../hosted-dependency-removal-records";
import { HostedDependencyRemovalDisposition } from "../hosted-dependency-removal-effects";

// Native protected-file cases must report SKIP outside an actual root Linux fixture.
// No assertion here establishes the mocked upstream producer/census as genuine.
describe.skipIf(process.platform!=="linux" || process.getuid?.()!==0)("completed removal immutable idle replay",()=>{
  beforeEach(()=>{state.root=fs.mkdtempSync("/run/TEST-completed-removal-retry-");fs.chmodSync(state.root,0o700);state.effects=[];state.events=[];state.failIdleSync=false;state.faultObserved=false;});
  afterEach(()=>{fs.rmSync(state.root,{recursive:true,force:true});});
  function fixture(lockPresent=false) {
    const removal="23456789-1234-4234-8234-123456789abc",eviction="12345678-1234-4234-8234-123456789abc";
    const workspace={canonicalPath:"/TEST-completed-retry/workspace",dev:"1",ino:"3"};
    const claimed=parseDependencyOwner({version:2,workspace,revision:21,epoch:5,owner:{kind:DependencyOwnerKind.Maintenance,phase:DependencyOwnerPhase.ExclusiveMutation,
      attempt:{operationId:removal,epoch:5,host:{installationId:"45678901-1234-4234-8234-123456789abc",bootId:"34567890-1234-4234-8234-123456789abc",
        supervisorId:"100:200",runtimeSha:"b".repeat(40),inventoryDigest:"d".repeat(64),grantDigest:"c".repeat(64)}}}});
    if(!claimed.owner)throw new Error("fixture owner");
    const fenced=parseDependencyOwner({...claimed,revision:22,owner:{...claimed.owner,phase:DependencyOwnerPhase.Fenced}}),next=parseDependencyOwner({...fenced,revision:23,owner:null});
    const reference=writeReferenceOnce(policy+removal+".removal-claim.json",{purpose:"TEST_inert_preceding_claim"}),
      actorReference=writeReferenceOnce(policy+removal+".removal-actor.json",{purpose:"TEST_inert_preceding_actor"}),
      retirement=writeReferenceOnce(policy+removal+".removal-retirement.json",{purpose:"TEST_inert_preceding_retirement"}),
      completion=writeReferenceOnce(policy+removal+".removal-session-closed.json",{version:1,kind:Kind.SessionClosed,claim:reference,actor:actorReference,disposition:HostedDependencyRemovalDisposition.Removed,removedEntries:7});
    const lockPath=policy+eviction+".remove.lock",lock=writeReferenceOnce(lockPath,{purpose:"TEST_inert_original_lock"});
    if(!lockPresent)fs.unlinkSync(physical(lockPath));
    const binding={workspace},absent={receipt:{operationId:eviction}},selected={reference,claim:{claimed,binding,absent}};
    state.owner=fenced;state.proof={selected,actorReference,retirement,lock};state.history={actual:{binding},committed:absent};
    const path=policy+"1-3-23.removal-idle.json",idle={version:1,kind:Kind.Idle,claim:reference,retirement,completion,fenced,released:next};
    const run=()=>tryReleaseOriginalHostedDependencyCompletedRemoval({held:true},"TEST-completed-retry",12,Symbol("TEST-boundary"));
    return {path,idle,fenced,next,run,eviction};
  }
  for(const lockPresent of [false,true])it(`reuses exact durable idle without replacing its inode (lock present=${lockPresent})`,()=>{
    const f=fixture(lockPresent),before=writeReferenceOnce(f.path,f.idle),bytes=fs.readFileSync(physical(f.path));
    state.events=[];state.failIdleSync=true;
    expect(()=>f.run()).toThrow();expect(state.owner).toEqual(f.fenced);expect(state.effects).toEqual([]);
    expect(pinReferenceFile(f.path).reference).toEqual(before);expect(fs.readFileSync(physical(f.path))).toEqual(bytes);
    state.failIdleSync=false;state.events=[];
    expect(f.run()).toMatchObject({operationId:f.eviction,removedEntries:7});
    expect(state.faultObserved).toBe(true);
    const release=state.events.indexOf("release"),cas=state.events.indexOf("owner-cas"),leafSync=state.events.indexOf("idle-file-fsync"),parentSync=state.events.indexOf("idle-parent-fsync");
    expect(leafSync).toBeGreaterThanOrEqual(0);expect(parentSync).toBeGreaterThanOrEqual(0);
    expect(leafSync).toBeLessThan(release);expect(parentSync).toBeLessThan(release);expect(release).toBeLessThan(cas);
    expect(pinReferenceFile(f.path).reference).toEqual(before);expect(fs.readFileSync(physical(f.path))).toEqual(bytes);
    expect(state.owner).toEqual(f.next);expect(state.effects).toContain(lockPresent?"unlink":"confirm");expect(state.effects.filter(e=>e==="owner-cas")).toHaveLength(1);
  });
  it("creates missing idle only from completed proof",()=>{
    const f=fixture();expect(fs.existsSync(physical(f.path))).toBe(false);expect(f.run()).toMatchObject({removedEntries:7});
    expect(pinReferenceFile(f.path).bytes).toEqual(encodeReference(f.idle));expect(state.owner).toEqual(f.next);
  });
  for(const missing of ["retirement","session-closed"])it(`does not create idle without actual ${missing} record`,()=>{
    const f=fixture();fs.unlinkSync(physical(policy+"23456789-1234-4234-8234-123456789abc.removal-"+missing+".json"));
    expect(f.run()).toBeUndefined();expect(fs.existsSync(physical(f.path))).toBe(false);expect(state.owner).toEqual(f.fenced);expect(state.effects).toEqual([]);
  });
  for(const unsafe of ["symlink","hardlink","mode"])it(`preserves unsafe existing ${unsafe} idle without effects`,()=>{
    const f=fixture(),foreign=state.root+"/foreign.json";fs.writeFileSync(foreign,encodeReference(f.idle),{mode:0o600});
    if(unsafe==="symlink")fs.symlinkSync(foreign,physical(f.path));
    else if(unsafe==="hardlink")fs.linkSync(foreign,physical(f.path));
    else fs.writeFileSync(physical(f.path),encodeReference(f.idle),{mode:0o644});
    const before=fs.lstatSync(physical(f.path)),bytes=fs.readFileSync(foreign);
    expect(()=>f.run()).toThrow();expect(state.owner).toEqual(f.fenced);expect(state.effects).toEqual([]);
    const after=fs.lstatSync(physical(f.path));expect({dev:after.dev,ino:after.ino,mode:after.mode,nlink:after.nlink}).toEqual({dev:before.dev,ino:before.ino,mode:before.mode,nlink:before.nlink});
    expect(fs.readFileSync(foreign)).toEqual(bytes);
  });
  for(const conflict of ["claim","retirement","completion","fenced","released","schema","noncanonical"] as const)
    it(`preserves conflicting existing ${conflict} record and owner without release effects`,()=>{
      const f=fixture(),bad=structuredClone(f.idle);
      if(conflict==="claim" || conflict==="retirement" || conflict==="completion")bad[conflict]={...bad[conflict],sha256:"f".repeat(64)};
      else if(conflict==="fenced" || conflict==="released")bad[conflict]={...bad[conflict],revision:99};
      else if(conflict==="schema")bad.version=2;
      const before=writeReferenceOnce(f.path,bad);
      if(conflict==="noncanonical")fs.writeFileSync(physical(f.path),JSON.stringify(bad,null,2)+"\n");
      const snapshot=pinReferenceFile(f.path),bytes=fs.readFileSync(physical(f.path));
      expect(()=>f.run()).toThrow();expect(state.owner).toEqual(f.fenced);expect(state.effects).toEqual([]);
      expect(pinReferenceFile(f.path).reference).toEqual(snapshot.reference);expect(fs.readFileSync(physical(f.path))).toEqual(bytes);
      expect(snapshot.reference.identity).toEqual(before.identity);
    });
});
