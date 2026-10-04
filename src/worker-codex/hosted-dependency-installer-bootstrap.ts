import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Fixed unprivileged contained payload. It has no launch/store authority and
 * reads only its readonly closed profile plus package/lock staging mounts. */
const profile = JSON.parse(readFileSync("/runtime/profile.json", "utf8")) as {
  nodePath: string; npmCliPath: string; nodeVersion: string; npmVersion: string; stagingDirectory: string; installArgv: string[];
  nodeAbi: string; platform: string; arch: string; environment: Record<string, string>; umask: number;
};
process.umask(profile.umask);
const env = profile.environment;
if (process.versions.modules !== profile.nodeAbi || process.platform !== profile.platform || process.arch !== profile.arch) process.exit(71);
function run(args: readonly string[]): { status: number | null; stdout: string } {
  const r = spawnSync(profile.nodePath, args, { cwd: profile.stagingDirectory, env, encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"], timeout: 10 * 60 * 1000, maxBuffer: 2 * 1024 * 1024 });
  if (r.error || r.signal) process.exit(70);
  return { status: r.status, stdout: r.stdout };
}
const node = run(["--version"]), npm = run([profile.npmCliPath, "--version"]);
if (node.status !== 0 || npm.status !== 0 || node.stdout.trim() !== profile.nodeVersion || npm.stdout.trim() !== profile.npmVersion) process.exit(71);
const install = run([profile.npmCliPath, ...profile.installArgv]);
if (install.status !== 0) process.exit(72);
// Graph verification runs in the same contained lifetime; receipt/capability and
// full manifest verification remain the final parent admission responsibility.
const graph = run([profile.npmCliPath, "ls", "--depth=0", "--json", "--ignore-scripts"]);
process.exit(graph.status === 0 ? 0 : 73);
