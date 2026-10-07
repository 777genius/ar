import { describe, expect, it } from "vitest";
import { DependencyGenerationContinuityKind as Kind, parseDependencyGenerationContinuity,
  assertDependencyGenerationBaselineTransition, DependencyOwnerKind, DependencyOwnerPhase,
  parseDependencyOwner, type DependencyOwnerRecord, type DependencyGenerationBaseline } from "@vioxen/subscription-runtime/core";
import { claimDependencyConsumer, markDependencyConsumerRunning, fenceDependencyConsumer } from "../application/dependency-consumer-ownership";
import type { DependencyOwnerStore } from "../ports/dependency-owner-store";

const operationId="11111111-1111-4111-8111-111111111111";
const nextOperation="22222222-2222-4222-8222-222222222222";
const workspace={canonicalPath:"/jobs/TEST-one/workspace",dev:"1",ino:"2"};
const reference=(name:string,ino:string)=>({path:`/private/${name}`,identity:{dev:"1",ino},sha256:"a".repeat(64)});
const baseline:DependencyGenerationBaseline={version:1,kind:Kind.BaselineAuthenticatedV1,operationId,generation:operationId,
  readyRevision:2,previousReady:reference("ready","3"),baseline:reference("baseline","4"),writerBarrier:reference("barrier","5")};
const launch={installationId:operationId,bootId:operationId,runtimeSha:"b".repeat(40),grantDigest:"c".repeat(64),
  startId:operationId,unit:`subscription-runtime-ordinary-${operationId}.service`};
const idle=()=>parseDependencyOwner({version:2,workspace,revision:3,epoch:1,owner:null,generationContinuity:baseline});
type ProtectedOwner=Extract<DependencyOwnerRecord,{version:2|3}>;
function protectedOwner(value:DependencyOwnerRecord):ProtectedOwner {if(value.version===1)throw Error("fixture");return value;}
function transition(previous:DependencyOwnerRecord,next:DependencyOwnerRecord):void {
  assertDependencyGenerationBaselineTransition(protectedOwner(previous),protectedOwner(next));
}
describe("baseline continuity scheduling contract",()=>{
  // These ports verify domain scheduling only; none is a protected origin,
  // physical barrier, native discharge or positive adapter authority fixture.
  it("preserves the exact baseline across the REAL claim, Running and fencing operations",()=>{
    let record=idle();const captured:DependencyOwnerRecord[]=[];
    const store:DependencyOwnerStore={read:()=>record,compareAndSwap:(_workspace,expected,next)=>{
      expect(expected).toBe(record.revision);transition(record,next);captured.push(record);record=parseDependencyOwner(next);return record;
    }};
    const attempt=claimDependencyConsumer(store,workspace,launch,nextOperation);
    markDependencyConsumerRunning(store,workspace,attempt,"10");fenceDependencyConsumer(store,workspace,attempt);
    expect(record.epoch).toBe(2);expect(record.owner?.phase).toBe(DependencyOwnerPhase.Fenced);
    expect(protectedOwner(record).generationContinuity).toEqual(baseline);
    const released=parseDependencyOwner({...record,revision:record.revision+1,owner:null,
      activity:{lastEntry:record.activity!.lastEntry,lastRelease:{epoch:2,atMs:"11"}}});
    transition(record,released);expect(protectedOwner(released).generationContinuity).toEqual(baseline);
    expect(captured.map(value=>value.owner?.phase??null)).toEqual([null,DependencyOwnerPhase.ExclusiveMutation,DependencyOwnerPhase.Running]);
  });
  it("refuses a Running null publication, a dropped slot and replacement of an Active interval",()=>{
    const running=protectedOwner(parseDependencyOwner({...idle(),revision:4,epoch:2,owner:{kind:DependencyOwnerKind.Consumer,
      phase:DependencyOwnerPhase.Running,attempt:{attemptId:nextOperation,epoch:2,launch}}}));
    expect(()=>transition(running,parseDependencyOwner({...running,revision:5,owner:null}))).toThrow();
    const dropped={...running,revision:5};delete dropped.generationContinuity;
    expect(()=>transition(running,parseDependencyOwner(dropped))).toThrow();
    expect(()=>transition(running,parseDependencyOwner({...running,revision:5,generationContinuity:{...baseline,generation:nextOperation}}))).toThrow();
  });
  it("preserves Active during an idle v2-to-v3 custody handoff without changing epoch or activity",()=>{
    const previous=idle(),next=parseDependencyOwner({...previous,version:3,revision:4,custodyBinding:reference("custody","6")});
    expect(()=>transition(previous,next)).not.toThrow();
    expect(()=>transition(previous,parseDependencyOwner({...next,epoch:2}))).toThrow();
  });
  it("refuses using an eviction successor as an Unverified retirement",()=>{
    const evicting={version:1,kind:Kind.RetiredEvictingV1,operationId,generation:operationId,readyRevision:2,evictingRevision:3,
      previousReady:baseline.previousReady,baseline:baseline.baseline,writerBarrier:baseline.writerBarrier,retiredEvicting:reference("evicting","6")};
    expect(parseDependencyGenerationContinuity(evicting).kind).toBe(Kind.RetiredEvictingV1);
    expect(()=>parseDependencyGenerationContinuity({...evicting,kind:Kind.RetiredReadyV1})).toThrow();
    expect(()=>parseDependencyGenerationContinuity({...evicting,evictingRevision:4})).toThrow();
  });
  it("refuses missing/aliased barrier references and does not invoke an accessor",()=>{
    expect(()=>parseDependencyGenerationContinuity({...baseline,writerBarrier:baseline.baseline})).toThrow();
    const {writerBarrier:_barrier,...missing}=baseline;
    expect(()=>parseDependencyGenerationContinuity(missing)).toThrow();
    let reads=0;const getter={...baseline};Object.defineProperty(getter,"writerBarrier",{enumerable:true,get(){reads++;throw Error("getter");}});
    expect(()=>parseDependencyGenerationContinuity(getter)).toThrow();expect(reads).toBe(0);
  });
});
