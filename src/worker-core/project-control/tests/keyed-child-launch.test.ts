import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { DispatchEligibility, KeyedChildLedger, KeyedChildProfile as Profile,
  KeyedChildState as State, NoEffectProofKind, encodeChildKey,
  type ChildSlotAllocation, type ReviewedChildAuthority } from "../domain/keyed-child-launch";

const scope = { projectId: "test-project", workstreamId: "work", controllerId: "controller" };
const authority: ReviewedChildAuthority = { ...scope, grantDigest: "a".repeat(64),
  reviewedSnapshotDigest: "b".repeat(64), accountId: "admitted-account", sourceSha: "c".repeat(40),
  artifactSha: "d".repeat(64), absoluteDeadline: 1000, maxGoalTurns: 3, effectiveOptionDigest: "e".repeat(64) };
const slot = (n: number): ChildSlotAllocation => ({ slotId: `slot-${n}`, requestId: `request-${n}`,
  operationId: `operation-${n}`, childHandle: `child-${n}`, startId: `start-${n}`,
  unitCorrelation: `unit-${n}`, profile: Profile.IsolatedWrite });
const request = { key: "key", task: "precise task", profile: Profile.IsolatedWrite };
const fresh = () => KeyedChildLedger.create(authority, [slot(1), slot(2)]);
const view = (l: KeyedChildLedger) => l.observe(scope, "child-1");
const accepted = () => fresh().accept(0, request, 10);
function prepared() {
  let l = accepted();
  l = l.advance(view(l), State.Materializing, 20);
  return l.advance(view(l), State.Prepared, 30);
}
function noEffects(l: KeyedChildLedger, handle = "child-1") {
  return l.terminalizeBeforeIntent({ kind: NoEffectProofKind.IndependentlyEstablished,
    correlation: l.observe(scope, handle), evidenceDigest: "f".repeat(64) });
}

