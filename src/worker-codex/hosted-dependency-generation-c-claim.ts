import { claimOriginalHostedDependencyPreservedConsumer } from "./hosted-dependency-preservation-consumer";
import { readOriginalHostedDependencyRemovalIdle } from "./hosted-dependency-removal-history";
import { readOriginalHostedDependencyMaintenanceIdle } from "./hosted-dependency-active-maintenance";
import { randomUUID } from "node:crypto";
import { DependencyGenerationContinuityKind, DependencyOwnerKind, DependencyOwnerPhase, parseDependencyOwner } from "@vioxen/subscription-runtime/core";
import { claimDependencyConsumer, captureDependencyConsumerPreclaim } from "@vioxen/subscription-runtime/worker-core";
import { assertHostedActivationFence, type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { hostedDependencyOwnerRoot } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { LocalDependencyOwnerStore } from "../store-local-file/dependency-environment/local-dependency-owner-store";
import { assertOriginalHostedDependencyPhysicalRecordAccess } from "./hosted-current-dependency-origin";
import { readHostedOrdinaryDependencyReaderProducerFacts } from "./hosted-ordinary-dependency-reader";
import { readOriginalHostedDependencyCIdleGeneration } from "./hosted-dependency-generation-source-closure";
import { readOriginalHostedDependencyOperatorNativeCensus } from "./hosted-dependency-generation-native-census";
import { readHostedDependencyActiveActorFacts } from "./hosted-dependency-active-actor-facts";
const encode=(value:unknown)=>Buffer.from(JSON.stringify(value)+"\n");
function held():never{throw new Error("hosted_dependency_generation_claim_held");}
/** Genuine producer before submission. This actual operator does not borrow a
 * previous Consumer or manufacture a new current-context permission. Only the
 * original lexical dispatch can enter; no owner/launch/proof DTO is accepted. */
export function claimOriginalHostedDependencyCGeneration(fence:HostedActivationFence,startId:string,access:symbol) {
  assertOriginalHostedDependencyPhysicalRecordAccess(access);assertHostedActivationFence(fence);
  const selected=readHostedOrdinaryDependencyReaderProducerFacts(fence,startId);if(!selected)return undefined;
  const preserved=claimOriginalHostedDependencyPreservedConsumer(fence,selected.binding,{installationId:selected.binding.installationId,bootId:selected.start.bootId,
    runtimeSha:selected.binding.runtimeSha,grantDigest:selected.binding.grantDigest,startId,unit:selected.start.unit},access);if(preserved)return preserved;
  const reader=LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384});
  let previous:ReturnType<LocalDependencyOwnerStore["read"]>;
  try{previous=reader.read(selected.binding.workspace);}finally{reader.close();}
  if(!previous || previous.version===1)return undefined;
  const retired=previous.generationContinuity?.kind===DependencyGenerationContinuityKind.RetiredEvictingV1;
  if(!retired && previous.generationContinuity?.kind!==DependencyGenerationContinuityKind.BaselineAuthenticatedV1)return undefined;
  if(previous.version!==2 || previous.owner)held();
  const proof=retired ? readOriginalHostedDependencyRemovalIdle(fence,selected.binding.workspace,access) :
    readOriginalHostedDependencyMaintenanceIdle(fence,selected.binding.workspace,access) ?? readOriginalHostedDependencyCIdleGeneration(fence,selected.binding.jobId,access),actors=readHostedDependencyActiveActorFacts(fence,access);
  if(!proof || retired && !encode(proof.binding).equals(encode(selected.binding)) || !encode(proof.previous).equals(encode(previous)) || !actors || !readOriginalHostedDependencyOperatorNativeCensus(fence,access))held();
  const launch={installationId:selected.binding.installationId,bootId:selected.start.bootId,runtimeSha:selected.binding.runtimeSha,
    grantDigest:selected.binding.grantDigest,startId,unit:selected.start.unit},attemptId=randomUUID(),attempt={attemptId,epoch:previous.epoch+1,launch},
    expected=parseDependencyOwner({...previous,revision:previous.revision+1,epoch:attempt.epoch,
      owner:{kind:DependencyOwnerKind.Consumer,phase:DependencyOwnerPhase.ExclusiveMutation,attempt}});
  const store=LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384,generationBaselineVerifier:{
    assertGenerationBaselineTransition({previousOwner,proposedOwner}) {
      assertOriginalHostedDependencyPhysicalRecordAccess(access);assertHostedActivationFence(fence);
      if(!encode(previousOwner).equals(encode(previous)) || !encode(proposedOwner).equals(encode(expected)))held();
    },
  }});
  let claim:ReturnType<typeof captureDependencyConsumerPreclaim>;
  try {
    const granted=claimDependencyConsumer(store,selected.binding.workspace,launch,attemptId);
    if(!encode(granted).equals(encode(attempt)) || !encode(store.read(selected.binding.workspace)).equals(encode(expected)))held();
    claim=captureDependencyConsumerPreclaim(store,selected.binding.workspace,granted);
  }finally{store.close();}
  // All mutex descriptors close before the current global physical proof.
  if(!encode(readHostedOrdinaryDependencyReaderProducerFacts(fence,startId)).equals(encode(selected)) ||
      !encode(readHostedDependencyActiveActorFacts(fence,access)).equals(encode(actors)) ||
      !readOriginalHostedDependencyOperatorNativeCensus(fence,access))held();
  assertHostedActivationFence(fence);return claim;
}
