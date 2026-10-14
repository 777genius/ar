import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  sealSyntheticTerminalAttemptCheckpoint,
  verifySyntheticTerminalAttemptCheckpoint,
  type SyntheticTerminalCheckpointInput,
} from "../terminal-attempt-checkpoint";

const execFileAsync = promisify(execFile);

async function fixture(): Promise<{
  root: string;
  input: SyntheticTerminalCheckpointInput;
  releaseSqlite(): Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "test-terminal-checkpoint-"));
  const sourceRoot = join(root, "source");
  const jobRoot = join(sourceRoot, "jobs", "test-project", "job-1");
  await mkdir(jobRoot, { recursive: true });
  const registryManifestPath = join(jobRoot, "job.json");
  const resultPath = join(jobRoot, "latest-result.json");
  const runtimeEventsPath = join(jobRoot, "runtime-events.jsonl");
  const journalPath = join(jobRoot, "journal.jsonl");
  const sqlitePath = join(jobRoot, "state.sqlite");
  await writeFile(registryManifestPath, JSON.stringify({ jobId: "job-1", revision: 7 }));
  await writeFile(resultPath, JSON.stringify({ runId: "job-1", status: "done", updatedAt: "2026-09-23T00:00:01.000Z" }));
  await writeFile(runtimeEventsPath, [
    { event: "runner_starting", timestamp: "2026-09-23T00:00:00.000Z", attributes: { jobId: "job-1" } },
    { event: "runner_disposed", timestamp: "2026-09-23T00:00:02.000Z", attributes: { jobId: "job-1" } },
  ].map((item) => JSON.stringify(item)).join("\n") + "\n");
  await writeFile(journalPath, `${JSON.stringify({ attemptId: "attempt-1", state: "terminal" })}\n`);
  const sqlite = spawn("python3", ["-u", "-c", "import sqlite3,sys\nc=sqlite3.connect(sys.argv[1])\nc.execute('PRAGMA journal_mode=WAL')\nc.execute('CREATE TABLE records(value TEXT)')\nc.execute(\"INSERT INTO records VALUES ('committed WAL page')\")\nc.commit()\nprint('ready',flush=True)\nsys.stdin.read()\nc.close()", sqlitePath], { stdio: ["pipe", "pipe", "pipe"] });
  await once(sqlite.stdout!, "data");
  return { root, releaseSqlite: async () => {
    const exited = once(sqlite, "exit");
    sqlite.stdin!.end();
    await exited;
  }, input: {
    sourceRoot,
    destination: join(root, "sealed"),
    projectId: "test-project",
    workstreamId: "test-workstream",
    jobId: "job-1",
    attemptId: "attempt-1",
    runtimeSha: "a".repeat(40),
    ownershipEpoch: 2,
    retentionUntil: "2099-01-01T00:00:00.000Z",
    registryManifestPath,
    resultPath,
    runtimeEventsPath,
    journalPath,
    sqlitePaths: [sqlitePath],
  } };
}

describe("synthetic terminal attempt checkpoint", () => {
  it("seals allowlisted bytes and an online SQLite backup with a verifiable manifest", async () => {
    const { root, input, releaseSqlite } = await fixture();
    try {
      const seal = await sealSyntheticTerminalAttemptCheckpoint(input);
      expect((await stat(`${input.sqlitePaths[0]}-wal`)).size).toBeGreaterThan(0);
      expect(seal.sealSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(await verifySyntheticTerminalAttemptCheckpoint(input.destination)).toBe(true);
      const manifest = JSON.parse(await readFile(seal.manifestPath, "utf8"));
      expect(manifest).toMatchObject({
        projectId: "test-project", workstreamId: "test-workstream",
        jobId: "job-1", attemptId: "attempt-1", ownershipEpoch: 2,
        authority: "synthetic_only_no_live_writer_claim",
      });
      const { stdout } = await execFileAsync("python3", ["-c", "import sqlite3,sys\nprint(sqlite3.connect(sys.argv[1]).execute('SELECT value FROM records').fetchone()[0])", join(input.destination, "payload", "sqlite_0.sqlite")]);
      expect(stdout.trim()).toBe("committed WAL page");
      await expect(sealSyntheticTerminalAttemptCheckpoint(input)).rejects.toThrow();
      const storedResult = join(input.destination, "payload", "runtime_result.data");
      await chmod(input.destination, 0o700);
      await chmod(storedResult, 0o600);
      await writeFile(storedResult, "tampered");
      expect(await verifySyntheticTerminalAttemptCheckpoint(input.destination)).toBe(false);
    } finally {
      await releaseSqlite();
      await chmod(input.destination, 0o700).catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects production scope and unknown or active attempts before publication", async () => {
    const { root, input, releaseSqlite } = await fixture();
    try {
      await expect(sealSyntheticTerminalAttemptCheckpoint({ ...input, projectId: "real-project" }))
        .rejects.toThrow("checkpoint_invalid_identity");
      await writeFile(input.resultPath, JSON.stringify({ runId: "job-1", status: "blocked" }));
      await expect(sealSyntheticTerminalAttemptCheckpoint(input))
        .rejects.toThrow("checkpoint_attempt_not_terminal");
      await expect(readFile(join(input.destination, "checkpoint-manifest.json")))
        .rejects.toThrow();
    } finally {
      await releaseSqlite();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects invalid or stale result times and accepts a job without SQLite", async () => {
    const { root, input, releaseSqlite } = await fixture();
    try {
      for (const updatedAt of ["not-a-date", "2026-09-22T23:59:59.000Z", "2026-09-23T00:00:03.000Z"]) {
        await writeFile(input.resultPath, JSON.stringify({ runId: "job-1", status: "done", updatedAt }));
        await expect(sealSyntheticTerminalAttemptCheckpoint(input))
          .rejects.toThrow("checkpoint_attempt_not_terminal");
      }
      await writeFile(input.resultPath, JSON.stringify({ runId: "job-1", status: "done", updatedAt: "2026-09-23T00:00:01.000Z" }));
      await sealSyntheticTerminalAttemptCheckpoint({ ...input, sqlitePaths: [] });
      expect(await verifySyntheticTerminalAttemptCheckpoint(input.destination)).toBe(true);
    } finally {
      await releaseSqlite();
      await chmod(input.destination, 0o700).catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });
});
