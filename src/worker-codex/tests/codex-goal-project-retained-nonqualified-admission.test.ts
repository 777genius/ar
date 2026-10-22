import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { appendFile, chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AccessBoundary,
  NetworkAccessMode,
  ProjectAdmissionWorkerRole,
  ProjectOperation,
  RETAINED_NONQUALIFIED_STATUS,
  RetainedNonqualifiedOriginalKind,
  type ProjectAccessScope,
  type RetainedNonqualifiedReceipt,
} from "@vioxen/subscription-runtime/worker-core";
import {
  buildCodexProjectAdmissionSnapshot,
  codexProjectAdmissionGate,
  type CodexProjectAdmissionDeps,
} from "../application/project-control/codex-goal-project-admission";
import { stoppedWorkspaceTerminalConsumption } from "../application/project-control/codex-goal-project-terminal-consumption";
import { captureRetainedLifecycle, retainedLifecyclePaths, retainedLifecycleTar } from "../application/project-control/codex-goal-retained-nonqualified-lifecycle";
import { buildTar } from "../codex-goal-handoff-untracked-tar";
import { captureRetainedWorkspaceInventory } from "../application/project-control/codex-goal-retained-nonqualified-inventory";
import { createCodexGoalJob, listCodexGoalJobs, readCodexGoalJob } from "../codex-goal-jobs";

// The Linux custody-path process inventory has its own tests; here only its verdict is controlled so
// the reader's decision on a fresh holder is observable on every platform.
const holders = vi.hoisted(() => ({ blockers: [] as { pid: number; startTime: string; argvSha256: string; cwd: string }[] }));
vi.mock("../application/project-control/codex-goal-legacy-attempt-process-evidence", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../application/project-control/codex-goal-legacy-attempt-process-evidence")>()),
  captureLegacyAttemptProcessEvidence: async (input: { custodyPaths: readonly string[] }) => ({
    schemaVersion: 1 as const, observedAt: new Date().toISOString(), inspectedPidCount: 1, inventorySha256: "0".repeat(64),
    custodyPaths: [...input.custodyPaths], blockers: holders.blockers }),
}));

// Held, ancestor-safe reads need the Linux evidence custody. On other hosts production refuses (fail closed);
// here only, a plain-fs double of the same PORT lets the verifier's decisions run. The real custody
// (alias, dangling parent, parent replacement) is exercised in the Linux-only tests below and in
// project-control-evidence-custody-local-adapter.test.ts.
vi.mock("../../worker-local/project-control-evidence-custody-local-adapter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../worker-local/project-control-evidence-custody-local-adapter")>();
  if (actual.localProjectControlEvidenceCustodySupported) return actual;
  const fs = await import("node:fs/promises");
  const crypto = await import("node:crypto");
  class PortDouble {
    async readImmutableFile(path: string, maxBytes: number) {
      const info = await fs.lstat(path);
      if (!info.isFile() || info.size > maxBytes) throw new Error("evidence_custody_file_invalid");
      const bytes = await fs.readFile(path);
      return { canonicalPath: path, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), length: bytes.length, bytes, mode: info.mode & 0o777 };
    }
    async readOptionalImmutableFile(path: string, maxBytes: number) {
      try { return await this.readImmutableFile(path, maxBytes); }
      catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined; throw error; }
    }
  }
  return { ...actual, LocalProjectControlEvidenceCustody: PortDouble };
});

