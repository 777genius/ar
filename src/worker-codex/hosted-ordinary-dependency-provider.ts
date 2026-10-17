import { withHostedActivationFence } from "./hosted-dependency-activation";
import type { CodexAppServerChildProcess } from "@vioxen/subscription-runtime/provider-codex";
import { codexProviderEgressProfileEnvVar } from "../provider-codex/codex-provider-egress-policy";
import { reserveHostedOrdinaryProviderFacts, type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { retryHostedFenceAcquisition } from "../provider-codex/app-server/adapters/hosted-fd-fence";
import { CurrentHostedDependencyOriginKind, readCurrentHostedManagedDependencyProviderParent,
  readCurrentHostedDependencySessionRefreshParent, publishCurrentHostedManagedDependencyProvider,
  spawnCurrentHostedManagedDependencyProvider, spawnCurrentHostedDependencySessionModelProbe, spawnCurrentHostedDependencySessionRefresh,
  observeCurrentHostedManagedDependencyProviderFrame, observeCurrentHostedDependencySessionRefreshFrame,
  releaseCurrentHostedManagedDependencyProviderFrame, releaseCurrentHostedDependencySessionRefreshFrame,
  invalidateCurrentHostedManagedDependencyProvider, invalidateCurrentHostedDependencySessionRefresh,
  remainingCurrentHostedManagedDependencyProviderSetup, signalCurrentHostedManagedDependencyProviderView,
  type CurrentHostedDependencyOrigin, type CurrentHostedDependencySessionHome } from "./hosted-current-dependency-origin";
function invalid():never {throw new Error("hosted_dependency_current_origin_unresolved");}
function reserve(context:CurrentHostedDependencyOrigin,fence:HostedActivationFence) {
  const actual=readCurrentHostedManagedDependencyProviderParent(context,fence);
  if (actual.facts.kind!==CurrentHostedDependencyOriginKind.Ordinary) invalid();
  // Reservation selects the authenticated logical workspace/profile. The private
  // fixed Plan separately authenticates the actual child home/cwd before spawn.
  const selected=reserveHostedOrdinaryProviderFacts(fence,{cwd:actual.binding.workspace.canonicalPath,
    env:{SUBSCRIPTION_RUNTIME_SANDBOX_KIND:"hosted-codex-job",[codexProviderEgressProfileEnvVar]:String(actual.facts.ordinary.profileId)}});
  readCurrentHostedManagedDependencyProviderParent(context,fence);return selected;
}
/** Fixed selected-C route; no process callback/row/child registration escapes. */
export function startCurrentHostedOrdinaryDependencyProvider(context:CurrentHostedDependencyOrigin,
  input:Readonly<{command:string;args:readonly string[];cwd:string;env:Readonly<Record<string,string>>}>):CodexAppServerChildProcess {
  const spawned=withHostedActivationFence(fence=>{
    const selected=reserve(context,fence); publishCurrentHostedManagedDependencyProvider(context,fence,selected.unit);
    const view=spawnCurrentHostedManagedDependencyProvider(context,fence,selected.unit,input);
    return {unit:selected.unit,view};
  });
  void observeCurrentHostedManagedDependencyProviderFrame(context,spawned.unit).then(()=>retryHostedFenceAcquisition(()=>{
    withHostedActivationFence(fence=>{
      readCurrentHostedManagedDependencyProviderParent(context,fence);
      releaseCurrentHostedManagedDependencyProviderFrame(context,fence,spawned.unit);
      readCurrentHostedManagedDependencyProviderParent(context,fence);
    });
  },remainingCurrentHostedManagedDependencyProviderSetup(context,spawned.unit))).catch(()=>{
    try {invalidateCurrentHostedManagedDependencyProvider(context,spawned.unit);
      signalCurrentHostedManagedDependencyProviderView(context,spawned.view,"SIGTERM");
    } catch { /* Revoked/unknown child stays held; a late callback cannot select a successor. */ }
  });
  return spawned.view;
}
/** Same original-issued home/use throughout catalog child drain and CLI refresh. */
export function startCurrentHostedOrdinaryDependencySessionBootstrap(home:CurrentHostedDependencySessionHome,probe:boolean):CodexAppServerChildProcess {
  const spawned=withHostedActivationFence(fence=>{
    const parent=readCurrentHostedDependencySessionRefreshParent(home,fence);
    if (parent.facts.kind!==CurrentHostedDependencyOriginKind.Ordinary) invalid();
    // No caller context or current/latest account selects this reservation.
    const selected=reserveHostedOrdinaryProviderFacts(fence,{cwd:parent.binding.workspace.canonicalPath,
      env:{SUBSCRIPTION_RUNTIME_SANDBOX_KIND:"hosted-codex-job",[codexProviderEgressProfileEnvVar]:String(parent.facts.ordinary.profileId)}});
    readCurrentHostedDependencySessionRefreshParent(home,fence);
    const view=probe ? spawnCurrentHostedDependencySessionModelProbe(home,fence,selected.unit) : spawnCurrentHostedDependencySessionRefresh(home,fence,selected.unit);
    return {unit:selected.unit,view};
  });
  void observeCurrentHostedDependencySessionRefreshFrame(home,spawned.unit).then(()=>retryHostedFenceAcquisition(()=>{
    withHostedActivationFence(fence=>{
      releaseCurrentHostedDependencySessionRefreshFrame(home,fence,spawned.unit);
    });
  },5000)).catch(()=>{try {invalidateCurrentHostedDependencySessionRefresh(home,spawned.unit);} catch { /* Revoked same-use setup remains held. */ }});
  return spawned.view;
}
