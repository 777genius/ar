import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { SubscriptionWorkerError, defaultSafeExecutionErrorClassifier, normalizeSafeExecutionPolicy, shouldContinueSafeExecutionAfterFailure } from "@vioxen/subscription-runtime/worker-core";
import { assertCodexGoalTurnCheckpointHistory, createCodexGoalTurnCheckpoint, type CodexGoalTurnCheckpointPublisher } from "../codex-goal-turn-checkpoint";
import { runConfigFromFlags } from "../codex-goal-cli-run-config";
import { parseFlags } from "../codex-goal-cli-support";
import { buildCodexGoalExecutorOptions } from "../codex-goal-runner";

const exec = promisify(execFile);
const roots: string[] = [];
const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd })).stdout.trim();
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "codex-turn-checkpoint-"));
  roots.push(root);
  const workspacePath = join(root, "workspace");
  const jobRootDir = join(root, "job");
  await mkdir(workspacePath);
  await mkdir(jobRootDir, { mode: 0o700 });
  await git(workspacePath, "init", "-q");
  await git(workspacePath, "config", "user.name", "Test");
  await git(workspacePath, "config", "user.email", "test@example.invalid");
  await writeFile(join(workspacePath, "base.txt"), "base\n");
  await git(workspacePath, "add", "base.txt");
  await git(workspacePath, "commit", "-qm", "base");
  return { root, workspacePath, jobRootDir, initialBaseCommit: await git(workspacePath, "rev-parse", "HEAD") };
}

