import { createHash } from "node:crypto";

export enum KeyedChildProfile { IsolatedWrite = "isolated_write", ReadOnly = "read_only" }
export enum KeyedChildState {
  Claimed = "claimed", Materializing = "materializing", Prepared = "prepared",
  DispatchIntent = "dispatch_intent", Submitted = "submitted", Running = "running",
  StopRequested = "stop_requested", Terminal = "terminal", Uncertain = "uncertain",
}
export enum DispatchEligibility {
  EligibleBeforeIntent = "eligible_before_intent", HeldAfterIntent = "held_after_intent",
  Ineligible = "ineligible",
}
export enum NoEffectProofKind { IndependentlyEstablished = "independently_established_no_effects" }

export interface ChildScope {
  readonly projectId: string;
  readonly workstreamId: string;
  readonly controllerId: string;
}
/** Reviewed host-side abstraction; no dependency on PR3's eventual representation. */
export interface ReviewedChildAuthority extends ChildScope {
  readonly grantDigest: string;
  readonly reviewedSnapshotDigest: string;
  readonly accountId: string;
  readonly sourceSha: string;
  readonly artifactSha: string;
  readonly absoluteDeadline: number;
  readonly maxGoalTurns: number;
  readonly effectiveOptionDigest: string;
}
export interface ChildSlotAllocation {
  readonly slotId: string;
  readonly requestId: string;
  readonly operationId: string;
  readonly childHandle: string;
  readonly startId: string;
  readonly unitCorrelation: string;
  readonly profile: KeyedChildProfile;
}
export interface ChildLaunchRequest {
  readonly key: string;
  readonly task: string;
  readonly profile: KeyedChildProfile;
}
export interface ChildCorrelation extends ChildSlotAllocation {
  readonly authorityDigest: string;
  readonly keyDigest: string;
  readonly requestDigest: string;
  readonly promptDigest: string;
  readonly generation: number;
}
export interface ChildObservation extends ChildCorrelation {
  readonly state: KeyedChildState;
  /** Permanent historical fact, never a submission permit. */
  readonly dispatchIntent: Readonly<{ generation: number }> | null;
  readonly eligibility: DispatchEligibility;
}
export interface IndependentNoEffectEvidence {
  readonly kind: NoEffectProofKind;
  readonly correlation: ChildCorrelation;
  readonly evidenceDigest: string;
}
interface AcceptedChild {
  readonly key: string;
  readonly task: string;
  readonly allocation: ChildSlotAllocation;
  readonly keyDigest: string;
  readonly requestDigest: string;
  readonly promptDigest: string;
  readonly state: KeyedChildState;
  readonly dispatchIntent: Readonly<{ generation: number }> | null;
}

