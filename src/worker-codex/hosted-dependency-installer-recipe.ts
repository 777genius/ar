import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync,
  realpathSync, readdirSync, symlinkSync, writeFileSync, chownSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertReadonlyHostOperator, decodePrivateJson } from "./hosted-readonly-authority";
import { readHostedPrivateBytes } from "./hosted-readonly-inputs";
import { readonlySupervisorRoot } from "./hosted-readonly-custody";
import { hostedDependencyInstallerArgv, type HostedDependencyInstallerInputs } from "./hosted-dependency-installer-inputs";
import { hostedDependencyInstallerUid } from "./hosted-dependency-installer-identity";
import { DependencyInstallArchitecture, DependencyLibcFamily, DependencyToolRootKind, dependencyTestNpmConfig, dependencyTestNpmEnvironment, dependencyTestNpmUmask,
  type DependencyTestNpmToolchain } from "../worker-core/dependency-environment/domain/dependency-install-key";
import { encodeDependencyTreeManifest, DependencyManifestEntryKind as Kind, type DependencyManifestEntry } from "../worker-core/dependency-environment/domain/dependency-tree-manifest";

export const hostedDependencyInstallerRoot = join(readonlySupervisorRoot, "dependency-installers");
export type HostedDependencyInstallerProfile = DependencyTestNpmToolchain & { readonly schemaVersion: 1 };
const plans = new WeakMap<object, string>();
export type HostedDependencyInstallerPlan = Readonly<{ startId: string; directory: string; rootDirectory: string;
  stagingDirectory: string; inputSha256: string; profile: HostedDependencyInstallerProfile }>;
const fail = (): never => { throw new Error("dependency_installer_recipe_unsupported"); };
export function installerPath(value: string): string {
  if (!/^\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/.test(value) ||
      value.split("/").some(p => p === "." || p === "..")) fail();
  return value;
}
function trustedFile(path: string, expected?: string): Buffer {
  installerPath(path);
  for (let parent = dirname(path);; parent = dirname(parent)) {
    const stat = lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022)) fail();
    if (parent === "/") break;
  }
  const before = lstatSync(path);
  if (!before.isFile() || before.uid !== 0 || before.nlink !== 1 || (before.mode & 0o022)) fail();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd), bytes = readFileSync(fd), after = lstatSync(path);
    if (opened.dev !== before.dev || opened.ino !== before.ino || after.dev !== before.dev || after.ino !== before.ino ||
        after.ctimeMs !== before.ctimeMs || after.size !== before.size || (expected && createHash("sha256").update(bytes).digest("hex") !== expected)) fail();
    return bytes;
  } finally { closeSync(fd); }
}
/** Content pin for the qualified bundled npm tree. The host profile issuer uses
 * these same canonical bytes; incomplete bounds, mounts or external links fail.
 */
