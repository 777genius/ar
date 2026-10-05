import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, open, readFile, readdir, readlink, realpath } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { observeDependencyDirectoryRoot } from "../../dist/worker-local/dependency-environment/observe-dependency-tree.js";
import { DependencyTreeObservationStatus } from "../../dist/worker-core/dependency-environment/domain/dependency-tree-manifest.js";
import { DependencyInstallArchitecture, DependencyLibcFamily, DependencyToolRootKind,
  type DependencyTestNpmToolchain } from "../../dist/worker-core/dependency-environment/domain/dependency-install-key.js";

const exec = promisify(execFile);
export const sha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
export type CommandFact = { purpose: string; status: number | null; completed: boolean; elapsedMs: number };
export const commandFacts: CommandFact[] = [];
export async function command(file: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv,
  purpose: string, timeout = 120000): Promise<string> {
  const started = Date.now();
  try {
    const result = await exec(file, [...args], { cwd, env, encoding: "utf8", timeout, maxBuffer: 1024 * 1024 });
    commandFacts.push({ purpose, status: 0, completed: true, elapsedMs: Date.now() - started });
    return result.stdout.trim();
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    const killed = error && typeof error === "object" && "killed" in error ? error.killed : undefined;
    commandFacts.push({ purpose, status: typeof code === "number" ? code : null,
      completed: typeof code === "number" && killed !== true, elapsedMs: Date.now() - started });
    // Do not retain npm output, inherited environment or arbitrary child errors.
    throw new Error(`TEST_command_failed:${purpose}`);
  }
}
export async function fileHash(path: string): Promise<string> {
  const handle = await open(path, "r"), before = await handle.stat({ bigint: true });
  try {
    assert(before.isFile() && before.size <= 256n * 1024n * 1024n);
    const hash = createHash("sha256"), buffer = Buffer.alloc(65536); let offset = 0;
    while (true) {
      const read = await handle.read(buffer, 0, buffer.length, offset);
      if (!read.bytesRead) break;
      offset += read.bytesRead; assert(BigInt(offset) <= before.size);
      hash.update(buffer.subarray(0, read.bytesRead));
    }
    const after = await handle.stat({ bigint: true });
    assert.equal(BigInt(offset), before.size);
    for (const field of ["dev", "ino", "mode", "size", "mtimeNs", "ctimeNs"] as const)
      assert.equal(after[field], before[field]);
    return hash.digest("hex");
  } finally { await handle.close(); }
}
export type Entry = { path: string; kind: "file" | "directory" | "symlink"; mode: number;
  dev: string; ino: string; sha256?: string; target?: string };
// Only the deliberately generated root node_modules is excluded from original
// preservation. Every other name, including all Git and sentinel entries, stays.
export async function inventory(root: string, excludeRootNodeModules = false): Promise<Entry[]> {
  const rows: Entry[] = [], started = Date.now(); let bytes = 0n;
  async function visit(path: string): Promise<void> {
    assert(rows.length < 5000 && Date.now() - started < 30000);
    const stat = await lstat(path, { bigint: true }), logical = relative(root, path);
    const common = { path: logical, mode: Number(stat.mode & 0o7777n), dev: String(stat.dev), ino: String(stat.ino) };
    if (stat.isDirectory()) {
      rows.push({ ...common, kind: "directory" });
      for (const name of (await readdir(path)).sort()) {
        if (path === root && excludeRootNodeModules && name === "node_modules") continue;
        await visit(join(path, name));
      }
    } else if (stat.isSymbolicLink()) rows.push({ ...common, kind: "symlink", target: await readlink(path) });
    else {
      assert(stat.isFile() && stat.nlink === 1n); bytes += stat.size; assert(bytes <= 16n * 1024n * 1024n);
      rows.push({ ...common, kind: "file", sha256: await fileHash(path) });
    }
  }
  await visit(root); return rows;
}
export async function absent(path: string): Promise<void> {
  await assert.rejects(lstat(path), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT"));
}
export async function observeTools(npmRootInput: string, cwd: string, env: NodeJS.ProcessEnv): Promise<DependencyTestNpmToolchain> {
  const nodePath = await realpath(process.execPath), npmRootPath = await realpath(npmRootInput);
  assert.match(nodePath, /^\/(?:usr|opt)\//); assert.match(npmRootPath, /^\/(?:usr|opt)\//);
  const npmCliPath = join(npmRootPath, "bin/npm-cli.js"); assert.equal(await realpath(npmCliPath), npmCliPath);
  assert.equal(await command(nodePath, [npmCliPath, "--version"], cwd, env, "npm_version"), "10.9.9");
  const npmPackage: unknown = JSON.parse(await readFile(join(npmRootPath, "package.json"), "utf8"));
  assert(npmPackage && typeof npmPackage === "object" && "version" in npmPackage && npmPackage.version === "10.9.9");
  const tree = await observeDependencyDirectoryRoot({ parentPath: dirname(npmRootPath), name: "npm",
    limits: { maxEntries: 50000, maxTotalBytes: 128 * 1024 * 1024, maxManifestBytes: 16 * 1024 * 1024, maxDurationMs: 60000 } });
  assert.equal(tree.status, DependencyTreeObservationStatus.Complete);
  if (tree.status !== DependencyTreeObservationStatus.Complete) throw new Error("TEST_npm_inventory_incomplete");
  const ldd = await command("/usr/bin/ldd", [nodePath], cwd, env, "node_elf_libraries", 30000);
  const libraries = new Set<string>();
  for (const match of ldd.matchAll(/(?:=>\s+|^\s*)(\/[^\s]+)\s+\(/gm)) {
    const raw = match[1]; assert(raw);
    const path = await realpath(raw); assert(path.startsWith("/usr/lib/")); libraries.add(path);
  }
  assert(libraries.size > 0 && libraries.size <= 32);
  const toolRoots = await Promise.all([...libraries].sort().map(async (path): Promise<DependencyTestNpmToolchain["toolRoots"][number]> => ({ path,
    sha256: await fileHash(path), kind: DependencyToolRootKind.File })));
  const libc = toolRoots.find(root => /\/libc\.so\.6$/.test(root.path)); assert(libc);
  const version = await command("/usr/bin/getconf", ["GNU_LIBC_VERSION"], cwd, env, "glibc_version", 30000);
  const libcVersion = /^glibc ([0-9]+\.[0-9]+)$/.exec(version)?.[1]; assert(libcVersion);
  const nodeAbi = process.versions.modules; assert(nodeAbi && /^[1-9]\d*$/.test(nodeAbi));
  return { nodePath, nodeSha256: await fileHash(nodePath), nodeVersion: process.version,
    nodeAbi, platform: "linux", arch: DependencyInstallArchitecture.X64,
    npmCliPath, npmSha256: await fileHash(npmCliPath), npmVersion: "10.9.9", npmRootPath,
    npmRootSha256: tree.digest, libc: { family: DependencyLibcFamily.Glibc, version: libcVersion,
      path: libc.path, sha256: libc.sha256 }, toolRoots };
}
