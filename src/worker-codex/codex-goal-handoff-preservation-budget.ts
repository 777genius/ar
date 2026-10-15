/** Finite preservation bounds, separate from the unchanged Git read budget. */
export const handoffPreservationBudget = Object.freeze({
  sourceFileBytes: 8 * 1024 * 1024,
  untrackedBytes: 64 * 1024 * 1024,
  packetFileBytes: 128 * 1024 * 1024,
  packetBytes: 256 * 1024 * 1024,
});
export enum HandoffPreservationRefusalReason {
  File = "handoff_file_byte_limit_exceeded",
  Total = "handoff_total_byte_limit_exceeded",
  Privacy = "handoff_raw_secret_rejected",
}
/** Only exact normalized materializer refusals qualify; paths/causes are never copied. */
export function handoffPreservationRefusalReason(error: unknown): HandoffPreservationRefusalReason | undefined {
  if (!(error instanceof Error)) return;
  return Object.values(HandoffPreservationRefusalReason).find(code =>
    error.message === code || error.message === `dirty_terminal_handoff_unavailable:${code}`);
}
export class MimoPreservationRefused extends Error {
  constructor(reason: HandoffPreservationRefusalReason) {
    super(reason === HandoffPreservationRefusalReason.Privacy
      ? "hosted_mimo_worker_preservation_privacy_refused" : "hosted_mimo_worker_preservation_budget_exceeded");
  }
}
