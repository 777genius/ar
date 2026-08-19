import { describe, expect, it, vi } from "vitest";
import {
  ProjectDebtReason,
  type ConsumedOutputLedgerEpochPlan,
  type ProjectAdmissionSnapshot,
  type ProjectDebtItem,
} from "@vioxen/subscription-runtime/worker-core";
import {
  buildSocialProposedAdmissionAnchor,
  createOrVerifySocialProposedAdmissionAnchor,
  LEDGER_EPOCH_PROPOSED_ADMISSION_SIDECAR,
  normalizeAnchoredProposedAdmission,
  readSocialProposedAdmissionAnchor,
  SOCIAL_PROPOSED_ADMISSION_PLAN_SHA256,
  type LedgerEpochProposedAdmissionAnchor,
  verifySocialProposedAdmissionAnchorEvidence,
} from "../application/project-control/codex-goal-ledger-epoch-proposed-admission";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifySocialPreparedV1SourceOrphanSeal } from
  "../application/project-control/codex-goal-ledger-epoch-proposed-admission";
import { assertConsumedOutputLedgerEpochAdmissionTransition } from
  "../application/project-control/codex-goal-ledger-epoch-admission-transition";
import { verifyConsumedOutputLedgerEpochProposedAdmissionAnchor } from
  "../application/project-control/codex-goal-consumed-output-ledger-epoch";

