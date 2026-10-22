import { consumeOriginalHostedDependencyColdHandoff, assertOriginalHostedDependencyConsumedColdHandoff,
  closeOriginalHostedDependencyColdHandoff } from "./hosted-dependency-cold-controller";
import type { DependencyAttempt } from "@vioxen/subscription-runtime/worker-core";
import type { HostedDependencyBinding } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import type { HostedDependencyKeyInputs } from "./hosted-dependency-materialization-context";
import type { HostedDependencyColdReady, HostedDependencyColdResult } from "./hosted-dependency-cold-materialization-state";
import type { HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { DependencyAdmissionError, DependencyAdmissionFailure } from "@vioxen/subscription-runtime/worker-core";
import type { CurrentHostedDependencyOrigin } from "./hosted-current-dependency-origin";
/** An opaque view refers to the SAME original map; it stores no observation,
 * Ready receipt, owner, phase or independent provenance. Constructors and
 * dispatch are frozen here before exports can escape. */
export class OriginalHostedDependencyColdHandoff {
  readonly #origin:CurrentHostedDependencyOrigin;
  readonly #access:symbol;
  constructor(readonly startId:string,origin:CurrentHostedDependencyOrigin,access:symbol) {
    this.#origin=origin;this.#access=access;
  }
  static resolve(value:unknown,access:symbol):CurrentHostedDependencyOrigin | undefined {
    if (!value || typeof value!=="object" || !(#access in value) || value.#access!==access) return undefined;
    return value.#origin;
  }
  static consume(value:unknown,binding:HostedDependencyBinding,attempt:DependencyAttempt,inputs:HostedDependencyKeyInputs,ready:HostedDependencyColdReady):Pick<HostedDependencyColdResult,"observed"|"reference"|"exposure"|"source"> {
    if(!value || typeof value!=="object" || !(#access in value))throw new DependencyAdmissionError(DependencyAdmissionFailure.StaleAttempt);
    return consumeOriginalHostedDependencyColdHandoff(value,binding,attempt,inputs,ready,value.#access);
  }
  static assertConsumed(value:unknown,fence:HostedActivationFence):void {
    if(!value || typeof value!=="object" || !(#access in value))throw new DependencyAdmissionError(DependencyAdmissionFailure.StaleAttempt);
    assertOriginalHostedDependencyConsumedColdHandoff(value,fence,value.#access);
  }
  static close(value:unknown):void {
    if(!value || typeof value!=="object" || !(#access in value))return;
    // A counterfeit own symbol is not authority and closes no actual resource.
    if(value.#origin!==OriginalHostedDependencyColdHandoff.resolve(value,value.#access))return;
    closeOriginalHostedDependencyColdHandoff(value,value.#access);
  }

}
// Freeze the actual runtime dispatch in its defining module, before export
// consumers can replace it and before any lexical access is ever supplied.
Object.freeze(OriginalHostedDependencyColdHandoff.prototype);
Object.freeze(OriginalHostedDependencyColdHandoff);
export function consumeCurrentHostedDependencyColdHandoff(handle:Readonly<{startId:string}>,binding:HostedDependencyBinding,
  attempt:DependencyAttempt,inputs:HostedDependencyKeyInputs,ready:HostedDependencyColdReady):Pick<HostedDependencyColdResult,"observed"|"reference"|"exposure"|"source"> {
  return OriginalHostedDependencyColdHandoff.consume(handle,binding,attempt,inputs,ready);
}
export function assertCurrentHostedDependencyConsumedColdHandoff(handle:Readonly<{startId:string}>,fence:HostedActivationFence):void {
  OriginalHostedDependencyColdHandoff.assertConsumed(handle,fence);
}
export function closeCurrentHostedDependencyColdHandoff(handle:Readonly<{startId:string}>|undefined):void {
  OriginalHostedDependencyColdHandoff.close(handle);
}