// Suite role (rule 31 clause 3): these tests bind the ADMISSION READER. They hand-build
// the retained originals (receipt, ledger record) because the producer is the root-only
// operation, which codex-goal-mcp-project-retained-nonqualified.test.ts drives end to end
// in the root Linux lane. Here the property is: retained custody suppresses debt only
// while the exact originals are still on disk; every change restores blocking debt.

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd })).stdout;
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { holders.blockers = []; for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(kind: RetainedNonqualifiedOriginalKind) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "retained-admission-TEST-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "worktrees", "TEST-worker"), registry = join(root, "registry"), jobRoot = join(root, "jobs", "TEST-worker");
  const ledgerRoot = join(root, "ledger"), evidenceRoot = join(root, "evidence"), archive = join(evidenceRoot, "nonqualified-retention-TEST-worker");
  for (const path of [workspace, join(registry, "TEST-worker"), jobRoot, join(ledgerRoot, "items"), archive]) await mkdir(path, { recursive: true });
  await git(workspace, "init", "--quiet", "-b", "main");
  // The raw-identity guard refuses any Git conversion, including one inherited from the host's global config.
  await git(workspace, "config", "core.autocrlf", "false");
  await git(workspace, "config", "user.name", "iliya"); await git(workspace, "config", "user.email", "iliyazelenkog@gmail.com");
  await writeFile(join(workspace, "tracked.txt"), "base\n");
  await writeFile(join(workspace, ".gitignore"), "logs/\nnode_modules/\n");
  await git(workspace, "add", "-A"); await git(workspace, "commit", "--quiet", "-m", "chore(test): TEST base");
  // MM: the staged blob and the worktree bytes differ and neither equals HEAD.
  await writeFile(join(workspace, "tracked.txt"), "staged by the original attempt\n"); await git(workspace, "add", "tracked.txt");
  await writeFile(join(workspace, "tracked.txt"), "edited after staging\n");
  await mkdir(join(workspace, "logs")); await writeFile(join(workspace, "logs", "validation.log"), "useful ignored validation log\n");
  await mkdir(join(workspace, "node_modules", "dep"), { recursive: true }); await writeFile(join(workspace, "node_modules", "dep", "i.js"), "x\n");
  await writeFile(join(workspace, "capsule.txt"), "untracked TEST input\n");
  const scope: ProjectAccessScope = { projectId: "TEST-project", readRoots: [root], workspaceRoots: [join(root, "worktrees")],
    worktreeRoots: [join(root, "worktrees")], registryRoot: registry, jobIdPrefixes: ["TEST-"], tmuxSessionPrefixes: ["TEST-"],
    allowedAccountIds: ["account-a"], allowedGitRemotes: [], allowedBranches: ["main"],
    consumedOutputLedgerRoots: [ledgerRoot], consumedOutputEvidenceRoots: [evidenceRoot] };
  await writeFile(join(jobRoot, "prompt.md"), "Disposable TEST task\n");
  await createCodexGoalJob({ registryRootDir: registry, manifest: { jobId: "TEST-worker", jobRootDir: jobRoot, workspacePath: workspace,
    promptPath: join(jobRoot, "prompt.md"), taskId: "TEST-worker", accounts: ["account-a"], tags: ["worker-role-producer"],
    accessBoundary: AccessBoundary.IsolatedWorkspaceWrite, projectAccessScope: scope, networkAccess: NetworkAccessMode.Restricted } });
  const manifestPath = join(registry, "TEST-worker", "job.json");
  const resultPath = join(jobRoot, "TEST-worker.latest-result.json"), progressPath = join(jobRoot, "TEST-worker.progress.json");
  const eventsPath = join(jobRoot, "TEST-worker.events.jsonl"), stopPath = join(jobRoot, "TEST-worker.stop-event.json");
  await writeFile(progressPath, JSON.stringify({ status: "running", pid: 2147483000 }));
  await writeFile(eventsPath, '{"event":"executor_started"}\n{"event":"runner_disposed"}\n');
  if (kind === RetainedNonqualifiedOriginalKind.FailedCheckpoint) {
    await writeFile(resultPath, JSON.stringify({ status: "failed", reason: "checkpoint_unprotected" }));
  }
  const manifestNow = await readCodexGoalJob({ registryRootDir: registry, jobId: "TEST-worker" });
  const paths = retainedLifecyclePaths(manifestNow, registry);
  const lifecycle = await captureRetainedLifecycle(paths, { collect: true });
  const ignoredRetain = ["logs/validation.log"];
  const inventory = await captureRetainedWorkspaceInventory(workspace, { collect: true, ignoredRetain });
  const backup: Record<string, string | Buffer> = { "owner-intent.json": "{}\n", "git-status.txt": "?? capsule.txt\nMM tracked.txt\n", "tracked.diff": "diff\n",
    "tracked.numstat": "1\t1\ttracked.txt\n", "untracked.tar": buildTar(inventory.untrackedFiles), "staged.tar": buildTar(inventory.stagedFiles),
    "lifecycle.tar": retainedLifecycleTar(lifecycle.files) };
  for (const [name, bytes] of Object.entries(backup)) await writeFile(join(archive, name), bytes);
  const receipt: RetainedNonqualifiedReceipt = { schemaVersion: 1, operation: "retain_nonqualified_attempt", kind,
    sourceQualification: "not_assessed", replayAuthorized: false, permitSha256: "1".repeat(64), projectId: "TEST-project",
    controllerJobId: "TEST-controller", workerJobId: "TEST-worker", taskId: "TEST-worker", workspace, headCommit: inventory.headCommit,
    controllerManifestSha256: "2".repeat(64), workerManifestSha256: sha256(await readFile(manifestPath)),
    original: { ...lifecycle.states, ...(kind === RetainedNonqualifiedOriginalKind.FailedCheckpoint ? { resultStatus: "failed" as const } : {}) },
    ignored: { retain: ignoredRetain, disposableListing: inventory.disposableListing },
    inventory: { digest: inventory.digest, totalBytes: inventory.totalBytes, entries: inventory.entries },
    backupFiles: Object.fromEntries(Object.entries(backup).map(([name, bytes]) => [name, sha256(bytes)])), retainedAt: "2026-10-10T10:00:00.000Z" };
  const receiptPath = join(archive, "retained-nonqualified-attempt.json");
  const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
  await writeFile(receiptPath, receiptBytes);
  const writeRecord = async (overrides: Record<string, unknown> = {}) => writeFile(join(ledgerRoot, "items", "TEST-worker.json"), `${JSON.stringify({
    schemaVersion: 1, jobId: "TEST-worker", status: RETAINED_NONQUALIFIED_STATUS, closedAt: "2026-10-10T10:00:00.000Z", consumedAt: "2026-10-10T10:00:00.000Z",
    archivePath: archive, note: "custody only",
    retention: { schemaVersion: 1, kind, receiptPath, receiptSha256: sha256(receiptBytes), sourceQualification: "not_assessed", replayAuthorized: false },
    backup: { workspace, statusPath: join(archive, "git-status.txt"), patchPath: join(archive, "tracked.diff"),
      numstatPath: join(archive, "tracked.numstat"), untrackedArchivePath: join(archive, "untracked.tar") }, ...overrides })}\n`);
  const live = { alive: false, resultExists: kind === RetainedNonqualifiedOriginalKind.FailedCheckpoint };
  const deps: CodexProjectAdmissionDeps = {
    listJobs: async () => listCodexGoalJobs({ registryRootDir: registry }),
    readJob: async (input) => readCodexGoalJob(input),
    buildOverviewItems: async (inputs) => inputs.map(({ jobId }) => ({ ok: true, jobId, workspacePath: workspace, workspaceDirty: true,
      workerAlive: live.alive, workerProcessAlive: live.alive, progressProcessAlive: false, resultExists: live.resultExists,
      ...(live.resultExists ? { resultStatus: "failed" } : {}),
      activeWriterRisk: live.alive ? "active_worker" : "dirty_workspace_without_worker", activeWriterRiskReasons: [], tags: ["worker-role-producer"] })),
  };
  const snapshot = () => buildCodexProjectAdmissionSnapshot({ registryRootDir: registry, scope, deps });
  const blocking = async () => (await snapshot()).debt.filter(item => item.severity === "blocking");
  const allowed = async () => (await codexProjectAdmissionGate({ registryRootDir: registry, controllerJobId: "TEST-controller", scope, deps })
    .evaluate({ operation: ProjectOperation.CreateJob, workerRole: ProjectAdmissionWorkerRole.Producer })).allowed;
  return { workspace, archive, jobRoot, receiptPath, manifestPath, resultPath, eventsPath, progressPath, stopPath, live, writeRecord, blocking, allowed };
}

