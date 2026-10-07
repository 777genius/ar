import { DependencyOwnerPhase, sameDependencyAttempt } from "@vioxen/subscription-runtime/core";
import { withHostedActivationFence, type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { assertCurrentHostedDependencyAttempt, CurrentHostedDependencyOriginKind, findOriginalHostedDependencyGenerationEntry,
  holdCurrentHostedDependencyGenerationSourceUse, type CurrentHostedDependencyOrigin } from "./hosted-current-dependency-origin";
import { assertOriginalHostedDependencyExecutionAdmission } from "./hosted-dependency-entry-effects";
import { assertOriginalHostedDependencyGenerationBarrier, beginOriginalHostedDependencyGenerationBarrier, captureOriginalHostedDependencyGenerationInputs } from "./hosted-dependency-generation-controller";
import { HostedDependencyWarmLeafPhase, HostedDependencySourceUsePhase } from "./hosted-dependency-generation-state";
import { HostedDependencyInstallerRecipe } from "./hosted-dependency-installer-inputs";
import { sameHostedDependencyKeyInputs } from "./hosted-dependency-materialization-context";
import { captureHostedDependencyWarmLeafRequest, selectHostedDependencyWarmLeaf } from "./hosted-dependency-warm-leaf-request";
import { writeHostedDependencyWarmLeaf } from "./hosted-dependency-warm-leaf-physical";
import { readHostedDependencyRootDirectoryPin } from "./hosted-dependency-root-physical-facts";
const encode=(value:unknown)=>Buffer.from(JSON.stringify(value)+"\n");
function held():never {throw new Error("hosted_dependency_warm_source_leaf_held");}
/** One original-issued, pre-qualifier authored-code edit. The request is data,
 * and cannot select an owner, source scope, executor or continuity outcome. */
export async function editOriginalHostedDependencyWarmSourceLeaf(context:CurrentHostedDependencyOrigin,request:unknown,access:symbol):Promise<void> {
  const selected=findOriginalHostedDependencyGenerationEntry(context,access);
  withHostedActivationFence(fence=>assertOriginalHostedDependencyExecutionAdmission(context,fence,access));
  // Authenticate actual original identity before touching any caller property.
  const data=captureHostedDependencyWarmLeafRequest(request);
  const state=withHostedActivationFence(fence=>{
    assertOriginalHostedDependencyExecutionAdmission(context,fence,access);
    beginOriginalHostedDependencyGenerationBarrier(context,fence,access);
    const generation=findOriginalHostedDependencyGenerationEntry(context,access).generation;if(!generation)held();return generation;
  }),edit={phase:HostedDependencyWarmLeafPhase.Preparing};
  const current=(fence:HostedActivationFence)=>{
    const now=findOriginalHostedDependencyGenerationEntry(context,access),actual=assertCurrentHostedDependencyAttempt(context,fence,DependencyOwnerPhase.ExclusiveMutation);
    if(now!==selected || now.generation!==state || now.rootPurpose || now.cold ||
        actual.facts.kind===CurrentHostedDependencyOriginKind.Ordinary && !now.ordinaryAdmitted ||
        state.warmLeaf!==edit || state.sourceUse.exposure || state.sourceUse.qualification ||
        state.sourceUse.phase!==HostedDependencySourceUsePhase.Capturing || !sameDependencyAttempt(state.attempt,actual.attempt) ||
        !encode(state.binding).equals(encode(actual.binding)))held();
    assertOriginalHostedDependencyGenerationBarrier(context,fence,access);return actual;
  };
  try {
    withHostedActivationFence(fence=>{
    assertOriginalHostedDependencyExecutionAdmission(context,fence,access);
    if(selected.generation!==state || selected.rootPurpose || selected.cold || state.sourceUse.exposure || state.sourceUse.qualification ||
        state.sourceUse.phase!==HostedDependencySourceUsePhase.Capturing)held();
    state.warmLeaf=edit;current(fence);
    });
    const inputs=await captureOriginalHostedDependencyGenerationInputs(context,access);
    if(inputs.recipe!==HostedDependencyInstallerRecipe.NpmLocalNoLifecycleV1)held();
    selectHostedDependencyWarmLeaf(inputs,data.relativePath);
    const tree=withHostedActivationFence(fence=>{current(fence);return readHostedDependencyRootDirectoryPin(inputs.capture.workspace.canonicalPath+"/node_modules");});
    withHostedActivationFence(fence=>{
      current(fence);
      if(state.inputs!==inputs && (!state.inputs || !sameHostedDependencyKeyInputs(state.inputs,inputs)))held();
      // No await between current purpose and the actual synchronous effect.
      writeHostedDependencyWarmLeaf(context,fence,access,inputs,data.relativePath,data.bytes);
      // The physical helper has closed every temporary descriptor first.
      current(fence);
      if(!encode(readHostedDependencyRootDirectoryPin(tree.canonicalPath)).equals(encode(tree)))held();
    });
    const after=await captureOriginalHostedDependencyGenerationInputs(context,access);
    withHostedActivationFence(fence=>{
      current(fence);if(!sameHostedDependencyKeyInputs(inputs,after) ||
        !encode(readHostedDependencyRootDirectoryPin(tree.canonicalPath)).equals(encode(tree)))held();
      edit.phase=HostedDependencyWarmLeafPhase.Completed;
    });
  }catch(error){edit.phase=HostedDependencyWarmLeafPhase.Held;holdCurrentHostedDependencyGenerationSourceUse(context);throw error;}
}
