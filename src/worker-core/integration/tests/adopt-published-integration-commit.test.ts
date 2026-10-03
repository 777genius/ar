import { describe, expect, it } from "vitest";
import {
  IntegrationAttemptStatus, IntegrationAuditEventType, SecretScanStatus,
  adoptPublishedIntegrationCommit, applyWorkerOutput, openProjectIntegrationAttempt,
  runRequiredChecks,
} from "../../index";
import { createFixture, input, policy } from "./project-integration-use-cases.fixture";

const parent = "a".repeat(40);
const tree = "b".repeat(40);
const sha = "c".repeat(40);
const reviewedOutputId = "d".repeat(64);
const attestation = {
  provenance: "operator_attestation" as const,
  operator: "iliya",
  verifiedAt: "2026-09-28T12:00:00.000Z",
  verificationMethod: "authenticated_gh_api" as const,
  repository: "vioxen/subscription-runtime",
  remote: "origin",
  branch: "main",
  commitSha: sha,
  evidenceSha256: "e".repeat(64),
};
const message = "fix(runtime): integrate reviewed output";

async function setup() {
  const fixture = createFixture({ clockNow: () => new Date("2026-09-28T12:00:10.000Z") });
  const opened = await openProjectIntegrationAttempt(fixture.deps(), input());
  const applied = await applyWorkerOutput(fixture.deps(), { attemptId: opened.attemptId });
  const checked = await runRequiredChecks(fixture.deps(), { attemptId: applied.attemptId });
  fixture.store.update({
    ...checked,
    checkedReviewedTree: tree,
    workerOutput: {
      ...checked.workerOutput,
      reviewedOutputId,
      reviewedOutputFileByteAllowance: 1024,
      baseCommit: parent,
      patchPath: "/evidence/reviewed.patch",
      patchSha256: "f".repeat(64),
    },
  });
  fixture.git.dirtyFiles = [];
  const commit = {
    commitSha: sha, tree, parentCommits: [parent],
    author: { name: "Approved Integrator", email: "integrator@example.com" },
    committer: { name: "Approved Integrator", email: "integrator@example.com" },
    message, files: ["src/memory.ts"],
  };
  const git = Object.assign(fixture.git, {
    currentHead: async () => parent,
    remoteRepository: async () => "vioxen/subscription-runtime",
    reviewedOutputTreeFromPatch: async () => tree,
    inspectIntegrationCommit: async () => commit,
  });
  const deps = {
    ...fixture.deps(), git,
    reviewedOutputIntegrity: { verify: async () => {} },
    scanner: { scanFiles: async () => ({
      status: SecretScanStatus.Passed, scannedReviewedTree: tree, scannedReviewedParent: parent,
    }) },
  };
  const request = { attemptId: opened.attemptId, commitSha: sha, message, attestation, policy: policy() };
  return { fixture, deps, request, commit };
}

describe("externally published reviewed commit adoption", () => {
  it("records an exact locally inspected commit and consumes the ledger once on replay", async () => {
    const { fixture, deps, request } = await setup();
    const adopted = await adoptPublishedIntegrationCommit(deps, request);
    expect(adopted.status).toBe(IntegrationAttemptStatus.Pushed);
    expect(adopted.externalPublicationAttestation).toEqual(attestation);
    expect(fixture.ledger.finalizeCalls).toBe(1);
    await adoptPublishedIntegrationCommit(deps, request);
    expect(fixture.ledger.finalizeCalls).toBe(2);
    expect(fixture.ledger.prepareCalls).toBe(1);
    expect(fixture.events.filter((event) => event.type === IntegrationAuditEventType.ExternalCommitAdopted)).toHaveLength(1);
    expect(fixture.events.filter((event) => event.type === IntegrationAuditEventType.Pushed)).toHaveLength(1);
  });

  it.each([
    ["tree", { tree: "0".repeat(40) }],
    ["parent", { parentCommits: ["0".repeat(40)] }],
    ["files", { files: ["src/other.ts"] }],
    ["owner", { author: { name: "Other", email: "other@example.com" } }],
    ["message", { message: "fix(test): different message" }],
  ])("rejects a different %s before consuming the ledger", async (_label, changed) => {
    const { fixture, deps, request, commit } = await setup();
    deps.git.inspectIntegrationCommit = async () => ({ ...commit, ...changed });
    await expect(adoptPublishedIntegrationCommit(deps, request)).rejects.toThrow("published_commit_adoption_commit_mismatch");
    expect(fixture.ledger.prepareCalls).toBe(0);
    expect(fixture.store.get(request.attemptId)?.status).toBe(IntegrationAttemptStatus.ChecksPassed);
  });

  it("rejects a failed immutable-tree secret scan before ledger mutation", async () => {
    const { fixture, deps, request } = await setup();
    deps.scanner.scanFiles = async () => ({
      status: SecretScanStatus.Failed, scannedReviewedTree: tree, scannedReviewedParent: parent,
    });
    await expect(adoptPublishedIntegrationCommit(deps, request)).rejects.toThrow("published_commit_adoption_secret_scan_failed");
    expect(fixture.ledger.prepareCalls).toBe(0);
  });

  it("rejects a stale operator observation before consuming the ledger", async () => {
    const { fixture, deps, request } = await setup();
    await expect(adoptPublishedIntegrationCommit(deps, {
      ...request, attestation: { ...attestation, verifiedAt: "2026-09-28T11:00:00.000Z" },
    })).rejects.toThrow("published_commit_adoption_attestation_stale");
    expect(fixture.ledger.prepareCalls).toBe(0);
  });

  it("resumes after ledger finalization failure without changing the candidate", async () => {
    const { fixture, deps, request } = await setup();
    fixture.ledger.finalizeError = new Error("ledger_finalize_failed");
    await expect(adoptPublishedIntegrationCommit(deps, request)).rejects.toThrow("ledger_finalize_failed");
    expect(fixture.store.get(request.attemptId)?.status).toBe(IntegrationAttemptStatus.CommitCreated);
    delete fixture.ledger.finalizeError;
    const recovered = await adoptPublishedIntegrationCommit(deps, request);
    expect(recovered.status).toBe(IntegrationAttemptStatus.Pushed);
    expect(fixture.ledger.prepareCalls).toBe(1);
    await expect(adoptPublishedIntegrationCommit(deps, {
      ...request, attestation: { ...attestation, evidenceSha256: "0".repeat(64) },
    })).rejects.toThrow("published_commit_adoption_replay_conflict");
  });

  it("refuses a terminal replay when its immutable preparation is missing", async () => {
    const { fixture, deps, request } = await setup();
    await adoptPublishedIntegrationCommit(deps, request);
    Object.assign(fixture.ledger, { readPrepared: async () => undefined });
    await expect(adoptPublishedIntegrationCommit(deps, request))
      .rejects.toThrow("published_commit_adoption_preparation_missing");
    expect(fixture.ledger.prepareCalls).toBe(1);
  });
});