export function hostedDependencyInstallerNpmRootSha256(root: string): string {
  installerPath(root); const facts: DependencyManifestEntry[] = []; let count = 0, bytes = 0;
  const deadline = performance.now() + 10_000;
  if (realpathSync(root) !== root) fail();
  const mounts = readFileSync("/proc/self/mountinfo", "utf8").split("\n");
  if (mounts.some(line => { const mounted = line.split(" ")[4]; return mounted === root || mounted?.startsWith(root + "/"); })) fail();
  const walk = (path: string): void => {
    if (++count > 100_000 || performance.now() > deadline) fail();
    const before = lstatSync(path), relative = path.slice(root.length).split("/").filter(Boolean).map(n => Buffer.from(n).toString("base64"));
    const mode = before.mode & 0o7777;
    if (before.uid !== 0 || (!before.isSymbolicLink() && (before.mode & 0o022)) || before.nlink < 1) fail();
    if (before.isSymbolicLink()) {
      const resolved = realpathSync(path); if (!resolved.startsWith(root + "/")) fail();
      facts.push({ path: relative, kind: Kind.Symlink, mode, target: Buffer.from(readlinkSync(path)).toString("base64") });
    } else if (before.isFile()) {
      if (before.nlink !== 1 || (bytes += before.size) > 512 * 1024 * 1024) fail();
      facts.push({ path: relative, kind: Kind.File, mode, size: String(before.size), sha256: createHash("sha256").update(trustedFile(path)).digest("hex") });
    } else if (before.isDirectory()) {
      const names = readdirSync(path).sort(); facts.push({ path: relative, kind: Kind.Directory, mode });
      for (const name of names) { installerPath(join(path, name)); walk(join(path, name)); }
      if (JSON.stringify(names) !== JSON.stringify(readdirSync(path).sort())) fail();
    } else fail();
    const after = lstatSync(path);
    if (after.dev !== before.dev || after.ino !== before.ino || after.ctimeMs !== before.ctimeMs || after.mtimeMs !== before.mtimeMs || performance.now() > deadline) fail();
  };
  walk(root); return createHash("sha256").update(encodeDependencyTreeManifest(facts)).digest("hex");
}
export function readHostedDependencyInstallerProfile(): HostedDependencyInstallerProfile {
  assertReadonlyHostOperator();
  const bytes = readHostedPrivateBytes(join(readonlySupervisorRoot, "dependency-installer-profile.json"), 4096);
  if (!bytes) fail();
  const v = decodePrivateJson(bytes) as HostedDependencyInstallerProfile;
  if (!v || Object.keys(v).sort().join(",") !== "arch,libc,nodeAbi,nodePath,nodeSha256,nodeVersion,npmCliPath,npmRootPath,npmRootSha256,npmSha256,npmVersion,platform,schemaVersion,toolRoots" ||
      v.schemaVersion !== 1 || ![v.nodeSha256, v.npmSha256].every(s => typeof s === "string" && /^[a-f0-9]{64}$/.test(s)) ||
      typeof v.nodeVersion !== "string" || !/^v\d+\.\d+\.\d+$/.test(v.nodeVersion) ||
      typeof v.npmVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(v.npmVersion) ||
      typeof v.nodePath !== "string" || !/^\/(?:usr|opt)\//.test(v.nodePath) ||
      typeof v.npmCliPath !== "string" || !/^\/(?:usr|opt)\/.+\/npm\/bin\/npm-cli\.js$/.test(v.npmCliPath) || realpathSync(v.nodePath) !== v.nodePath ||
      realpathSync(v.npmCliPath) !== v.npmCliPath || v.platform !== "linux" || v.arch !== DependencyInstallArchitecture.X64 ||
      typeof v.nodeAbi !== "string" || !/^[1-9][0-9]*$/.test(v.nodeAbi) || v.npmRootPath !== dirname(dirname(v.npmCliPath)) ||
      typeof v.npmRootSha256 !== "string" || !/^[a-f0-9]{64}$/.test(v.npmRootSha256) ||
      !v.libc || Object.keys(v.libc).sort().join(",") !== "family,path,sha256,version" || v.libc.family !== DependencyLibcFamily.Glibc ||
      !/^[0-9]+\.[0-9]+$/.test(v.libc.version) || !/^[a-f0-9]{64}$/.test(v.libc.sha256) ||
      !Array.isArray(v.toolRoots) || v.toolRoots.length < 1 || v.toolRoots.length > 32) fail();
  trustedFile(v.nodePath, v.nodeSha256); trustedFile(v.npmCliPath, v.npmSha256);
  for (const library of v.toolRoots) {
    if (!library || Object.keys(library).sort().join(",") !== "kind,path,sha256" || library.kind !== DependencyToolRootKind.File ||
        typeof library.path !== "string" || !library.path.startsWith("/usr/lib/") || !/^[a-f0-9]{64}$/.test(library.sha256) || realpathSync(library.path) !== library.path) fail();
    trustedFile(library.path, library.sha256);
  }
  if (new Set(v.toolRoots.map(l => l.path)).size !== v.toolRoots.length ||
      !v.toolRoots.some(l => l.sha256 === v.libc.sha256 && l.path === v.libc.path && /\/libc\.so\.[0-9]+$/.test(l.path)) ||
      hostedDependencyInstallerNpmRootSha256(v.npmRootPath) !== v.npmRootSha256) fail();
  return Object.freeze({ ...v });
}
function directory(path: string, mode = 0o700, writable = false): void {
  mkdirSync(path, { mode }); if (writable) chownSync(path, hostedDependencyInstallerUid, hostedDependencyInstallerUid);
}
function snapshot(plan: HostedDependencyInstallerPlan): string {
  const names = [plan.directory, plan.rootDirectory, join(plan.directory, "inputs"), plan.stagingDirectory,
    join(plan.directory, "home"), join(plan.directory, "cache"), join(plan.rootDirectory, "runtime")];
  const facts: unknown[][] = names.map(path => {
    const s = lstatSync(path); if (!s.isDirectory() || s.isSymbolicLink()) fail();
    return [path, s.dev, s.ino, s.uid, s.gid, s.mode];
  });
  for (const parent of new Set(["/usr/lib64", ...plan.profile.toolRoots.map(l => dirname(l.path))])) {
    const local = join(plan.rootDirectory, parent.slice(1));
    for (const name of readdirSync(local).sort()) {
      const path = join(local, name), stat = lstatSync(path);
      facts.push([path, stat.dev, stat.ino, stat.mode, stat.isSymbolicLink() ? readlinkSync(path) : null]);
    }
  }
  for (const path of [join(plan.directory, "inputs/package.json"), join(plan.directory, "inputs/package-lock.json"),
    join(plan.rootDirectory, "runtime/bootstrap.js"), join(plan.rootDirectory, "runtime/package.json"), join(plan.rootDirectory, "runtime/profile.json"), join(plan.rootDirectory, "runtime/npmrc")]) {
    const bytes = trustedFile(path); facts.push([path, createHash("sha256").update(bytes).digest("hex")]);
  }
  return JSON.stringify(facts);
}

