import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, readlinkSync, readSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

// Independent of mutable project/job ancestry and of TEST/global authority.
// Existing managed namespaces already hide all of /run/user, including this
// authority. It is separate from /run/user/0's TEST/global policy directories.
export const researchAuthorityRoot = "/run/user/subscription-runtime-research-v1";
// Fresh byte validation includes every custody/descriptor/path check, even on
// cache hits. Four seconds expired on the shared Host before provider startup;
// retain a finite per-artifact/executable budget without reusing authority.
export const researchByteValidationTimeoutMs = 30_000;
export const researchHash = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");
export type ResearchDenialObservation = "artifact-deadline" | "file-deadline" | "host-command-timeout" | "host-command-failed";
export function isResearchDenialObservation(value: unknown): value is ResearchDenialObservation {
  return value === "artifact-deadline" || value === "file-deadline" || value === "host-command-timeout" || value === "host-command-failed";
}
export enum ResearchHostCommandOperation {
  SystemctlShow = "systemctl-show", SystemctlListJobs = "systemctl-list-jobs", SystemdRun = "unit-submit", Unknown = "unknown",
}
export enum ResearchHostCommandUnitRole { Runtime = "runtime", Provider = "provider", Unknown = "unknown" }
export type ResearchHostCommandFailure = Readonly<{
  operation: ResearchHostCommandOperation; unitRole: ResearchHostCommandUnitRole; elapsedMs: number;
}>;
const hostCommandFailures = new WeakMap<object, ResearchHostCommandFailure>();
export function researchHostCommandFailure(error: unknown): ResearchHostCommandFailure | undefined {
  return error !== null && typeof error === "object" ? hostCommandFailures.get(error) : undefined;
}
export function copyResearchHostCommandFailure(original: unknown, replacement: Error): void {
  const failure = researchHostCommandFailure(original);
  if (failure && !hostCommandFailures.has(replacement)) hostCommandFailures.set(replacement, failure);
}
export function researchInvalid(observation?: ResearchDenialObservation, operation?: ResearchHostCommandOperation,
  unitRole?: ResearchHostCommandUnitRole, elapsedMs?: number): never {
  const error = new Error("hosted_research_launch_denied", { cause: observation });
  try {
    if (operation !== undefined && Object.values(ResearchHostCommandOperation).includes(operation) &&
        unitRole !== undefined && Object.values(ResearchHostCommandUnitRole).includes(unitRole) &&
        elapsedMs !== undefined && Number.isFinite(elapsedMs)) hostCommandFailures.set(error,
      Object.freeze({ operation, unitRole, elapsedMs: Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, elapsedMs)) }));
  } catch { /* Diagnostic failure cannot replace the original refusal. */ }
  throw error;
}
export function researchName(jobId: string): string { return researchHash(jobId); }
export function researchPath(value: unknown): string {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value ||
      !/^\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/.test(value) || value.length > 4096) researchInvalid();
  return value;
}
export function researchId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)) researchInvalid();
  return value;
}
export function researchRecord(value: unknown, keys: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== keys.split(",").sort().join(",")) researchInvalid();
  return value as Record<string, unknown>;
}
export function researchJson(bytes: Buffer): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { researchInvalid(); }
}

/** Strong custody applies to authority, artifacts, executables and operator input.
 * Project paths are separately pinned by the owner before a service is created. */
export function researchCustody(path: string, privateLeaf = false): void {
  researchPath(path);
  for (let current = path;; current = dirname(current)) {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) ||
        (current !== path && !stat.isDirectory()) ||
        (privateLeaf && current === path && (stat.mode & 0o077))) researchInvalid();
    if (current === "/") return;
  }
}
export function researchPrivateDirectory(path: string): void {
  if (path !== researchAuthorityRoot && !path.startsWith(researchAuthorityRoot + "/")) researchInvalid();
  try { researchCustody(path, true); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    researchCustody(dirname(path)); mkdirSync(path, { mode: 0o700 }); researchCustody(path, true);
  }
}
export function researchRead(path: string, privateFile = true, max = 1024 * 1024): Buffer {
  researchCustody(dirname(path), privateFile);
  return readResearchRegularBytes(path, privateFile, max);
}
function readResearchRegularBytes(path: string, privateFile: boolean, max: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.uid !== 0 || before.nlink !== 1 ||
        (before.mode & (privateFile ? 0o077 : 0o022)) || before.size > max) researchInvalid();
    const bytes = readFileSync(fd), after = fstatSync(fd);
    if (bytes.length !== before.size || before.ctimeMs !== after.ctimeMs ||
        before.mtimeMs !== after.mtimeMs || before.size !== after.size) researchInvalid();
    return bytes;
  } finally { closeSync(fd); }
}

/** Selected prompt data under the pinned job directory. Its project ancestry
 * is not authority. No symlink, foreign owner, hardlink or replacement is read. */
