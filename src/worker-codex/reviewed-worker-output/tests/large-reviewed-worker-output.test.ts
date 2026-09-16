import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import {
  AccessBoundary, ReviewDecisionStatus, SecretScanStatus,
  openProjectIntegrationAttempt, applyWorkerOutput, runRequiredChecks, commitApprovedChanges,
  type ProjectIntegrationPolicy,
} from "@vioxen/subscription-runtime/worker-core";
import { LocalGitIntegrationAdapter, LocalProjectCheckRunner, SimpleSecretScanner } from "@vioxen/subscription-runtime/worker-local";
import { LocalIntegrationAttemptStore } from "../../../store-local-file/local-integration-attempt-store";
import { MemoryAttemptStore } from "../../../worker-core/integration/tests/project-integration-use-cases.fixture";
import { localReviewedWorkerOutputDeps } from "../adapters/local-reviewed-worker-output-adapters";
import { LocalReviewedOutputIntegrationIntegrity } from "../adapters/local-reviewed-output-integration-integrity";
import { captureReviewedWorkerOutput, commitReviewedWorkerOutputReviewAttestation, resolveReviewedWorkerOutput, reviewedWorkerOutputId } from "../application/reviewed-worker-output-use-cases";
import { captureCodexGoalExactWorkspacePatch } from "../../codex-goal-handoff-artifacts";

const exec = promisify(execFile);
const roots: string[] = [];
const allowance = 8 * 1024 * 1024;
const report = "Reviewed report line.\n".repeat(230000).slice(0, 4678817) + "\n";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd, maxBuffer: 20 * 1024 * 1024 })).stdout.trim();
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture(includeBaseChange = false) {
  const root = await mkdtemp(join(tmpdir(), "large-reviewed-output-")); roots.push(root);
  const workspacePath = join(root, "worker");
  await mkdir(workspacePath);
  await git(workspacePath, "init", "-b", "main");
  await git(workspacePath, "config", "user.name", "Fixture");
  await git(workspacePath, "config", "user.email", "fixture@example.com");
  await writeFile(join(workspacePath, "base.md"), "base\n");
  await git(workspacePath, "add", ".");
  await git(workspacePath, "commit", "-m", "test: base");
  const target = join(root, "target");
  await git(root, "clone", workspacePath, target);
  await writeFile(join(workspacePath, "report.md"), report);
  if (includeBaseChange) await writeFile(join(workspacePath, "base.md"), "configured scanner sentinel\n");
  const deps = localReviewedWorkerOutputDeps({ rootDir: join(root, "reviewed") });
  const patch = (await captureCodexGoalExactWorkspacePatch({ workspacePath, limits: { maxFileBytes: allowance }, enforceSingleWorkspaceLayer: false }))!.patch;
  const input = {
    projectId: "project", controllerJobId: "controller", workerJobId: "worker", taskId: "task",
    workspacePath, expectedPatchSha256: hash(patch), decision: ReviewDecisionStatus.Approved,
    reviewedBy: "controller", reason: "Reviewed exact report", approvedFiles: includeBaseChange ? ["base.md", "report.md"] : ["report.md"],
    requiredChecks: [{ checkId: "report", command: [process.execPath, "-e", "process.exit(0)"] }],
    reviewedOutputFileByteAllowance: allowance,
  };
  return { root, workspacePath, target, deps, input, patch };
}

