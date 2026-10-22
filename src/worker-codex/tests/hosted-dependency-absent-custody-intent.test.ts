import { expect, it } from "vitest";
import { DependencyGenerationContinuityKind as Continuity, DependencyOwnerKind, DependencyOwnerPhase } from "@vioxen/subscription-runtime/core";
import { DependencyReceiptState } from "@vioxen/subscription-runtime/worker-core";
import { parseHostedDependencyColdCustodyIntent, HostedDependencyColdCustodyIntentKind as IntentKind } from "../hosted-dependency-cold-custody-intent";
const eviction="12345678-1234-4234-8234-123456789abc",operationId="23456789-1234-4234-8234-123456789abc",installation="34567890-1234-4234-8234-123456789abc";
const reference=(name:string)=>({path:`/TEST-protected/${name}.json`,identity:{dev:"1",ino:"2"},sha256:"a".repeat(64)});
function fixture() {
  const workspace={canonicalPath:"/TEST-disposable/workspace",dev:"1",ino:"3"},baseline={version:1,kind:Continuity.BaselineAuthenticatedV1,
    operationId:installation,generation:"TEST-generation",readyRevision:10,previousReady:reference("ready"),baseline:reference("baseline"),writerBarrier:reference("barrier")},
    retired={...baseline,kind:Continuity.RetiredEvictingV1,operationId:eviction,evictingRevision:11,retiredEvicting:reference("evicting")},
    originalIdle={version:2,workspace,revision:30,epoch:5,owner:null,generationContinuity:retired},
    claimedOwner={...originalIdle,revision:31,epoch:6,owner:{kind:DependencyOwnerKind.Maintenance,phase:DependencyOwnerPhase.ExclusiveMutation,
      attempt:{operationId,epoch:6,host:{installationId:installation,bootId:installation,supervisorId:"100:200",runtimeSha:"b".repeat(40),grantDigest:"c".repeat(64),inventoryDigest:"d".repeat(64)}}}},
    tree={dev:"1",ino:"4"},trash={operationId:eviction,originalTree:tree,destinationParent:{canonicalPath:"/TEST-disposable/trash",dev:"1",ino:"5"},destinationName:`dependency-${eviction}`},
    receipt={version:1,state:DependencyReceiptState.Absent,revision:12,generation:baseline.generation,workspace,coverageRevision:"TEST-coverage",operationId:eviction,installKey:"e".repeat(64),
      evictionCommit:{operationId:eviction,generation:baseline.generation,workspace,coverageRevision:"TEST-coverage",tree,manifestDigest:"f".repeat(64),installKey:"e".repeat(64),trash,commitEvidenceId:"a".repeat(64)}};
  return {version:2,kind:IntentKind.AbsentRestoration,operationId,originalIdle,claimedOwner,
    candidate:{jobId:"TEST-custody-history",closedStartId:installation,binding:reference("binding"),generationBaseline:baseline,idle:reference("pre-eviction-idle"),sourceClosed:reference("source-closed"),sourceMapping:reference("source")},
    policyInput:{...reference("policy"),path:`/var/lib/subscription-runtime-host-policy/readonly-dependency-cold-adoptions/${operationId}.policy.json`},
    removalRelease:reference("removal-release"),priorAbsent:{receipt,reference:reference("absent")}};
}
// Syntax contract only, no host authorization. Red if version dispatch conflates
// immutable HISTORY with current Retired state or permits predecessor drift.
it("retains pre-eviction Baseline history beside the separate actual Retired predecessor",()=>{
  const input=fixture(),intent=parseHostedDependencyColdCustodyIntent(input);expect(intent.version).toBe(2);
  expect(intent.candidate.generationBaseline.kind).toBe(Continuity.BaselineAuthenticatedV1);
  expect(intent.originalIdle.version!==1 && intent.originalIdle.generationContinuity?.kind).toBe(Continuity.RetiredEvictingV1);
  expect(intent.candidate.idle).toEqual(input.candidate.idle);expect(intent.candidate.idle).not.toEqual(input.removalRelease);
  expect(()=>parseHostedDependencyColdCustodyIntent({...input,candidate:{...input.candidate,generationBaseline:input.originalIdle.generationContinuity}})).toThrow();
});
it("preserves V1 Ready-only admission instead of silently treating Retired as Ready",()=>{
  const input=fixture(),{kind:_kind,removalRelease:_release,priorAbsent:_absent,...v1}=input;
  expect(()=>parseHostedDependencyColdCustodyIntent({...v1,version:1})).toThrow();
  const ready={...v1.originalIdle,generationContinuity:v1.candidate.generationBaseline},claimed={...v1.claimedOwner,generationContinuity:v1.candidate.generationBaseline};
  expect(parseHostedDependencyColdCustodyIntent({...v1,version:1,originalIdle:ready,claimedOwner:claimed}).version).toBe(1);
});
it("refuses unrelated prior Absent, unsupported version and partial release records",()=>{
  const input=fixture();expect(()=>parseHostedDependencyColdCustodyIntent({...input,priorAbsent:{...input.priorAbsent,
    receipt:{...input.priorAbsent.receipt,operationId:operationId,evictionCommit:{...input.priorAbsent.receipt.evictionCommit,operationId}}}})).toThrow();
  expect(()=>parseHostedDependencyColdCustodyIntent({...input,version:3})).toThrow();
  const {removalRelease:_release,...partial}=input;expect(()=>parseHostedDependencyColdCustodyIntent(partial)).toThrow();
});
it("requires the once-selected own exact claim edge and preserved continuity",()=>{
  const input=fixture();for(const claimedOwner of [{...input.claimedOwner,epoch:7},{...input.claimedOwner,revision:32},
    {...input.claimedOwner,generationContinuity:{...input.originalIdle.generationContinuity,operationId}},
    {...input.claimedOwner,owner:{...input.claimedOwner.owner,attempt:{...input.claimedOwner.owner.attempt,operationId:eviction}}}])
    expect(()=>parseHostedDependencyColdCustodyIntent({...input,claimedOwner})).toThrow();
});
