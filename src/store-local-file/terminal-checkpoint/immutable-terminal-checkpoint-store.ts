import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
  assertTerminalCheckpointClaimIdentity,
  TerminalCheckpointDurablePhase,
  TerminalCheckpointPayloadKind,
  type TerminalCheckpointPayload,
  type TerminalCheckpointSealManifest,
} from "@vioxen/subscription-runtime/worker-core";
import { LocalTerminalCheckpointAdmission, type LocalTerminalCheckpointClaim } from "./local-terminal-checkpoint-admission";

const execFileAsync = promisify(execFile);
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const rolePattern = /^[a-z][a-z0-9_]{0,63}$/;

export type TerminalCheckpointSource = {
  readonly role: string;
  readonly kind: TerminalCheckpointPayloadKind;
  readonly root: string;
  readonly path: string;
  readonly expectedSha256?: string;
  readonly expectedBytes?: number;
};

export type ImmutableTerminalCheckpointSealInput = {
  readonly admission: LocalTerminalCheckpointAdmission;
  readonly claim: LocalTerminalCheckpointClaim;
  readonly destination: string;
  readonly terminalAt: string;
  readonly retentionUntil: string;
  readonly ownershipEvidence: TerminalCheckpointSealManifest["ownershipEvidence"];
  readonly previousCheckpointId?: string;
  readonly sources: readonly TerminalCheckpointSource[];
  readonly validateCaptured?: (payloadDirectory: string) => Promise<void>;
  readonly afterDurablePhase?: (phase: TerminalCheckpointDurablePhase) => Promise<void>;
  /** Required when an already published checkpoint is returned after ack loss. */
  readonly expectedSealSha256?: string;
};