describe.each([RetainedNonqualifiedOriginalKind.ResultMissing, RetainedNonqualifiedOriginalKind.FailedCheckpoint])(
  "admission over retained_nonqualified custody (%s)", kind => {
    it("keeps the stopped dirty attempt blocking until retained, then admits only while the exact originals are unchanged", async () => {
      const f = await fixture(kind);
      expect(await f.allowed()).toBe(false);
      expect((await f.blocking()).length).toBeGreaterThan(0);
      await f.writeRecord();
      expect(await f.blocking()).toEqual([]);
      expect(await f.allowed()).toBe(true);
    });

    // A healthy live worker is a live-writer fact the admission gate blocks (blockAnyLiveWriter);
    // the snapshot itself reports no stale debt for it, so only the gate is asserted there.
    it.each([
      ["a tracked file is edited", async (f: Awaited<ReturnType<typeof fixture>>) => { await writeFile(join(f.workspace, "tracked.txt"), "edited again\n"); }],
      ["an untracked input is edited", async (f: Awaited<ReturnType<typeof fixture>>) => { await appendFile(join(f.workspace, "capsule.txt"), "more\n"); }],
      ["a new untracked file appears", async (f: Awaited<ReturnType<typeof fixture>>) => { await writeFile(join(f.workspace, "late.txt"), "new\n"); }],
      ["only the file mode changes", async (f: Awaited<ReturnType<typeof fixture>>) => { await chmod(join(f.workspace, "capsule.txt"), 0o755); }],
      ["the index changes without touching bytes", async (f: Awaited<ReturnType<typeof fixture>>) => { await git(f.workspace, "add", "capsule.txt"); }],
      ["the base commit moves", async (f: Awaited<ReturnType<typeof fixture>>) => { await git(f.workspace, "commit", "--quiet", "-am", "fix(test): move HEAD"); }],
      ["the job manifest bytes change", async (f: Awaited<ReturnType<typeof fixture>>) => { await appendFile(f.manifestPath, " "); }],
      ["the original events grow (a replay started)", async (f: Awaited<ReturnType<typeof fixture>>) => { await appendFile(f.eventsPath, '{"event":"executor_started"}\n'); }],
      ["the original progress changes", async (f: Awaited<ReturnType<typeof fixture>>) => { await writeFile(f.progressPath, JSON.stringify({ status: "completed" })); }],
      ["the original result changes or appears", async (f: Awaited<ReturnType<typeof fixture>>) => { await writeFile(f.resultPath, JSON.stringify({ status: "done" })); f.live.resultExists = true; }],
      ["a retained backup byte is corrupted", async (f: Awaited<ReturnType<typeof fixture>>) => { await writeFile(join(f.archive, "tracked.diff"), "tampered\n"); }],
      ["a retained backup file is deleted", async (f: Awaited<ReturnType<typeof fixture>>) => { await rm(join(f.archive, "untracked.tar")); }],
      ["the receipt is replaced", async (f: Awaited<ReturnType<typeof fixture>>) => { await writeFile(f.receiptPath, "{}\n"); }],
      ["the receipt is deleted", async (f: Awaited<ReturnType<typeof fixture>>) => { await rm(f.receiptPath); }],
      // Finding 2: HEAD, the worktree bytes and the "MM" porcelain status all stay constant; only the staged blob changes.
      ["only the staged blob changes (MM status, HEAD and worktree constant)", async (f: Awaited<ReturnType<typeof fixture>>) => {
        await writeFile(join(f.workspace, "tracked.txt"), "staged by someone else\n"); await git(f.workspace, "add", "tracked.txt");
        await writeFile(join(f.workspace, "tracked.txt"), "edited after staging\n");
        expect((await git(f.workspace, "status", "--porcelain", "--", "tracked.txt")).trim()).toBe("MM tracked.txt");
      }],
      ["only the staged mode changes", async (f: Awaited<ReturnType<typeof fixture>>) => { await git(f.workspace, "update-index", "--chmod=+x", "tracked.txt"); }],
      // Finding 1 and 4: the whole lifecycle, derived from the manifest, is compared with its mode.
      ["a job log appears", async (f: Awaited<ReturnType<typeof fixture>>) => { await writeFile(join(f.jobRoot, "TEST-worker.log"), "log\n"); }],
      ["a stop event appears", async (f: Awaited<ReturnType<typeof fixture>>) => { await writeFile(f.stopPath, "{}\n"); }],
      ["an unexpired account lease is created after retention", async (f: Awaited<ReturnType<typeof fixture>>) => {
        await writeFile(join(f.jobRoot, "account-reservation.json"), JSON.stringify({ expiresAt: new Date(Date.now() + 3_600_000).toISOString() })); }],
      ["an expired account reservation appears (state differs from the archived absence)", async (f: Awaited<ReturnType<typeof fixture>>) => {
        await writeFile(join(f.jobRoot, "account-reservation.json"), JSON.stringify({ expiresAt: "2020-01-01T00:00:00.000Z" })); }],
      ["a malformed account reservation appears", async (f: Awaited<ReturnType<typeof fixture>>) => { await writeFile(join(f.jobRoot, "account-reservation.json"), "not json"); }],
      ["the prompt changes", async (f: Awaited<ReturnType<typeof fixture>>) => { await appendFile(join(f.jobRoot, "prompt.md"), "more\n"); }],
      ["only the events file mode changes", async (f: Awaited<ReturnType<typeof fixture>>) => { // umask-independent: always a different mode than the archived one
        await chmod(f.eventsPath, ((await stat(f.eventsPath)).mode & 0o777) === 0o600 ? 0o644 : 0o600); }],
      ["an independent holder with a new PID appears", async () => { holders.blockers = [{ pid: 424242, startTime: "1", argvSha256: "0".repeat(64), cwd: "/" }]; }],
      // Finding 3: ignored files are retained or classified; a change or an unclassified newcomer restores debt.
      ["a retained ignored validation log is edited", async (f: Awaited<ReturnType<typeof fixture>>) => { await appendFile(join(f.workspace, "logs", "validation.log"), "tampered\n"); }],
      ["an unclassified ignored file appears", async (f: Awaited<ReturnType<typeof fixture>>) => { await writeFile(join(f.workspace, "logs", "other.log"), "new\n"); }],
      ["the lifecycle archive payload is deleted", async (f: Awaited<ReturnType<typeof fixture>>) => { await rm(join(f.archive, "lifecycle.tar")); }],
      ["the staged index archive payload is corrupted", async (f: Awaited<ReturnType<typeof fixture>>) => { await writeFile(join(f.archive, "staged.tar"), "tampered"); }],
    ])("restores blocking debt when %s", async (_name, change) => {
      const f = await fixture(kind);
      await f.writeRecord();
      expect(await f.allowed()).toBe(true);
      await change(f);
      expect((await f.blocking()).length).toBeGreaterThan(0);
      expect(await f.allowed()).toBe(false);
    });

    it("ignores dependency/cache directories but never an ignored credential-looking file", async () => {
      const f = await fixture(kind);
      await f.writeRecord();
      await writeFile(join(f.workspace, "node_modules", "dep", "i.js"), "changed dependency\n");
      expect(await f.allowed()).toBe(true);
      await writeFile(join(f.workspace, "logs", ".env"), "TOKEN=x\n");
      expect((await f.blocking()).length).toBeGreaterThan(0);
    });

    it("keeps the staged blob recoverable independently of the worktree (raw git, not the implementation)", async () => {
      const f = await fixture(kind);
      const staged = (await exec("git", ["show", ":tracked.txt"], { cwd: f.workspace })).stdout;
      expect(staged).toBe("staged by the original attempt\n");
      const tarred = (await exec("tar", ["-xOf", join(f.archive, "staged.tar"), "tracked.txt"])).stdout;
      expect(tarred).toBe(staged);
      expect(await readFile(join(f.workspace, "tracked.txt"), "utf8")).toBe("edited after staging\n"); // worktree differs
      const receipt = JSON.parse(await readFile(f.receiptPath, "utf8")) as RetainedNonqualifiedReceipt;
      const entry = receipt.inventory.entries.find(item => item.path === "tracked.txt")!;
      expect(entry).toMatchObject({ status: "MM", index: { mode: "100644" } });
      expect((await git(f.workspace, "ls-files", "--stage", "tracked.txt")).split(/\s+/)[1]).toBe(entry.index!.oid);
    });

    // Real custody only (Linux): the receipt, backups and originals must be reached through canonical ancestors.
    it.runIf(process.platform === "linux")("aliased receipt/backup parent restores debt even when the relocated bytes match", async () => {
      const f = await fixture(kind);
      await f.writeRecord();
      expect(await f.allowed()).toBe(true);
      await rename(f.archive, `${f.archive}.real`);
      await symlink(`${f.archive}.real`, f.archive);
      expect((await f.blocking()).length).toBeGreaterThan(0);
      expect(await f.allowed()).toBe(false);
    });

    it.runIf(process.platform === "linux")("aliased job-root parent of the original lifecycle files restores debt", async () => {
      const f = await fixture(kind);
      await f.writeRecord();
      expect(await f.allowed()).toBe(true);
      await rename(f.jobRoot, `${f.jobRoot}.real`);
      await symlink(`${f.jobRoot}.real`, f.jobRoot);
      expect(await f.allowed()).toBe(false);
    });

    it("never treats retained custody as proof that a process is gone", async () => {
      const f = await fixture(kind);
      await f.writeRecord();
      expect(await f.allowed()).toBe(true);
      f.live.alive = true;
      expect(await f.allowed()).toBe(false);
    });

    it("does not let a forged ledger record stand in for the retained originals", async () => {
      const f = await fixture(kind);
      const wrongKind = kind === RetainedNonqualifiedOriginalKind.ResultMissing
        ? RetainedNonqualifiedOriginalKind.FailedCheckpoint : RetainedNonqualifiedOriginalKind.ResultMissing;
      const original = await readFile(f.receiptPath);
      const retention = (receiptBytes: Buffer, k = kind) => ({ schemaVersion: 1, kind: k, receiptPath: f.receiptPath,
        receiptSha256: sha256(receiptBytes), sourceQualification: "not_assessed", replayAuthorized: false });
      // A kind label that disagrees with the preserved facts.
      await f.writeRecord({ retention: retention(original, wrongKind) });
      expect(await f.allowed()).toBe(false);
      // A self-consistent but different receipt (hash re-bound in the record) still names the wrong job identity.
      const forged = Buffer.from(JSON.stringify({ ...JSON.parse(original.toString()), workerManifestSha256: "9".repeat(64) }));
      await writeFile(f.receiptPath, forged);
      await f.writeRecord({ retention: retention(forged) });
      expect((await f.blocking()).length).toBeGreaterThan(0);
      expect(await f.allowed()).toBe(false);
    });
  });

