import { AgentRuntimeAccessBoundary as AccessBoundary, AgentRuntimeTool, type AgentRuntimeToolName } from "../../domain/types";

export enum ChildContinuationMode { Disabled = "disabled" }
export enum ChildLifetimeFailure {
  Expired = "child_deadline_expired",
  Clock = "child_clock_inconsistent",
  Turns = "child_turn_budget_exhausted",
  Invocation = "child_invocation_consumed",
}
export class ChildLifetimeError extends Error {
  constructor(readonly reason: ChildLifetimeFailure) { super(reason); this.name = "ChildLifetimeError"; }
}
export type ChildLifetime = {
  readonly schemaVersion: 1;
  readonly accountId: string;
  readonly deadlineEpochMs: number;
  readonly maxGoalTurns: number;
  readonly maxAccountCycles: 1;
  readonly maxAttempts: 1;
  readonly continuationMode: ChildContinuationMode.Disabled;
  readonly allowedTools: readonly AgentRuntimeToolName[];
  readonly denyProjectInstructions: true;
  readonly accessBoundary: `${AccessBoundary.ReadOnly | AccessBoundary.IsolatedWorkspaceWrite}`;
};

export function parseChildLifetime(value: unknown): ChildLifetime {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join(",") !== "accessBoundary,accountId,allowedTools,continuationMode,deadlineEpochMs,denyProjectInstructions,maxAccountCycles,maxAttempts,maxGoalTurns,schemaVersion" ||
      v.schemaVersion !== 1 || typeof v.accountId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(v.accountId) ||
      !Number.isSafeInteger(v.deadlineEpochMs) || (v.deadlineEpochMs as number) <= 0 ||
      !Number.isSafeInteger(v.maxGoalTurns) || (v.maxGoalTurns as number) <= 0 ||
      v.maxAccountCycles !== 1 || v.maxAttempts !== 1 || v.continuationMode !== ChildContinuationMode.Disabled ||
      v.denyProjectInstructions !== true ||
      (v.accessBoundary !== AccessBoundary.ReadOnly && v.accessBoundary !== AccessBoundary.IsolatedWorkspaceWrite) ||
      !Array.isArray(v.allowedTools) || !v.allowedTools.length || v.allowedTools.length > 4 ||
      new Set(v.allowedTools).size !== v.allowedTools.length ||
      v.allowedTools.some(tool => ![AgentRuntimeTool.ReadFile, AgentRuntimeTool.SearchFiles, AgentRuntimeTool.EditFile, AgentRuntimeTool.WriteFile].includes(tool)) ||
      (v.accessBoundary === AccessBoundary.ReadOnly && v.allowedTools.some(tool => tool === AgentRuntimeTool.EditFile || tool === AgentRuntimeTool.WriteFile))) invalid();
  return Object.freeze({ ...v, allowedTools: Object.freeze([...v.allowedTools]) }) as ChildLifetime;
}
export function parseChildLifetimeJson(value: string): ChildLifetime {
  try { return parseChildLifetime(JSON.parse(value)); } catch { return invalid(); }
}
function invalid(): never { throw new Error("child_lifetime_invalid"); }

/** One object is shared by executor, engine and every transport client. Nothing
 * in provider events, aliases or failed writes can restore spent authority. */
export class ChildExecutionBudget {
  readonly lifetime: ChildLifetime;
  private readonly wallStart: number;
  private readonly monotonicStart: number;
  private lastWall: number;
  private lastMonotonic: number;
  private invoked = false;
  private providerStarted = false;
  private turns = 0;
  private failure: ChildLifetimeFailure | undefined;
  constructor(lifetime: ChildLifetime, private readonly clock = {
    wall: () => Date.now(), monotonic: () => performance.now(),
  }) {
    this.lifetime = parseChildLifetime(lifetime);
    this.wallStart = this.lastWall = clock.wall();
    this.monotonicStart = this.lastMonotonic = clock.monotonic();
  }
  get consumedTurns(): number { return this.turns; }
  remainingMs(): number {
    if (this.failure) throw new ChildLifetimeError(this.failure);
    const wall = this.clock.wall(), monotonic = this.clock.monotonic();
    if (!Number.isFinite(this.wallStart) || !Number.isFinite(this.monotonicStart) || !Number.isFinite(wall) || !Number.isFinite(monotonic) || wall < this.lastWall || monotonic < this.lastMonotonic) {
      return this.deny(ChildLifetimeFailure.Clock);
    }
    this.lastWall = wall; this.lastMonotonic = monotonic;
    const remaining = Math.min(this.lifetime.deadlineEpochMs - wall,
      this.lifetime.deadlineEpochMs - this.wallStart - (monotonic - this.monotonicStart));
    if (remaining <= 0) return this.deny(ChildLifetimeFailure.Expired);
    return remaining;
  }
  beginInvocation(): void {
    this.remainingMs();
    if (this.invoked) this.deny(ChildLifetimeFailure.Invocation);
    this.invoked = true;
  }
  beforeProviderStart(): void {
    this.remainingMs();
    if (!this.invoked || this.providerStarted) this.deny(ChildLifetimeFailure.Invocation);
    this.providerStarted = true;
  }
  beforeTurnWrite(): void {
    this.remainingMs();
    if (!this.invoked || !this.providerStarted) this.deny(ChildLifetimeFailure.Invocation);
    if (this.turns >= this.lifetime.maxGoalTurns) this.deny(ChildLifetimeFailure.Turns);
    this.turns += 1;
  }
  exhaust(): never { return this.deny(ChildLifetimeFailure.Turns); }
  private deny(reason: ChildLifetimeFailure): never {
    this.failure ??= reason;
    throw new ChildLifetimeError(this.failure);
  }
}
