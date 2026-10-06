import { describe,expect,it } from "vitest";
import { ScopedTerminationKind,ScopedTerminationExtent,parseScopedProviderOnlyReceipt,type ScopedProviderOnlyReceipt } from "../../../core/scoped-termination-contract";
import { HostedCustodyReservationState as State } from "../domain/hosted-custody-epoch";
import { HostedActivationPhase as Phase,assertHostedActivationSuccessor,type HostedActivation } from "../domain/hosted-installation-activation";
const parentId="11111111-1111-1111-1111-111111111111",providerId="22222222-2222-2222-2222-222222222222",siblingId="33333333-3333-3333-3333-333333333333";
const root="/var/lib/subscription-runtime-host-policy",digest="a".repeat(64);
const reference=(path:string)=>({path,identity:{dev:"1",ino:"2"},sha256:digest});
const row=(startId:string,kind:ScopedTerminationKind,generation:number)=>({startId,unit:`subscription-runtime-${kind===ScopedTerminationKind.Runtime ? "ordinary":"hosted"}-${startId}.service`,creatorId:"creator",originSha256:digest,generation,state:State.Reserved});
const parent=row(parentId,ScopedTerminationKind.Runtime,2),provider=row(providerId,ScopedTerminationKind.Provider,3),sibling=row(siblingId,ScopedTerminationKind.Provider,4);
const prior:HostedActivation={schemaVersion:1,installationId:"installation",hostId:"host",bootId:"boot",supervisorId:"123:456",generation:4,phase:Phase.Ordinary,
  ordinaryOriginsSha256:digest,exclusiveEnrollmentSha256:null,ordinaryStarts:[parent,provider,sibling]};
function facts():ScopedProviderOnlyReceipt {return parseScopedProviderOnlyReceipt({schemaVersion:2,extent:ScopedTerminationExtent.ProviderOnly,publicationGeneration:5,
  identity:{installationId:"installation",hostId:"host",bootId:"boot",supervisorId:"123:456",runtimeSha:"b".repeat(40)},
  parent:{startId:parentId,unit:parent.unit,creatorId:"creator",originSha256:digest,generation:2,start:reference(`${root}/ordinary-starts/${parentId}.json`)},
  provider:{startId:providerId,unit:provider.unit,creatorId:"creator",originSha256:digest,generation:3,start:reference(`${root}/ordinary-starts/${providerId}.json`)},
  attempt:{attemptId:"44444444-4444-4444-4444-444444444444",epoch:2,grantDigest:digest},home:{canonicalPath:"/var/lib/private-home",dev:"1",ino:"2",mountId:"3"},
  use:{accountId:"account",restoredHash:digest},completion:reference(`${root}/dependency-ordinary-provider-completions/${providerId}.json`)});}
const terminal=():HostedActivation=>({...prior,generation:5,ordinaryStarts:prior.ordinaryStarts.map(value=>value.startId===providerId?{...value,state:State.Terminal}:value)});
// Independent domain risk: provider-only proof must not authorize parent/sibling
// terminalization, a no-op generation bump, or fall through on unknown evidence.
// These structural facts intentionally establish no original/native authority.
describe("provider-only activation scheduling contract",()=>{
  it("permits only the selected child transition with its ordinary parent still live",()=>{
    assertHostedActivationSuccessor(prior,terminal(),facts());
    expect(terminal().ordinaryStarts.find(value=>value.startId===parentId)?.state).toBe(State.Reserved);
    expect(terminal().ordinaryStarts.find(value=>value.startId===siblingId)?.state).toBe(State.Reserved);
  });
  it("requires an actual provider Terminal transition and refuses omitted proof",()=>{
    expect(()=>assertHostedActivationSuccessor(prior,{...prior,generation:5},facts())).toThrow();
    expect(()=>assertHostedActivationSuccessor(prior,terminal())).toThrow();
  });
  it.each([parentId,siblingId])("cannot terminalize another row %s",startId=>{
    const next=terminal();expect(()=>assertHostedActivationSuccessor(prior,{...next,ordinaryStarts:next.ordinaryStarts.map(value=>value.startId===startId?{...value,state:State.Terminal}:value)},facts())).toThrow();
  });
  it("rejects unknown evidence instead of treating it as an unauthenticated transition",()=>{
    const unknown={...facts(),schemaVersion:3} as unknown as ScopedProviderOnlyReceipt;
    expect(()=>assertHostedActivationSuccessor(prior,{...prior,generation:5},unknown)).toThrow();
    expect(()=>assertHostedActivationSuccessor(prior,{...prior,generation:5},false as unknown as ScopedProviderOnlyReceipt)).toThrow();
  });
  it.each(["installationId","hostId","bootId","supervisorId"])("rejects foreign identity %s",key=>{
    const receipt=facts(),identity={...receipt.identity,[key]:"foreign"};
    expect(()=>assertHostedActivationSuccessor(prior,terminal(),{...receipt,identity})).toThrow();
  });
  it("rejects a replaced selected row, wrong generation or changed authenticated catalog",()=>{
    expect(()=>assertHostedActivationSuccessor(prior,{...terminal(),generation:6},facts())).toThrow();
    expect(()=>assertHostedActivationSuccessor(prior,{...terminal(),ordinaryOriginsSha256:"c".repeat(64)},facts())).toThrow();
    expect(()=>assertHostedActivationSuccessor(prior,terminal(),{...facts(),provider:{...facts().provider,generation:4}})).toThrow();
  });
  it("rejects borrowed parent/provider/completion references and closes mutable reference aliases",()=>{
    const receipt=facts();
    expect(()=>parseScopedProviderOnlyReceipt({...receipt,provider:{...receipt.provider,start:receipt.parent.start}})).toThrow();
    expect(()=>parseScopedProviderOnlyReceipt({...receipt,completion:reference(`${root}/dependency-ordinary-provider-completions/${siblingId}.json`)})).toThrow();
    expect(Object.isFrozen(receipt.provider.start)).toBe(true);expect(Object.isFrozen(receipt.completion)).toBe(true);
    expect(Object.isFrozen(receipt.provider.start.identity)).toBe(true);expect(Object.isFrozen(receipt.completion.identity)).toBe(true);
  });
});
