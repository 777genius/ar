import { describe, expect, it } from "vitest";
import { DependencyCustodyEvidenceKind as Kind, parseDependencyCustodyEvidence,
  type DependencyProtectedReference, type DependencyReadonlyAdoptionEvidence,
  type DependencyReadonlyColdBaselineAdoptionEvidence } from "../dependency-environment/dependency-custody-evidence";
import { DependencyGenerationContinuityKind as Continuity } from "../dependency-environment/dependency-generation-continuity";

const operationId = "00000000-0000-4000-8000-000000000001";
const baselineId = "00000000-0000-4000-8000-000000000002";
const closedStartId = "00000000-0000-4000-8000-000000000003";
const ref = (name: string): DependencyProtectedReference => ({ path: "/TEST-protected/" + name + ".json",
  identity: { dev: "1", ino: "2" }, sha256: "a".repeat(64) });
function evidence(): DependencyReadonlyColdBaselineAdoptionEvidence {
  return { version: 2, kind: Kind.ReadonlyColdBaselineAdoptionV2, operationId,
    workspace: { canonicalPath: "/TEST/C/workspace", dev: "1", ino: "3" },
    installation: { installationId: operationId, runtimeSha: "b".repeat(40), inventoryDigest: "c".repeat(64) },
    candidate: { jobId: "C", binding: ref("C-binding"), closedStartId,
      generationBaseline: { version: 1, kind: Continuity.BaselineAuthenticatedV1, operationId: baselineId,
        generation: "TEST-cold-generation", readyRevision: 4, previousReady: ref("ready"),
        baseline: ref("baseline"), writerBarrier: ref("barrier") },
      sourceClosed: ref("source-closed"), idle: ref("idle"), sourceMapping: ref("completed-local-source") },
    readonlyCustody: { jobId: "R", jobRootDir: "/TEST/C", workspacePath: "/TEST/C/workspace",
      grant: ref("R-grant"), policy: ref("policy"), review: ref("review"), stage: ref("stage"), lease: ref("lease") } };
}
const denied = (value: unknown) => expect(() => parseDependencyCustodyEvidence(value)).toThrow("dependency_custody_evidence:invalid_record");

