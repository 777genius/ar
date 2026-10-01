import { ChildExecutionBudget } from "@vioxen/subscription-runtime/core";
import { sendAppServerRequest } from "./app-server-request-sender";
import type { CodexAppServerJsonRpcResponse } from "../protocol/app-server-json-rpc";
import type { CodexAppServerChildProcess } from "./app-server-process-port";
import type { AppServerExecutionLease } from "./app-server-admission";
import type { PendingRequest } from "./app-server-turn-state";
import { throwIfAborted } from "../domain/app-server-errors";
import type { CodexMaterializedSession } from "../../codex-json-execution-engine";

export enum AppServerExecutionReadiness {
  Starting = "starting",
  Initialized = "initialized",
  Ready = "ready",
}
export type AppServerExecutionBinding = {
  readonly allocationId: string;
  readonly incarnationId: string;
};
export type AppServerExecutionReadyEvent = AppServerExecutionBinding & {
  readonly state: AppServerExecutionReadiness;
  readonly threadId?: string;
};

/** A work fence, never an admission capability or a cleanup receipt. The
 * retained caller supplies the original deadline and allocation references.
 * Children continue to spend their existing, shared ChildExecutionBudget. */
export class AppServerExecutionLifetime {
  private readonly abort = new AbortController();
  private readonly wallStart = Date.now();
  private readonly monotonicStart = performance.now();
  private lastWall = this.wallStart;
  private lastMonotonic = this.monotonicStart;
  private timer: NodeJS.Timeout | undefined;
  private materializationEntered = false;
  private invocationEntered = false;
  private providerEntered = false;
  private threadEntered = false;
  private turns = 0;
  private initialized = false;
  private ready = false;
  readonly maxGoalTurns: number;

  constructor(private readonly input: {
    readonly deadlineEpochMs: number;
    readonly maxGoalTurns: number;
    readonly binding: AppServerExecutionBinding;
    readonly onReadiness?: (event: AppServerExecutionReadyEvent) => void;
  } | { readonly childBudget: ChildExecutionBudget }) {
    this.maxGoalTurns = "childBudget" in input ? input.childBudget.lifetime.maxGoalTurns : input.maxGoalTurns;
    if (!Number.isSafeInteger(this.deadlineEpochMs) || !Number.isSafeInteger(this.maxGoalTurns) ||
        this.maxGoalTurns < 1 || (!("childBudget" in input) &&
        (!input.binding.allocationId.trim() || !input.binding.incarnationId.trim()))) {
      throw new Error("codex_app_server_lifetime_invalid");
    }
    if (!("childBudget" in input)) this.input = Object.freeze({ ...input, binding: Object.freeze({ ...input.binding }) });
  }
  get deadlineEpochMs(): number {
    return "childBudget" in this.input ? this.input.childBudget.lifetime.deadlineEpochMs : this.input.deadlineEpochMs;
  }
  get childBudget(): ChildExecutionBudget | undefined {
    return "childBudget" in this.input ? this.input.childBudget : undefined;
  }
  get signal(): AbortSignal { return this.abort.signal; }
  remainingMs(): number {
    if (this.signal.aborted) throw this.signal.reason;
    try {
      if ("childBudget" in this.input) return this.input.childBudget.remainingMs();
      const wall = Date.now(), monotonic = performance.now();
      if (!Number.isFinite(wall) || !Number.isFinite(monotonic) || wall < this.lastWall || monotonic < this.lastMonotonic) {
        throw new Error("codex_app_server_clock_inconsistent");
      }
      this.lastWall = wall; this.lastMonotonic = monotonic;
      const remaining = Math.min(this.deadlineEpochMs - wall,
        this.deadlineEpochMs - this.wallStart - (monotonic - this.monotonicStart));
      if (remaining <= 0) throw new Error("codex_app_server_deadline_expired");
      return remaining;
    } catch (error) { this.close(error); throw error; }
  }
  assertActive(signal?: AbortSignal): void {
    if (signal?.aborted) this.close(signal.reason);
    this.remainingMs();
  }
  arm(): void {
    this.assertActive();
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      try { this.arm(); } catch { /* close() has already fenced every continuation. */ }
    }, Math.min(2147483647, Math.ceil(this.remainingMs())));
    this.timer.unref();
  }
  enterMaterialization(signal: AbortSignal): void {
    this.assertActive(signal);
    if (this.materializationEntered) throw new Error("codex_app_server_materialization_consumed");
    this.materializationEntered = true;
    this.arm();
  }
  beginInvocation(signal: AbortSignal): void {
    this.assertActive(signal);
    if (this.invocationEntered) throw new Error("codex_app_server_invocation_consumed");
    this.invocationEntered = true;
    this.arm();
  }
  beforeProviderStart(): void {
    this.assertActive();
    if (!this.invocationEntered || this.providerEntered) throw new Error("codex_app_server_provider_restart_denied");
    this.providerEntered = true;
    this.publish(AppServerExecutionReadiness.Starting);
  }
  beforeWrite(method: string): void {
    this.assertActive();
    if (method === "thread/fork" || method === "thread/resume") throw new Error("codex_app_server_continuation_denied");
    if (method === "thread/start") {
      if (this.threadEntered) throw new Error("codex_app_server_thread_reuse_denied");
      this.threadEntered = true;
    }
    if (method === "turn/start" && !("childBudget" in this.input)) {
      if (this.turns >= this.maxGoalTurns) throw new Error("codex_app_server_turn_budget_exhausted");
      this.turns += 1;
    }
  }
  markInitialized(): void {
    this.assertActive();
    this.initialized = true;
    this.publish(AppServerExecutionReadiness.Initialized);
  }
  markReady(threadId: string): void {
    this.assertActive();
    if (!this.initialized || !this.threadEntered || !threadId.trim() || this.ready) throw new Error("codex_app_server_readiness_invalid");
    this.ready = true;
    this.publish(AppServerExecutionReadiness.Ready, threadId);
  }
  private publish(state: AppServerExecutionReadiness, threadId?: string): void {
    this.assertActive();
    if (!("childBudget" in this.input)) this.input.onReadiness?.({ ...this.input.binding, state,
      ...(threadId === undefined ? {} : { threadId }) });
    this.assertActive();
  }
  close(reason: unknown = new Error("codex_app_server_execution_closed")): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.signal.aborted) this.abort.abort(reason);
  }
  /** Bounds even non-cancellable adapters. The caller must retain their late
   * resource result; the race itself is deliberately not cleanup evidence. */
  async wait<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
    void pending.catch(() => undefined);
    this.assertActive(signal);
    this.arm();
    const joined = signal ? AbortSignal.any([signal, this.signal]) : this.signal;
    let listener: () => void = () => undefined;
    try {
      const result = await Promise.race([pending, new Promise<never>((_, reject) => {
        listener = () => { this.close(joined.reason); reject(joined.reason); };
        joined.addEventListener("abort", listener, { once: true });
        if (joined.aborted) listener();
      })]);
      this.assertActive(signal);
      return result;
    } finally { joined.removeEventListener("abort", listener); }
  }
}

