import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { expect, it } from "vitest";
import { JobRetirementLayoutId, jobRetirementDeletionVerdict, jobRetirementJsonSchema, jobRetirementLayouts, jobRetirementRecordLocationMatches,
  jobRetirementWorkstreamCovers, resolveJobRetirementLayout, validateJobRetirementDocument, type JobRetirementDocument, type ObservedRetirementTarget,
  type RetiredJobRecord, type RetiredWorkstreamRecord } from "../job-retirement/job-retirement-contract";
import { assertJobId } from "../codex-goal-job-manifest-parse-primitives";

// The committed v1 directory is what the host retention tool consumes. Regenerate
// it with UPDATE_JOB_RETIREMENT_CONTRACT=1 after a deliberate contract change.
const root = fileURLToPath(new URL("../../../host-integration/job-retirement/v1/", import.meta.url));
const generated = { "schema.json": jobRetirementJsonSchema(), "layouts.json": jobRetirementLayouts };
const read = (name: string): unknown => JSON.parse(readFileSync(join(root, name), "utf8"));
type Cases = { documents: { file: string; valid: boolean; reason?: string }[];
  deletion: { name: string; file: string; observed: ObservedRetirementTarget; verdict: string }[];
  locations: { file: string; path: string; matches: boolean }[];
  workstreamCoverage: { name: string; workstream: string; tombstones: Record<string, string>; covers: boolean }[] };
const cases = read("fixtures/cases.json") as Cases;

it("keeps the committed schema and layouts equal to the runtime contract", () => {
  for (const [name, value] of Object.entries(generated)) {
    if (process.env.UPDATE_JOB_RETIREMENT_CONTRACT === "1") writeFileSync(join(root, name), JSON.stringify(value, null, 2) + "\n");
    expect(read(name), name).toEqual(JSON.parse(JSON.stringify(value)));
  }
});
it("accepts every valid fixture and rejects every invalid one with its rule", () => {
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(read("schema.json") as object);
  expect(cases.documents.filter(row => row.valid).length).toBeGreaterThanOrEqual(10);
  for (const row of cases.documents) {
    const document = read("fixtures/" + row.file), verdict = validateJobRetirementDocument(document);
    // Structural refusals must fail the JSON Schema too; semantic ones pass it on purpose.
    expect(validate(document), row.file).toBe(row.valid || row.reason !== "schema");
    expect(verdict, row.file).toEqual(row.valid ? { ok: true, document } : { ok: false, reason: row.reason });
  }
});
it("decides deletion by tombstone scope and exact directory identity", () => {
  for (const row of cases.deletion) {
    const document = read("fixtures/" + row.file) as RetiredJobRecord | RetiredWorkstreamRecord;
    expect(jobRetirementDeletionVerdict(document, row.observed), row.name).toBe(row.verdict);
  }
});
it("accepts a record only at the path its layout gives it", () => {
  for (const row of cases.locations)
    expect(jobRetirementRecordLocationMatches(row.path, read("fixtures/" + row.file) as JobRetirementDocument), row.path).toBe(row.matches);
});
it("checks that a workstream tombstone covers exactly its job tombstones", () => {
  const digest = (file: string) => createHash("sha256").update(readFileSync(join(root, "fixtures", file))).digest("hex");
  for (const row of cases.workstreamCoverage) {
    const tombstones = new Map(Object.entries(row.tombstones).map(([jobId, file]) => [jobId, digest(file)]));
    expect(jobRetirementWorkstreamCovers(read("fixtures/" + row.workstream) as RetiredWorkstreamRecord, tombstones), row.name).toBe(row.covers);
  }
});
it("uses the job ID rule of the job registry", () => {
  const pattern = new RegExp(jobRetirementLayouts.jobIdPattern);
  for (const id of ["a", "job-1", "A.b_c-9", "x".repeat(100), "x".repeat(101), "-a", ".a", "a/b", "a b", ""]) {
    let registry = true; try { assertJobId(id); } catch { registry = false; }
    expect(pattern.test(id), id).toBe(registry);
  }
});
it("resolves the three registry layouts and nothing else", () => {
  expect(resolveJobRetirementLayout("/srv/worker-state/jobs/p/w/registry")).toMatchObject({ id: JobRetirementLayoutId.ProjectWorkstream,
    projectId: "p", workstreamId: "w", stateDir: "/srv/worker-state/jobs/p/w", scratchRoot: "/srv/workers/jobs/p/w" });
  expect(resolveJobRetirementLayout("/srv/worker-state/jobs/w/registry")).toMatchObject({ id: JobRetirementLayoutId.FlatWorkstream,
    workstreamId: "w", stateDir: "/srv/worker-state/jobs/w", scratchRoot: "/srv/workers/jobs/w" });
  expect(resolveJobRetirementLayout("/srv/worker-state/mimo-projects/p/w/registry")).toMatchObject({ id: JobRetirementLayoutId.MimoWorkstream,
    stateDir: "/srv/worker-state/mimo-projects/p/w", scratchRoot: "/srv/workers/mimo-projects/p/w" });
  for (const path of ["/srv/worker-state/jobs/registry", "/srv/worker-state/jobs/p/w/x/registry", "/srv/worker-state/mimo-projects/P/w/registry",
    "/srv/worker-state/mimo-projects/p/registry", "/srv/worker-state/jobs/p/w/registry/", "/var/lib/jobs/p/w/registry"])
    expect(resolveJobRetirementLayout(path), path).toBeUndefined();
});
