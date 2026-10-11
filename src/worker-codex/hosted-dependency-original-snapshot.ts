import { observedProcessCgroup } from "./hosted-readonly-observations";
import { readFileSync } from "node:fs";
import { assertHostedActivationFence, assertHostedActivationOperator, type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { assertHostedFdProcess, HostedFdLaunchKind } from "../provider-codex/app-server/adapters/hosted-fd-child";
import { assertHostedProcessDescriptors } from "../provider-codex/app-server/adapters/hosted-process-descriptors";
import { assertHostedRetainedToolDescriptors, type HostedRetainedToolFiles } from "../provider-codex/app-server/adapters/hosted-retained-tool-files";
import { HostedDependencyColdInstallerPhase, type HostedDependencyColdState } from "./hosted-dependency-cold-materialization-state";
import type { RootPurposeState } from "./hosted-managed-dependency-session-state";
import { collectCurrentHostedOrdinaryDependencyOrigin } from "./hosted-dependency-current-facts";
import { collectActualHostedManagedReadonlyOrigin } from "./hosted-managed-readonly-origin-collector";
import { assertOriginalHostedDependencyPhysicalRecordAccess, assertOriginalHostedDependencyRootPurposeDescriptorState } from "./hosted-current-dependency-origin";
function invalid():never {throw new Error("hosted_dependency_current_origin_unresolved");}
/** Exact original physical/descriptor dispatch, protected by the original
 * lexical access before any state getter or IO. This is not a caller scope. */
function assertSelectedDescriptors(access:symbol,scope:HostedRetainedToolFiles|undefined, purpose:RootPurposeState|undefined):void {
  if (purpose?.descriptors.size) { if (scope !== undefined) invalid(); assertOriginalHostedDependencyRootPurposeDescriptorState(purpose,access); }
  else if (scope === undefined) assertHostedProcessDescriptors(); else assertHostedRetainedToolDescriptors(scope);
}
export function collectOriginalHostedDependencySnapshot(access:symbol,fence: HostedActivationFence, scope?: HostedRetainedToolFiles, rootPurpose?: RootPurposeState,cold?:HostedDependencyColdState) {
  assertOriginalHostedDependencyPhysicalRecordAccess(access);
  assertHostedActivationFence(fence); assertHostedActivationOperator();
  // Only the same privately retained actual FDA Installer role participates.
  // Generic/regular FD census is unchanged; no supplied descriptor exemptions.
  if(cold?.installerFrame && cold.installerPhase!==HostedDependencyColdInstallerPhase.Waited) {
    const frame=cold.installerFrame;assertHostedFdProcess(frame.child,frame.unit,HostedFdLaunchKind.Installer,frame.command,frame.args);
  }
  const group = observedProcessCgroup(readFileSync("/proc/self/cgroup","utf8"));
  if (/^0::\/subscription\.slice\/subscription-runtime\.slice\/subscription-runtime-hosted\.slice\/subscription-runtime-ordinary-[a-f0-9-]{36}\.service$/.test(group)) {
    assertSelectedDescriptors(access,scope,rootPurpose);
    const before = collectCurrentHostedOrdinaryDependencyOrigin(fence);
    assertSelectedDescriptors(access,scope,rootPurpose);
    const after = collectCurrentHostedOrdinaryDependencyOrigin(fence);
    if (before.digest !== after.digest) invalid(); return after;
  }
  const before = collectActualHostedManagedReadonlyOrigin(fence);
  assertSelectedDescriptors(access,scope,rootPurpose);
  const after = collectActualHostedManagedReadonlyOrigin(fence);
  if (after.digest !== before.digest) invalid();
  return after;
}