function fakePublisher(receipts: string[]): CodexGoalTurnCheckpointPublisher {
  return async (input) => {
    expect(await readFile(input.patchPath, "utf8")).toBe(input.patch);
    expect(await readFile(input.manifestPath, "utf8")).toBe(input.manifestText);
    receipts.push(input.manifest.state);
    return { schemaVersion: 1, jobId: input.manifest.jobId, taskId: input.manifest.taskId,
      turnOrdinal: input.manifest.turnOrdinal, manifestSha256: sha256(input.manifestText),
      patchSha256: sha256(input.patch), remoteKey: `offsite/${input.manifest.turnOrdinal}`,
      unexpected: "discarded" };
  };
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("Codex goal turn checkpoint", () => {
  it("keeps a registered opt-in required when the operator socket is absent", async () => {
    const f = await fixture();
    const config = runConfigFromFlags(parseFlags([
      "--auth-root", join(f.root, "auth"), "--accounts", "account-1",
      "--workspace", f.workspacePath, "--prompt", join(f.root, "prompt.txt"),
      "--require-turn-checkpoint",
    ]), {}, f.root, f.jobRootDir, "task-1");
    expect(config.checkpointRequired).toBe(true);
    expect(() => buildCodexGoalExecutorOptions({ config, initialBaseCommit: f.initialBaseCommit,
      stateRootDir: join(f.root, "state"), encryptionKey: new Uint8Array(32) })).toThrow("checkpoint_publisher_required");
  });
  it("does not rotate accounts or replay a turn after checkpoint failure", () => {
    const classification = defaultSafeExecutionErrorClassifier(new SubscriptionWorkerError(
      "subscription_worker_run_failed", "Completed turn unprotected",
      { details: { reason: "checkpoint_unprotected" } },
    ));
    expect(classification).toMatchObject({ reason: "checkpoint_unprotected", retryable: false });
    for (const workspaceChanged of [false, true]) {
      expect(shouldContinueSafeExecutionAfterFailure({ classification,
        policy: normalizeSafeExecutionPolicy({ policy: { maxAttempts: 5, retryUnknownCleanWorkspace: true, retryUnknownChangedWorkspace: true } }),
        effectMode: "workspace_patch", workspaceChanged, attemptsRemaining: true,
      }).allowed).toBe(false);
    }
  });
  it("publishes exact immutable patch and a clean tombstone with distinct ordinals", async () => {
    const f = await fixture();
    const states: string[] = [];
    const checkpoint = createCodexGoalTurnCheckpoint({ ...f, jobId: "job-1", taskId: "task-1", publisher: fakePublisher(states) });
    await writeFile(join(f.workspacePath, "new.txt"), "content\n");
    await checkpoint({ workspacePath: f.workspacePath, runId: "run-1", turnNumber: 1 });
    const firstPatch = await readFile(join(f.jobRootDir, "turn-checkpoints/000001.patch"), "utf8");
    const firstManifest = JSON.parse(await readFile(join(f.jobRootDir, "turn-checkpoints/000001.manifest.json"), "utf8"));
    expect(firstManifest).toMatchObject({ initialBaseCommit: f.initialBaseCommit, turnOrdinal: 1,
      state: "patch", changedPaths: ["new.txt"], patchSha256: sha256(firstPatch) });
    const restored = join(f.root, "restored");
    await git(f.root, "clone", "-q", f.workspacePath, restored);
    await exec("git", ["apply", join(f.jobRootDir, "turn-checkpoints/000001.patch")], { cwd: restored });
    expect(await readFile(join(restored, "new.txt"), "utf8")).toBe("content\n");
    await rm(join(f.workspacePath, "new.txt"));
    await checkpoint({ workspacePath: f.workspacePath, runId: "run-1", turnNumber: 2 });
    const clean = JSON.parse(await readFile(join(f.jobRootDir, "turn-checkpoints/000002.manifest.json"), "utf8"));
    expect(clean).toMatchObject({ state: "clean", changedPaths: [], patchSha256: sha256("") });
    expect(await readFile(join(f.jobRootDir, "turn-checkpoints/000002.patch"), "utf8")).toBe("");
    expect(states).toEqual(["patch", "clean"]);
    const receipt = JSON.parse(await readFile(join(f.jobRootDir, "turn-checkpoints/000002.receipt.json"), "utf8"));
    expect(receipt).toMatchObject({ turnOrdinal: 2, remoteKey: "offsite/2" });
    expect(receipt).not.toHaveProperty("unexpected");
  });

  it("continues checkpoint ordinals after a clean, patch, and relaunch", async () => {
    const f = await fixture();
    const states: string[] = [];
    const input = { ...f, jobId: "job", taskId: "task", publisher: fakePublisher(states) };
    const firstRun = createCodexGoalTurnCheckpoint(input);
    await firstRun({ workspacePath: f.workspacePath, runId: "first", turnNumber: 1 });
    await writeFile(join(f.workspacePath, "new.txt"), "dirty\n");
    await firstRun({ workspacePath: f.workspacePath, runId: "first", turnNumber: 2 });
    expect(await assertCodexGoalTurnCheckpointHistory(input)).toBe(2);
    await rm(join(f.workspacePath, "new.txt"));
    const relaunched = createCodexGoalTurnCheckpoint(input);
    await relaunched({ workspacePath: f.workspacePath, runId: "second", turnNumber: 1 });
    expect(states).toEqual(["clean", "patch", "clean"]);
    expect(await assertCodexGoalTurnCheckpointHistory(input)).toBe(3);
    expect(JSON.parse(await readFile(join(f.jobRootDir,
      "turn-checkpoints/000003.manifest.json"), "utf8"))).toMatchObject({
        turnOrdinal: 3, state: "clean", changedPaths: [],
      });
    expect(JSON.parse(await readFile(join(f.jobRootDir,
      "turn-checkpoints/000002.manifest.json"), "utf8"))).toMatchObject({ state: "patch" });
  });

  it("rejects partial and mismatched persisted history at admission", async () => {
    const partial = await fixture();
    const partialStates: string[] = [];
    const partialInput = { ...partial, jobId: "job", taskId: "task", publisher: fakePublisher(partialStates) };
    await createCodexGoalTurnCheckpoint(partialInput)({ workspacePath: partial.workspacePath,
      runId: "first", turnNumber: 1 });
    await rm(join(partial.jobRootDir, "turn-checkpoints/000001.receipt.json"));
    await expect(assertCodexGoalTurnCheckpointHistory(partialInput)).rejects.toThrow("checkpoint_history_incomplete");
    await expect(createCodexGoalTurnCheckpoint(partialInput)({ workspacePath: partial.workspacePath,
      runId: "second", turnNumber: 1 })).rejects.toThrow("checkpoint_history_incomplete");
    expect(partialStates).toEqual(["clean"]);

    const incomplete = await fixture();
    const incompleteInput = { ...incomplete, jobId: "job", taskId: "task", publisher: fakePublisher([]) };
    await createCodexGoalTurnCheckpoint(incompleteInput)({ workspacePath: incomplete.workspacePath,
      runId: "first", turnNumber: 1 });
    await rm(join(incomplete.jobRootDir, "turn-checkpoints/000001.manifest.json"));
    await expect(assertCodexGoalTurnCheckpointHistory(incompleteInput)).rejects.toThrow("checkpoint_history_incomplete");

    const mismatched = await fixture();
    const mismatchInput = { ...mismatched, jobId: "job", taskId: "task", publisher: fakePublisher([]) };
    await createCodexGoalTurnCheckpoint(mismatchInput)({ workspacePath: mismatched.workspacePath,
      runId: "first", turnNumber: 1 });
    const receiptPath = join(mismatched.jobRootDir, "turn-checkpoints/000001.receipt.json");
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    await writeFile(receiptPath, `${JSON.stringify({ ...receipt, manifestSha256: "0".repeat(64) })}\n`);
    await expect(assertCodexGoalTurnCheckpointHistory(mismatchInput)).rejects.toThrow("checkpoint_history_mismatch");
  });

  it("restores the final worktree across staged, unstaged, untracked, and binary patch sections", async () => {
    const f = await fixture();
    await writeFile(join(f.workspacePath, ".gitattributes"), "*.bin -diff\n");
    await git(f.workspacePath, "add", ".gitattributes");
    await git(f.workspacePath, "commit", "-qm", "binary attributes");
    const initialBaseCommit = await git(f.workspacePath, "rev-parse", "HEAD");
    await writeFile(join(f.workspacePath, "base.txt"), "staged\n");
    await git(f.workspacePath, "add", "base.txt");
    await writeFile(join(f.workspacePath, "base.txt"), "final worktree\n");
    await writeFile(join(f.workspacePath, "new.txt"), "untracked\n");
    await writeFile(join(f.workspacePath, "asset.bin"), "binary patch payload\n");
    const states: string[] = [];
    const checkpoint = createCodexGoalTurnCheckpoint({ ...f, initialBaseCommit,
      jobId: "job", taskId: "task", publisher: fakePublisher(states) });
    await checkpoint({ workspacePath: f.workspacePath, runId: "run", turnNumber: 1 });
    const patch = await readFile(join(f.jobRootDir, "turn-checkpoints/000001.patch"), "utf8");
    expect(patch).toContain("GIT binary patch");
    const restored = join(f.root, "restored-mixed");
    await git(f.root, "clone", "-q", f.workspacePath, restored);
    await exec("git", ["apply", join(f.jobRootDir, "turn-checkpoints/000001.patch")], { cwd: restored });
    expect(await readFile(join(restored, "base.txt"), "utf8")).toBe("final worktree\n");
    expect(await readFile(join(restored, "new.txt"), "utf8")).toBe("untracked\n");
    expect(await readFile(join(restored, "asset.bin"), "utf8")).toBe("binary patch payload\n");
    expect(states).toEqual(["patch"]);
  });

  it("captures a forced staged addition matching .gitignore from the initial base", async () => {
    const f = await fixture();
    await writeFile(join(f.workspacePath, ".gitignore"), "ignored.txt\n");
    await git(f.workspacePath, "add", ".gitignore");
    await git(f.workspacePath, "commit", "-qm", "ignore test file");
    const initialBaseCommit = await git(f.workspacePath, "rev-parse", "HEAD");
    await writeFile(join(f.workspacePath, "ignored.txt"), "important staged bytes\n");
    await git(f.workspacePath, "add", "-f", "ignored.txt");
    const states: string[] = [];
    await createCodexGoalTurnCheckpoint({ ...f, initialBaseCommit,
      jobId: "job", taskId: "task", publisher: fakePublisher(states) })({
        workspacePath: f.workspacePath, runId: "run", turnNumber: 1,
      });
    const patchPath = join(f.jobRootDir, "turn-checkpoints/000001.patch");
    const manifest = JSON.parse(await readFile(join(f.jobRootDir,
      "turn-checkpoints/000001.manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ state: "patch", changedPaths: ["ignored.txt"] });
    expect(states).toEqual(["patch"]);
    const restored = join(f.root, "restored-ignored");
    await git(f.root, "clone", "-q", f.workspacePath, restored);
    await exec("git", ["apply", patchPath], { cwd: restored });
    expect(await readFile(join(restored, "ignored.txt"), "utf8"))
      .toBe("important staged bytes\n");
  });

  it("treats a forced staged ignored addition removed from the worktree as clean", async () => {
    const f = await fixture();
    await writeFile(join(f.workspacePath, ".gitignore"), "ignored.txt\n");
    await git(f.workspacePath, "add", ".gitignore");
    await git(f.workspacePath, "commit", "-qm", "ignore test file");
    const initialBaseCommit = await git(f.workspacePath, "rev-parse", "HEAD");
    await writeFile(join(f.workspacePath, "ignored.txt"), "staged only\n");
    await git(f.workspacePath, "add", "-f", "ignored.txt");
    await rm(join(f.workspacePath, "ignored.txt"));
    const states: string[] = [];
    await createCodexGoalTurnCheckpoint({ ...f, initialBaseCommit,
      jobId: "job", taskId: "task", publisher: fakePublisher(states) })({
        workspacePath: f.workspacePath, runId: "run", turnNumber: 1,
      });
    expect(states).toEqual(["clean"]);
    expect(JSON.parse(await readFile(join(f.jobRootDir,
      "turn-checkpoints/000001.manifest.json"), "utf8"))).toMatchObject({
        state: "clean", changedPaths: [], patchSha256: sha256(""),
      });
    expect(await readFile(join(f.jobRootDir, "turn-checkpoints/000001.patch"), "utf8")).toBe("");
  });

  it("detects a staged ignored addition restored during capture", async () => {
    const f = await fixture();
    await writeFile(join(f.workspacePath, ".gitignore"), "ignored.txt\n");
    await git(f.workspacePath, "add", ".gitignore");
    await git(f.workspacePath, "commit", "-qm", "ignore test file");
    await writeFile(join(f.workspacePath, "ignored.txt"), "staged only\n");
    await git(f.workspacePath, "add", "-f", "ignored.txt");
    await rm(join(f.workspacePath, "ignored.txt"));
    await writeFile(join(f.workspacePath, "base.txt"), "modified\n");
    const states: string[] = [];
    const checkpoint = createCodexGoalTurnCheckpoint({ ...f,
      initialBaseCommit: await git(f.workspacePath, "rev-parse", "HEAD"),
      jobId: "job", taskId: "task", publisher: fakePublisher(states),
      testHooks: { afterSafetyScan: async (scan) => {
        if (scan === 1) await writeFile(join(f.workspacePath, "ignored.txt"), "staged only\n");
      } },
    });
    await expect(checkpoint({ workspacePath: f.workspacePath, runId: "run", turnNumber: 1 }))
      .rejects.toThrow("handoff_workspace_changed_during_materialization");
    expect(states).toEqual([]);
  });

  it("rejects a forced staged ignored file changed after its first snapshot", async () => {
    const f = await fixture();
    await writeFile(join(f.workspacePath, ".gitignore"), "ignored.txt\n");
    await git(f.workspacePath, "add", ".gitignore");
    await git(f.workspacePath, "commit", "-qm", "ignore test file");
    await writeFile(join(f.workspacePath, "ignored.txt"), "first bytes\n");
    await git(f.workspacePath, "add", "-f", "ignored.txt");
    const states: string[] = [];
    const checkpoint = createCodexGoalTurnCheckpoint({ ...f,
      initialBaseCommit: await git(f.workspacePath, "rev-parse", "HEAD"),
      jobId: "job", taskId: "task", publisher: fakePublisher(states),
      testHooks: { afterPatchSnapshot: async (snapshot) => {
        if (snapshot === 1) await writeFile(join(f.workspacePath, "ignored.txt"), "later bytes\n");
      } },
    });
    await expect(checkpoint({ workspacePath: f.workspacePath, runId: "run", turnNumber: 1 }))
      .rejects.toThrow("handoff_workspace_changed_during_materialization");
    expect(states).toEqual([]);
  });

  it("rejects a forced staged ignored file removed from the index during capture", async () => {
    const f = await fixture();
    await writeFile(join(f.workspacePath, ".gitignore"), "ignored.txt\n");
    await git(f.workspacePath, "add", ".gitignore");
    await git(f.workspacePath, "commit", "-qm", "ignore test file");
    await writeFile(join(f.workspacePath, "ignored.txt"), "important bytes\n");
    await git(f.workspacePath, "add", "-f", "ignored.txt");
    const states: string[] = [];
    const checkpoint = createCodexGoalTurnCheckpoint({ ...f,
      initialBaseCommit: await git(f.workspacePath, "rev-parse", "HEAD"),
      jobId: "job", taskId: "task", publisher: fakePublisher(states),
      testHooks: { afterPatchSnapshot: async (snapshot) => {
        if (snapshot === 1) await git(f.workspacePath, "rm", "--cached", "--", "ignored.txt");
      } },
    });
    await expect(checkpoint({ workspacePath: f.workspacePath, runId: "run", turnNumber: 1 }))
      .rejects.toThrow("handoff_workspace_changed_during_materialization");
    expect(states).toEqual([]);
  });

  it("scans forced staged ignored content before publication", async () => {
    const f = await fixture();
    await writeFile(join(f.workspacePath, ".gitignore"), "ignored.txt\n");
    await git(f.workspacePath, "add", ".gitignore");
    await git(f.workspacePath, "commit", "-qm", "ignore test file");
    await writeFile(join(f.workspacePath, "ignored.txt"), "sk-" + "m".repeat(24) + "\n");
    await git(f.workspacePath, "add", "-f", "ignored.txt");
    const states: string[] = [];
    await expect(createCodexGoalTurnCheckpoint({ ...f,
      initialBaseCommit: await git(f.workspacePath, "rev-parse", "HEAD"),
      jobId: "job", taskId: "task", publisher: fakePublisher(states),
    })({ workspacePath: f.workspacePath, runId: "run", turnNumber: 1 }))
      .rejects.toThrow("handoff_raw_secret_rejected:ignored.txt");
    expect(states).toEqual([]);
  });

  it("rejects a hostile mutation captured between safety scans before writing or publishing", async () => {
    const f = await fixture();
    const path = join(f.workspacePath, "mutation-window.txt");
    const safe = "safe content\n";
    const unsafe = ["s", "k", "-"].join("") + "m".repeat(24) + "\n";
    await writeFile(path, safe);
    const calls: string[] = [];
    const checkpoint = createCodexGoalTurnCheckpoint({ ...f, jobId: "job", taskId: "task",
      publisher: fakePublisher(calls), testHooks: {
        afterSafetyScan: async () => { await writeFile(path, unsafe); },
        afterPatchSnapshot: async (snapshot) => { if (snapshot === 1) await writeFile(path, safe); },
      } });
    await expect(checkpoint({ workspacePath: f.workspacePath, runId: "run", turnNumber: 1 }))
      .rejects.toThrow("handoff_raw_secret_rejected:mutation-window.txt");
    expect(calls).toEqual([]);
    await expect(readFile(join(f.jobRootDir, "turn-checkpoints/000001.patch")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed on secret, size, moved HEAD, and missing receipt", async () => {
    const secret = await fixture();
    await writeFile(join(secret.workspacePath, "auth.json"), "{}\n");
    const calls: string[] = [];
    await expect(createCodexGoalTurnCheckpoint({ ...secret, jobId: "job", taskId: "task", publisher: fakePublisher(calls) })({ workspacePath: secret.workspacePath, runId: "run", turnNumber: 1 })).rejects.toThrow();
    expect(calls).toEqual([]);

    const size = await fixture();
    await writeFile(join(size.workspacePath, "large.txt"), "12345");
    await expect(createCodexGoalTurnCheckpoint({ ...size, jobId: "job", taskId: "task", publisher: fakePublisher(calls), limits: { maxFileBytes: 4 } })({ workspacePath: size.workspacePath, runId: "run", turnNumber: 1 })).rejects.toThrow("handoff_file_byte_limit_exceeded");

    const moved = await fixture();
    await writeFile(join(moved.workspacePath, "committed.txt"), "committed\n");
    await git(moved.workspacePath, "add", "committed.txt");
    await git(moved.workspacePath, "commit", "-qm", "new head");
    await expect(createCodexGoalTurnCheckpoint({ ...moved, jobId: "job", taskId: "task", publisher: fakePublisher(calls) })({ workspacePath: moved.workspacePath, runId: "run", turnNumber: 1 })).rejects.toThrow("handoff_base_commit_mismatch");

    const missing = await fixture();
    await expect(createCodexGoalTurnCheckpoint({ ...missing, jobId: "job", taskId: "task", publisher: async () => undefined as never })({ workspacePath: missing.workspacePath, runId: "run", turnNumber: 1 })).rejects.toThrow("checkpoint_receipt_invalid");

    const mismatched = await fixture();
    await expect(createCodexGoalTurnCheckpoint({ ...mismatched, jobId: "job", taskId: "task", publisher: async (input) => ({
      schemaVersion: 1, jobId: input.manifest.jobId, taskId: input.manifest.taskId,
      turnOrdinal: input.manifest.turnOrdinal, manifestSha256: "0".repeat(64),
      patchSha256: input.manifest.patchSha256, remoteKey: "offsite/wrong",
    }) })({ workspacePath: mismatched.workspacePath, runId: "run", turnNumber: 1 })).rejects.toThrow("checkpoint_receipt_invalid");

    const raced = await fixture();
    await expect(createCodexGoalTurnCheckpoint({ ...raced, jobId: "job", taskId: "task", publisher: async (input) => {
      await writeFile(join(raced.workspacePath, "late.txt"), "late\n");
      return fakePublisher(calls)(input);
    } })({ workspacePath: raced.workspacePath, runId: "run", turnNumber: 1 })).rejects.toThrow("checkpoint_workspace_changed_during_publish");
    await expect(readFile(join(raced.jobRootDir, "turn-checkpoints/000001.receipt.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