export function researchPromptBytes(job: ResearchDirectoryIdentity, path: string, pinnedRoot = job.path): Buffer {
  assertResearchDirectory(job, pinnedRoot);
  researchPath(path);
  if (!path.startsWith(job.path + "/")) researchInvalid();
  const pinnedPath = join(pinnedRoot, relative(job.path, path));
  for (let current = dirname(pinnedPath); current !== pinnedRoot; current = dirname(current)) {
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022)) researchInvalid();
  }
  const bytes = readResearchRegularBytes(pinnedPath, false, 1024 * 1024);
  assertResearchDirectory(job, pinnedRoot);
  return bytes;
}
export function researchPublish(path: string, value: unknown, exclusive = false): void {
  researchCustody(dirname(path), true);
  const bytes = Buffer.from(JSON.stringify(value) + "\n");
  if (exclusive) {
    const fd = openSync(path, "wx", 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  } else {
    const tmp = path + "." + randomUUID() + ".tmp";
    const fd = openSync(tmp, "wx", 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    try { renameSync(tmp, path); } finally { try { unlinkSync(tmp); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; } }
  }
  const fd = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

type ResearchFileHashCache = Map<string, { signature: string; digest: string }>;
const researchFileSignature = (stat: Stats): string =>
  [stat.dev, stat.ino, stat.size, stat.ctimeMs, stat.mtimeMs, stat.mode, stat.uid, stat.gid, stat.nlink].join(":");

/** Local byte witness with constant memory, including for large native binaries.
 * Cache hits still open/check the descriptor and path under strong custody. */
export function researchFileDigest(path: string, options: {
  maxBytes: number; deadline: number; cache: ResearchFileHashCache; cacheEntries: number;
  executable?: boolean; expected?: Stats;
}): string {
  const checkTime = (): void => { if (performance.now() > options.deadline) researchInvalid("file-deadline"); };
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0 || !Number.isFinite(options.deadline) ||
      !Number.isSafeInteger(options.cacheEntries) || options.cacheEntries < 1) researchInvalid();
  checkTime(); researchCustody(path); checkTime();
  const pathStat = lstatSync(path), fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd), signature = researchFileSignature(before);
    if (!before.isFile() || before.uid !== 0 || before.nlink !== 1 || (before.mode & 0o022) ||
        !Number.isSafeInteger(before.size) || before.size < 0 || before.size > options.maxBytes ||
        (options.executable && !(before.mode & 0o111)) || researchFileSignature(pathStat) !== signature ||
        (options.expected && researchFileSignature(options.expected) !== signature)) researchInvalid();
    checkTime();
    const cached = options.cache.get(path);
    let digest = cached?.signature === signature ? cached.digest : undefined;
    if (digest === undefined) {
      const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(64 * 1024);
      let offset = 0;
      while (offset < before.size) {
        checkTime();
        const count = readSync(fd, buffer, 0, Math.min(buffer.length, before.size - offset), offset);
        if (count < 1) researchInvalid();
        hash.update(buffer.subarray(0, count)); offset += count;
        checkTime();
      }
      if (readSync(fd, buffer, 0, 1, offset) !== 0) researchInvalid();
      digest = hash.digest("hex");
    }
    if (researchFileSignature(fstatSync(fd)) !== signature) researchInvalid();
    researchCustody(path);
    if (researchFileSignature(lstatSync(path)) !== signature) researchInvalid();
    checkTime();
    if (options.cache.size >= options.cacheEntries && !options.cache.has(path)) options.cache.clear();
    options.cache.set(path, { signature, digest });
    return digest;
  } finally { closeSync(fd); }
}

/** Hash executable bytes, never .source-commit or deployment assertions. Internal
 * dependency links are permitted only inside the same immutable artifact. */
export function researchArtifactDigest(runtimeDirectory: string): string {
  const deadline = performance.now() + researchByteValidationTimeoutMs;
  researchCustody(runtimeDirectory);
  const rows: string[] = [];
  const visited = new Set<string>();
  let entries = 0, totalBytes = 0;
  const visit = (path: string): void => {
    if (visited.has(path)) return;
    visited.add(path);
    if (++entries > 50000) researchInvalid();
    if (performance.now() > deadline) researchInvalid("artifact-deadline");
    const stat = lstatSync(path), name = relative(runtimeDirectory, path);
    if (stat.uid !== 0 || (!stat.isSymbolicLink() && (stat.mode & 0o022))) researchInvalid();
    if (stat.isSymbolicLink()) {
      const target = realpathSync(path);
      if (!target.startsWith(runtimeDirectory + "/")) researchInvalid();
      researchCustody(target); rows.push(`${name}:link:${readlinkSync(path)}`);
      visit(target); // Includes workspace package targets outside node_modules.
    } else if (stat.isDirectory()) {
      rows.push(`${name}:dir:${stat.mode & 0o777}`);
      for (const child of readdirSync(path).sort()) visit(join(path, child));
    } else if (stat.isFile()) {
      totalBytes += stat.size;
      if (totalBytes > 512 * 1024 * 1024 || stat.nlink !== 1) researchInvalid();
      const digest = researchFileDigest(path, { maxBytes: 512 * 1024 * 1024, deadline,
        cache: artifactFileHashes, cacheEntries: 50000, expected: stat });
      rows.push(`${name}:${stat.mode & 0o777}:${digest}`);
    } else researchInvalid();
  };
  for (const name of ["dist", "host-integration", "node_modules", "package.json"]) visit(join(runtimeDirectory, name));
  if (performance.now() > deadline) researchInvalid("artifact-deadline");
  return researchHash(JSON.stringify(rows));
}
const artifactFileHashes: ResearchFileHashCache = new Map();

export type ResearchDirectoryIdentity = Readonly<{ path: string; device: number; inode: number }>;
export function researchDirectoryIdentity(path: string): ResearchDirectoryIdentity {
  researchPath(path);
  // Walk all components without accepting symlinks. Ancestors may be project
  // owned; they confer no authority and the root-private bind mount pins the leaf.
  for (let current = path;; current = dirname(current)) {
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) researchInvalid();
    if (current === path && (stat.uid !== 0 || (stat.mode & 0o022))) researchInvalid();
    if (current === "/") break;
  }
  const stat = lstatSync(path);
  return Object.freeze({ path, device: stat.dev, inode: stat.ino });
}
export function assertResearchDirectory(identity: ResearchDirectoryIdentity, path = identity.path): void {
  const current = researchDirectoryIdentity(path);
  if (current.device !== identity.device || current.inode !== identity.inode) researchInvalid();
}
