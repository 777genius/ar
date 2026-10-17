import { HostedActivationPhase, type HostedActivation, type HostedOrdinaryReservation } from "./hosted-installation-activation";
import { HostedCustodyReservationState } from "./hosted-custody-epoch";
import type { ScopedOrdinaryReaderFinalReceipt, ScopedProviderOnlyMember } from "./scoped-termination";
function invalid():never {throw new Error("hosted_activation_invalid");}
function exact(row:HostedOrdinaryReservation|undefined,member:ScopedProviderOnlyMember):boolean {
  return !!row && row.startId===member.startId && row.unit===member.unit && row.creatorId===member.creatorId &&
    row.originSha256===member.originSha256 && row.generation===member.generation;
}
/** Pure scheduling guard only. OS/native/owner/installer proof is freshly
 * authenticated by the fixed adapter under its genuine held fence. */
export function assertOrdinaryReaderFinalSuccessor(prior:HostedActivation,next:HostedActivation,receipt:ScopedOrdinaryReaderFinalReceipt):void {
  const reader=prior.ordinaryStarts.find(row=>row.startId===receipt.reader.startId),after=next.ordinaryStarts.find(row=>row.startId===receipt.reader.startId);
  if (prior.phase!==HostedActivationPhase.Ordinary || next.phase!==HostedActivationPhase.Ordinary ||
      receipt.identity.installationId!==prior.installationId || receipt.identity.hostId!==prior.hostId ||
      receipt.identity.bootId!==prior.bootId || receipt.identity.supervisorId!==prior.supervisorId ||
      receipt.publicationGeneration!==next.generation || !exact(reader,receipt.reader) || !exact(after,receipt.reader) ||
      reader?.state!==HostedCustodyReservationState.Reserved || after?.state!==HostedCustodyReservationState.Terminal ||
      prior.ordinaryStarts.length!==next.ordinaryStarts.length || prior.ordinaryOriginsSha256!==next.ordinaryOriginsSha256) invalid();
  // Same-origin later provider rows are an exhaustive candidate census. A fixed
  // adapter must resolve EACH actual attempt relation; a missing relation never
  // becomes an assertion that a candidate is unrelated or never spawned.
  const candidates=prior.ordinaryStarts.filter(row=>row.unit.startsWith("subscription-runtime-hosted-") &&
    row.creatorId===receipt.reader.creatorId && row.originSha256===receipt.reader.originSha256 && row.generation>receipt.reader.generation);
  if (candidates.length!==receipt.providers.length || candidates.some((row,index)=>
      row.state!==HostedCustodyReservationState.Terminal || !exact(row,receipt.providers[index]!.member))) invalid();
  for (let index=0;index<prior.ordinaryStarts.length;index++) {
    const row=prior.ordinaryStarts[index]!,current=next.ordinaryStarts[index];
    if (!current || row.startId!==receipt.reader.startId && JSON.stringify(row)!==JSON.stringify(current)) invalid();
  }
}