describe("finite keyed child ledger", () => {
  it("stop cannot be regressed by a late materialization failure", () => {
    const l = accepted(), stopped = l.stop(view(l));
    expect(stopped.markUncertain(view(stopped))).toBe(stopped);
    expect(view(stopped).state).toBe(State.StopRequested);
    expect(stopped.stop(view(stopped))).toBe(stopped);
    expect(stopped.remainingAllowance).toBe(1);
    expect(() => stopped.advance(view(stopped), State.Prepared, 50)).toThrow();
    expect(() => stopped.advance(view(stopped), State.DispatchIntent, 50)).toThrow();
  });
  it("lost replies and terminal replay cannot allocate a replacement child", () => {
    let l = accepted();
    const initial = view(l);
    expect(l.accept(l.generation, { ...request }, 9999)).toBe(l);
    expect(() => l.accept(l.generation, { ...request, task: "different" }, 20)).toThrow("conflict");
    expect(() => l.accept(l.generation, { ...request, profile: Profile.ReadOnly }, 20)).toThrow("conflict");
    l = noEffects(l);
    expect(l.occupied).toBe(false);
    expect(l.accept(l.generation, request, 9999)).toBe(l);
    expect(view(l)).toMatchObject({ state: State.Terminal, childHandle: initial.childHandle,
      operationId: initial.operationId, startId: initial.startId, keyDigest: initial.keyDigest });
    expect(() => l.accept(l.generation, { ...request, task: "different" }, 20)).toThrow("conflict");
    expect(l.remainingAllowance).toBe(1);
  });

  it("competing distinct keys consume neither slot nor generation while occupied", () => {
    const base = fresh(), l = base.accept(0, request, 10);
    expect(() => l.accept(1, { ...request, key: "competitor" }, 11)).toThrow("occupied");
    expect(l.remainingAllowance).toBe(1);
    expect(l.generation).toBe(1);
    expect(base.remainingAllowance).toBe(2);
    expect(base.occupied).toBe(false);
    // A racing successor based on the old snapshot must fail the expected-generation CAS.
    expect(() => l.accept(base.generation, { ...request, key: "competitor" }, 11)).toThrow("stale");
  });

  it("successful no-effect proof releases occupancy but never replenishes allowance", () => {
    let l = noEffects(accepted());
    l = l.accept(l.generation, { ...request, key: "second" }, 50);
    expect(l.observe(scope, "child-2").startId).toBe("start-2");
    l = noEffects(l, "child-2");
    expect(l.remainingAllowance).toBe(0);
    expect(() => l.accept(l.generation, { ...request, key: "third" }, 60)).toThrow("exhausted");
  });

  it("stale and foreign observations cannot mutate a successor or cross authority", () => {
    const l = accepted(), old = view(l), next = l.advance(old, State.Materializing, 20);
    expect(next.generation).toBe(2);
    expect(l.generation).toBe(1);
    expect(() => next.advance(old, State.Prepared, 30)).toThrow("stale");
    for (const field of ["authorityDigest", "keyDigest", "requestDigest", "promptDigest", "startId", "unitCorrelation",
      "slotId", "requestId", "operationId", "childHandle"] as const) {
      expect(() => next.stop({ ...view(next), [field]: "foreign" })).toThrow();
    }
    const foreign = KeyedChildLedger.create({ ...authority, grantDigest: "f".repeat(64) }, [slot(1)]).accept(0, request, 10);
    expect(() => l.stop(view(foreign))).toThrow("foreign");
    expect(() => l.advance(old, State.Running, 30)).toThrow("incompatible");
  });

  it("intent publication followed by ambiguity never renews submission eligibility", () => {
    const p = prepared();
    expect(view(p).eligibility).toBe(DispatchEligibility.EligibleBeforeIntent);
    const intent = p.advance(view(p), State.DispatchIntent, 40);
    expect(view(intent).dispatchIntent).toEqual({ generation: 4 });
    expect(view(intent).eligibility).toBe(DispatchEligibility.HeldAfterIntent);
    const uncertain = intent.markUncertain(view(intent));
    expect(view(uncertain).dispatchIntent).toEqual({ generation: 4 });
    expect(uncertain.occupied).toBe(true);
    expect(() => uncertain.advance(view(uncertain), State.DispatchIntent, 50)).toThrow();
    expect(() => uncertain.advance(view(uncertain), State.Prepared, 50)).toThrow();
    expect(() => noEffects(uncertain)).toThrow("proof required");
    expect(uncertain.accept(uncertain.generation, request, 50)).toBe(uncertain);
  });

  it("acknowledgment, running and repeated stop preserve exact correlation and intent", () => {
    let l = prepared();
    for (const state of [State.DispatchIntent, State.Submitted, State.Running]) l = l.advance(view(l), state, 40);
    const running = view(l);
    l = l.stop(running);
    expect(view(l)).toMatchObject({ state: State.StopRequested, operationId: "operation-1",
      startId: "start-1", unitCorrelation: "unit-1", dispatchIntent: { generation: 4 } });
    expect(l.stop(view(l))).toBe(l);
    expect(l.occupied).toBe(true);
    expect(() => noEffects(l)).toThrow();
  });

  it("timeout, zero exit, lease expiry and process death are not release evidence", () => {
    let l = prepared();
    l = l.advance(view(l), State.DispatchIntent, 40);
    for (const unsupported of ["timeout", "provider_zero_exit", "lease_expired", "process_death"]) {
      expect(() => l.advance(view(l), unsupported as State, 9999)).toThrow();
      expect(() => l.terminalizeBeforeIntent({ kind: unsupported as NoEffectProofKind,
        correlation: view(l), evidenceDigest: "f".repeat(64) })).toThrow();
    }
    l = l.markUncertain(view(l));
    expect(l.occupied).toBe(true);
    expect(() => l.accept(l.generation, { ...request, key: "replacement" }, 50)).toThrow("occupied");
  });

  it("pre-intent uncertainty cannot release occupancy without independent correlated evidence", () => {
    const claimed = accepted(), l = claimed.markUncertain(view(claimed));
    expect(l.occupied).toBe(true);
    expect(() => l.terminalizeBeforeIntent({ kind: NoEffectProofKind.IndependentlyEstablished,
      correlation: view(l), evidenceDigest: "" })).toThrow("digest");
    expect(() => l.terminalizeBeforeIntent({ kind: NoEffectProofKind.IndependentlyEstablished,
      correlation: { ...view(l), startId: "unrelated" }, evidenceDigest: "f".repeat(64) })).toThrow("foreign");
    expect(() => l.terminalizeBeforeIntent({ kind: "provider_zero_exit" as NoEffectProofKind,
      correlation: view(l), evidenceDigest: "f".repeat(64) })).toThrow("proof required");
    expect(() => l.advance(view(l), State.Prepared, 50)).toThrow();
    expect(noEffects(l).occupied).toBe(false);
  });

  it("absolute deadline blocks new acceptance and pre-intent effects, never replay", () => {
    expect(() => fresh().accept(0, request, 1000)).toThrow("deadline");
    const l = accepted();
    expect(() => l.advance(view(l), State.Materializing, 1000)).toThrow("deadline");
    const p = prepared();
    expect(() => p.advance(view(p), State.DispatchIntent, 1000)).toThrow("deadline");
    expect(l.accept(1, request, 1000)).toBe(l);
  });

  it("exact UTF-8 keys and tasks cannot be normalized, truncated or overridden", () => {
    for (const bad of ["", "x".repeat(129), "\ud800", "\udfff"]) {
      expect(() => fresh().accept(0, { ...request, key: bad }, 10)).toThrow();
    }
    for (const bad of ["", "x".repeat(4001), "\ud800", "\udfff"]) {
      expect(() => fresh().accept(0, { ...request, task: bad }, 10)).toThrow();
    }
    const l = fresh().accept(0, { ...request, key: " key ", task: " task 😀 " }, 10);
    expect(() => l.accept(1, { ...request, key: " key ", task: "task 😀" }, 10)).toThrow("conflict");
    const override = { ...request, accountId: "override" };
    expect(() => fresh().accept(0, override, 10)).toThrow("override");
    expect(() => fresh().accept(0, { ...request, key: "k".repeat(128), task: "t".repeat(4000) }, 10)).not.toThrow();
  });

  it("canonical version and field order keep identities stable and scope separated", () => {
    const canonical = '["keyed-child-key",1,"test-project","work","controller","key"]';
    expect(encodeChildKey(scope, "key")).toBe(canonical);
    expect(view(accepted()).keyDigest).toBe(createHash("sha256").update(canonical).digest("hex"));
    expect(encodeChildKey({ ...scope, controllerId: "other" }, "key")).not.toBe(canonical);
    expect(encodeChildKey(scope, " key")).not.toBe(canonical);
  });

  it("private authority and finite allocations cannot be changed by external references", () => {
    const a = { ...authority }, slots = [slot(1)], l = KeyedChildLedger.create(a, slots);
    a.accountId = "changed"; a.absoluteDeadline = 1; slots[0] = slot(99);
    expect(l.accept(0, request, 10).observe(scope, "child-1").startId).toBe("start-1");
    expect(() => KeyedChildLedger.create(authority, [slot(1), slot(1)])).toThrow("duplicate");
    expect(() => KeyedChildLedger.create(authority, [slot(1), { ...slot(2), childHandle: "operation-1" }])).toThrow("ambiguous");
    expect(() => KeyedChildLedger.create({ ...authority, maxGoalTurns: 0 }, [slot(1)])).toThrow();
    expect(() => KeyedChildLedger.create(authority, Array.from({ length: 129 }, (_, n) => slot(n)))).toThrow();
    expect(() => KeyedChildLedger.create(authority, [{ ...slot(1), childHandle: "x".repeat(129) }])).toThrow();
    expect(() => l.observe({ ...scope, controllerId: "foreign" }, "child-1")).toThrow("foreign scope");
    const c = l.accept(0, request, 10);
    expect(() => c.observe(scope, "foreign")).toThrow("foreign handle");
    expect(JSON.stringify(view(c))).not.toContain("precise task");
    expect(JSON.stringify(view(c))).not.toContain("admitted-account");
  });

  it("correlation binds every reviewed lifetime and admission field, preventing swapped grants", () => {
    for (const override of [{ accountId: "other" }, { sourceSha: "f".repeat(40) },
      { artifactSha: "f".repeat(64) }, { absoluteDeadline: 1001 }, { maxGoalTurns: 4 },
      { effectiveOptionDigest: "f".repeat(64) }, { reviewedSnapshotDigest: "f".repeat(64) }]) {
      const foreign = KeyedChildLedger.create({ ...authority, ...override }, [slot(1)]).accept(0, request, 10);
      expect(() => accepted().stop(view(foreign))).toThrow("foreign correlation");
    }
  });
});
