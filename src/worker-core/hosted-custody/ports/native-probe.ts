import type { NativeProbeAllocation, NativeProbeFacts, NativeProbeRequest, OriginalProbeAttempt } from "../domain/native-probe.js";
// A read model cannot implement this nominal owning port.
export abstract class OriginalNativeProbe {
  readonly #original = true;
  protected constructor() { void this.#original; }
  abstract allocation(): NativeProbeAllocation;
  abstract startOnce(): Promise<void>;
  abstract closeOnce(): Promise<void>;
  abstract observeOriginal(): Promise<NativeProbeFacts>;
}
export interface NativeProbePort {
  resolveOriginal(request: NativeProbeRequest): Promise<OriginalNativeProbe>;
  issueOriginal(allocationId: string): Promise<OriginalNativeProbe>;
}
export interface RawProbeDeclarationClosurePort {
  retainOriginalClose(declarationIdentity: string, closeIdentity: string, attempt: OriginalProbeAttempt): Promise<void>;
}
