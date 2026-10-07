/** TEST-only pre-issuance filesystem composition. No launch, PATH mutation,
 * authority publication, home/auth IO or current-origin construction. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readlinkSync, readSync, type Stats,
  realpathSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
const runtime = "/opt/subscription-runtime-dependency-os-TEST";
const providerSha256 = "1378bc13983533f293585f9a17265a08dabecc991afc6651e385a7cc99234e1d";
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function missing(path: string): void {
  try { lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error("TEST default command composition collision");
}
function protectedDirectory(path: string): void {
  const stat = lstatSync(path);
  assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === 0 && stat.gid === 0 && !(stat.mode & 0o022));
  assert.equal(realpathSync(path), path);
}
function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function freshFile(path: string, bytes: Uint8Array, mode: number): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try { fchmodSync(fd, mode); writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  const stat = lstatSync(path);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.uid === 0 && stat.gid === 0 && stat.nlink === 1);
  assert.equal(stat.mode & 0o7777, mode); assert.equal(stat.size, bytes.byteLength);
  assert.equal(hash(readFileSync(path)), hash(bytes));
  syncDirectory(dirname(path));
}
/** Fixed compiler output/source closure only. No runtime compiler or caller path
 * is introduced; the existing pinned TEST tsc emits the single module first. */
function catalogFile(path: string, source: boolean): Buffer {
  const ancestors: {path:string; stat:Stats}[] = [];
  for (let ancestor = dirname(path);; ancestor = dirname(ancestor)) {
    protectedDirectory(ancestor); ancestors.push({path:ancestor,stat:lstatSync(ancestor)}); if (ancestor === "/") break;
  }
  const before = lstatSync(path);
  assert(before.isFile() && !before.isSymbolicLink() && before.uid === 0 && before.gid === 0 && before.nlink === 1 && !(before.mode & 0o022));
  assert(before.size > 0 && before.size <= 32768);
  const fd = openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const bytes = Buffer.alloc(before.size + 1); let length = 0;
    while (length < bytes.length) { const count = readSync(fd,bytes,length,bytes.length-length,length); if (!count) break; length += count; }
    assert.equal(length,before.size);
    for (const current of [fstatSync(fd),lstatSync(path)]) {
      assert(current.isFile() && !current.isSymbolicLink());
      for (const key of ["dev","ino","uid","gid","mode","nlink","size","mtimeMs","ctimeMs"] as const) assert.equal(current[key],before[key]);
    }
    for (const parent of ancestors) {
      protectedDirectory(parent.path); const current = lstatSync(parent.path);
      for (const key of ["dev","ino","uid","gid","mode"] as const) assert.equal(current[key],parent.stat[key]);
    }
    const data = bytes.subarray(0,length); assert(data.every(byte => byte <= 127));
    if (source) assert.equal(hash(data), "41c102229b801eb6d8f5fea546c9dd3c169711718617dc66a6d58162a69523f9");
    return data;
  } finally { closeSync(fd); }
}
/** The outer assembler may call once after immutable source/toolchain copying
 * and root ownership, before boot/digest/profile/installation. A partial failure
 * is not retried or cleaned here. Existing outer ownership decides disposition.
 * Actual TEST workspace/guest-namespace configuration is published by its owned
 * guest fixture before installedArtifactDigest, never invented by this helper. */
