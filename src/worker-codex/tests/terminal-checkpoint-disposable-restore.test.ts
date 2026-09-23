import "./hosted-test-egress-default-fixture";
import "./unmanaged-goal-host-fixture";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createLocalFileSafeExecutionStores } from "@vioxen/subscription-runtime/store-local-file";
import { LocalTerminalCheckpointAdmission } from "@vioxen/subscription-runtime/store-local-file";
import { TerminalCheckpointDurablePhase } from "@vioxen/subscription-runtime/worker-core";
import { AtomicJsonRuntimeResultWriter } from "../codex-goal-runtime-result-io";
import { createCodexGoalJob, codexGoalJobManifestPath, updateCodexGoalJob } from "../codex-goal-jobs";
import { codexGoalAccountSlots, codexGoalOutputPath, codexGoalRuntimeEventsPath,
  runCodexGoal, type CodexGoalRunConfig } from "../codex-goal-runner";
import { sealTestTerminalAttemptCheckpoint, TestFakeExecutorOwnershipWitness,
  verifyTestTerminalAttemptCheckpoint } from
  "../terminal-checkpoint/test-terminal-attempt-checkpoint";
import { restoreDisposableTestCheckpoint } from
  "../terminal-checkpoint/disposable-test-restic-restore";

const execFileAsync = promisify(execFile);
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

