import { SubscriptionWorkerError } from "@vioxen/subscription-runtime/worker-core";

type ManagedResumeResult = {
  readonly status?: "completed";
} | {
  readonly status: "waiting_for_input";
  readonly runId: string;
};

/** Instance-local admission and retained provider ownership for one binding. */
export class FileBackendCodexSessionBinding {
  private busy = false;
  private readonly managedRunIds = new Set<string>();

  constructor(private readonly ownsManagedRun: ((runId: string) => boolean) | undefined) {}

  trackManagedRun(runId: string): void {
    // Remember the id before provider IO: even failed waiting-result
    // persistence can leave a live managed provider session in the driver.
    this.managedRunIds.add(runId);
  }

  isInUse(): boolean {
    return this.busy || this.hasRetainedManagedRun();
  }

  async reserveResume<T extends ManagedResumeResult>(
    runId: string,
    importSource: () => Promise<void>,
    operation: () => Promise<T>,
  ): Promise<T> {
    return await this.reserve(async () => {
      this.trackManagedRun(runId);
      // A retained provider session still uses the old binding. A durable
      // recovery with no live session can adopt the current source at admission.
      if (this.ownsManagedRun && !this.ownsManagedRun(runId)) await importSource();
      const result = await operation();
      if (result.status === "waiting_for_input") this.trackManagedRun(result.runId);
      return result;
    }, runId);
  }

  async reserve<T>(operation: () => Promise<T>, resumedRunId?: string): Promise<T> {
    if (this.busy || this.hasRetainedManagedRun(resumedRunId)) {
      throw new SubscriptionWorkerError(
        "subscription_worker_run_failed",
        "Codex session binding is in use; wait for the operation and any managed resume to settle before reseeding or starting another operation.",
        { details: { reason: "codex_session_binding_busy" } },
      );
    }
    // Reserve synchronously, before seed/import IO or provider admission. The
    // mutable seeder and capacity tracker belong to this one operation until
    // all failure attribution, quota accounting and refresh publication finish.
    this.busy = true;
    try {
      return await operation();
    } finally {
      this.busy = false;
    }
  }

  private hasRetainedManagedRun(resumedRunId?: string): boolean {
    let retainedOtherRun = false;
    for (const runId of this.managedRunIds) {
      if (!this.ownsManagedRun?.(runId)) {
        this.managedRunIds.delete(runId);
      } else if (runId !== resumedRunId) {
        retainedOtherRun = true;
      }
    }
    return retainedOtherRun;
  }
}
