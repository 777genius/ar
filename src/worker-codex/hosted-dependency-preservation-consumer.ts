import { createReadonlyPrivateRecord } from "./hosted-readonly-custody";
import { randomUUID } from "node:crypto";
import { DependencyOwnerKind, DependencyOwnerPhase, parseDependencyOwner, sameDependencyProtectedReference, type DependencyLaunchBinding } from "@vioxen/subscription-runtime/core";
import { claimDependencyConsumer, captureDependencyConsumerPreclaim } from "@vioxen/subscription-runtime/worker-core";
import { assertHostedActivationFence, type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { assertOriginalHostedDependencyPhysicalRecordAccess } from "./hosted-current-dependency-origin";
import { readHostedDependencyPendingPreservations, readHostedDependencyPreservationRelease, readHostedDependencyPreservationConsumer } from "./hosted-dependency-preservation-handoff";
import { readOriginalHostedDependencyPreservationHistory } from "./hosted-dependency-preservation-operator";
import { readOriginalHostedDependencyOperatorNativeCensus } from "./hosted-dependency-generation-native-census";
import { hostedDependencyOwnerRoot, type HostedDependencyBinding } from "./hosted-dependency-workspace";
import { hostedDependencyPreservationSelectionPath } from "./hosted-dependency-preservation-selection";
import { pinReferenceFile, encodeReference as encode } from "./hosted-dependency-legacy-reference-records";
import { LocalDependencyOwnerStore } from "../store-local-file/dependency-environment/local-dependency-owner-store";
import { readHostedPrivateBytes } from "./hosted-readonly-inputs";
import { readHostedDependencyCommittedPreservation } from "./hosted-dependency-preservation";
const equal=(a:unknown,b:unknown)=>encode(a).equals(encode(b));
function held():never {throw new Error("hosted_dependency_preservation_consumer_held");}
/** Called only by the two defining original C/R producers, after they derive
 * their real launch from the current reservation. All other generic fallbacks
 * are vetoed by a pending index, including before the old receipt was retired. */
export function claimOriginalHostedDependencyPreservedConsumer(fence:HostedActivationFence,binding:HostedDependencyBinding,launch:DependencyLaunchBinding,access:symbol) {
  assertOriginalHostedDependencyPhysicalRecordAccess(access);assertHostedActivationFence(fence);
  const pending=readHostedDependencyPendingPreservations(fence,binding);if(!pending.length)return undefined;if(pending.length!==1)held();
  const selected=pending[0]!,s=selected.header,release=readHostedDependencyPreservationRelease(fence,s),previous=release.released;
  if(!readHostedDependencyCommittedPreservation(binding,release.retired.receipt,s.operationId))held();
  if(launch.installationId!==binding.installationId || launch.runtimeSha!==binding.runtimeSha || launch.grantDigest!==binding.grantDigest)held();
  const path=hostedDependencyPreservationSelectionPath(s.operationId)+".consumer.json",retained=readHostedPrivateBytes(path,32768)?readHostedDependencyPreservationConsumer(s):undefined;
  if(retained && (!equal(retained.previous,previous) || !sameDependencyProtectedReference(retained.release,release.reference) ||
      retained.claimed.owner?.kind!==DependencyOwnerKind.Consumer || !equal(retained.claimed.owner.attempt.launch,launch)))held();
  const reader=LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384});let actual;
  try{actual=reader.read(binding.workspace);if(!equal(actual,previous) && !(retained && equal(actual,retained.claimed)))held();}finally{reader.close();}
  readOriginalHostedDependencyPreservationHistory(fence,s,access);if(!readOriginalHostedDependencyOperatorNativeCensus(fence,access))held();
  const attempt=retained?.claimed.owner?.kind===DependencyOwnerKind.Consumer?retained.claimed.owner.attempt:{attemptId:randomUUID(),epoch:previous.epoch+1,launch},expected=parseDependencyOwner({...previous,revision:previous.revision+1,
    epoch:attempt.epoch,owner:{kind:DependencyOwnerKind.Consumer,phase:DependencyOwnerPhase.ExclusiveMutation,attempt}});
  // Selection of the one real new consumer is immutable before its CAS. A
  // crash cannot assign another Consumer UUID to the same committed mapping.
  const record=encode({version:1,selection:selected.reference,release:release.reference,previous,claimed:expected});
  if(record.length>32768)held();createReadonlyPrivateRecord(path,record);
  if(!pinReferenceFile(path,32768).bytes.equals(record))held();
  const store=LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384});
  let claim:ReturnType<typeof captureDependencyConsumerPreclaim>;
  try{const granted=equal(actual,expected)?attempt:claimDependencyConsumer(store,binding.workspace,launch,attempt.attemptId);
    if(!equal(granted,attempt) || !equal(store.read(binding.workspace),expected))held();
    claim=captureDependencyConsumerPreclaim(store,binding.workspace,granted);
  }finally{store.close();}
  readOriginalHostedDependencyPreservationHistory(fence,s,access);if(!readOriginalHostedDependencyOperatorNativeCensus(fence,access))held();
  assertHostedActivationFence(fence);return claim;
}