async function makeWalDatabase(path: string, jobId: string, taskId: string,
  generation: string, attemptNumber: number): Promise<void> {
  const script = "import os,sqlite3,sys\nc=sqlite3.connect(sys.argv[1])\nc.execute('PRAGMA journal_mode=WAL')\nc.execute('PRAGMA user_version=1')\nc.execute('CREATE TABLE checkpoint_identity(schema_version INTEGER,job_id TEXT,task_id TEXT,generation TEXT,attempt_number INTEGER)')\nc.execute('INSERT INTO checkpoint_identity VALUES (1,?,?,?,?)',sys.argv[2:])\nc.commit()\nos._exit(0)";
  await execFileAsync("python3", ["-c", script, path, jobId, taskId, generation,
    String(attemptNumber)]);
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "test-checkpoint-e2e-"));
  const registryRootDir = join(root, "registry");
  const jobRootDir = join(root, "test-project", "job");
  const stateRootDir = join(jobRootDir, "state");
  const artifactRootDir = join(root, "artifacts");
  const dbRootDir = join(root, "owned-databases");
  const workspacePath = join(root, "workspace");
  const promptPath = join(root, "prompt.md");
  await Promise.all([mkdir(jobRootDir, { recursive: true }), mkdir(artifactRootDir),
    mkdir(dbRootDir), mkdir(workspacePath)]);
  await writeFile(promptPath, "Synthetic fake executor.\n");
  const config: CodexGoalRunConfig = {
    jobId: "test-job", taskId: "test-task", jobRootDir, stateRootDir,
    authRootDir: join(root, "test-auth-empty"), workspacePath, promptPath,
    accounts: codexGoalAccountSlots(["test-account"]),
  };
  const ownershipWitness = new TestFakeExecutorOwnershipWitness();
  await createCodexGoalJob({ registryRootDir, manifest: {
    jobId: "test-job", taskId: "test-task", jobRootDir, workspacePath,
    promptPath, accounts: ["test-account"],
  } });
  await runCodexGoal(config, { createExecutor: (options) => {
    if (!options.executionGeneration) throw new Error("test_generation_missing");
    ownershipWitness.observeExecutorStart(options.executionGeneration, 4);
    return { async run() {
      if (!options.executionGeneration) throw new Error("test_generation_missing");
      const journal = createLocalFileSafeExecutionStores({
        rootDir: options.stateRootDir,
        terminalCheckpointJobRootDir: jobRootDir,
        executionGeneration: options.executionGeneration,
      }).journal;
      const startedAt = new Date();
      await journal.startTask({ taskId: "test-task", workspaceRunId: "test-workspace",
        workspacePath, effectMode: "read_only", provider: "codex", now: startedAt });
      const attempt = { taskId: "test-task", attemptNumber: 1, provider: "codex",
        startedAt, finishedAt: new Date(), status: "completed" as const,
        workspaceDirtyBefore: false, changedFiles: [] };
      await journal.appendAttempt({ taskId: "test-task", attempt, now: attempt.finishedAt });
      await journal.completeTask({ taskId: "test-task", result: { outputText: "done" },
        now: new Date() });
      ownershipWitness.observeRunComplete();
      return { status: "completed", attempts: [attempt], task: { outputText: "done" } } as never;
    },
    async dispose() { ownershipWitness.observeDisposeComplete(); } };
  } });
  const resultPath = codexGoalOutputPath(config);
  const eventsPath = codexGoalRuntimeEventsPath(config);
  const result = JSON.parse(await readFile(resultPath, "utf8"));
  const generation = result.details.executionGeneration as string;
  const patchPath = join(artifactRootDir, "historical-referenced.patch");
  const patch = Buffer.from("test historical dependency\n");
  await writeFile(patchPath, patch);
  await new AtomicJsonRuntimeResultWriter(jobRootDir).writeResult({ path: resultPath,
    result: { ...result, artifacts: [{ kind: "patch", path: patchPath,
      byteLength: patch.length, sha256: sha(patch) }] } });
  const databasePaths = [join(dbRootDir, "session.sqlite"), join(dbRootDir, "events.sqlite")];
  for (const path of databasePaths) {
    await makeWalDatabase(path, "test-job", "test-task", generation, 1);
    expect((await stat(`${path}-wal`)).size).toBeGreaterThan(0);
  }
  const registryManifestPath = codexGoalJobManifestPath({ registryRootDir, jobId: "test-job" });
  const identity = { projectId: "test-project", workstreamId: "test-workstream",
    jobId: "test-job", taskId: "test-task", executionGeneration: generation,
    attemptNumber: 1, ownershipEpoch: 4, runtimeSha: "a".repeat(40),
    registryRevisionSha256: sha(await readFile(registryManifestPath)) };
  const input = { testRoot: root, checkpointId: "test-checkpoint-1", identity, jobRootDir,
    registryRootDir, registryManifestPath, stateRootDir, resultPath, eventsPath,
    artifactRootDir, sqliteDatabases: databasePaths.map((path) => ({ root: dbRootDir, path })),
    inventoryComplete: true as const, providerState: "none" as const,
    ownership: { kind: "fake_executor_complete" as const, executionGeneration: generation,
      ownershipEpoch: 4, providerLaunches: 0 as const },
    ownershipWitness,
    destination: join(root, "sealed-checkpoint"),
    retentionUntil: "2099-01-01T00:00:00.000Z",
    previousCheckpointId: "test-checkpoint-0",
  };
  return { root, input, patchPath, databasePaths,
    cleanup: async () => {
      await chmod(input.destination, 0o700).catch(() => {});
      await chmod(join(input.destination, "payload"), 0o700).catch(() => {});
      const restoredSeal = join(root, "test-checkpoint-restored-1", input.destination.slice(1));
      await chmod(restoredSeal, 0o700).catch(() => {});
      await chmod(join(restoredSeal, "payload"), 0o700).catch(() => {});
      await rm(root, { recursive: true, force: true });
    } };
}