describe("stopped workspace terminal consumption (inner guard)", () => {
  it("never accepts a retained_nonqualified record unless the caller re-verified the originals", async () => {
    const record = { jobId: "TEST-worker", status: RETAINED_NONQUALIFIED_STATUS, ledgerPath: "/ledger/items/TEST-worker.json", workspace: "/w",
      hasAuthoredOutput: false, structurallyValid: true, valid: true, evidence: [] };
    const ledger = { byJobId: new Map([["TEST-worker", record]]), byWorkspace: new Map(), debt: [] };
    const base = { ledger, jobId: "TEST-worker", workerAlive: false, workerExplicitlyStopped: true, workspaceDirty: true,
      workspacePath: "/w", resolvedWorkspacePath: "/w" };
    expect(await stoppedWorkspaceTerminalConsumption(base)).toBeUndefined();
    expect(await stoppedWorkspaceTerminalConsumption({ ...base, retainedNonqualifiedVerified: false })).toBeUndefined();
    expect(await stoppedWorkspaceTerminalConsumption({ ...base, retainedNonqualifiedVerified: true })).toBe(record);
    expect(await stoppedWorkspaceTerminalConsumption({ ...base, retainedNonqualifiedVerified: true, workerAlive: true })).toBeUndefined();
  });
});
