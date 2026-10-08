import { execFile } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessBoundary, CONSUMED_OUTPUT_LEDGER_RETIRED_MARKER, NetworkAccessMode, ReviewDecisionStatus, type ProjectAccessScope } from "@vioxen/subscription-runtime/worker-core";
import { LocalProjectControlEvidenceCustody } from "@vioxen/subscription-runtime/worker-local";
import { LocalConsumedOutputLedgerMutationLock, LocalConsumedOutputLedgerWriter } from "../../worker-local/consumed-output-ledger-local-adapter";
import { localProjectControlEvidenceCustodySupported } from "../../worker-local/project-control-evidence-custody-local-adapter";
import { acquireConsumedOutputLedgerMaintenanceLock, releaseConsumedOutputLedgerMaintenanceLock } from "../../worker-local/consumed-output-ledger-maintenance-lock";
import { recoveryDirectoryIdentities } from "../../worker-local/project-control-recovery-directory-identity";
import { createCodexGoalMcpServer } from "../codex-goal-mcp";
import { createCodexGoalJob, codexGoalJobManifestPath } from "../codex-goal-jobs";
import { localReviewedWorkerOutputDeps, reviewedWorkerOutputRoot } from "../reviewed-worker-output";
import { codexGoalOutputPath, codexGoalProgressPath } from "../codex-goal-runner";
import { archiveBytes, archiveHash, projectControlArchiveReviewedOutput, readReviewedArchivePermit, type ReviewedArchivePermit } from "../codex-goal-mcp-project-control-reviewed-archive";
import { readCodexGoalConsumedOutputLedgers } from "../application/project-control/codex-goal-consumed-output-ledger-io";
import { callToolJson } from "./codex-goal-mcp-test-support";

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd,
  env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } })).stdout;
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

// CI qualifies both native identities. Selecting a lane never grants privilege:
// the dedicated root TEST command must actually run with effective UID 0.
enum ArchiveTestPrivilege { Root = "root", Nonroot = "nonroot" }
const effectiveUid = process.geteuid?.();
if (effectiveUid === undefined) throw new Error("archive_TEST_requires_native_effective_uid");
const nativePrivilege = effectiveUid === 0 ? ArchiveTestPrivilege.Root : ArchiveTestPrivilege.Nonroot;
const requestedPrivilege = process.env.SR_ARCHIVE_TEST_PRIVILEGE;
if (requestedPrivilege !== undefined && requestedPrivilege !== nativePrivilege) {
  throw new Error("archive_TEST_privilege_lane_mismatch");
}