const virtualFs = vi.hoisted(() => ({
  files: new Map<string, Buffer>(),
  directories: new Map<string, readonly string[]>(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (path: Parameters<typeof actual.readFile>[0], options?: unknown) => {
      const bytes = virtualFs.files.get(String(path));
      if (!bytes) return await actual.readFile(path, options as never);
      return typeof options === "string" ? bytes.toString(options as BufferEncoding) : bytes;
    },
    readdir: async (path: Parameters<typeof actual.readdir>[0], options?: unknown) => {
      const names = virtualFs.directories.get(String(path));
      if (!names) return await actual.readdir(path, options as never);
      return names.map((name) => ({
        name,
        isDirectory: () => true,
        isSymbolicLink: () => false,
      }));
    },
  };
});

describe("Social prepared-v1 proposed-admission anchor", () => {
  it("accepts the stable proposed counts and rejects stale or inexact counts", () => {
    expect(() => assertConsumedOutputLedgerEpochAdmissionTransition({
      plan: plan(), before: { debtCount: 1110 }, proposed: proposedSummary(),
    })).not.toThrow();
    expect(() => assertConsumedOutputLedgerEpochAdmissionTransition({
      plan: plan(), before: { debtCount: 1110 }, proposed: {
        ...proposedSummary(), debtCount: 2449,
      },
    })).toThrow("ledger_epoch_proposed_admission_summary_mismatch");
    expect(() => assertConsumedOutputLedgerEpochAdmissionTransition({
      plan: plan(), before: { debtCount: 1110 }, proposed: {
        ...proposedSummary(), debtCount: 2447,
        counts: { ...proposedSummary().counts, unconsumedCompletedJobs: 493 },
      },
    })).toThrow("ledger_epoch_proposed_admission_summary_mismatch");
    expect(() => assertConsumedOutputLedgerEpochAdmissionTransition({
      plan: plan(), before: { debtCount: 1110 }, proposed: {
        ...proposedSummary(),
        counts: { ...proposedSummary().counts, unconsumedCompletedJobs: 493 },
      },
    })).toThrow("ledger_epoch_proposed_admission_summary_mismatch");
    expect(() => assertConsumedOutputLedgerEpochAdmissionTransition({
      plan: plan(), before: { debtCount: 1109 }, proposed: proposedSummary(),
    })).toThrow("ledger_epoch_proposed_admission_before_mismatch");
    expect(() => assertConsumedOutputLedgerEpochAdmissionTransition({
      plan: plan(), before: { debtCount: 1110 }, proposed: {
        ...proposedSummary(),
        counts: { ...proposedSummary().counts, unreadableWorkspaces: 1 },
        debtCount: 2449,
      },
    })).toThrow("ledger_epoch_proposed_admission_summary_mismatch");
  });

  it("rejects missing and forged structural direct-apply authority", async () => {
    await expect(verifyConsumedOutputLedgerEpochProposedAdmissionAnchor({
      plan: plan(),
    })).rejects.toThrow("ledger_epoch_proposed_admission_verified_anchor_required");

    await expect(verifyConsumedOutputLedgerEpochProposedAdmissionAnchor({
      plan: plan(),
      expectedProposedAdmissionAnchorSha256: "a".repeat(64),
    } as Parameters<typeof verifyConsumedOutputLedgerEpochProposedAdmissionAnchor>[0] &
      { readonly expectedProposedAdmissionAnchorSha256: string })).rejects.toThrow(
      "ledger_epoch_proposed_admission_anchor_missing",
    );
  });

  it("rejects a caller-supplied no-op verifier as direct-apply authority", async () => {
    await expect(verifyConsumedOutputLedgerEpochProposedAdmissionAnchor({
      plan: plan(),
      expectedProposedAdmissionAnchorSha256: "a".repeat(64),
      verifyProposedAdmissionAnchor: async () => {},
    } as Parameters<typeof verifyConsumedOutputLedgerEpochProposedAdmissionAnchor>[0] & {
      readonly verifyProposedAdmissionAnchor: () => Promise<void>;
    })).rejects.toThrow("ledger_epoch_proposed_admission_anchor_missing");
  });

  it("downgrades only exact anchored debt and allows anchored debt to disappear", () => {
    const first = debt(ProjectDebtReason.UnconsumedCompletedJob, "job-1");
    const second = debt(ProjectDebtReason.OrphanLegacyWorkspace, "/work/orphan-1");
    const anchor = anchorFor([first, second]);

    expect(normalizeAnchoredProposedAdmission({
      anchor,
      snapshot: snapshot([first]),
    }).debt).toEqual([{ ...first, severity: "info" }]);

    expect(normalizeAnchoredProposedAdmission({
      anchor,
      snapshot: snapshot([]),
    }).debt).toEqual([]);

    expect(() => normalizeAnchoredProposedAdmission({
      anchor,
      snapshot: snapshot([{ ...first, evidence: ["changed"] }]),
    })).toThrow("ledger_epoch_proposed_admission_new_or_changed_debt");

    expect(() => normalizeAnchoredProposedAdmission({
      anchor,
      snapshot: snapshot([
        first,
        debt(ProjectDebtReason.UnconsumedCompletedJob, "new-job"),
      ]),
    })).toThrow("ledger_epoch_proposed_admission_new_or_changed_debt");

    expect(() => normalizeAnchoredProposedAdmission({
      anchor,
      snapshot: snapshot([{
        ...debt(ProjectDebtReason.LegacyOutputQuarantineRequired, "new-info"),
        severity: "info",
      }]),
    })).toThrow("ledger_epoch_proposed_admission_new_or_changed_debt");

    expect(() => normalizeAnchoredProposedAdmission({
      anchor,
      snapshot: snapshot([
        debt(ProjectDebtReason.UnreadableWorkspace, "/new/unreadable"),
      ]),
    })).toThrow("ledger_epoch_proposed_admission_unreadable_workspace_blocked");
  });

  it("preserves the exact post-activation integrated ledger item as info", () => {
    const item = postActivationConsumedDirtyWorkspace();

    expect(normalizeAnchoredProposedAdmission({
      anchor: anchorFor([]),
      snapshot: snapshot([item]),
    })).toMatchObject({
      debt: [item],
      counts: { consumedDirtyWorkspaces: 1 },
    });
  });

  it("preserves the exact post-activation rejected ledger item as info", () => {
    const item = postActivationRejectedConsumedDirtyWorkspace();

    expect(normalizeAnchoredProposedAdmission({
      anchor: anchorFor([]),
      snapshot: snapshot([item]),
    })).toMatchObject({
      debt: [item],
      counts: { consumedDirtyWorkspaces: 1 },
    });
  });

  it("rejects every inexact post-activation consumed workspace item", () => {
    const exact = postActivationConsumedDirtyWorkspace();
    const rejected = postActivationRejectedConsumedDirtyWorkspace();
    const cases: readonly ProjectDebtItem[] = [
      { ...exact, severity: "blocking" },
      { ...exact, severity: "warning" },
      { ...exact, reason: ProjectDebtReason.LegacyOutputQuarantineRequired },
      { ...exact, evidence: ["dirty output consumed by terminal ledger status: failed",
        exact.evidence[1]!, exact.evidence[2]!] },
      { ...exact, evidence: [exact.evidence[0]!, "ledger: relative/item.json",
        exact.evidence[2]!] },
      { ...exact, evidence: [exact.evidence[0]!, "ledger: /ledger/v2/items/../item.json",
        exact.evidence[2]!] },
      { ...exact, evidence: [exact.evidence[0]!, "ledger: /ledger/v2/items",
        exact.evidence[2]!] },
      { ...exact, evidence: [exact.evidence[0]!, "ledger: /ledger/v2/other/item.json",
        exact.evidence[2]!] },
      { ...exact, evidence: [exact.evidence[0]!, exact.evidence[1]!, "commit: abc123"] },
      { ...exact, evidence: [...exact.evidence, "extra"] },
      { ...rejected, severity: "blocking" },
      { ...rejected, severity: "warning" },
      { ...rejected, reason: ProjectDebtReason.LegacyOutputQuarantineRequired },
      ...["failed", "duplicate", "superseded", "archived", "reviewed_no_change"]
        .map((status): ProjectDebtItem => ({ ...rejected, evidence: [
          `dirty output consumed by terminal ledger status: ${status}`,
          rejected.evidence[1]!,
        ] })),
      { ...rejected, evidence: [rejected.evidence[0]!] },
      { ...rejected, evidence: [rejected.evidence[0]!,
        "ledger: relative/item.json"] },
      { ...rejected, evidence: [rejected.evidence[0]!,
        "ledger: /ledger/v2/items/../item.json"] },
      { ...rejected, evidence: [rejected.evidence[0]!, "ledger: /ledger/v2/items"] },
      { ...rejected, evidence: [rejected.evidence[0]!,
        "ledger: /ledger/v2/other/item.json"] },
      { ...rejected, evidence: [...rejected.evidence, "commit: abc1234"] },
      { ...rejected, evidence: [...rejected.evidence, "extra"] },
    ];

    for (const item of cases) {
      expect(() => normalizeAnchoredProposedAdmission({
        anchor: anchorFor([]), snapshot: snapshot([item]),
      })).toThrow("ledger_epoch_proposed_admission_new_or_changed_debt");
    }

    expect(() => normalizeAnchoredProposedAdmission({
      anchor: anchorFor([exact]),
      snapshot: snapshot([{ ...exact, evidence: [
        exact.evidence[0]!, exact.evidence[1]!, "commit: 7654321",
      ] }]),
    })).toThrow("ledger_epoch_proposed_admission_new_or_changed_debt");

  });

  it("blocks a generic unreadable item even inside the exact count envelope", async () => {
    const blocking = [
      ...many(ProjectDebtReason.UnconsumedCompletedJob, 495),
      ...many(ProjectDebtReason.OrphanLegacyWorkspace, 205),
      ...many(ProjectDebtReason.ActiveWriterConflict, 6),
      ...many(ProjectDebtReason.InactiveDirtyWorkspace, 4),
      {
        ...debt(ProjectDebtReason.UnreadableWorkspace, "/unrelated/unreadable"),
        evidence: [
          "mentions social-monitor-x-attribution-reuse-fixture-integration-v1-20260719",
        ],
      },
    ];
    const info = Array.from({ length: 1738 }, (_, index) => ({
      ...debt(ProjectDebtReason.LegacyOutputQuarantineRequired, `info-${index}`),
      severity: "info" as const,
    }));
    await expect(createOrVerifySocialProposedAdmissionAnchor({
      plan: plan(),
      snapshot: snapshot([...blocking, ...info]),
      controllerJobRootDir: "/controller",
      debtCustody: [],
      sourceOrphanSeal: {
        bindings: Array.from({ length: 205 }, (_, index) => ({ index })),
        bindingSha256: Array.from({ length: 205 }, () => "f".repeat(64)),
        bindingsSha256: "c".repeat(64),
      },
      expectedAnchorSha256: "a".repeat(64),
    })).rejects.toThrow("ledger_epoch_proposed_admission_unreadable_workspace_blocked");
  });

  it("binds exact immutable plan, archive, and pushed-attempt lineage", async () => {
    const fixture = await historicalLineageFixture();
    try {
      const anchor = await buildSocialProposedAdmissionAnchor(fixture.input);
      expect(anchor?.historicalAlias).toMatchObject({
        targetWorkspacePath:
          "/var/data/social-monitor/worktrees/social-monitor-x-attribution-reuse-fixture-integration-v1-20260719",
        attemptId: "social-monitor-x-attribution-reuse-fixture-integration-20260719-001",
        commitSha: "6c0129f655a056da0832355c5f8733a4e1daa4ff",
      });
      await expect(verifySocialProposedAdmissionAnchorEvidence(anchor!)).resolves.toBeUndefined();
    } finally {
      await fixture.cleanup();
    }
  });

  it("accepts exactly 506 sealed plan source records and rejects inexact shapes", async () => {
    const fixture = await historicalLineageFixture();
    try {
      const anchor = (await buildSocialProposedAdmissionAnchor(fixture.input))!;
      const sidecar = join(fixture.input.plan.newRoot,
        LEDGER_EPOCH_PROPOSED_ADMISSION_SIDECAR);
      await mkdir(sidecar);
      const assertCandidate = async (count: number, accepted: boolean) => {
        const candidate = anchorWithSourceRecordCount(anchor, count);
        await writeFile(join(sidecar, "anchor.json"), JSON.stringify(candidate));
        await writeFile(join(sidecar, "expected-anchor-sha256"), candidate.anchorSha256);
        const result = expect(readSocialProposedAdmissionAnchor(
          fixture.input.plan, candidate.anchorSha256));
        if (accepted) await result.resolves.toEqual(candidate);
        else await result.rejects.toThrow(
          "ledger_epoch_proposed_admission_anchor_shape_invalid");
      };

      await assertCandidate(506, true);
      await assertCandidate(205, false);
      await assertCandidate(505, false);
      await assertCandidate(507, false);
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects tampered historical archive or pushed-attempt bytes", async () => {
    const fixture = await historicalLineageFixture();
    try {
      const anchor = (await buildSocialProposedAdmissionAnchor(fixture.input))!;
      for (const path of [fixture.statusPath, fixture.attemptPath]) {
        const original = virtualFs.files.get(path)!;
        virtualFs.files.set(path, Buffer.concat([original, Buffer.from(" ")]));
        await expect(verifySocialProposedAdmissionAnchorEvidence(anchor)).rejects.toThrow(
          "ledger_epoch_proposed_admission_alias_lineage_drift",
        );
        virtualFs.files.set(path, original);
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects missing or duplicate pushed attempts", async () => {
    const fixture = await historicalLineageFixture();
    try {
      virtualFs.directories.set(fixture.attemptsRoot, []);
      await expect(buildSocialProposedAdmissionAnchor(fixture.input)).rejects.toThrow(
        "ledger_epoch_proposed_admission_alias_evidence_mismatch",
      );
      virtualFs.directories.set(fixture.attemptsRoot, ["attempt-1", "attempt-2"]);
      virtualFs.files.set(join(fixture.attemptsRoot, "attempt-2", "attempt.json"),
        virtualFs.files.get(fixture.attemptPath)!);
      await expect(buildSocialProposedAdmissionAnchor(fixture.input)).rejects.toThrow(
        "ledger_epoch_proposed_admission_alias_evidence_mismatch",
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("fails closed around the exact plan-bound 506-record source-orphan seal", async () => {
    const root = await mkdtemp(join(tmpdir(), "proposed-admission-sidecar-"));
    try {
      const sidecar = join(root, ".ledger-epoch-v2-sidecar");
      await mkdir(sidecar);
      const records = plan().orphanWorkspaceBindings
        .map((record) => JSON.stringify(record)).sort()
        .map((record) => JSON.parse(record) as Record<string, unknown>);
      const writeRecord = async (index: number, record: Record<string, unknown>) => {
        await writeFile(join(sidecar,
          `source-orphan-${String(index).padStart(4, "0")}.json`),
        JSON.stringify(record));
      };
      for (const [index, record] of records.entries()) await writeRecord(index, record);
      const intent = { planSha256: SOCIAL_PROPOSED_ADMISSION_PLAN_SHA256 };
      for (const [name, value] of [
        ["intent.json", intent], ["plan.json", {}], ["owner.json", {}],
        ["state.json", {}], ["receipt.json", {}],
      ] as const) await writeFile(join(sidecar, name), JSON.stringify(value));
      const sourceOrphansSha256 = sha256(records.map((record) =>
          JSON.stringify(record)
        ).join("\n"));
      const writeManifest = async (sourceHash: string) => {
        const unsigned = {
          schemaVersion: 2,
          planSha256: SOCIAL_PROPOSED_ADMISSION_PLAN_SHA256,
          sourceOrphansSha256: sourceHash,
          intentSha256: sha256(JSON.stringify(intent)),
        };
        await writeFile(join(sidecar, "manifest.json"), JSON.stringify({
          ...unsigned,
          upgradeSha256: sha256(JSON.stringify(unsigned)),
        }));
      };
      await writeManifest(sourceOrphansSha256);
      const sealed = await verifySocialPreparedV1SourceOrphanSeal({
        ...plan(), newRoot: root,
      });
      expect(sealed.bindingSha256).toHaveLength(506);
      expect(sealed.bindingsSha256).toBe(sourceOrphansSha256);

      await rm(join(sidecar, "source-orphan-0505.json"));
      await expect(verifySocialPreparedV1SourceOrphanSeal({
        ...plan(), newRoot: root,
      })).rejects.toThrow("ledger_epoch_proposed_admission_source_orphan_sidecar_partial");
      await writeRecord(505, records[505]!);

      await writeFile(join(sidecar, "source-orphan-0506.json"), "{}\n");
      await expect(verifySocialPreparedV1SourceOrphanSeal({
        ...plan(), newRoot: root,
      })).rejects.toThrow("ledger_epoch_proposed_admission_source_orphan_sidecar_partial");
      await rm(join(sidecar, "source-orphan-0506.json"));

      await writeRecord(0, {});
      await expect(verifySocialPreparedV1SourceOrphanSeal({
        ...plan(), newRoot: root,
      })).rejects.toThrow("ledger_epoch_proposed_admission_source_orphan_seal_mismatch");
      await writeRecord(0, records[0]!);

      await writeRecord(0, records[1]!);
      await writeRecord(1, records[0]!);
      await expect(verifySocialPreparedV1SourceOrphanSeal({
        ...plan(), newRoot: root,
      })).rejects.toThrow("ledger_epoch_proposed_admission_source_orphan_seal_mismatch");
      await writeRecord(0, records[0]!);
      await writeRecord(1, records[1]!);

      await writeManifest("0".repeat(64));
      await expect(verifySocialPreparedV1SourceOrphanSeal({
        ...plan(), newRoot: root,
      })).rejects.toThrow("ledger_epoch_proposed_admission_source_orphan_seal_mismatch");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function historicalLineageFixture() {
  const root = await mkdtemp(join(tmpdir(), "proposed-admission-lineage-"));
  const newRoot = join(root, "new");
  const controllerRoot = "/var/data/social-monitor/worker-jobs/controller";
  const archiveName =
    "social-monitor-x-attribution-reuse-fixture-ci-v1-20260719-integrated-6c0129f655a0-social-monitor-x-attribution-reuse-fixture-integration-20260719-001";
  const archiveRoot = join(controllerRoot, "archives", archiveName);
  const attemptsRoot = join(controllerRoot, "project-integration", "integration-attempts");
  const attemptPath = join(attemptsRoot, "attempt-1", "attempt.json");
  const statusPath = join(archiveRoot, "git-status.txt");
  const diffPath = join(archiveRoot, "tracked.diff");
  const numstatPath = join(archiveRoot, "tracked.numstat");
  const workerJobId = "social-monitor-x-attribution-reuse-fixture-ci-v1-20260719";
  const attemptId = "social-monitor-x-attribution-reuse-fixture-integration-20260719-001";
  const sourceWorkspacePath =
    "/var/data/social-monitor/worktrees/social-monitor-x-attribution-reuse-fixture-ci-v1-20260719";
  const targetWorkspacePath =
    "/var/data/social-monitor/worktrees/social-monitor-x-attribution-reuse-fixture-integration-v1-20260719";
  const commitSha = "6c0129f655a056da0832355c5f8733a4e1daa4ff";
  const itemRelativePath = `items/${workerJobId}--${attemptId}.json`;
  const preparationRelativePath = `preparations/${attemptId}.json`;
  const item = {
    schemaVersion: 1, jobId: workerJobId, attemptId, status: "integrated",
    closedAt: "2026-07-19T02:15:09.018Z", commitSha, archivePath: archiveRoot,
    note: `Integrated reviewed worker output via project lifecycle attempt ${attemptId}.`,
    backup: { workspace: sourceWorkspacePath, statusPath, patchPath: diffPath,
      numstatPath },
    consumedAt: "2026-07-19T02:15:09.018Z", integratedCommitSha: commitSha,
    commit: commitSha,
    notes: [{ status: "integrated",
      text: `Integrated reviewed worker output via project lifecycle attempt ${attemptId}.`,
      commit: commitSha }],
  };
  const preparation = {
    attemptId, workerJobId, workerWorkspacePath: sourceWorkspacePath, commitSha,
    archivePath: archiveRoot, statusPath, patchPath: diffPath, numstatPath,
  };
  const changedFile =
    "scripts/lib/reader-summary-production-day-reuse-provenance.spec.ts";
  const attempt = {
    attemptId, projectId: "social-monitor",
    controllerJobId: "social-monitor-project-controller-v1", workerJobId,
    sourceWorkspacePath, targetWorkspacePath,
    targetBranch: "fix/x-attribution-reuse-fixture-ci-v2", targetRemote: "origin",
    expectedFiles: [changedFile], status: "pushed",
    workerOutput: {
      workerJobId, workspacePath: sourceWorkspacePath,
      patchPath: "/var/data/social-monitor/worker-jobs/reviewed-worker-outputs/ae7057651acf5be3f97f74f002a7777f0f34a3609bf846dfa41e81648b23e308/output.patch",
      patchSha256: "3a90d2c4fd6dfdb0a4ddd26c2d11b5594a833fd2a93e811e213e38e8a0eabfc5",
      baseCommit: "55780616f3be3742974d8c26943712aead6b6a98",
      targetCommit: "55780616f3be3742974d8c26943712aead6b6a98",
      changedFiles: [changedFile],
    },
    reviewDecision: {
      reviewedBy: "independent-review:production_18_quality_audit",
      decision: "approved",
      reason: "Independent review confirmed truthful complete warning-only attribution fixture; production validation untouched; exact regression 4/4 and nearby validation 67/67; lint, targeted TS, line cap, secrets and diff-check pass.",
      approvedFiles: [changedFile], requiredChecks: [],
    },
    checkRuns: [], createdAt: "2026-07-19T02:13:43.551Z",
    updatedAt: "2026-07-19T02:15:09.018Z",
    commitCandidate: {
      commitSha, message: "test(summary): align X attribution reuse fixture",
      files: [changedFile], secretScanStatus: "passed",
      createdAt: "2026-07-19T02:14:58.909Z",
      diffStat: ".../reader-summary-production-day-reuse-provenance.spec.ts    | 11 ++++++++++-\n 1 file changed, 10 insertions(+), 1 deletion(-)",
    },
    pushAttempt: { remote: "origin", branch: "fix/x-attribution-reuse-fixture-ci-v2",
      commitSha, status: "pushed", pushedAt: "2026-07-19T02:15:09.018Z" },
  };
  const itemBytes = `${JSON.stringify(item, null, 2)}\n`;
  const preparationBytes = `${JSON.stringify(preparation, null, 2)}\n`;
  const attemptBytes = `${JSON.stringify(attempt, null, 2)}\n`;
  expect([itemBytes.length, sha256(itemBytes)]).toEqual([1980,
    "d230f4ceed015a5f9a9ccc207f62418a3495fb54ae7ec8c02df9a794d7765b4d"]);
  expect([preparationBytes.length, sha256(preparationBytes)]).toEqual([1296,
    "55e2a0824804d6db0a9a5698fe5ef84b453c9a8a6e21ed373748536048ecb523"]);
  expect([attemptBytes.length, sha256(attemptBytes)]).toEqual([2724,
    "e54f8f26db111df27bdc0b3773942c53eb0a8a278c2f7c9c9fea48b3604068a8"]);
  await Promise.all([
    mkdir(join(newRoot, "legacy-preservation", "items"), { recursive: true }),
    mkdir(join(newRoot, "legacy-preservation", "preparations"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(newRoot, "legacy-preservation", itemRelativePath), itemBytes),
    writeFile(join(newRoot, "legacy-preservation", preparationRelativePath),
      preparationBytes),
  ]);
  virtualFs.files.set(statusPath, Buffer.from(` M ${changedFile}\n`));
  virtualFs.files.set(diffPath, Buffer.from(
    "diff --git a/scripts/lib/reader-summary-production-day-reuse-provenance.spec.ts b/scripts/lib/reader-summary-production-day-reuse-provenance.spec.ts\n" +
    "index db393ab00..64aad898d 100644\n--- a/scripts/lib/reader-summary-production-day-reuse-provenance.spec.ts\n+++ b/scripts/lib/reader-summary-production-day-reuse-provenance.spec.ts\n@@ -185,7 +185,16 @@ function buildLiveReport(\n     collectionQuality: {\n       collectionDate,\n       dayWindowAudit: { publishedInsideWindowFeedItemCount: 5 },\n-      xAccountPool: { totalAccountCount: 1, eligibleAccountCount: 1 },\n+      xAccountPool: {\n+        totalAccountCount: 1,\n+        eligibleAccountCount: 1,\n+        attributionStatus: \"unknown\",\n+        attributionPolicy: \"warning_only\",\n+        attributionGateReason:\n+          \"unknown_attribution_global_collection_succeeded_warning_only\",\n+        eligibleAccountZeroAttributableOutputWarningCount: 0,\n+        attributionWarnings: [],\n+      },\n     },\n     durableEvidence: evidence,\n     evidenceBinding: binding,\n",
  ));
  virtualFs.files.set(numstatPath, Buffer.from(`10\t1\t${changedFile}\n`));
  virtualFs.files.set(attemptPath, Buffer.from(attemptBytes));
  virtualFs.directories.set(attemptsRoot, ["attempt-1"]);
  const blocking = [
    ...many(ProjectDebtReason.UnconsumedCompletedJob, 495),
    ...many(ProjectDebtReason.OrphanLegacyWorkspace, 205),
    ...many(ProjectDebtReason.ActiveWriterConflict, 6),
    ...many(ProjectDebtReason.InactiveDirtyWorkspace, 4),
  ];
  const info = many(ProjectDebtReason.LegacyOutputQuarantineRequired, 1738)
    .map((value) => ({ ...value, severity: "info" as const }));
  const evidenceBindings = [archiveRoot, statusPath, diffPath, numstatPath]
    .map((declaredPath) => ({ declaredPath, state: "denied" as const,
      canonicalPath: declaredPath }));
  const files = [{ relativePath: itemRelativePath, size: 1980,
    sha256: "d230f4ceed015a5f9a9ccc207f62418a3495fb54ae7ec8c02df9a794d7765b4d",
    disposition: "quarantine" as const,
    quarantineReason: "invalid_or_missing_evidence" as const }, {
    relativePath: preparationRelativePath, size: 1296,
    sha256: "55e2a0824804d6db0a9a5698fe5ef84b453c9a8a6e21ed373748536048ecb523",
    disposition: "preserve_only" as const,
  }];
  return {
    statusPath, attemptPath, attemptsRoot,
    input: {
      plan: { ...plan(), newRoot, evidenceBindings, files },
      snapshot: snapshot([...blocking, ...info]),
      controllerJobRootDir: controllerRoot,
      debtCustody: blocking.map((value, index) => ({
        reason: value.reason, subject: value.subject, declaredPath: `/debt/${index}`,
        canonicalPath: `/debt/${index}`, device: 1, inode: index + 1,
      })),
      sourceOrphanSeal: sourceOrphanSeal(506),
    },
    cleanup: async () => {
      virtualFs.files.clear();
      virtualFs.directories.clear();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function debt(reason: ProjectDebtReason, subject: string): ProjectDebtItem {
  return { reason, subject, severity: "blocking", evidence: [`evidence ${subject}`] };
}

function postActivationConsumedDirtyWorkspace(): ProjectDebtItem {
  return {
    reason: ProjectDebtReason.ConsumedDirtyWorkspace,
    subject: "producer-job",
    severity: "info",
    evidence: [
      "dirty output consumed by terminal ledger status: integrated",
      "ledger: /ledger/v2/items/producer-job.json",
      "commit: abc1234",
    ],
  };
}

function postActivationRejectedConsumedDirtyWorkspace(): ProjectDebtItem {
  return {
    reason: ProjectDebtReason.ConsumedDirtyWorkspace,
    subject: "social-monitor-release-bundle-recovery-v4-20260810",
    severity: "info",
    evidence: [
      "dirty output consumed by terminal ledger status: rejected",
      "ledger: /ledger/v2/items/social-monitor-release-bundle-recovery-v4-20260810.json",
    ],
  };
}

function many(reason: ProjectDebtReason, count: number): readonly ProjectDebtItem[] {
  return Array.from({ length: count }, (_, index) => debt(reason, `${reason}-${index}`));
}

function snapshot(debtItems: readonly ProjectDebtItem[]): ProjectAdmissionSnapshot {
  return {
    schemaVersion: 1,
    projectId: "social-monitor",
    observedAt: new Date(0).toISOString(),
    debt: debtItems,
  };
}

function itemHash(item: ProjectDebtItem): string {
  const canonical = {
    reason: item.reason,
    subject: item.subject,
    evidence: [...item.evidence],
    severity: item.severity ?? "blocking",
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sourceOrphanSeal(count: number) {
  const canonical = Array.from({ length: count }, (_, index) =>
    JSON.stringify({ index })).sort();
  return {
    bindings: canonical.map((value) => JSON.parse(value) as Record<string, unknown>),
    bindingSha256: canonical.map(sha256),
    bindingsSha256: sha256(canonical.join("\n")),
  };
}

function anchorWithSourceRecordCount(
  anchor: LedgerEpochProposedAdmissionAnchor,
  count: number,
): LedgerEpochProposedAdmissionAnchor {
  const seal = sourceOrphanSeal(count);
  const { anchorSha256: ignored, ...anchored } = anchor;
  void ignored;
  const unsigned = {
    ...anchored,
    sourceOrphanBindingSha256: seal.bindingSha256,
    sourceOrphanBindingsSha256: seal.bindingsSha256,
    sourceOrphanBindings: seal.bindings,
  };
  return { ...unsigned, anchorSha256: sha256(JSON.stringify(unsigned)) };
}

function anchorFor(items: readonly ProjectDebtItem[]): LedgerEpochProposedAdmissionAnchor {
  return {
    schemaVersion: 1,
    planSha256: SOCIAL_PROPOSED_ADMISSION_PLAN_SHA256,
    controllerJobId: "controller",
    projectId: "social-monitor",
    oldRoot: "/ledger/v1",
    newRoot: "/ledger/v2",
    cutoff: "2026-07-20T00:00:00.000Z",
    debtCount: 2448,
    blockingDebtCount: 710,
    infoDebtCount: 1738,
    categoryCounts: {},
    debt: [...items].sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right))),
    debtItemSha256: items.map(itemHash).sort(),
    blockingDebtItemSha256: items.map(itemHash).sort(),
    debtSha256: "a".repeat(64),
    debtCustody: [],
    debtCustodySha256: "b".repeat(64),
    sourceOrphanBindingSha256: Array.from(
      { length: 205 }, () => "f".repeat(64)
    ),
    sourceOrphanBindingsSha256: "c".repeat(64),
    sourceOrphanBindings: Array.from({ length: 205 }, (_, index) => ({ index })),
    sourceOrphanBindingCount: 205,
    historicalAlias: {
      name: "social-monitor-x-attribution-reuse-fixture-integration-v1-20260719",
      targetWorkspacePath:
        "/var/data/social-monitor/worktrees/social-monitor-x-attribution-reuse-fixture-integration-v1-20260719",
      workerJobId: "social-monitor-x-attribution-reuse-fixture-ci-v1-20260719",
      sourceWorkspacePath:
        "/var/data/social-monitor/worktrees/social-monitor-x-attribution-reuse-fixture-ci-v1-20260719",
      attemptId: "social-monitor-x-attribution-reuse-fixture-integration-20260719-001",
      commitSha: "6c0129f655a056da0832355c5f8733a4e1daa4ff",
      item: { planRecord: { relativePath: "item", size: 3, sha256: "e".repeat(64),
        disposition: "quarantine" }, planRecordSha256: "e".repeat(64),
      preserved: file("/item") },
      preparation: { planRecord: { relativePath: "preparation", size: 3,
        sha256: "e".repeat(64), disposition: "preserve_only" },
      planRecordSha256: "e".repeat(64), preserved: file("/preparation") },
      archiveEvidenceBindings: [],
      archiveEvidenceBindingsSha256: "e".repeat(64),
      archiveRoot: "/archive",
      gitStatus: file("/archive/git-status.txt"),
      trackedDiff: file("/archive/tracked.diff"),
      trackedNumstat: file("/archive/tracked.numstat"),
      pushedAttempt: file("/controller/attempt.json"),
    },
    anchorSha256: "d".repeat(64),
  };
}

function file(path: string) {
  return {
    path,
    canonicalPath: path,
    device: 1,
    inode: 2,
    size: 3,
    sha256: "e".repeat(64),
  };
}

function plan(): ConsumedOutputLedgerEpochPlan {
  return {
    schemaVersion: 1,
    controllerJobId: "controller",
    projectId: "social-monitor",
    oldRoot: "/ledger/v1",
    newRoot: "/ledger/v2",
    cutoff: "2026-07-20T00:00:00.000Z",
    oldRootHash: "a".repeat(64),
    oldRootFileCount: 1,
    oldRootDevice: 1,
    oldRootInode: 2,
    newRootParentDevice: 1,
    newRootParentInode: 3,
    epochNumber: 1,
    genesisOldRootHash: "a".repeat(64),
    controllerManifestSha256: "b".repeat(64),
    controllerStableScopeSha256: "c".repeat(64),
    registryJobIdsSha256: "d".repeat(64),
    registryJobCount: 708,
    migratedCount: 493,
    quarantinedCount: 209,
    inheritedQuarantinedCount: 0,
    deniedRoots: [],
    evidenceBindings: [],
    orphanWorkspaceBindings: Array.from({ length: 506 }, (_, index) => ({
      declaredPath: `/work/orphan-${index}`,
      state: "denied" as const,
    })),
    files: [],
    planSha256: SOCIAL_PROPOSED_ADMISSION_PLAN_SHA256,
  };
}

function proposedSummary() {
  return {
    debtCount: 2448,
    counts: {
      unconsumedCompletedJobs: 495,
      orphanLegacyWorkspaces: 205,
      activeWriterConflicts: 6,
      inactiveDirtyWorkspaces: 4,
      unreadableWorkspaces: 0,
      legacyOutputQuarantineRequired: 1738,
    },
  };
}
