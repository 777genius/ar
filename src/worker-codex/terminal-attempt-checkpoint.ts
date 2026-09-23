import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const sqliteSuffix = /\.(?:db|sqlite|sqlite3)$/i;
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

export type SyntheticTerminalCheckpointInput = {
  readonly sourceRoot: string;
  readonly destination: string;
  readonly projectId: string;
  readonly workstreamId: string;
  readonly jobId: string;
  readonly attemptId: string;
  readonly runtimeSha: string;
  readonly ownershipEpoch: number;
  readonly retentionUntil: string;
  readonly registryManifestPath: string;
  readonly resultPath: string;
  readonly runtimeEventsPath: string;
  readonly journalPath: string;
  readonly sqlitePaths: readonly string[];
};

export type TerminalCheckpointFile = {
  readonly role: string;
  readonly sourceRelativePath: string;
  readonly storedPath: string;
  readonly sourceSha256: string;
  readonly sourceBytes: number;
  readonly storedSha256: string;
  readonly storedBytes: number;
};

/**
 * Captures only synthetic test projects. There is deliberately no production
 * adapter: the current controller/registry/journal writers do not share a
 * job-scoped quiescence claim, so a live job cannot satisfy this contract.
 */
export async function sealSyntheticTerminalAttemptCheckpoint(
  input: SyntheticTerminalCheckpointInput,
): Promise<{ readonly manifestPath: string; readonly sealSha256: string }> {
  assertIdentity(input);
  const root = await realpath(input.sourceRoot);
  const sources = [
    { role: "registry_manifest", path: input.registryManifestPath },
    { role: "runtime_result", path: input.resultPath },
    { role: "runtime_events", path: input.runtimeEventsPath },
    { role: "attempt_journal", path: input.journalPath },
    ...input.sqlitePaths.map((path, index) => ({ role: `sqlite_${index}`, path })),
  ];
  if (input.sqlitePaths.length > 256 || new Set(sources.map((item) => item.path)).size !== sources.length) {
    throw new Error("checkpoint_invalid_source_set");
  }
  const paths = await Promise.all(sources.map(async (source) => ({
    ...source,
    relativePath: await checkedSourcePath(root, source.path),
  })));
  if (input.sqlitePaths.some((path) => !sqliteSuffix.test(path))) {
    throw new Error("checkpoint_sqlite_suffix_required");
  }
  const [result, events, job, journal] = await Promise.all([
    readJson(input.resultPath),
    readFile(input.runtimeEventsPath, "utf8"),
    readJson(input.registryManifestPath),
    readFile(input.journalPath, "utf8"),
  ]);
  assertTerminalEvidence(input, result, events, job, journal);

  // Exclusive publication prevents accidental replacement of an older seal.
  await mkdir(input.destination, { mode: 0o700 });
  try {
    const files: TerminalCheckpointFile[] = [];
    for (const source of paths) {
      const before = await fingerprint(source.path);
      const storedPath = join("payload", `${source.role}${source.role.startsWith("sqlite_") ? ".sqlite" : ".data"}`);
      const target = join(input.destination, storedPath);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      if (source.role.startsWith("sqlite_")) {
        await sqliteOnlineBackup(source.path, target);
      } else {
        await copyFile(source.path, target);
      }
      const after = await fingerprint(source.path);
      if (before.sha256 !== after.sha256 || before.bytes !== after.bytes) {
        throw new Error("checkpoint_source_changed_during_capture");
      }
      const stored = await fingerprint(target);
      files.push({
        role: source.role,
        sourceRelativePath: source.relativePath,
        storedPath,
        sourceSha256: before.sha256,
        sourceBytes: before.bytes,
        storedSha256: stored.sha256,
        storedBytes: stored.bytes,
      });
      await chmod(target, 0o400);
    }
    // Validate the captured bytes as well as the preflight reads. A source
    // replacement between validation and copying cannot inherit the verdict.
    assertTerminalEvidence(
      input,
      await readJson(join(input.destination, "payload", "runtime_result.data")),
      await readFile(join(input.destination, "payload", "runtime_events.data"), "utf8"),
      await readJson(join(input.destination, "payload", "registry_manifest.data")),
      await readFile(join(input.destination, "payload", "attempt_journal.data"), "utf8"),
    );
    const manifest = {
      schemaVersion: 1,
      authority: "synthetic_only_no_live_writer_claim",
      projectId: input.projectId,
      workstreamId: input.workstreamId,
      jobId: input.jobId,
      attemptId: input.attemptId,
      runtimeSha: input.runtimeSha,
      ownershipEpoch: input.ownershipEpoch,
      retentionUntil: input.retentionUntil,
      capturedAt: new Date().toISOString(),
      files,
    };
    const bytes = `${JSON.stringify(manifest, null, 2)}\n`;
    const sealSha256 = sha(bytes);
    const manifestPath = join(input.destination, "checkpoint-manifest.json");
    await writeFile(manifestPath, bytes, { flag: "wx", mode: 0o400 });
    await writeFile(join(input.destination, "SHA256SUMS"), `${sealSha256}  checkpoint-manifest.json\n`, { flag: "wx", mode: 0o400 });
    await chmod(input.destination, 0o500);
    return { manifestPath, sealSha256 };
  } catch (error) {
    await rm(input.destination, { recursive: true, force: true });
    throw error;
  }
}

