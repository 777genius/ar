import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
  AccessBoundary,
  TerminalCheckpointDurablePhase,
  selectTerminalAttempt,
  TerminalCheckpointPayloadKind,
  type RuntimeResultEnvelope,
  type TerminalCheckpointClaimIdentity,
  type TerminalCheckpointSealManifest,
} from "@vioxen/subscription-runtime/worker-core";
import {
  LocalTerminalCheckpointAdmission,
  parseLocalSafeExecutionTaskRecord,
  sealImmutableTerminalCheckpoint,
  verifyImmutableTerminalCheckpoint,
  type TerminalCheckpointSource,
} from "@vioxen/subscription-runtime/store-local-file";

const execFileAsync = promisify(execFile);
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Records the fake executor's actual completion sequence for disposable tests. */
export class TestFakeExecutorOwnershipWitness {
  #phase: "new" | "started" | "run_complete" | "disposed" = "new";
  #generation = "";
  #epoch = -1;

  observeExecutorStart(generation: string, epoch: number): void {
    if (this.#phase !== "new" || !generation || !Number.isSafeInteger(epoch) || epoch < 0) {
      throw new Error("terminal_checkpoint_test_ownership_unproved");
    }
    this.#generation = generation;
    this.#epoch = epoch;
    this.#phase = "started";
  }

