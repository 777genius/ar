import type { readCurrentHostedManagedDependencyProviderParent } from "./hosted-current-dependency-origin";
import type { ManagedProviderState, ManagedSessionHomeState, ManagedSessionUseState } from "./hosted-managed-dependency-session-state";
import { freezeFacts } from "./hosted-dependency-immutable-facts";
type NativeWaitFields = Readonly<Pick<ManagedProviderState,"reference"|"proxyClosed"|"proxyPid"|"proxyBirth"|"invocationId"|"proxySignal"|"proxyCode"|"inputPending"|"inputBytes"|"home"|"executionUse">>;
/** Pure captured-field validation and serialization. The caller inside the
 * sole original map selects actual private child/use/home; these facts cannot
 * register a child, complete an epoch or authorize a store transition. */
export function formManagedProviderWaitFacts(parent:ReturnType<typeof readCurrentHostedManagedDependencyProviderParent>,
  native:NativeWaitFields,home:ManagedSessionHomeState|undefined,use:ManagedSessionUseState) {
  if (!native.proxyClosed || !native.proxyPid || !native.proxyBirth || !native.invocationId || native.proxySignal!==null ||
      !Number.isInteger(native.proxyCode) || native.proxyCode===null || native.proxyCode===undefined || native.proxyCode<0 || native.proxyCode>255)
    throw new Error("hosted_dependency_current_origin_unresolved");
  if ((native.inputPending ?? 0)!==0 || (native.inputBytes ?? 0)!==0 || !native.home || native.home!==home ||
      use!==native.executionUse || use.home!==native.home.facade || !use.account || !use.restoredHash)
    throw new Error("hosted_dependency_current_origin_unresolved");
  return freezeFacts({parent,reference:native.reference,pid:native.proxyPid,birth:native.proxyBirth,invocationId:native.invocationId,
    waitStatus:native.proxyCode,home:native.home.root,use:{accountId:use.account,restoredHash:use.restoredHash}});
}
