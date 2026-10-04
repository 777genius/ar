import { describe, expect, it } from "vitest";
import {
  IntegrationAttemptStatus, IntegrationAuditEventType, SecretScanStatus,
  adoptPublishedIntegrationCommit, applyWorkerOutput, openProjectIntegrationAttempt,
  runRequiredChecks, pushApprovedCommit, ReviewDecisionStatus, AccessBoundary, createAccessPolicyService,
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
    authorizePublishedAdoption: async () => {},
    reviewedOutputIntegrity: { verify: async () => {} },
    scanner: { scanFiles: async () => ({
      status: SecretScanStatus.Passed, scannedReviewedTree: tree, scannedReviewedParent: parent,
    }) },
  };
  const configured = policy();
  const recordOnlyPolicy = {
    ...configured, access: {
      ...configured.access, scope: { ...configured.access.scope!, allowedGitRemotes: [] },
    },
  };
  const request = { attemptId: opened.attemptId, commitSha: sha, message, attestation, policy: recordOnlyPolicy };
  return { fixture, deps, request, commit };
}

describe("externally published reviewed commit adoption", () => {
  it("records an exact locally inspected commit and consumes the ledger once on replay", async () => {
    const { fixture, deps, request } = await setup();
    const adopted = await adoptPublishedIntegrationCommit(deps, request);
    expect(adopted.status).toBe(IntegrationAttemptStatus.Pushed);
    expect(createAccessPolicyService(request.policy.access).canPushBranch({
      workspacePath: adopted.targetWorkspacePath, branch: adopted.targetBranch,
      remote: adopted.targetRemote,
    }).allowed).toBe(false);
    expect(adopted.externalPublicationAttestation).toEqual(attestation);
    expect(fixture.ledger.finalizeCalls).toBe(1);
    await adoptPublishedIntegrationCommit(deps, request);
    expect(fixture.ledger.finalizeCalls).toBe(2);
    expect(fixture.ledger.prepareCalls).toBe(1);
    expect(fixture.git.calls).not.toContain("push");
    expect(fixture.git.calls).not.toContain("commit");
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

  it("requires a trusted authorizer even when the dependency is absent at runtime", async () => {
    const { fixture, deps, request } = await setup();
    const { authorizePublishedAdoption: _authority, ...untrusted } = deps;
    // External JS callers can omit a dependency despite the TypeScript contract.
    await expect(adoptPublishedIntegrationCommit(
      untrusted as typeof deps, request,
    )).rejects.toThrow("published_commit_adoption_authority_required");
    expect(fixture.ledger.prepareCalls).toBe(0);
    expect(fixture.store.get(request.attemptId)?.status).toBe(IntegrationAttemptStatus.ChecksPassed);
  });

  it("rejects an unauthenticated caller before any durable mutation", async () => {
    const { fixture, deps, request } = await setup();
    deps.authorizePublishedAdoption = async () => { throw new Error("unauthorized_caller"); };
    const before = fixture.store.get(request.attemptId);
    await expect(adoptPublishedIntegrationCommit(deps, request)).rejects.toThrow("unauthorized_caller");
    expect(fixture.store.get(request.attemptId)).toEqual(before);
    expect(fixture.ledger.prepareCalls).toBe(0);
  });

  it.each(["project", "branch", "target", "source", "boundary"] as const)(
    "rejects %s outside controller scope before ledger mutation", async (field) => {
      const { fixture, deps, request } = await setup();
      const scope = { ...request.policy.access.scope!, worktreeRoots: [] };
      if (field === "project") scope.projectId = "different-project";
      if (field === "branch") scope.allowedBranches = ["other"];
      if (field === "target") scope.workspaceRoots = ["/work/infinity-context-child"];
      if (field === "source") scope.workspaceRoots = ["/work/infinity-context-main"];
      const access = { ...request.policy.access, scope,
        ...(field === "boundary" ? { boundary: AccessBoundary.ReadOnly } : {}),
      };
      await expect(adoptPublishedIntegrationCommit(deps, {
        ...request, policy: { ...request.policy, access },
      })).rejects.toThrow(/published_commit_adoption_(authority_required|scope_denied)/);
      expect(fixture.ledger.prepareCalls).toBe(0);
      expect(fixture.store.get(request.attemptId)?.status).toBe(IntegrationAttemptStatus.ChecksPassed);
    },
  );

  it("rejects a different authenticated repository before consuming the ledger", async () => {
    const { fixture, deps, request } = await setup();
    await expect(adoptPublishedIntegrationCommit(deps, {
      ...request, attestation: { ...attestation, repository: "other/repository" },
    })).rejects.toThrow("published_commit_adoption_repository_mismatch");
    expect(fixture.ledger.prepareCalls).toBe(0);
  });

  it.each(["review", "checks", "output"] as const)(
    "requires retained %s evidence before consumption", async (missing) => {
      const { fixture, deps, request } = await setup();
      const attempt = fixture.store.get(request.attemptId)!;
      if (missing === "review") fixture.store.update({ ...attempt,
        reviewDecision: { ...attempt.reviewDecision, decision: ReviewDecisionStatus.Rejected },
      });
      if (missing === "checks") fixture.store.update({ ...attempt, checkRuns: [] });
      if (missing === "output") fixture.store.update({ ...attempt,
        workerOutput: { ...attempt.workerOutput, reviewedOutputId: "" },
      });
      await expect(adoptPublishedIntegrationCommit(deps, request)).rejects.toThrow();
      expect(fixture.ledger.prepareCalls).toBe(0);
      expect(fixture.store.get(request.attemptId)?.status).toBe(IntegrationAttemptStatus.ChecksPassed);
    },
  );

  it("still denies a new push with the same record-only controller", async () => {
    const { fixture, deps, request } = await setup();
    fixture.ledger.finalizeError = new Error("ledger_finalize_failed");
    await expect(adoptPublishedIntegrationCommit(deps, request)).rejects.toThrow("ledger_finalize_failed");
    delete fixture.ledger.finalizeError;
    await expect(pushApprovedCommit(deps, { attemptId: request.attemptId, policy: request.policy }))
      .rejects.toThrow();
    expect(fixture.ledger.finalizeCalls).toBe(1);
    expect(fixture.git.calls).not.toContain("push");
    expect(fixture.store.get(request.attemptId)?.status).toBe(IntegrationAttemptStatus.CommitCreated);
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