it.each([0, 1, 2])("delivers a real 4,678,818-byte reviewed report only with passing checks (exit %i)", async (checkExit) => {
  expect(Buffer.byteLength(report)).toBe(4678818);
  const f = await fixture();
  const snapshot = await captureReviewedWorkerOutput(f.deps, { ...f.input, requiredChecks: [{ checkId: "report", command: [process.execPath, "-e", `process.exit(${checkExit === 1 ? 1 : 0})`] }] });
  const markerPath = join(f.root, "review.json");
  await writeFile(markerPath, JSON.stringify({ reviewedOutput: {
    reviewedOutputId: snapshot.reviewedOutputId, patchSha256: snapshot.patchSha256,
    patchPath: snapshot.patchPath, baseCommit: snapshot.baseCommit, changedFiles: snapshot.changedFiles,
    reviewedBy: snapshot.reviewDecision.reviewedBy, decision: snapshot.reviewDecision.decision, capturedAt: snapshot.capturedAt,
  } }));
  await commitReviewedWorkerOutputReviewAttestation({ store: f.deps.store, markerVerifier: f.deps.markerVerifier, snapshot, reviewMarkerPath: markerPath });
  const resolved = await resolveReviewedWorkerOutput({ store: f.deps.store, projectId: "project", reviewedOutputId: snapshot.reviewedOutputId });
  const policy: ProjectIntegrationPolicy = {
    access: { boundary: AccessBoundary.ProjectScopedControl, scope: {
      projectId: "project", workspaceRoots: [f.target, f.workspacePath], worktreeRoots: [f.workspacePath],
      allowedBranches: ["main"], allowedGitRemotes: ["origin"], jobIdPrefixes: ["worker"],
    } }, allowedPathPrefixes: ["report.md"], requiredCheckIds: ["report"],
  };
  const storeRoot = join(f.root, "attempts");
  const store = new LocalIntegrationAttemptStore({ rootDir: storeRoot });
  const integration = {
    store, git: new LocalGitIntegrationAdapter({ allowedPatchRoots: [f.root] }), locks: f.deps.locks,
    checks: new LocalProjectCheckRunner(), scanner: new SimpleSecretScanner(),
    reviewedOutputIntegrity: new LocalReviewedOutputIntegrationIntegrity({ rootDir: join(f.root, "reviewed"), projectId: "project" }),
    commitIdentity: { approvedIdentity: () => ({ name: "Fixture", email: "fixture@example.com" }) },
  };
  await openProjectIntegrationAttempt(integration, { policy, attemptId: "large", projectId: "project", controllerJobId: "controller", sourceWorkspacePath: f.workspacePath, targetWorkspacePath: f.target, targetBranch: "main", targetRemote: "origin", workerOutput: resolved.workerOutput, reviewDecision: snapshot.reviewDecision });
  await applyWorkerOutput(integration, { attemptId: "large" });
  if (checkExit === 2) {
    const before = await git(f.target, "rev-parse", "HEAD");
    await expect(runRequiredChecks({ ...integration, checks: { runCheck: async (input) => {
      const result = await integration.checks.runCheck(input);
      await writeFile(join(f.target, "report.md"), report + "Concurrent check drift.\n");
      return result;
    } } }, { attemptId: "large" })).rejects.toThrow("target_tree_mismatch");
    await expect(commitApprovedChanges(integration, { attemptId: "large", policy, message: "docs: report" })).rejects.toThrow();
    expect(await git(f.target, "rev-parse", "HEAD")).toBe(before);
    return;
  }
  await runRequiredChecks(integration, { attemptId: "large" });
  if (checkExit !== 0) {
    const before = await git(f.target, "rev-parse", "HEAD");
    await expect(commitApprovedChanges(integration, { attemptId: "large", policy, message: "docs: report" })).rejects.toThrow();
    expect(await git(f.target, "rev-parse", "HEAD")).toBe(before);
    return;
  }
  const original = (await store.get("large"))!;
  const before = await git(f.target, "rev-parse", "HEAD");
  for (const changes of [
    { reviewedOutputFileByteAllowance: allowance - 1 },
    { patchSha256: "0".repeat(64) }, { patchPath: join(f.root, "other.patch") },
  ]) {
    await store.update({ ...original, workerOutput: { ...original.workerOutput, ...changes } });
    await expect(commitApprovedChanges(integration, { attemptId: "large", policy, message: "docs: report" })).rejects.toThrow("identity_mismatch");
    expect(await git(f.target, "rev-parse", "HEAD")).toBe(before);
  }
  await store.update(original);
  const { reviewedOutputIntegrity: _integrity, ...withoutIntegrity } = integration;
  await expect(commitApprovedChanges(withoutIntegrity, { attemptId: "large", policy, message: "docs: report" })).rejects.toThrow("integrity_verifier_required");
  await expect(integration.scanner.scanFiles({ workspacePath: f.target, files: ["report.md"] })).resolves.toMatchObject({ status: SecretScanStatus.Failed });
  await writeFile(join(f.target, "report.md"), report + '\napi_key = "sk-' + "a".repeat(48) + '"\n');
  await expect(commitApprovedChanges(integration, { attemptId: "large", policy, message: "docs: report" })).rejects.toThrow();
  expect(await git(f.target, "rev-parse", "HEAD")).toBe(before);
  await writeFile(join(f.target, "report.md"), report + "Unreviewed post-check addition.\n");
  await expect(commitApprovedChanges(integration, { attemptId: "large", policy, message: "docs: report" })).rejects.toThrow("target_tree_mismatch");
  expect(await git(f.target, "rev-parse", "HEAD")).toBe(before);
  await writeFile(join(f.target, "report.md"), report);
  await expect(commitApprovedChanges({ ...integration, scanner: { scanFiles: async () => ({ status: SecretScanStatus.Passed }) } }, { attemptId: "large", policy, message: "docs: report" })).rejects.toThrow();
  expect(await git(f.target, "rev-parse", "HEAD")).toBe(before);
  const scanner = integration.scanner;
  await expect(commitApprovedChanges({ ...integration, scanner: { scanFiles: async (input) => {
    const result = await scanner.scanFiles(input);
    await writeFile(join(f.target, "report.md"), report + "Concurrent benign change.\n");
    return result;
  } } }, { attemptId: "large", policy, message: "docs: report" })).rejects.toThrow("target_tree_mismatch");
  expect(await git(f.target, "rev-parse", "HEAD")).toBe(before);
  await writeFile(join(f.target, "report.md"), report);
  const attributes = join(f.target, ".git", "info", "attributes");
  await writeFile(attributes, "report.md filter=reviewed-drift\n");
  await git(f.target, "config", "filter.reviewed-drift.clean", "cat; printf 'filter drift\\n'");
  await expect(commitApprovedChanges(integration, { attemptId: "large", policy, message: "docs: report" })).rejects.toThrow("target_tree_mismatch");
  expect(await git(f.target, "rev-parse", "HEAD")).toBe(before);
  await rm(attributes);
  await git(f.target, "config", "--unset", "filter.reviewed-drift.clean");
  const hook = join(f.target, ".git", "hooks", "pre-commit");
  await writeFile(hook, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  await expect(commitApprovedChanges(integration, { attemptId: "large", policy, message: "docs: report" })).rejects.toThrow("hook run");
  expect(await git(f.target, "rev-parse", "HEAD")).toBe(before);
  await rm(hook);
  await git(f.target, "config", "commit.gpgsign", "true");
  await expect(commitApprovedChanges(integration, { attemptId: "large", policy, message: "docs: report" })).rejects.toThrow("signing_requires_supported_path");
  await git(f.target, "config", "--unset", "commit.gpgsign");
  const shim = join(f.root, "mutating-git.cjs");
  await writeFile(shim, `#!${process.execPath}
const {execFileSync}=require("node:child_process");
const args=process.argv.slice(2);
const out=execFileSync("git",args,{maxBuffer:20*1024*1024});
if(args[0]==="commit-tree") require("node:fs").appendFileSync(${JSON.stringify(join(f.target, "report.md"))},"Late commit drift.\\n");
process.stdout.write(out);
`, { mode: 0o700 });
  await expect(commitApprovedChanges({ ...integration, git: new LocalGitIntegrationAdapter({ allowedPatchRoots: [f.root], gitBinaryPath: shim }) }, { attemptId: "large", policy, message: "docs: report" })).rejects.toThrow("target_tree_mismatch");
  expect(await git(f.target, "rev-parse", "HEAD")).toBe(before);
  await writeFile(join(f.target, "report.md"), report);
  await writeFile(shim, `#!${process.execPath}
const {execFileSync}=require("node:child_process");
const args=process.argv.slice(2);
if(args[0]==="update-ref") process.exit(1);
process.stdout.write(execFileSync("git",args,{maxBuffer:20*1024*1024}));
`, { mode: 0o700 });
  await expect(commitApprovedChanges({ ...integration, git: new LocalGitIntegrationAdapter({ allowedPatchRoots: [f.root], gitBinaryPath: shim }) }, { attemptId: "large", policy, message: "docs: report" })).rejects.toThrow();
  const prepared = (await store.get("large"))!.preparedReviewedCommit!;
  expect(prepared.candidate.commitSha).toMatch(/^[a-f0-9]{40}$/);
  expect(await git(f.target, "rev-parse", "HEAD")).toBe(before);
  await expect(commitApprovedChanges(integration, { attemptId: "large", policy, message: "docs: changed message" })).rejects.toThrow("prepared_identity_mismatch");
  await commitApprovedChanges(integration, { attemptId: "large", policy, message: "docs: report" });
  expect(await git(f.target, "rev-parse", "HEAD")).toBe(prepared.candidate.commitSha);
  expect(await git(f.target, "status", "--porcelain")).toBe("");
  expect(await git(f.target, "rev-parse", "HEAD")).not.toBe(before);
  expect(await readFile(join(f.target, "report.md"), "utf8")).toBe(report);
  const committedReport = await exec("git", ["show", "HEAD:report.md"], { cwd: f.target, maxBuffer: allowance });
  expect(hash(committedReport.stdout)).toBe(hash(report));
  for (const staging of [prepared.originalIndexTree, "different"]) {
    if (staging === "different") {
      await writeFile(join(f.target, "staged.txt"), "intentional staging\n");
      await git(f.target, "add", "staged.txt");
    } else await git(f.target, "read-tree", staging);
    const index = await readFile(join(f.target, ".git", "index"));
    const replay = { ...integration, store: new LocalIntegrationAttemptStore({ rootDir: storeRoot }),
      git: new LocalGitIntegrationAdapter({ allowedPatchRoots: [f.root] }) };
    expect((await replay.store.get("large"))!.reviewedIndexRecoveryPending).toBe(false);
    await commitApprovedChanges(replay, { attemptId: "large", policy, message: "docs: report" });
    expect(await readFile(join(f.target, ".git", "index"))).toEqual(index);
    expect(await git(f.target, "rev-parse", "HEAD")).toBe(prepared.candidate.commitSha);
    expect((await replay.store.readEvents("large")).filter(event => event.commitSha === prepared.candidate.commitSha)).toHaveLength(1);
  }

});

it("rejects defaults, invalid allowances, late secrets, and persisted allowance tampering", async () => {
  const f = await fixture();
  const { reviewedOutputFileByteAllowance: _allowance, ...legacyInput } = f.input;
  await expect(captureReviewedWorkerOutput(f.deps, legacyInput)).rejects.toThrow();
  for (const value of [0, -1, 1.5, NaN, Infinity, allowance + 1, null, "8388608"]) {
    await expect(captureReviewedWorkerOutput(f.deps, { ...f.input, reviewedOutputFileByteAllowance: value as number })).rejects.toThrow("allowance_invalid");
  }
  const snapshot = await captureReviewedWorkerOutput(f.deps, f.input);
  expect(reviewedWorkerOutputId(snapshot)).toBe(snapshot.reviewedOutputId);
  const manifestPath = join(f.root, "reviewed", snapshot.reviewedOutputId, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, reviewedOutputFileByteAllowance: allowance - 1 }));
  await expect(f.deps.store.get(snapshot.reviewedOutputId)).rejects.toThrow("identity_mismatch");
  await writeFile(join(f.workspacePath, "report.md"), report + '\napi_key = "sk-' + "a".repeat(48) + '"\n');
  await expect(f.deps.snapshotter.capture({ workspacePath: f.workspacePath, reviewedOutputFileByteAllowance: allowance })).rejects.toThrow("secret_like_content");
  await git(f.workspacePath, "add", "report.md");
  const unsafeTree = await git(f.workspacePath, "write-tree");
  await writeFile(join(f.workspacePath, "report.md"), report);
  await expect(new SimpleSecretScanner().scanFiles({ workspacePath: f.workspacePath, files: ["report.md"], reviewedTree: unsafeTree, reviewedOutputFileByteAllowance: allowance })).resolves.toMatchObject({ status: SecretScanStatus.Failed, safeMessage: "secret_like_content:report.md" });
  await writeFile(join(f.workspacePath, "report.md"), report + '\napi_key = "sk-' + "a".repeat(48) + '"\n');

  await expect(new SimpleSecretScanner().scanFiles({ workspacePath: f.workspacePath, files: ["report.md"], reviewedOutputFileByteAllowance: allowance })).resolves.toMatchObject({ status: SecretScanStatus.Failed, safeMessage: "secret_like_content:report.md" });
});


