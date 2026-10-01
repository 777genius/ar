import { assertRuntimeValidatedTermination, type RuntimeValidatedTermination } from "../../hosted-custody/domain/scoped-termination";
import { createHash } from "node:crypto";
import { KeyedChildState } from "@vioxen/subscription-runtime/core";

export enum KeyedChildProfile { IsolatedWrite = "isolated_write", ReadOnly = "read_only" }
export { KeyedChildState } from "@vioxen/subscription-runtime/core";
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

/** Private persistence DTO; never use this in model-facing observations. */
export interface KeyedChildLedgerSnapshot {
  readonly schemaVersion: 1;
  readonly authorityDigest: string;
  readonly slots: readonly ChildSlotAllocation[];
  readonly generation: number;
  readonly accepted: readonly AcceptedChild[];
}
export const keyedChildSnapshotMaxBytes = 4 * 1024 * 1024;
function exactFields(value: unknown, fields: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== fields.split(",").sort().join(",")) {
    throw new Error("invalid snapshot fields");
  }
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
 * Validated private restoration binds the trusted authority and finite slots.
 * Publication still requires a direct domain successor, never a hydrated edit.
 */
export class KeyedChildLedger {
  static readonly #construction = Object.freeze({});
  readonly #successorToken = Object.freeze({});
  readonly #previousToken: object | undefined;
  readonly #authority: ReviewedChildAuthority;
  readonly #slots: readonly ChildSlotAllocation[];
  readonly #accepted: readonly AcceptedChild[];
  readonly generation: number;
  readonly authorityDigest: string;

