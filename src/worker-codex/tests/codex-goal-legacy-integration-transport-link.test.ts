import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CheckRunStatus, IntegrationAttemptStatus, PushAttemptStatus,
  ReviewDecisionStatus, SecretScanStatus,
  type ConsumedOutputLedger, type IntegrationAttempt,
} from "@vioxen/subscription-runtime/worker-core";
import {
  linkLegacyIntegrationTransport, verifiedLegacyTransportLinkAttemptIds,
} from "../application/project-control/codex-goal-legacy-integration-transport-link";

const commitSha = "f".repeat(40);
const patchSha256 = "e".repeat(64);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("legacy integration transport link", () => {
  it("links only an exact adopted commit and consumed ledger without rewriting old evidence", async () => {
    const fixture = await setup();
    const before = await readFile(fixture.oldPath);
    const linked = await linkLegacyIntegrationTransport(fixture.input);
    expect(linked.receipt.commitSha).toBe(commitSha);
    expect(await readFile(fixture.oldPath)).toEqual(before);
    expect([...await verifiedLegacyTransportLinkAttemptIds({
      controllerJobRootDir: fixture.root, controllerJobId: "controller",
      projectId: "project", ledger: fixture.input.ledger,
    })]).toEqual(["old"]);
  });

  it.each([
    ["wrong commit", (f: Awaited<ReturnType<typeof setup>>) =>
      ({ ...f.input, commitSha: "a".repeat(40) })],
    ["wrong ledger commit", (f: Awaited<ReturnType<typeof setup>>) =>
      ({ ...f.input, ledger: ledger("a".repeat(40)) })],
  ] as const)("refuses %s before publishing", async (_name, change) => {
    const fixture = await setup();
    await expect(linkLegacyIntegrationTransport(change(fixture)))
      .rejects.toThrow();
    const receiptPath = join(fixture.root, "project-integration",
      "legacy-transport-links", `${hash("old")}.json`);
    await expect(readFile(receiptPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a different adopted patch despite both matching file hashes", async () => {
    const fixture = await setup({ adoptedPatchSha256: "d".repeat(64) });
    await expect(linkLegacyIntegrationTransport(fixture.input))
      .rejects.toThrow("legacy_integration_transport_link_evidence_mismatch");
  });

  it("replays the same receipt after publication and rejects changed evidence without ledger writes", async () => {
    const fixture = await setup();
    const first = await linkLegacyIntegrationTransport(fixture.input);
    const receiptBefore = await readFile(first.path);
    const second = await linkLegacyIntegrationTransport(fixture.input);
    expect(second).toEqual(first);
    expect(await readFile(first.path)).toEqual(receiptBefore);
    expect(await readdir(join(fixture.root, "project-integration",
      "legacy-transport-links"))).toHaveLength(1);
    const adopted = JSON.parse(await readFile(fixture.adoptedPath, "utf8")) as IntegrationAttempt;
    await writeFile(fixture.adoptedPath, `${JSON.stringify({ ...adopted, updatedAt: "later" })}\n`);
    await expect(linkLegacyIntegrationTransport(fixture.input))
      .rejects.toThrow("legacy_integration_transport_link_attempt_cas_mismatch");
    await expect(verifiedLegacyTransportLinkAttemptIds({
      controllerJobRootDir: fixture.root, controllerJobId: "controller",
      projectId: "project", ledger: fixture.input.ledger,
    })).rejects.toThrow("legacy_integration_transport_link_attempt_cas_mismatch");
    expect(await readFile(first.path)).toEqual(receiptBefore);
  });

  it("keeps the link valid when an exact ledger record moves to a new root", async () => {
    const fixture = await setup();
    const linked = await linkLegacyIntegrationTransport(fixture.input);
    const migratedLedger = ledger(commitSha, "/new-ledger/items/worker--adopted.json");
    expect([...await verifiedLegacyTransportLinkAttemptIds({
      controllerJobRootDir: fixture.root, controllerJobId: "controller",
      projectId: "project", ledger: migratedLedger,
    })]).toEqual(["old"]);
    expect(await readFile(linked.path, "utf8")).not.toContain("/test/ledger");
  });

  it.each(["project-integration", "integration-attempts"] as const)(
    "rejects a symlinked %s ancestor before reading or publishing",
    async (component) => {
      const fixture = await setup();
      const parent = component === "project-integration"
        ? fixture.root : join(fixture.root, "project-integration");
      const original = join(parent, component);
      const saved = join(parent, `${component}-saved`);
      await rename(original, saved);
      await symlink(saved, original);
      await expect(linkLegacyIntegrationTransport(fixture.input))
        .rejects.toThrow("legacy_integration_transport_link_directory_invalid");
      const receiptPath = join(fixture.root, "project-integration",
        "legacy-transport-links", `${hash("old")}.json`);
      await expect(readFile(receiptPath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("does not publish through a symlinked receipt directory", async () => {
    const fixture = await setup();
    const outside = await mkdtemp(join(tmpdir(), "legacy-link-outside-"));
    roots.push(outside);
    await symlink(outside, join(fixture.root, "project-integration",
      "legacy-transport-links"));
    await expect(linkLegacyIntegrationTransport(fixture.input))
      .rejects.toThrow("legacy_integration_transport_link_directory_invalid");
    expect(await readdir(outside)).toEqual([]);
  });

  it("refuses a noncanonical second directory with the linked old attempt ID", async () => {
    const fixture = await setup();
    await linkLegacyIntegrationTransport(fixture.input);
    const shadow = join(fixture.root, "project-integration",
      "integration-attempts", "shadow-noncanonical");
    await mkdir(shadow);
    const old = JSON.parse(await readFile(fixture.oldPath, "utf8")) as IntegrationAttempt;
    await writeFile(join(shadow, "attempt.json"), JSON.stringify({
      ...old, status: IntegrationAttemptStatus.Opened,
    }));
    await expect(verifiedLegacyTransportLinkAttemptIds({
      controllerJobRootDir: fixture.root, controllerJobId: "controller",
      projectId: "project", ledger: fixture.input.ledger,
    })).rejects.toThrow("legacy_integration_transport_link_attempt_binding_invalid");
  });

  it("refuses a mismatched old file set even with matching CAS hashes", async () => {
    const fixture = await setup({ oldFiles: ["other.ts"] });
    await expect(linkLegacyIntegrationTransport(fixture.input))
      .rejects.toThrow("legacy_integration_transport_link_evidence_mismatch");
  });
});

async function setup(options: { readonly oldFiles?: readonly string[];
  readonly adoptedPatchSha256?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), "legacy-link-test-"));
  roots.push(root);
  const common = {
    projectId: "project", controllerJobId: "controller", workerJobId: "worker",
    sourceWorkspacePath: "/test/worker", targetWorkspacePath: "/test/target",
    targetRemote: "origin", targetBranch: "main", expectedFiles: ["file.ts"],
    reviewDecision: { reviewedBy: "owner", decision: ReviewDecisionStatus.Approved,
      reason: "reviewed", approvedFiles: ["file.ts"], requiredChecks: [] },
    createdAt: "2026-09-28T00:00:00.000Z",
    updatedAt: "2026-09-28T00:00:00.000Z",
  };
  const output = { workerJobId: "worker", workspacePath: "/test/worker",
    baseCommit: "a".repeat(40), targetCommit: "a".repeat(40),
    patchSha256, changedFiles: ["file.ts"] };
  const old: IntegrationAttempt = { ...common, attemptId: "old",
    status: IntegrationAttemptStatus.ChecksPassed,
    workerOutput: output, checkRuns: [] };
  const adopted: IntegrationAttempt = { ...common, attemptId: "adopted",
    status: IntegrationAttemptStatus.Pushed,
    workerOutput: { ...output,
      patchSha256: options.adoptedPatchSha256 ?? patchSha256,
      reviewedOutputId: "reviewed-id",
      reviewedOutputFileByteAllowance: 1024 },
    checkedReviewedTree: "b".repeat(40),
    checkRuns: [{ checkId: "test", command: ["true"], status: CheckRunStatus.Passed,
      startedAt: common.createdAt, completedAt: common.updatedAt, exitCode: 0 }],
    commitCandidate: { commitSha, message: "fix: exact", files: ["file.ts"],
      secretScanStatus: SecretScanStatus.Passed, createdAt: common.createdAt },
    pushAttempt: { remote: "origin", branch: "main", commitSha,
      status: PushAttemptStatus.Pushed, pushedAt: common.updatedAt },
    externalPublicationAttestation: { provenance: "operator_attestation",
      operator: "owner", verifiedAt: common.updatedAt,
      verificationMethod: "authenticated_gh_api", repository: "owner/repo",
      remote: "origin", branch: "main", commitSha, evidenceSha256: "c".repeat(64) },
  };
  const oldValue = options.oldFiles
    ? { ...old, expectedFiles: options.oldFiles, reviewDecision: {
        ...old.reviewDecision, approvedFiles: options.oldFiles },
      workerOutput: { ...old.workerOutput, changedFiles: options.oldFiles } }
    : old;
  const oldPath = await writeAttempt(root, oldValue);
  const adoptedPath = await writeAttempt(root, adopted);
  return { root, oldPath, adoptedPath, input: {
    controllerJobRootDir: root, controllerJobId: "controller", projectId: "project",
    oldAttemptId: "old", expectedOldAttemptSha256: hash(await readFile(oldPath)),
    adoptedAttemptId: "adopted",
    expectedAdoptedAttemptSha256: hash(await readFile(adoptedPath)),
    commitSha, ledger: ledger(commitSha),
  } };
}

async function writeAttempt(root: string, attempt: IntegrationAttempt): Promise<string> {
  const path = join(root, "project-integration", "integration-attempts",
    hash(attempt.attemptId), "attempt.json");
  await mkdir(join(root, "project-integration", "integration-attempts",
    hash(attempt.attemptId)), { recursive: true });
  await writeFile(path, `${JSON.stringify(attempt)}\n`);
  return path;
}

function ledger(sha: string, path = "/test/ledger/item.json"): ConsumedOutputLedger {
  return { byJobId: new Map([["worker", { jobId: "worker", attemptId: "adopted",
    status: "integrated", ledgerPath: path, commitSha: sha,
    workspace: "/test/worker",
    hasAuthoredOutput: true, valid: true, evidence: [] }]]),
    byWorkspace: new Map(), debt: [] };
}

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
