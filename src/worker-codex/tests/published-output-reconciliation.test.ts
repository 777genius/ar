import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { ReviewDecisionStatus, createAccessPolicyService, AccessBoundary,
  type ProjectAccessScope } from "@vioxen/subscription-runtime/worker-core";
import { LocalConsumedOutputLedgerWriter } from "@vioxen/subscription-runtime/worker-local";
import { captureReviewedWorkerOutput, commitReviewedWorkerOutputReviewAttestation,
  localReviewedWorkerOutputDeps, assertReviewedWorkerOutputStillMatchesLocked } from "../reviewed-worker-output";
import { incorporationBytes, incorporationHash, incorporationPermitSchema, incorporationReceiptSchema,
  incorporationEvidenceReferences,
  type IncorporationPermit } from "../published-output-reconciliation/domain/publication-incorporation";
import { reconcilePublishedReviewedOutput, type PublishedOutputReconciliationDeps } from
  "../published-output-reconciliation/application/reconcile-published-reviewed-output";
import { verifyPublishedOutputIncorporation } from "../published-output-reconciliation/adapters/local-git-incorporation";
import { readCodexGoalConsumedOutputLedgers } from "../application/project-control/codex-goal-consumed-output-ledger-io";
import { readPublishedReconciliationPermit } from "../codex-goal-mcp-project-control-published-reconciliation";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd })).stdout.trim();
async function commit(cwd: string, message: string) {
  // Synthetic TEST commits still use the owner's exact ordinary identity.
  expect(await git(cwd, "var", "GIT_AUTHOR_IDENT")).toMatch(/^iliya <iliyazelenkog@gmail.com>/);
  expect(await git(cwd, "var", "GIT_COMMITTER_IDENT")).toMatch(/^iliya <iliyazelenkog@gmail.com>/);
  await git(cwd, "add", "-A"); await git(cwd, "commit", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "sr-incorporation-TEST-"))); roots.push(root);
  const source = join(root, "source"), target = join(root, "canonical"), ledger = join(root, "ledger");
  const archive = join(root, "evidence", "incorporation");
  await mkdir(source); await mkdir(ledger); await mkdir(archive, { recursive: true });
  await git(source, "init", "-b", "main");
  await git(source, "config", "user.name", "iliya");
  await git(source, "config", "user.email", "iliyazelenkog@gmail.com");
  for (const file of ["a.txt", "executable.txt", "deleted.txt"]) await writeFile(join(source, file), "before\n");
  const base = await commit(source, "chore(test): establish source base");
  await writeFile(join(source, "a.txt"), "reviewed after\n");
  await chmod(join(source, "executable.txt"), 0o755);
  await rm(join(source, "deleted.txt"));
  await writeFile(join(source, "untracked.txt"), "reviewed new file\n");
  const reviewed = localReviewedWorkerOutputDeps({ rootDir: join(root, "reviewed") });
  const capture = await reviewed.snapshotter.capture({ workspacePath: source });
  const snapshot = await captureReviewedWorkerOutput(reviewed, {
    projectId: "TEST-project", controllerJobId: "TEST-controller", workerJobId: "TEST-worker", taskId: "TEST-task",
    workspacePath: source, expectedPatchSha256: incorporationHash(capture.patch),
    decision: ReviewDecisionStatus.Approved, reviewedBy: "TEST-independent-reviewer", reason: "Synthetic approved fixture",
    approvedFiles: capture.changedFiles, requiredChecks: [],
  });
  const markerPath = join(root, "review.json");
  await writeFile(markerPath, JSON.stringify({ reviewedOutput: {
    reviewedOutputId: snapshot.reviewedOutputId, patchSha256: snapshot.patchSha256,
    patchPath: snapshot.patchPath, baseCommit: snapshot.baseCommit, changedFiles: snapshot.changedFiles,
    reviewedBy: snapshot.reviewDecision.reviewedBy, decision: snapshot.reviewDecision.decision, capturedAt: snapshot.capturedAt,
  } }));
  await commitReviewedWorkerOutputReviewAttestation({ store: reviewed.store, markerVerifier: reviewed.markerVerifier,
    snapshot, reviewMarkerPath: markerPath });
  await git(root, "clone", source, target);
  await git(target, "config", "user.name", "iliya");
  await git(target, "config", "user.email", "iliyazelenkog@gmail.com");
  await git(target, "remote", "set-url", "origin", "https://github.com/test/synthetic-repository.git");
  await writeFile(join(target, "unrelated.txt"), "canonical unrelated change\n");
  const parent = await commit(target, "chore(test): unrelated canonical change");
  await git(target, "apply", "--index", snapshot.patchPath);
  const publishedSha = await commit(target, "fix(test): publish frozen reviewed output");
  const tree = await git(target, "rev-parse", "HEAD^{tree}");
  await writeFile(join(target, "a.txt"), "later legitimate canonical edit\n");
  const head = await commit(target, "feat(test): evolve canonical source later");
  const proofFiles = await Promise.all(["publication", "source-review", "ci", "publication-review"].map(async (kind) => {
    const path = join(root, `${kind}.json`), bytes = incorporationBytes({ syntheticTEST: true, kind, publishedSha });
    await writeFile(path, bytes); return { path, sha256: incorporationHash(bytes) };
  }));
  const permit: IncorporationPermit = {
    schemaVersion: 1, operation: "reconcile_published_reviewed_output", controllerJobId: "TEST-controller",
    projectId: "TEST-project", workerJobId: "TEST-worker", reviewedOutputId: snapshot.reviewedOutputId,
    reviewedBy: snapshot.reviewDecision.reviewedBy, reviewDecisionSha256: incorporationHash(JSON.stringify(snapshot.reviewDecision)),
    patchSha256: snapshot.patchSha256, sourceBase: base, sourceWorkspace: source, targetWorkspace: target, changedFiles: [...snapshot.changedFiles],
    repository: "test/synthetic-repository", remote: "origin", branch: "main", publishedSha, canonicalHead: head,
    operator: "TEST-owner", verifiedAt: "2026-10-04T18:00:00.000Z", verificationMethod: "authenticated_gh_api",
    ownerLogin: "777genius", authorEmail: "iliyazelenkog@gmail.com", publicationEvidenceSha256: proofFiles[0]!.sha256,
    publicationEvidencePath: proofFiles[0]!.path, sourceReviewEvidence: proofFiles[1]!, additionalEvidence: [],
    requiredCanonicalChecks: ["TEST-canonical-CI"], snapshotCheckMappings: [],
    checks: [{ checkId: "TEST-canonical-CI", commitSha: publishedSha, conclusion: "success", evidenceSha256: proofFiles[2]!.sha256, evidencePath: proofFiles[2]!.path }],
    review: { reviewedSha: publishedSha, reviewedTree: tree, decision: "approved", reviewedBy: "TEST-reviewer", evidenceSha256: proofFiles[3]!.sha256, evidencePath: proofFiles[3]!.path },
  };
  const scope: ProjectAccessScope = { projectId: "TEST-project", workspaceRoots: [source, target],
    jobIdPrefixes: ["TEST-"], allowedBranches: ["main"], allowedGitRemotes: [],
    consumedOutputLedgerRoots: [ledger], consumedOutputEvidenceRoots: [join(root, "evidence")] };
  const writer = new LocalConsumedOutputLedgerWriter(undefined, undefined, scope.consumedOutputEvidenceRoots);
  let quiescent = true, interrupted = false, verifies = 0, captures = 0;
  const deps: PublishedOutputReconciliationDeps = {
    loadSnapshot: (id) => reviewed.store.get(id), readPatch: (snap) => reviewed.store.readPatch(snap),
    assertQuiescent: async () => { if (!quiescent) throw new Error("TEST_worker_active"); },
    assertSourceMatches: async (snap) => { captures++;
      await assertReviewedWorkerOutputStillMatchesLocked(reviewed, snap, { workspacePath: source, owner: "TEST", lockId: "TEST" }); },
    verify: async (snap, patch) => { verifies++; return verifyPublishedOutputIncorporation({ permit, patch,
      changedFiles: snap.changedFiles, tempRoot: join(root, "verification") }); },
    readStatus: async () => Buffer.from(await git(source, "status", "--porcelain=v1", "--untracked-files=all")),
    readPrepared: async () => {
      try { return { receipt: incorporationReceiptSchema.parse(JSON.parse(await readFile(join(archive, "publication-incorporation.json"), "utf8"))),
        status: await readFile(join(archive, "git-status.txt")) }; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    },
    publish: async (receipt, patch, status) => {
      for (const proof of incorporationEvidenceReferences(permit)) await writeFile(join(archive, `proof-${proof.sha256}.json`), await readFile(proof.path), { flag: "wx" });
      for (const [name, bytes] of [["permit.json", incorporationBytes(permit)], ["tracked.diff", Buffer.from(patch)],
        ["git-status.txt", status], ["publication-incorporation.json", incorporationBytes(receipt)]] as const) {
        await writeFile(join(archive, name), bytes, { flag: "wx" });
      }
      if (interrupted) throw new Error("TEST_interrupted_after_receipt");
    }, writer,
    isCommitted: async (decision) => {
      await writer.assertCanRecord({ ledgerRoot: ledger, decision });
      try { await readFile(join(ledger, "items", "TEST-worker.json")); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
    },
  };
  const input = { scope, controllerJobId: "TEST-controller", permit, permitSha256: incorporationHash(incorporationBytes(permit)), archivePath: archive };
  return { root, source, target, ledger, archive, base, parent, permit, snapshot, deps, input,
    run: () => reconcilePublishedReviewedOutput(deps, input),
    proof: () => verifyPublishedOutputIncorporation({ permit, patch: capture.patch, changedFiles: snapshot.changedFiles, tempRoot: join(root, "verify") }),
    setActive: () => { quiescent = false; }, interrupt: () => { interrupted = true; },
    counts: () => ({ verifies, captures }),
    readLedger: () => readCodexGoalConsumedOutputLedgers({ roots: [ledger], evidenceRoots: scope.consumedOutputEvidenceRoots! }),
  };
}

describe("historical publication incorporation on synthetic TEST projects", () => {
  it("consumes exact additions/deletions/modes despite squash parent and unrelated whole-tree changes, without push", async () => {
    const f = await fixture(); const head = await git(f.target, "rev-parse", "HEAD");
    const sourceIndex = await readFile(join(f.source, ".git", "index"));
    const sourceObjects = await git(f.source, "count-objects", "-v");
    const result = await f.run();
    expect(result.decision.attemptId).toBeUndefined(); expect(result.decision.status).toBe("integrated");
    const proof = await f.deps.readPrepared();
    expect(proof!.receipt.publishedParents).toEqual([f.parent]); expect(f.parent).not.toBe(f.base);
    expect(proof!.receipt.reconstructedTree).not.toBe(proof!.receipt.publishedTree);
    expect(proof!.receipt.paths.find((p) => p.path === "deleted.txt")!.after).toBeNull();
    expect(proof!.receipt.paths.find((p) => p.path === "executable.txt")!.after!.mode).toBe("100755");
    expect(proof!.receipt.paths.find((p) => p.path === "untracked.txt")!.before).toBeNull();
    expect((await f.readLedger()).byJobId.get("TEST-worker")?.valid).toBe(true);
    expect(await git(f.target, "rev-parse", "HEAD")).toBe(head);
    expect(await readFile(join(f.source, ".git", "index"))).toEqual(sourceIndex);
    expect(await git(f.source, "count-objects", "-v")).toBe(sourceObjects);
    expect(createAccessPolicyService({ boundary: AccessBoundary.ProjectScopedControl, scope: f.input.scope })
      .canPushBranch({ workspacePath: f.target, branch: "main", remote: "origin" }).allowed).toBe(false);
  });
  it.each(["a.txt", "untracked.txt", "deleted.txt", "executable.txt"])("refuses divergent presence/blob/mode for %s", async (file) => {
    const f = await fixture(); await git(f.target, "checkout", "--detach", f.permit.publishedSha);
    if (file === "untracked.txt") await rm(join(f.target, file));
    else if (file === "executable.txt") await chmod(join(f.target, file), 0o644);
    else await writeFile(join(f.target, file), "wrong publication\n");
    f.permit.publishedSha = await commit(f.target, "fix(test): mismatched publication");
    f.permit.canonicalHead = f.permit.publishedSha;
    f.permit.review.reviewedTree = await git(f.target, "rev-parse", "HEAD^{tree}");
    await expect(f.proof()).rejects.toThrow("published_output_path_not_incorporated");
    expect((await f.readLedger()).byJobId.size).toBe(0);
  });
  it("refuses omitted frozen changed paths", async () => {
    const f = await fixture();
    await expect(verifyPublishedOutputIncorporation({ permit: f.permit, patch: await readFile(f.snapshot.patchPath, "utf8"),
      changedFiles: ["a.txt"], tempRoot: join(f.root, "verify") })).rejects.toThrow("published_output_changed_paths_mismatch");
  });
  it("retains the actual different review head while proving the identical publication tree", async () => {
    const f = await fixture();
    expect(await git(f.target, "var", "GIT_AUTHOR_IDENT")).toMatch(/^iliya <iliyazelenkog@gmail.com>/);
    expect(await git(f.target, "var", "GIT_COMMITTER_IDENT")).toMatch(/^iliya <iliyazelenkog@gmail.com>/);
    f.permit.review.reviewedSha = await git(f.target, "commit-tree", f.permit.review.reviewedTree,
      "-p", f.base, "-m", "fix(test): independently reviewed original head");
    expect(f.permit.review.reviewedSha).not.toBe(f.permit.publishedSha);
    expect(await git(f.target, "rev-parse", `${f.permit.review.reviewedSha}^{tree}`)).toBe(f.permit.review.reviewedTree);
    f.input.permitSha256 = incorporationHash(incorporationBytes(f.permit));
    await f.run(); expect((await f.readLedger()).byJobId.get("TEST-worker")!.valid).toBe(true);
    expect((await f.deps.readPrepared())!.receipt.permit.review.reviewedSha).toBe(f.permit.review.reviewedSha);
  });
  it.each(["projectId", "controllerJobId", "workerJobId", "sourceWorkspace", "targetWorkspace", "reviewedOutputId", "reviewedBy", "sourceBase", "reviewDecisionSha256", "patchSha256"] as const)(
    "denies mismatched authority or frozen binding %s before consumption", async (field) => {
      const f = await fixture(); const wrong = field.endsWith("Sha256") || field === "reviewedOutputId" ? "f".repeat(64)
        : field === "sourceBase" ? "f".repeat(40) : field.endsWith("Workspace") ? "/outside/TEST" : "other";
      f.input.permit = { ...f.permit, [field]: wrong };
      await expect(reconcilePublishedReviewedOutput(f.deps, f.input)).rejects.toThrow();
      expect((await f.readLedger()).byJobId.size).toBe(0); expect(f.counts().verifies).toBe(0);
    });
  it("refuses missing actual approval attestation", async () => {
    const f = await fixture(); await rm(join(f.root, "reviewed", f.snapshot.reviewedOutputId, "review-attestation.json"));
    await expect(f.run()).rejects.toThrow("published_output_approved_snapshot_binding_required");
    expect((await f.readLedger()).byJobId.size).toBe(0);
  });
  it("refuses untracked output drift and active source", async () => {
    const f = await fixture(); await writeFile(join(f.source, "omitted-drift.txt"), "new output\n");
    await expect(f.run()).rejects.toThrow("reviewed_worker_output_workspace_changed_after_capture");
    await rm(join(f.source, "omitted-drift.txt")); f.setActive();
    await expect(f.run()).rejects.toThrow("TEST_worker_active"); expect((await f.readLedger()).byJobId.size).toBe(0);
  });
  it("refuses wrong repository and review tree", async () => {
    const f = await fixture(); f.permit.repository = "wrong/repository";
    await expect(f.proof()).rejects.toThrow("published_output_repository_mismatch");
    f.permit.repository = "test/synthetic-repository"; f.permit.review.reviewedTree = "f".repeat(40);
    await expect(f.proof()).rejects.toThrow("published_output_review_tree_mismatch");
    expect((await f.readLedger()).byJobId.size).toBe(0);
  });
  it("refuses an adversarial commit object with a different author", async () => {
    const f = await fixture();
    // Malicious object fixture, not an ordinary authored commit or ref update.
    const raw = await git(f.target, "cat-file", "commit", f.permit.publishedSha);
    const path = join(f.root, "adversarial-commit-object.txt");
    await writeFile(path, raw.replace("author iliya <iliyazelenkog@gmail.com>", "author attacker <attacker@example.test>"));
    f.permit.publishedSha = await git(f.target, "hash-object", "-t", "commit", "-w", path);
    f.permit.canonicalHead = f.permit.publishedSha;
    await expect(f.proof()).rejects.toThrow("published_output_owner_mismatch");
    expect((await f.readLedger()).byJobId.size).toBe(0);
  });
  it("rejects nonancestor publication and CI from a different exact SHA even with empty private checks", async () => {
    const f = await fixture(); f.permit.canonicalHead = f.base;
    await expect(f.proof()).rejects.toThrow();
    f.permit.checks[0]!.commitSha = f.base;
    expect(() => incorporationPermitSchema.parse(f.permit)).toThrow("published_output_exact_sha_evidence_required");
    f.permit.checks = []; expect(() => incorporationPermitSchema.parse(f.permit)).toThrow();
  });
  it("requires every declared canonical CI result", async () => {
    const f = await fixture(); f.permit.requiredCanonicalChecks.push("TEST-missing-security-CI");
    await expect(f.run()).rejects.toThrow("published_output_exact_sha_evidence_required");
    expect((await f.readLedger()).byJobId.size).toBe(0);
  });
  it("reuses immutable preparation after interruption and refuses drift before first consumption", async () => {
    const f = await fixture(); f.interrupt(); await expect(f.run()).rejects.toThrow("TEST_interrupted_after_receipt");
    const bytes = await readFile(join(f.archive, "publication-incorporation.json"));
    expect((await f.readLedger()).byJobId.size).toBe(0);
    await writeFile(join(f.source, "drift.txt"), "new output\n");
    await expect(f.run()).rejects.toThrow("reviewed_worker_output_workspace_changed_after_capture");
    expect((await f.readLedger()).byJobId.size).toBe(0);
    await rm(join(f.source, "drift.txt")); await f.run(); const count = f.counts();
    await writeFile(join(f.source, "new-after-consumption.txt"), "later output\n"); f.setActive();
    expect((await f.run()).idempotentReplay).toBe(true);
    expect(f.counts()).toEqual(count); expect(f.counts().verifies).toBe(1);
    expect(await readFile(join(f.archive, "publication-incorporation.json"))).toEqual(bytes);
  });
  it("refuses conflicting replay permit/evidence before another ledger write", async () => {
    const f = await fixture(); await f.run(); f.input.permitSha256 = "f".repeat(64);
    await expect(f.run()).rejects.toThrow("published_output_preparation_conflict");
  });
  it.each(["publication-incorporation.json", "tracked.diff", "permit.json", "git-status.txt"])(
    "authoritative reader rejects tampered %s", async (file) => {
      const f = await fixture(); await f.run(); await writeFile(join(f.archive, file), "tampered\n");
      const read = await f.readLedger(); expect(read.byJobId.size).toBe(0);
      expect(read.debt.some((item) => item.severity === "blocking")).toBe(true);
    });
  it("authoritative reader rejects a forged path proof even if receipt hash is replaced", async () => {
    const f = await fixture(); const result = await f.run();
    const receipt = (await f.deps.readPrepared())!.receipt; receipt.paths[0]!.published = null;
    const bytes = incorporationBytes(receipt); await writeFile(join(f.archive, "publication-incorporation.json"), bytes);
    const ledger = JSON.parse(await readFile(result.ledgerPath, "utf8")) as Record<string, unknown>;
    ledger.publicationIncorporation = { path: join(f.archive, "publication-incorporation.json"), sha256: incorporationHash(bytes) };
    await writeFile(result.ledgerPath, JSON.stringify(ledger));
    expect((await f.readLedger()).byJobId.size).toBe(0);
  });
  it("authoritative reader rejects an omitted path even if receipt hash is replaced", async () => {
    const f = await fixture(); const result = await f.run(); const receipt = (await f.deps.readPrepared())!.receipt;
    receipt.paths.pop(); const bytes = incorporationBytes(receipt);
    await writeFile(join(f.archive, "publication-incorporation.json"), bytes);
    const ledger = JSON.parse(await readFile(result.ledgerPath, "utf8")) as Record<string, unknown>;
    ledger.publicationIncorporation = { path: join(f.archive, "publication-incorporation.json"), sha256: incorporationHash(bytes) };
    await writeFile(result.ledgerPath, JSON.stringify(ledger)); expect((await f.readLedger()).byJobId.size).toBe(0);
  });
  it("authoritative reader rejects tampered raw proof bytes", async () => {
    const f = await fixture(); await f.run();
    await writeFile(join(f.archive, `proof-${f.permit.publicationEvidenceSha256}.json`), "changed raw publication facts");
    const read = await f.readLedger(); expect(read.byJobId.size).toBe(0);
    expect(read.debt.some((item) => item.severity === "blocking")).toBe(true);
  });
  it("refuses drift introduced during immutable preparation before first consumption", async () => {
    const f = await fixture(); const publish = f.deps.publish;
    await expect(reconcilePublishedReviewedOutput({ ...f.deps, publish: async (...args) => {
      await publish(...args); await writeFile(join(f.source, "new-during-publication.txt"), "new output\n");
    } }, f.input)).rejects.toThrow("reviewed_worker_output_workspace_changed_after_capture");
    expect((await f.readLedger()).byJobId.size).toBe(0);
  });
  it.skipIf(process.geteuid?.() === 0)("fails closed for an unprivileged root-permit caller", async () => {
    await expect(readPublishedReconciliationPermit({ controllerJobId: "TEST-controller", reviewedOutputId: "a".repeat(64),
      permitFile: "/missing/TEST-permit", expectedPermitSha256: "a".repeat(64) })).rejects.toThrow("published_output_reconciliation_root_required");
  });
});