it("preserves aggregate 16 MiB and persisted patch 16 MiB bounds", async () => {
  const f = await fixture();
  for (const file of ["second.md", "third.md", "fourth.md"]) {
    await writeFile(join(f.workspacePath, file), report);
  }
  await expect(f.deps.snapshotter.capture({ workspacePath: f.workspacePath, reviewedOutputFileByteAllowance: allowance })).rejects.toThrow("total_byte_limit_exceeded");
  const patch = "x".repeat(16 * 1024 * 1024 + 1);
  await expect(captureReviewedWorkerOutput({ ...f.deps, snapshotter: { capture: async () => ({ patch, baseCommit: "a".repeat(40), changedFiles: ["report.md"] }) } }, {
    ...f.input, expectedPatchSha256: hash(patch),
  })).rejects.toThrow("patch_size_mismatch");
});

it("omission retains the historical identity payload", async () => {
  const f = await fixture();
  await writeFile(join(f.workspacePath, "report.md"), "small report\n");
  const patch = (await f.deps.snapshotter.capture({ workspacePath: f.workspacePath })).patch;
  const { reviewedOutputFileByteAllowance: _allowance, ...legacyInput } = f.input;
  const snapshot = await captureReviewedWorkerOutput(f.deps, { ...legacyInput, expectedPatchSha256: hash(patch) });
  const legacyPayload = {
    format: snapshot.format, formatRevision: snapshot.formatRevision, projectId: snapshot.projectId,
    controllerJobId: snapshot.controllerJobId, workerJobId: snapshot.workerJobId, taskId: snapshot.taskId,
    sourceWorkspacePath: snapshot.sourceWorkspacePath, baseCommit: snapshot.baseCommit,
    patchSha256: snapshot.patchSha256, changedFiles: snapshot.changedFiles, reviewDecision: snapshot.reviewDecision,
  };
  expect(snapshot.reviewedOutputId).toBe(hash(JSON.stringify(legacyPayload)));
  expect(JSON.parse(await readFile(join(f.root, "reviewed", snapshot.reviewedOutputId, "manifest.json"), "utf8"))).not.toHaveProperty("reviewedOutputFileByteAllowance");
});


