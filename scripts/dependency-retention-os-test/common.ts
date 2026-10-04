import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";

export const runtime = "/opt/subscription-runtime-dependency-os-TEST";
export const policy = "/var/lib/subscription-runtime-host-policy";
export const node = runtime + "/toolchain/bin/node";
export const cleanEnv = { PATH: runtime + "/toolchain/bin:/usr/bin:/bin", LANG: "C", LC_ALL: "C", SYSTEMD_COLORS: "0" };
export const digest = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
export function command(file: string, args: readonly string[], timeout = 30000, cwd = "/"): string {
  const result = spawnSync(file, [...args], { cwd, env: cleanEnv, encoding: "utf8", timeout,
    maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  assert(!result.error && result.status === 0 && result.signal === null,
    `TEST command failed: ${file}, status=${result.status}, signal=${result.signal}`);
  return result.stdout;
}
export function directory(path: string, mode = 0o700): void {
  mkdirSync(path, { recursive: true, mode });
  assert.equal(realpathSync(path), path);
  const stat = lstatSync(path); assert.equal(stat.uid, 0); assert.equal(stat.mode & 0o777, mode);
}
export function json(path: string, value: unknown, mode = 0o600): void {
  const temporary = path + "." + randomUUID() + ".tmp";
  writeFileSync(temporary, JSON.stringify(value) + "\n", { flag: "wx", mode });
  linkSync(temporary, path); unlinkSync(temporary);
}
export function fileDigest(path: string): string { return digest(readFileSync(path)); }
export function directoryIdentity(path: string) {
  const stat = lstatSync(path, { bigint: true }); assert(stat.isDirectory() && !stat.isSymbolicLink());
  return { canonicalPath: path, dev: String(stat.dev), ino: String(stat.ino) };
}
export function installedArtifactDigest(): string {
  const entries: unknown[] = []; let count = 0, size = 0; const deadline = Date.now() + 30000;
  function walk(path: string): void {
    assert(++count <= 200000 && Date.now() < deadline);
    const stat = lstatSync(path); assert.equal(stat.uid, 0);
    assert(stat.isSymbolicLink() || (stat.mode & 0o022) === 0);
    const relative = path.slice(runtime.length + 1);
    if (stat.isDirectory()) {
      entries.push([relative, "directory", stat.mode & 0o7777]);
      for (const name of readdirSync(path).sort()) walk(path + "/" + name);
    } else if (stat.isSymbolicLink()) {
      assert(realpathSync(path).startsWith(runtime + "/"));
      entries.push([relative, "symlink", readlinkSync(path)]);
    } else {
      assert(stat.isFile() && stat.nlink === 1 && (size += stat.size) <= 2 * 1024 * 1024 * 1024);
      entries.push([relative, "file", stat.mode & 0o7777, stat.size, fileDigest(path)]);
    }
  }
  for (const name of ["dist", "packages", "node_modules", "scripts", "package.json", "toolchain"]) walk(runtime + "/" + name);
  return digest(JSON.stringify(entries));
}
