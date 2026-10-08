import { retainedResourceDigest } from "../core/scoped-retained-resource-contract.js";
import { nativeProbe } from "../worker-core/hosted-custody/application/native-probe.js";
import { NativeProbeKind, NativeProbeOperation, ProbeAdmission, ProbeInventory, ProbePrefix, validateProbeAllocation, type NativeProbeAllocation, type NativeProbeFacts, type NativeProbeRequest } from "../worker-core/hosted-custody/domain/native-probe.js";
import { OriginalNativeProbe, type NativeProbePort } from "../worker-core/hosted-custody/ports/native-probe.js";
import { requestOriginalData } from "./original-owner-client.js";
interface OriginalData { readonly allocation: NativeProbeAllocation; readonly childReady: true; readonly effectiveCleanupEndNs: string; readonly effectiveWorkEndNs: string; readonly helperCommitted: boolean; readonly helperStarted: boolean; readonly nativeClosed: boolean }
function decode(value: unknown, request: NativeProbeRequest): OriginalData {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== "allocation,childReady,effectiveCleanupEndNs,effectiveWorkEndNs,helperCommitted,helperStarted,nativeClosed") throw new Error("invalid original observation");
  const data = value as OriginalData; validateProbeAllocation(data.allocation);
  if (data.childReady !== true || [data.helperCommitted,data.helperStarted,data.nativeClosed].some(v => typeof v !== "boolean") || !/^[1-9][0-9]{0,18}$/.test(data.effectiveWorkEndNs) || !/^[1-9][0-9]{0,18}$/.test(data.effectiveCleanupEndNs) || data.allocation.jobId !== request.jobId || data.allocation.machineId !== request.machineId || retainedResourceDigest(data.allocation) !== request.allocationDigest || data.allocation.declarations.length !== 3 || BigInt(data.effectiveWorkEndNs) >= BigInt(data.effectiveCleanupEndNs) || data.allocation.declarations.some(row => row.workEndNs !== data.effectiveWorkEndNs || BigInt(row.cleanupEndNs) < BigInt(data.effectiveCleanupEndNs))) throw new Error("foreign original observation");
  return data;
}
// This is a transport proxy for an already-issued native tuple. Registry
// membership and every final effect check stay inside the real native producer.
class InstalledOriginalProxy extends OriginalNativeProbe {
  #data: OriginalData;
  constructor(readonly request: NativeProbeRequest, data: OriginalData) { super(); this.#data=data; }
  allocation(): NativeProbeAllocation { return this.#data.allocation; }
  async startOnce(): Promise<void> { this.#data=decode(await requestOriginalData({...this.request,operation:NativeProbeOperation.Start}),this.request); }
  async closeOnce(): Promise<void> { this.#data=decode(await requestOriginalData({...this.request,operation:NativeProbeOperation.Stop}),this.request); }
  async observeOriginal(): Promise<NativeProbeFacts> {
    // Stop's original response records dispatch. Settlement is observed only by
    // the original administrative foreground observer after native termination.
    const data=this.#data, inventory=new ProbeInventory(data.allocation);
    for(const [i,row] of data.allocation.declarations.entries()) {
      inventory.tighten(row.identity,{preparationNs:data.effectiveWorkEndNs,cleanupNs:row.cleanupEndNs,observationNs:data.effectiveCleanupEndNs});
      if(i<2||data.helperStarted)inventory.materialize(row.identity);
    }
    if(data.nativeClosed)inventory.close("native-original-close");
    return Object.freeze({kind:NativeProbeKind.NativeProbe,allocationDigest:this.request.allocationDigest,admission:data.nativeClosed?ProbeAdmission.Closed:ProbeAdmission.Open,originalStart:data.helperCommitted?ProbePrefix.Retained:data.helperStarted?ProbePrefix.Dispatched:ProbePrefix.Unsent,originalStop:data.nativeClosed?ProbePrefix.Dispatched:ProbePrefix.Unsent,preparationEndNs:data.effectiveWorkEndNs,absoluteCleanupEndNs:data.effectiveCleanupEndNs,declarations:inventory.snapshot().map(row=>Object.freeze({...row,debt:true})),infrastructureTasksObserved:data.helperStarted?3:2,allocationBirths:0,completeHold:false,workQualified:false});
  }
}
const installed: NativeProbePort = Object.freeze({
  async resolveOriginal(request: NativeProbeRequest): Promise<OriginalNativeProbe> { return new InstalledOriginalProxy(request,decode(await requestOriginalData({...request,operation:NativeProbeOperation.Status}),request)); },
  async issueOriginal(): Promise<OriginalNativeProbe> { throw new Error("original issuance requires the fixed Root administrative operation"); },
});
export async function installedNativeProbe(request: NativeProbeRequest): Promise<NativeProbeFacts> { return nativeProbe(installed,request); }
