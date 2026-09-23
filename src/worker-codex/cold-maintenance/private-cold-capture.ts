import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, open, readdir, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { observeColdReadOnlySource, type ColdSourceObservation } from "./private-cold-source-observation";

const run = promisify(execFile);
const MAX_FILES = 32;
const MAX_BYTES = 128 * 1024 * 1024;
const MAX_METADATA = 256 * 1024;
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const dbRoles = new Set(["state_5", "logs_2", "goals_1", "memories_1", "queue_1", "thread_history_1"]);
const artifactRole = /^(registry|result|journal|events|artifact_(0|[1-9][0-9]?))$/;
const forbidden = /(^|[._-])(auth|credential|secret|token|cookie|keychain|password|session)([._-]|$)/i;
const excludedTree = /^(archive|archives|archived|history|historical|worktree|worktrees|project|projects)(?:[-_][A-Za-z0-9]+)*$/i;

export type ColdFileIdentity = { readonly bytes: number; readonly sha256: string;
  readonly dev: number; readonly ino: number };
export type ColdSource = { readonly role: string; readonly kind: "sqlite" | "artifact";
  readonly path: string; readonly identity: ColdFileIdentity;
  readonly sidecars?: { readonly wal?: ColdFileIdentity; readonly shm?: ColdFileIdentity };
  /** Optional exact row witness supplied by a reviewed schema owner. */
  readonly probe?: { readonly table: string; readonly keyColumn: string; readonly key: string;
    readonly valueColumn: string; readonly value: string } };
export type ColdManifest = { readonly version: 1; readonly kind: "inert_cold_maintenance";
  readonly selectedJobId: string; readonly rawFiles: readonly { readonly name: string;
    readonly bytes: number; readonly sha256: string }[];
  readonly files: readonly { readonly role: string;
    readonly kind: "sqlite" | "artifact"; readonly storedPath: string;
    readonly bytes: number; readonly sha256: string;
    readonly probe?: ColdSource["probe"] }[] };

