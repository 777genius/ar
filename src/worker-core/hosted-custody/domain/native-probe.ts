import type { ScopedRetainedCleanupAttempt } from "../../../core/scoped-retained-resource-contract.js";
// Foundation policy contains no transport, manager, filesystem or native handles.
// Allocation/read models are observations; only an owning port admits effects.
export enum NativeProbeKind { NativeProbe = "NativeProbe" }
export enum NativeProbeOperation { Start = "start", Status = "status", Stop = "stop" }
export enum NativeProbeProfile { OriginalFoundationV1 = "OriginalFoundationV1" }
export enum ProbeAdmission { Open = "open", Closed = "closed", Lost = "lost" }
export enum ProbeBranch { Unselected = "unselected", Prepare = "prepare", Declared = "declared" }
export enum ProbeMaterialization { Awaiting = "awaiting", Materialized = "materialized", AwaitingClosed = "awaiting-materialization-closed" }
export enum ProbeCustody { NeverAcquired = "never-acquired", Retained = "retained", Lost = "acquired-then-lost" }
export enum ProbeStep {
  Intent = "intent", Obligation = "obligation", Subscribe = "subscribe",
  SliceStart = "slice-start", SliceReference = "slice-reference", Directory = "directory", Events = "events",
  StageCreate = "stage-create", StageWrite = "stage-write", FileSync = "file-sync", StageParentSync = "stage-parent-sync",
  Publish = "publish", FinalParentSync = "final-parent-sync", SourceParentSync = "source-parent-sync", VerifyFragment = "verify-fragment",
  Reload = "reload", Load = "load", TargetReference = "target-reference", TargetStart = "target-start",
  Binding = "binding", Transfer = "transfer",
}
export enum ProbePrefix { Unsent = "unsent", Dispatched = "dispatched", Retained = "retained", Failed = "failed", Uncertain = "uncertain" }
export interface NativeProbeRequest {
  readonly kind: NativeProbeKind; readonly operation: NativeProbeOperation;
  readonly allocationDigest: string; readonly jobId: string; readonly machineId: string;
}
export interface ProbeDeclaration {
  readonly identity: string; readonly ordinal: number; readonly lifetime: string;
  readonly parent: string | null; readonly workEndNs: string; readonly cleanupEndNs: string;
}
export interface ProbeLimits {
  readonly infrastructureTasks: number; readonly infrastructureThreads: number;
  readonly messages: number; readonly journalEntries: number; readonly declarations: number; readonly targets: number;
}
export interface NativeProbeAllocation {
  readonly version: 1; readonly kind: NativeProbeKind; readonly profile: NativeProbeProfile;
  readonly jobId: string; readonly machineId: string; readonly installationDigest: string;
  readonly profileDigest: string; readonly manifestDigest: string;
  readonly issuanceAnchorNs: string; readonly preparationEndNs: string; readonly absoluteCleanupEndNs: string;
  readonly cleanupReservation: string; readonly declarations: readonly ProbeDeclaration[]; readonly limits: ProbeLimits;
}
export interface OriginalProbeAttempt {
  readonly reservation: string; readonly original: ScopedRetainedCleanupAttempt;
  readonly originalCleanupDeadlineEpochMs: number; readonly originalAttemptAllowanceMs: number;
}
export interface ProbeCutoffs {
  readonly preparationNs: string; readonly cleanupNs: string; readonly observationNs: string;
}
export interface ProbeDeclarationSnapshot {
  readonly identity: string; readonly materialization: ProbeMaterialization; readonly branch: ProbeBranch;
  readonly operationIdentity: string | null; readonly intentIdentity: string | null;
  readonly creationAdmission: ProbeAdmission; readonly prefixes: Readonly<Record<ProbeStep, ProbePrefix>>;
  readonly directory: ProbeCustody; readonly events: ProbeCustody;
  readonly sliceInvocation: string | null; readonly targetInvocation: string | null;
  readonly attempt: OriginalProbeAttempt | null; readonly cutoffs: ProbeCutoffs;
  readonly closeIdentity: string | null; readonly debt: boolean;
}
export interface NativeProbeFacts {
  readonly kind: NativeProbeKind; readonly allocationDigest: string; readonly admission: ProbeAdmission;
  readonly originalStart: ProbePrefix; readonly originalStop: ProbePrefix;
  readonly preparationEndNs: string; readonly absoluteCleanupEndNs: string;
  readonly declarations: readonly ProbeDeclarationSnapshot[];
  readonly infrastructureTasksObserved: number; readonly allocationBirths: 0;
  readonly completeHold: false; readonly workQualified: false;
}
const maximum = (1n << 63n) - 1n;
export function probeTime(value: string): bigint {
  if (!/^(0|[1-9][0-9]{0,18})$/.test(value)) throw new Error("invalid probe time");
  const n = BigInt(value); if (n > maximum) throw new Error("probe time overflow"); return n;
}
export function issuanceEnds(anchor: bigint): readonly [string, string] {
  if (anchor < 0n || anchor > maximum - 180_000_000_000n) throw new Error("invalid issuance anchor");
  return [(anchor + 120_000_000_000n).toString(), (anchor + 180_000_000_000n).toString()];
}
export function validateOriginalAttempt(attempt: OriginalProbeAttempt): void {
  const start = attempt.original.startedAtEpochMs, allowance = attempt.originalAttemptAllowanceMs;
  const deadline = attempt.originalCleanupDeadlineEpochMs;
  for (const value of [start, allowance, deadline, attempt.original.endEpochMs]) if (!Number.isSafeInteger(value) || value <= 0) throw new Error("invalid original attempt");
  if (allowance > 60_000) throw new Error("original attempt allowance exceeds profile");
  if (!Number.isSafeInteger(start + allowance) || attempt.original.endEpochMs !== Math.min(deadline, start + allowance)) throw new Error("changed V2 attempt end");
}
export function intersectCutoffs(original: ProbeCutoffs, restrictions: ProbeCutoffs): ProbeCutoffs {
  const min = (a: string, b: string): string => (probeTime(a) < probeTime(b) ? a : b);
  return Object.freeze({ preparationNs: min(original.preparationNs, restrictions.preparationNs), cleanupNs: min(original.cleanupNs, restrictions.cleanupNs), observationNs: min(original.observationNs, restrictions.observationNs) });
}
export function validateProbeAllocation(allocation: NativeProbeAllocation): void {
  if (allocation.version !== 1 || allocation.kind !== NativeProbeKind.NativeProbe || allocation.profile !== NativeProbeProfile.OriginalFoundationV1) throw new Error("not a NativeProbe allocation");
  const [preparation, cleanup] = issuanceEnds(probeTime(allocation.issuanceAnchorNs));
  if (preparation !== allocation.preparationEndNs || cleanup !== allocation.absoluteCleanupEndNs) throw new Error("changed original allocation budget");
  if (Object.keys(allocation.limits).sort().join(",") !== "declarations,infrastructureTasks,infrastructureThreads,journalEntries,messages,targets") throw new Error("omitted or unknown immutable capacity");
  for (const n of Object.values(allocation.limits)) if (!Number.isSafeInteger(n) || n <= 0 || n > 65536) throw new Error("omitted or excessive immutable capacity");
  if (allocation.limits.infrastructureThreads > allocation.limits.infrastructureTasks || allocation.limits.targets > allocation.limits.declarations || allocation.declarations.length !== allocation.limits.declarations) throw new Error("invalid finite inventory");
  const identities = new Map<string, ProbeDeclaration>();
  for (const [ordinal, row] of allocation.declarations.entries()) {
    if (!row.identity || !row.lifetime || row.ordinal !== ordinal || identities.has(row.identity) || probeTime(row.workEndNs) > probeTime(preparation) || probeTime(row.cleanupEndNs) > probeTime(cleanup) || probeTime(row.cleanupEndNs) <= probeTime(row.workEndNs)) throw new Error("invalid frozen declaration");
    identities.set(row.identity, row);
  }
  for (const row of identities.values()) {
    const seen = new Set<string>(); let current: ProbeDeclaration | undefined = row;
    while (current) {
      if (seen.has(current.identity)) throw new Error("declaration cycle"); seen.add(current.identity);
      if (current.parent === null) break;
      current = identities.get(current.parent); if (!current) throw new Error("missing declaration parent");
    }
  }
}

