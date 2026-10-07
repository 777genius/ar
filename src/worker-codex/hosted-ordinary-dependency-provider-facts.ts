import { DependencyToolReadyReadStatus } from "../core/dependency-environment/dependency-tool-ready-reader";
import { DependencyOwnerPhase, sameDependencyProtectedReference } from "@vioxen/subscription-runtime/core";
import { readHostedOrdinaryProviderFacts, HostedOrdinaryProviderReadPhase, type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { CurrentHostedDependencyOriginKind, readCurrentHostedManagedDependencyProviderParent, readCurrentHostedOrdinaryDependencyReaderEntry,
  type CurrentHostedDependencyOrigin } from "./hosted-current-dependency-origin";
import { readOriginalHostedDependencyRootPreparation } from "./hosted-dependency-root-physical-selection";
import { pinReferenceFile } from "./hosted-dependency-legacy-reference-records";
import { formOrdinaryDependencyProviderStartFacts } from "./hosted-managed-provider-start-facts";
function invalid():never { throw new Error("hosted_dependency_current_origin_unresolved"); }
/** Fixed actual ordinary read model. No caller record/row/FD/pin or raw child is
 * accepted; original-map parent/resource validation brackets every collection. */
export function readOriginalHostedOrdinaryProviderBirthFacts(context:CurrentHostedDependencyOrigin,fence:HostedActivationFence,unit:string,phase:HostedOrdinaryProviderReadPhase=HostedOrdinaryProviderReadPhase.Reserved) {
  const actual=readCurrentHostedManagedDependencyProviderParent(context,fence);
  if (actual.facts.kind!==CurrentHostedDependencyOriginKind.Ordinary) invalid();
  const match=/^subscription-runtime-hosted-([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\.service$/.exec(unit);
  if (!match || match[0]!==unit) invalid();
  const entry=readCurrentHostedOrdinaryDependencyReaderEntry(context,fence,DependencyOwnerPhase.Running);
  const prepared=readOriginalHostedDependencyRootPreparation(context,fence,DependencyOwnerPhase.Running);
  if (prepared.record.version!==3 && prepared.record.version!==5 && prepared.record.version!==7) invalid(); const record=prepared.record;
  const selected=readHostedOrdinaryProviderFacts(fence,match[1]!,phase),providerPin=pinReferenceFile(`/var/lib/subscription-runtime-host-policy/ordinary-starts/${match[1]}.json`,16384);
  if (selected.parentId!==actual.attempt.launch.startId || !selected.bytes.equals(providerPin.bytes) ||
      !sameDependencyProtectedReference(entry.origin,record.originReference) || !sameDependencyProtectedReference(entry.producer,record.readerProducer) ||
      !sameDependencyProtectedReference(entry.entry,record.readerEntry)) invalid();
  readCurrentHostedManagedDependencyProviderParent(context,fence);
  return formOrdinaryDependencyProviderStartFacts({...actual,facts:actual.facts},selected,providerPin.reference,record,prepared.admission===DependencyToolReadyReadStatus.Ready ? prepared.ready : prepared.admission===DependencyToolReadyReadStatus.Baseline ? prepared.baselineReady : prepared.unverified);
}
