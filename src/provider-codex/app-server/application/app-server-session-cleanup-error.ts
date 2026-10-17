/** Source-issued cleanup wrapper; nested errors remain local and are never serialized. */
export enum AppServerSessionCleanupPhase {
  Run = "run",
  Resume = "resume",
  Prewarm = "prewarm",
}

export enum AppServerCleanupDiagnosticCode {
  Unknown = "unknown",
  ProcessCleanupFailed = "process_cleanup_failed",
  OwnershipUnverified = "ownership_unverified",
}

const facts = new WeakMap<object, Readonly<{
  phase: AppServerSessionCleanupPhase; primary: unknown; cleanup: unknown;
}>>();

export class AppServerSessionCleanupError extends AggregateError {
  constructor(primary: unknown, cleanup: unknown, phase: AppServerSessionCleanupPhase) {
    if (!Object.values(AppServerSessionCleanupPhase).includes(phase)) throw new TypeError("codex_app_server_cleanup_phase_invalid");
    super([primary, cleanup], `codex_app_server_${phase}_cleanup_failed`);
    facts.set(this, Object.freeze({ phase, primary, cleanup }));
  }
}

export function appServerSessionCleanupFacts(error: unknown) {
  return typeof error === "object" && error !== null ? facts.get(error) : undefined;
}