function fail(reason: string): never { throw new Error(`cold_maintenance_${reason}`); }
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return !!rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function validDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function onlyKeys(value: unknown, allowed: readonly string[]): boolean {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).every((key) => allowed.includes(key));
}
function validIdentity(value: ColdFileIdentity): boolean {
  return onlyKeys(value, ["bytes", "sha256", "dev", "ino"]) &&
    Number.isSafeInteger(value.bytes) && value.bytes >= 0 &&
    value.bytes <= MAX_BYTES && validDigest(value.sha256) &&
    Number.isSafeInteger(value.dev) && value.dev >= 0 &&
    Number.isSafeInteger(value.ino) && value.ino > 0;
}
function validProbe(p: ColdSource["probe"]): boolean {
  return onlyKeys(p, ["table", "keyColumn", "key", "valueColumn", "value"]) &&
    [p!.table, p!.keyColumn, p!.valueColumn].every((s) =>
    /^[A-Za-z_][A-Za-z_0-9]{0,63}$/.test(s) && !forbidden.test(s)) &&
    typeof p!.key === "string" && p!.key.length <= 256 &&
    typeof p!.value === "string" && p!.value.length <= 256;
}
async function present(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (e) { if (isCode(e, "ENOENT")) return false; throw e; }
}
function isCode(e: unknown, code: string): boolean {
  return typeof e === "object" && e !== null && "code" in e && e.code === code;
}
async function exactDirectory(path: string): Promise<void> {
  if (!isAbsolute(path) || resolve(path) !== path || path === "/") fail("path_invalid");
  await noSymlinkPath("/", path, "directory");
}
async function noSymlinkPath(root: string, path: string, final: "file" | "directory" | "absent"): Promise<void> {
  if (!isAbsolute(path) || resolve(path) !== path || !inside(root, path)) fail("path_invalid");
  let cursor = root;
  const parts = relative(root, path).split(sep);
  for (const [i, part] of parts.entries()) {
    if (!part || part === "." || part === ".." || forbidden.test(part)) fail("path_invalid");
    cursor = join(cursor, part);
    const last = i === parts.length - 1;
    if (last && final === "absent") {
      if (await present(cursor)) fail("output_exists");
      continue;
    }
    const item = await lstat(cursor);
    if (item.isSymbolicLink() || (last && final === "file" ? !item.isFile() : !item.isDirectory()))
      fail("path_invalid");
  }
  if (final !== "absent" && await realpath(path) !== path) fail("path_invalid");
}
async function selectedPath(root: string, path: string): Promise<void> {
  if (!inside(root, path) || relative(root, path).split(sep).slice(0, -1).some((part) => excludedTree.test(part)))
    fail("path_invalid");
  await noSymlinkPath(root, path, "file");
}
async function readBounded(path: string, limit: number): Promise<Buffer> {
  const file = await open(path, "r");
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > limit) fail("limit_exceeded");
    const chunks: Buffer[] = [];
    let total = 0;
    const chunk = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, limit - total + 1), null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > limit) fail("limit_exceeded");
      chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
    }
    if ((await file.stat()).size !== total) fail("payload_tampered");
    return Buffer.concat(chunks, total);
  } finally { await file.close(); }
}
async function exactFile(path: string, expected: ColdFileIdentity): Promise<Buffer> {
  const before = await stat(path);
  if (!before.isFile() || before.dev !== expected.dev || before.ino !== expected.ino ||
      before.size !== expected.bytes) fail("source_identity_changed");
  const bytes = await readBounded(path, expected.bytes);
  const after = await stat(path);
  if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
      bytes.length !== expected.bytes || digest(bytes) !== expected.sha256) fail("source_identity_changed");
  return bytes;
}
async function durableFile(path: string, bytes: Buffer | string): Promise<void> {
  const file = await open(path, "wx", 0o400);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
}
async function syncDir(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

const sqliteScript = `import json,sqlite3,sys,urllib.parse
raw,out,probe_json=sys.argv[1:]
p=json.loads(probe_json)
src=sqlite3.connect('file:'+urllib.parse.quote(raw,safe='/')+'?mode=ro',uri=True)
dst=sqlite3.connect(out)
src.backup(dst)
src.close()
dst.execute('PRAGMA journal_mode=DELETE')
if dst.execute('PRAGMA integrity_check').fetchall()!=[('ok',)]: raise ValueError('integrity')
if dst.execute('PRAGMA foreign_key_check').fetchall(): raise ValueError('foreign_key')
q=lambda s:'"'+s+'"'
if p is not None:
 rows=dst.execute('SELECT '+q(p['valueColumn'])+' FROM '+q(p['table'])+' WHERE '+q(p['keyColumn'])+'=?',(p['key'],)).fetchall()
 if rows!=[(p['value'],)]: raise ValueError('probe')
dst.close()`;
const verifyScript = `import json,sqlite3,sys,urllib.parse
p=json.loads(sys.argv[2]); c=sqlite3.connect('file:'+urllib.parse.quote(sys.argv[1],safe='/')+'?mode=ro',uri=True)
if c.execute('PRAGMA integrity_check').fetchall()!=[('ok',)]: raise ValueError('integrity')
if c.execute('PRAGMA foreign_key_check').fetchall(): raise ValueError('foreign_key')
q=lambda s:'"'+s+'"'
if p is not None and c.execute('SELECT '+q(p['valueColumn'])+' FROM '+q(p['table'])+' WHERE '+q(p['keyColumn'])+'=?',(p['key'],)).fetchall()!=[(p['value'],)]: raise ValueError('probe')
c.close()`;
async function sqliteCheck(path: string, probe: ColdSource["probe"]): Promise<void> {
  try { await run("python3", ["-c", verifyScript, path, JSON.stringify(probe ?? null)],
    { timeout: 30_000, maxBuffer: 1024 }); }
  catch { fail("sqlite_invalid"); }
}

/** Private capture. A trusted Host/operator establishes rescue control separately. */
export async function capturePrivateColdMaintenance(input: {
  readonly sourceRoot: string; readonly expectedSource: ColdSourceObservation;
  readonly selectedJobId: string; readonly selectedJobRoot: string;
  readonly sources: readonly ColdSource[]; readonly destination: string;
}): Promise<{ readonly manifestSha256: string; readonly receiptPath: string }> {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(input.selectedJobId) ||
      !Array.isArray(input.sources) || input.sources.length < 1 || input.sources.length > MAX_FILES)
    fail("allowlist_invalid");
  await exactDirectory(input.sourceRoot);
  await noSymlinkPath(input.sourceRoot, input.selectedJobRoot, "directory");
  if (relative(input.sourceRoot, input.selectedJobRoot).split(sep).some((part) => excludedTree.test(part)))
    fail("path_invalid");
  await exactDirectory(dirname(input.destination));
  await noSymlinkPath(dirname(input.destination), input.destination, "absent");
  if (!basename(input.destination).startsWith("cold-maintenance-") ||
      inside(input.sourceRoot, input.destination) || inside(input.destination, input.sourceRoot))
    fail("path_invalid");
  await observeColdReadOnlySource(input.sourceRoot, input.expectedSource);
  const usedRoles = new Set<string>();
  const usedInodes = new Set<string>();
  const staged: { source: ColdSource; main: Buffer; wal?: Buffer; shm?: Buffer }[] = [];
  let total = 0;
  for (const source of input.sources) {
    if (!validIdentity(source?.identity) ||
        (source.sidecars !== undefined && (!onlyKeys(source.sidecars, ["wal", "shm"]) ||
          Object.values(source.sidecars).some((item) => item !== undefined && !validIdentity(item)))))
      fail("allowlist_invalid");
    total += source.identity.bytes + (source.sidecars?.wal?.bytes ?? 0) + (source.sidecars?.shm?.bytes ?? 0);
    if (total > MAX_BYTES) fail("limit_exceeded");
  }
  total = 0;
  for (const source of input.sources) {
    if (!onlyKeys(source, ["role", "kind", "path", "identity", "sidecars", "probe"]) ||
        (source.sidecars !== undefined && !onlyKeys(source.sidecars, ["wal", "shm"])) ||
        (source.kind !== "sqlite" && source.kind !== "artifact") ||
        !(source.kind === "sqlite" ? dbRoles.has(source.role) &&
          (source.probe === undefined || validProbe(source.probe)) :
          artifactRole.test(source.role) && source.probe === undefined && source.sidecars === undefined) ||
        usedRoles.has(source.role) || !validIdentity(source.identity)) fail("allowlist_invalid");
    usedRoles.add(source.role);
    await selectedPath(input.selectedJobRoot, source.path);
    const main = await exactFile(source.path, source.identity);
    const key = `${source.identity.dev}:${source.identity.ino}`;
    if (usedInodes.has(key)) fail("duplicate_alias");
    usedInodes.add(key);
    total += main.length;
    let wal: Buffer | undefined;
    let shm: Buffer | undefined;
    if (source.kind === "sqlite") {
      for (const suffix of ["wal", "shm"] as const) {
        const sidePath = `${source.path}-${suffix}`;
        const exists = await present(sidePath);
        const expected = source.sidecars?.[suffix];
        if (exists !== !!expected) fail("sidecar_inventory_changed");
        if (expected) {
          if (!validIdentity(expected)) fail("allowlist_invalid");
          await selectedPath(input.selectedJobRoot, sidePath);
          const bytes = await exactFile(sidePath, expected);
          const sideKey = `${expected.dev}:${expected.ino}`;
          if (usedInodes.has(sideKey)) fail("duplicate_alias");
          usedInodes.add(sideKey);
          total += bytes.length;
          if (suffix === "wal") wal = bytes; else shm = bytes;
        }
      }
    }
    if (total > MAX_BYTES || usedInodes.size > MAX_FILES * 3) fail("limit_exceeded");
    staged.push({ source, main, ...(wal ? { wal } : {}), ...(shm ? { shm } : {}) });
  }
  await mkdir(input.destination, { mode: 0o700 });
  const rawDir = join(input.destination, "raw");
  const payloadDir = join(input.destination, "payload");
  const workDir = join(input.destination, "working");
  await mkdir(rawDir, { mode: 0o700 });
  await mkdir(payloadDir, { mode: 0o700 });
  await mkdir(workDir, { mode: 0o700 });
  const files: ColdManifest["files"][number][] = [];
  const rawFiles: ColdManifest["rawFiles"][number][] = [];
  for (const { source, main, wal, shm } of staged) {
    const raw = join(rawDir, source.role);
    await durableFile(raw, main);
    rawFiles.push({ name: source.role, bytes: main.length, sha256: digest(main) });
    if (wal) { await durableFile(`${raw}-wal`, wal);
      rawFiles.push({ name: `${source.role}-wal`, bytes: wal.length, sha256: digest(wal) }); }
    if (shm) { await durableFile(`${raw}-shm`, shm);
      rawFiles.push({ name: `${source.role}-shm`, bytes: shm.length, sha256: digest(shm) }); }
    const storedPath = `payload/${source.role}${source.kind === "sqlite" ? ".sqlite" : ".data"}`;
    const stored = join(input.destination, storedPath);
    if (source.kind === "sqlite") {
      const working = join(workDir, source.role);
      await durableFile(working, main);
      if (wal) await durableFile(`${working}-wal`, wal);
      if (shm) await durableFile(`${working}-shm`, shm);
      try { await run("python3", ["-c", sqliteScript, working, stored, JSON.stringify(source.probe ?? null)],
        { timeout: 30_000, maxBuffer: 1024 }); }
      catch { fail("sqlite_invalid"); }
      await sqliteCheck(stored, source.probe);
      await chmod(stored, 0o400);
    } else await durableFile(stored, main);
    if (source.kind === "sqlite") {
      const handle = await open(stored, "r");
      try { await handle.sync(); } finally { await handle.close(); }
    }
    const bytes = await readBounded(stored, MAX_BYTES);
    if (bytes.length > MAX_BYTES) fail("limit_exceeded");
    files.push({ role: source.role, kind: source.kind, storedPath, bytes: bytes.length,
      sha256: digest(bytes), ...(source.probe ? { probe: source.probe } : {}) });
  }
  // The source may have changed after initial staging; reread every declared byte.
  for (const { source } of staged) {
    await selectedPath(input.selectedJobRoot, source.path);
    await exactFile(source.path, source.identity);
    if (source.kind === "sqlite") for (const suffix of ["wal", "shm"] as const) {
      const expected = source.sidecars?.[suffix];
      if ((await present(`${source.path}-${suffix}`)) !== !!expected) fail("sidecar_inventory_changed");
      if (expected) { await selectedPath(input.selectedJobRoot, `${source.path}-${suffix}`);
        await exactFile(`${source.path}-${suffix}`, expected); }
    }
  }
  await exactDirectory(input.sourceRoot);
  await observeColdReadOnlySource(input.sourceRoot, input.expectedSource);
  await rm(workDir, { recursive: true });
  const manifest: ColdManifest = { version: 1, kind: "inert_cold_maintenance",
    selectedJobId: input.selectedJobId, rawFiles, files };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
  const manifestSha256 = digest(manifestBytes);
  await durableFile(join(input.destination, "maintenance-manifest.json"), manifestBytes);
  await syncDir(rawDir); await syncDir(payloadDir); await syncDir(input.destination);
  const receipt = { kind: "inert_cold_maintenance_receipt", selectedJobId: input.selectedJobId,
    manifestSha256, currentSelectedJobOnly: true, historicalTreesExcluded: true,
    routingDisabled: true, resumabilityClaim: false };
  await durableFile(join(input.destination, "maintenance-receipt.json"), `${JSON.stringify(receipt)}\n`);
  await verifyInventory(input.destination, manifestSha256, false);
  await durableFile(join(input.destination, "MAINTENANCE_COMMITTED"), `${manifestSha256}\n`);
  await syncDir(input.destination); await syncDir(dirname(input.destination));
  return { manifestSha256, receiptPath: join(input.destination, "MAINTENANCE_COMMITTED") };
}