  private constructor(a: ReviewedChildAuthority, slots: readonly ChildSlotAllocation[],
    accepted: readonly AcceptedChild[], generation: number, previous: KeyedChildLedger | undefined,
    capability: object) {
    if (capability !== KeyedChildLedger.#construction) throw new Error("invalid ledger construction");
    this.#previousToken = previous ? previous.#successorToken : undefined;
    this.#authority = a; this.#slots = slots; this.#accepted = accepted;
    this.generation = generation; this.authorityDigest = authorityHash(a);
    Object.freeze(this);
  }
  static create(a: ReviewedChildAuthority, slots: readonly ChildSlotAllocation[]): KeyedChildLedger {
    encodeChildKey(a, "validation"); text(a.accountId, 128);
    for (const d of [a.grantDigest, a.reviewedSnapshotDigest, a.effectiveOptionDigest]) digest(d);
    if (!/^[a-f0-9]{40}$/.test(a.sourceSha)) throw new Error("invalid source SHA");
    // PR3 retains a Git artifact SHA; preceding callers may use a SHA-256 artifact digest.
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(a.artifactSha)) throw new Error("invalid artifact SHA");
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
    return new KeyedChildLedger(authority, Object.freeze(copies), Object.freeze([]), 0, undefined, KeyedChildLedger.#construction);
  }
  get remainingAllowance(): number { return this.#slots.length - this.#accepted.length; }
  get occupied(): boolean { return this.#accepted.some(c => c.state !== KeyedChildState.Terminal); }
  snapshot(): KeyedChildLedgerSnapshot {
    return Object.freeze({ schemaVersion: 1, authorityDigest: this.authorityDigest,
      slots: this.#slots, generation: this.generation, accepted: this.#accepted });
  }
  serialize(): string {
    const encoded = JSON.stringify(this.snapshot());
    if (Buffer.byteLength(encoded, "utf8") > keyedChildSnapshotMaxBytes) throw new Error("snapshot too large");
    return encoded;
  }
  /** Only immediate domain-produced successors or byte-identical noops may publish.
   * Restored snapshots confer no transition/proof authority. */
  assertSuccessor(next: KeyedChildLedger): void {
    if (!(next instanceof KeyedChildLedger) ||
        !(next.serialize() === this.serialize() ||
          (next.#previousToken === this.#successorToken && next.generation === this.generation + 1))) {
      throw new Error("invalid ledger successor");
    }
  }
  /** Restore against independently trusted immutable authority and allocations.
   * Canonical equality also rejects duplicate JSON fields and alternate encodings. */
  static restore(encoded: string, trusted: KeyedChildLedger): KeyedChildLedger {
    text(encoded, keyedChildSnapshotMaxBytes);
    if (Buffer.byteLength(encoded, "utf8") > keyedChildSnapshotMaxBytes) throw new Error("snapshot too large");
    const value: unknown = JSON.parse(encoded);
    exactFields(value, "schemaVersion,authorityDigest,slots,generation,accepted");
    const s = value as KeyedChildLedgerSnapshot;
    if (s.schemaVersion !== 1 || s.authorityDigest !== trusted.authorityDigest ||
        JSON.stringify(s.slots) !== JSON.stringify(trusted.#slots) ||
        !Number.isSafeInteger(s.generation) || s.generation < 0 ||
        !Array.isArray(s.accepted) || s.accepted.length > trusted.#slots.length) throw new Error("invalid snapshot binding");
    let validation = KeyedChildLedger.create(trusted.#authority, trusted.#slots), minimum = 0;
    const children: AcceptedChild[] = [];
    for (const row of s.accepted) {
      exactFields(row, "key,task,allocation,keyDigest,requestDigest,promptDigest,state,dispatchIntent");
      exactFields(row.allocation, "slotId,requestId,operationId,childHandle,startId,unitCorrelation,profile");
      validation = validation.accept(validation.generation,
        { key: row.key, task: row.task, profile: row.allocation.profile }, 1);
      const accepted = validation.#accepted.at(-1)!;
      if (children.some(c => c.key === row.key) ||
          JSON.stringify(row.allocation) !== JSON.stringify(accepted.allocation) ||
          ["keyDigest", "requestDigest", "promptDigest"].some(field =>
            row[field as "keyDigest"] !== accepted[field as "keyDigest"]) ||
          !Object.values(KeyedChildState).includes(row.state)) throw new Error("invalid accepted history");
      const pre = new Map([[KeyedChildState.Claimed, 1], [KeyedChildState.Materializing, 2],
        [KeyedChildState.Prepared, 3], [KeyedChildState.Terminal, 2],
        [KeyedChildState.Uncertain, 2], [KeyedChildState.StopRequested, 2]]);
      const post = new Map([[KeyedChildState.DispatchIntent, 0], [KeyedChildState.Submitted, 1],
        [KeyedChildState.Running, 2], [KeyedChildState.Uncertain, 1], [KeyedChildState.StopRequested, 1], [KeyedChildState.Terminal, 1]]);
      if (row.dispatchIntent !== null) {
        exactFields(row.dispatchIntent, "generation"); integer(row.dispatchIntent.generation);
        if (!post.has(row.state) || row.dispatchIntent.generation < minimum + 4 ||
            (!children.length && row.dispatchIntent.generation !== 4)) throw new Error("invalid dispatch intent");
        minimum = row.dispatchIntent.generation + post.get(row.state)!;
      } else {
        if (!pre.has(row.state)) throw new Error("missing dispatch intent");
        minimum += pre.get(row.state)!;
      }
      children.push(Object.freeze({ ...accepted, state: row.state,
        dispatchIntent: row.dispatchIntent === null ? null : Object.freeze({ generation: row.dispatchIntent.generation }) }));
      // Reconstructed history supplies occupancy to the existing accept validator.
      validation = new KeyedChildLedger(trusted.#authority, trusted.#slots, Object.freeze([...children]), minimum, undefined, KeyedChildLedger.#construction);
    }
    if (minimum > s.generation || (!children.length && s.generation !== 0)) throw new Error("invalid snapshot generation");
    const last = children.at(-1);
    if (last && ((last.dispatchIntent && [KeyedChildState.DispatchIntent, KeyedChildState.Submitted,
        KeyedChildState.Running].includes(last.state)) || (children.length === 1 &&
        [KeyedChildState.Claimed, KeyedChildState.Materializing, KeyedChildState.Prepared].includes(last.state))) &&
        s.generation !== minimum) throw new Error("impossible snapshot generation");
    const restored = new KeyedChildLedger(trusted.#authority, trusted.#slots, Object.freeze(children), s.generation, undefined, KeyedChildLedger.#construction);
    if (restored.serialize() !== encoded) throw new Error("noncanonical snapshot");
    return restored;
  }
  #checkGeneration(expected: number): void {
    if (expected !== this.generation) throw new Error("stale generation");
  }
  #beforeDeadline(now: number): void {
    integer(now);
    if (now >= this.#authority.absoluteDeadline) throw new Error("deadline expired");
  }
  #successor(children: readonly AcceptedChild[]): KeyedChildLedger {
    if (this.generation === Number.MAX_SAFE_INTEGER) throw new Error("generation exhausted");
    return new KeyedChildLedger(this.#authority, this.#slots, Object.freeze(children), this.generation + 1, this, KeyedChildLedger.#construction);
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
  /** Receipt authority is opaque, runtime validated and bound to stable identity.
   * The adapter revalidates durable ordinary successors under the fresh CAS. */
  terminalizeAfterIntent(binding: ChildCorrelation, authority: RuntimeValidatedTermination): KeyedChildLedger {
    const c = this.#correlated(binding);
    if (!c.dispatchIntent) throw new Error("dispatch intent required");
    assertRuntimeValidatedTermination(authority, binding, c.dispatchIntent.generation);
    return c.state === KeyedChildState.Terminal ? this : this.#replace(c, KeyedChildState.Terminal);
  }
  /** Evidence must come from independent trusted verification, never an exception/timeout. */
  terminalizeBeforeIntent(evidence: IndependentNoEffectEvidence): KeyedChildLedger {
    const c = this.#correlated(evidence.correlation);
    if (c.dispatchIntent || evidence.kind !== NoEffectProofKind.IndependentlyEstablished) throw new Error("no-effect proof required");
    digest(evidence.evidenceDigest);
    return c.state === KeyedChildState.Terminal ? this : this.#replace(c, KeyedChildState.Terminal);
  }
}