  observeRunComplete(): void {
    if (this.#phase !== "started") throw new Error("terminal_checkpoint_test_ownership_unproved");
    this.#phase = "run_complete";
  }

  observeDisposeComplete(): void {
    if (this.#phase !== "run_complete") throw new Error("terminal_checkpoint_test_ownership_unproved");
    this.#phase = "disposed";
  }

  assertComplete(identity: TerminalCheckpointClaimIdentity): void {
    if (this.#phase !== "disposed" || this.#generation !== identity.executionGeneration ||
        this.#epoch !== identity.ownershipEpoch) {
      throw new Error("terminal_checkpoint_test_ownership_unproved");
    }
  }
}

export type TestTerminalCheckpointInput = {
  readonly testRoot: string;
  readonly checkpointId: string;
  readonly identity: TerminalCheckpointClaimIdentity;
  readonly jobRootDir: string;
  readonly registryRootDir: string;
  readonly registryManifestPath: string;
  readonly stateRootDir: string;
  readonly resultPath: string;
  readonly eventsPath: string;
  readonly artifactRootDir: string;
  readonly sqliteDatabases: readonly { readonly root: string; readonly path: string }[];
  /** These two facts are supplied by the synthetic fixture, never by a live provider. */
  readonly inventoryComplete: true;
  readonly providerState: "none";
  readonly ownership: { readonly kind: "fake_executor_complete";
    readonly executionGeneration: string; readonly ownershipEpoch: number;
    readonly providerLaunches: 0 };
  readonly ownershipWitness: TestFakeExecutorOwnershipWitness;
  readonly destination: string;
  readonly retentionUntil: string;
  readonly previousCheckpointId?: string;
  readonly expectedSealSha256?: string;
  readonly injectCrashAfterPhase?: TerminalCheckpointDurablePhase;
};

/** Host-owned synthetic capture; there is no live ownership/inventory adapter. */
export async function sealTestTerminalAttemptCheckpoint(input: TestTerminalCheckpointInput): Promise<{
  readonly manifestPath: string;
  readonly sealSha256: string;
}> {
  await assertSyntheticFixtureScope(input);
  if (!input.identity.projectId.startsWith("test-") || !input.inventoryComplete ||
      input.providerState !== "none" || input.ownership.kind !== "fake_executor_complete" ||
      input.ownership.providerLaunches !== 0 ||
      input.ownership.executionGeneration !== input.identity.executionGeneration ||
      input.ownership.ownershipEpoch !== input.identity.ownershipEpoch) {
    throw new Error("terminal_checkpoint_test_ownership_unproved");
  }
  if (!(input.ownershipWitness instanceof TestFakeExecutorOwnershipWitness)) {
    throw new Error("terminal_checkpoint_test_ownership_unproved");
  }
  input.ownershipWitness.assertComplete(input.identity);
  const admission = new LocalTerminalCheckpointAdmission(input.jobRootDir);
  // A completed publication can be returned after lost acknowledgement only
  // with the independently retained digest and exact identity.
  if (input.expectedSealSha256) {
    try {
      const existing = await verifyTestTerminalAttemptCheckpoint(input.destination, input.expectedSealSha256);
      if (existing.checkpointId === input.checkpointId &&
          JSON.stringify(existing.identity) === JSON.stringify(input.identity)) {
        return { manifestPath: join(input.destination, "checkpoint-manifest.json"),
          sealSha256: input.expectedSealSha256 };
      }
      throw new Error("terminal_checkpoint_retry_identity_mismatch");
    } catch (error) {
      if (!isCode(error, "ENOENT")) throw error;
    }
  }
  const claim = await admission.claim(input.checkpointId, input.identity);
  let sealed = false;
  let injectedCrash = false;
  try {
    const journalPath = localJournalPath(input.stateRootDir, input.identity.taskId);
    const [registryBytes, resultBytes, eventsBytes, journalBytes] = await Promise.all([
      readTrusted(input.registryRootDir, input.registryManifestPath),
      readTrusted(input.jobRootDir, input.resultPath),
      readTrusted(input.jobRootDir, input.eventsPath),
      readTrusted(input.stateRootDir, journalPath),
    ]);
    if (sha(registryBytes) !== input.identity.registryRevisionSha256) {
      throw new Error("terminal_checkpoint_registry_revision_mismatch");
    }
    const registry = parseRecord(registryBytes);
    if (registry.accessBoundary === AccessBoundary.ProjectScopedControl) {
      throw new Error("terminal_checkpoint_controller_route_unsupported");
    }
    const projectScope = registry.projectAccessScope;
    if (projectScope && (!isRecord(projectScope) ||
        projectScope.projectId !== input.identity.projectId)) {
      throw new Error("terminal_checkpoint_registry_identity_mismatch");
    }
    if (registry.jobId !== input.identity.jobId ||
        typeof registry.jobRootDir !== "string" ||
        await realpath(registry.jobRootDir) !== await realpath(input.jobRootDir)) {
      throw new Error("terminal_checkpoint_registry_identity_mismatch");
    }
    const result = parseRecord(resultBytes) as RuntimeResultEnvelope;
    const events = parseEvents(eventsBytes);
    const journal = parseLocalSafeExecutionTaskRecord(journalBytes.toString("utf8"));
    const selected = selectTerminalAttempt({
      jobId: input.identity.jobId, taskId: input.identity.taskId,
      executionGeneration: input.identity.executionGeneration,
      attemptNumber: input.identity.attemptNumber,
      journal, result, events, ownershipComplete: true,
    });
    const artifacts = result.artifacts ?? [];
    if (artifacts.length > 32 || input.sqliteDatabases.length > 32) {
      throw new Error("terminal_checkpoint_inventory_too_large");
    }
    const sources: TerminalCheckpointSource[] = [
      { role: "registry_manifest", kind: TerminalCheckpointPayloadKind.File,
        root: input.registryRootDir, path: input.registryManifestPath },
      { role: "runtime_result", kind: TerminalCheckpointPayloadKind.File,
        root: input.jobRootDir, path: input.resultPath },
      { role: "runtime_events", kind: TerminalCheckpointPayloadKind.File,
        root: input.jobRootDir, path: input.eventsPath },
      { role: "attempt_journal", kind: TerminalCheckpointPayloadKind.File,
        root: input.stateRootDir, path: journalPath },
    ];
    for (const [index, artifact] of artifacts.entries()) {
      if (!["patch", "summary", "manifest"].includes(artifact.kind) ||
          typeof artifact.path !== "string" || !isAbsolute(artifact.path) ||
          typeof artifact.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
          !Number.isSafeInteger(artifact.byteLength) || Number(artifact.byteLength) < 0) {
        throw new Error("terminal_checkpoint_artifact_reference_invalid");
      }
      sources.push({ role: `artifact_${index}`, kind: TerminalCheckpointPayloadKind.File,
        root: input.artifactRootDir, path: artifact.path,
        expectedSha256: artifact.sha256, expectedBytes: artifact.byteLength! });
    }
    for (const [index, database] of input.sqliteDatabases.entries()) {
      await assertTrustedSource(database.root, database.path);
      const wal = await lstat(`${database.path}-wal`).catch((error: unknown) => {
        if (isCode(error, "ENOENT")) return null;
        throw error;
      });
      if (wal && (!wal.isFile() || wal.isSymbolicLink())) {
        throw new Error("terminal_checkpoint_source_untrusted");
      }
      sources.push({ role: `sqlite_${index}`, kind: TerminalCheckpointPayloadKind.Sqlite,
        root: database.root, path: database.path });
      await verifyTestDatabaseIdentity(database.path, input.identity);
    }
    const seal = await sealImmutableTerminalCheckpoint({
      admission, claim, destination: input.destination,
      terminalAt: selected.terminalAt, retentionUntil: input.retentionUntil,
      ownershipEvidence: { kind: "fake_executor_complete",
        executionGeneration: input.identity.executionGeneration, providerLaunches: 0 },
      ...(input.previousCheckpointId === undefined ? {} : { previousCheckpointId: input.previousCheckpointId }),
      ...(input.expectedSealSha256 === undefined ? {} : { expectedSealSha256: input.expectedSealSha256 }),
      sources,
      afterDurablePhase: async (phase) => {
        if (input.injectCrashAfterPhase === phase) {
          injectedCrash = true;
          throw new Error(`terminal_checkpoint_test_crash_after_${phase}`);
        }
      },
      validateCaptured: async (payloadDir) => {
        const capturedResult = parseRecord(await readFile(join(payloadDir, "runtime_result.data"))) as RuntimeResultEnvelope;
        const captured = selectTerminalAttempt({
          jobId: input.identity.jobId, taskId: input.identity.taskId,
          executionGeneration: input.identity.executionGeneration,
          attemptNumber: input.identity.attemptNumber,
          journal: parseLocalSafeExecutionTaskRecord(
            (await readFile(join(payloadDir, "attempt_journal.data"))).toString("utf8")),
          result: capturedResult,
          events: parseEvents(await readFile(join(payloadDir, "runtime_events.data"))),
          ownershipComplete: true,
        });
        if (captured.terminalAt !== selected.terminalAt ||
            sha(await readFile(join(payloadDir, "registry_manifest.data"))) !==
              input.identity.registryRevisionSha256) {
          throw new Error("terminal_checkpoint_captured_sequence_mismatch");
        }
        for (const [index] of input.sqliteDatabases.entries()) {
          await verifyTestDatabaseIdentity(join(payloadDir, `sqlite_${index}.sqlite`), input.identity);
        }
      },
    });
    const verified = await verifyTestTerminalAttemptCheckpoint(input.destination, seal.sealSha256);
    if (verified.fence !== claim.fence || verified.checkpointId !== claim.checkpointId) {
      throw new Error("terminal_checkpoint_stale_fence");
    }
    await admission.release(claim, true);
    sealed = true;
    return seal;
  } finally {
    // Once COMMITTED may exist, an uncertain verifier or acknowledgement must
    // leave admission fenced. Never reopen writers over published seal bytes.
    if (!sealed && !injectedCrash) {
      const commitMayExist = await lstat(join(input.destination, "COMMITTED"))
        .then(() => true)
        .catch((error: unknown) => !isCode(error, "ENOENT"));
      if (!commitMayExist) await admission.release(claim, false).catch(() => {});
    }
  }
}

async function assertSyntheticFixtureScope(input: TestTerminalCheckpointInput): Promise<void> {
  if (!isAbsolute(input.testRoot)) throw new Error("terminal_checkpoint_test_scope_invalid");
  const root = await realpath(input.testRoot);
  const temp = await realpath(tmpdir());
  if (root !== resolve(input.testRoot) || !root.split(sep).at(-1)?.startsWith("test-") ||
      !inside(temp, root)) throw new Error("terminal_checkpoint_test_scope_invalid");
  const jobRoot = await realpath(input.jobRootDir);
  if (relative(root, jobRoot).split(sep)[0] !== input.identity.projectId) {
    throw new Error("terminal_checkpoint_test_scope_invalid");
  }
  for (const path of [input.registryRootDir, input.registryManifestPath,
    input.jobRootDir, input.stateRootDir, input.resultPath, input.eventsPath,
    input.artifactRootDir, input.destination,
    ...input.sqliteDatabases.flatMap((database) => [database.root, database.path])]) {
    if (!isAbsolute(path) || !inside(root, resolve(path))) {
      throw new Error("terminal_checkpoint_test_scope_invalid");
    }
    const parent = await realpath(dirname(path));
    if (parent !== root && !inside(root, parent)) {
      throw new Error("terminal_checkpoint_test_scope_invalid");
    }
  }
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return Boolean(rel) && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export async function verifyTestTerminalAttemptCheckpoint(
  directory: string, expectedSealSha256: string,
): Promise<TerminalCheckpointSealManifest> {
  const manifest = await verifyImmutableTerminalCheckpoint(directory, expectedSealSha256);
  const payload = (role: string) => {
    const file = manifest.files.find((item) => item.role === role);
    if (!file) throw new Error("terminal_checkpoint_payload_missing");
    return join(directory, file.storedPath);
  };
  const [registryBytes, resultBytes, eventsBytes, journalBytes] = await Promise.all([
    readTrusted(directory, payload("registry_manifest")),
    readTrusted(directory, payload("runtime_result")),
    readTrusted(directory, payload("runtime_events")),
    readTrusted(directory, payload("attempt_journal")),
  ]);
  if (sha(registryBytes) !== manifest.identity.registryRevisionSha256 ||
      parseRecord(registryBytes).jobId !== manifest.identity.jobId) {
    throw new Error("terminal_checkpoint_registry_identity_mismatch");
  }
  const result = parseRecord(resultBytes) as RuntimeResultEnvelope;
  const selected = selectTerminalAttempt({
    jobId: manifest.identity.jobId, taskId: manifest.identity.taskId,
    executionGeneration: manifest.identity.executionGeneration,
    attemptNumber: manifest.identity.attemptNumber,
    journal: parseLocalSafeExecutionTaskRecord(journalBytes.toString("utf8")),
    result, events: parseEvents(eventsBytes), ownershipComplete: true,
  });
  if (selected.terminalAt !== manifest.terminalAt) throw new Error("terminal_checkpoint_watermark_mismatch");
  const artifacts = result.artifacts ?? [];
  if (artifacts.length !== manifest.files.filter((file) => file.role.startsWith("artifact_")).length) {
    throw new Error("terminal_checkpoint_artifact_reference_invalid");
  }
  for (const [index, artifact] of artifacts.entries()) {
    const file = manifest.files.find((item) => item.role === `artifact_${index}`);
    if (!file || file.sha256 !== artifact.sha256 || file.bytes !== artifact.byteLength ||
        !artifact.path || !artifact.path.endsWith(file.sourceRelativePath)) {
      throw new Error("terminal_checkpoint_artifact_reference_invalid");
    }
  }
  for (const file of manifest.files.filter((item) => item.role.startsWith("sqlite_"))) {
    const path = join(directory, file.storedPath);
    await assertTrustedSource(directory, path);
    await verifyTestDatabaseIdentity(path, manifest.identity);
  }
  return manifest;
}

function localJournalPath(stateRootDir: string, taskId: string): string {
  return join(stateRootDir, "attempt-journal", "attempt-journal",
    `${createHash("sha256").update(taskId).digest("hex")}.json`);
}

async function verifyTestDatabaseIdentity(
  path: string, identity: TerminalCheckpointClaimIdentity,
): Promise<void> {
  const script = "import json,pathlib,sqlite3,sys\nc=sqlite3.connect(pathlib.Path(sys.argv[1]).as_uri()+'?mode=ro',uri=True)\nv=c.execute('PRAGMA user_version').fetchone()[0]\nk=[(r[1],r[2]) for r in c.execute('PRAGMA table_info(checkpoint_identity)')]\nr=c.execute('SELECT schema_version,job_id,task_id,generation,attempt_number FROM checkpoint_identity').fetchall()\nprint(json.dumps({'version':v,'columns':k,'rows':r}))\nc.close()";
  const { stdout } = await execFileAsync("python3", ["-c", script, path], { timeout: 60_000 });
  const actual: unknown = JSON.parse(stdout);
  const columns = [["schema_version", "INTEGER"], ["job_id", "TEXT"], ["task_id", "TEXT"],
    ["generation", "TEXT"], ["attempt_number", "INTEGER"]];
  if (!isRecord(actual) || actual.version !== 1 ||
      JSON.stringify(actual.columns) !== JSON.stringify(columns)) {
    throw new Error("terminal_checkpoint_sqlite_schema_mismatch");
  }
  if (!Array.isArray(actual.rows) || actual.rows.length !== 1 ||
      JSON.stringify(actual.rows[0]) !== JSON.stringify([1, identity.jobId, identity.taskId,
        identity.executionGeneration, identity.attemptNumber])) {
    throw new Error("terminal_checkpoint_sqlite_sequence_mismatch");
  }
}

async function readTrusted(root: string, path: string): Promise<Buffer> {
  await assertTrustedSource(root, path);
  return readFile(path);
}

async function assertTrustedSource(root: string, path: string): Promise<void> {
  if (!isAbsolute(root) || !isAbsolute(path)) throw new Error("terminal_checkpoint_source_untrusted");
  const rootItem = await lstat(root);
  if (!rootItem.isDirectory() || rootItem.isSymbolicLink()) {
    throw new Error("terminal_checkpoint_source_untrusted");
  }
  const canonicalRoot = await realpath(root);
  const rel = relative(canonicalRoot, resolve(path));
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("terminal_checkpoint_source_untrusted");
  }
  let cursor = canonicalRoot;
  const parts = rel.split(sep);
  for (const [index, part] of parts.entries()) {
    cursor = join(cursor, part);
    const item = await lstat(cursor);
    if (item.isSymbolicLink() ||
        (index === parts.length - 1 ? !item.isFile() : !item.isDirectory())) {
      throw new Error("terminal_checkpoint_source_untrusted");
    }
  }
}

function parseRecord(bytes: Buffer): Record<string, unknown> {
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("terminal_checkpoint_json_invalid");
  }
  return value as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEvents(bytes: Buffer): readonly {
  readonly event: string; readonly timestamp: string;
  readonly attributes?: Readonly<Record<string, string | number | boolean>>;
}[] {
  const lines = bytes.toString("utf8").trim().split("\n");
  if (lines.length === 0 || lines.some((line) => !line)) throw new Error("terminal_checkpoint_events_invalid");
  return lines.map((line) => {
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        !("event" in value) || typeof value.event !== "string" ||
        !("timestamp" in value) || typeof value.timestamp !== "string") {
      throw new Error("terminal_checkpoint_events_invalid");
    }
    return value as { event: string; timestamp: string;
      attributes?: Readonly<Record<string, string | number | boolean>> };
  });
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
