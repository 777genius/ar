import { NativeProbeKind, NativeProbeOperation, validateProbeAllocation, type NativeProbeFacts, type NativeProbeRequest } from "../domain/native-probe.js";
import type { NativeProbePort, OriginalNativeProbe } from "../ports/native-probe.js";
export async function issueNativeProbeAllocation(port: NativeProbePort, allocationId: string): Promise<OriginalNativeProbe> {
  const owned = await port.issueOriginal(allocationId); validateProbeAllocation(owned.allocation()); return owned;
}
export async function nativeProbe(port: NativeProbePort, request: NativeProbeRequest): Promise<NativeProbeFacts> {
  if (request.kind !== NativeProbeKind.NativeProbe || !Object.values(NativeProbeOperation).includes(request.operation)) throw new Error("unsupported NativeProbe request");
  const original = await port.resolveOriginal(request), allocation = original.allocation();
  validateProbeAllocation(allocation);
  if (allocation.jobId !== request.jobId || allocation.machineId !== request.machineId) throw new Error("foreign original allocation");
  switch (request.operation) {
    case NativeProbeOperation.Start: await original.startOnce(); break;
    case NativeProbeOperation.Stop: await original.closeOnce(); break;
    case NativeProbeOperation.Status: break;
  }
  return original.observeOriginal();
}