// Session identity carries the work fence through the existing pool without
// changing its cleanup ownership or generic account reuse policy.
const sessionLifetimes = new WeakMap<CodexMaterializedSession, AppServerExecutionLifetime>();
export function appServerSessionLifetime(session: CodexMaterializedSession): AppServerExecutionLifetime | undefined {
  return sessionLifetimes.get(session);
}
export function observeAppServerExecutionLifetime(session: CodexMaterializedSession, onAbort: (reason: unknown) => void): AppServerExecutionLifetime | undefined {
  const lifetime = appServerSessionLifetime(session);
  lifetime?.signal.addEventListener("abort", () => onAbort(lifetime.signal.reason), { once: true });
  return lifetime;
}
export function assertAppServerExecutionActive(lifetime: AppServerExecutionLifetime | undefined,
  budget: ChildExecutionBudget | undefined, terminalError: Error | null, signal?: AbortSignal): number {
  throwIfAborted(signal);
  if (terminalError) throw terminalError;
  lifetime?.assertActive(signal);
  return Math.min(lifetime?.remainingMs() ?? Infinity, budget?.remainingMs() ?? Infinity);
}
export function bindAppServerSessionLifetime(session: CodexMaterializedSession, lifetime: AppServerExecutionLifetime): CodexMaterializedSession {
  lifetime.assertActive();
  const env: Record<string, string> = {};
  // The pool and client both spread env. Resolve each accessor once, behind
  // the original fence, while checking the fence on both enumerations.
  for (const key of Object.keys(session.env)) {
    let read = false, value: string;
    Object.defineProperty(env, key, { enumerable: true, get: () => {
      lifetime.assertActive();
      if (!read) { value = session.env[key]!; lifetime.assertActive(); read = true; }
      return value;
    } });
  }
  const bound = { ...session, env };
  sessionLifetimes.set(bound, lifetime);
  return bound;
}

/** The request continuation and the write consume the same original fence.
 * Kept here so ordinary request timeout defaults stay in the client. */
export async function sendAppServerLifetimeRequest(method: string, params: unknown,
  input: { readonly timeoutMs?: number; readonly abortSignal?: AbortSignal; readonly usageLease?: AppServerExecutionLease },
  port: {
    readonly child: CodexAppServerChildProcess | null;
    readonly terminalError: Error | null;
    readonly id: number;
    readonly pending: Map<number, PendingRequest>;
    readonly timeoutMs: number;
    readonly childBudget: ChildExecutionBudget | undefined;
    readonly childLifetime: AppServerChildLifetime | undefined;
    readonly executionLifetime: AppServerExecutionLifetime | undefined;
  }): Promise<CodexAppServerJsonRpcResponse> {
  const assertActive = () => {
    throwIfAborted(input.abortSignal);
    if (port.terminalError) throw port.terminalError;
    port.executionLifetime?.assertActive(input.abortSignal);
    port.childBudget?.remainingMs();
  };
  if (!port.child) throw new Error("codex_app_server_not_started");
  assertActive();
  const response = await sendAppServerRequest({
    id: port.id, method, params,
    timeoutMs: Math.min(input.timeoutMs ?? port.timeoutMs,
      port.executionLifetime?.remainingMs() ?? Infinity, port.childBudget?.remainingMs() ?? Infinity),
    ...(input.abortSignal === undefined ? {} : { abortSignal: input.abortSignal }),
    ...(input.usageLease === undefined ? {} : { usageLease: input.usageLease }),
    pending: port.pending,
    write: message => {
      assertActive();
      port.executionLifetime?.beforeWrite(method);
      return port.childLifetime
        ? port.childLifetime.write(method, () => port.child!.stdin.write(message))
        : port.child!.stdin.write(message);
    },
  });
  assertActive();
  return response;
}

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