function assertTerminalEvidence(
  input: SyntheticTerminalCheckpointInput,
  result: Record<string, unknown>,
  events: string,
  job: Record<string, unknown>,
  journal: string,
): void {
  const window = terminalEventWindow(events, input.jobId);
  const resultUpdatedAt = typeof result.updatedAt === "string"
    ? Date.parse(result.updatedAt)
    : NaN;
  if (result.runId !== input.jobId || !["done", "failed"].includes(String(result.status)) ||
      job.jobId !== input.jobId || window === undefined ||
      !Number.isFinite(resultUpdatedAt) ||
      resultUpdatedAt < window.startedAt || resultUpdatedAt > window.disposedAt ||
      !hasTerminalJournalRecord(journal, input.attemptId)) {
    throw new Error("checkpoint_attempt_not_terminal");
  }
}

export async function verifySyntheticTerminalAttemptCheckpoint(
  directory: string,
): Promise<boolean> {
  const manifestPath = join(directory, "checkpoint-manifest.json");
  const manifestBytes = await readFile(manifestPath);
  const sum = await readFile(join(directory, "SHA256SUMS"), "utf8");
  if (sum !== `${sha(manifestBytes)}  checkpoint-manifest.json\n`) return false;
  const manifest = await readJson(manifestPath);
  if (manifest.authority !== "synthetic_only_no_live_writer_claim" ||
      !String(manifest.projectId).startsWith("test-") || !Array.isArray(manifest.files)) return false;
  const payload = await lstat(join(directory, "payload"));
  if (!payload.isDirectory() || payload.isSymbolicLink()) return false;
  const roles = manifest.files.map((item: unknown) =>
    typeof item === "object" && item !== null && !Array.isArray(item)
      ? (item as Record<string, unknown>).role
      : undefined);
  if (roles.length < 4 || new Set(roles).size !== roles.length ||
      !["registry_manifest", "runtime_result", "runtime_events", "attempt_journal"].every((role) => roles.includes(role)) ||
      roles.some((role) => typeof role !== "string" ||
        !(["registry_manifest", "runtime_result", "runtime_events", "attempt_journal"].includes(role) || /^sqlite_\d+$/.test(role)))) {
    return false;
  }
  for (const unknownFile of manifest.files) {
    if (typeof unknownFile !== "object" || unknownFile === null || Array.isArray(unknownFile)) return false;
    const file = unknownFile as Record<string, unknown>;
    if (typeof file.storedPath !== "string" ||
        !/^payload\/[a-z_0-9]+\.(?:data|sqlite)$/.test(file.storedPath)) return false;
    const path = join(directory, file.storedPath);
    const item = await lstat(path);
    if (!item.isFile() || item.isSymbolicLink()) return false;
    const actual = await fingerprint(path);
    if (file.storedSha256 !== actual.sha256 || file.storedBytes !== actual.bytes) return false;
    if (file.storedPath.endsWith(".sqlite")) {
      await sqliteIntegrityCheck(path);
    }
  }
  return true;
}