describe("fenced synthetic checkpoint and encrypted disposable restore", () => {
  it("fences real result, journal and registry writers while another job progresses", async () => {
    const f = await fixture();
    const gate = new LocalTerminalCheckpointAdmission(f.input.jobRootDir);
    const resultBefore = await readFile(f.input.resultPath, "utf8");
    const claim = await gate.claim("test-concurrent-writers", f.input.identity);
    try {
      await expect(new AtomicJsonRuntimeResultWriter(f.input.jobRootDir).writeResult({
        path: f.input.resultPath, result: JSON.parse(resultBefore),
      })).rejects.toThrow("terminal_checkpoint_job_fenced");
      const journal = createLocalFileSafeExecutionStores({ rootDir: f.input.stateRootDir,
        terminalCheckpointJobRootDir: f.input.jobRootDir,
        executionGeneration: f.input.identity.executionGeneration }).journal;
      await expect(journal.markPartial({ taskId: "test-task", status: "partial",
        reason: "unknown_error", now: new Date() }))
        .rejects.toThrow("terminal_checkpoint_job_fenced");
      await expect(updateCodexGoalJob({ registryRootDir: f.input.registryRootDir,
        jobId: "test-job", patch: { description: "late update" },
      })).rejects.toThrow("terminal_checkpoint_job_fenced");
      const otherJobRoot = join(f.root, "test-other-project", "job");
      await createCodexGoalJob({ registryRootDir: f.input.registryRootDir, manifest: {
        jobId: "test-job-b", taskId: "test-task-b", jobRootDir: otherJobRoot,
        workspacePath: join(f.root, "workspace"), promptPath: join(f.root, "prompt.md"),
        accounts: ["test-account"],
      } });
      await expect(updateCodexGoalJob({ registryRootDir: f.input.registryRootDir,
        jobId: "test-job-b", patch: { description: "independent" },
      })).resolves.toMatchObject({ description: "independent" });
      expect(await readFile(f.input.resultPath, "utf8")).toBe(resultBefore);
    } finally { await gate.release(claim, false); await f.cleanup(); }
  });

  it("rejects a seal destination outside the disposable test project before claiming", async () => {
    const f = await fixture();
    try {
      await expect(sealTestTerminalAttemptCheckpoint({ ...f.input,
        destination: join(f.root, "..", "outside-seal"),
      })).rejects.toThrow("terminal_checkpoint_test_scope_invalid");
      await symlink(join(f.root, ".."), join(f.root, "escape"));
      await expect(sealTestTerminalAttemptCheckpoint({ ...f.input,
        destination: join(f.root, "escape", "outside-seal"),
      })).rejects.toThrow("terminal_checkpoint_test_scope_invalid");
      await expect(sealTestTerminalAttemptCheckpoint({ ...f.input,
        artifactRootDir: join(f.root, "escape", "artifacts"),
      })).rejects.toThrow("terminal_checkpoint_test_scope_invalid");
      await new LocalTerminalCheckpointAdmission(f.input.jobRootDir).withWriter(async () => {});
    } finally { await f.cleanup(); }
  });

  it("restores only the sealed checkpoint from a generated-password local restic repository", async () => {
    const f = await fixture();
    try {
      const seal = await sealTestTerminalAttemptCheckpoint(f.input);
      const manifest = await verifyTestTerminalAttemptCheckpoint(f.input.destination, seal.sealSha256);
      expect(manifest.files.map((file) => file.role)).toEqual([
        "registry_manifest", "runtime_result", "runtime_events", "attempt_journal",
        "artifact_0", "sqlite_0", "sqlite_1",
      ]);
      expect(await stat(`${f.databasePaths[0]}-wal`)).toBeTruthy();
      const retry = await sealTestTerminalAttemptCheckpoint({ ...f.input,
        expectedSealSha256: seal.sealSha256 });
      expect(retry).toEqual(seal);
      const receipt = await restoreDisposableTestCheckpoint({
        testRoot: f.root, sealDirectory: f.input.destination,
        expectedSealSha256: seal.sealSha256,
        repositoryDirectory: join(f.root, "encrypted-restic"),
        destination: join(f.root, "test-checkpoint-restored-1"),
        receiptPath: join(f.root, "restore-receipt.json"),
        generatedTestPassword: randomBytes(32).toString("hex"),
      });
      expect(receipt).toMatchObject({ checkpointId: "test-checkpoint-1",
        sealSha256: seal.sealSha256, rollbackPointer: "test-checkpoint-0",
        routingDisabled: true });
      expect(receipt.snapshotId).toMatch(/^[a-f0-9]{64}$/);
      expect(receipt.checks).toContain("sqlite_sequence");
      expect(await verifyTestTerminalAttemptCheckpoint(receipt.destination, seal.sealSha256))
        .toMatchObject({ checkpointId: "test-checkpoint-1" });
    } finally { await f.cleanup(); }
  });

  it("rejects missing referenced artifacts, symlinks and post-seal tamper", async () => {
    const f = await fixture();
    try {
      await rm(f.patchPath);
      await expect(sealTestTerminalAttemptCheckpoint(f.input)).rejects.toThrow();
    } finally { await f.cleanup(); }
    const g = await fixture();
    try {
      await rm(g.patchPath);
      await symlink(join(g.root, "prompt.md"), g.patchPath);
      await expect(sealTestTerminalAttemptCheckpoint(g.input)).rejects.toThrow(/source_(?:symlink|untrusted)/);
    } finally { await g.cleanup(); }
    const h = await fixture();
    try {
      const seal = await sealTestTerminalAttemptCheckpoint(h.input);
      const result = join(h.input.destination, "payload", "runtime_result.data");
      await chmod(result, 0o600);
      await writeFile(result, "tampered");
      await expect(verifyTestTerminalAttemptCheckpoint(h.input.destination, seal.sealSha256))
        .rejects.toThrow("payload_mismatch");
    } finally { await h.cleanup(); }
  });

  it("rejects wrong epoch, generation and partial journal without rewriting the result", async () => {
    const f = await fixture();
    try {
      await expect(sealTestTerminalAttemptCheckpoint({ ...f.input,
        ownershipWitness: new TestFakeExecutorOwnershipWitness() }))
        .rejects.toThrow("ownership_unproved");
      await expect(sealTestTerminalAttemptCheckpoint({ ...f.input,
        ownership: { ...f.input.ownership, ownershipEpoch: 5 } }))
        .rejects.toThrow("ownership_unproved");
      const originalResult = JSON.parse(await readFile(f.input.resultPath, "utf8"));
      const resultWriter = new AtomicJsonRuntimeResultWriter(f.input.jobRootDir);
      await resultWriter.writeResult({ path: f.input.resultPath,
        result: { ...originalResult, details: { ...originalResult.details,
          executionGeneration: "test-wrong-generation" } } });
      await expect(sealTestTerminalAttemptCheckpoint(f.input))
        .rejects.toThrow("generation_mismatch");
      await resultWriter.writeResult({ path: f.input.resultPath, result: originalResult });
      const journal = createLocalFileSafeExecutionStores({ rootDir: f.input.stateRootDir,
        terminalCheckpointJobRootDir: f.input.jobRootDir,
        executionGeneration: f.input.identity.executionGeneration }).journal;
      await journal.markPartial({ taskId: "test-task", status: "partial",
        reason: "unknown_error", now: new Date() });
      await expect(sealTestTerminalAttemptCheckpoint(f.input))
        .rejects.toThrow("journal_not_terminal");
      expect(JSON.parse(await readFile(f.input.resultPath, "utf8")).status).toBe("done");
    } finally { await f.cleanup(); }
  });

  it("retains incomplete publication evidence after a dependency digest failure", async () => {
    const f = await fixture();
    try {
      await writeFile(f.patchPath, "changed after result publication\n");
      await expect(sealTestTerminalAttemptCheckpoint(f.input))
        .rejects.toThrow("dependency_hash_mismatch");
      await expect(readFile(join(f.input.destination, "COMMITTED"))).rejects.toThrow();
      await expect(sealTestTerminalAttemptCheckpoint(f.input))
        .rejects.toThrow("retry_digest_required");
      expect(JSON.parse(await readFile(f.input.resultPath, "utf8")).status).toBe("done");
    } finally { await f.cleanup(); }
  });

  it("rejects unexpected payloads and modified manifest bytes", async () => {
    const f = await fixture();
    try {
      const seal = await sealTestTerminalAttemptCheckpoint(f.input);
      const unexpected = join(f.input.destination, "payload", "unexpected.data");
      await chmod(join(f.input.destination, "payload"), 0o700);
      await writeFile(unexpected, "unexpected");
      await expect(verifyTestTerminalAttemptCheckpoint(f.input.destination, seal.sealSha256))
        .rejects.toThrow("unexpected_file");
      await rm(unexpected);
      const manifestPath = seal.manifestPath;
      await chmod(manifestPath, 0o600);
      await writeFile(manifestPath, "{}");
      await expect(verifyTestTerminalAttemptCheckpoint(f.input.destination, seal.sealSha256))
        .rejects.toThrow("digest_mismatch");
    } finally { await f.cleanup(); }
  });

  it("detects a corrupted sealed SQLite payload", async () => {
    const f = await fixture();
    try {
      const seal = await sealTestTerminalAttemptCheckpoint(f.input);
      const database = join(f.input.destination, "payload", "sqlite_0.sqlite");
      await chmod(database, 0o600);
      await writeFile(database, "corrupted database");
      await expect(verifyTestTerminalAttemptCheckpoint(f.input.destination, seal.sealSha256))
        .rejects.toThrow("payload_mismatch");
    } finally { await f.cleanup(); }
  });

  it("rejects an invalid retention deadline before reserving the destination", async () => {
    const f = await fixture();
    try {
      await expect(sealTestTerminalAttemptCheckpoint({ ...f.input, retentionUntil: "invalid" }))
        .rejects.toThrow("seal_input_invalid");
      await expect(stat(f.input.destination)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await f.cleanup(); }
  });

  it.each(["retention", "unknown_role", "wrong_kind"])("rejects a checksum-valid invalid %s manifest", async (mutation) => {
    const f = await fixture();
    try {
      await sealTestTerminalAttemptCheckpoint(f.input);
      const manifestPath = join(f.input.destination, "checkpoint-manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      if (mutation === "retention") manifest.retentionUntil = "invalid";
      if (mutation === "wrong_kind") {
        const file = manifest.files[0];
        file.kind = "sqlite";
        file.storedPath = `payload/${file.role}.sqlite`;
        await writeFile(join(f.input.destination, file.storedPath),
          await readFile(join(f.input.destination, "payload/registry_manifest.data")));
        await rm(join(f.input.destination, "payload/registry_manifest.data"));
      }
      if (mutation === "unknown_role") {
        await writeFile(join(f.input.destination, "payload/unexpected.data"), "extra");
        manifest.files.push({ role: "unexpected", kind: "file", sourceRelativePath: "extra",
          storedPath: "payload/unexpected.data", sha256: sha("extra"), bytes: 5 });
      }
      const bytes = `${JSON.stringify(manifest)}\n`;
      const digest = sha(bytes);
      for (const [name, content] of [["checkpoint-manifest.json", bytes],
        ["SHA256SUMS", `${digest}  checkpoint-manifest.json\n`], ["COMMITTED", `${digest}\n`]]) {
        const path = join(f.input.destination, name!);
        await chmod(path, 0o600); await writeFile(path, content!);
      }
      await expect(verifyTestTerminalAttemptCheckpoint(f.input.destination, digest))
        .rejects.toThrow("manifest_invalid");
    } finally { await f.cleanup(); }
  });

  it("rejects a source database with an unknown schema version", async () => {
    const f = await fixture();
    try {
      const script = "import sqlite3,sys\nc=sqlite3.connect(sys.argv[1])\nc.execute('PRAGMA user_version=2')\nc.commit()\nc.close()";
      await execFileAsync("python3", ["-c", script, f.databasePaths[0]!]);
      await expect(sealTestTerminalAttemptCheckpoint(f.input))
        .rejects.toThrow("sqlite_schema_mismatch");
      await new LocalTerminalCheckpointAdmission(f.input.jobRootDir).withWriter(async () => {});
    } finally { await f.cleanup(); }
  });

  it.each(Object.values(TerminalCheckpointDurablePhase))(
    "retains crash evidence and the job fence after %s",
    async (phase) => {
      const f = await fixture();
      try {
        await expect(sealTestTerminalAttemptCheckpoint({ ...f.input,
          injectCrashAfterPhase: phase }))
          .rejects.toThrow(`test_crash_after_${phase}`);
        const gate = new LocalTerminalCheckpointAdmission(f.input.jobRootDir);
        await expect(gate.withWriter(async () => {})).rejects.toThrow("job_fenced");
        const committed = await readFile(join(f.input.destination, "COMMITTED"), "utf8")
          .catch(() => null);
        expect(committed !== null).toBe(phase === TerminalCheckpointDurablePhase.Committed);
        if (committed) {
          const digest = sha(await readFile(join(f.input.destination, "checkpoint-manifest.json")));
          expect(committed).toBe(`${digest}\n`);
          await expect(verifyTestTerminalAttemptCheckpoint(f.input.destination, digest))
            .resolves.toMatchObject({ checkpointId: "test-checkpoint-1" });
        }
        expect(JSON.parse(await readFile(f.input.resultPath, "utf8")).status).toBe("done");
      } finally { await f.cleanup(); }
    },
  );
});
