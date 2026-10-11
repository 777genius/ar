import { execFile, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFile, chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessBoundary, NetworkAccessMode, RETAINED_NONQUALIFIED_BACKUP_PAYLOADS, RetainedNonqualifiedOriginalKind,
  RetainedNonqualifiedResourcePolicyId, type ProjectAccessScope } from "@vioxen/subscription-runtime/worker-core";
import { LocalProjectControlEvidenceCustody } from "@vioxen/subscription-runtime/worker-local";
import { LocalConsumedOutputLedgerWriter } from "../../worker-local/consumed-output-ledger-local-adapter";
import { localProjectControlEvidenceCustodySupported } from "../../worker-local/project-control-evidence-custody-local-adapter";
import { recoveryDirectoryIdentities } from "../../worker-local/project-control-recovery-directory-identity";
import { createCodexGoalMcpServer } from "../codex-goal-mcp";
import { codexGoalJobManifestPath, createCodexGoalJob } from "../codex-goal-jobs";
import { codexGoalOutputPath, codexGoalProgressPath, codexGoalRuntimeEventsPath } from "../codex-goal-runner";
import { assertRetainedNonqualifiedCapacity, projectControlRetainNonqualifiedAttempt, readRetainedNonqualifiedPermit,
  type RetainedNonqualifiedPermit } from "../codex-goal-mcp-project-control-retained-nonqualified";
import { rootPermitSha256 } from "../codex-goal-mcp-project-control-root-permit";
import { readCodexGoalConsumedOutputLedgers } from "../application/project-control/codex-goal-consumed-output-ledger-io";
import { callToolJson } from "./codex-goal-mcp-test-support";

// Suite role (rule 31 clause 3): this file BINDS THE PRODUCER. The real root-only MCP operation
// is driven end to end against disposable TEST jobs and a real Git workspace, and admission is
// read through the real MCP snapshot tool, so a removed guard in the operation or in admission
// fails here. The hand-built-receipt admission suite
// (codex-goal-project-retained-nonqualified-admission.test.ts) is the door-level companion.
// Custody is Linux-only and the permit must be root-owned, exactly as for the approved archive.

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } })).stdout;
const bytesOf = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const cleanups: (() => Promise<unknown>)[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const nativePrivilegeIsRoot = process.geteuid?.() === 0;
const GIB = 1024 ** 3;

describe("capacity guard", () => {
  it("refuses when either the durable target or scratch cannot hold the complete backup", () => {
    const fits = { requiredBytes: 100, durableFreeBytes: 100, scratchFreeBytes: 100 };
    expect(assertRetainedNonqualifiedCapacity(fits)).toEqual(fits);
    expect(() => assertRetainedNonqualifiedCapacity({ ...fits, durableFreeBytes: 99 })).toThrow("retained_nonqualified_capacity_insufficient");
    expect(() => assertRetainedNonqualifiedCapacity({ ...fits, scratchFreeBytes: 99 })).toThrow("retained_nonqualified_capacity_insufficient");
    expect(() => assertRetainedNonqualifiedCapacity({ ...fits, scratchFreeBytes: Number.NaN })).toThrow("retained_nonqualified_capacity_insufficient");
  });
});

if (!nativePrivilegeIsRoot) {
  it("native nonroot retention boundary refuses before permit or controller IO", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "sr-retain-nonroot-TEST-")));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const args = { controllerJobId: "TEST-controller", workerJobId: "TEST-worker", permitFile: join(root, "TEST-absent.json"), expectedPermitSha256: "0".repeat(64) };
    const canonicalDirectory = vi.spyOn(LocalProjectControlEvidenceCustody.prototype, "canonicalDirectory");
    await expect(readRetainedNonqualifiedPermit(args)).rejects.toThrow("retained_nonqualified_root_required");
    await expect(projectControlRetainNonqualifiedAttempt(args)).rejects.toThrow("retained_nonqualified_root_required");
    expect(canonicalDirectory).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });
}

