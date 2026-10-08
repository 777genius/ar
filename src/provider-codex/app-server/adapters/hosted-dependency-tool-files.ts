import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DependencyAdmissionError, DependencyAdmissionFailure } from "../../../core/dependency-environment/dependency-owner";
import { dependencyToolCachePath, dependencyToolPins, DependencyToolProfileId, parseDependencyToolProfile,
  parseDependencyToolRegistration, type DependencyToolFile, type DependencyToolProfile,
  type DependencyToolRegistration } from "../../../core/dependency-environment/dependency-tool-profile";

/** Operator-only configuration publication while installation is CLOSED.
 * Actual binding issuer verifies host principal, inventory and fresh enrollment.
 * File qualification does not import active admission/installation adapters.
 */
export function createHostedDependencyToolProfile(jobRootDir: string, registration: DependencyToolRegistration): DependencyToolProfile {
  const parsed = parseDependencyToolRegistration(registration), cachePath = dependencyToolCachePath(jobRootDir);
  for (const path of [join(jobRootDir, "tool-cache"), cachePath, ...["vite", "transforms", "tmp"].map(n => join(cachePath, n))]) {
    mkdirSync(path, { mode: 0o700 });
    const fd = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  assertCacheDirectories(cachePath);
  const cache = lstatSync(cachePath, { bigint: true });
  assertHelperPackageScope();
  const readonlyFiles = expectedHelperPaths().map(trustedFile);
  const helper = readonlyFiles[0]; if (!helper) fail();
  return parseDependencyToolProfile({ version: 1, profileId: DependencyToolProfileId.ViteVitestConfigFreeV1,
    pins: dependencyToolPins, ...parsed, cache: { canonicalPath: cachePath, dev: String(cache.dev), ino: String(cache.ino) },
    node: trustedFile(realpathSync(process.execPath)), helper, readonlyFiles });
}

export function assertHostedDependencyToolProfileFiles(profile: DependencyToolProfile, jobRootDir: string): void {
  assertHelperPackageScope();
  const expected = expectedHelperPaths();
  if (profile.readonlyFiles.length !== 7 || profile.cache.canonicalPath !== dependencyToolCachePath(jobRootDir) || profile.node.path !== realpathSync(process.execPath) ||
      profile.helper.path !== expected[0] || profile.readonlyFiles.some((f, i) => f.path !== expected[i] || trustedFile(f.path).sha256 !== f.sha256) ||
      trustedFile(profile.node.path).sha256 !== profile.node.sha256) fail();
  assertCacheDirectories(profile.cache.canonicalPath);
  const cache = lstatSync(profile.cache.canonicalPath, { bigint: true });
  if (String(cache.dev) !== profile.cache.dev || String(cache.ino) !== profile.cache.ino) fail();
}

function assertCacheDirectories(path: string): void {
  // --map-user=65532 maps initial host UID0 to inner UID65532. Kernel file
  // ownership remains UID0; the fixed dropped-capability recipe changes no
  // host file owners. The root-private parent still protects leaf replacement.
  trustedDirectory(dirname(path));
  const parent = lstatSync(dirname(path));
  if ((parent.mode & 0o777) !== 0o700) fail();
  const leaf = lstatSync(path, { bigint: true });
  for (const directory of [path, ...["vite", "transforms", "tmp"].map(name => join(path, name))]) {
    const s = lstatSync(directory, { bigint: true });
    if (!s.isDirectory() || s.uid !== 0n || s.gid !== 0n || (s.mode & 0o777n) !== 0o700n ||
        s.dev !== leaf.dev || realpathSync(directory) !== directory) fail();
  }
  for (const line of readFileSync("/proc/self/mountinfo", "utf8").trim().split("\n")) {
    const fields = line.split(" "); if (fields.length < 10 || !fields.includes("-")) fail();
    const point = fields[4]!.replace(/\\([0-7]{3})/g, (_, code: string) => String.fromCharCode(parseInt(code, 8)));
    if (point === path || point.startsWith(path + "/")) fail();
  }
}

export function expectedHelperPaths(): readonly string[] {
  return ["../../../worker-local/dependency-environment/config-free-tool-entry.js", "../../../core/dependency-environment/dependency-tool-profile.js",
    "../../../worker-codex/hosted-global-scan-pre-tool-hook.js", "../../../worker-codex/hosted-global-scan-hook-policy.js", "../../../worker-codex/code-mode-exec-command-parser.js",
    "../../../worker-core/host-command/global-filesystem-scan-policy.js", "../../../../package.json"].map(p => fileURLToPath(new URL(p, import.meta.url)));
}
function assertHelperPackageScope(): void {
  const paths = expectedHelperPaths(), metadata = paths[6]; if (!metadata) fail();
  trustedFile(metadata);
  const value: unknown = JSON.parse(readFileSync(metadata, "utf8"));
  if (!value || typeof value !== "object" || !("type" in value) || value.type !== "module") fail();
  const root = dirname(metadata);
  for (const js of paths.slice(0, 6)) {
    if (!js.startsWith(root + "/dist/")) fail();
    // Node selects the nearest package scope, not merely any ancestor JSON.
    for (let directory = dirname(js); directory !== root; directory = dirname(directory)) {
      try { lstatSync(join(directory, "package.json")); fail(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }
}
export function trustedFile(path: string): DependencyToolFile {
  trustedDirectory(dirname(path));
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.uid !== 0n || before.nlink !== 1n || (before.mode & 0o022n) || before.size > 256n * 1024n * 1024n || realpathSync(path) !== path) fail();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes: Buffer;
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino ||
        opened.ctimeNs !== before.ctimeNs || opened.mtimeNs !== before.mtimeNs) fail();
    bytes = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    if (after.dev !== before.dev || after.ino !== before.ino || after.ctimeNs !== before.ctimeNs || after.mtimeNs !== before.mtimeNs) fail();
  } finally { closeSync(fd); }
  const after = lstatSync(path, { bigint: true });
  if (before.dev !== after.dev || before.ino !== after.ino || before.ctimeNs !== after.ctimeNs || before.mtimeNs !== after.mtimeNs || BigInt(bytes.length) !== before.size) fail();
  return { path, sha256: createHash("sha256").update(bytes).digest("hex") };
}
function trustedDirectory(path: string): void {
  for (let p = path;; p = dirname(p)) {
    const stat = lstatSync(p);
    if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022) || realpathSync(p) !== p) fail();
    if (p === "/") break;
  }
}
function fail(): never { throw new DependencyAdmissionError(DependencyAdmissionFailure.Unsupported); }
