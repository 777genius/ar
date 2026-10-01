import type { ChildCorrelation } from "../../project-control/domain/keyed-child-launch";
import { scopedDigest, parseScopedReceipt, type ScopedTerminationReceipt } from "@vioxen/subscription-runtime/core";
export { ScopedTerminationKind, ScopedTerminationReason, ScopedTerminationOutcome, ScopedTerminationCause, ScopedSignal,
  scopedDigest, parseRetainedScopeIdentity, parseScopedStartCorrelation, parseScopedInvocation, parseScopedOperation, parseScopedReceipt, parseScopedSubmitter } from "@vioxen/subscription-runtime/core";
export type { RetainedScopeIdentity, ScopedStartCorrelation, ScopedInvocation, ScopedSubmitter, ScopedTerminationMember,
  ScopedTerminationOperation, ScopedTerminationObservation, ScopedTerminationReceipt } from "@vioxen/subscription-runtime/core";
function match(value: unknown, pattern: RegExp): void { if (typeof value !== "string" || !pattern.test(value)) throw new Error("scoped_record_invalid"); }
const hash = /^[a-f0-9]{64}$/;
export function stableChildDigest(binding: ChildCorrelation, intentGeneration: number): string {
  return scopedDigest([binding.authorityDigest, binding.slotId, binding.requestId, binding.operationId,
    binding.childHandle, binding.startId, binding.unitCorrelation, binding.profile, binding.keyDigest,
    binding.requestDigest, binding.promptDigest, intentGeneration]);
}
const validated = new WeakMap<object, { stableDigest: string; receiptDigest: string }>();
/** A trusted port validates durable bytes and all ordinary successors on every
 * call. DTOs/restoration do not enter this registry. Port injection is host-only. */
export class ScopedTerminationValidator {
  constructor(private readonly validate: (binding: ChildCorrelation, intentGeneration: number, receiptDigest: string) => void) {}
  authorize(binding: ChildCorrelation, intentGeneration: number, receiptDigest: string): RuntimeValidatedTermination {
    match(receiptDigest, hash); this.validate(binding, intentGeneration, receiptDigest);
    const authority = Object.freeze({ receiptDigest });
    validated.set(authority, { stableDigest: stableChildDigest(binding, intentGeneration), receiptDigest });
    return authority as RuntimeValidatedTermination;
  }
}
declare const runtimeTerminationBrand: unique symbol;
export interface RuntimeValidatedTermination { readonly [runtimeTerminationBrand]: true; readonly receiptDigest: string }
export function assertRuntimeValidatedTermination(value: RuntimeValidatedTermination, binding: ChildCorrelation, intentGeneration: number): void {
  const retained = validated.get(value);
  if (!retained || retained.receiptDigest !== value.receiptDigest || retained.stableDigest !== stableChildDigest(binding, intentGeneration)) throw new Error("scoped_terminal_authority_required");
}

const ordinaryValidated = new WeakMap<object, ScopedTerminationReceipt>();
declare const ordinaryTerminationBrand: unique symbol;
export interface RuntimeValidatedOrdinaryTermination { readonly [ordinaryTerminationBrand]: true }
export class OrdinaryTerminationValidator {
  constructor(private readonly validate: (receiptDigest: string) => ScopedTerminationReceipt) {}
  authorize(receiptDigest: string): RuntimeValidatedOrdinaryTermination {
    match(receiptDigest, hash);
    const receipt = parseScopedReceipt(this.validate(receiptDigest));
    const authority = Object.freeze({}); ordinaryValidated.set(authority, receipt);
    return authority as RuntimeValidatedOrdinaryTermination;
  }
}
export function scopedOrdinaryAuthority(value: RuntimeValidatedOrdinaryTermination): ScopedTerminationReceipt {
  const receipt = ordinaryValidated.get(value);
  if (!receipt) throw new Error("scoped_ordinary_authority_required"); return receipt;
}
