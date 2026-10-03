export const defaultAppServerRateLimitsCacheTtlMs = 30_000;

export type CodexAppServerRateLimitsSnapshotSource =
  | "initial_read"
  | "notification_refetch";

export type CodexAppServerRateLimitsAdmission =
  | { readonly status: "admitted" }
  | { readonly status: "rejected"; readonly reason: string };

export type CodexAppServerRateLimitsSnapshotHandler = (input: {
  readonly result: unknown;
  readonly observedAt: Date;
  readonly source: CodexAppServerRateLimitsSnapshotSource;
}) =>
  | CodexAppServerRateLimitsAdmission
  | Promise<CodexAppServerRateLimitsAdmission>;

export class CodexAppServerRateLimitsRejectedError extends Error {
  constructor(readonly reason: string) {
    super(`codex_app_server_rate_limits_rejected:${reason}`);
    this.name = "CodexAppServerRateLimitsRejectedError";
  }
}

export function isCodexAppServerRateLimitsRejectedError(
  error: unknown,
): error is CodexAppServerRateLimitsRejectedError {
  return error instanceof CodexAppServerRateLimitsRejectedError;
}

export class AppServerRateLimitsMonitor {
  private cachedUntilMs = 0;
  private requestedGeneration = 0;
  private completedGeneration = 0;
  private refreshPromise: Promise<void> | null = null;
  private nextSource: CodexAppServerRateLimitsSnapshotSource = "initial_read";

  constructor(
    private readonly options: {
      readonly read: () => Promise<unknown>;
      readonly handle: CodexAppServerRateLimitsSnapshotHandler;
      readonly now?: () => Date;
      readonly cacheTtlMs?: number;
      readonly onBackgroundError?: (error: unknown) => void;
    },
  ) {}

  async prime(): Promise<void> {
    const now = this.now();
    if (this.cachedUntilMs > now.getTime()) return;
    this.requestedGeneration += 1;
    this.nextSource = "initial_read";
    await this.drain();
  }

  notifyRateLimitsUpdated(): void {
    this.cachedUntilMs = 0;
    this.requestedGeneration += 1;
    this.nextSource = "notification_refetch";
    void this.drain().catch((error) => {
      this.options.onBackgroundError?.(error);
    });
  }

  async flush(): Promise<void> {
    await this.refreshPromise;
  }

  private drain(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    const requestedAtStart = this.requestedGeneration;
    this.refreshPromise = this.refreshUntilCurrent().finally(() => {
      this.refreshPromise = null;
      if (
        this.completedGeneration < this.requestedGeneration &&
        this.requestedGeneration > requestedAtStart
      ) {
        void this.drain().catch((error) => {
          this.options.onBackgroundError?.(error);
        });
      }
    });
    return this.refreshPromise;
  }

  private async refreshUntilCurrent(): Promise<void> {
    while (this.completedGeneration < this.requestedGeneration) {
      const generation = this.requestedGeneration;
      const source = this.nextSource;
      const result = await this.options.read();
      const observedAt = this.now();
      const admission = await this.options.handle({
        result,
        observedAt,
        source,
      });
      this.cachedUntilMs =
        observedAt.getTime() +
        (this.options.cacheTtlMs ?? defaultAppServerRateLimitsCacheTtlMs);
      this.completedGeneration = generation;
      if (source === "initial_read" && admission.status === "rejected") {
        throw new CodexAppServerRateLimitsRejectedError(admission.reason);
      }
    }
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}
