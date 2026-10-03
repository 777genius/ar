import { ScopedSignal, ScopedTerminationCause as Cause, ScopedTerminationOutcome as Outcome,
  ScopedTerminationReason, parseScopedOperation, parseScopedReceipt, type ScopedTerminationReceipt } from "../domain/scoped-termination";
import type { ScopedTerminationPort } from "../ports/scoped-termination-port";
export type ScopedTerminationResult = { readonly outcome: Outcome.Unresolved; readonly cause: Cause } |
  { readonly outcome: Outcome.ReceiptBacked; readonly receipt: ScopedTerminationReceipt };
/** One bounded attempt. Waits and collection are outside coordination; only
 * begin/publish may acquire it. Acknowledgments never supply observations. */
export class TerminateOwnedScope {
  constructor(private readonly port: ScopedTerminationPort, private readonly cleanupBudgetMs = 10_000) {
    if (!Number.isSafeInteger(cleanupBudgetMs) || cleanupBudgetMs < 1 || cleanupBudgetMs > 30_000) throw new Error("scoped_cleanup_budget_invalid");
  }
  async execute(reason: ScopedTerminationReason): Promise<ScopedTerminationResult> {
    const end = performance.now() + this.cleanupBudgetMs;
    let cause = Cause.Ownership;
    const remaining = () => { const ms = Math.floor(end - performance.now()); if (ms < 1) { cause = Cause.Budget; throw new Error("scoped_cleanup_exhausted"); } return ms; };
    try {
      this.port.authenticate(); cause = Cause.Correlation;
      const operation = parseScopedOperation(await this.port.begin(reason)); remaining();
      for (const member of operation.members) {
        cause = Cause.Creator; await this.port.fenceCreator(member, remaining());
        cause = Cause.Queue; await this.port.drainQueue(member, remaining());
        cause = Cause.Identity; await this.port.signal(member, ScopedSignal.Term, remaining());
      }
      const observations = [];
      for (const member of operation.members) {
        cause = Cause.Collection; let observation = await this.port.collect(member, remaining());
        if (!observation.identityUnchanged) { cause = Cause.Identity; throw new Error("scoped_identity_changed"); }
        if (!observation.recursiveEmpty) {
          cause = Cause.Identity; await this.port.signal(member, ScopedSignal.Kill, remaining());
          cause = Cause.Collection; observation = await this.port.collect(member, remaining());
        }
        if (!observation.creatorFenced) { cause = Cause.Creator; throw new Error("scoped_creator_live"); }
        if (!observation.queueEmpty) { cause = Cause.Queue; throw new Error("scoped_queue_live"); }
        if (!observation.recursiveEmpty) { cause = Cause.Descendants; throw new Error("scoped_descendants_live"); }
        observations.push(observation);
      }
      remaining(); cause = Cause.Publication;
      const receipt = parseScopedReceipt(await this.port.publish(operation, observations, remaining()));
      return { outcome: Outcome.ReceiptBacked, receipt };
    } catch { return { outcome: Outcome.Unresolved, cause }; }
  }
}
