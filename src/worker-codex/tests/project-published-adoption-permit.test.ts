import { describe, expect, it } from "vitest";
import { openIntegrationAttempt } from "../../worker-core/integration/domain/integration-attempt";
import { input } from "../../worker-core/integration/tests/project-integration-use-cases.fixture";
import { assertPublishedAdoptionPermitAttempt } from "../codex-goal-mcp-project-control-published-adoption";

const permit = {
  schemaVersion: 2 as const,
  projectId: "infinity-context",
  controllerJobId: "infinity-context-controller",
  attemptId: "attempt-1",
  commitSha: "a".repeat(40),
  message: "fix(runtime): adopt exact publication",
  reviewedOutputId: "b".repeat(64),
  reviewedTree: "c".repeat(40),
  patchSha256: "d".repeat(64),
  targetWorkspacePath: "/work/infinity-context-main",
  attestation: {
    provenance: "operator_attestation" as const,
    operator: "iliya", verifiedAt: "2026-10-04T12:00:00.000Z",
    verificationMethod: "authenticated_gh_api" as const,
    repository: "test/synthetic-repository",
    remote: "origin", branch: "main", commitSha: "a".repeat(40),
    evidenceSha256: "e".repeat(64),
  },
};
function attempt() {
  const opened = openIntegrationAttempt({ ...input(), now: "2026-10-04T12:00:00.000Z" });
  return {
    ...opened, checkedReviewedTree: permit.reviewedTree,
    workerOutput: { ...opened.workerOutput, reviewedOutputId: permit.reviewedOutputId,
      patchSha256: permit.patchSha256 },
  };
}

describe("authenticated published-adoption permit bindings", () => {
  it("accepts only the exact controller-owned immutable output", () => {
    expect(() => assertPublishedAdoptionPermitAttempt(permit, attempt(), permit.projectId)).not.toThrow();
  });
  it.each(["projectId", "controllerJobId", "attemptId", "targetWorkspacePath"] as const)(
    "rejects a different %s", (field) => {
      expect(() => assertPublishedAdoptionPermitAttempt(permit, {
        ...attempt(), [field]: "different",
      }, permit.projectId)).toThrow("published_commit_adoption_permit_attempt_mismatch");
    },
  );
  it.each(["reviewedOutputId", "patchSha256"] as const)(
    "rejects a different %s", (field) => {
      const candidate = attempt();
      expect(() => assertPublishedAdoptionPermitAttempt(permit, {
        ...candidate, workerOutput: { ...candidate.workerOutput, [field]: "f".repeat(64) },
      }, permit.projectId)).toThrow("published_commit_adoption_permit_attempt_mismatch");
    },
  );
  it("rejects a different checked tree", () => {
    expect(() => assertPublishedAdoptionPermitAttempt(permit, {
      ...attempt(), checkedReviewedTree: "f".repeat(40),
    }, permit.projectId)).toThrow("published_commit_adoption_permit_attempt_mismatch");
  });
  it("rejects a caller controlling another project", () => {
    expect(() => assertPublishedAdoptionPermitAttempt(permit, attempt(), "other-project"))
      .toThrow("published_commit_adoption_permit_attempt_mismatch");
  });
  it.each(["targetBranch", "targetRemote"] as const)("rejects a different %s", (field) => {
    expect(() => assertPublishedAdoptionPermitAttempt(permit, {
      ...attempt(), [field]: "other",
    }, permit.projectId)).toThrow("published_commit_adoption_permit_attempt_mismatch");
  });
});
