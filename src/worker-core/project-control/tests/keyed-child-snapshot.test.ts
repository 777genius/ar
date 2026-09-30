import { describe, expect, it } from "vitest";
import { KeyedChildLedger, keyedChildSnapshotMaxBytes, KeyedChildProfile as Profile, KeyedChildState as State,
  NoEffectProofKind, type KeyedChildLedgerSnapshot } from "../domain/keyed-child-launch";

const scope = { projectId: "TEST", workstreamId: "work", controllerId: "controller" };
const authority = { ...scope, grantDigest: "a".repeat(64), reviewedSnapshotDigest: "b".repeat(64),
  accountId: "TEST-account", sourceSha: "c".repeat(40), artifactSha: "d".repeat(64),
  absoluteDeadline: 1000, maxGoalTurns: 3, effectiveOptionDigest: "e".repeat(64) };
const slots = [1, 2].map(n => ({ slotId: `slot-${n}`, requestId: `request-${n}`, operationId: `operation-${n}`,
  childHandle: `child-${n}`, startId: `start-${n}`, unitCorrelation: `unit-${n}`, profile: Profile.IsolatedWrite }));
const seed = () => KeyedChildLedger.create(authority, slots);
const request = { key: " key 😀 ", task: " precise task 😀 ", profile: Profile.IsolatedWrite };
const claimed = () => seed().accept(0, request, 10);
const view = (l: KeyedChildLedger) => l.observe(scope, "child-1");
const terminal = () => { const l = claimed(); return l.terminalizeBeforeIntent({
  kind: NoEffectProofKind.IndependentlyEstablished, correlation: view(l), evidenceDigest: "f".repeat(64) }); };
function intent() {
  let l = claimed();
  for (const state of [State.Materializing, State.Prepared, State.DispatchIntent]) l = l.advance(view(l), state, 20);
  return l;
}
// Mutations are made to serialized data, independently of production validation.
const mutable = (l = claimed()) => JSON.parse(l.serialize());

