import { readOriginalHostedDependencyMaintenanceIdle } from "./hosted-dependency-active-maintenance";
import { readOriginalHostedDependencyColdCustodyTransfer } from "./hosted-dependency-cold-custody-transfer";
import { randomUUID } from "node:crypto";
import { DependencyConsumerLaunchKind, DependencyGenerationContinuityKind, DependencyOwnerKind, DependencyOwnerPhase,
  parseDependencyOwner, sameDependencyProtectedReference } from "@vioxen/subscription-runtime/core";
import { claimDependencyConsumer, captureDependencyConsumerPreclaim, HostedCustodyPhase, HostedCustodyReservationState } from "@vioxen/subscription-runtime/worker-core";
import { assertHostedActivationFence, type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { hostedDependencyOwnerRoot } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { readHostedReadonlyDependencyStart } from "../provider-codex/app-server/adapters/hosted-dependency-origin";
import { LocalDependencyOwnerStore } from "../store-local-file/dependency-environment/local-dependency-owner-store";
import { assertOriginalHostedDependencyPhysicalRecordAccess } from "./hosted-current-dependency-origin";
import { readOriginalHostedDependencyRIdleGeneration } from "./hosted-dependency-generation-r-source-closure";
import { readOriginalHostedDependencyOperatorNativeCensus } from "./hosted-dependency-generation-native-census";
import { readHostedDependencyActiveActorFacts } from "./hosted-dependency-active-actor-facts";
import { HostedReadonlyEpochStore } from "./hosted-readonly-epoch-store";
import { readHostedReadonlyDependencyMaterial } from "./hosted-readonly-dependency-records";
const encode=(v:unknown)=>Buffer.from(JSON.stringify(v)+"\n");
function held():never{throw new Error("hosted_dependency_readonly_generation_claim_held");}
/** This private fixed producer derives every launch/custody field from the real
 * current R reservation. No previous Consumer, launch DTO or permit is borrowed. */
export function claimOriginalHostedDependencyRGeneration(fence:HostedActivationFence,startId:string,access:symbol) {
  assertOriginalHostedDependencyPhysicalRecordAccess(access);assertHostedActivationFence(fence);
  const epoch=new HostedReadonlyEpochStore().readEpoch(),outer=epoch.outerRuntime;
  if(epoch.phase!==HostedCustodyPhase.Ready || epoch.revoked || !outer || outer.startId!==startId ||
      outer.state!==HostedCustodyReservationState.Reserved || outer.generation!==epoch.generation)held();
  const start=readHostedReadonlyDependencyStart(fence,startId),material=readHostedReadonlyDependencyMaterial(fence,epoch.identity),workspace=material.evidence.workspace;
  if(start.value.startId!==outer.startId || start.value.unit!==outer.unit || start.value.creatorId!==outer.creatorId || start.value.generation!==epoch.generation ||
      !sameDependencyProtectedReference(start.value.association,material.reference))held();
  const reader=LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384});
  let previous:ReturnType<LocalDependencyOwnerStore["read"]>;
  try{previous=reader.read(workspace);}finally{reader.close();}
  if(!previous || previous.version===1 || previous.generationContinuity?.kind!==DependencyGenerationContinuityKind.BaselineAuthenticatedV1)return undefined;
  const proof=readOriginalHostedDependencyMaintenanceIdle(fence,workspace,access) ?? readOriginalHostedDependencyColdCustodyTransfer(fence,material,previous,access) ??
    readOriginalHostedDependencyRIdleGeneration(fence,access),actors=readHostedDependencyActiveActorFacts(fence,access);
  if(previous.version!==3 || !encode(proof.previous).equals(encode(previous)) || !actors || !readOriginalHostedDependencyOperatorNativeCensus(fence,access))held();
  const launch={installationId:start.value.installationId,bootId:start.value.bootId,runtimeSha:start.value.runtimeSha,
    grantDigest:start.value.grantDigest,startId,unit:outer.unit,kind:DependencyConsumerLaunchKind.ManagedReadonlyLocalV1,
    association:material.reference,origin:start.reference},attemptId=randomUUID(),attempt={attemptId,epoch:previous.epoch+1,launch},
    expected=parseDependencyOwner({...previous,revision:previous.revision+1,epoch:attempt.epoch,
      owner:{kind:DependencyOwnerKind.Consumer,phase:DependencyOwnerPhase.ExclusiveMutation,attempt}});
  const store=LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384,generationBaselineVerifier:{
    assertGenerationBaselineTransition({previousOwner,proposedOwner}) {
      assertOriginalHostedDependencyPhysicalRecordAccess(access);assertHostedActivationFence(fence);
      if(!encode(previousOwner).equals(encode(previous)) || !encode(proposedOwner).equals(encode(expected)))held();
    },
  }});
  let claim:ReturnType<typeof captureDependencyConsumerPreclaim>;
  try{const granted=claimDependencyConsumer(store,workspace,launch,attemptId);
    if(!encode(granted).equals(encode(attempt)) || !encode(store.read(workspace)).equals(encode(expected)))held();
    claim=captureDependencyConsumerPreclaim(store,workspace,granted);
  }finally{store.close();}
  if(!encode(new HostedReadonlyEpochStore().readEpoch()).equals(encode(epoch)) || !sameDependencyProtectedReference(readHostedReadonlyDependencyStart(fence,startId).reference,start.reference) ||
      !sameDependencyProtectedReference(readHostedReadonlyDependencyMaterial(fence,epoch.identity).reference,material.reference) ||
      !encode(readHostedDependencyActiveActorFacts(fence,access)).equals(encode(actors)) || !readOriginalHostedDependencyOperatorNativeCensus(fence,access))held();
  assertHostedActivationFence(fence);return claim;
}