/** Called only in the initial trusted namespace after actual owner admission.
 * Root/profile/source bytes are retained before enqueue; nothing guest writable
 * selects an executable or changes mount policy. Private parent is never granted.
 */
export function createHostedDependencyInstallerPlan(startId: string, inputs: HostedDependencyInstallerInputs): HostedDependencyInstallerPlan {
  assertReadonlyHostOperator();
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(startId)) fail();
  const selected = readHostedDependencyInstallerProfile();
  mkdirSync(hostedDependencyInstallerRoot, { recursive: true, mode: 0o700 });
  for (let p = hostedDependencyInstallerRoot;; p = dirname(p)) {
    const s = lstatSync(p); if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== 0 || (s.mode & 0o022) ||
      (p === hostedDependencyInstallerRoot && (s.mode & 0o077))) fail();
    if (p === "/") break;
  }
  const dir = join(hostedDependencyInstallerRoot, startId), root = join(dir, "root"), staging = join(dir, "staging");
  directory(dir); directory(root, 0o755); directory(join(dir, "inputs")); directory(staging, 0o700, true);
  directory(join(dir, "home"), 0o700, true); directory(join(dir, "cache"), 0o700, true);
  for (const relative of ["usr", "etc", "workspace", "home", "cache", "runtime", "dev", "proc", "tmp"])
    directory(join(root, relative), relative === "tmp" ? 0o1777 : 0o755);
  directory(join(root, "home/installer")); directory(join(root, "etc/ssl")); directory(join(root, "etc/ssl/certs"));
  mkdirSync(join(root, staging.slice(1)), { recursive: true, mode: 0o755 });
  for (const target of [dirname(selected.nodePath), selected.npmRootPath, "/usr/lib64", ...selected.toolRoots.map(l => dirname(l.path))]) {
    mkdirSync(join(root, target.slice(1)), { recursive: true, mode: 0o755 });
  }
  writeFileSync(join(root, selected.nodePath.slice(1)), "", { flag: "wx", mode: 0o644 });
  for (const library of selected.toolRoots) writeFileSync(join(root, library.path.slice(1)), "", { flag: "wx", mode: 0o644 });
  // Preserve only SONAME aliases that resolve to a listed exact pinned file.
  // No parent library directory or unrelated sibling is exposed.
  for (const parent of new Set(selected.toolRoots.map(l => dirname(l.path)))) {
    for (const name of readdirSync(parent)) {
      const path = join(parent, name), stat = lstatSync(path);
      if (!stat.isSymbolicLink()) continue;
      if (stat.uid !== 0 || stat.nlink !== 1) fail();
      let resolved: string; try { resolved = realpathSync(path); } catch { continue; }
      if (selected.toolRoots.some(l => l.path === resolved)) symlinkSync(readlinkSync(path), join(root, path.slice(1)));
    }
  }
  const loader = "/usr/lib64/ld-linux-x86-64.so.2", loaderTarget = realpathSync(loader);
  if (!selected.toolRoots.some(l => l.path === loaderTarget) || !lstatSync(loader).isSymbolicLink()) fail();
  symlinkSync(readlinkSync(loader), join(root, loader.slice(1)));
  // Qualified merged-/usr host only; never bind host /etc or /home wholesale.
  for (const name of ["bin", "lib", "lib64", "sbin"]) {
    const host = "/" + name; const stat = lstatSync(host);
    if (!stat.isSymbolicLink() || readlinkSync(host) !== "usr/" + name) fail();
    symlinkSync("usr/" + name, join(root, name));
  }
  for (const name of ["hosts", "resolv.conf", "nsswitch.conf"]) {
    const path = realpathSync("/etc/" + name), bytes = trustedFile(path);
    if (bytes.length > 64 * 1024) fail();
    writeFileSync(join(root, "etc", name), bytes, { flag: "wx", mode: 0o644 });
  }
  for (const [name, bytes] of [["package.json", inputs.packageBytes], ["package-lock.json", inputs.lockBytes]] as const) {
    writeFileSync(join(dir, "inputs", name), bytes, { flag: "wx", mode: 0o644 });
    const fd = openSync(join(dir, "inputs", name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try { fsyncSync(fd); } finally { closeSync(fd); }
    writeFileSync(join(staging, name), "", { flag: "wx", mode: 0o644 });
  }
  const bootstrap = fileURLToPath(new URL("./hosted-dependency-installer-bootstrap.js", import.meta.url));
  const bytes = trustedFile(bootstrap);
  writeFileSync(join(root, "runtime/bootstrap.js"), bytes, { flag: "wx", mode: 0o644 });
  writeFileSync(join(root, "runtime/package.json"), '{"type":"module"}\n', { flag: "wx", mode: 0o644 });
  writeFileSync(join(root, "runtime/profile.json"), JSON.stringify({ ...selected, stagingDirectory: staging, installArgv: hostedDependencyInstallerArgv,
    environment: dependencyTestNpmEnvironment, umask: dependencyTestNpmUmask }), { flag: "wx", mode: 0o644 });
  writeFileSync(join(root, "runtime/npmrc"), dependencyTestNpmConfig, { flag: "wx", mode: 0o644 });
  // The enclosing retained record fsyncs all ancestry; sync payloads as well.
  for (const p of [join(root, "runtime/bootstrap.js"), join(root, "runtime/package.json"), join(root, "runtime/profile.json"), join(root, "runtime/npmrc"),
    ...["hosts", "resolv.conf", "nsswitch.conf"].map(n => join(root, "etc", n))]) {
    const fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW); try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  const plan = Object.freeze({ startId, directory: dir, rootDirectory: root, stagingDirectory: staging,
    inputSha256: inputs.sha256, profile: selected });
  plans.set(plan, snapshot(plan)); return plan;
}
export function assertHostedDependencyInstallerPlan(plan: HostedDependencyInstallerPlan): void {
  assertReadonlyHostOperator();
  if (plans.get(plan) !== snapshot(plan) || JSON.stringify(readHostedDependencyInstallerProfile()) !== JSON.stringify(plan.profile)) fail();
}
export function hostedDependencyInstallerProperties(plan: HostedDependencyInstallerPlan): readonly string[] {
  assertHostedDependencyInstallerPlan(plan);
  return ["Restart=no", `User=${hostedDependencyInstallerUid}`, `Group=${hostedDependencyInstallerUid}`, "NoNewPrivileges=yes", "CapabilityBoundingSet=", "AmbientCapabilities=",
    "Environment=PATH=/usr/bin:/bin LANG=C LC_ALL=C HOME=/home/installer",
    "UnsetEnvironment=NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH OPENSSL_CONF OPENSSL_MODULES NODE_V8_COVERAGE",
    "PrivateDevices=yes", "ProtectSystem=strict", "ProtectHome=yes", "RestrictSUIDSGID=yes", "MountAPIVFS=no",
    "InaccessiblePaths=-/proc -/sys -/run", "RuntimeMaxSec=20min", "TimeoutStopSec=30s", "TasksMax=256", "LimitCORE=0",
    `RootDirectory=${plan.rootDirectory}`, `BindReadOnlyPaths=${plan.profile.nodePath}:${plan.profile.nodePath}:norbind ${plan.profile.npmRootPath}:${plan.profile.npmRootPath}:norbind /etc/ssl/certs:/etc/ssl/certs:norbind`,
    ...plan.profile.toolRoots.map(l => `BindReadOnlyPaths=${l.path}:${l.path}:norbind`),
    `BindPaths=${plan.stagingDirectory}:${plan.stagingDirectory}:norbind ${join(plan.directory, "home")}:/home/installer:norbind ${join(plan.directory, "cache")}:/cache:norbind`,
    `BindReadOnlyPaths=${join(plan.directory, "inputs/package.json")}:${plan.stagingDirectory}/package.json:norbind ${join(plan.directory, "inputs/package-lock.json")}:${plan.stagingDirectory}/package-lock.json:norbind`,
    `ReadWritePaths=${plan.stagingDirectory} /home/installer /cache`, "TemporaryFileSystem=/tmp:rw,nosuid,nodev,mode=1777,size=256M"];
}
