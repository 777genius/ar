import { KeyedChildState as State, type ChildCorrelation, type ChildLaunchRequest,
  type ChildObservation, type ChildScope } from "../domain/keyed-child-launch";

import { KeyedLaunchReason, type KeyedLaunchView } from "@vioxen/subscription-runtime/core";
export { KeyedLaunchReason, type KeyedLaunchView } from "@vioxen/subscription-runtime/core";
import { ScopedStopReason, type KeyedChildApplicationPort } from "../ports/keyed-child-application-ports";
export * from "../ports/keyed-child-application-ports";

/** Response cancellation is independent of this owner's accepted work. An
 * existing record NEVER schedules preparation or dispatch, even after restart. */
export class KeyedChildLaunchApplication {
  readonly #owned = new Map<string, Promise<void>>();
  readonly #deadlines = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(private readonly port: KeyedChildApplicationPort) {}
  assertAuthority(scope: ChildScope, digest: string): void {
    this.port.authenticate();
    if (digest !== this.port.authorityDigest || scope.projectId !== this.port.scope.projectId ||
        scope.workstreamId !== this.port.scope.workstreamId || scope.controllerId !== this.port.scope.controllerId) {
      throw new Error("keyed_application_foreign_authority");
    }
  }
  async launch(request: ChildLaunchRequest, signal: AbortSignal): Promise<KeyedLaunchView> {
    this.port.authenticate();
    const accepted = await this.port.coordinate(async () => {
      this.port.authenticate();
      if (signal.aborted) throw new Error("keyed_launch_cancelled_before_claim");
      const current = this.port.read();
      const ledger = await this.port.transact(this.port.scope, this.port.authorityDigest,
        current.generation, l => {
          const next = l.accept(l.generation, request, Date.now());
          if (next !== l) this.port.beforeFreshClaim(next.snapshot().accepted.at(-1)!.allocation.slotId);
          return next;
        });
      const row = ledger.snapshot().accepted.find(c => c.key === request.key)!;
      return { view: ledger.observe(this.port.scope, row.allocation.childHandle),
        fresh: ledger.generation !== current.generation };
    });
    // Scheduling happens only after the claim's final durability check.
    if (accepted.fresh) {
      const expire = () => {
        const remaining = this.port.deadlineEpochMs - Date.now();
        if (remaining > 0) {
          const timer = setTimeout(expire, Math.min(2147483647, remaining)); timer.unref();
          this.#deadlines.set(accepted.view.childHandle, timer); return;
        }
        this.#deadlines.delete(accepted.view.childHandle);
        void this.stop(accepted.view.childHandle, ScopedStopReason.Deadline).catch(() => {});
      };
      expire();
      const work = Promise.resolve().then(() => this.#prepare(accepted.view, request.task))
        .catch(() => this.#hold(accepted.view));
      this.#owned.set(accepted.view.childHandle, work);
      void work.finally(() => this.#owned.delete(accepted.view.childHandle));
    }
    return this.#view(accepted.view);
  }
  async observe(handle: string): Promise<KeyedLaunchView> {
    this.port.authenticate();
    return this.port.coordinate(async () => {
      this.port.authenticate();
      return this.#view(this.port.read().observe(this.port.scope, handle));
    });
  }
  async stop(handle: string, reason = ScopedStopReason.Requested): Promise<KeyedLaunchView> {
    this.port.authenticate();
    const stopped = await this.port.coordinate(async () => {
      this.port.authenticate();
      const current = this.port.read();
      const binding = current.observe(this.port.scope, handle); // Authorization before target effects.
      const next = await this.port.transact(this.port.scope, this.port.authorityDigest,
        current.generation, l => l.stop(binding));
      return next.observe(this.port.scope, handle);
    });
    // Unresolved, throwing and absent stop ports cannot cancel the original
    // deadline. Only an authoritative terminal observation permits cancellation.
    if (stopped.state !== State.Terminal) {
      try { await this.port.stopPort?.request(stopped, reason); } catch { /* Unresolved, retained. */ }
    }
    return this.#view(stopped);
  }
  /** Owner shutdown/testing can join work; no foreground wait holds coordination. */
  async drain(): Promise<void> { await Promise.all(this.#owned.values()); }
  async #advance(binding: ChildCorrelation, from: State, to: State): Promise<ChildObservation | null> {
    return this.port.coordinate(async () => {
      this.port.authenticate();
      const current = this.port.read(), latest = current.observe(this.port.scope, binding.childHandle);
      if (latest.state !== from || latest.generation !== binding.generation) return null;
      // Advance with the retained binding, so the domain checks full identity
      // as well as generation after work outside coordination.
      const next = await this.port.transact(this.port.scope, this.port.authorityDigest,
        current.generation, l => l.advance(binding, to, Date.now()));
      return next.observe(this.port.scope, binding.childHandle);
    });
  }
  async #prepare(binding: ChildObservation, task: string): Promise<void> {
    const preparing = await this.#advance(binding, State.Claimed, State.Materializing);
    if (!preparing) return;
    await this.port.materialize(preparing, task);
    const prepared = await this.#advance(preparing, State.Materializing, State.Prepared);
    if (!prepared) return;
    const ack = await this.port.coordinate(async () => {
      this.port.authenticate();
      const latest = this.port.read().observe(this.port.scope, binding.childHandle);
      if (latest.state !== State.Prepared || latest.generation !== prepared.generation) return null;
      // Adapter owns fresh intent + reservation/start + OS call in ONE sync fence.
      return this.port.dispatchPrepared(prepared);
    });
    if (ack?.completion) {
      try { await ack.completion; } finally { await this.#hold(binding); }
    }
  }
  async #hold(binding: ChildCorrelation): Promise<void> {
    try {
      await this.port.coordinate(async () => {
        this.port.authenticate();
        const current = this.port.read(), latest = current.observe(this.port.scope, binding.childHandle);
        // Late completion cannot regress stop or terminal state. No stale CAS.
        if (latest.state === State.Terminal) { this.#view(latest); return; }
        if (latest.state === State.StopRequested) return;
        await this.port.transact(this.port.scope, this.port.authorityDigest,
          current.generation, l => l.markUncertain(latest));
      });
      if (Date.now() >= this.port.deadlineEpochMs) await this.stop(binding.childHandle, ScopedStopReason.Deadline);
    } catch { /* Corrupt/pending storage remains authoritative; never reconstruct/release. */ }
  }
  #view(o: ChildObservation): KeyedLaunchView {
    if (o.state === State.Terminal) {
      const timer = this.#deadlines.get(o.childHandle);
      if (timer) { clearTimeout(timer); this.#deadlines.delete(o.childHandle); }
    }
    return Object.freeze({ operationHandle: o.operationId, childHandle: o.childHandle,
      state: o.state, occupied: o.state !== State.Terminal, stopRequested: o.state === State.StopRequested,
      deadlineEpochMs: this.port.deadlineEpochMs, maxGoalTurns: this.port.maxGoalTurns,
      reason: o.state === State.StopRequested ? KeyedLaunchReason.TerminationUnresolved :
        o.state === State.Uncertain || o.state === State.DispatchIntent ? KeyedLaunchReason.Held : KeyedLaunchReason.None });
  }
}
