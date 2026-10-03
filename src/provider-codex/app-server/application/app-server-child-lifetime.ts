import { ChildExecutionBudget } from "@vioxen/subscription-runtime/core";

/** Provider transport enforcement. Cleanup controls retain custody; a process
 * stop request never supplies a host termination receipt. */
export class AppServerChildLifetime {
  private started = false;
  private timer: NodeJS.Timeout | undefined;
  constructor(readonly budget: ChildExecutionBudget, private readonly port: {
    readonly isTerminal: () => boolean;
    readonly activeTurns: () => readonly (readonly [string, string])[];
    readonly recordTerminal: (error: Error) => void;
    readonly interrupt: (threadId: string, turnId: string) => void;
    readonly stop: () => Promise<void>;
  }) {}
  beforeProviderStart(nativeSurface: string | undefined, controllerTools: boolean): void {
    this.budget.beforeProviderStart();
    if (this.started) throw new Error("child_provider_restart_denied");
    if (nativeSurface !== "disabled" || controllerTools) throw new Error("child_client_confinement_conflict");
    this.started = true;
  }
  write(method: string, action: () => boolean): boolean {
    try {
      this.budget.remainingMs();
      if (method === "turn/start") this.budget.beforeTurnWrite();
      return action();
    } catch (error) { this.cleanup(error); throw error; }
  }
  eventAllowed(): boolean {
    try { this.budget.remainingMs(); return true; }
    catch (error) { this.cleanup(error); return false; }
  }
  armDeadline(): void {
    if (this.port.isTerminal()) return;
    try {
      this.timer = setTimeout(() => this.armDeadline(), Math.min(2147483647, this.budget.remainingMs()));
      this.timer.unref();
    } catch (error) { this.cleanup(error); }
  }
  cleanup(error: unknown): void {
    if (this.port.isTerminal()) return;
    const active = this.port.activeTurns();
    this.port.recordTerminal(error instanceof Error ? error : new Error("child_cleanup_requested"));
    for (const [threadId, turnId] of active) {
      try { this.port.interrupt(threadId, turnId); }
      catch { /* Ambiguous cancellation retains ownership; still request process stop. */ }
    }
    void this.port.stop().catch(() => undefined);
  }
  disposeTimer(): void { if (this.timer) clearTimeout(this.timer); }
}