export async function sealImmutableTerminalCheckpoint(input: ImmutableTerminalCheckpointSealInput): Promise<{
  readonly manifestPath: string;
  readonly sealSha256: string;
}> {
  if (!input.claim.identity.projectId.startsWith("test-") ||
      !isAbsolute(input.destination) || input.sources.length < 4 || input.sources.length > 260 ||
      !Number.isFinite(Date.parse(input.terminalAt)) ||
      Date.parse(input.retentionUntil) <= Date.now()) {
    throw new Error("terminal_checkpoint_seal_input_invalid");
  }
  await input.admission.assertClaim(input.claim);
  if (await exists(input.destination)) {
    if (!input.expectedSealSha256) throw new Error("terminal_checkpoint_retry_digest_required");
    const existing = await verifyImmutableTerminalCheckpoint(input.destination, input.expectedSealSha256);
    if (existing.checkpointId !== input.claim.checkpointId ||
        existing.fence !== input.claim.fence ||
        JSON.stringify(existing.identity) !== JSON.stringify(input.claim.identity)) {
      throw new Error("terminal_checkpoint_retry_identity_mismatch");
    }
    return { manifestPath: join(input.destination, "checkpoint-manifest.json"),
      sealSha256: input.expectedSealSha256 };
  }
  const prepared = await prepareSources(input.sources);
  await mkdir(input.destination, { mode: 0o700 }); // exclusive, create-only reservation
  await syncDirectory(dirname(input.destination));
  await input.afterDurablePhase?.(TerminalCheckpointDurablePhase.Reserved);
  const payloadDir = join(input.destination, "payload");
  await mkdir(payloadDir, { mode: 0o700 });
  await syncDirectory(input.destination);
  const files: TerminalCheckpointPayload[] = [];
  for (const source of prepared) {
    await input.admission.assertClaim(input.claim);
    const storedPath = `payload/${source.role}.${source.kind === TerminalCheckpointPayloadKind.Sqlite ? "sqlite" : "data"}`;
    const target = join(input.destination, storedPath);
    const before = await sourceFingerprint(source.path, source.kind);
    if (source.kind === TerminalCheckpointPayloadKind.Sqlite) {
      await writeExclusive(target, Buffer.alloc(0));
      await sqliteBackup(source.path, target);
      await syncFile(target);
    } else {
      await writeExclusive(target, await readFile(source.path));
    }
    const after = await sourceFingerprint(source.path, source.kind);
    if (before !== after) throw new Error("terminal_checkpoint_source_changed");
    const bytes = await readFile(target);
    if (source.expectedSha256 !== undefined && hash(bytes) !== source.expectedSha256 ||
        source.expectedBytes !== undefined && bytes.length !== source.expectedBytes) {
      throw new Error("terminal_checkpoint_dependency_hash_mismatch");
    }
    await chmod(target, 0o400);
    await syncFile(target);
    files.push({ role: source.role, kind: source.kind,
      sourceRelativePath: source.relativePath, storedPath,
      sha256: hash(bytes), bytes: bytes.length });
  }
  await input.validateCaptured?.(payloadDir);
  await syncDirectory(payloadDir);
  await input.afterDurablePhase?.(TerminalCheckpointDurablePhase.Payloads);
  if (files.find((file) => file.role === "registry_manifest")?.sha256 !==
      input.claim.identity.registryRevisionSha256) {
    throw new Error("terminal_checkpoint_registry_revision_mismatch");
  }
  await input.admission.assertClaim(input.claim);
  const manifest: TerminalCheckpointSealManifest = {
    schemaVersion: 1, authority: "test_fixture_fenced",
    checkpointId: input.claim.checkpointId, identity: input.claim.identity,
    fence: input.claim.fence, capturedAt: new Date().toISOString(),
    terminalAt: input.terminalAt, retentionUntil: input.retentionUntil,
    ownershipEvidence: input.ownershipEvidence,
    registryRevisionSha256: input.claim.identity.registryRevisionSha256,
    ...(input.previousCheckpointId === undefined ? {} : { previousCheckpointId: input.previousCheckpointId }),
    files,
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const sealSha256 = hash(manifestBytes);
  await writeExclusive(join(input.destination, "checkpoint-manifest.json"), manifestBytes);
  await writeExclusive(join(input.destination, "SHA256SUMS"),
    Buffer.from(`${sealSha256}  checkpoint-manifest.json\n`));
  await syncDirectory(input.destination);
  await input.afterDurablePhase?.(TerminalCheckpointDurablePhase.Manifest);
  await input.admission.assertClaim(input.claim);
  await writeExclusive(join(input.destination, "COMMITTED"), Buffer.from(`${sealSha256}\n`));
  await chmod(payloadDir, 0o500);
  await chmod(input.destination, 0o500);
  await syncDirectory(payloadDir);
  await syncDirectory(input.destination);
  await input.afterDurablePhase?.(TerminalCheckpointDurablePhase.Committed);
  return { manifestPath: join(input.destination, "checkpoint-manifest.json"), sealSha256 };
}

export async function verifyImmutableTerminalCheckpoint(
  directory: string, expectedSealSha256: string,
): Promise<TerminalCheckpointSealManifest> {
  if (!/^[a-f0-9]{64}$/.test(expectedSealSha256)) throw new Error("terminal_checkpoint_digest_invalid");
  await assertPlainDirectory(directory);
  const top = await readdir(directory);
  if (top.sort().join("\0") !== ["COMMITTED", "SHA256SUMS", "checkpoint-manifest.json", "payload"].sort().join("\0")) {
    throw new Error("terminal_checkpoint_unexpected_file");
  }
  const manifestBytes = await readPlainFile(join(directory, "checkpoint-manifest.json"));
  if (hash(manifestBytes) !== expectedSealSha256 ||
      (await readPlainFile(join(directory, "SHA256SUMS"))).toString("utf8") !==
        `${expectedSealSha256}  checkpoint-manifest.json\n` ||
      (await readPlainFile(join(directory, "COMMITTED"))).toString("utf8") !==
        `${expectedSealSha256}\n`) throw new Error("terminal_checkpoint_digest_mismatch");
  const value: unknown = JSON.parse(manifestBytes.toString("utf8"));
  if (!isRecord(value) || value.schemaVersion !== 1 || value.authority !== "test_fixture_fenced" ||
      !Array.isArray(value.files) || value.files.length < 4 || value.files.length > 260 ||
      !isRecord(value.identity) || typeof value.checkpointId !== "string" ||
      !Number.isSafeInteger(value.fence) || !Number.isFinite(Date.parse(String(value.terminalAt)))) {
    throw new Error("terminal_checkpoint_manifest_invalid");
  }
  const manifest = value as TerminalCheckpointSealManifest;
  assertTerminalCheckpointClaimIdentity(manifest.identity);
  if (!manifest.identity.projectId.startsWith("test-") ||
      manifest.registryRevisionSha256 !== manifest.identity.registryRevisionSha256 ||
      !isRecord(manifest.ownershipEvidence) ||
      manifest.ownershipEvidence.kind !== "fake_executor_complete" ||
      manifest.ownershipEvidence.executionGeneration !== manifest.identity.executionGeneration ||
      manifest.ownershipEvidence.providerLaunches !== 0) {
    throw new Error("terminal_checkpoint_manifest_invalid");
  }
  await assertPlainDirectory(join(directory, "payload"));
  const expected = new Set<string>();
  const roles = new Set<string>();
  for (const file of manifest.files) {
    if (!isRecord(file) || typeof file.role !== "string" || !rolePattern.test(file.role) ||
        roles.has(file.role) || ![TerminalCheckpointPayloadKind.File,
          TerminalCheckpointPayloadKind.Sqlite].includes(file.kind) ||
        typeof file.sourceRelativePath !== "string" || !safeRelative(file.sourceRelativePath) ||
        file.storedPath !== `payload/${file.role}.${file.kind === TerminalCheckpointPayloadKind.Sqlite ? "sqlite" : "data"}` ||
        typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256) ||
        !Number.isSafeInteger(file.bytes) || file.bytes < 0) {
      throw new Error("terminal_checkpoint_manifest_invalid");
    }
    roles.add(file.role);
    expected.add(basename(file.storedPath));
    const bytes = await readPlainFile(join(directory, file.storedPath));
    if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) {
      throw new Error("terminal_checkpoint_payload_mismatch");
    }
    if (file.kind === TerminalCheckpointPayloadKind.Sqlite) {
      await sqliteIntegrity(join(directory, file.storedPath));
    }
  }
  if (!["registry_manifest", "runtime_result", "runtime_events", "attempt_journal"]
      .every((role) => roles.has(role))) throw new Error("terminal_checkpoint_manifest_invalid");
  if (manifest.files.find((file) => file.role === "registry_manifest")?.sha256 !==
      manifest.registryRevisionSha256) throw new Error("terminal_checkpoint_registry_revision_mismatch");
  const actualPayloadNames = await readdir(join(directory, "payload"));
  if (actualPayloadNames.sort().join("\0") !== [...expected].sort().join("\0")) {
    throw new Error(`terminal_checkpoint_unexpected_file:${actualPayloadNames.join(",")}`);
  }
  return manifest;
}

