import { DependencyOwnerPhase } from "@vioxen/subscription-runtime/core";
import { assertHostedFdProcess, HostedFdLaunchKind } from "../provider-codex/app-server/adapters/hosted-fd-child";
import type { HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { HostedDependencyColdInstallerPhase } from "./hosted-dependency-cold-materialization-state";
import { findOriginalHostedDependencyGenerationEntry, assertCurrentHostedDependencyAttempt, type CurrentHostedDependencyOrigin,
  type CurrentHostedDependencyOriginFacts } from "./hosted-current-dependency-origin";
function invalid():never {throw new Error("hosted_dependency_current_origin_unresolved");}
/** Same fixed actual parent/FDA association selector. Lexical original access
 * and map identity are checked before any property or physical child read. */
export function readOriginalHostedDependencyGenerationNativeScope(context:CurrentHostedDependencyOrigin,fence:HostedActivationFence,access:symbol):Readonly<{units:readonly string[];facts:CurrentHostedDependencyOriginFacts}> {
  const retained=findOriginalHostedDependencyGenerationEntry(context,access);if(!retained.generation)invalid();
  const phase=retained.generation.ownerPhase;
  if(phase!==DependencyOwnerPhase.ExclusiveMutation && phase!==DependencyOwnerPhase.Running)invalid();
  const actual=assertCurrentHostedDependencyAttempt(context,fence,phase),units=[actual.attempt.launch.unit];
  const installer=retained.cold?.installerFrame;
  if(installer && retained.cold?.installerPhase!==HostedDependencyColdInstallerPhase.Waited) {
    assertHostedFdProcess(installer.child,installer.unit,HostedFdLaunchKind.Installer,installer.command,installer.args);units.push(installer.unit);
  }
  const provider=retained.rootPurpose?.provider;
  if(provider?.child) {if(!provider.command || !provider.args)invalid();assertHostedFdProcess(provider.child,provider.unit,HostedFdLaunchKind.Provider,provider.command,provider.args);units.push(provider.unit);}
  if(new Set(units).size!==units.length || units.length>3)invalid();return Object.freeze({units:Object.freeze(units),facts:actual.facts});
}
