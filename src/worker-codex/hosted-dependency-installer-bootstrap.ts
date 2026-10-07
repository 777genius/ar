import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, writeSync } from "node:fs";

/** Fixed unprivileged contained payload. It has no launch/store authority and
 * reads only its readonly closed profile plus package/lock staging mounts. */
const groups = process.getgroups?.(); // Node appends effective GID to this API.
if (process.getuid?.() !== 65532 || process.geteuid?.() !== 65532 || process.getgid?.() !== 65532 || process.getegid?.() !== 65532 ||
    !groups || groups.length !== 1 || groups[0] !== 65532) process.exit(74);
enum LockName { PackageLock = "package-lock.json", Shrinkwrap = "npm-shrinkwrap.json" }
const profile = JSON.parse(readFileSync("/runtime/profile.json", "utf8")) as {
  nodePath: string; npmCliPath: string; nodeVersion: string; npmVersion: string; stagingDirectory: string; installArgv: string[];
  nodeAbi: string; platform: string; arch: string; environment: Record<string, string>; umask: number;
  lockName: LockName; inputSha256: string;
};
process.umask(profile.umask);
const env = profile.environment;
// The protected finite plan binds exactly the selected lock leaf readonly.
// Refuse relabeling or an extra npm precedence/config input before npm starts.
if (!Object.values(LockName).includes(profile.lockName)) process.exit(75);
for (const name of [profile.lockName === LockName.Shrinkwrap ? LockName.PackageLock : LockName.Shrinkwrap, ".npmrc"]) {
  try { lstatSync(`${profile.stagingDirectory}/${name}`); process.exit(75); }
  catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") process.exit(75);
  }
}
function inputBytes(name: string): Buffer {
  const path = `${profile.stagingDirectory}/${name}`, stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size <= 0 || stat.size > 8 * 1024 * 1024 || (stat.mode & 0o022)) process.exit(75);
  const bytes = readFileSync(path);
  if (bytes.length !== stat.size) process.exit(75);
  return bytes;
}
const packageBytes = inputBytes("package.json"), lockBytes = inputBytes(profile.lockName);
const inputSha256 = createHash("sha256").update(String(Buffer.byteLength(profile.lockName)) + ":").update(profile.lockName)
  .update(String(packageBytes.length) + ":").update(packageBytes).update(String(lockBytes.length) + ":").update(lockBytes).digest("hex");
if (inputSha256 !== profile.inputSha256) process.exit(75);
enum PreflightStage { RuntimeIdentity = "runtime_identity", ToolVersions = "tool_versions" }
function refusePreflight(stage: PreflightStage, facts: Readonly<Record<string, boolean | number | null>>): never {
  try { writeSync(2, "dependency_installer_preflight_v1 " + JSON.stringify({ stage, ...facts }) + "\n"); }
  finally { process.exit(71); }
}
const runtime = { abiMatch: process.versions.modules === profile.nodeAbi, platformMatch: process.platform === profile.platform, archMatch: process.arch === profile.arch };
if (!runtime.abiMatch || !runtime.platformMatch || !runtime.archMatch) refusePreflight(PreflightStage.RuntimeIdentity, runtime);
function run(args: readonly string[]): { status: number | null; stdout: string; duplicateConfig: boolean } {
  const r = spawnSync(profile.nodePath, args, { cwd: profile.stagingDirectory, env, encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"], timeout: 10 * 60 * 1000, maxBuffer: 2 * 1024 * 1024 });
  if (r.error || r.signal) process.exit(70);
  return { status: r.status, stdout: r.stdout, duplicateConfig: r.stderr.includes("double-loading config") };
}
const node = run(["--version"]), npm = run([profile.npmCliPath, "--version"]);
const versions = { nodeStatus: node.status, npmStatus: npm.status, nodeVersionMatch: node.stdout.trim() === profile.nodeVersion,
  npmVersionMatch: npm.stdout.trim() === profile.npmVersion, duplicateConfig: npm.duplicateConfig };
if (node.status !== 0 || npm.status !== 0 || !versions.nodeVersionMatch || !versions.npmVersionMatch) refusePreflight(PreflightStage.ToolVersions, versions);
const install = run([profile.npmCliPath, ...profile.installArgv]);
if (install.status !== 0) process.exit(72);
// Graph verification runs in the same contained lifetime; receipt/capability and
// full manifest verification remain the final parent admission responsibility.
const graph = run([profile.npmCliPath, "ls", "--depth=0", "--json", "--ignore-scripts"]);
process.exit(graph.status === 0 ? 0 : 73);
