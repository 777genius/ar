import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readFile, readdir, readlink, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { performance } from "node:perf_hooks";

export const pins = { vite: "8.0.16", vitest: "4.1.8", picocolors: "1.1.1" } as const;
export const profile = "TEST-vite8-vitest4-config-free-v1";
export const sentinelNames = [".vite", ".vite-temp", ".experimental", ".experimental-vitest-cache", ".cache"];
export type Registration = {
  version: 1; purpose: "standalone-tool-qualification-only"; profile: typeof profile;
  fixtureRoot: string; workspace: string; nodeModules: string; viteCache: string;
  transformCache: string; tmp: string; trace: string; requestedConfig: false | string;
  sourceLockSha256: string; sourceSha: string;
};
export function sha256(bytes: string | Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
export function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
export async function qualify(registration: Registration): Promise<void> {
  assert.equal(process.platform, "linux", "TEST Linux only");
  assert.equal(process.env.CI, "true", "CI/server qualification only");
  assert.equal(process.env.GITHUB_ACTIONS, "true", "fresh hosted CI runner required");
  assert.equal(registration.version, 1);
  assert.equal(registration.purpose, "standalone-tool-qualification-only");
  assert.equal(registration.profile, profile);
  assert.equal(registration.requestedConfig, false, "unsupported_custom_configuration");
  assert.equal(registration.fixtureRoot, process.env.TEST_REGISTERED_ROOT);
  assert.equal(registration.trace, join(registration.fixtureRoot, "tool-import.trace"));
  assert.match(registration.sourceSha, /^[a-f0-9]{40}$/);
  assert.match(registration.sourceLockSha256, /^[a-f0-9]{64}$/);
  for (const path of [registration.fixtureRoot, registration.workspace, registration.nodeModules,
    registration.viteCache, registration.transformCache, registration.tmp]) {
    assert.equal(await realpath(path), path, "TEST canonical path required");
    assert.ok(inside(registration.fixtureRoot, path), "outside registered TEST filesystem");
    assert.ok((await lstat(path)).isDirectory());
  }
  assert.equal(registration.nodeModules, join(registration.workspace, "node_modules"));
  for (const path of [registration.viteCache, registration.transformCache, registration.tmp]) {
    assert.ok(!inside(registration.nodeModules, path), "cache/tmp cannot be inside target");
    assert.ok(!inside(path, registration.nodeModules), "cache/tmp cannot contain target");
  }
  assert.ok(!inside(registration.viteCache, registration.transformCache)
    && !inside(registration.transformCache, registration.viteCache), "cache leaves must be separate");
  for (const [name, expected] of Object.entries(pins)) {
    const installed: unknown = JSON.parse(await readFile(join(registration.nodeModules, name, "package.json"), "utf8"));
    assert.ok(object(installed));
    assert.equal(installed.version, expected, `unsupported_installed_${name}`);
  }
}

export type TreeEntry = { path: string; type: "directory" | "file" | "symlink"; mode: number; size?: string; sha256?: string; target?: string };
export type TreeSnapshot = { digest: string; entries: TreeEntry[]; fileBytes: string; durationMs: number;
  largestFile: { bytes: string; pathSha256: string | null } };
const maxTotalBytes = 4n * 1024n ** 3n;
export const snapshotBounds = { maxFileBytes: maxTotalBytes.toString(), maxTotalFileBytes: maxTotalBytes.toString(),
  maxEntries: 200_000, maxDurationMs: 180_000, hashBufferBytes: 64 * 1024 } as const;
type BoundDiagnostic = { bound: "file_bytes" | "total_file_bytes" | "entry_count" | "elapsed_ms";
  pathSha256: string; observed: string; limit: string };
export class SnapshotBoundError extends Error {
  readonly diagnostic: BoundDiagnostic;
  constructor(diagnostic: BoundDiagnostic) {
    super(`TEST inventory bound exceeded: ${JSON.stringify(diagnostic)}`);
    this.diagnostic = diagnostic;
  }
}
function sameIdentity(before: BigIntStats, after: BigIntStats): void {
  assert.equal(after.dev, before.dev); assert.equal(after.ino, before.ino);
  assert.equal(after.mode, before.mode); assert.equal(after.nlink, before.nlink);
  assert.equal(after.size, before.size); assert.equal(after.mtimeNs, before.mtimeNs);
  assert.equal(after.ctimeNs, before.ctimeNs);
}
// TEST-only observation limits, not measured production retention-profile defaults.
// Every name is included; no cache/dot-directory exclusion is permitted.
export async function snapshot(root: string): Promise<TreeSnapshot> {
  const started = performance.now(), entries: TreeEntry[] = [];
  const buffer = Buffer.allocUnsafe(snapshotBounds.hashBufferBytes);
  let fileBytes = 0n, largestFileBytes = 0n, largestFilePathSha256: string | null = null;
  function bound(kind: BoundDiagnostic["bound"], path: string, observed: bigint, limit: bigint): void {
    if (observed > limit) throw new SnapshotBoundError({ bound: kind, pathSha256: sha256(relative(root, path)),
      observed: observed.toString(), limit: limit.toString() });
  }
  function timeBound(path: string): void {
    bound("elapsed_ms", path, BigInt(Math.ceil(performance.now() - started)), BigInt(snapshotBounds.maxDurationMs));
  }
  async function visit(path: string): Promise<void> {
    bound("entry_count", path, BigInt(entries.length + 1), BigInt(snapshotBounds.maxEntries)); timeBound(path);
    const before = await lstat(path, { bigint: true });
    const entry = { path: relative(root, path), mode: Number(before.mode & 0o7777n) };
    if (before.isDirectory()) {
      entries.push({ ...entry, type: "directory" });
      const names = await readdir(path);
      names.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
      for (const name of names) await visit(join(path, name));
    } else if (before.isFile()) {
      assert.equal(before.nlink, 1n, "TEST physical copy must not share hardlinks");
      // A whole-tree 4 GiB budget already bounds each file. Stream large locked
      // distributions instead of allocating their entire contents or excluding them.
      bound("file_bytes", path, before.size, maxTotalBytes);
      bound("total_file_bytes", path, fileBytes + before.size, maxTotalBytes);
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let readBytes = 0n;
      const hash = createHash("sha256");
      try {
        const opened = await handle.stat({ bigint: true });
        assert.ok(opened.isFile(), "TEST retained descriptor must be a regular file"); sameIdentity(before, opened);
        while (true) {
          timeBound(path);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
          if (bytesRead === 0) break;
          readBytes += BigInt(bytesRead); fileBytes += BigInt(bytesRead);
          bound("file_bytes", path, readBytes, maxTotalBytes); bound("total_file_bytes", path, fileBytes, maxTotalBytes);
          hash.update(buffer.subarray(0, bytesRead));
        }
        assert.equal(readBytes, before.size, "TEST file length changed during streaming hash");
        sameIdentity(opened, await handle.stat({ bigint: true }));
      } finally { await handle.close(); }
      if (readBytes > largestFileBytes) { largestFileBytes = readBytes; largestFilePathSha256 = sha256(entry.path); }
      entries.push({ ...entry, type: "file", size: readBytes.toString(), sha256: hash.digest("hex") });
    } else if (before.isSymbolicLink()) {
      entries.push({ ...entry, type: "symlink", target: await readlink(path) });
    } else assert.fail("TEST special filesystem entry");
    const after = await lstat(path, { bigint: true });
    sameIdentity(before, after); timeBound(path);
  }
  await visit(root);
  return { digest: sha256(JSON.stringify(entries)), entries, fileBytes: fileBytes.toString(), durationMs: performance.now() - started,
    largestFile: { bytes: largestFileBytes.toString(), pathSha256: largestFilePathSha256 } };
}
export function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
export async function readObject(path: string): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  assert.ok(object(value), "TEST JSON object required");
  return value;
}
