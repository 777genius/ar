import { types } from "node:util";
import { DependencyGenerationContinuityKind, isDependencyCustodyObject, isDependencyProtectedReference,
  parseDependencyGenerationContinuity, parseDependencyOwner, DependencyOwnerKind, DependencyOwnerPhase,
  type DependencyOwnerRecord, type DependencyReadonlyColdBaselineAdoptionEvidence, type DependencyProtectedReference } from "@vioxen/subscription-runtime/core";
import { parseHostedReadonlyPolicy } from "./hosted-readonly-inputs";
export const coldCustodyRoot="/var/lib/subscription-runtime-host-policy/readonly-dependency-cold-adoptions";
export type HostedDependencyColdCustodyIntent=Readonly<{
  version:1; operationId:string; candidate:DependencyReadonlyColdBaselineAdoptionEvidence["candidate"];
  originalIdle:DependencyOwnerRecord; claimedOwner:DependencyOwnerRecord; policyInput:DependencyProtectedReference;
}>;
function held():never{throw new Error("hosted_dependency_cold_custody_held");}
/** Syntax only; the original producer independently rejoins the protected C
 * closure, current owner and actual operator under the same real fence. */
export function parseHostedDependencyColdCustodyIntent(input:unknown):HostedDependencyColdCustodyIntent {
  if(!isDependencyCustodyObject(input,"candidate,claimedOwner,operationId,originalIdle,policyInput,version") || input.version!==1 ||
      typeof input.operationId!=="string" || /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.exec(input.operationId)?.[0]!==input.operationId ||
      !isDependencyProtectedReference(input.policyInput) || input.policyInput.path!==`${coldCustodyRoot}/${input.operationId}.policy.json` ||
      !isDependencyCustodyObject(input.candidate,"binding,closedStartId,generationBaseline,idle,jobId,sourceClosed,sourceMapping"))held();
  const c=input.candidate,originalIdle=parseDependencyOwner(input.originalIdle),claimedOwner=parseDependencyOwner(input.claimedOwner),
    generationBaseline=parseDependencyGenerationContinuity(c.generationBaseline);
  if(typeof c.jobId!=="string" || !/^TEST-[A-Za-z0-9_.-]{1,123}$/.test(c.jobId) || typeof c.closedStartId!=="string" ||
      /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.exec(c.closedStartId)?.[0]!==c.closedStartId ||
      !isDependencyProtectedReference(c.binding) || !isDependencyProtectedReference(c.idle) || !isDependencyProtectedReference(c.sourceClosed) ||
      !isDependencyProtectedReference(c.sourceMapping) || generationBaseline.kind!==DependencyGenerationContinuityKind.BaselineAuthenticatedV1 ||
      originalIdle.version!==2 || originalIdle.owner || claimedOwner.version!==2 || claimedOwner.revision!==originalIdle.revision+1 ||
      claimedOwner.epoch!==originalIdle.epoch+1 || claimedOwner.owner?.kind!==DependencyOwnerKind.Maintenance ||
      claimedOwner.owner.phase!==DependencyOwnerPhase.ExclusiveMutation || claimedOwner.owner.attempt.operationId!==input.operationId ||
      JSON.stringify(originalIdle.workspace)!==JSON.stringify(claimedOwner.workspace) ||
      JSON.stringify(originalIdle.generationContinuity)!==JSON.stringify(generationBaseline) ||
      JSON.stringify(claimedOwner.generationContinuity)!==JSON.stringify(generationBaseline))held();
  return {version:1,operationId:input.operationId,originalIdle,claimedOwner,policyInput:input.policyInput,
    candidate:{jobId:c.jobId,closedStartId:c.closedStartId,binding:c.binding,idle:c.idle,sourceClosed:c.sourceClosed,sourceMapping:c.sourceMapping,generationBaseline}};
}
/** Caller configuration is copied without getters/iterators before any IO.
 * The actual fixed operator later checks it against the selected installation. */
export function captureHostedDependencyColdCustodyPolicy(input:unknown) {
  if(!input || typeof input!=="object" || types.isProxy(input))held();
  const d=Object.getOwnPropertyDescriptors(input),keys="issuerDeploymentDigest,jobId,jobRootDir,readonlyPaths,runtimeManifestSha256,runtimeSha,schemaVersion,workspacePath";
  if(Reflect.ownKeys(d).some(k=>typeof k!=="string") || Object.keys(d).sort().join(",")!==keys ||
      Object.values(d).some(v=>!("value" in v)))held();
  const paths=d.readonlyPaths?.value;
  if(!Array.isArray(paths) || types.isProxy(paths))held();
  const a=Object.getOwnPropertyDescriptors<object>(paths),length=a.length;
  if(!length || !("value" in length) || typeof length.value!=="number" || !Number.isInteger(length.value) || length.value<1 || length.value>64 ||
      Reflect.ownKeys(a).length!==length.value+1)held();
  const copied:string[]=[];
  for(let i=0;i<length.value;i++){const item=a[String(i)];if(!item || !("value" in item) || typeof item.value!=="string" || item.value.length>4096)held();copied.push(item.value);}
  const scalar=(key:string):string=>{const value=d[key]?.value;if(typeof value!=="string" || value.length>4096)held();return value;};
  if(d.schemaVersion?.value!==1)held();
  return parseHostedReadonlyPolicy({schemaVersion:1,jobId:scalar("jobId"),jobRootDir:scalar("jobRootDir"),workspacePath:scalar("workspacePath"),
    runtimeSha:scalar("runtimeSha"),runtimeManifestSha256:scalar("runtimeManifestSha256"),issuerDeploymentDigest:scalar("issuerDeploymentDigest"),readonlyPaths:copied});
}