// This is finite bookkeeping, never an authority provider. Native dispatch repeats
// the final-boundary check using the retained original kernel clock/custody.
export class ProbeInventory {
  readonly #rows: Map<string, ProbeDeclarationSnapshot>;
  #admission = ProbeAdmission.Open;
  #highWater: bigint;
  #attempt: OriginalProbeAttempt | null = null;
  #targetsReserved = 0;
  readonly allocation: NativeProbeAllocation;
  constructor(allocation: NativeProbeAllocation) {
    validateProbeAllocation(allocation);
    this.allocation = Object.freeze({ ...allocation, limits: Object.freeze({ ...allocation.limits }), declarations: Object.freeze(allocation.declarations.map(row => Object.freeze({ ...row }))) });
    this.#highWater = probeTime(this.allocation.issuanceAnchorNs);
    this.#rows = new Map(allocation.declarations.map(row => [row.identity, Object.freeze({
      identity: row.identity, materialization: ProbeMaterialization.Awaiting, branch: ProbeBranch.Unselected,
      operationIdentity: null, intentIdentity: null, creationAdmission: ProbeAdmission.Open,
      prefixes: Object.freeze(Object.fromEntries(Object.values(ProbeStep).map(step => [step, ProbePrefix.Unsent]))) as Readonly<Record<ProbeStep, ProbePrefix>>,
      directory: ProbeCustody.NeverAcquired, events: ProbeCustody.NeverAcquired, sliceInvocation: null, targetInvocation: null,
      attempt: null, cutoffs: Object.freeze({ preparationNs: row.workEndNs, cleanupNs: row.cleanupEndNs, observationNs: allocation.absoluteCleanupEndNs }), closeIdentity: null, debt: false,
    })]));
  }
  get admission(): ProbeAdmission { return this.#admission; }
  snapshot(): readonly ProbeDeclarationSnapshot[] { return Object.freeze([...this.#rows.values()]); }
  #row(identity: string): ProbeDeclarationSnapshot { const row = this.#rows.get(identity); if (!row) throw new Error("foreign declaration"); return row; }
  #set(row: ProbeDeclarationSnapshot): void { this.#rows.set(row.identity, Object.freeze(row)); }
  sample(now: bigint): void {
    if (now < this.#highWater || now > maximum) { this.close("clock-loss", true); throw new Error("clock regression or overflow"); }
    this.#highWater = now;
  }
  tighten(identity: string, cutoffs: ProbeCutoffs): void { const row = this.#row(identity); this.#set({ ...row, cutoffs: intersectCutoffs(row.cutoffs, cutoffs) }); }
  materialize(identity: string): void {
    const row = this.#row(identity);
    if (row.materialization !== ProbeMaterialization.Awaiting && row.materialization !== ProbeMaterialization.AwaitingClosed) throw new Error("materialization unavailable");
    this.#set({ ...row, materialization: ProbeMaterialization.Materialized });
  }
  select(identity: string, branch: ProbeBranch, operationIdentity: string, intentIdentity: string, now: bigint): void {
    this.sample(now); const row = this.#row(identity);
    if (this.#admission !== ProbeAdmission.Open || row.creationAdmission !== ProbeAdmission.Open || row.branch !== ProbeBranch.Unselected || row.materialization !== ProbeMaterialization.Materialized || now >= probeTime(row.cutoffs.preparationNs) || !operationIdentity || !intentIdentity || branch === ProbeBranch.Unselected) throw new Error("branch admission unavailable");
    // The first admitted Prepare reserves its target before any intent/operation
    // association or dispatch. Completion, failure and observational JOIN never
    // recycle this allocation-wide reservation; Declared creates no target.
    if (branch === ProbeBranch.Prepare) {
      if (this.#targetsReserved >= this.allocation.limits.targets) {
        this.close("target-capacity-exhausted");
        throw new Error("immutable target capacity exhausted");
      }
      this.#targetsReserved++;
    }
    this.#set({ ...row, branch, operationIdentity, intentIdentity, creationAdmission: branch === ProbeBranch.Declared ? ProbeAdmission.Closed : ProbeAdmission.Open, debt: true });
  }
  dispatch(identity: string, step: ProbeStep, now: bigint): void {
    this.sample(now); const row = this.#row(identity);
    const publication = step === ProbeStep.Intent || step === ProbeStep.Obligation;
    if (this.#admission !== ProbeAdmission.Open || row.branch === ProbeBranch.Unselected || (!publication && row.creationAdmission !== ProbeAdmission.Open) || now >= probeTime(row.cutoffs.preparationNs) || row.prefixes[step] !== ProbePrefix.Unsent) throw new Error("effect admission unavailable");
    if (step !== ProbeStep.Intent && row.prefixes[ProbeStep.Intent] !== ProbePrefix.Retained) throw new Error("intent not durable");
    if (!publication && row.prefixes[ProbeStep.Obligation] !== ProbePrefix.Retained) throw new Error("immutable obligation not durable");
    const sequence = Object.values(ProbeStep), index = sequence.indexOf(step);
    if (index > 1 && row.prefixes[sequence[index - 1]!] !== ProbePrefix.Retained) throw new Error("original predecessor not retained");
    this.#set({ ...row, prefixes: Object.freeze({ ...row.prefixes, [step]: ProbePrefix.Dispatched }), debt: true });
  }
  observe(identity: string, step: ProbeStep, outcome: ProbePrefix, now: bigint): void {
    this.sample(now); const row = this.#row(identity), previous = row.prefixes[step];
    if (previous !== ProbePrefix.Dispatched || ![ProbePrefix.Retained, ProbePrefix.Failed, ProbePrefix.Uncertain].includes(outcome)) throw new Error("not an original in-flight outcome");
    const late = now >= probeTime(row.cutoffs.preparationNs);
    const acquiredCustody = this.#admission === ProbeAdmission.Lost ? ProbeCustody.Lost : ProbeCustody.Retained;
    this.#set({ ...row, prefixes: Object.freeze({ ...row.prefixes, [step]: late ? ProbePrefix.Uncertain : outcome }),
      directory: step === ProbeStep.Directory && outcome === ProbePrefix.Retained ? acquiredCustody : row.directory,
      events: step === ProbeStep.Events && outcome === ProbePrefix.Retained ? acquiredCustody : row.events, debt: true });
    if (late || outcome !== ProbePrefix.Retained) this.close(`operation-${identity}`);
  }
  associateAttempt(identity: string, attempt: OriginalProbeAttempt): void {
    validateOriginalAttempt(attempt); const row = this.#row(identity);
    if (row.attempt || attempt.reservation !== this.allocation.cleanupReservation) throw new Error("original cleanup attempt conflict");
    const previous = this.#attempt;
    if (previous && (previous.reservation !== attempt.reservation || previous.originalAttemptAllowanceMs !== attempt.originalAttemptAllowanceMs || previous.originalCleanupDeadlineEpochMs !== attempt.originalCleanupDeadlineEpochMs || previous.original.originalAuthorityDigest !== attempt.original.originalAuthorityDigest || previous.original.attemptId !== attempt.original.attemptId || previous.original.startedAtEpochMs !== attempt.original.startedAtEpochMs || previous.original.endEpochMs !== attempt.original.endEpochMs || previous.original.joinDigest !== attempt.original.joinDigest)) throw new Error("original attempt renewed across declaration association");
    this.#attempt ??= Object.freeze({ ...attempt, original: Object.freeze({ ...attempt.original }) });
    this.#set({ ...row, attempt: this.#attempt });
  }
  close(closeIdentity: string, lost = false): void {
    if (!closeIdentity) throw new Error("missing immutable close identity");
    if (this.#admission === ProbeAdmission.Lost) return;
    this.#admission = lost ? ProbeAdmission.Lost : ProbeAdmission.Closed;
    for (const row of this.#rows.values()) this.#set({ ...row,
      creationAdmission: this.#admission, closeIdentity: row.closeIdentity ?? closeIdentity,
      materialization: row.materialization === ProbeMaterialization.Awaiting ? ProbeMaterialization.AwaitingClosed : row.materialization,
      directory: lost && row.directory === ProbeCustody.Retained ? ProbeCustody.Lost : row.directory,
      events: lost && row.events === ProbeCustody.Retained ? ProbeCustody.Lost : row.events, debt: true,
    });
  }
}