export function composeDefaultTestCodex(root: string): void {
  assert.equal(process.getuid!(), 0); assert.equal(process.geteuid!(), 0);
  assert(/^\/var\/lib\/subscription-runtime-os-TEST\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/root$/.test(root));
  for (let path = root;; path = dirname(path)) { protectedDirectory(path); if (path === "/") break; }
  const prefix = root + runtime, toolchain = prefix + "/toolchain";
  for (const path of [prefix, toolchain, toolchain + "/bin", toolchain + "/lib", toolchain + "/lib/node_modules"])
    protectedDirectory(path);
  missing(root + "/var/lib/subscription-runtime-host-policy/host-installation.json");
  missing(prefix + "/guest-evidence.json");
  const source = prefix + "/scripts/dependency-retention-os-test/provider.ts";
  for (let path = dirname(source); path.startsWith(prefix); path = dirname(path)) protectedDirectory(path);
  const before = lstatSync(source);
  assert(before.isFile() && !before.isSymbolicLink() && before.uid === 0 && before.gid === 0 && before.nlink === 1 && !(before.mode & 0o022));
  assert(before.size > 0 && before.size <= 32768);
  const sourceFd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes: Buffer;
  try {
    const actual = fstatSync(sourceFd);
    assert(actual.isFile() && actual.dev === before.dev && actual.ino === before.ino && actual.size === before.size);
    const bounded = Buffer.alloc(before.size + 1); let length = 0;
    while (length < bounded.length) {
      const count = readSync(sourceFd, bounded, length, bounded.length - length, length);
      if (!count) break; length += count;
    }
    assert.equal(length, before.size); bytes = bounded.subarray(0, length);
    assert.equal(hash(bytes), providerSha256);
    const last = fstatSync(sourceFd);
    assert.equal(last.dev, before.dev); assert.equal(last.ino, before.ino); assert.equal(last.size, before.size);
    assert.equal(last.mtimeMs, before.mtimeMs); assert.equal(last.ctimeMs, before.ctimeMs);
  } finally { closeSync(sourceFd); }
  const after = lstatSync(source);
  assert.equal(before.dev, after.dev); assert.equal(before.ino, after.ino);
  assert.equal(before.mtimeMs, after.mtimeMs); assert.equal(before.ctimeMs, after.ctimeMs);
  catalogFile(prefix + "/scripts/dependency-retention-os-test/default-codex-catalog-protocol.ts",true);
  const catalogModule = catalogFile(prefix + "/scripts/dependency-retention-os-test/generated-catalog/default-codex-catalog-protocol.js",false);
  const packageRoot = toolchain + "/lib/node_modules/codex", alias = toolchain + "/bin/codex";
  missing(packageRoot); missing(alias);
  missing(root + "/usr/local/bin/codex");
  mkdirSync(packageRoot, {mode: 0o755}); mkdirSync(packageRoot + "/bin", {mode: 0o755});
  freshFile(packageRoot + "/package.json", Buffer.from('{"name":"@openai/codex","type":"module","private":true}\n'), 0o644);
  const executable = packageRoot + "/bin/provider.ts";
  freshFile(executable, bytes, 0o555);
  freshFile(packageRoot + "/bin/default-codex-catalog-protocol.js",catalogModule,0o555);
  freshFile(packageRoot + "/TEST-catalog-module.json",Buffer.from(JSON.stringify({schemaVersion:1,kind:"TEST_compiled_catalog_closure",
    sourceSha256:"41c102229b801eb6d8f5fea546c9dd3c169711718617dc66a6d58162a69523f9",moduleSha256:hash(catalogModule)})+"\n"),0o444);
  const target = "../lib/node_modules/codex/bin/provider.ts";
  symlinkSync(target, alias);
  const link = lstatSync(alias); assert(link.isSymbolicLink() && link.uid === 0 && link.gid === 0 && link.nlink === 1);
  assert.equal(readlinkSync(alias), target); assert.equal(realpathSync(alias), executable);
  assert.equal(hash(readFileSync(realpathSync(alias))), providerSha256);
  syncDirectory(toolchain + "/bin"); syncDirectory(packageRoot + "/bin");
  syncDirectory(packageRoot); syncDirectory(toolchain + "/lib/node_modules");
  composeCanonicalGuestAlias(root, executable, packageRoot);
}

/** Canonical default resolution inside this owned guest only. The relative link
 * also resolves correctly during outer pre-boot inspection without escaping root.
 * The immutable package record makes the expected link part of artifact digest;
 * the actual named link/target are independently rechecked by the owned guest. */
function composeCanonicalGuestAlias(root: string, executable: string, packageRoot: string): void {
  protectedDirectory(root + "/usr");
  for (const path of [root + "/usr/local", root + "/usr/local/bin"]) {
    try { mkdirSync(path, {mode:0o755}); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    protectedDirectory(path);
  }
  const parents: {path:string;fd:number;stat:Stats}[] = [];
  try {
    for (const path of [root + "/usr", root + "/usr/local", root + "/usr/local/bin"]) {
      const fd = openSync(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
      try {
        const stat = fstatSync(fd), named = lstatSync(path);
        assert(stat.isDirectory() && named.isDirectory() && !named.isSymbolicLink());
        for (const key of ["dev","ino","uid","gid","mode"] as const) assert.equal(stat[key],named[key]);
        parents.push({path,fd,stat});
      } catch (error) { closeSync(fd); throw error; }
    }
    const alias = root + "/usr/local/bin/codex";
    const target = "../../../opt/subscription-runtime-dependency-os-TEST/toolchain/lib/node_modules/codex/bin/provider.ts";
    missing(alias); symlinkSync(target,alias);
    const before = lstatSync(alias);
    assert(before.isSymbolicLink() && before.uid === 0 && before.gid === 0 && before.nlink === 1);
    assert.equal(readlinkSync(alias),target); assert.equal(realpathSync(alias),executable);
    assert.equal(hash(catalogFile(executable,false)),providerSha256);
    const after = lstatSync(alias);
    for (const key of ["dev","ino","uid","gid","mode","nlink","size","mtimeMs","ctimeMs"] as const)
      assert.equal(after[key],before[key]);
    assert.equal(readlinkSync(alias),target); assert.equal(realpathSync(alias),executable);
    for (const parent of parents) {
      protectedDirectory(parent.path);
      for (const current of [fstatSync(parent.fd),lstatSync(parent.path)]) {
        assert(current.isDirectory() && !current.isSymbolicLink());
        for (const key of ["dev","ino","uid","gid","mode"] as const) assert.equal(current[key],parent.stat[key]);
      }
    }
    freshFile(packageRoot + "/TEST-default-alias.json",Buffer.from(JSON.stringify({schemaVersion:1,
      kind:"TEST_canonical_default_alias",alias:"/usr/local/bin/codex",target,
      executable:runtime + "/toolchain/lib/node_modules/codex/bin/provider.ts",providerSha256})+"\n"),0o444);
    syncDirectory(root + "/usr/local/bin"); syncDirectory(root + "/usr/local"); syncDirectory(root + "/usr");
  } finally {
    let failure: unknown;
    for (const parent of parents.reverse()) {
      try { closeSync(parent.fd); } catch (error) { failure ??= error; }
    }
    if (failure !== undefined) throw failure;
  }
}