type Prepared = TerminalCheckpointSource & { readonly relativePath: string };

async function prepareSources(sources: readonly TerminalCheckpointSource[]): Promise<readonly Prepared[]> {
  const roles = new Set<string>();
  const paths = new Set<string>();
  const prepared: Prepared[] = [];
  for (const source of sources) {
    if (!rolePattern.test(source.role) || roles.has(source.role) ||
        !isAbsolute(source.root) || !isAbsolute(source.path) ||
        ![TerminalCheckpointPayloadKind.File, TerminalCheckpointPayloadKind.Sqlite].includes(source.kind) ||
        source.kind === TerminalCheckpointPayloadKind.Sqlite && !/\.(db|sqlite|sqlite3)$/i.test(source.path)) {
      throw new Error("terminal_checkpoint_source_invalid");
    }
    await assertPlainDirectory(source.root);
    const root = await realpath(source.root);
    const rel = relative(root, resolve(source.path));
    if (!safeRelative(rel)) throw new Error("terminal_checkpoint_source_outside_root");
    let cursor = root;
    for (const part of rel.split(sep)) {
      cursor = join(cursor, part);
      const item = await lstat(cursor);
      if (item.isSymbolicLink()) throw new Error("terminal_checkpoint_source_symlink");
      if (cursor !== source.path && cursor !== resolve(source.path) && !item.isDirectory()) {
        throw new Error("terminal_checkpoint_source_untrusted");
      }
    }
    const path = await realpath(source.path);
    const item = await lstat(path);
    if (!item.isFile() || paths.has(path)) throw new Error("terminal_checkpoint_source_alias");
    paths.add(path); roles.add(source.role);
    prepared.push({ ...source, path, relativePath: rel });
  }
  return prepared;
}

