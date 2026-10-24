import type { CodexMaterializedSession } from "../../codex-json-execution-engine";
import { isReplaySafeTurnStartRejection } from "./app-server-turn-failure";
import { AppServerSlotAcquireAbortedError } from "./app-server-slot-pool";

type PoisonedHome = {
  readonly session: CodexMaterializedSession;
  readonly settled: Promise<void>;
  readonly settle: () => void;
  disposing: boolean;
};

/** Per-CODEX_HOME accounting for the shared slot: a failing run poisons its
 * home instead of stopping the shared session, and the poisoned session is
 * disposed exactly once, when its last user leaves or as soon as its client
 * is terminal. */
export class AppServerSessionDrain {
  private readonly refsByHome = new Map<string, number>();
  private readonly poisonedHomes = new Map<string, PoisonedHome>();

  constructor(
    private readonly disposeSessionSlot: (session: CodexMaterializedSession) => Promise<void>,
    private readonly isSessionSlotTerminal: (session: CodexMaterializedSession) => boolean,
  ) {}

  /** Returns a promise only when gated on a poisoned drain; the healthy path
   * must stay synchronous so callers keep their admission ordering. An abort
   * while gated leaves without a ref, exactly like an aborted slot acquire. */
  acquire(session: CodexMaterializedSession, abortSignal: AbortSignal): Promise<void> | undefined {
    const key = session.codexHome;
    const poisoned = this.poisonedHomes.get(key);
    if (!poisoned) {
      this.refsByHome.set(key, (this.refsByHome.get(key) ?? 0) + 1);
      return undefined;
    }
    if (abortSignal.aborted) return Promise.reject(new AppServerSlotAcquireAbortedError());
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(new AppServerSlotAcquireAbortedError());
      abortSignal.addEventListener("abort", onAbort, { once: true });
      void poisoned.settled.then(() => {
        abortSignal.removeEventListener("abort", onAbort);
        // The abort already rejected this waiter; taking a ref now would leak it.
        if (abortSignal.aborted) return;
        const next = this.acquire(session, abortSignal);
        if (next) next.then(resolve, reject); else resolve();
      });
    });
  }

  release(session: CodexMaterializedSession): void {
    const key = session.codexHome;
    const remaining = (this.refsByHome.get(key) ?? 1) - 1;
    if (remaining > 0) { this.refsByHome.set(key, remaining); return; }
    this.refsByHome.delete(key);
    void this.maybeDispose(key);
  }

  async poison(session: CodexMaterializedSession, error: unknown): Promise<void> {
    // A replay-safe turn-start rejection never reached the provider and leaves
    // the shared session healthy; disposing it would kill concurrent sibling runs.
    if (isReplaySafeTurnStartRejection(error)) return;
    const key = session.codexHome;
    const poisoned = this.poisonedHomes.get(key) ?? this.markPoisoned(key, session);
    // One stop per poisoned session. Deferring it only helps while siblings can
    // still finish: a terminal client would hand its dead slot to every ref
    // holder that has not reached ensureSlot yet.
    if (poisoned.disposing) return;
    if ((this.refsByHome.get(key) ?? 0) > 1 && !this.isSessionSlotTerminal(session)) return;
    await this.dispose(key, poisoned);
  }

  settleAll(): void {
    for (const poisoned of this.poisonedHomes.values()) poisoned.settle();
    this.poisonedHomes.clear();
  }

  private markPoisoned(key: string, session: CodexMaterializedSession): PoisonedHome {
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => { settle = resolve; });
    const poisoned = { session, settled, settle, disposing: false };
    this.poisonedHomes.set(key, poisoned);
    return poisoned;
  }

  private async maybeDispose(key: string): Promise<void> {
    const poisoned = this.poisonedHomes.get(key);
    if (!poisoned || poisoned.disposing || (this.refsByHome.get(key) ?? 0) > 0) return;
    try { await this.dispose(key, poisoned); }
    // The releasing run already settled; a deferred cleanup failure must never
    // surface in its place. The pool keeps its own unresolved-cleanup state.
    catch { /* deferred cleanup failure */ }
  }

  /** The poison gate holds until the stop settles, so no run starts a second
   * process on the same CODEX_HOME while the poisoned one is still stopping. */
  private async dispose(key: string, poisoned: PoisonedHome): Promise<void> {
    poisoned.disposing = true;
    try { await this.disposeSessionSlot(poisoned.session); }
    finally {
      if (this.poisonedHomes.get(key) === poisoned) this.poisonedHomes.delete(key);
      poisoned.settle();
    }
  }
}
