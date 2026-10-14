#!/usr/bin/env node
import { constants } from "node:fs";
import { lstat, open, readFile, realpath, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { dependencyToolGuestConfigPath, dependencyToolPins, DependencyToolOperation, DependencyToolTransformCache,
  parseDependencyToolGuestConfig, type DependencyToolGuestConfig } from "../../core/dependency-environment/dependency-tool-profile";

/** The capsule configures an already admitted descendant. It grants nothing.
 * Rooted provider construction/final owner fence remains authoritative.
 */
export async function runConfigFreeDependencyTool(operation: DependencyToolOperation): Promise<void> {
  if (process.platform !== "linux" || process.execArgv.length !== 0 || process.env.NODE_OPTIONS || process.env.NODE_PATH) fail();
  const config = await readConfig();
  const workspace = config.workspace.canonicalPath, tree = join(workspace, "node_modules");
  const cache = config.profile.cache.canonicalPath;
  const workspaceStat = await lstat(workspace, { bigint: true }), treeStat = await lstat(tree, { bigint: true }), cacheStat = await lstat(cache, { bigint: true });
  if (!workspaceStat.isDirectory() || !treeStat.isDirectory() || !cacheStat.isDirectory() ||
      String(workspaceStat.dev) !== config.workspace.dev || String(workspaceStat.ino) !== config.workspace.ino ||
      String(treeStat.dev) !== config.tree.dev || String(treeStat.ino) !== config.tree.ino ||
      String(cacheStat.dev) !== config.profile.cache.dev || String(cacheStat.ino) !== config.profile.cache.ino ||
      await realpath(workspace) !== workspace || await realpath(tree) !== tree || await realpath(cache) !== cache) fail();
  const mountInfo = await readFile("/proc/self/mountinfo", "utf8");
  requireMountMode(mountInfo, tree, "ro"); requireMountMode(mountInfo, cache, "rw");
  const tmp = join(cache, "tmp");
  for (const path of [tmp, join(cache, "vite"), join(cache, "transforms")]) {
    if (!(await lstat(path)).isDirectory() || await realpath(path) !== path) fail();
  }
  // Standard temporary placement is fixed before any Vitest import.
  process.env.TMPDIR = tmp;
  // Cache-only serialization, never dependency admission/immutable-byte proof.
  // Crash residue is retained; no PID/TTL recovery or deletion of another lock.
  const lockPath = join(cache, ".n3-tool-invocation.lock"), lock = await open(lockPath, "wx", 0o600);
  try { await executeConfiguredTool(operation, config); }
  finally {
    try {
      const own = await lock.stat({ bigint: true }), named = await lstat(lockPath, { bigint: true });
      if (!named.isFile() || named.nlink !== 1n || named.dev !== own.dev || named.ino !== own.ino) fail();
      await unlink(lockPath);
    } finally { await lock.close(); }
  }
}
async function executeConfiguredTool(operation: DependencyToolOperation, config: DependencyToolGuestConfig): Promise<void> {
  const workspace = config.workspace.canonicalPath, tree = join(workspace, "node_modules"), cache = config.profile.cache.canonicalPath;
  const fixtureRequire = createRequire(join(tree, "__n3_tool_resolver__.cjs"));
  const resolveTool = async (name: string): Promise<string> => {
    const resolved = await realpath(fixtureRequire.resolve(name));
    if (!resolved.startsWith(tree + "/")) fail();
    return pathToFileURL(resolved).href;
  };
  // Tool bytes have already been authenticated before provider exposure and
  // remain OS read-only. Config/metadata here do not pretend to attest them.
  if (operation === DependencyToolOperation.Optimize) {
    const vite: typeof import("vite") = await import(await resolveTool("vite"));
    if (vite.version !== dependencyToolPins.vite) fail();
    const resolved = await vite.resolveConfig({ root: workspace, configFile: false, envDir: false, cacheDir: join(cache, "vite"),
      optimizeDeps: { entries: [], include: [...config.profile.optimizerDependencies], noDiscovery: true } }, "serve");
    const metadata = await vite.optimizeDeps(resolved);
    const bundles: string[] = [];
    for (const dependency of config.profile.optimizerDependencies) {
      const item = metadata.optimized[dependency]; if (!item) fail();
      const bundle = await realpath(item.file);
      if (!bundle.startsWith(join(cache, "vite", "deps") + "/") || (await readFile(bundle)).length === 0) fail();
      bundles.push(bundle);
    }
    report({ operation, vite: vite.version, bundles });
    return;
  }
  if (operation !== DependencyToolOperation.Test) fail();
  for (const file of config.profile.testFiles) {
    const path = join(workspace, file);
    if (!(await lstat(path)).isFile() || await realpath(path) !== path || !path.startsWith(workspace + "/")) fail();
  }
  const vitest: typeof import("vitest/node") = await import(await resolveTool("vitest/node"));
  const ctx = await vitest.createVitest("test", { root: workspace, config: false, run: true, watch: false,
    environment: "node", include: [...config.profile.testFiles], pool: "forks", maxWorkers: 1, fileParallelism: false,
    coverage: { enabled: false }, experimental: { fsModuleCache: config.profile.transformCache === DependencyToolTransformCache.Persisted,
      fsModuleCachePath: join(cache, "transforms") } },
  { root: workspace, cacheDir: join(cache, "vite"), envDir: false, server: { watch: null } });
  let testCount = 0;
  try {
    if (ctx.version !== dependencyToolPins.vitest) fail();
    const result = await ctx.start([...config.profile.testFiles]);
    if (result.unhandledErrors.length || result.testModules.length !== config.profile.testFiles.length) fail();
    const expected = new Set(config.profile.testFiles.map(file => join(workspace, file)));
    for (const module of result.testModules) {
      if (!expected.delete(module.moduleId) || module.state() !== "passed" || !module.ok()) fail();
      const tests = [...module.children.allTests()];
      if (tests.length === 0 || tests.some(test => test.result().state !== "passed")) fail();
      testCount += tests.length;
    }
    if (expected.size || (process.exitCode !== undefined && process.exitCode !== 0)) fail();
  } finally {
    // Tool close is necessary, never supervisor native descendant-drain proof.
    await ctx.close();
  }
  report({ operation, vitest: ctx.version, testCount, transformCache: config.profile.transformCache });
}
export function requireMountMode(mountInfo: string, path: string, mode: "ro" | "rw"): void {
  const matches = mountInfo.trim().split("\n").map(line => line.split(" ")).filter(fields => {
    if (fields.length < 10 || !fields.includes("-")) fail();
    return fields[4]!.replace(/\\([0-7]{3})/g, (_, code: string) => String.fromCharCode(parseInt(code, 8))) === path;
  });
  if (matches.length !== 1 || !matches[0]![5]!.split(",").includes(mode)) fail();
}
async function readConfig(): Promise<DependencyToolGuestConfig> {
  const fd = await open(dependencyToolGuestConfigPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await fd.stat({ bigint: true });
    // Host UID 0 maps to the nonzero guest uid. The immutable root, not this
    // numeric owner field, supplies host principal custody.
    if (!before.isFile() || before.nlink !== 1n || (before.mode & 0o022n) || before.size > 65536n) fail();
    const bytes = await fd.readFile(), after = await fd.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.ctimeNs !== after.ctimeNs || before.mtimeNs !== after.mtimeNs || BigInt(bytes.length) !== before.size) fail();
    const config = parseDependencyToolGuestConfig(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    if (await realpath(process.execPath) !== config.profile.node.path || await realpath(process.argv[1] ?? "") !== config.profile.helper.path ||
        !config.profile.cache.canonicalPath.startsWith(dirname(config.workspace.canonicalPath) + "/tool-cache/")) fail();
    return config;
  } finally { await fd.close(); }
}
function report(facts: Readonly<Record<string, unknown>>): void { process.stdout.write(JSON.stringify({ profile: "vite-vitest-config-free-v1", ...facts }) + "\n"); }
function fail(): never { throw new Error("dependency_tool_execution_unsupported"); }
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const operation = process.argv[2];
    if (process.argv.length !== 3 || !Object.values(DependencyToolOperation).includes(operation as DependencyToolOperation)) fail();
    await runConfigFreeDependencyTool(operation as DependencyToolOperation);
  } catch {
    process.stderr.write("dependency_tool_execution_failed\n"); process.exitCode = 1;
  }
}
