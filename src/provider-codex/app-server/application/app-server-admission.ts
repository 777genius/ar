/** Local backpressure. Rejection must never poison a shared provider slot. */
export class AppServerAdmissionError extends Error {
  constructor(readonly reason: "capacity" | "thread_busy") {
    super(`codex_app_server_admission_rejected:${reason}`);
    this.name = "AppServerAdmissionError";
  }
}

export function isAppServerAdmissionError(error: unknown): boolean {
  const seen = new Set<Error>();
  while (error instanceof Error && !seen.has(error)) {
    if (error instanceof AppServerAdmissionError) return true;
    seen.add(error);
    error = error.cause;
  }
  return false;
}

export const appServerTurnCapacity = 128;

/** Synchronous admission avoids allocating an unbounded waiter queue. */
export class AppServerAdmission {
  private readonly active = new Set<symbol>();
  private readonly threads = new Set<string>();

  acquire(threadId?: string): () => void {
    if (threadId !== undefined && this.threads.has(threadId)) {
      throw new AppServerAdmissionError("thread_busy");
    }
    if (this.active.size >= appServerTurnCapacity) {
      throw new AppServerAdmissionError("capacity");
    }
    const token = Symbol();
    this.active.add(token);
    if (threadId !== undefined) this.threads.add(threadId);
    return () => {
      if (!this.active.delete(token)) return;
      if (threadId !== undefined) this.threads.delete(threadId);
    };
  }
}

/** Holds usage history across thread setup and successive goal turns. */
export class AppServerExecutionLease {
  private readonly releases = new Map<string, () => void>();
  constructor(private readonly releaseAdmission: () => void, private readonly pin: (id: string) => () => void) {}
  retain(threadId: string): void {
    if (!this.releases.has(threadId)) this.releases.set(threadId, this.pin(threadId));
  }
  release(): void {
    for (const release of this.releases.values()) release();
    this.releases.clear();
    this.releaseAdmission();
  }
}