async function fixture(kind: RetainedNonqualifiedOriginalKind) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "sr-retain-nonqualified-TEST-")));
  vi.stubEnv("TMUX_TMPDIR", root); // a disposable tmux socket directory: absence is observed, never synthesized
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const registryRootDir = join(root, "jobs", "registry"), source = join(root, "workspaces", "TEST-worker"), canonical = join(root, "workspaces", "TEST-main");
  const ledgerRoot = join(root, "jobs", "ledger"), evidenceRoot = join(root, "jobs", "archives");
  const controllerJobId = "TEST-controller", workerJobId = "TEST-worker";
  for (const path of [source, canonical, ledgerRoot, evidenceRoot, join(root, "worktrees")]) await mkdir(path, { recursive: true });
  await git(source, "init", "-b", "main");
  await git(source, "config", "core.autocrlf", "false"); // the raw-identity guard refuses any Git conversion
  await git(source, "config", "user.name", "iliya"); await git(source, "config", "user.email", "iliyazelenkog@gmail.com");
  await writeFile(join(source, "a.txt"), "before\n"); await writeFile(join(source, ".gitignore"), "logs/\nnode_modules/\n"); await git(source, "add", "-A"); await git(source, "commit", "-m", "chore(test): TEST base");
  const baseCommit = (await git(source, "rev-parse", "HEAD")).trim();
  // MM: the staged blob (A) and the worktree bytes (B) are independently distinct from HEAD and from each other.
  await writeFile(join(source, "a.txt"), "staged by the original attempt\n"); await git(source, "add", "a.txt");
  await writeFile(join(source, "a.txt"), "edited by the original attempt\n");
  // Useful ignored input (a validation log) and a disposable dependency directory.
  await mkdir(join(source, "logs")); await writeFile(join(source, "logs", "validation.log"), "useful ignored validation log\n");
  await mkdir(join(source, "node_modules", "dep"), { recursive: true }); await writeFile(join(source, "node_modules", "dep", "i.js"), "x\n");
  await mkdir(join(source, "capsule", "deep"), { recursive: true });
  await writeFile(join(source, "capsule", "input.txt"), "untracked TEST input\n");
  await writeFile(join(source, "capsule", "deep", "tool.sh"), "#!/bin/sh\necho TEST\n"); await chmod(join(source, "capsule", "deep", "tool.sh"), 0o755);
  await writeFile(join(source, "binary.dat"), Buffer.from([0, 255, 1, 2]));
  const scope: ProjectAccessScope = { projectId: "TEST-project", readRoots: [root], workspaceRoots: [join(root, "workspaces")],
    worktreeRoots: [join(root, "worktrees")], registryRoot: registryRootDir, jobIdPrefixes: ["TEST-"], tmuxSessionPrefixes: ["TEST-"],
    allowedAccountIds: ["TEST-account"], allowedGitRemotes: [], allowedBranches: ["main"],
    consumedOutputLedgerRoots: [ledgerRoot], consumedOutputEvidenceRoots: [evidenceRoot] };
  for (const [jobId, workspacePath, boundary] of [[controllerJobId, canonical, AccessBoundary.ProjectScopedControl],
    [workerJobId, source, AccessBoundary.IsolatedWorkspaceWrite]] as const) {
    const jobRootDir = join(root, "jobs", jobId);
    await mkdir(jobRootDir); await writeFile(join(jobRootDir, "prompt.md"), "Disposable TEST task\n");
    await createCodexGoalJob({ registryRootDir, manifest: { jobId, jobRootDir, workspacePath, promptPath: join(jobRootDir, "prompt.md"),
      taskId: jobId, accounts: ["TEST-account"], tags: jobId === workerJobId ? ["worker-role-producer"] : [], accessBoundary: boundary,
      projectAccessScope: scope, networkAccess: NetworkAccessMode.Restricted, tmuxSession: `TEST-retain-${process.pid}-${root.split("/").at(-1)}` } });
  }
  const jobRootDir = join(root, "jobs", workerJobId), layout = { jobRootDir, taskId: workerJobId };
  const resultPath = codexGoalOutputPath(layout), progressPath = codexGoalProgressPath(layout), eventsPath = codexGoalRuntimeEventsPath(layout);
  // Stale "running" progress with disposed runner events and no process: the shape of the retained originals.
  await writeFile(progressPath, bytesOf({ status: "running", updatedAt: "2026-10-10T08:00:00.000Z" }));
  await writeFile(eventsPath, '{"event":"executor_started"}\n{"event":"runner_disposed"}\n');
  if (kind === RetainedNonqualifiedOriginalKind.FailedCheckpoint) {
    await writeFile(resultPath, bytesOf({ status: "failed", changedFiles: [], evidence: [], blockers: ["checkpoint_unprotected"], nextAction: "none" }));
  }
  const server = createCodexGoalMcpServer(), client = new Client({ name: "retain-nonqualified-TEST", version: "0.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  cleanups.push(async () => { await client.close(); await server.close(); });
  const [evidenceIdentity, ledgerIdentity] = await recoveryDirectoryIdentities([evidenceRoot, ledgerRoot]);
  const hashOf = async (jobId: string) => rootPermitSha256(await readFile(codexGoalJobManifestPath({ registryRootDir, jobId })));
  const permit: RetainedNonqualifiedPermit = { schemaVersion: 1, operation: "retain_nonqualified_attempt", kind, controllerJobId,
    projectId: scope.projectId, workerJobId, taskId: workerJobId, registryRootDir, workerJobRootDir: jobRootDir, sourceWorkspace: source,
    controllerManifestSha256: await hashOf(controllerJobId), workerManifestSha256: await hashOf(workerJobId), baseCommit,
    ignoredRetain: ["logs/validation.log"], resourcePolicy: RetainedNonqualifiedResourcePolicyId.Default,
    archivePath: join(evidenceRoot, `nonqualified-retention-${workerJobId}`), evidenceRoot: evidenceIdentity!, ledgerRoot: ledgerIdentity!,
    owner: "TEST-root-owner", reason: "Retain the stopped TEST original; no qualification is claimed", requestedAt: "2026-10-10T10:00:00.000Z" };
  const permitFile = join(root, "retain-intent.json");
  let expectedPermitSha256 = "";
  const savePermit = async () => { const bytes = bytesOf(permit); await writeFile(permitFile, bytes, { mode: 0o600 }); expectedPermitSha256 = rootPermitSha256(bytes); };
  await savePermit();
  expect((await stat(permitFile)).uid).toBe(0);
  const run = (extra: Record<string, unknown> = {}) => callToolJson(client, "codex_goal_project_retain_nonqualified_attempt", {
    registryRootDir, controllerJobId, workerJobId, permitFile, expectedPermitSha256, ...extra });
  const preview = async () => { const result = await run(); expect(result).toMatchObject({ ok: false, reason: "confirm_retention_required" }); return result; };
  const confirm = async () => run({ confirmRetention: true, expectedPlanSha256: (await preview()).planSha256 });
  const admission = () => callToolJson(client, "codex_goal_project_admission_snapshot", { registryRootDir, controllerJobId, operation: "create_job", workerRole: "producer" });
  const readLedger = () => readCodexGoalConsumedOutputLedgers({ roots: [ledgerRoot], evidenceRoots: [evidenceRoot] });
  const archiveFile = (name: string) => join(permit.archivePath, name);
  const custody = new LocalProjectControlEvidenceCustody();
  const originals = async () => Promise.all([resultPath, progressPath, eventsPath, join(source, "a.txt"), join(source, "capsule", "input.txt"),
    join(source, "binary.dat"), codexGoalJobManifestPath({ registryRootDir, jobId: workerJobId })].map(path => readFile(path).catch(() => null)));
  return { root, source, canonical, ledgerRoot, evidenceRoot, registryRootDir, jobRootDir, permit, scope, client, resultPath, progressPath, eventsPath,
    run, preview, confirm, admission, readLedger, archiveFile, custody, originals, baseCommit, workerJobId, controllerJobId,
    update: async (change: Partial<RetainedNonqualifiedPermit>, rebind = true) => { Object.assign(permit, change); const before = expectedPermitSha256; await savePermit(); if (!rebind) expectedPermitSha256 = before; },
    noDecision: async () => { expect((await readLedger()).byJobId.size).toBe(0);
      expect(await custody.pathKind(join(ledgerRoot, "items", "TEST-worker.json"))).toBe("absent"); },
    noArchive: async () => { expect(await custody.pathKind(permit.archivePath)).toBe("absent");
      expect(await custody.pathKind(`${permit.archivePath}.preparation.json`)).toBe("absent"); },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

if (nativePrivilegeIsRoot && localProjectControlEvidenceCustodySupported) {
describe.each([RetainedNonqualifiedOriginalKind.ResultMissing, RetainedNonqualifiedOriginalKind.FailedCheckpoint])(
  "retained nonqualified attempt through native root MCP on disposable TEST identities (%s)", kind => {
    it("previews without effects, then retains with a hash-bound confirm and clears only this attempt's admission debt", async () => {
      const f = await fixture(kind);
      expect(await f.admission()).toMatchObject({ decision: { allowed: false, reason: "output_debt_present" } });
      const before = await f.originals();
      const planned = await f.preview();
      expect(planned).toMatchObject({ kind, headCommit: f.baseCommit, inventoryEntries: 5 });
      expect(planned.capacity).toMatchObject({ requiredBytes: expect.any(Number) });
      await f.noDecision(); await f.noArchive();
      expect(await f.run({ confirmRetention: true })).toMatchObject({ ok: false, error: "retained_nonqualified_plan_mismatch" });
      expect(await f.run({ confirmRetention: true, expectedPlanSha256: "f".repeat(64) })).toMatchObject({ error: "retained_nonqualified_plan_mismatch" });
      await f.noDecision(); await f.noArchive();

      expect(await f.run({ confirmRetention: true, expectedPlanSha256: planned.planSha256 })).toMatchObject({ ok: true, disposition: "retained_nonqualified" });
      const record = (await f.readLedger()).byJobId.get("TEST-worker");
      expect(record).toMatchObject({ status: "retained_nonqualified", valid: true, retainedNonqualified: { kind } });
      expect(await f.admission()).toMatchObject({ decision: { allowed: true } });
      // Nothing original moved, and no stop, DONE, result, no-output or approval fact was manufactured.
      expect(await f.originals()).toEqual(before);
      expect(await f.custody.pathKind(join(f.jobRootDir, "TEST-worker.stop-event.json"))).toBe("absent");
      const receipt = JSON.parse((await readFile(f.archiveFile("retained-nonqualified-attempt.json"))).toString());
      expect(receipt).toMatchObject({ sourceQualification: "not_assessed", replayAuthorized: false, kind, headCommit: f.baseCommit,
        original: { result: kind === RetainedNonqualifiedOriginalKind.ResultMissing ? { state: "absent" } : { state: "present" } } });
      const ledgerJson = JSON.parse(await readFile(join(f.ledgerRoot, "items", "TEST-worker.json"), "utf8"));
      expect(ledgerJson).toMatchObject({ status: "retained_nonqualified", retention: { sourceQualification: "not_assessed", replayAuthorized: false } });
      expect(ledgerJson).not.toHaveProperty("commitSha");
      expect(ledgerJson).not.toHaveProperty("failure");
      // Backup custody holds the exact bytes: tracked diff, raw untracked tar, intent.
      expect((await readFile(f.archiveFile("tracked.numstat"), "utf8"))).toContain("a.txt");
      expect(await readFile(f.archiveFile("untracked.tar"))).toSatisfy((tar: Buffer) => tar.includes("untracked TEST input") && tar.includes("capsule/deep/tool.sh"));
      // tracked.diff is the tracked HEAD-to-worktree diff ONLY: untracked bytes live in untracked.tar, not duplicated as patches.
      const trackedDiff = await readFile(f.archiveFile("tracked.diff"), "utf8");
      expect(trackedDiff).toContain("a.txt");
      expect(trackedDiff).not.toContain("untracked TEST input");
      expect(trackedDiff).not.toContain("capsule/input.txt");
      expect(trackedDiff).not.toContain("binary.dat");
      // The receipt names its finite policy and records every payload's ACTUAL length, equal to the bytes on disk.
      expect(receipt).toMatchObject({ schemaVersion: 2, resourcePolicy: "default_v1" });
      for (const payload of RETAINED_NONQUALIFIED_BACKUP_PAYLOADS) {
        expect(receipt.payloadLengths[payload]).toBe((await readFile(f.archiveFile(payload))).length);
      }
      expect(await readFile(f.archiveFile("owner-intent.json"))).toEqual(await readFile(join(f.root, "retain-intent.json")));
    });

    it("is idempotent on replay, even after the workspace later changes, and then admission restores the debt", async () => {
      const f = await fixture(kind);
      expect(await f.confirm()).toMatchObject({ ok: true });
      const receipt = await readFile(f.archiveFile("retained-nonqualified-attempt.json"));
      await writeFile(join(f.source, "late.txt"), "later output\n");
      expect(await f.run({ confirmRetention: true })).toMatchObject({ ok: true, result: { idempotentReplay: true } });
      expect(await readFile(f.archiveFile("retained-nonqualified-attempt.json"))).toEqual(receipt);
      // Changed bytes after retention: the receipt no longer matches the present originals.
      expect(await f.admission()).toMatchObject({ decision: { allowed: false } });
      await rm(join(f.source, "late.txt"));
      expect(await f.admission()).toMatchObject({ decision: { allowed: true } });
      await appendFile(join(f.source, "capsule", "input.txt"), "edited after retention\n");
      expect(await f.admission()).toMatchObject({ decision: { allowed: false } });
      expect((await f.readLedger()).byJobId.size).toBe(1);
    });

    it("refuses a conflicting owner intent on the same attempt and never starts a second disposition", async () => {
      const f = await fixture(kind);
      expect(await f.confirm()).toMatchObject({ ok: true });
      await f.update({ reason: "A conflicting conscious disposition" });
      expect(await f.run({ confirmRetention: true })).toMatchObject({ ok: false, error: "retained_nonqualified_preparation_conflict" });
      expect((await f.readLedger()).byJobId.size).toBe(1);
    });
  });

describe("retained nonqualified attempt rejections and reconciliation (native root MCP)", () => {
  const missing = RetainedNonqualifiedOriginalKind.ResultMissing, failed = RetainedNonqualifiedOriginalKind.FailedCheckpoint;

  it.each([
    ["controllerManifestSha256", "f".repeat(64), "retained_nonqualified_manifest_binding_mismatch"],
    ["workerManifestSha256", "f".repeat(64), "retained_nonqualified_manifest_binding_mismatch"],
    ["baseCommit", "e".repeat(40), "retained_nonqualified_base_mismatch"],
    ["projectId", "OTHER", "retained_nonqualified_scope_binding_mismatch"],
    ["controllerJobId", "OTHER", "retained_nonqualified_permit_caller_mismatch"],
    ["workerJobId", "OTHER", "retained_nonqualified_permit_caller_mismatch"],
    ["taskId", "OTHER", "retained_nonqualified_job_binding_mismatch"],
    ["sourceWorkspace", "/external", "retained_nonqualified_scope_binding_mismatch"],
    ["workerJobRootDir", "/external", "retained_nonqualified_job_binding_mismatch"],
    ["archivePath", "/external/archive", "retained_nonqualified_scope_binding_mismatch"],
    ["kind", failed, "retained_nonqualified_kind_mismatch"],
  ] as const)("refuses wrong owner-intent binding %s without any decision or archive", async (field, value, error) => {
    const f = await fixture(missing);
    await f.update({ [field]: value } as Partial<RetainedNonqualifiedPermit>);
    expect(await f.run({ confirmRetention: true, expectedPlanSha256: "0".repeat(64) })).toMatchObject({ ok: false, error });
    await f.noDecision(); await f.noArchive();
  });

  it("refuses insecure, stale-hash, symlink and nonroot permits before any effect", async () => {
    const f = await fixture(missing);
    await f.update({ owner: "TEST-different-owner" }, false);
    expect(await f.run()).toMatchObject({ error: "retained_nonqualified_permit_hash_mismatch" });
    await f.update({ owner: "TEST-root-owner" }); await chmod(join(f.root, "retain-intent.json"), 0o644);
    expect(await f.run()).toMatchObject({ error: "retained_nonqualified_permit_security_invalid" });
    vi.spyOn(process, "geteuid").mockReturnValue(1234);
    expect(await f.run()).toMatchObject({ error: "retained_nonqualified_root_required" });
    await f.noDecision(); await f.noArchive();
  });

  it("refuses a forged DONE (or any non-failed) original result instead of retaining it", async () => {
    const f = await fixture(failed);
    const done = bytesOf({ status: "done", changedFiles: ["a.txt"], evidence: [], blockers: [], nextAction: "review_completed" });
    await writeFile(f.resultPath, done);
    expect(await f.run()).toMatchObject({ ok: false, error: "retained_nonqualified_result_not_failed" });
    expect(await readFile(f.resultPath)).toEqual(done);
    await f.noDecision(); await f.noArchive();
  });

  it("refuses a present result when the owner declared the result missing, and the reverse", async () => {
    const withResult = await fixture(failed);
    await withResult.update({ kind: missing });
    expect(await withResult.run()).toMatchObject({ error: "retained_nonqualified_kind_mismatch" });
    const withoutResult = await fixture(missing);
    await withoutResult.update({ kind: failed });
    expect(await withoutResult.run()).toMatchObject({ error: "retained_nonqualified_kind_mismatch" });
  });

  it("refuses a live writer, a descendant holding the workspace, an active account lease and a live progress PID", async () => {
    const f = await fixture(missing);
    const child = spawn("sleep", ["60"], { cwd: f.source, stdio: "ignore" }); children.push(child);
    expect(await f.run()).toMatchObject({ error: expect.stringContaining("retained_nonqualified_writer_present") });
    child.kill("SIGKILL"); children.pop();
    await writeFile(join(f.jobRootDir, "account-reservation.json"), bytesOf({ expiresAt: new Date(Date.now() + 3_600_000).toISOString() }));
    expect(await f.run()).toMatchObject({ error: "retained_nonqualified_account_lease_active" });
    await rm(join(f.jobRootDir, "account-reservation.json"));
    await writeFile(f.progressPath, bytesOf({ pid: process.pid, status: "running", updatedAt: new Date().toISOString() }));
    expect(await f.run()).toMatchObject({ error: "retained_nonqualified_source_not_quiescent" });
    await writeFile(f.progressPath, "invalid json");
    expect(await f.run()).toMatchObject({ ok: false });
    await f.noDecision(); await f.noArchive();
  });

  it.each([
    ["an untracked symlink", async (f: Fixture) => { await symlink("/etc/hostname", join(f.source, "alias")); }, "retained_nonqualified_unsafe_symlink"],
    ["a nested repository", async (f: Fixture) => { await mkdir(join(f.source, "nested")); await git(join(f.source, "nested"), "init"); await writeFile(join(f.source, "nested", "x"), "x"); }, "retained_nonqualified_unsupported_entry"],
    ["a clean workspace with nothing to retain", async (f: Fixture) => { await git(f.source, "reset", "-q", "--hard", "HEAD"); await git(f.source, "clean", "-fdxq"); await f.update({ ignoredRetain: [] }); }, "retained_nonqualified_inventory_empty"],
  ])("refuses unsafe or empty inventory: %s", async (_name, change, error) => {
    const f = await fixture(missing); await change(f);
    expect(await f.run()).toMatchObject({ ok: false, error }); await f.noDecision(); await f.noArchive();
  });

  it("refuses when the workspace changes between preview and confirm", async () => {
    const f = await fixture(missing); const plan = (await f.preview()).planSha256;
    await appendFile(join(f.source, "capsule", "input.txt"), "changed after preview\n");
    expect(await f.run({ confirmRetention: true, expectedPlanSha256: plan })).toMatchObject({ error: "retained_nonqualified_plan_mismatch" });
    await f.noDecision(); await f.noArchive();
  });

  it("the old strict routes still reject these real input classes and nothing is rewritten", async () => {
    const f = await fixture(failed); const result = await readFile(f.resultPath);
    expect(await callToolJson(f.client, "codex_goal_project_record_failed_no_output", { registryRootDir: f.registryRootDir,
      controllerJobId: f.controllerJobId, jobId: f.workerJobId, terminalAttemptId: "attempt-1", failureCategory: "infrastructure",
      failureCode: "checkpoint_unprotected", confirmFailedNoOutput: true })).toMatchObject({ ok: false });
    await f.noDecision();
    expect(await readFile(f.resultPath)).toEqual(result);
    expect(await f.admission()).toMatchObject({ decision: { allowed: false } });
  });

  it("recovers an interrupted backup publication, refuses changed bytes and a different partial owner", async () => {
    const f = await fixture(missing); let fail = true;
    const original = LocalProjectControlEvidenceCustody.prototype.publishImmutableBytes;
    vi.spyOn(LocalProjectControlEvidenceCustody.prototype, "publishImmutableBytes").mockImplementation(async function(this: LocalProjectControlEvidenceCustody, input) {
      const result = await original.call(this, input);
      if (input.fileName === "tracked.diff" && fail) { fail = false; throw new Error("TEST_interrupted_after_backup"); }
      return result;
    });
    const plan = (await f.preview()).planSha256;
    expect(await f.run({ confirmRetention: true, expectedPlanSha256: plan })).toMatchObject({ error: "TEST_interrupted_after_backup" });
    await f.noDecision();
    expect(await f.custody.pathKind(f.archiveFile("retained-nonqualified-attempt.json"))).toBe("absent");
    const owner = f.permit.owner; await f.update({ owner: "TEST-conflicting-owner" });
    expect(await f.run({ confirmRetention: true, expectedPlanSha256: plan })).toMatchObject({ ok: false }); await f.noDecision();
    await f.update({ owner });
    expect(await f.run({ confirmRetention: true, expectedPlanSha256: plan })).toMatchObject({ ok: true, result: { idempotentReplay: false } });
    expect((await f.readLedger()).byJobId.get("TEST-worker")?.valid).toBe(true);
  });

  it("reconciles a failure after the receipt under the same attempt, but refuses the source if it changed meanwhile", async () => {
    const f = await fixture(missing); const plan = (await f.preview()).planSha256;
    const record = vi.spyOn(LocalConsumedOutputLedgerWriter.prototype, "record").mockRejectedValueOnce(new Error("TEST_ledger_publication_failed"));
    expect(await f.run({ confirmRetention: true, expectedPlanSha256: plan })).toMatchObject({ error: "TEST_ledger_publication_failed" });
    expect(record).toHaveBeenCalledTimes(1);
    await f.noDecision();
    const receipt = await readFile(f.archiveFile("retained-nonqualified-attempt.json"));
    await appendFile(join(f.source, "capsule", "input.txt"), "changed while partially published\n");
    expect(await f.run({ confirmRetention: true, expectedPlanSha256: plan })).toMatchObject({ ok: false });
    await f.noDecision();
    await writeFile(join(f.source, "capsule", "input.txt"), "untracked TEST input\n");
    expect(await f.run({ confirmRetention: true, expectedPlanSha256: plan })).toMatchObject({ ok: true });
    expect(await readFile(f.archiveFile("retained-nonqualified-attempt.json"))).toEqual(receipt);
  });

  it("a competing terminal decision for the same job prevents retention", async () => {
    const f = await fixture(missing);
    await mkdir(join(f.ledgerRoot, "items"), { recursive: true });
    await writeFile(join(f.ledgerRoot, "items", "TEST-worker--attempt-1.json"), bytesOf({ jobId: "TEST-worker", status: "failed_no_output" }));
    expect(await f.run({ confirmRetention: true, expectedPlanSha256: "0".repeat(64) })).toMatchObject({ error: "consumed_output_ledger_terminal_conflict" });
    await f.noArchive();
  });

  it("archives exact lifecycle bytes and reconstructs distinct staged and worktree state from custody alone", async () => {
    const f = await fixture(failed);
    const stagedBlob = (await exec("git", ["show", ":a.txt"], { cwd: f.source })).stdout;
    const original = Object.fromEntries(await Promise.all([["result.json", f.resultPath], ["progress.json", f.progressPath], ["events.jsonl", f.eventsPath],
      ["job.json", codexGoalJobManifestPath({ registryRootDir: f.registryRootDir, jobId: f.workerJobId })], ["prompt.md", join(f.jobRootDir, "prompt.md")]]
      .map(async ([name, path]) => [name!, await readFile(path!)] as const)));
    expect(await f.confirm()).toMatchObject({ ok: true });
    const tarEntry = (archive: string, name: string) => spawnSync("tar", ["-xOf", f.archiveFile(archive), name], { maxBuffer: 1 << 26 }).stdout;
    // The archived bytes are the failed result, events, progress and job metadata themselves, not hashes of mutable paths.
    for (const [name, bytes] of Object.entries(original)) expect(tarEntry("lifecycle.tar", name).equals(bytes)).toBe(true);
    expect(spawnSync("tar", ["-tf", f.archiveFile("lifecycle.tar")]).stdout.toString().split("\n").filter(Boolean).sort())
      .toEqual(["events.jsonl", "job.json", "progress.json", "prompt.md", "result.json"]); // absent files are not synthesized
    // Staged blob A as its own object, binary-safe, independent of worktree B.
    expect(tarEntry("staged.tar", "a.txt").toString()).toBe(stagedBlob);
    expect(stagedBlob).toBe("staged by the original attempt\n");
    const receipt = JSON.parse((await readFile(f.archiveFile("retained-nonqualified-attempt.json"))).toString());
    const entry = receipt.inventory.entries.find((item: { path: string }) => item.path === "a.txt");
    expect(entry).toMatchObject({ status: "MM", index: { mode: "100644" } });
    // Rebuild the original state in a scratch clone of HEAD using only the retained evidence.
    const clone = join(f.root, "recovery-clone");
    await exec("git", ["clone", "--quiet", f.source, clone]);
    await git(clone, "apply", f.archiveFile("tracked.diff"));
    expect(await readFile(join(clone, "a.txt"), "utf8")).toBe("edited by the original attempt\n"); // worktree B
    const staged = spawnSync("git", ["hash-object", "-w", "--stdin"], { cwd: clone, input: tarEntry("staged.tar", "a.txt") }).stdout.toString().trim();
    expect(staged).toBe(entry.index.oid); // index A recovered exactly, and it is not the worktree content
    expect(staged).not.toBe(spawnSync("git", ["hash-object", "--stdin"], { cwd: clone, input: Buffer.from("edited by the original attempt\n") }).stdout.toString().trim());
    // Actually rebuild the independent index entry from the receipt's mode/oid and compare it to the original index.
    await git(clone, "update-index", "--cacheinfo", `${entry.index.mode},${entry.index.oid},a.txt`);
    expect((await exec("git", ["ls-files", "-s", "a.txt"], { cwd: clone })).stdout)
      .toBe((await exec("git", ["ls-files", "-s", "a.txt"], { cwd: f.source })).stdout);
    // The tracked-only patch carries NO untracked file ...
    expect(await readFile(join(clone, "binary.dat")).catch(() => null)).toBeNull();
    // ... and the complete raw tar restores every untracked and selected ignored input byte for byte, with its mode.
    const rawRestore = join(f.root, "raw-restore");
    await mkdir(rawRestore);
    expect(spawnSync("tar", ["-xf", f.archiveFile("untracked.tar"), "-C", rawRestore]).status).toBe(0);
    for (const path of ["binary.dat", "capsule/input.txt", "capsule/deep/tool.sh", "logs/validation.log"]) {
      expect(await readFile(join(rawRestore, path))).toEqual(await readFile(join(f.source, path)));
      expect((await stat(join(rawRestore, path))).mode & 0o777).toBe((await stat(join(f.source, path))).mode & 0o777);
    }
    expect(await readFile(join(rawRestore, "binary.dat"))).toEqual(Buffer.from([0, 255, 1, 2]));
  });

  it("refuses a permit that names an unsupported resource policy before any effect", async () => {
    const f = await fixture(missing);
    for (const policy of ["unlimited", "expanded_v2", ""]) {
      await f.update({ resourcePolicy: policy as never });
      expect(await f.run({ confirmRetention: true, expectedPlanSha256: "0".repeat(64) })).toMatchObject({ ok: false });
      await f.noDecision(); await f.noArchive();
    }
  });

  it("binds the finite policy: the default policy refuses an oversize file from metadata alone, with no receipt or ledger", async () => {
    const f = await fixture(missing);
    await writeFile(join(f.source, "huge.bin"), ""); await truncate(join(f.source, "huge.bin"), 64 * 1024 * 1024 + 1); // sparse
    expect(await f.run()).toMatchObject({ ok: false, error: "retained_nonqualified_inventory_too_large" });
    await f.noDecision(); await f.noArchive();
  });

  it("consumes the expanded policy only through the retention role's memory port; an ordinary tool call, a tight allowance and an adequate one behave differently", async () => {
    // The port is what only the Host's retention operator role constructs (see retention-operation-host.ts); here it is an
    // injected observation, so this binds the MECHANISM of the real operation, not any host authority.
    const f = await fixture(missing);
    await f.update({ resourcePolicy: RetainedNonqualifiedResourcePolicyId.ExpandedV1 });
    const permitFile = join(f.root, "retain-intent.json");
    const args = { registryRootDir: f.registryRootDir, controllerJobId: f.controllerJobId, workerJobId: f.workerJobId, permitFile,
      expectedPermitSha256: rootPermitSha256(await readFile(permitFile)) };
    const port = (effectiveBytes: number) => async () => ({ hostAvailableBytes: effectiveBytes, cgroupRemainingBytes: undefined, effectiveBytes, cgroupVersion: "v2" as const });
    // No port (every MCP caller): refused before any effect, whatever the permit says.
    expect(await f.run()).toMatchObject({ ok: false, error: expect.stringContaining("retained_nonqualified_memory_unknown") });
    await f.noDecision(); await f.noArchive();
    // A tight allowance (the live enclosing limit leaves less than 8 x 512 MiB + 256 MiB): refused before any effect.
    await expect(projectControlRetainNonqualifiedAttempt(args, port(GIB))).rejects.toThrow("retained_nonqualified_memory_insufficient");
    await f.noDecision(); await f.noArchive();
    // An adequate allowance: the same real operation previews, then retains under the expanded policy.
    const preview = await projectControlRetainNonqualifiedAttempt(args, port(8 * GIB));
    expect(preview.structuredContent).toMatchObject({ ok: false, reason: "confirm_retention_required", resourcePolicy: "expanded_v1",
      memory: { requiredBytes: 4.25 * GIB, effectiveBytes: 8 * GIB } });
    const planSha256 = (preview.structuredContent as { planSha256: string }).planSha256;
    const retained = await projectControlRetainNonqualifiedAttempt({ ...args, confirmRetention: true, expectedPlanSha256: planSha256 }, port(8 * GIB));
    expect(retained.structuredContent).toMatchObject({ ok: true });
    expect(JSON.parse((await readFile(f.archiveFile("retained-nonqualified-attempt.json"))).toString())).toMatchObject({ schemaVersion: 2, resourcePolicy: "expanded_v1" });
    // Admission verifies by streaming hashes: it needs no memory authority and no port, and still clears the debt.
    expect(await f.admission()).toMatchObject({ decision: { allowed: true } });
    // Same-permit replay needs no memory authority either (payloads are streamed), and stays byte-identical.
    const receipt = await readFile(f.archiveFile("retained-nonqualified-attempt.json"));
    expect(await f.run({ confirmRetention: true })).toMatchObject({ ok: true });
    expect(await readFile(f.archiveFile("retained-nonqualified-attempt.json"))).toEqual(receipt);
  });

  it("the policy is hash-bound: a conflicting external permit is refused on replay while the immutable archive and its admission stay intact", async () => {
    // Host-independent on purpose: the expanded policy's live memory admission needs a Linux cgroup and is
    // covered by the resources test and the (opt-in) actual-size runner, not by this portable suite.
    // f.update changes only the mutable EXTERNAL permit file; admission reads the immutable archived receipt and
    // the current originals, so it must neither follow nor be broken by a later conflicting request.
    const f = await fixture(missing);
    expect(await f.preview()).toMatchObject({ resourcePolicy: "default_v1", memory: null });
    expect(await f.confirm()).toMatchObject({ ok: true });
    const receipt = await readFile(f.archiveFile("retained-nonqualified-attempt.json"));
    const intentBytes = await readFile(f.archiveFile("owner-intent.json"));
    const ledger = (await f.readLedger()).byJobId.get("TEST-worker");
    expect(await f.admission()).toMatchObject({ decision: { allowed: true } });
    await f.update({ resourcePolicy: RetainedNonqualifiedResourcePolicyId.ExpandedV1 });
    expect(await f.run({ confirmRetention: true })).toMatchObject({ ok: false });
    expect(await readFile(f.archiveFile("retained-nonqualified-attempt.json"))).toEqual(receipt);
    expect(await readFile(f.archiveFile("owner-intent.json"))).toEqual(intentBytes);
    expect((await f.readLedger()).byJobId.get("TEST-worker")).toEqual(ledger);
    expect(await f.admission()).toMatchObject({ decision: { allowed: true } });
  });

  it("reads an existing owner intent under exactly its own length, so a grown partial intent is refused before it is buffered", async () => {
    const f = await fixture(missing);
    const intentLength = (await readFile(join(f.root, "retain-intent.json"))).length;
    const original = LocalProjectControlEvidenceCustody.prototype.publishImmutableBytes;
    let interrupt = true;
    vi.spyOn(LocalProjectControlEvidenceCustody.prototype, "publishImmutableBytes").mockImplementation(async function(this: LocalProjectControlEvidenceCustody, input) {
      const result = await original.call(this, input);
      if (input.fileName === "owner-intent.json" && interrupt) { interrupt = false; throw new Error("TEST_interrupted_after_intent"); }
      return result;
    });
    const plan = (await f.preview()).planSha256;
    expect(await f.run({ confirmRetention: true, expectedPlanSha256: plan })).toMatchObject({ error: "TEST_interrupted_after_intent" });
    // Grow the partial intent far beyond its length; the equality read must be capped, not admitted at the payload allowance.
    await chmod(f.archiveFile("owner-intent.json"), 0o644);
    await appendFile(f.archiveFile("owner-intent.json"), Buffer.alloc(2 * 1024 * 1024, 0x20));
    const reads = vi.spyOn(LocalProjectControlEvidenceCustody.prototype, "readImmutableFile");
    expect(await f.run({ confirmRetention: true, expectedPlanSha256: plan })).toMatchObject({ ok: false, error: "retained_nonqualified_preparation_conflict" });
    const intentReads = reads.mock.calls.filter(([path]) => String(path).endsWith("owner-intent.json"));
    expect(intentReads.length).toBeGreaterThan(0);
    for (const [, max] of intentReads) expect(max).toBe(intentLength);
    await f.noDecision();
    expect(await f.custody.pathKind(f.archiveFile("retained-nonqualified-attempt.json"))).toBe("absent");
  });

  it("replay and admission read each payload under its recorded length: a payload grown on disk is refused", async () => {
    const f = await fixture(missing);
    expect(await f.confirm()).toMatchObject({ ok: true });
    await appendFile(f.archiveFile("git-status.txt"), "tampered growth\n");
    expect(await f.run({ confirmRetention: true })).toMatchObject({ ok: false });
    expect(await f.admission()).toMatchObject({ decision: { allowed: false } });
  });

  it("refuses an unclassified ignored file, a credential-looking one and a retain path that is not ignored", async () => {
    const f = await fixture(missing);
    await writeFile(join(f.source, "logs", "other.log"), "not named by the owner\n");
    expect(await f.run()).toMatchObject({ ok: false, error: expect.stringContaining("retained_nonqualified_ignored_unclassified:logs/other.log") });
    await rm(join(f.source, "logs", "other.log"));
    await f.update({ ignoredRetain: ["logs/validation.log", "a.txt"] });
    expect(await f.run()).toMatchObject({ ok: false, error: expect.stringContaining("retained_nonqualified_ignored_retain_not_ignored:a.txt") });
    await f.update({ ignoredRetain: ["logs/validation.log", "logs/.env"] });
    expect(await f.run()).toMatchObject({ ok: false, error: expect.stringContaining("retained_nonqualified_ignored_credential_path") });
    await f.noDecision(); await f.noArchive();
  });

  it("refuses a custom lifecycle path whose parent is a symlink to an external regular file, before receipt or ledger", async () => {
    const f = await fixture(missing);
    const external = join(f.root, "external-logs");
    await mkdir(external);
    await writeFile(join(external, "validation.log"), "EXTERNAL bytes that must never be copied\n");
    await symlink(external, join(f.jobRootDir, "logs"));
    const manifestPath = codexGoalJobManifestPath({ registryRootDir: f.registryRootDir, jobId: f.workerJobId });
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.logPath = join(f.jobRootDir, "logs", "validation.log");
    await writeFile(manifestPath, bytesOf(manifest));
    await f.update({ workerManifestSha256: rootPermitSha256(await readFile(manifestPath)) });
    const refused = await f.run();
    expect(refused).toMatchObject({ ok: false, error: expect.stringContaining("evidence_custody_root_noncanonical") });
    await f.noDecision(); await f.noArchive(); // nothing, including the external bytes, reached custody
    // A dangling parent alias and an absent leaf under it refuse as well; absence is not inferred.
    await rm(join(f.jobRootDir, "logs")); await symlink(join(f.root, "nowhere"), join(f.jobRootDir, "logs"));
    expect(await f.run()).toMatchObject({ ok: false });
    await f.noDecision(); await f.noArchive();
  });

  it("rejects index-only drift between preview and confirm even when HEAD, worktree and MM status are unchanged", async () => {
    const f = await fixture(missing); const plan = (await f.preview()).planSha256;
    await writeFile(join(f.source, "a.txt"), "staged by someone else\n"); await git(f.source, "add", "a.txt");
    await writeFile(join(f.source, "a.txt"), "edited by the original attempt\n");
    expect((await git(f.source, "status", "--porcelain", "--", "a.txt")).trim()).toBe("MM a.txt");
    expect(await f.run({ confirmRetention: true, expectedPlanSha256: plan })).toMatchObject({ error: "retained_nonqualified_plan_mismatch" });
    await f.noDecision(); await f.noArchive();
  });

  it.each([
    ["a stop event", (f: Fixture) => writeFile(join(f.jobRootDir, "TEST-worker.stop-event.json"), "{}\n")],
    ["an expired account reservation", (f: Fixture) => writeFile(join(f.jobRootDir, "account-reservation.json"), bytesOf({ expiresAt: "2020-01-01T00:00:00.000Z" }))],
    ["a staged-blob swap", async (f: Fixture) => { await writeFile(join(f.source, "a.txt"), "staged by someone else\n"); await git(f.source, "add", "a.txt");
      await writeFile(join(f.source, "a.txt"), "edited by the original attempt\n"); }],
  ])("publication CAS rejects drift of %s appearing after backup publication", async (_name, drift) => {
    const f = await fixture(missing); const plan = (await f.preview()).planSha256;
    const original = LocalProjectControlEvidenceCustody.prototype.publishImmutableBytes;
    vi.spyOn(LocalProjectControlEvidenceCustody.prototype, "publishImmutableBytes").mockImplementation(async function(this: LocalProjectControlEvidenceCustody, input) {
      const result = await original.call(this, input);
      if (input.fileName === "lifecycle.tar") await drift(f);
      return result;
    });
    expect(await f.run({ confirmRetention: true, expectedPlanSha256: plan })).toMatchObject({ ok: false, error: "retained_nonqualified_source_changed" });
    await f.noDecision();
    expect(await f.custody.pathKind(f.archiveFile("retained-nonqualified-attempt.json"))).toBe("absent");
  });

  it("after retention a lease created later, an independent holder and a missing archival payload each restore admission debt", async () => {
    const f = await fixture(missing); expect(await f.confirm()).toMatchObject({ ok: true });
    expect(await f.admission()).toMatchObject({ decision: { allowed: true } });
    await writeFile(join(f.jobRootDir, "account-reservation.json"), bytesOf({ expiresAt: new Date(Date.now() + 3_600_000).toISOString() }));
    expect(await f.admission()).toMatchObject({ decision: { allowed: false } });
    await rm(join(f.jobRootDir, "account-reservation.json"));
    expect(await f.admission()).toMatchObject({ decision: { allowed: true } });
    const holder = spawn("sleep", ["60"], { cwd: f.jobRootDir, stdio: "ignore" }); children.push(holder);
    expect(await f.admission()).toMatchObject({ decision: { allowed: false } });
    holder.kill("SIGKILL"); children.pop();
    await rm(f.archiveFile("lifecycle.tar"));
    expect(await f.admission()).toMatchObject({ decision: { allowed: false } });
  });

  it("replay refuses tampered retained backup bytes instead of adopting them", async () => {
    const f = await fixture(missing); expect(await f.confirm()).toMatchObject({ ok: true });
    await writeFile(f.archiveFile("tracked.numstat"), "tampered\n");
    expect(await f.run({ confirmRetention: true })).toMatchObject({ error: "retained_nonqualified_backup_hash_mismatch" });
    expect(await f.admission()).toMatchObject({ decision: { allowed: false } });
  });
});
}
