import { DependencyOwnerPhase } from "@vioxen/subscription-runtime/core";
import { withHostedActivationFence, type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { assertCurrentHostedDependencyAttempt, CurrentHostedDependencyOriginKind, findOriginalHostedDependencyGenerationEntry,
  type CurrentHostedDependencyOrigin } from "./hosted-current-dependency-origin";
import { beginOriginalHostedDependencyGenerationBarrier } from "./hosted-dependency-generation-controller";
import { HostedDependencyWarmLeafPhase } from "./hosted-dependency-generation-state";
import { HostedDependencyColdPhase } from "./hosted-dependency-cold-materialization-state";
import { finishOriginalHostedDependencyColdTree } from "./hosted-dependency-cold-controller";
function invalid():never {throw new Error("hosted_current_dependency_origin_unresolved");}
/** Lexical original-map selection precedes all request/state access. Early
 * denial-only enrollment never admits cold effects or a concurrent source edit. */
export function assertOriginalHostedDependencyExecutionAdmission(context:CurrentHostedDependencyOrigin,fence:HostedActivationFence,access:symbol) {
  const retained=findOriginalHostedDependencyGenerationEntry(context,access),actual=assertCurrentHostedDependencyAttempt(context,fence,DependencyOwnerPhase.ExclusiveMutation);
  if(actual.facts.kind===CurrentHostedDependencyOriginKind.Ordinary && !retained.ordinaryAdmitted ||
      retained.generation?.warmLeaf && retained.generation.warmLeaf.phase!==HostedDependencyWarmLeafPhase.Completed)invalid();
  return actual;
}
/** The same original map owns the fixed cold effect and actual installer. */
export function materializeOriginalHostedDependencyColdTree(context:CurrentHostedDependencyOrigin,access:symbol):Promise<Readonly<{startId:string}>|undefined> {
  withHostedActivationFence(fence=>{
    const actual=assertOriginalHostedDependencyExecutionAdmission(context,fence,access),retained=findOriginalHostedDependencyGenerationEntry(context,access);
    if(retained.cold)invalid();beginOriginalHostedDependencyGenerationBarrier(context,fence,access);
    retained.cold={phase:HostedDependencyColdPhase.Producing,binding:actual.binding,attempt:actual.attempt};
  });
  return finishOriginalHostedDependencyColdTree(context,access);
}