it("scans a late secret in a large base blob even when the current file is safe", async () => {
  const f = await fixture();
  await writeFile(join(f.workspacePath, "report.md"), report + '\napi_key = "sk-' + "a".repeat(48) + '"\n');
  await git(f.workspacePath, "add", "report.md");
  await git(f.workspacePath, "commit", "-m", "test: synthetic unsafe base");
  await writeFile(join(f.workspacePath, "report.md"), report);
  await expect(f.deps.snapshotter.capture({ workspacePath: f.workspacePath, reviewedOutputFileByteAllowance: allowance })).rejects.toThrow("secret_like_content");
  await expect(new SimpleSecretScanner().scanFiles({ workspacePath: f.workspacePath, files: ["report.md"], reviewedOutputFileByteAllowance: allowance })).resolves.toMatchObject({ status: SecretScanStatus.Failed, safeMessage: "secret_like_content:report.md" });
  const reviewedParent = await git(f.workspacePath, "rev-parse", "HEAD");
  await git(f.workspacePath, "add", "report.md");
  await git(f.workspacePath, "commit", "-m", "test: safe head");
  const reviewedTree = await git(f.workspacePath, "rev-parse", "HEAD^{tree}");
  await expect(new SimpleSecretScanner().scanFiles({ workspacePath: f.workspacePath, files: ["report.md"], reviewedTree, reviewedParent, reviewedOutputFileByteAllowance: allowance })).resolves.toMatchObject({ status: SecretScanStatus.Failed, safeMessage: "secret_scan_base_changed" });
});


