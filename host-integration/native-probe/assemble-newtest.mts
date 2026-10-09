import { RetainedV2ProfileKind } from "./retained-v2-profile.mjs";
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { retainedResourceCanonicalJson, retainedResourceDigest } from "../../src/core/scoped-retained-resource-contract.js";
import type { InstallationFile } from "./root-origin-operator.mjs";
export const nativeInstallation = "/opt/subscription-runtime/native-probe";
export const newtestRoot = "/opt/subscription-runtime/native-newtest";
export const officialBaseSha256 = "e77b6f10c2590cef872b33ee9f635a0e3fd1f57fb074c0e52b5c7f56147a0c86";
export const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
export function protectedPath(path: string, directory = false): void {
  if (resolve(path) !== path || !path.startsWith("/") || path.includes("//")) throw new Error("noncanonical NEWTEST path");
  for (let p = path; ; p = dirname(p)) {
    const s = lstatSync(p);
    if (s.isSymbolicLink() || s.uid !== (process.getuid?.() ?? 0) || s.gid !== (process.getgid?.() ?? 0) || (s.mode & 0o022) || (p === path && !directory ? !s.isFile() || s.nlink !== 1 : !s.isDirectory())) throw new Error("unprotected NEWTEST input");
    if (p === "/") break;
  }
}
export function measured(path: string, maximum = 256 * 1024 * 1024): Buffer {
  protectedPath(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (before.size > BigInt(maximum)) throw new Error("NEWTEST leaf capacity");
    const b = readFileSync(fd), after = fstatSync(fd, { bigint: true }), named = lstatSync(path, { bigint: true });
    if (before.dev !== named.dev || before.ino !== named.ino || before.size !== after.size || before.size !== BigInt(b.length) || before.mode !== after.mode || before.ctimeNs !== after.ctimeNs || before.mtimeNs !== after.mtimeNs) throw new Error("changed NEWTEST input");
    return b;
  } finally { closeSync(fd); }
}
export function durable(path: string, value: unknown, mode = 0o600): void {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(retainedResourceCanonicalJson(value) + "\n");
  protectedPath(dirname(path), true);
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  for (let p = dirname(path); ; p = dirname(p)) {
    const parent = openSync(p, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(parent); } finally { closeSync(parent); }
    if (p === "/") break;
  }
}
export interface TreeLeaf { readonly path: string; readonly bytes: number; readonly mode: number; readonly sha256: string }
export function tree(root: string): readonly TreeLeaf[] {
  protectedPath(root, true);
  const rows: TreeLeaf[] = [];
  const walk = (p: string): void => {
    for (const name of readdirSync(p).sort()) {
      const path = join(p, name), s = lstatSync(path);
      if (s.isDirectory() && !s.isSymbolicLink()) { protectedPath(path, true); walk(path); }
      else {
        const b = measured(path);
        rows.push({ path: path.slice(root.length + 1), bytes: b.length, mode: s.mode & 0o7777, sha256: digest(b) });
        if (rows.length > 4096) throw new Error("NEWTEST tree capacity");
      }
    }
  };
  walk(root); return Object.freeze(rows);
}
export function verifyTree(root: string, expected: string): readonly TreeLeaf[] {
  const rows = tree(root);
  if (!/^[a-f0-9]{64}$/.test(expected) || retainedResourceDigest(rows) !== expected) throw new Error("wrong NEWTEST artifact tree");
  return rows;
}
// Read ELF metadata without executing the binary or invoking ldd. Only the
// supported x86-64 little-endian ELF ABI and stock guest library search apply.
export function elfInputs(b: Buffer): { interpreter: string | null; needed: readonly string[] } {
  const fail = (): never => { throw new Error("unsupported ELF closure"); };
  if (b.length < 64 || b.length > 256 * 1024 * 1024 || !b.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) || b[4] !== 2 || b[5] !== 1 || b.readUInt16LE(18) !== 62 || b.readUInt32LE(20) !== 1) fail();
  const number = (offset: number): number => { const n = b.readBigUInt64LE(offset); if (n > BigInt(b.length)) fail(); return Number(n); };
  const range = (offset: number, size: number): void => { if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset + size > b.length) fail(); };
  const string = (offset: number, maximum: number): string => {
    range(offset, maximum);
    // Names/installed paths are at most 255 bytes, independent of dynstr size.
    const bytes = b.subarray(offset, offset + Math.min(maximum, 256)), end = bytes.indexOf(0);
    if (end < 0) fail();
    const name = bytes.subarray(0, end); if (name.some(c => c < 32 || c > 126)) fail(); return name.toString("ascii");
  };
  const ph = number(32), size = b.readUInt16LE(54), count = b.readUInt16LE(56);
  if (size !== 56 || !count || count > 256) fail(); range(ph, count * size);
  const page = 4096n, addressLimit = 1n << 64n;
  const pageStart = (n: bigint): bigint => n / page * page;
  const pageEnd = (n: bigint): bigint => (n + page - 1n) / page * page;
  const segments: Array<{ type: number; flags: number; offset: number; address: bigint; bytes: number; memory: bigint }> = [];
  for (let i = 0; i < count; i++) {
    const p = ph + i * size, segment = { type: b.readUInt32LE(p), flags: b.readUInt32LE(p + 4),
      offset: number(p + 8), address: b.readBigUInt64LE(p + 16), bytes: number(p + 32), memory: b.readBigUInt64LE(p + 40) };
    range(segment.offset, segment.bytes);
    if (segment.address + BigInt(segment.bytes) > addressLimit) fail();
    if (segment.type === 1 && (BigInt(segment.bytes) > segment.memory ||
      segment.address + segment.memory > addressLimit || (segment.flags & ~7) ||
      BigInt(segment.offset) % page !== segment.address % page)) fail();
    segments.push(segment);
  }
  const interpreters = segments.filter(s => s.type === 3), dynamics = segments.filter(s => s.type === 2);
  if (interpreters.length > 1 || dynamics.length > 1) fail();
  const interpreter = interpreters[0], dynamic = dynamics[0];
  const needed: number[] = []; let address: bigint | undefined, strings: number | undefined;
  if (dynamic) {
    if (dynamic.bytes % 16) fail();
    let terminated = false;
    for (let i = 0; i < dynamic.bytes; i += 16) {
      const p = dynamic.offset + i, tag = b.readBigInt64LE(p), value = b.readBigUInt64LE(p + 8);
      if (!tag) { terminated = true; break; }
      if (tag === 1n) { if (value >= BigInt(b.length) || needed.length >= 64) fail(); needed.push(Number(value)); }
      if (tag === 5n) { if (address !== undefined) fail(); address = value; }
      // DT_STRSZ measures all dynamic symbol names, not only dependency names.
      // Bound it by the measured file and a complete file-backed PT_LOAD below.
      if (tag === 10n) { if (strings !== undefined || !value || value > BigInt(b.length)) fail(); strings = Number(value); }
      // A foreign search override needs its own admitted profile.
      if (tag === 15n || tag === 29n) fail();
    }
    if (!terminated) fail();
  }
  const loads = address === undefined || strings === undefined ? [] : segments.filter(s =>
    s.type === 1 && address! >= s.address && address! + BigInt(strings!) <= s.address + BigInt(s.bytes));
  if ((address !== undefined || strings !== undefined || needed.length) && loads.length !== 1) fail();
  const load = loads[0], start = load ? load.offset + Number(address! - load.address) : 0;
  if (load) {
    const begin = address!, end = begin + BigInt(strings!);
    const intersects = (a: bigint, z: bigint): boolean => a < z && a < end && begin < z;
    if (end > addressLimit || !(load.flags & 4)) fail();
    for (const s of segments.filter(s => s.type === 1)) {
      const fileEnd = s.address + BigInt(s.bytes), memoryEnd = s.address + s.memory;
      const mappedStart = pageStart(s.address), mappedEnd = pageEnd(fileEnd);
      if (mappedEnd > addressLimit || pageEnd(memoryEnd) > addressLimit) fail();
      // Linux/glibc map whole file pages. Even zero filesz at an unaligned
      // address can cover a file page in glibc; conflicting coverage refuses.
      if (s !== load && intersects(mappedStart, mappedEnd) &&
        (BigInt(s.offset) - s.address !== BigInt(load.offset) - load.address || s.flags !== load.flags)) fail();
      if (s !== load && s.bytes > 0 && intersects(s.address, fileEnd)) fail();
      // Include Linux's tail-to-page zeroing and glibc's anonymous BSS pages.
      const zeroStart = s.bytes ? fileEnd : mappedStart;
      if (s.memory > BigInt(s.bytes) && intersects(zeroStart, pageEnd(memoryEnd))) fail();
    }
  }
  if (strings !== undefined) range(start, strings);
  return { interpreter: interpreter ? string(interpreter.offset, interpreter.bytes) : null, needed: needed.map(i => {
    if (strings === undefined || i >= strings) return fail(); const name = string(start + i, strings - i);
    if (!/^[A-Za-z0-9_+.-]+\.so(?:\.[0-9]+)*$/.test(name)) fail(); return name;
  }) };
}
interface ClosureLeaf { readonly source: string; readonly image: string }
export function elfClosure(entries: readonly string[]): readonly ClosureLeaf[] {
  const rows = new Map<string, ClosureLeaf>(), visited = new Set<string>();
  const add = (source: string, image: string): void => {
    const actual = realpathSync(source); protectedPath(actual);
    if (!actual.startsWith("/usr/lib/") && !entries.includes(actual)) throw new Error("foreign shared ELF input");
    const previous = rows.get(image); if (previous && previous.source !== actual) throw new Error("ambiguous ELF image path");
    rows.set(image, { source: actual, image }); visit(actual);
  };
  const visit = (path: string): void => {
    if (visited.has(path)) return; visited.add(path);
    if (visited.size > 64) throw new Error("ELF closure capacity");
    const inputs = elfInputs(measured(path));
    if (inputs.interpreter) {
      if (!/^\/(?:usr\/)?lib(?:64)?\/.+\.so(?:\.[0-9]+)*$/.test(inputs.interpreter)) throw new Error("foreign ELF interpreter");
      add(inputs.interpreter, inputs.interpreter);
    }
    for (const name of inputs.needed) {
      let found: string | undefined;
      for (const parent of ["/lib/x86_64-linux-gnu", "/usr/lib/x86_64-linux-gnu", "/lib64", "/usr/lib64", "/lib", "/usr/lib"]) {
        const path = join(parent, name);
        try { lstatSync(path); found = path; break; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
      }
      if (!found) throw new Error("missing stock ELF dependency"); add(found, found);
    }
  };
  for (const entry of entries) { protectedPath(entry); visit(entry); }
  return [...rows.values()];
}
export function admitJsImports(admin: string): void {
  for (const row of tree(admin)) {
    if (!/\.(?:mjs|js)$/.test(row.path)) continue;
    const path = join(admin, row.path), text = measured(path).toString("utf8");
    for (const match of text.matchAll(/(?:\b(?:import|export)\s+[^;]*?\bfrom\s*|\bimport\s*\(\s*)["']([^"']+)["']/g)) {
      const specifier = match[1]!;
      if (specifier.startsWith("node:")) continue;
      if (!specifier.startsWith(".")) throw new Error("unbundled NEWTEST import");
      const imported = resolve(dirname(path), specifier);
      if (!imported.startsWith(admin + "/")) throw new Error("escaping NEWTEST import");
      measured(imported);
    }
  }
}
export function assembleNewtest(candidate: string, artifact: string, artifactDigest: string, daemonUid: number, daemonGid: number): unknown {
  // No installed writes until the whole artifact and dependency plan admits.
  verifyTree(artifact, artifactDigest); admitJsImports(join(artifact, "admin"));
  protectedPath(candidate, true);
  if (readdirSync(candidate).length) throw new Error("nonempty candidate refused");
  const node = "/opt/subscription-runtime/runtime/node";
  const binaries = [node, join(artifact, "root-producer-entry"), join(artifact, "original-owner-associated.node"), join(artifact, "native-root-client")];
  const elf = elfClosure([...binaries,"/usr/bin/dbus-daemon"]);
  const plan: Array<{ path: string; source: string; mode: number }> = [
    { path: nativeInstallation + "/root-producer-entry", source: binaries[1]!, mode: 0o700 },
    { path: nativeInstallation + "/test-root/opt/native/node", source: node, mode: 0o755 },
    { path: nativeInstallation + "/test-root/opt/native/original-owner-helper.mjs", source: join(artifact, "original-owner-helper.mjs"), mode: 0o644 },
    { path: nativeInstallation + "/test-root/opt/native/original-owner-associated.node", source: binaries[2]!, mode: 0o644 },
    { path: "/usr/bin/dbus-daemon", source: "/usr/bin/dbus-daemon", mode: lstatSync("/usr/bin/dbus-daemon").mode & 0o7777 },
    { path: nativeInstallation + "/admin/host-integration/native-probe/root-origin-operator.mjs", source: join(artifact, "admin/host-integration/native-probe/root-origin-operator.mjs"), mode: 0o644 },
    { path: nativeInstallation + "/native-root-client", source: binaries[3]!, mode: 0o700 },
  ];
  for (const row of tree(join(artifact, "admin"))) {
    const path = nativeInstallation + "/admin/" + row.path;
    if (!plan.some(p => p.path === path)) plan.push({ path, source: join(artifact, "admin", row.path), mode: 0o644 });
  }
  for (const row of elf) plan.push({ path: nativeInstallation + "/test-root" + row.image, source: row.source, mode: 0o755 });
  // Real original observer mappings, not an expected list derived from ELF.
  const maps = processMaps();
  const shared = new Set([node, ...elf.map(row => row.source), ...maps.split("\n").flatMap(line => { const m = /^\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(\/.*)$/.exec(line); return m ? [m[1]!] : []; })]);
  for (const path of shared) {
    if (path !== node && !path.startsWith("/usr/lib/")) throw new Error("foreign observer mapped input");
    plan.push({ path, source: path, mode: lstatSync(path).mode & 0o7777 });
  }
  const paths = new Set<string>(), files: InstallationFile[] = [];
  const admitted: Array<{ row: typeof plan[number]; bytes: Buffer }> = [];
  for (const row of plan) {
    if (paths.has(row.path)) continue; paths.add(row.path);
    if (Buffer.byteLength(row.path) > 255 || files.length >= 128) throw new Error("installation census capacity");
    const bytes = measured(row.source); files.push({ path: row.path, bytes: bytes.length, mode: row.mode, sha256: digest(bytes) }); admitted.push({ row, bytes });
  }
  if (![daemonUid, daemonGid].every(v => Number.isInteger(v) && v >= 0 && v <= 0xffffffff)) throw new Error("invalid original daemon identity");
  const manifest = { version: 1, profile: "NativeOriginalA0", daemonUid, daemonGid, files };
  if (Buffer.byteLength(retainedResourceCanonicalJson(manifest)) > 65536) throw new Error("installation manifest capacity");
  for (const { row, bytes } of admitted) {
    if (!row.path.startsWith(nativeInstallation + "/")) continue;
    const target = join(candidate, row.path.slice(nativeInstallation.length + 1)); mkdirSync(dirname(target), { recursive: true, mode: 0o755 }); durable(target, bytes, row.mode);
  }
  durable(join(candidate, "manifest.json"), manifest);
  return { installationDigest: retainedResourceDigest(manifest), files: files.length, authorityIssued: false };
}
export function assembleRetainedV2Newtest(candidate: string, artifact: string, artifactDigest: string, daemonUid: number, daemonGid: number): unknown {
  return assembleRetainedNative(candidate,artifact,artifactDigest,daemonUid,daemonGid,false);
}
export function assembleRetainedV2ActorNewtest(candidate: string, artifact: string, artifactDigest: string, daemonUid: number, daemonGid: number): unknown {
  return assembleRetainedNative(candidate,artifact,artifactDigest,daemonUid,daemonGid,true);
}
function assembleRetainedNative(candidate: string, artifact: string, artifactDigest: string, daemonUid: number, daemonGid: number, actors: boolean): unknown {
  const nativeInstallation=actors?"/opt/subscription-runtime/native-retained-v2-b1a":"/opt/subscription-runtime/native-retained-v2";
  const entry=actors?"retained-v2-actor-entry":"retained-v2-entry",operator=actors?"retained-v2-actor-operator.mjs":"retained-v2-operator.mjs";
  // No installed writes until the whole artifact and dependency plan admits.
  verifyTree(artifact, artifactDigest); admitJsImports(join(artifact, "admin"));
  protectedPath(candidate, true);
  if (readdirSync(candidate).length) throw new Error("nonempty candidate refused");
  const node = "/opt/subscription-runtime/runtime/node";
  const binaries = [node, join(artifact, entry), join(artifact, "original-owner-associated.node"), join(artifact, "native-root-client")];
  const elf = elfClosure([...binaries,"/usr/bin/dbus-daemon"]);
  const plan: Array<{ path: string; source: string; mode: number }> = [
    { path: nativeInstallation + "/"+entry, source: binaries[1]!, mode: 0o700 },
    { path: nativeInstallation + "/test-root/opt/native/node", source: node, mode: 0o755 },
    { path: nativeInstallation + "/test-root/opt/native/original-owner-helper.mjs", source: join(artifact, "original-owner-helper.mjs"), mode: 0o644 },
    { path: nativeInstallation + "/test-root/opt/native/original-owner-associated.node", source: binaries[2]!, mode: 0o644 },
    { path: "/usr/bin/dbus-daemon", source: "/usr/bin/dbus-daemon", mode: lstatSync("/usr/bin/dbus-daemon").mode & 0o7777 },
    { path: nativeInstallation + "/admin/host-integration/native-probe/"+operator, source: join(artifact, "admin/host-integration/native-probe",operator), mode: 0o644 },
    { path: nativeInstallation + "/expected-helper-policy.json", source: join(artifact,"expected-helper-policy.json"), mode: 0o644 },
    { path: nativeInstallation + "/native-root-client", source: binaries[3]!, mode: 0o700 },
  ];
  for (const row of tree(join(artifact, "admin"))) {
    const path = nativeInstallation + "/admin/" + row.path;
    if (!plan.some(p => p.path === path)) plan.push({ path, source: join(artifact, "admin", row.path), mode: 0o644 });
  }
  for (const row of elf) plan.push({ path: nativeInstallation + "/test-root" + row.image, source: row.source, mode: 0o755 });
  // Real original observer mappings, not an expected list derived from ELF.
  const maps = processMaps();
  const shared = new Set([node, ...elf.map(row => row.source), ...maps.split("\n").flatMap(line => { const m = /^\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(\/.*)$/.exec(line); return m ? [m[1]!] : []; })]);
  for (const path of shared) {
    if (path !== node && !path.startsWith("/usr/lib/")) throw new Error("foreign observer mapped input");
    plan.push({ path, source: path, mode: lstatSync(path).mode & 0o7777 });
  }
  const paths = new Set<string>(), files: InstallationFile[] = [];
  const admitted: Array<{ row: typeof plan[number]; bytes: Buffer }> = [];
  for (const row of plan) {
    if (paths.has(row.path)) continue; paths.add(row.path);
    if (Buffer.byteLength(row.path) > 255 || files.length >= 128) throw new Error("installation census capacity");
    const bytes = measured(row.source); files.push({ path: row.path, bytes: bytes.length, mode: row.mode, sha256: digest(bytes) }); admitted.push({ row, bytes });
  }
  if (![daemonUid, daemonGid].every(v => Number.isInteger(v) && v >= 0 && v <= 0xffffffff)) throw new Error("invalid original daemon identity");
  const manifest = { version: 1, profile: actors?RetainedV2ProfileKind.B1a:RetainedV2ProfileKind.A1, daemonUid, daemonGid, files };
  if (Buffer.byteLength(retainedResourceCanonicalJson(manifest)) > 65536) throw new Error("installation manifest capacity");
  for (const { row, bytes } of admitted) {
    if (!row.path.startsWith(nativeInstallation + "/")) continue;
    const target = join(candidate, row.path.slice(nativeInstallation.length + 1)); mkdirSync(dirname(target), { recursive: true, mode: 0o755 }); durable(target, bytes, row.mode);
  }
  durable(join(candidate, "manifest.json"), manifest);
  return { installationDigest: retainedResourceDigest(manifest), files: files.length, authorityIssued: false };
}
// /proc maps is a kernel stream, not a stable regular installation leaf.
export function processMaps(): string { const text=readFileSync("/proc/self/maps", "utf8"); if(Buffer.byteLength(text)>1048576)throw new Error("mapped closure capacity");return text; }
