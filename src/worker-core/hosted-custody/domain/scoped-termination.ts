import type { ChildCorrelation } from "../../project-control/domain/keyed-child-launch";
import { scopedDigest, parseScopedReceipt, type ScopedTerminationReceipt } from "@vioxen/subscription-runtime/core";
export { ScopedTerminationExtent, parseScopedOrdinaryReaderFinalReceipt, parseScopedProviderOnlyReceipt, ScopedTerminationKind, ScopedTerminationReason, ScopedTerminationOutcome, ScopedTerminationCause, ScopedSignal,
  scopedDigest, parseRetainedScopeIdentity, parseScopedStartCorrelation, parseScopedInvocation, parseScopedOperation, parseScopedReceipt, parseScopedSubmitter, parseScopedActorChain, parseScopedActorDischarge, bindScopedActorChain, validateScopedCollectedEvidence, ScopedEnqueueActorRole, ScopedActorDischargeMethod } from "@vioxen/subscription-runtime/core";
export type { ScopedOrdinaryReaderFinalReceipt, ScopedOrdinaryReaderFinalProvider, ScopedProviderOnlyReceipt, ScopedProviderOnlyMember, RetainedScopeIdentity, ScopedStartCorrelation, ScopedInvocation, ScopedSubmitter, ScopedTerminationMember,
  ScopedTerminationOperation, ScopedTerminationObservation, ScopedTerminationReceipt, ScopedActorChain, ScopedActorDischarge, ScopedEnqueueActor, ScopedCollectedEvidence, ScopedIdentityEvidence, ScopedCgroupNode } from "@vioxen/subscription-runtime/core";
function match(value: unknown, pattern: RegExp): void { if (typeof value !== "string" || !pattern.test(value)) throw new Error("scoped_record_invalid"); }
const hash = /^[a-f0-9]{64}$/;
export function stableChildDigest(binding: ChildCorrelation, intentGeneration: number): string {
  return scopedDigest([binding.authorityDigest, binding.slotId, binding.requestId, binding.operationId,
    binding.childHandle, binding.startId, binding.unitCorrelation, binding.profile, binding.keyDigest,
    binding.requestDigest, binding.promptDigest, intentGeneration]);
}
// Capabilities are issued and consumed by the concrete authenticated adapter.
// Domain successors are pure values; durable stores must authenticate the opaque
// capability and revalidate exact evidence before publishing these values.
declare const runtimeTerminationBrand: unique symbol;
export interface RuntimeValidatedTermination { readonly [runtimeTerminationBrand]: true; readonly receiptDigest: string }
declare const ordinaryTerminationBrand: unique symbol;
export interface RuntimeValidatedOrdinaryTermination { readonly [ordinaryTerminationBrand]: true }