it("rejects a real encoded patch over 16 MiB while file and aggregate bytes fit", async () => {
  const f = await fixture();
  await rm(join(f.workspacePath, "report.md"));
  const bytes = randomBytes(7 * 1024 * 1024);
  await writeFile(join(f.workspacePath, "one.bin"), bytes);
  await writeFile(join(f.workspacePath, "two.bin"), bytes);
  expect(bytes.byteLength * 2).toBeLessThan(16 * 1024 * 1024);
  await expect(f.deps.snapshotter.capture({ workspacePath: f.workspacePath, reviewedOutputFileByteAllowance: allowance })).rejects.toThrow(/patch.*limit|buffer/i);
});

it.each(["--assume-unchanged", "--skip-worktree"])("scans the complete immutable delta despite %s", async (flag) => {
  const f = await fixture(true);
  const snapshot = await captureReviewedWorkerOutput(f.deps, { ...f.input, requiredChecks: f.input.requiredChecks });
  const markerPath = join(f.root, "review.json");
  await writeFile(markerPath, JSON.stringify({ reviewedOutput: {
    reviewedOutputId: snapshot.reviewedOutputId, patchSha256: snapshot.patchSha256,
    patchPath: snapshot.patchPath, baseCommit: snapshot.baseCommit, changedFiles: snapshot.changedFiles,
    reviewedBy: snapshot.reviewDecision.reviewedBy, decision: snapshot.reviewDecision.decision, capturedAt: snapshot.capturedAt,
  } }));
  await commitReviewedWorkerOutputReviewAttestation({ store: f.deps.store, markerVerifier: f.deps.markerVerifier, snapshot, reviewMarkerPath: markerPath });
  const resolved = await resolveReviewedWorkerOutput({ store: f.deps.store, projectId: "project", reviewedOutputId: snapshot.reviewedOutputId });
  const policy: ProjectIntegrationPolicy = {
    access: { boundary: AccessBoundary.ProjectScopedControl, scope: {
      projectId: "project", workspaceRoots: [f.target, f.workspacePath], worktreeRoots: [f.workspacePath],
      allowedBranches: ["main"], allowedGitRemotes: ["origin"], jobIdPrefixes: ["worker"],
    } }, allowedPathPrefixes: ["base.md", "report.md"], requiredCheckIds: ["report"],
  };
  const store = new MemoryAttemptStore([]);
  const integration = {
    store, git: new LocalGitIntegrationAdapter({ allowedPatchRoots: [f.root] }), locks: f.deps.locks,
    checks: new LocalProjectCheckRunner(), scanner: new SimpleSecretScanner(),
    reviewedOutputIntegrity: new LocalReviewedOutputIntegrationIntegrity({ rootDir: join(f.root, "reviewed"), projectId: "project" }),
    commitIdentity: { approvedIdentity: () => ({ name: "Fixture", email: "fixture@example.com" }) },
  };
  await openProjectIntegrationAttempt(integration, { policy, attemptId: "large", projectId: "project", controllerJobId: "controller", sourceWorkspacePath: f.workspacePath, targetWorkspacePath: f.target, targetBranch: "main", targetRemote: "origin", workerOutput: resolved.workerOutput, reviewDecision: snapshot.reviewDecision });
  await applyWorkerOutput(integration, { attemptId: "large" });

  await runRequiredChecks(integration, { attemptId: "large" });
  await git(f.target, "reset", "HEAD", "--", "base.md");
  await git(f.target, "update-index", flag, "base.md");
  expect(await git(f.target, "status", "--porcelain")).not.toContain("base.md");
  const before = await git(f.target, "rev-parse", "HEAD");
  const scanner = new SimpleSecretScanner({ patterns: [/configured scanner sentinel/] });
  let scanned: readonly string[] = [];
  await expect(commitApprovedChanges({ ...integration, scanner: { scanFiles: async (input) => {
    scanned = input.files;
    return scanner.scanFiles(input);
  } } }, { attemptId: "large", policy, message: "docs: report" })).rejects.toThrow();
  expect(scanned).toEqual(["base.md", "report.md"]);
  expect(await git(f.target, "rev-parse", "HEAD")).toBe(before);
  const committed = await commitApprovedChanges(integration, { attemptId: "large", policy, message: "docs: report" });
  expect(committed.commitCandidate?.files).toEqual(["base.md", "report.md"]);
  expect((await git(f.target, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD")).split("\n")).toEqual(["base.md", "report.md"]);
});
