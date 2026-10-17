/** One finite H1 continuation of the existing supervisor's own qualifier. */
import assert from "node:assert/strict";
import { FullRemovalCase } from "../../host-integration/managed-launcher/dependency-full-native-TEST.js";
export interface H1SupervisionPorts {
  readonly ready:(qualifierPid:number)=>void|Promise<void>;
  readonly recover:()=>Promise<Readonly<{pid:number;code:number|null;signal:NodeJS.Signals|null}>>;
  readonly complete:()=>void;
  readonly publish:(qualifierPid:number,recoveryPid:number)=>void;
}
export function originalH1Continuation(removalCase:FullRemovalCase,ports:H1SupervisionPorts){
  let consumed=false;
  return async(qualifier:Readonly<{pid:number;code:number|null;signal:NodeJS.Signals|null}>):Promise<void>=>{
    assert.equal(removalCase,FullRemovalCase.ParentCrashH1);assert(!consumed);consumed=true;
    assert(Number.isSafeInteger(qualifier.pid) && qualifier.pid>0 && qualifier.code===null && qualifier.signal==="SIGKILL");
    // The protected reader itself bounds only verified incomplete publication.
    // Contradiction/authentication failures must propagate without retry.
    await ports.ready(qualifier.pid);
    const recovery=await ports.recover();
    assert(Number.isSafeInteger(recovery.pid) && recovery.pid>0 && recovery.pid!==qualifier.pid && recovery.code===0 && recovery.signal===null);
    ports.complete();ports.publish(qualifier.pid,recovery.pid);
  };
}
