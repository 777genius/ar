import type { CodexMaterializedSession } from "../../codex-json-execution-engine";
import { isReplaySafeTurnStartRejection } from "./app-server-turn-failure";

type PoisonedHome = {
  readonly session: CodexMaterializedSession;
  readonly settled: Promise<void>;
  readonly settle: () => void;
};

/** Per-CODEX_HOME accounting for the shared slot: a failing run poisons its
 * home instead of stopping the shared session, and the poisoned session is
 * disposed exactly once when its last user leaves. */
export class AppServerSessionDrain {
  private readonly refsByHome = new Map<string, number>();
  private readonly poisonedHomes = new Map<string, PoisonedHome>();

  constructor(private readonly disposeSessionSlot: (session: CodexMaterializedSession) => Promise<void>) {}

  /** Returns a promise only when gated on a poisoned drain; the healthy path
   * must stay synchronous so callers keep their admission ordering. */
  acquire(session: CodexMaterializedSession): Promise<void> | undefined {
    const key = session.codexHome;
    const poisoned = this.poisonedHomes.get(key);
    if (!poisoned) {
      this.refsByHome.set(key, (this.refsByHome.get(key) ?? 0) + 1);
      return undefined;
    }
    return poisoned.settled.then(() => this.acquire(session)).then(() => undefined);
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
    // A second failure on a poisoned session must not schedule a second stop.
    if (this.poisonedHomes.has(key)) return;
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => { settle = resolve; });
    this.poisonedHomes.set(key, { session, settled, settle });
    if ((this.refsByHome.get(key) ?? 0) > 1) return;
    this.poisonedHomes.delete(key);
    try { await this.disposeSessionSlot(session); }
    finally { settle(); }
  }

  settleAll(): void {
    for (const poisoned of this.poisonedHomes.values()) poisoned.settle();
    this.poisonedHomes.clear();
  }

  private async maybeDispose(key: string): Promise<void> {
    const poisoned = this.poisonedHomes.get(key);
    if (!poisoned || (this.refsByHome.get(key) ?? 0) > 0) return;
    this.poisonedHomes.delete(key);
    try { await this.disposeSessionSlot(poisoned.session); }
    // The releasing run already settled; a deferred cleanup failure must never
    // surface in its place. The pool keeps its own unresolved-cleanup state.
    catch { /* deferred cleanup failure */ }
    poisoned.settle();
  }
}
