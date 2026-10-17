import { dependencyToolQualificationRecordName } from "../core/dependency-environment/dependency-tool-profile";
import { parseDependencyToolAdmissionQualification } from "../core/dependency-environment/dependency-tool-execution";
import { pinReferenceFile } from "./hosted-dependency-legacy-reference-records";
import { isDependencyCustodyObject } from "@vioxen/subscription-runtime/core";
import { DependencyGenerationContinuityKind, DependencyOwnerPhase, isDependencyConsumerOwner, sameDependencyAttempt, sameDependencyProtectedReference, sameDependencyTree } from "@vioxen/subscription-runtime/core";
import { assertHostedActivationFence, type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { hostedDependencyOwnerRoot } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { LocalDependencyOwnerStore } from "../store-local-file/dependency-environment/local-dependency-owner-store";
import { assertCurrentHostedDependencyAttempt, findOriginalHostedDependencyGenerationState, type CurrentHostedDependencyOrigin } from "./hosted-current-dependency-origin";
import { readOriginalHostedDependencyGenerationBaselinePins } from "./hosted-dependency-generation-source-closure";
import { assertOriginalHostedDependencyGenerationBarrier } from "./hosted-dependency-generation-controller";
import { HostedDependencyGenerationBarrierPhase as Phase } from "./hosted-dependency-generation-state";
import { readHostedDependencyCommittedReady } from "./hosted-dependency-receipts";
import { readHostedDependencyRootDirectoryPin } from "./hosted-dependency-root-physical-facts";
const encode=(v:unknown)=>Buffer.from(JSON.stringify(v)+"\n");
function held():never{throw new Error("hosted_dependency_generation_baseline_unresolved");}
/** Original-map-only current continuity read. Historical Ready bytes are never
 * re-observed or upgraded here. This reader cannot manufacture source exposure,
 * qualification, a runtime purpose or eviction authorization. */
export function readOriginalHostedDependencyWarmBaseline(context:CurrentHostedDependencyOrigin,fence:HostedActivationFence,access:symbol) {
  const state=findOriginalHostedDependencyGenerationState(context,access);if(!state)held();
  const actual=assertCurrentHostedDependencyAttempt(context,fence,state.ownerPhase);
  const store=LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384});
  let owner:ReturnType<LocalDependencyOwnerStore["read"]>;
  try{owner=store.read(actual.binding.workspace);}finally{store.close();}
  if(!owner || owner.version===1 || owner.generationContinuity?.kind!==DependencyGenerationContinuityKind.BaselineAuthenticatedV1)return undefined;
  if(!isDependencyConsumerOwner(owner.owner) || owner.owner.phase!==state.ownerPhase || !sameDependencyAttempt(owner.owner.attempt,actual.attempt))held();
  assertOriginalHostedDependencyGenerationBarrier(context,fence,access);
  if(state.phase!==Phase.Pending && state.phase!==Phase.Published)held();
  const slot=owner.generationContinuity,pins=readOriginalHostedDependencyGenerationBaselinePins(actual.attempt,actual.binding,slot,access),
    ready=readHostedDependencyCommittedReady(actual.binding,slot.readyRevision),tree=readHostedDependencyRootDirectoryPin(actual.binding.workspace.canonicalPath+"/node_modules"),
    workspace=readHostedDependencyRootDirectoryPin(actual.binding.workspace.canonicalPath);
  if(!sameDependencyProtectedReference(ready.reference,slot.previousReady) || !encode(ready.receipt).equals(encode(pins.baseline.ready)) ||
      ready.receipt.generation!==slot.generation || !sameDependencyTree(tree,ready.receipt.tree) || tree.dev!==workspace.dev || tree.mountId!==workspace.mountId ||
      !sameDependencyProtectedReference(pins.baselinePin.reference,slot.baseline) || !encode(pins.baseline.actors).equals(encode(state.actors)))held();
  if(!isDependencyCustodyObject(pins.baseline.attempt,"attemptId,epoch,launch"))held();
  const launch=pins.baseline.attempt.launch;
  if(!isDependencyCustodyObject(launch,"bootId,grantDigest,installationId,runtimeSha,startId,unit") &&
      !isDependencyCustodyObject(launch,"association,bootId,grantDigest,installationId,kind,origin,runtimeSha,startId,unit"))held();
  if(typeof launch.startId!=="string")held();
  const qualificationPin=pinReferenceFile("/var/lib/subscription-runtime-host-policy/"+dependencyToolQualificationRecordName(launch.startId),16384),
    qualification=parseDependencyToolAdmissionQualification(JSON.parse(qualificationPin.bytes.toString("utf8")));
  if(qualification.version!==1 || qualification.startId!==launch.startId || qualification.attemptId!==slot.operationId ||
      qualification.readyRevision!==ready.receipt.revision || qualification.installKey!==ready.receipt.installKey ||
      qualification.manifestDigest!==ready.receipt.manifestDigest || !sameDependencyTree(qualification.tree,ready.receipt.tree) ||
      !qualificationPin.bytes.equals(encode(qualification)))held();
  const after=assertCurrentHostedDependencyAttempt(context,fence,state.ownerPhase);
  if(!sameDependencyAttempt(after.attempt,actual.attempt) || !encode(after.binding).equals(encode(actual.binding)) ||
      !encode(readHostedDependencyRootDirectoryPin(tree.canonicalPath)).equals(encode(tree)))held();
  assertOriginalHostedDependencyGenerationBarrier(context,fence,access);assertHostedActivationFence(fence);
  state.baseline=slot;state.barrier=slot.writerBarrier;
  return Object.freeze({binding:actual.binding,attempt:actual.attempt,slot,ready,pins,tree,qualification,qualificationReference:qualificationPin.reference});
}