describe("finite canonical private snapshot codec", () => {
  it("roundtrips every supported state, preserving intent/occupancy/handles and sanitized observations", () => {
    const examples = [seed(), claimed(), terminal()]; let l = claimed();
    for (const state of [State.Materializing, State.Prepared, State.DispatchIntent, State.Submitted, State.Running]) {
      l = l.advance(view(l), state, 20); examples.push(l);
    }
    examples.push(l.stop(view(l)), l.markUncertain(view(l)), claimed().markUncertain(view(claimed())));
    for (const original of examples) {
      const restored = KeyedChildLedger.restore(original.serialize(), seed());
      expect(restored.serialize()).toBe(original.serialize()); expect(restored.occupied).toBe(original.occupied);
      expect(restored.remainingAllowance).toBe(original.remainingAllowance);
      if (restored.generation) {
        expect(view(restored)).toEqual(view(original));
        expect(restored.accept(restored.generation, { ...request }, 9999)).toBe(restored);
        expect(JSON.stringify(view(restored))).not.toContain(request.task);
        expect(JSON.stringify(view(restored))).not.toContain(authority.accountId);
      }
      expect(Object.isFrozen(restored.snapshot().accepted)).toBe(true);
    }
  });
  it.each([
    (s: ReturnType<typeof mutable>) => { s.extra = true; },
    (s: ReturnType<typeof mutable>) => { s.schemaVersion = 2; },
    (s: ReturnType<typeof mutable>) => { s.authorityDigest = "f".repeat(64); },
    (s: ReturnType<typeof mutable>) => { s.slots[0].startId = "foreign"; },
    (s: ReturnType<typeof mutable>) => { s.slots[0].extra = true; },
    (s: ReturnType<typeof mutable>) => { s.generation = -1; },
    (s: ReturnType<typeof mutable>) => { s.generation = 1.5; },
    (s: ReturnType<typeof mutable>) => { s.generation = Number.MAX_SAFE_INTEGER + 1; },
    (s: ReturnType<typeof mutable>) => { s.generation = 0; },
    (s: ReturnType<typeof mutable>) => { s.generation = 5; },
    (s: ReturnType<typeof mutable>) => { s.accepted[0].state = "future"; },
    (s: ReturnType<typeof mutable>) => { s.accepted[0].promptDigest = "f".repeat(64); },
    (s: ReturnType<typeof mutable>) => { s.accepted[0].keyDigest = "a"; },
    (s: ReturnType<typeof mutable>) => { s.accepted[0].requestDigest = "f".repeat(64); },
    (s: ReturnType<typeof mutable>) => { s.accepted[0].task = "\ud800"; },
    (s: ReturnType<typeof mutable>) => { s.accepted[0].key = "\udfff"; },
    (s: ReturnType<typeof mutable>) => { s.accepted[0].task = "x".repeat(4001); },
    (s: ReturnType<typeof mutable>) => { s.accepted[0].allocation = s.slots[1]; },
    (s: ReturnType<typeof mutable>) => { s.accepted.push(s.accepted[0]); s.generation = 5; },
    (s: ReturnType<typeof mutable>) => { s.accepted[0].dispatchIntent = { generation: 1 }; },
    (s: ReturnType<typeof mutable>) => { s.accepted[0].state = State.Running; },
  ])("rejects malformed, foreign, inconsistent or reused snapshot data (%#)", mutation => {
    const s = mutable(); mutation(s);
    expect(() => KeyedChildLedger.restore(JSON.stringify(s), seed())).toThrow();
  });
  it("rejects impossible intent state/generation, unknown intent fields and multiple occupied slots", () => {
    for (const change of [{ state: State.Terminal }, { dispatchIntent: null }, { dispatchIntent: { generation: 5 } },
      { dispatchIntent: { generation: 3 } }, { dispatchIntent: { generation: 4, extra: true } }]) {
      const s = mutable(intent()); Object.assign(s.accepted[0], change);
      expect(() => KeyedChildLedger.restore(JSON.stringify(s), seed())).toThrow();
    }
    const second = terminal().accept(2, { ...request, key: "second" }, 20), s = mutable(second);
    s.accepted[0].state = State.Uncertain;
    expect(() => KeyedChildLedger.restore(JSON.stringify(s), seed())).toThrow("occupied");
    // Releasing occupancy cannot replenish or rewrite an earlier accepted slot.
    const restored = KeyedChildLedger.restore(second.serialize(), seed());
    expect(restored.remainingAllowance).toBe(0);
    expect(restored.observe(scope, "child-1").state).toBe(State.Terminal);
  });
  it("rejects duplicate fields, alternate order/whitespace, overbound bytes and nonfinite generation", () => {
    const encoded = claimed().serialize();
    for (const bad of ["{", encoded + " ", encoded.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
      JSON.stringify({ ...claimed().snapshot(), generation: Infinity }),
      " ".repeat(keyedChildSnapshotMaxBytes + 1),
      JSON.stringify(Object.assign({ generation: 1 }, claimed().snapshot()))]) {
      expect(() => KeyedChildLedger.restore(bad, seed())).toThrow();
    }
    const dto: KeyedChildLedgerSnapshot = claimed().snapshot();
    expect(Object.isFrozen(dto.accepted[0]!.allocation)).toBe(true);
    expect(() => KeyedChildLedger.restore(encoded, KeyedChildLedger.create({ ...authority, maxGoalTurns: 4 }, slots))).toThrow();
  });
});

it("decoded snapshots cannot borrow a prior aggregate's transition provenance", () => {
  const current = claimed(), successor = current.advance(view(current), State.Materializing, 20);
  const decoded = KeyedChildLedger.restore(successor.serialize(), current);
  expect(decoded.serialize()).toBe(successor.serialize());
  expect(() => current.assertSuccessor(decoded)).toThrow("invalid ledger successor");
  expect(() => current.assertSuccessor(successor)).not.toThrow();
  expect(() => current.assertSuccessor(KeyedChildLedger.restore(current.serialize(), current))).not.toThrow();
  for (const supplied of [current, {}, undefined]) {
    expect(() => Reflect.construct(KeyedChildLedger, [authority, slots, successor.snapshot().accepted, 2, current, supplied])).toThrow();
  }
});
