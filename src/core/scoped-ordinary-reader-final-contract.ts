import { isDependencyProtectedReference, type DependencyProtectedReference } from "./dependency-environment/dependency-custody-evidence";
import { ScopedTerminationExtent, ScopedTerminationKind, type ScopedProviderOnlyMember, type ScopedProviderOnlyReceipt } from "./scoped-termination-contract";
export interface ScopedOrdinaryReaderFinalProvider {
  readonly member:ScopedProviderOnlyMember;readonly completion:DependencyProtectedReference;readonly relation:DependencyProtectedReference;
}
/** Honest non-keyed C identity. No synthetic account, deadline, actor chain,
 * home or credential terminal state. Adapter independently proves physical
 * discharge and SAME actual attempt under the genuine held fence. */
export interface ScopedOrdinaryReaderFinalReceipt {
  readonly schemaVersion:3;readonly extent:ScopedTerminationExtent.OrdinaryReaderFinal;readonly publicationGeneration:number;
  readonly identity:ScopedProviderOnlyReceipt["identity"];readonly reader:ScopedProviderOnlyMember;
  readonly attempt:ScopedProviderOnlyReceipt["attempt"];readonly preclaim:DependencyProtectedReference;
  readonly completion:DependencyProtectedReference;readonly providers:readonly ScopedOrdinaryReaderFinalProvider[];
}
function invalid():never {throw new Error("scoped_ordinary_reader_final_invalid");}
function fields(value:unknown,keys:string):Record<string,unknown> {
  if (!value || typeof value!=="object" || Array.isArray(value) || Object.keys(value).sort().join(",")!==keys.split(",").sort().join(",")) invalid();
  return value as Record<string,unknown>;
}
function text(value:unknown,pattern:RegExp):string {if (typeof value!=="string" || pattern.exec(value)?.[0]!==value) invalid();return value;}
function positive(value:unknown):number {if (typeof value!=="number" || !Number.isSafeInteger(value) || value<1) invalid();return value;}
const uuid=/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/,hash=/[a-f0-9]{64}/,id=/[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,255}/;
const root="/var/lib/subscription-runtime-host-policy";
function ref(value:unknown,path:string):DependencyProtectedReference {
  if (!isDependencyProtectedReference(value) || value.path!==path) invalid();
  return Object.freeze({...value,identity:Object.freeze({...value.identity})});
}
function member(value:unknown,kind:ScopedTerminationKind):ScopedProviderOnlyMember {
  const v=fields(value,"startId,unit,creatorId,originSha256,generation,start"),startId=text(v.startId,uuid);
  const unit=`subscription-runtime-${kind===ScopedTerminationKind.Runtime ? "ordinary":"hosted"}-${startId}.service`;if (v.unit!==unit) invalid();
  return Object.freeze({startId,unit,creatorId:text(v.creatorId,id),originSha256:text(v.originSha256,hash),generation:positive(v.generation),
    start:ref(v.start,`${root}/ordinary-starts/${startId}.json`)});
}
export function parseScopedOrdinaryReaderFinalReceipt(value:unknown):ScopedOrdinaryReaderFinalReceipt {
  const v=fields(value,"schemaVersion,extent,publicationGeneration,identity,reader,attempt,preclaim,completion,providers");
  if (v.schemaVersion!==3 || v.extent!==ScopedTerminationExtent.OrdinaryReaderFinal || !Array.isArray(v.providers) || v.providers.length>256) invalid();
  const publicationGeneration=positive(v.publicationGeneration),reader=member(v.reader,ScopedTerminationKind.Runtime);
  if (reader.generation>=publicationGeneration) invalid();
  const raw=fields(v.identity,"installationId,hostId,bootId,supervisorId,runtimeSha");
  const identity=Object.freeze({installationId:text(raw.installationId,id),hostId:text(raw.hostId,id),bootId:text(raw.bootId,id),
    supervisorId:text(raw.supervisorId,/[1-9][0-9]{0,9}:[1-9][0-9]{0,19}/),runtimeSha:text(raw.runtimeSha,/[a-f0-9]{40}/)});
  const own=fields(v.attempt,"attemptId,epoch,grantDigest"),attempt=Object.freeze({attemptId:text(own.attemptId,uuid),epoch:positive(own.epoch),grantDigest:text(own.grantDigest,hash)});
  const seen=new Set<string>(),providers=v.providers.map(rawProvider=>{
    const row=fields(rawProvider,"member,completion,relation"),selected=member(row.member,ScopedTerminationKind.Provider);
    if (seen.has(selected.startId) || selected.creatorId!==reader.creatorId || selected.originSha256!==reader.originSha256 ||
        selected.generation<=reader.generation || selected.generation>=publicationGeneration) invalid();seen.add(selected.startId);
    return Object.freeze({member:selected,completion:ref(row.completion,`${root}/dependency-ordinary-provider-completions/${selected.startId}.json`),
      relation:ref(row.relation,`${root}/dependency-provider-attempts/${selected.startId}.json`)});
  });
  return Object.freeze({schemaVersion:3,extent:ScopedTerminationExtent.OrdinaryReaderFinal,publicationGeneration,identity,reader,attempt,
    preclaim:ref(v.preclaim,`${root}/dependency-reader-starts/${reader.startId}.json`),
    completion:ref(v.completion,`${root}/dependency-ordinary-reader-completions/${reader.startId}.json`),providers:Object.freeze(providers)});
}