if (nativePrivilege === ArchiveTestPrivilege.Nonroot) {
  it("native nonroot archive boundary refuses before permit or controller IO", async () => {
    expect(process.geteuid?.()).not.toBe(0);
    const root = await realpath(await mkdtemp(join(tmpdir(), "sr-archive-nonroot-TEST-")));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const args: Parameters<typeof readReviewedArchivePermit>[0] = {
      controllerJobId: "TEST-nonroot-controller", reviewedOutputId: "0".repeat(64),
      permitFile: join(root, "TEST-absent-permit.json"), expectedPermitSha256: "0".repeat(64),
    };
    const canonicalDirectory = vi.spyOn(LocalProjectControlEvidenceCustody.prototype, "canonicalDirectory");
    await expect(readReviewedArchivePermit(args)).rejects.toThrow("reviewed_archive_root_required");
    await expect(projectControlArchiveReviewedOutput(args)).rejects.toThrow("reviewed_archive_root_required");
    expect(canonicalDirectory).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });
}

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "sr-approved-archive-TEST-")));
  // Native tmux observation uses a disposable TEST socket directory. No session
  // is started; absence is independently observed, not synthesized by a mock.
  vi.stubEnv("TMUX_TMPDIR", root);
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const registryRootDir = join(root, "jobs", "registry");
  const source = join(root, "workspaces", "TEST-worker"), canonical = join(root, "workspaces", "TEST-main");
  const ledgerRoot = join(root, "jobs", "ledger"), evidenceRoot = join(root, "jobs", "archives");
  const controllerJobId = "TEST-controller", workerJobId = "TEST-worker";
  for (const path of [canonical, ledgerRoot, evidenceRoot, join(root, "worktrees")]) await mkdir(path, { recursive: true });
  await git(canonical, "init", "-b", "main");
  await git(canonical, "config", "user.name", "iliya");
  await git(canonical, "config", "user.email", "iliyazelenkog@gmail.com");
  await writeFile(join(canonical, "a.txt"), "before\n");
  await writeFile(join(canonical, "deleted.txt"), "old\n");
  await git(canonical, "add", "-A"); await git(canonical, "commit", "-m", "chore(test): original TEST base");
  await git(root, "clone", canonical, source);
  await writeFile(join(source, "a.txt"), "historically approved\n");
  await writeFile(join(source, "new.txt"), "approved addition\n");
  await writeFile(join(source, "binary.dat"), Buffer.from([0, 255, 1, 2]));
  await rm(join(source, "deleted.txt"));
  await writeFile(join(canonical, "a.txt"), "accepted subsequent correction\n");
  await git(canonical, "add", "-A"); await git(canonical, "commit", "-m", "fix(test): independent TEST correction");
  const scope: ProjectAccessScope = { projectId: "TEST-project", readRoots: [root],
    workspaceRoots: [join(root, "workspaces")], worktreeRoots: [join(root, "worktrees")],
    registryRoot: registryRootDir, jobIdPrefixes: ["TEST-"], tmuxSessionPrefixes: ["TEST-"],
    allowedAccountIds: ["TEST-account"], allowedGitRemotes: [], allowedBranches: ["main"],
    consumedOutputLedgerRoots: [ledgerRoot], consumedOutputEvidenceRoots: [evidenceRoot] };
  for (const [jobId, workspacePath, boundary] of [[controllerJobId, canonical, AccessBoundary.ProjectScopedControl],
    [workerJobId, source, AccessBoundary.IsolatedWorkspaceWrite]] as const) {
    const jobRootDir = join(root, "jobs", jobId);
    await mkdir(jobRootDir); await writeFile(join(jobRootDir, "prompt.md"), "Disposable TEST task\n");
    await createCodexGoalJob({ registryRootDir, manifest: { jobId, jobRootDir, workspacePath,
      promptPath: join(jobRootDir, "prompt.md"), taskId: jobId, accounts: ["TEST-account"],
      accessBoundary: boundary, projectAccessScope: scope, networkAccess: NetworkAccessMode.Restricted,
      tmuxSession: `TEST-archive-${process.pid}-${root.split("/").at(-1)}` } });
  }
  const jobRootDir = join(root, "jobs", workerJobId);
  const resultPath = codexGoalOutputPath({ jobRootDir, taskId: workerJobId });
  await writeFile(resultPath, archiveBytes({ status: "done", changedFiles: ["a.txt", "new.txt", "binary.dat", "deleted.txt"],
    evidence: [], blockers: [], nextAction: "review_completed" }));
  const server = createCodexGoalMcpServer(), client = new Client({ name: "approved-archive-TEST", version: "0.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  cleanups.push(async () => { await client.close(); await server.close(); });
  const reviewed = localReviewedWorkerOutputDeps({ rootDir: reviewedWorkerOutputRoot(registryRootDir) });
  const capture = await reviewed.snapshotter.capture({ workspacePath: source });
  const review = await callToolJson(client, "codex_goal_project_mark_reviewed", { registryRootDir, controllerJobId,
    jobId: workerJobId, captureReviewedOutput: true, reviewDecision: ReviewDecisionStatus.Approved,
    expectedPatchSha256: archiveHash(capture.patch), reviewedBy: "TEST-independent-reviewer",
    reviewReason: "Historically valid TEST output", approvedFiles: capture.changedFiles, requiredChecks: [] });
  expect(review.ok).toBe(true);
  const snapshot = await reviewed.store.get(String(review.reviewedOutputId)); expect(snapshot).toBeDefined();
  const snap = snapshot!, snapshotRoot = join(reviewedWorkerOutputRoot(registryRootDir), snap.reviewedOutputId);
  const approvalFile = "review-attestation.json";
  const approval = await readFile(join(snapshotRoot, approvalFile));
  const binding = JSON.parse(approval.toString()) as { reviewMarkerSha256: string };
  const [evidenceIdentity, ledgerIdentity] = await recoveryDirectoryIdentities([evidenceRoot, ledgerRoot]);
  const permit: ReviewedArchivePermit = { schemaVersion: 1, operation: "archive_reviewed_output", controllerJobId,
    projectId: scope.projectId, workerJobId, taskId: workerJobId, registryRootDir, workerJobRootDir: jobRootDir,
    sourceWorkspace: source, controllerManifestSha256: archiveHash(await readFile(codexGoalJobManifestPath({ registryRootDir, jobId: controllerJobId }))),
    workerManifestSha256: archiveHash(await readFile(codexGoalJobManifestPath({ registryRootDir, jobId: workerJobId }))),
    reviewedOutputId: snap.reviewedOutputId, snapshotSha256: archiveHash(await readFile(join(snapshotRoot, "manifest.json"))),
    patchSha256: snap.patchSha256, reviewDecisionSha256: archiveHash(JSON.stringify(snap.reviewDecision)),
    approvalFile, approvalSha256: archiveHash(approval), reviewMarkerSha256: binding.reviewMarkerSha256,
    archivePath: join(evidenceRoot, `approved-archive-${snap.reviewedOutputId}`), evidenceRoot: evidenceIdentity!, ledgerRoot: ledgerIdentity!,
    owner: "TEST-root-owner", reason: "Superseded by independently accepted TEST correction; retain historical approval",
    requestedAt: "2026-10-06T13:00:00.000Z" };
  const permitFile = join(root, "archive-intent.json");
  const savePermit = async (value = permit) => { const bytes = archiveBytes(value); await writeFile(permitFile, bytes, { mode: 0o600 }); return archiveHash(bytes); };
  let expectedPermitSha256 = await savePermit();
  const permitIdentity = await stat(permitFile);
  expect(permitIdentity.uid).toBe(0);
  expect(permitIdentity.mode & 0o777).toBe(0o600);
  const run = (confirmArchive = true) => callToolJson(client, "codex_goal_project_archive_reviewed_output", {
    registryRootDir, controllerJobId, reviewedOutputId: snap.reviewedOutputId, permitFile, expectedPermitSha256,
    ...(confirmArchive ? { confirmArchive: true } : {}) });
  const admission = () => callToolJson(client, "codex_goal_project_admission_snapshot", {
    registryRootDir, controllerJobId, operation: "create_job", workerRole: "producer" });
  const readLedger = () => readCodexGoalConsumedOutputLedgers({ roots: [ledgerRoot], evidenceRoots: [evidenceRoot] });
  const archiveFile = (name: string) => join(permit.archivePath, name);
  return { root, source, canonical, ledgerRoot, evidenceRoot, snapshotRoot, permitFile, permit, snapshot: snap, resultPath, client,
    progressPath: codexGoalProgressPath({ jobRootDir, taskId: workerJobId }), run, admission, readLedger, archiveFile,
    update: async (change: Partial<ReviewedArchivePermit>, rebind = true) => { Object.assign(permit, change);
      const hash = await savePermit(); if (rebind) expectedPermitSha256 = hash; },
    noDecision: async () => { expect((await readLedger()).byJobId.size).toBe(0);
      expect(await new LocalProjectControlEvidenceCustody().pathKind(join(ledgerRoot, "items", "TEST-worker.json"))).toBe("absent"); },
    noArchive: async () => {
      const custody = new LocalProjectControlEvidenceCustody();
      expect(await custody.pathKind(permit.archivePath)).toBe("absent");
      expect(await custody.pathKind(`${permit.archivePath}.preparation.json`)).toBe("absent");
    },
  };
}

if (nativePrivilege === ArchiveTestPrivilege.Root && localProjectControlEvidenceCustodySupported) {
describe("approved output retained archive through native root MCP on disposable TEST identities", () => {
  it("unblocks ordinary producer admission for inapplicable historical approval while retaining source and approval bytes", async () => {
    const f = await fixture();
    await expect(git(f.canonical, "apply", "--check", f.snapshot.patchPath)).rejects.toThrow();
    expect(await f.admission()).toMatchObject({ decision: { allowed: false, reason: "output_debt_present" } });
    const paths = [f.snapshot.patchPath, join(f.snapshotRoot, "manifest.json"), join(f.snapshotRoot, f.permit.approvalFile),
      join(f.source, "a.txt"), join(f.source, "new.txt"), join(f.source, "binary.dat"), join(f.source, ".git", "index"), f.resultPath];
    const before = await Promise.all(paths.map(path => readFile(path)));
    const canonicalHead = await git(f.canonical, "rev-parse", "HEAD");
    expect(await f.run()).toMatchObject({ ok: true, disposition: "archived", result: { idempotentReplay: false } });
    const ledger = await f.readLedger(); expect(ledger.byJobId.get("TEST-worker")).toMatchObject({ valid: true, status: "archived" });
    expect(await f.admission()).toMatchObject({ decision: { allowed: true } });
    expect(await Promise.all(paths.map(path => readFile(path)))).toEqual(before);
    expect(await git(f.canonical, "rev-parse", "HEAD")).toBe(canonicalHead);
    expect(await readFile(f.archiveFile("tracked.diff"))).toEqual(before[0]);
    expect(await readFile(f.archiveFile("original-manifest.json"))).toEqual(before[1]);
    expect(await readFile(f.archiveFile("original-approval.json"))).toEqual(before[2]);
    expect((await readFile(f.archiveFile("tracked.numstat"), "utf8"))).toContain("new.txt");
    expect(f.snapshot.reviewDecision.decision).toBe(ReviewDecisionStatus.Approved);
  });
  it("preview validates the exact stopped source and creates zero archives or ledger entries", async () => {
    const f = await fixture(); expect(await f.run(false)).toMatchObject({ ok: false, reason: "confirm_archive_required" });
    await f.noDecision(); await f.noArchive();
    await writeFile(join(f.source, "new.txt"), "drift\n");
    expect(await f.run(false)).toMatchObject({ ok: false, error: "reviewed_worker_output_workspace_changed_after_capture" });
    await f.noDecision(); await f.noArchive();
  });
  it.each(["patchSha256", "snapshotSha256", "approvalSha256", "reviewDecisionSha256", "controllerManifestSha256", "workerManifestSha256"] as const)(
    "refuses stale/wrong immutable %s without terminal decision or archive", async field => {
      const f = await fixture(); await f.update({ [field]: "f".repeat(64) });
      expect(await f.run()).toMatchObject({ ok: false }); await f.noDecision(); await f.noArchive();
    });
  it.each(["controllerJobId", "workerJobId", "projectId", "taskId", "workerJobRootDir", "sourceWorkspace", "archivePath"] as const)(
    "refuses wrong owner intent binding %s", async field => {
      const f = await fixture(); await f.update({ [field]: field.endsWith("Dir") || field.endsWith("Workspace") || field === "archivePath" ? join(f.root, "external") : "OTHER" });
      expect(await f.run()).toMatchObject({ ok: false }); await f.noDecision();
    });
  it("refuses owner change under stale request hash and insecure/symlink/nonroot permits", async () => {
    const f = await fixture(); await f.update({ owner: "TEST-different-owner" }, false);
    expect(await f.run()).toMatchObject({ error: "reviewed_archive_permit_hash_mismatch" });
    await f.update({ owner: "TEST-root-owner" }); await chmod(f.permitFile, 0o644);
    expect(await f.run()).toMatchObject({ error: "reviewed_archive_permit_security_invalid" });
    await chmod(f.permitFile, 0o600); await rename(f.permitFile, `${f.permitFile}.real`); await symlink(`${f.permitFile}.real`, f.permitFile);
    expect(await f.run()).toMatchObject({ ok: false }); await rm(f.permitFile); await rename(`${f.permitFile}.real`, f.permitFile);
    vi.spyOn(process, "geteuid").mockReturnValue(1234);
    expect(await f.run()).toMatchObject({ error: "reviewed_archive_root_required" }); await f.noDecision(); await f.noArchive();
  });
  it("refuses live PID, stale live PID and unreadable/uncertain progress; age never establishes death", async () => {
    const f = await fixture();
    for (const updatedAt of [new Date().toISOString(), "2020-01-01T00:00:00.000Z"]) {
      await writeFile(f.progressPath, archiveBytes({ pid: process.pid, status: "running", updatedAt }));
      expect(await f.run()).toMatchObject({ error: "reviewed_archive_source_not_quiescent" });
    }
    await writeFile(f.progressPath, "invalid json");
    expect(await f.run()).toMatchObject({ error: "reviewed_archive_source_not_quiescent" }); await f.noDecision(); await f.noArchive();
  });
  it("refuses removed approval, original patch tampering and genuine postapproval source drift", async () => {
    const f = await fixture(); const approval = join(f.snapshotRoot, f.permit.approvalFile);
    await rename(approval, `${approval}.saved`); expect(await f.run()).toMatchObject({ ok: false }); await rename(`${approval}.saved`, approval);
    const patch = await readFile(f.snapshot.patchPath); await writeFile(f.snapshot.patchPath, "tampered\n");
    expect(await f.run()).toMatchObject({ ok: false }); await writeFile(f.snapshot.patchPath, patch);
    await writeFile(join(f.source, "unapproved.txt"), "later output\n");
    expect(await f.run()).toMatchObject({ error: "reviewed_worker_output_workspace_changed_after_capture" }); await f.noDecision(); await f.noArchive();
  });
  it("refuses changed root inode, symlink, external archive and denied custody without bootstrapping", async () => {
    const f = await fixture(); await rename(f.evidenceRoot, `${f.evidenceRoot}.saved`); await mkdir(f.evidenceRoot);
    expect(await f.run()).toMatchObject({ error: "project_control_recovery_directory_identity_drift" }); await f.noArchive();
    await rm(f.evidenceRoot, { recursive: true }); await symlink(`${f.evidenceRoot}.saved`, f.evidenceRoot);
    expect(await f.run()).toMatchObject({ ok: false }); await rm(f.evidenceRoot); await rename(`${f.evidenceRoot}.saved`, f.evidenceRoot);
    await f.update({ archivePath: join(f.root, "external-archive") }); expect(await f.run()).toMatchObject({ error: "reviewed_archive_scope_binding_mismatch" });
    await f.noArchive(); await f.noDecision();
  });
  it("publishes exactly once, verifies retained receipt on replay and refuses conflicting intent", async () => {
    const f = await fixture(); const first = await f.run(); expect(first.ok).toBe(true);
    const receipt = await readFile(f.archiveFile("approved-output-archive.json"));
    // Exact committed replay requires no mutable source recapture.
    await writeFile(join(f.source, "later.txt"), "later output\n");
    const replay = await f.run(); expect(replay, JSON.stringify(replay)).toMatchObject({ ok: true, result: { idempotentReplay: true } });
    expect(await readFile(f.archiveFile("approved-output-archive.json"))).toEqual(receipt);
    await f.update({ reason: "A conflicting conscious disposition" });
    expect(await f.run()).toMatchObject({ error: "reviewed_archive_preparation_conflict" });
    expect((await f.readLedger()).byJobId.size).toBe(1);
  });
  it("recovers interrupted immutable backup publication and refuses a different partial-preparation owner", async () => {
    const f = await fixture(); let fail = true;
    const original = LocalProjectControlEvidenceCustody.prototype.publishImmutableBytes;
    vi.spyOn(LocalProjectControlEvidenceCustody.prototype, "publishImmutableBytes").mockImplementation(async function(this: LocalProjectControlEvidenceCustody, input) {
      const result = await original.call(this, input);
      if (input.fileName === "tracked.diff" && fail) { fail = false; throw new Error("TEST_interrupted_after_backup"); }
      return result;
    });
    expect(await f.run()).toMatchObject({ error: "TEST_interrupted_after_backup" }); await f.noDecision();
    expect(await readFile(f.archiveFile("tracked.diff"))).toEqual(await readFile(f.snapshot.patchPath));
    expect(await new LocalProjectControlEvidenceCustody().pathKind(f.archiveFile("approved-output-archive.json"))).toBe("absent");
    const owner = f.permit.owner; await f.update({ owner: "TEST-conflicting-owner" });
    expect(await f.run()).toMatchObject({ error: "reviewed_archive_preparation_conflict" }); await f.noDecision();
    await f.update({ owner }); expect(await f.run()).toMatchObject({ ok: true, result: { idempotentReplay: false } });
  });
  it("a failure after verified backup/receipt cannot publish a false or partial terminal decision", async () => {
    const f = await fixture(); const original = LocalProjectControlEvidenceCustody.prototype.publishImmutableBytes;
    vi.spyOn(LocalProjectControlEvidenceCustody.prototype, "publishImmutableBytes").mockImplementation(async function(this: LocalProjectControlEvidenceCustody, input) {
      const result = await original.call(this, input);
      if (input.fileName === "approved-output-archive.json") throw new Error("TEST_after_verified_receipt");
      return result;
    });
    expect(await f.run()).toMatchObject({ error: "TEST_after_verified_receipt" }); await f.noDecision();
    expect(await readFile(f.archiveFile("approved-output-archive.json"))).toBeDefined(); vi.restoreAllMocks();
    await writeFile(join(f.source, "drift.txt"), "drift after receipt\n");
    expect(await f.run()).toMatchObject({ error: "reviewed_worker_output_workspace_changed_after_capture" }); await f.noDecision();
    await rm(join(f.source, "drift.txt")); expect(await f.run()).toMatchObject({ ok: true });
  });
  it("preserves configured directory identities across async backup IO and refuses subsequent publication to a replacement", async () => {
    const f = await fixture(); const original = LocalProjectControlEvidenceCustody.prototype.publishImmutableBytes;
    vi.spyOn(LocalProjectControlEvidenceCustody.prototype, "publishImmutableBytes").mockImplementation(async function(this: LocalProjectControlEvidenceCustody, input) {
      const result = await original.call(this, input);
      if (input.fileName === "tracked.diff") { await rename(f.evidenceRoot, `${f.evidenceRoot}.saved`); await mkdir(f.evidenceRoot); }
      return result;
    });
    expect(await f.run()).toMatchObject({ error: "project_control_recovery_directory_identity_drift" }); await f.noDecision(); await f.noArchive();
  });
  it("native ledger retirement after verified backup refuses consumption; receipt recovery reuses the same archive", async () => {
    const f = await fixture(); const original = LocalProjectControlEvidenceCustody.prototype.publishImmutableBytes;
    const marker = join(f.ledgerRoot, CONSUMED_OUTPUT_LEDGER_RETIRED_MARKER);
    vi.spyOn(LocalProjectControlEvidenceCustody.prototype, "publishImmutableBytes").mockImplementation(async function(this: LocalProjectControlEvidenceCustody, input) {
      const result = await original.call(this, input);
      if (input.fileName === "approved-output-archive.json") await writeFile(marker, "TEST retired ledger\n");
      return result;
    });
    expect(await f.run()).toMatchObject({ error: "consumed_output_ledger_root_retired" }); await f.noDecision();
    const receipt = await readFile(f.archiveFile("approved-output-archive.json")); vi.restoreAllMocks(); await rm(marker);
    expect(await f.run()).toMatchObject({ ok: true }); expect(await readFile(f.archiveFile("approved-output-archive.json"))).toEqual(receipt);
  });
  it("a native reviewed rejection for the same job prevents competing archive disposition", async () => {
    const f = await fixture(); const approval = await readFile(join(f.snapshotRoot, f.permit.approvalFile));
    expect(await callToolJson(f.client, "codex_goal_project_mark_reviewed", { registryRootDir: f.permit.registryRootDir,
      controllerJobId: f.permit.controllerJobId, jobId: f.permit.workerJobId, captureReviewedOutput: true,
      reviewDecision: ReviewDecisionStatus.Rejected, expectedPatchSha256: f.snapshot.patchSha256,
      reviewedBy: "TEST-other-review", reviewReason: "Competing TEST-only disposition", approvedFiles: f.snapshot.changedFiles, requiredChecks: [] })).toMatchObject({ ok: true });
    expect(await f.run()).toMatchObject({ error: "consumed_output_ledger_terminal_conflict" }); await f.noArchive();
    expect(await readFile(join(f.snapshotRoot, f.permit.approvalFile))).toEqual(approval);
    expect((await f.readLedger()).byJobId.get("TEST-worker")?.status).toBe("rejected");
  });
  it("denied custody and traversal refuse without creating an archive", async () => {
    const f = await fixture(); const manifestPath = codexGoalJobManifestPath({ registryRootDir: f.permit.registryRootDir, jobId: f.permit.controllerJobId });
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { projectAccessScope: ProjectAccessScope };
    manifest.projectAccessScope = { ...manifest.projectAccessScope, deniedRoots: [f.evidenceRoot] };
    await writeFile(manifestPath, archiveBytes(manifest)); await f.update({ controllerManifestSha256: archiveHash(await readFile(manifestPath)) });
    expect(await f.run()).toMatchObject({ error: "project_control_consumed_output_evidence_root_denied" }); await f.noDecision(); await f.noArchive();
    await f.update({ archivePath: `${f.evidenceRoot}/../traversal` }); expect(await f.run()).toMatchObject({ ok: false });
    expect(await new LocalProjectControlEvidenceCustody().pathKind(join(f.root, "jobs", "traversal"))).toBe("absent");
  });
  it("missing native worker observation and a nonstrict result cannot prove source quiescence", async () => {
    const f = await fixture(); await writeFile(f.resultPath, archiveBytes({ status: "done" }));
    expect(await f.run()).toMatchObject({ error: "reviewed_archive_source_not_quiescent" }); await f.noDecision(); await f.noArchive();
    const path = codexGoalJobManifestPath({ registryRootDir: f.permit.registryRootDir, jobId: f.permit.workerJobId });
    const manifest = JSON.parse(await readFile(path, "utf8")) as { tmuxSession?: string }; delete manifest.tmuxSession;
    await writeFile(path, archiveBytes(manifest)); await f.update({ workerManifestSha256: archiveHash(await readFile(path)) });
    await writeFile(f.resultPath, archiveBytes({ status: "done", changedFiles: f.snapshot.changedFiles, evidence: [], blockers: [], nextAction: "review_completed" }));
    expect(await f.run()).toMatchObject({ error: "reviewed_archive_source_not_quiescent" }); await f.noDecision(); await f.noArchive();
  });
  it("rejects wrong custody device and same-byte replacement of the retained archive inode", async () => {
    const f = await fixture(); const originalDevice = f.permit.evidenceRoot.device;
    await f.update({ evidenceRoot: { ...f.permit.evidenceRoot, device: originalDevice + 1 } });
    expect(await f.run()).toMatchObject({ error: "project_control_recovery_directory_identity_drift" }); await f.noDecision(); await f.noArchive();
    await f.update({ evidenceRoot: { ...f.permit.evidenceRoot, device: originalDevice } }); expect(await f.run()).toMatchObject({ ok: true });
    await rename(f.permit.archivePath, `${f.permit.archivePath}.saved`); await cp(`${f.permit.archivePath}.saved`, f.permit.archivePath, { recursive: true });
    expect(await f.run()).toMatchObject({ error: "project_control_recovery_directory_identity_drift" });
    expect((await f.readLedger()).byJobId.size).toBe(1);
  });
  it("retained backup tampering refuses replay instead of adopting changed recoverability evidence", async () => {
    const f = await fixture(); expect(await f.run()).toMatchObject({ ok: true });
    await writeFile(f.archiveFile("tracked.numstat"), "tampered\n");
    expect(await f.run()).toMatchObject({ error: "reviewed_archive_backup_hash_mismatch" });
    expect((await f.readLedger()).byJobId.size).toBe(1);
  });
  it("rechecks exact backup hashes inside the native ledger publication lock after asynchronous preflight", async () => {
    const f = await fixture(); const original = LocalConsumedOutputLedgerWriter.prototype.assertCanRecord;
    vi.spyOn(LocalConsumedOutputLedgerWriter.prototype, "assertCanRecord").mockImplementation(async function(this: LocalConsumedOutputLedgerWriter, input) {
      await original.call(this, input);
      await writeFile(input.decision.backup.patchPath!, "changed after verification\n");
    });
    expect(await f.run()).toMatchObject({ error: "reviewed_archive_backup_hash_mismatch" }); await f.noDecision();
    expect(await readFile(f.snapshot.patchPath, "utf8")).toContain("historically approved");
  });
  it("manifest drift after backup preflight invalidates immutable owner intent before native ledger consumption", async () => {
    const f = await fixture(); const original = LocalConsumedOutputLedgerWriter.prototype.assertCanRecord;
    const path = codexGoalJobManifestPath({ registryRootDir: f.permit.registryRootDir, jobId: f.permit.controllerJobId });
    const bytes = await readFile(path);
    vi.spyOn(LocalConsumedOutputLedgerWriter.prototype, "assertCanRecord").mockImplementation(async function(this: LocalConsumedOutputLedgerWriter, input) {
      await original.call(this, input); await writeFile(path, Buffer.concat([bytes, Buffer.from("\n")]));
    });
    expect(await f.run()).toMatchObject({ error: "reviewed_archive_manifest_binding_mismatch" }); await f.noDecision();
  });
});

describe("R1-R5 independent archive attacks on disposable TEST identities", () => {
  it.each(["source drift", "live progress", "removed approval"] as const)(
    "R1 refuses %s after real native writer preflight with zero consumption", async attack => {
      const f = await fixture();
      const original = LocalConsumedOutputLedgerWriter.prototype.assertCanRecord;
      let injected = false;
      vi.spyOn(LocalConsumedOutputLedgerWriter.prototype, "assertCanRecord").mockImplementation(async function(this: LocalConsumedOutputLedgerWriter, input) {
        await original.call(this, input);
        if (injected) return;
        injected = true;
        if (attack === "source drift") await writeFile(join(f.source, "new.txt"), "TEST late source drift\n");
        if (attack === "live progress") await writeFile(f.progressPath, archiveBytes({ pid: process.pid, status: "running" }));
        if (attack === "removed approval") await rm(join(f.snapshotRoot, f.permit.approvalFile));
      });
      const response = await f.run();
      expect(injected).toBe(true);
      // Check the actual ledger even if the response assertion fails on old code.
      const ledger = await f.readLedger();
      expect.soft(response).toMatchObject({ ok: false });
      expect.soft(ledger.byJobId.size).toBe(0);
      await f.noDecision();
    });

  it("R2 refuses items symlink swapped at the third real tracked.numstat read, with no outside publication", async () => {
    const f = await fixture();
    const outside = join(f.root, "TEST-outside-ledger"), items = join(f.ledgerRoot, "items");
    await mkdir(outside); await mkdir(items, { recursive: true });
    const original = LocalProjectControlEvidenceCustody.prototype.readImmutableFile;
    let reads = 0, injected = false;
    vi.spyOn(LocalProjectControlEvidenceCustody.prototype, "readImmutableFile").mockImplementation(async function(this: LocalProjectControlEvidenceCustody, path, maxBytes) {
      const result = await original.call(this, path, maxBytes);
      if (path === f.archiveFile("tracked.numstat") && ++reads === 3) {
        injected = true;
        await rename(items, `${items}.TEST-held`); await symlink(outside, items);
      }
      return result;
    });
    const response = await f.run();
    expect(injected).toBe(true);
    const outsideFiles = await readdir(outside);
    expect.soft(response).toMatchObject({ ok: false });
    expect.soft(outsideFiles).toEqual([]);
    // The common reader must observe no terminal decision anywhere in TEST custody.
    expect.soft((await f.readLedger()).byJobId.size).toBe(0);
    await rm(items); await rename(`${items}.TEST-held`, items);
    await f.noDecision();
  });

  it("R3 refuses running progress with the live TEST PID encoded as a string", async () => {
    const f = await fixture();
    await writeFile(f.progressPath, archiveBytes({ status: "running", pid: String(process.pid), updatedAt: new Date().toISOString() }));
    const response = await f.run();
    expect.soft(response).toMatchObject({ ok: false });
    await f.noDecision(); await f.noArchive();
  });

  it.each(["backup and receipt", "directory and receipt"] as const)(
    "R4 refuses paired %s replacement on native committed replay", async attack => {
      const f = await fixture(); expect(await f.run()).toMatchObject({ ok: true, result: { idempotentReplay: false } });
      const ledgerPath = join(f.ledgerRoot, "items", "TEST-worker.json"), ledgerBefore = await readFile(ledgerPath);
      const receipt = JSON.parse(await readFile(f.archiveFile("approved-output-archive.json"), "utf8")) as {
        files: Record<string, string>; archiveDirectory: ReviewedArchivePermit["evidenceRoot"];
      };
      if (attack === "backup and receipt") {
        const bytes = Buffer.from("TEST substituted numstat\n");
        await writeFile(f.archiveFile("tracked.numstat"), bytes); receipt.files["tracked.numstat"] = archiveHash(bytes);
      } else {
        await rename(f.permit.archivePath, `${f.permit.archivePath}.TEST-held`);
        await cp(`${f.permit.archivePath}.TEST-held`, f.permit.archivePath, { recursive: true });
        receipt.archiveDirectory = (await recoveryDirectoryIdentities([f.permit.archivePath]))[0]!;
      }
      await writeFile(f.archiveFile("approved-output-archive.json"), archiveBytes(receipt));
      expect.soft(await f.run()).toMatchObject({ ok: false });
      expect(await readFile(ledgerPath)).toEqual(ledgerBefore);
      expect((await f.readLedger()).byJobId.size).toBe(1);
      expect(await readFile(join(f.snapshotRoot, f.permit.approvalFile))).toEqual(await readFile(f.archiveFile("original-approval.json")));
    });

  it("R5 refuses result symlink to an unrelated strict done TEST payload", async () => {
    const f = await fixture(), outside = join(f.root, "TEST-unrelated-result.json");
    const bytes = await readFile(f.resultPath); await writeFile(outside, bytes);
    await rm(f.resultPath); await symlink(outside, f.resultPath);
    expect.soft(await f.run()).toMatchObject({ ok: false });
    await f.noDecision(); await f.noArchive();
    expect(await readFile(outside)).toEqual(bytes);
  });

  it.each(["source drift", "live progress", "removed approval"] as const)(
    "R1 publication guard refuses %s after actual native ledger staging", async attack => {
      const f = await fixture(), items = join(f.ledgerRoot, "items");
      const original = LocalConsumedOutputLedgerMutationLock.prototype.assertHeld;
      let injected = false;
      vi.spyOn(LocalConsumedOutputLedgerMutationLock.prototype, "assertHeld").mockImplementation(async function(this: LocalConsumedOutputLedgerMutationLock, lease) {
        await original.call(this, lease);
        const staged = await readdir(items).catch(() => [] as string[]);
        if (!injected && staged.some(name => name.startsWith(".custody-publish-") && name.endsWith(".tmp"))) {
          injected = true;
          if (attack === "source drift") await writeFile(join(f.source, "new.txt"), "TEST drift during native staging\n");
          if (attack === "live progress") await writeFile(f.progressPath, archiveBytes({ pid: process.pid, status: "running" }));
          if (attack === "removed approval") await rm(join(f.snapshotRoot, f.permit.approvalFile));
        }
      });
      expect(await f.run()).toMatchObject({ ok: false }); expect(injected).toBe(true);
      await f.noDecision();
    });

  it.each([undefined, null, 0, -1, 1.5, "123", {}])(
    "R3 refuses active progress without a usable PID (%j)", async pid => {
      const f = await fixture();
      await writeFile(f.progressPath, archiveBytes({ status: "running", ...(pid === undefined ? {} : { pid }) }));
      expect(await f.run()).toMatchObject({ error: "reviewed_archive_source_not_quiescent" });
      await f.noDecision(); await f.noArchive();
    });

  it("R3 preserves absent progress and genuinely stopped progress without a PID", async () => {
    const f = await fixture();
    expect(await new LocalProjectControlEvidenceCustody().pathKind(f.progressPath)).toBe("absent");
    expect(await f.run(false)).toMatchObject({ reason: "confirm_archive_required" });
    await writeFile(f.progressPath, archiveBytes({ status: "stopped" }));
    expect(await f.run()).toMatchObject({ ok: true, result: { idempotentReplay: false } });
  });

  it.each(["backup and receipt", "directory and receipt"] as const)(
    "R4 interrupted preparation refuses paired %s replacement with zero consumption", async attack => {
      const f = await fixture();
      const original = LocalProjectControlEvidenceCustody.prototype.publishImmutableBytes;
      vi.spyOn(LocalProjectControlEvidenceCustody.prototype, "publishImmutableBytes").mockImplementation(async function(this: LocalProjectControlEvidenceCustody, input) {
        const result = await original.call(this, input);
        if (input.fileName === "approved-output-archive.json") throw new Error("TEST_interrupt_before_consumption");
        return result;
      });
      expect(await f.run()).toMatchObject({ error: "TEST_interrupt_before_consumption" }); await f.noDecision();
      vi.restoreAllMocks();
      const receipt = JSON.parse(await readFile(f.archiveFile("approved-output-archive.json"), "utf8")) as {
        files: Record<string, string>; archiveDirectory: ReviewedArchivePermit["evidenceRoot"];
      };
      if (attack === "backup and receipt") {
        const bytes = Buffer.from("TEST paired replacement after preparation\n");
        await writeFile(f.archiveFile("tracked.numstat"), bytes); receipt.files["tracked.numstat"] = archiveHash(bytes);
      } else {
        await rename(f.permit.archivePath, `${f.permit.archivePath}.TEST-held`);
        await cp(`${f.permit.archivePath}.TEST-held`, f.permit.archivePath, { recursive: true });
        receipt.archiveDirectory = (await recoveryDirectoryIdentities([f.permit.archivePath]))[0]!;
      }
      await writeFile(f.archiveFile("approved-output-archive.json"), archiveBytes(receipt));
      expect(await f.run()).toMatchObject({ ok: false }); await f.noDecision();
    });

  it("R4 committed replay verifies the native decision anchor even if preparation and receipt are changed together", async () => {
    const f = await fixture(); expect(await f.run()).toMatchObject({ ok: true });
    const ledgerPath = join(f.ledgerRoot, "items", "TEST-worker.json"), native = await readFile(ledgerPath);
    const receiptPath = f.archiveFile("approved-output-archive.json");
    const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as { files: Record<string, string> };
    const changed = Buffer.from("TEST changed all mutable receipt evidence\n");
    await writeFile(f.archiveFile("tracked.numstat"), changed); receipt.files["tracked.numstat"] = archiveHash(changed);
    const receiptBytes = archiveBytes(receipt); await writeFile(receiptPath, receiptBytes);
    const preparationPath = `${f.permit.archivePath}.preparation.json`;
    const preparation = JSON.parse(await readFile(preparationPath, "utf8")) as { receiptSha256: string };
    preparation.receiptSha256 = archiveHash(receiptBytes); await writeFile(preparationPath, archiveBytes(preparation));
    expect(await f.run()).toMatchObject({ error: "reviewed_archive_receipt_anchor_mismatch" });
    expect(await readFile(ledgerPath)).toEqual(native);
  });

  it("R5 refuses malformed result bytes read from the canonical native result", async () => {
    const f = await fixture(); await writeFile(f.resultPath, "TEST invalid JSON\n");
    expect(await f.run()).toMatchObject({ error: "reviewed_archive_source_not_quiescent" });
    await f.noDecision(); await f.noArchive();
  });
});

}

describe.runIf(localProjectControlEvidenceCustodySupported)("native terminal writer descriptor confinement on disposable TEST identities", () => {
  it("R2 native terminal writer refuses an items symlink installed after the real mutation-lock check", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "sr-ledger-writer-TEST-")));
    const ledgerRoot = join(root, "TEST-ledger"), items = join(ledgerRoot, "items"), outside = join(root, "TEST-outside-ledger");
    await mkdir(items, { recursive: true }); await mkdir(outside);
    let injected = false;
    class RacingLocks extends LocalConsumedOutputLedgerMutationLock {
      override async assertHeld(lease: Parameters<LocalConsumedOutputLedgerMutationLock["assertHeld"]>[0]) {
        await super.assertHeld(lease);
        if (!injected) {
          injected = true;
          await rename(items, `${items}.TEST-held`); await symlink(outside, items);
        }
      }
    }
    try {
      const result = await new LocalConsumedOutputLedgerWriter(new RacingLocks()).record({ ledgerRoot, decision: {
        schemaVersion: 1, jobId: "TEST-terminal", status: "archived", closedAt: "2026-10-06T13:00:00.000Z",
        note: "Disposable TEST terminal writer", backup: { workspace: root, statusPath: join(root, "TEST-status.txt") },
      } }).then(() => "accepted", () => "refused");
      expect(injected).toBe(true);
      expect.soft(result).toBe("refused");
      expect.soft(await readdir(outside)).toEqual([]);
      expect(await readdir(`${items}.TEST-held`)).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("R2 native terminal writer retains items descriptor identity through staging and final link", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "sr-ledger-link-TEST-")));
    const ledgerRoot = join(root, "TEST-ledger"), items = join(ledgerRoot, "items"), outside = join(root, "TEST-outside-ledger");
    await mkdir(items, { recursive: true }); await mkdir(outside);
    let checks = 0, staged = false;
    class RacingLocks extends LocalConsumedOutputLedgerMutationLock {
      override async assertHeld(lease: Parameters<LocalConsumedOutputLedgerMutationLock["assertHeld"]>[0]) {
        await super.assertHeld(lease);
        if (++checks === 2) {
          staged = (await readdir(items)).some(name => name.startsWith(".custody-publish-") && name.endsWith(".tmp"));
          await rename(items, `${items}.TEST-held`); await symlink(outside, items);
        }
      }
    }
    try {
      await expect(new LocalConsumedOutputLedgerWriter(new RacingLocks()).record({ ledgerRoot, decision: {
        schemaVersion: 1, jobId: "TEST-terminal", status: "archived", closedAt: "2026-10-06T13:00:00.000Z",
        note: "Disposable TEST final publication race", backup: { workspace: root, statusPath: join(root, "TEST-status.txt") },
      } })).rejects.toThrow();
      expect(staged).toBe(true); expect(await readdir(outside)).toEqual([]);
      expect(await readdir(`${items}.TEST-held`)).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

if (nativePrivilege === ArchiveTestPrivilege.Root && localProjectControlEvidenceCustodySupported) {
it("retains a supported legacy native approval byte-for-byte through archive and exactly-once replay", async () => {
  const f = await fixture();
  // Match the deployed native approval format, retaining the real TEST review's
  // marker binding. The native store must recognize it as the approved snapshot.
  const currentPath = join(f.snapshotRoot, f.permit.approvalFile);
  const current = JSON.parse(await readFile(currentPath, "utf8")) as Record<string, unknown>;
  const approval = archiveBytes({ ...current, format: "reviewed-worker-output-approval" });
  const approvalPath = join(f.snapshotRoot, "approval.json");
  await writeFile(approvalPath, approval); await rm(currentPath);
  await f.update({ approvalFile: "approval.json", approvalSha256: archiveHash(approval) });
  expect(await f.run()).toMatchObject({ ok: true, result: { idempotentReplay: false } });
  expect(await f.run()).toMatchObject({ ok: true, result: { idempotentReplay: true } });
  expect(await readFile(approvalPath)).toEqual(approval);
  expect(await readFile(f.archiveFile("original-approval.json"))).toEqual(approval);
  expect((await f.readLedger()).byJobId.size).toBe(1);
});
}

// Only process.platform is simulated; all writer IO, locks and publication are
// real operations in disposable TEST directories on the native Linux host.
async function withDarwinWriter(check: (Writer: typeof LocalConsumedOutputLedgerWriter) => Promise<void>) {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  if (!descriptor) throw new Error("TEST_platform_descriptor_missing");
  Object.defineProperty(process, "platform", { ...descriptor, value: "darwin" });
  vi.resetModules();
  try {
    const { LocalConsumedOutputLedgerWriter: Writer } = await import("../../worker-local/consumed-output-ledger-local-adapter");
    await check(Writer);
  } finally {
    Object.defineProperty(process, "platform", descriptor);
    vi.resetModules();
  }
}

async function ordinaryWriterFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "sr-portable-writer-TEST-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const ledgerRoot = join(root, "TEST-ledger"), statusPath = join(root, "TEST-status.txt");
  await mkdir(ledgerRoot); await writeFile(statusPath, "TEST clean workspace\n");
  const decision = { schemaVersion: 1 as const, jobId: "TEST-portable-terminal", status: "failed_no_output" as const,
    closedAt: "2026-10-06T13:00:00.000Z", note: "Disposable TEST ordinary writer",
    failure: { category: "TEST", code: "TEST" }, output: { authoredChanges: false, workspaceDirty: false },
    backup: { workspace: root, statusPath } };
  return { root, ledgerRoot, decision, ledgerPath: join(ledgerRoot, "items", `${decision.jobId}.json`) };
}

