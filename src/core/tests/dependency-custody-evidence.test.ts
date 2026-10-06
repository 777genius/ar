import { describe, expect, it } from "vitest";
import { DependencyCustodyEvidenceKind as Kind, parseDependencyCustodyEvidence, type DependencyProtectedReference,
  type DependencyReadonlyAdoptionEvidence, type DependencyReadonlySuccessorIntent, type DependencyReadonlySuccessorOutput } from "../dependency-environment/dependency-custody-evidence";
const id = "00000000-0000-4000-8000-000000000001";
const ref = (name: string): DependencyProtectedReference => ({ path: "/TEST-protected/" + name + ".json", identity: { dev: "1", ino: "2" }, sha256: "a".repeat(64) });
const workspace = { canonicalPath: "/TEST/C/workspace", dev: "1", ino: "3" };
const installation = { installationId: id, runtimeSha: "b".repeat(40), inventoryDigest: "c".repeat(64) };
const common = { version: 1 as const, operationId: id, workspace, installation };
const adoption: DependencyReadonlyAdoptionEvidence = { ...common, kind: Kind.ReadonlyLocalAdoptionV1,
  candidate: { jobId: "C", binding: ref("C-binding"), comparison: ref("comparison"), sourceMapping: ref("source") },
  readonlyCustody: { jobId: "R", jobRootDir: "/TEST/C", workspacePath: workspace.canonicalPath,
    grant: ref("R-grant"), policy: ref("policy"), review: ref("review"), stage: ref("stage"), lease: ref("lease") } };
const intent: DependencyReadonlySuccessorIntent = { ...common, kind: Kind.ReadonlyLocalSuccessorIntentV1, candidateJobId: "C",
  priorAssociation: ref("association"), priorReady: ref("prior-ready"), addresses: { grant: "/TEST/grant-" + id + ".json",
    binding: "/TEST/binding-" + id + ".json", sourceBody: "/TEST/body-" + id + ".json", transferOutput: "/TEST/transfer-output-" + id + ".json" } };
const output: DependencyReadonlySuccessorOutput = { ...common, kind: Kind.ReadonlyLocalSuccessorOutputV1,
  tree: { dev: "1", ino: "4" }, priorAssociation: ref("association"), priorReady: ref("prior-ready"), intent: ref("intent"),
  grant: ref("grant"), binding: ref("binding"), sourceBody: ref("tagged-body"), manifest: ref("manifest"), toolProfile: ref("profile"),
  terminalProof: ref("actual-terminal"), installKey: "d".repeat(64), closureDigest: "e".repeat(64), manifestDigest: "f".repeat(64),
  generation: "a".repeat(64), coverageRevision: "a".repeat(64) };
// Red if a future address becomes proof, same-job adoption masks authority,
// transfer is relabelled installed, or unknown/secret-bearing data is persisted.
describe("data-only closed readonly-local custody evidence", () => {
  it("preserves distinct R/C identities and original physical root", () => {
    expect(parseDependencyCustodyEvidence(adoption)).toEqual(adoption);
    for (const custody of [ { ...adoption.readonlyCustody, jobId: "C" },
      { ...adoption.readonlyCustody, jobRootDir: "/TEST/R" }, { ...adoption.readonlyCustody, workspacePath: "/TEST/clone/workspace" } ]) {
      expect(() => parseDependencyCustodyEvidence({ ...adoption, readonlyCustody: custody })).toThrow("dependency_custody_evidence:invalid_record");
    }
  });
  it("keeps future addresses strings without a future hash/proof cycle", () => {
    expect(parseDependencyCustodyEvidence(intent)).toEqual(intent);
    for (const addresses of [ { ...intent.addresses, transferOutput: ref("future") },
      { ...intent.addresses, grant: intent.addresses.binding }, { ...intent.addresses, binding: "/TEST/../binding-" + id + ".json" },
      { ...intent.addresses, transferOutput: "/TEST/wrong-operation.json" } ]) {
      expect(() => parseDependencyCustodyEvidence({ ...intent, addresses })).toThrow("dependency_custody_evidence:invalid_record");
    }
    expect(() => parseDependencyCustodyEvidence({ ...intent, transferProof: ref("future") })).toThrow("dependency_custody_evidence:invalid_record");
  });
  it("requires final binding-derived generation and forbids future/installer fields", () => {
    expect(parseDependencyCustodyEvidence(output)).toEqual(output);
    for (const value of [ { ...output, generation: id }, { ...output, coverageRevision: "0".repeat(64) },
      { ...output, ready: ref("future-ready") }, { ...output, sourceWrapper: ref("future-wrapper") },
      { ...output, installerCompletionSha256: "0".repeat(64) }, { ...output, authorized: true } ]) {
      expect(() => parseDependencyCustodyEvidence(value)).toThrow("dependency_custody_evidence:invalid_record");
    }
  });
  it("refuses discriminant/nested accessors without evaluating user code", () => {
    let evaluated = 0;
    function accessor(value: object, key: string) {
      const copy = { ...value };
      Object.defineProperty(copy, key, { enumerable: true, get() { evaluated++; throw new Error("TEST getter must not run"); } });
      return copy;
    }
    for (const value of [ accessor(output, "kind"), { ...output, terminalProof: accessor(output.terminalProof, "path") },
      { ...intent, addresses: accessor(intent.addresses, "grant") } ]) {
      expect(() => parseDependencyCustodyEvidence(value)).toThrow("dependency_custody_evidence:invalid_record");
    }
    expect(evaluated).toBe(0);
  });
  it("rejects malformed/oversized/hidden references with normalized errors and detaches returned bytes", () => {
    const hidden = { ...output }; Object.defineProperty(hidden, "TEST-hidden", { value: true });
    const unsafe = [ { ...output, terminalProof: { ...output.terminalProof, path: "relative" } },
      { ...output, terminalProof: { ...output.terminalProof, path: "/TEST/sk-AAAAAAAAAAAAAAAA" } },
      { ...output, terminalProof: { ...output.terminalProof, identity: { dev: "1", ino: "0" } } }, hidden,
      { ...output, [Symbol("TEST-hidden")]: true }, { ...output, installKey: "g".repeat(64) } ];
    for (const value of unsafe) expect(() => parseDependencyCustodyEvidence(value)).toThrow("dependency_custody_evidence:invalid_record");
    const large = { ...output, ...Object.fromEntries(["priorAssociation", "priorReady", "intent", "grant", "binding", "sourceBody", "manifest", "toolProfile", "terminalProof"].map(name =>
      [name, { ...ref(name), path: "/" + "x".repeat(4000) }])) };
    expect(() => parseDependencyCustodyEvidence(large)).toThrow("dependency_custody_evidence:invalid_record");
    const parsed = parseDependencyCustodyEvidence(adoption);
    expect(parsed).not.toBe(adoption); expect(parsed.workspace).not.toBe(adoption.workspace);
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(adoption));
  });
});