function assertIdentity(input: SyntheticTerminalCheckpointInput): void {
  const id = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
  if (!input.projectId.startsWith("test-") ||
      ![input.projectId, input.workstreamId, input.jobId, input.attemptId].every((value) => id.test(value)) ||
      !/^[a-f0-9]{40}$/.test(input.runtimeSha) ||
      !Number.isSafeInteger(input.ownershipEpoch) || input.ownershipEpoch < 0 ||
      !Number.isFinite(Date.parse(input.retentionUntil)) ||
      Date.parse(input.retentionUntil) <= Date.now() ||
      !isAbsolute(input.sourceRoot) || !isAbsolute(input.destination)) {
    throw new Error("checkpoint_invalid_identity");
  }
}

async function checkedSourcePath(root: string, path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error("checkpoint_source_not_absolute");
  const item = await lstat(path);
  if (!item.isFile() || item.isSymbolicLink()) throw new Error("checkpoint_source_not_regular_file");
  const resolved = await realpath(path);
  const rel = relative(root, resolved);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("checkpoint_source_outside_root");
  }
  return rel;
}

async function fingerprint(path: string): Promise<{ readonly sha256: string; readonly bytes: number }> {
  const bytes = await readFile(path);
  return { sha256: sha(bytes), bytes: bytes.length };
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("checkpoint_invalid_json");
  }
  return value as Record<string, unknown>;
}

function terminalEventWindow(
  events: string,
  jobId: string,
): { readonly startedAt: number; readonly disposedAt: number } | undefined {
  const lines = events.trim().split("\n");
  if (lines.length === 0) return undefined;
  try {
    const parsed = lines.map((line) => JSON.parse(line) as unknown);
    const records = parsed.filter((item): item is Record<string, unknown> =>
      typeof item === "object" && item !== null && !Array.isArray(item));
    if (records.length !== lines.length) return undefined;
    const last = records.at(-1);
    if (!last || last.event !== "runner_disposed" ||
        typeof last.attributes !== "object" || last.attributes === null ||
        (last.attributes as Record<string, unknown>).jobId !== jobId ||
        typeof last.timestamp !== "string") return undefined;
    const disposedAt = Date.parse(last.timestamp);
    const started = records.slice(0, -1).reverse().find((event) =>
      event.event === "runner_starting" &&
      typeof event.attributes === "object" && event.attributes !== null &&
      (event.attributes as Record<string, unknown>).jobId === jobId);
    if (started && typeof started.timestamp === "string") {
      const startedAt = Date.parse(started.timestamp);
      if (Number.isFinite(startedAt) && Number.isFinite(disposedAt) && startedAt <= disposedAt) {
        return { startedAt, disposedAt };
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function hasTerminalJournalRecord(journal: string, attemptId: string): boolean {
  try {
    const last: unknown = JSON.parse(journal.trim().split("\n").at(-1) ?? "");
    if (typeof last !== "object" || last === null || Array.isArray(last)) return false;
    const record = last as Record<string, unknown>;
    return record.attemptId === attemptId && record.state === "terminal";
  } catch {
    return false;
  }
}

async function sqliteOnlineBackup(source: string, destination: string): Promise<void> {
  const script = "import pathlib,sqlite3,sys\ns=sqlite3.connect(pathlib.Path(sys.argv[1]).as_uri()+'?mode=ro', uri=True)\nd=sqlite3.connect(sys.argv[2])\ns.backup(d)\nassert d.execute('PRAGMA integrity_check').fetchone()[0]=='ok'\nd.close()\ns.close()";
  await execFileAsync("python3", ["-c", script, source, destination], { timeout: 60_000 });
}

async function sqliteIntegrityCheck(path: string): Promise<void> {
  const script = "import pathlib,sqlite3,sys\nc=sqlite3.connect(pathlib.Path(sys.argv[1]).as_uri()+'?mode=ro', uri=True)\nassert c.execute('PRAGMA integrity_check').fetchone()[0]=='ok'\nc.close()";
  await execFileAsync("python3", ["-c", script, path], { timeout: 60_000 });
}