// Regressions: conflating the last HOT C start with the cold baseline; accepting
// a retired slot or comparison as a cold baseline; losing exact C/R/root joins;
// serializing getters/hidden fields or retaining caller-owned protected data.
describe("closed data-only cold-baseline custody evidence", () => {
  it("preserves the independently completed C start, original baseline and exact protected references", () => {
    const input = evidence(), parsed = parseDependencyCustodyEvidence(input);
    expect(input.candidate.closedStartId).not.toBe(input.candidate.generationBaseline.operationId);
    expect(parsed).toEqual(input);
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(input));
    expect(parsed.kind).toBe(Kind.ReadonlyColdBaselineAdoptionV2);
  });
  it("accepts only the versioned genuine baseline shape with a Ready revision", () => {
    const input = evidence(), baseline = input.candidate.generationBaseline;
    const retired = { version: 1, kind: Continuity.RetiredReadyV1, operationId: baselineId,
      generation: baseline.generation, readyRevision: 4, unverifiedRevision: 5,
      previousReady: ref("ready"), retiredUnverified: ref("retired") };
    for (const generationBaseline of [ retired, { ...baseline, readyRevision: 0 },
      { ...baseline, writerBarrier: baseline.baseline }, { ...baseline, comparison: ref("comparison") },
      { ...baseline, kind: "unknown_baseline" }, { ...baseline, previousReady: { ...ref("ready"), sha256: "g".repeat(64) } } ]) {
      denied({ ...input, candidate: { ...input.candidate, generationBaseline } });
    }
    denied({ ...input, version: 1 });
    denied({ ...input, kind: Kind.ReadonlyLocalAdoptionV1 });
  });
  it("requires distinct C/R jobs and retains the C workspace under R custody", () => {
    const input = evidence();
    for (const readonlyCustody of [ { ...input.readonlyCustody, jobId: "C" },
      { ...input.readonlyCustody, jobRootDir: "/TEST/R" },
      { ...input.readonlyCustody, workspacePath: "/TEST/clone/workspace" } ]) denied({ ...input, readonlyCustody });
    denied({ ...input, candidate: { ...input.candidate, closedStartId: "TEST-not-a-start" } });
  });
  it("requires every actual closure/mapping reference and rejects fabricated comparison or issuer fields", () => {
    const input = evidence();
    for (const name of [ "binding", "sourceClosed", "idle", "sourceMapping" ] as const) {
      const candidate: Record<string, unknown> = { ...input.candidate }; delete candidate[name];
      denied({ ...input, candidate });
      denied({ ...input, candidate: { ...input.candidate, [name]: { ...ref(name), identity: { dev: "1", ino: "0" } } } });
    }
    for (const candidate of [ { ...input.candidate, comparison: ref("comparison") },
      { ...input.candidate, sourceMapping: "a".repeat(64) }, { ...input.candidate, issuer: "TEST-claimed-issuer" } ]) {
      denied({ ...input, candidate });
    }
    denied({ ...input, grant: ref("claimed-grant") });
    denied({ ...input, authorized: true });
  });
  it("rejects accessors in the discriminant and baseline chain without evaluating them", () => {
    let evaluations = 0;
    function accessor(value: object, key: string) {
      const copy = { ...value };
      Object.defineProperty(copy, key, { enumerable: true, get() { evaluations++; throw new Error("TEST getter must not run"); } });
      return copy;
    }
    const input = evidence();
    for (const value of [ accessor(input, "kind"), { ...input, candidate: accessor(input.candidate, "generationBaseline") },
      { ...input, candidate: { ...input.candidate, generationBaseline: accessor(input.candidate.generationBaseline, "kind") } },
      { ...input, candidate: { ...input.candidate, generationBaseline: { ...input.candidate.generationBaseline,
        previousReady: accessor(input.candidate.generationBaseline.previousReady, "path") } } } ]) denied(value);
    expect(evaluations).toBe(0);
  });
  it("rejects hidden fields and byte overflow, then detaches nested protected values", () => {
    const input = evidence(), hidden = { ...input.candidate.generationBaseline };
    Object.defineProperty(hidden, "TEST-hidden", { value: true });
    denied({ ...input, candidate: { ...input.candidate, generationBaseline: hidden } });
    denied({ ...input, candidate: { ...input.candidate, [Symbol("TEST-hidden")]: true } });
    const longRef = (name: string) => ({ ...ref(name), path: "/" + name + "x".repeat(3900) });
    denied({ ...input, readonlyCustody: { ...input.readonlyCustody, grant: longRef("grant"), policy: longRef("policy"),
      review: longRef("review"), stage: longRef("stage"), lease: longRef("lease") } });
    const parsed = parseDependencyCustodyEvidence(input);
    if (parsed.kind !== Kind.ReadonlyColdBaselineAdoptionV2) throw new Error("TEST wrong variant");
    expect(parsed.candidate).not.toBe(input.candidate);
    expect(parsed.candidate.generationBaseline).not.toBe(input.candidate.generationBaseline);
    expect(parsed.candidate.generationBaseline.previousReady.identity).not.toBe(input.candidate.generationBaseline.previousReady.identity);
    const before = JSON.stringify(parsed);
    Object.assign(input.candidate.generationBaseline.previousReady.identity, { ino: "999" });
    expect(JSON.stringify(parsed)).toBe(before);
  });
  it("preserves legacy compared-adoption v1 serialized bytes", () => {
    const cold = evidence();
    const legacy: DependencyReadonlyAdoptionEvidence = { version: 1, kind: Kind.ReadonlyLocalAdoptionV1,
      operationId: cold.operationId, workspace: cold.workspace, installation: cold.installation,
      candidate: { jobId: "C", binding: ref("C-binding"), comparison: ref("comparison"), sourceMapping: ref("legacy-source") },
      readonlyCustody: cold.readonlyCustody };
    expect(JSON.stringify(parseDependencyCustodyEvidence(legacy))).toBe(JSON.stringify(legacy));
    denied({ ...legacy, version: 2 });
  });
});