/** Exact immutable payload and raw inventory verification. */
export async function verifyPrivateColdMaintenance(directory: string, expectedSha256: string): Promise<ColdManifest> {
  return verifyInventory(directory, expectedSha256, true);
}
async function verifyInventory(directory: string, expectedSha256: string,
  committed: boolean): Promise<ColdManifest> {
  if (!validDigest(expectedSha256) || !isAbsolute(directory) || !basename(directory).startsWith("cold-maintenance-"))
    fail("verification_scope_invalid");
  await exactDirectory(dirname(directory));
  await noSymlinkPath(dirname(directory), directory, "directory");
  const top = (await readdir(directory)).sort();
  if (JSON.stringify(top) !== JSON.stringify([...(committed ? ["MAINTENANCE_COMMITTED"] : []), "maintenance-manifest.json", "maintenance-receipt.json", "payload", "raw"].sort()))
    fail("unexpected_payload");
  if (committed) {
    await noSymlinkPath(directory, join(directory, "MAINTENANCE_COMMITTED"), "file");
    const marker = await readBounded(join(directory, "MAINTENANCE_COMMITTED"), 65);
    if (marker.toString("utf8") !== `${expectedSha256}\n`) fail("partial_or_tampered");
  }
  await noSymlinkPath(directory, join(directory, "maintenance-manifest.json"), "file");
  const manifestBytes = await readBounded(join(directory, "maintenance-manifest.json"), MAX_METADATA);
  if (digest(manifestBytes) !== expectedSha256) fail("partial_or_tampered");
  await noSymlinkPath(directory, join(directory, "maintenance-receipt.json"), "file");
  let receipt: Record<string, unknown>;
  try { receipt = JSON.parse((await readBounded(join(directory, "maintenance-receipt.json"), MAX_METADATA)).toString("utf8")) as Record<string, unknown>; }
  catch { fail("receipt_invalid"); }
  let manifest: ColdManifest;
  try { manifest = JSON.parse(manifestBytes.toString("utf8")) as ColdManifest; }
  catch { fail("manifest_invalid"); }
  if (manifest.version !== 1 || manifest.kind !== "inert_cold_maintenance" ||
      !/^[A-Za-z0-9_-]{1,80}$/.test(manifest.selectedJobId) ||
      !Array.isArray(manifest.files) || manifest.files.length < 1 || manifest.files.length > MAX_FILES)
    fail("manifest_invalid");
  if (receipt.kind !== "inert_cold_maintenance_receipt" ||
      receipt.selectedJobId !== manifest.selectedJobId || receipt.manifestSha256 !== expectedSha256 ||
      receipt.currentSelectedJobOnly !== true || receipt.historicalTreesExcluded !== true ||
      receipt.routingDisabled !== true || receipt.resumabilityClaim !== false) fail("receipt_invalid");
  const roles = new Set<string>();
  const roleKinds = new Map<string, "sqlite" | "artifact">();
  let total = 0;
  const expectedPayload: string[] = [];
  for (const file of manifest.files) {
    if (!file || roles.has(file.role) || !(file.kind === "sqlite" ? dbRoles.has(file.role) &&
      (file.probe === undefined || validProbe(file.probe)) :
      file.kind === "artifact" && artifactRole.test(file.role) && file.probe === undefined) ||
      file.storedPath !== `payload/${file.role}${file.kind === "sqlite" ? ".sqlite" : ".data"}` ||
      !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !validDigest(file.sha256)) fail("manifest_invalid");
    roles.add(file.role);
    roleKinds.set(file.role, file.kind);
    expectedPayload.push(basename(file.storedPath));
    total += file.bytes;
    if (total > MAX_BYTES) fail("limit_exceeded");
    const path = join(directory, file.storedPath);
    await noSymlinkPath(directory, path, "file");
    const bytes = await readBounded(path, file.bytes);
    if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) fail("payload_tampered");
    if (file.kind === "sqlite") await sqliteCheck(path, file.probe);
  }
  if (JSON.stringify((await readdir(join(directory, "payload"))).sort()) !== JSON.stringify(expectedPayload.sort()))
    fail("unexpected_payload");
  if (!Array.isArray(manifest.rawFiles) || manifest.rawFiles.length < manifest.files.length ||
      manifest.rawFiles.length > MAX_FILES * 3) fail("manifest_invalid");
  const rawNames = new Set<string>();
  let rawTotal = 0;
  for (const file of manifest.rawFiles) {
    const role = typeof file?.name === "string" ? file.name.replace(/-(wal|shm)$/, "") : undefined;
    if (!file || rawNames.has(file.name) || !role || !roles.has(role) ||
        (file.name !== role && roleKinds.get(role) !== "sqlite") ||
        !/^[A-Za-z_0-9-]+$/.test(file.name) || !Number.isSafeInteger(file.bytes) ||
        file.bytes < 0 || !validDigest(file.sha256)) fail("manifest_invalid");
    rawNames.add(file.name);
    rawTotal += file.bytes;
    if (rawTotal > MAX_BYTES) fail("limit_exceeded");
    const path = join(directory, "raw", file.name);
    await noSymlinkPath(directory, path, "file");
    const bytes = await readBounded(path, file.bytes);
    if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) fail("payload_tampered");
  }
  if ([...roles].some((role) => !rawNames.has(role))) fail("manifest_invalid");
  if (JSON.stringify((await readdir(join(directory, "raw"))).sort()) !== JSON.stringify([...rawNames].sort()))
    fail("unexpected_payload");
  return manifest;
}
