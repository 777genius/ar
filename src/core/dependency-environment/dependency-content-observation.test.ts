import { createHash } from "node:crypto";
import type { DependencyProtectedReference } from "./dependency-protected-reference";
import { describe, expect, it } from "vitest";
import { DependencyContentObservationOutcome as Outcome, DependencyContentObservationRecordKind as Kind,
  DependencyContentObservationReadStatus as Status, DependencyContentObservationStage as Stage,
  readDependencyContentObservationFacts as readFacts, type DependencyContentObservationRecord } from "./dependency-content-observation";
const identity = { attemptId: "11111111-1111-4111-8111-111111111111", startId: "22222222-2222-4222-8222-222222222222",
  epoch: "2", scopeSha256: "a".repeat(64) };
const opened: DependencyContentObservationRecord = { version: 1, identity, kind: Kind.Opened };
const ref = (record: DependencyContentObservationRecord): DependencyProtectedReference => ({
  path: "/var/lib/subscription-runtime-host-policy/dependency-content-observations/" + (record.kind === Kind.Started || record.kind === Kind.Returned ? record.ordinal + "." : "") + record.kind + ".json",
  identity: { dev: "1", ino: record.kind === Kind.Opened ? "1" : record.kind === Kind.Closed ? "2" : String(10 + record.ordinal * 2 + (record.kind === Kind.Returned ? 1 : 0)) },
  sha256: createHash("sha256").update(JSON.stringify(record) + "\n").digest("hex"),
});
const close = (count: number, stages: readonly Stage[] = [Stage.Staged]): DependencyContentObservationRecord => ({ version: 1, identity, kind: Kind.Closed, count,
  opened: ref(opened), observations: Array.from({ length: count }, (_, index) => ({ ordinal: index + 1,
    started: ref({ version: 1, identity, kind: Kind.Started, ordinal: index + 1, stage: stages[index] ?? Stage.Staged }),
    returned: ref({ version: 1, identity, kind: Kind.Returned, ordinal: index + 1, stage: stages[index] ?? Stage.Staged, outcome: Outcome.Complete }),
  })),
});
const read = (expected: unknown, values: readonly DependencyContentObservationRecord[] | undefined) => readFacts(expected, values, values?.map(ref));
const pair = (ordinal: number, stage: Stage): [Extract<DependencyContentObservationRecord, { kind: Kind.Started }>,
  Extract<DependencyContentObservationRecord, { kind: Kind.Returned }>] => [
  { version: 1, identity, kind: Kind.Started, ordinal, stage },
  { version: 1, identity, kind: Kind.Returned, ordinal, stage, outcome: Outcome.Complete },
];
describe("admission content observation facts", () => {
  // Regression: absence or an interrupted capture must never be a HOT zero.
  it("requires a completed zero interval rather than missing observation records", () => {
    for (const values of [undefined, [], [opened], [close(0)]]) expect(read(identity, values).status).toBe(Status.Unknown);
    expect(read(identity, [opened, close(0)])).toMatchObject({ status: Status.Complete, attempted: 0, completed: 0, finalRoot: 0 });
  });
  it("distinguishes the three actual cold scans from one final-root observation", () => {
    expect(read(identity, [opened, ...pair(1, Stage.Staged), ...pair(2, Stage.Normalized), ...pair(3, Stage.FinalRoot), close(3, [Stage.Staged, Stage.Normalized, Stage.FinalRoot])]))
      .toMatchObject({ status: Status.Complete, attempted: 3, completed: 3, finalRoot: 1 });
  });
  it("refuses lost or incomplete completion even when a seal was written", () => {
    const values = pair(1, Stage.Staged), start = values[0]!, returned = values[1]!;
    expect(read(identity, [opened, start, close(1)]).status).toBe(Status.Unknown);
    expect(read(identity, [opened, start, { ...returned, outcome: Outcome.Incomplete }, close(1)]).status).toBe(Status.Unknown);
    expect(read(identity, [opened, ...pair(1, Stage.Staged)]).status).toBe(Status.Unknown);
  });
  it("deduplicates exact immutable facts and holds conflicting duplicates", () => {
    const values = pair(1, Stage.Staged);
    expect(read(identity, [opened, ...values, ...values, close(1)]).completed).toBe(1);
    expect(read(identity, [opened, ...values, ...pair(1, Stage.Normalized), close(1)]).status).toBe(Status.Unknown);
  });
  it("refuses replaced capture bytes or file identity against the original seal", () => {
    const values = [opened, ...pair(1, Stage.Staged), close(1)], references = values.map(ref);
    const changed = [...references]; changed[1] = { ...references[1]!, sha256: "b".repeat(64) };
    expect(readFacts(identity, values, changed).status).toBe(Status.Unknown);
    changed[1] = { ...references[1]!, identity: { dev: "1", ino: "999" } };
    expect(readFacts(identity, values, changed).status).toBe(Status.Unknown);
    expect(readFacts(identity, values, undefined).status).toBe(Status.Unknown);
  });
  it("holds gaps, foreign epochs and extra capture records", () => {
    expect(read(identity, [opened, ...pair(2, Stage.Staged), close(1)]).status).toBe(Status.Unknown);
    expect(read({ ...identity, epoch: "3" }, [opened, close(0)]).status).toBe(Status.Unknown);
    expect(read(identity, [opened, ...pair(1, Stage.Staged), close(0)]).status).toBe(Status.Unknown);
  });
});