describe("R6 ordinary writer darwin platform contract simulation with real TEST filesystem IO", () => {
  it("preflights an absent ordinary terminal record without requesting Linux custody", async () => {
    const f = await ordinaryWriterFixture();
    await withDarwinWriter(async Writer => {
      await expect(new Writer().assertCanRecord(f)).resolves.toBeUndefined();
      expect(await readdir(f.ledgerRoot)).toEqual([]);
    });
  });

  it("publishes and semantically replays an ordinary decision, refusing conflicting preflight and record", async () => {
    const f = await ordinaryWriterFixture();
    await withDarwinWriter(async Writer => {
      const writer = new Writer();
      await expect(writer.record(f)).resolves.toMatchObject({ ledgerPath: f.ledgerPath, idempotentReplay: false });
      const record = JSON.parse(await readFile(f.ledgerPath, "utf8")) as Record<string, unknown>;
      expect(record).toMatchObject({ ...f.decision, consumedAt: f.decision.closedAt });
      // Replay compares decisions, preserving an existing differently formatted record.
      await writeFile(f.ledgerPath, JSON.stringify(record));
      const before = await readFile(f.ledgerPath);
      await expect(writer.assertCanRecord(f)).resolves.toBeUndefined();
      await expect(writer.record(f)).resolves.toMatchObject({ idempotentReplay: true });
      const conflict = { ...f, decision: { ...f.decision, note: "TEST conflicting intent" } };
      await expect(writer.assertCanRecord(conflict)).rejects.toThrow("consumed_output_ledger_terminal_conflict");
      await expect(writer.record(conflict)).rejects.toThrow("consumed_output_ledger_terminal_conflict");
      expect(await readFile(f.ledgerPath)).toEqual(before);
      expect(await readdir(join(f.ledgerRoot, "items"))).toEqual([`${f.decision.jobId}.json`]);
    });
  });

  it("keeps real maintenance exclusion and retirement checks in ordinary portable mode", async () => {
    const f = await ordinaryWriterFixture();
    await withDarwinWriter(async Writer => {
      const writer = new Writer();
      const lease = await acquireConsumedOutputLedgerMaintenanceLock({ ledgerRoot: f.ledgerRoot, owner: "TEST-R6-migration" });
      try { await expect(writer.record(f)).rejects.toThrow("consumed_output_ledger_maintenance_locked"); }
      finally { await releaseConsumedOutputLedgerMaintenanceLock(lease); }
      await expect(writer.record(f)).resolves.toMatchObject({ idempotentReplay: false });
      const before = await readFile(f.ledgerPath);
      await writeFile(join(f.ledgerRoot, CONSUMED_OUTPUT_LEDGER_RETIRED_MARKER), "TEST retired ledger\n");
      await expect(writer.assertCanRecord(f)).rejects.toThrow("consumed_output_ledger_root_retired");
      await expect(writer.record(f)).rejects.toThrow("consumed_output_ledger_root_retired");
      expect(await readFile(f.ledgerPath)).toEqual(before);
    });
  });

  it.each(["custodyRoot", "evidenceRoots", "both"] as const)("keeps explicit %s fail closed on the simulated unsupported platform", async boundary => {
    const f = await ordinaryWriterFixture();
    await withDarwinWriter(async Writer => {
      const writer = new Writer(undefined, boundary === "evidenceRoots" ? undefined : f.root,
        boundary === "custodyRoot" ? undefined : [f.root]);
      await expect(writer.assertCanRecord(f)).rejects.toThrow("project_control_evidence_custody_platform_unsupported");
      await expect(writer.record(f)).rejects.toThrow("project_control_evidence_custody_platform_unsupported");
      await expect(stat(f.ledgerPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("does not treat an explicitly empty evidence boundary as ordinary mode", async () => {
    const f = await ordinaryWriterFixture();
    await withDarwinWriter(async Writer => {
      const writer = new Writer(undefined, undefined, []);
      await expect(writer.assertCanRecord(f)).rejects.toThrow("consumed_output_evidence_root_required");
      await expect(writer.record(f)).rejects.toThrow("consumed_output_evidence_root_required");
      await expect(stat(f.ledgerPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});
