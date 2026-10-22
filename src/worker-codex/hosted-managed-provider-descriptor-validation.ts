import { fstatSync } from "node:fs";
import { DependencyOwnerPhase, sameDependencyProtectedReference } from "@vioxen/subscription-runtime/core";
import { dependencyToolQualificationRecordName } from "../core/dependency-environment/dependency-tool-profile";
import { dependencyToolAdmittedGuestConfig } from "../core/dependency-environment/dependency-tool-execution";
import { assertHostedActivationFence, type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { assertHostedFdProcess, HostedFdLaunchKind } from "../provider-codex/app-server/adapters/hosted-fd-child";
import { readHostedDependencyRootDirectoryPin, sameRootDescriptorStat as sameStat } from "./hosted-dependency-root-physical-facts";
import { assertOriginalHostedDependencyPhysicalRecordAccess, findOriginalHostedDependencyGenerationEntry,
  readCurrentHostedManagedDependencyProvider, readRetainedHostedDependencyAttemptFacts, type CurrentHostedDependencyOrigin } from "./hosted-current-dependency-origin";
import { readOriginalHostedDependencyMaterialRecord } from "./hosted-dependency-original-record-reader";
import { readOriginalHostedManagedProviderDescriptor } from "./hosted-managed-provider-descriptor-reader";
const root="/var/lib/subscription-runtime-host-policy",encode=(value:unknown)=>Buffer.from(JSON.stringify(value)+"\n");
function invalid():never{throw new Error("hosted_dependency_current_origin_unresolved");}
export function readOriginalHostedManagedProviderTools(context: CurrentHostedDependencyOrigin, fence: HostedActivationFence, unit: string, access:symbol) {
  assertOriginalHostedDependencyPhysicalRecordAccess(access);
  const selected = readCurrentHostedManagedDependencyProvider(context,fence,unit), state = findOriginalHostedDependencyGenerationEntry(context,access).rootPurpose;
  const provider = state?.provider;
  if (!state || !provider || provider.unit !== unit || !sameDependencyProtectedReference(provider.reference,selected.reference) ||
      !encode(readHostedDependencyRootDirectoryPin(provider.root.canonicalPath)).equals(encode(provider.root))) invalid();
  const qualification = readOriginalHostedDependencyMaterialRecord(access,state.record.qualification,`${root}/${dependencyToolQualificationRecordName(selected.value.parentStartId)}`,16384,true);
  if (!readOriginalHostedManagedProviderDescriptor(provider.record.fd,access).equals(qualification.bytes) || !encode(provider.qualification).equals(qualification.bytes) ||
      !readOriginalHostedManagedProviderDescriptor(provider.capsule.fd,access).equals(encode(dependencyToolAdmittedGuestConfig(provider.qualification)))) invalid();
  if (provider.child) {
    if (!provider.command || !provider.args) invalid();
    assertHostedFdProcess(provider.child,unit,HostedFdLaunchKind.Provider,provider.command,provider.args);
  }
  const after = readCurrentHostedManagedDependencyProvider(context,fence,unit);
  if (!sameDependencyProtectedReference(after.reference,provider.reference)) invalid();
  return Object.freeze({qualification:provider.qualification,admission:provider.admission,capsulePath:provider.capsulePath,
    provider:selected.value,reference:selected.reference});
}
export function assertOriginalHostedManagedCapsuleCopy(context: CurrentHostedDependencyOrigin, fence: HostedActivationFence, unit: string, fd: number, access:symbol): void {
  assertOriginalHostedDependencyPhysicalRecordAccess(access);
  // The fixed FDA reader owns a temporary contained FD; no collector runs until it closes. This comparison registers no descriptor.
  assertHostedActivationFence(fence); readRetainedHostedDependencyAttemptFacts(context,DependencyOwnerPhase.Running);
  const provider = findOriginalHostedDependencyGenerationEntry(context,access).rootPurpose?.provider; if (!provider) invalid();
  if (provider.unit !== unit) invalid();
  const retained = fstatSync(provider.capsule.fd,{bigint:true}), actual = fstatSync(fd,{bigint:true});
  if (!sameStat(retained,actual) || !readOriginalHostedManagedProviderDescriptor(fd,access).equals(encode(dependencyToolAdmittedGuestConfig(provider.qualification)))) invalid();
}