function safeRelative(path: string): boolean {
  return Boolean(path) && path !== ".." && !path.startsWith(`..${sep}`) &&
    !isAbsolute(path) && !path.split(sep).includes(".");
}

async function sourceFingerprint(path: string, kind: TerminalCheckpointPayloadKind): Promise<string> {
  const main = hash(await readFile(path));
  if (kind === TerminalCheckpointPayloadKind.File) return main;
  let wal = "absent";
  try { wal = hash(await readPlainFile(`${path}-wal`)); }
  catch (error) { if (!isCode(error, "ENOENT")) throw error; }
  return `${main}:${wal}`;
}

async function sqliteBackup(source: string, destination: string): Promise<void> {
  const script = "import pathlib,sqlite3,sys\ns=sqlite3.connect(pathlib.Path(sys.argv[1]).as_uri()+'?mode=ro',uri=True)\nd=sqlite3.connect(sys.argv[2])\ns.backup(d)\nassert d.execute('PRAGMA integrity_check').fetchone()[0]=='ok'\nassert d.execute('PRAGMA foreign_key_check').fetchone() is None\nd.execute('PRAGMA wal_checkpoint(TRUNCATE)')\nassert d.execute('PRAGMA journal_mode=DELETE').fetchone()[0]=='delete'\nd.close()\ns.close()";
  await execFileAsync("python3", ["-c", script, source, destination], { timeout: 60_000 });
}

async function sqliteIntegrity(path: string): Promise<void> {
  const script = "import pathlib,sqlite3,sys\nc=sqlite3.connect(pathlib.Path(sys.argv[1]).as_uri()+'?mode=ro',uri=True)\nassert c.execute('PRAGMA integrity_check').fetchone()[0]=='ok'\nassert c.execute('PRAGMA foreign_key_check').fetchone() is None\nc.close()";
  await execFileAsync("python3", ["-c", script, path], { timeout: 60_000 });
}

async function readPlainFile(path: string): Promise<Buffer> {
  const item = await lstat(path);
  if (!item.isFile() || item.isSymbolicLink()) throw new Error("terminal_checkpoint_untrusted_file");
  return readFile(path);
}

async function assertPlainDirectory(path: string): Promise<void> {
  const item = await lstat(path);
  if (!item.isDirectory() || item.isSymbolicLink()) throw new Error("terminal_checkpoint_untrusted_directory");
}

async function writeExclusive(path: string, bytes: Buffer): Promise<void> {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
}

async function syncFile(path: string): Promise<void> {
  const file = await open(path, "r");
  try { await file.sync(); } finally { await file.close(); }
}

async function syncDirectory(path: string): Promise<void> {
  const dir = await open(path, "r");
  try { await dir.sync(); } finally { await dir.close(); }
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; }
  catch (error) { if (isCode(error, "ENOENT")) return false; throw error; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