function text(value: string, limit: number): void {
  // JS strings with lone surrogates cannot round-trip through UTF-8 exactly.
  if (typeof value !== "string" || !value.length || value.length > limit ||
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) {
    throw new Error("invalid bounded text");
  }
}
function digest(value: string): void {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error("invalid digest");
}
function integer(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("invalid positive integer");
}
function sha(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
/** Array positions are the v1 canonical field order; strings are never normalized. */
export function encodeChildKey(scope: ChildScope, key: string): string {
  for (const id of [scope.projectId, scope.workstreamId, scope.controllerId]) text(id, 128);
  text(key, 128);
  return JSON.stringify(["keyed-child-key", 1, scope.projectId, scope.workstreamId, scope.controllerId, key]);
}
function authorityHash(a: ReviewedChildAuthority): string {
  return sha(JSON.stringify(["keyed-child-authority", 1, a.projectId, a.workstreamId,
    a.controllerId, a.grantDigest, a.reviewedSnapshotDigest, a.accountId, a.sourceSha,
    a.artifactSha, a.absoluteDeadline, a.maxGoalTurns, a.effectiveOptionDigest]));
}
function allocationCopy(a: ChildSlotAllocation): ChildSlotAllocation {
  for (const id of [a.slotId, a.requestId, a.operationId, a.childHandle, a.startId, a.unitCorrelation]) text(id, 128);
  if (!Object.values(KeyedChildProfile).includes(a.profile)) throw new Error("invalid profile");
  return Object.freeze({ slotId: a.slotId, requestId: a.requestId, operationId: a.operationId,
    childHandle: a.childHandle, startId: a.startId, unitCorrelation: a.unitCorrelation, profile: a.profile });
}

/** Pure immutable successor aggregate. Acceptance and occupancy are one CAS write.
 * No public hydration/mutation path can inject a terminal or remove an intent.
 * Trusted persistence integration must preserve this contract, not cast JSON to it.
 */
export class KeyedChildLedger {
  readonly #authority: ReviewedChildAuthority;
  readonly #slots: readonly ChildSlotAllocation[];
  readonly #accepted: readonly AcceptedChild[];
  readonly generation: number;
  readonly authorityDigest: string;

  private constructor(a: ReviewedChildAuthority, slots: readonly ChildSlotAllocation[],
    accepted: readonly AcceptedChild[], generation: number) {
    this.#authority = a; this.#slots = slots; this.#accepted = accepted;
    this.generation = generation; this.authorityDigest = authorityHash(a);
    Object.freeze(this);
  }
  static create(a: ReviewedChildAuthority, slots: readonly ChildSlotAllocation[]): KeyedChildLedger {
    encodeChildKey(a, "validation"); text(a.accountId, 128);
    for (const d of [a.grantDigest, a.reviewedSnapshotDigest, a.artifactSha, a.effectiveOptionDigest]) digest(d);
    if (!/^[a-f0-9]{40}$/.test(a.sourceSha)) throw new Error("invalid source SHA");
    integer(a.absoluteDeadline); integer(a.maxGoalTurns);
    if (slots.length < 1 || slots.length > 128) throw new Error("invalid finite allowance");
    const copies = slots.map(allocationCopy);
    for (const field of ["slotId", "requestId", "operationId", "childHandle", "startId", "unitCorrelation"] as const) {
      if (new Set(copies.map(s => s[field])).size !== copies.length) throw new Error("duplicate allocation");
    }
    // Both opaque handle types use the same lookup namespace.
    if (new Set(copies.flatMap(s => [s.operationId, s.childHandle])).size !== copies.length * 2) {
      throw new Error("ambiguous handle allocation");
    }
    const authority = Object.freeze({ projectId: a.projectId, workstreamId: a.workstreamId,
      controllerId: a.controllerId, grantDigest: a.grantDigest, reviewedSnapshotDigest: a.reviewedSnapshotDigest,
      accountId: a.accountId, sourceSha: a.sourceSha, artifactSha: a.artifactSha,
      absoluteDeadline: a.absoluteDeadline, maxGoalTurns: a.maxGoalTurns, effectiveOptionDigest: a.effectiveOptionDigest });
    return new KeyedChildLedger(authority, Object.freeze(copies), Object.freeze([]), 0);
  }
  get remainingAllowance(): number { return this.#slots.length - this.#accepted.length; }
  get occupied(): boolean { return this.#accepted.some(c => c.state !== KeyedChildState.Terminal); }
  #checkGeneration(expected: number): void {
    if (expected !== this.generation) throw new Error("stale generation");
  }
  #beforeDeadline(now: number): void {
    integer(now);
    if (now >= this.#authority.absoluteDeadline) throw new Error("deadline expired");
  }
  #successor(children: readonly AcceptedChild[]): KeyedChildLedger {
    if (this.generation === Number.MAX_SAFE_INTEGER) throw new Error("generation exhausted");
    return new KeyedChildLedger(this.#authority, this.#slots, Object.freeze(children), this.generation + 1);
  }
  accept(expected: number, request: ChildLaunchRequest, now: number): KeyedChildLedger {
    this.#checkGeneration(expected);
    // Only the model-facing three-field request is admitted.
    if (Object.keys(request).some(k => !["key", "task", "profile"].includes(k))) throw new Error("request override");
    const keyDigest = sha(encodeChildKey(this.#authority, request.key));
    text(request.task, 4000);
    if (!Object.values(KeyedChildProfile).includes(request.profile)) throw new Error("invalid profile");
    const requestDigest = sha(JSON.stringify(["keyed-child-request", 1, request.task, request.profile]));
    const prior = this.#accepted.find(c => c.key === request.key);
    if (prior) {
      if (prior.task !== request.task || prior.allocation.profile !== request.profile) throw new Error("key conflict");
      return this; // Forever, including terminal and after the absolute deadline.
    }
    this.#beforeDeadline(now);
    if (this.occupied) throw new Error("occupied");
    const used = new Set(this.#accepted.map(c => c.allocation.slotId));
    const allocation = this.#slots.find(s => !used.has(s.slotId) && s.profile === request.profile);
    if (!allocation) throw new Error("allowance exhausted");
    const child: AcceptedChild = Object.freeze({ key: request.key, task: request.task, allocation,
      keyDigest, requestDigest, promptDigest: sha(request.task), state: KeyedChildState.Claimed, dispatchIntent: null });
    return this.#successor([...this.#accepted, child]);
  }
  /** Must run using trusted authenticated scope BEFORE any adapter manifest read. */
  observe(scope: ChildScope, handle: string): ChildObservation {
    if (scope.projectId !== this.#authority.projectId || scope.workstreamId !== this.#authority.workstreamId ||
        scope.controllerId !== this.#authority.controllerId) throw new Error("foreign scope");
    text(handle, 128);
    const child = this.#accepted.find(c => c.allocation.childHandle === handle || c.allocation.operationId === handle);
    if (!child) throw new Error("foreign handle");
    return this.#observation(child);
  }
  #observation(c: AcceptedChild): ChildObservation {
    return Object.freeze({ ...c.allocation, authorityDigest: this.authorityDigest, keyDigest: c.keyDigest,
      requestDigest: c.requestDigest, promptDigest: c.promptDigest, generation: this.generation,
      state: c.state, dispatchIntent: c.dispatchIntent,
      eligibility: c.dispatchIntent ? DispatchEligibility.HeldAfterIntent :
        c.state === KeyedChildState.Prepared ? DispatchEligibility.EligibleBeforeIntent : DispatchEligibility.Ineligible });
  }
  #correlated(binding: ChildCorrelation): AcceptedChild {
    this.#checkGeneration(binding.generation);
    const c = this.#accepted.find(c => c.allocation.slotId === binding.slotId);
    if (!c) throw new Error("foreign slot");
    const current = this.#observation(c);
    for (const field of ["authorityDigest", "keyDigest", "requestDigest", "promptDigest", "slotId", "requestId",
      "operationId", "childHandle", "startId", "unitCorrelation", "profile"] as const) {
      if (binding[field] !== current[field]) throw new Error("foreign correlation");
    }
    return c;
  }
  #replace(c: AcceptedChild, state: KeyedChildState): KeyedChildLedger {
    const next = Object.freeze({ ...c, state, dispatchIntent: state === KeyedChildState.DispatchIntent
      ? Object.freeze({ generation: this.generation + 1 }) : c.dispatchIntent });
    return this.#successor(this.#accepted.map(old => old === c ? next : old));
  }
  advance(binding: ChildCorrelation, state: KeyedChildState, now: number): KeyedChildLedger {
    const c = this.#correlated(binding);
    const next = new Map([
      [KeyedChildState.Claimed, KeyedChildState.Materializing],
      [KeyedChildState.Materializing, KeyedChildState.Prepared],
      [KeyedChildState.Prepared, KeyedChildState.DispatchIntent],
      [KeyedChildState.DispatchIntent, KeyedChildState.Submitted],
      [KeyedChildState.Submitted, KeyedChildState.Running],
    ]);
    if (next.get(c.state) !== state) throw new Error("incompatible transition");
    if (state !== KeyedChildState.Submitted && state !== KeyedChildState.Running) this.#beforeDeadline(now);
    return this.#replace(c, state);
  }
  markUncertain(binding: ChildCorrelation): KeyedChildLedger {
    const c = this.#correlated(binding);
    if (c.state === KeyedChildState.Terminal) throw new Error("terminal child");
    return c.state === KeyedChildState.Uncertain ? this : this.#replace(c, KeyedChildState.Uncertain);
  }
  stop(binding: ChildCorrelation): KeyedChildLedger {
    const c = this.#correlated(binding);
    return c.state === KeyedChildState.Terminal || c.state === KeyedChildState.StopRequested
      ? this : this.#replace(c, KeyedChildState.StopRequested);
  }
  /** Evidence must come from independent trusted verification, never an exception/timeout. */
  terminalizeBeforeIntent(evidence: IndependentNoEffectEvidence): KeyedChildLedger {
    const c = this.#correlated(evidence.correlation);
    if (c.dispatchIntent || evidence.kind !== NoEffectProofKind.IndependentlyEstablished) throw new Error("no-effect proof required");
    digest(evidence.evidenceDigest);
    return c.state === KeyedChildState.Terminal ? this : this.#replace(c, KeyedChildState.Terminal);
  }
}
