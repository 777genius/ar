import { createHash } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, opendirSync, readSync, writeFileSync, type BigIntStats } from "node:fs";
import { dirname, join } from "node:path";

// Node-builtins-only: this exact compiled module is also mounted readonly next
// to the contained bootstrap. These are observations, never launch/Ready proof.
export enum HostedDependencyStageEntryKind { Directory = "directory", File = "file" }
export type HostedDependencyLocalInputCommitment = import("../worker-local/dependency-environment/build-test-npm-dependency-install-key").DependencyLocalInputCommitment;
export type HostedDependencyLocalStageEntry = { readonly path: string; readonly kind: HostedDependencyStageEntryKind.Directory; readonly mode: 0o755 } |
  { readonly path: string; readonly kind: HostedDependencyStageEntryKind.File; readonly mode: number; readonly bytes: number; readonly sha256: string };
export type HostedDependencyLocalStage = { readonly version: 1; readonly entries: readonly HostedDependencyLocalStageEntry[];
  readonly commitment: HostedDependencyLocalInputCommitment };
export type HostedDependencyLocalStageFile = { readonly path: string; readonly mode: number; readonly bytes: Uint8Array };
/** Independent contained constants; no host key/domain runtime dependency. */
export function hostedDependencyLocalSelectionVerificationArgv(stage: HostedDependencyLocalStage): readonly string[] {
  if (stage.commitment.version !== 2) fail();
  const argv = ["ls", "--all", "--json", "--ignore-scripts", "--package-lock-only=false", "--install-strategy=hoisted", "--install-links=true",
    "--include=dev", "--include=optional", "--include=peer", "--strict-peer-deps=false", "--legacy-peer-deps=false", "--workspaces=false"];
  if (stage.commitment.layout === "root_only") return Object.freeze(argv);
  if (stage.commitment.layout !== "root_with_literal_workspace_inputs") fail();
  return Object.freeze([...argv.slice(0, -1), "--workspaces=true", "--include-workspace-root=true"]);
}
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
function fail(): never { throw new Error("dependency_local_stage_changed"); }
function coordinate(path: string): void {
  if (typeof path !== "string" || !path || path.length > 4096 || Buffer.from(path).toString() !== path || /[\x00-\x1f\x7f\\*?!\[\]{}]/.test(path) ||
      path.split("/").some(part => !part || Buffer.byteLength(part) > 255 || [".", "..", "node_modules", ".git"].includes(part))) fail();
}
/** Exact finite input inventory; ancestors are generated only from admitted
 * coordinates, not copied from the original filesystem or an npm pack walk. */
export function describeHostedDependencyLocalStage(commitment: HostedDependencyLocalInputCommitment,
  files: readonly HostedDependencyLocalStageFile[]): HostedDependencyLocalStage {
  const entries = new Map<string, HostedDependencyLocalStageEntry>([["", { path: "", kind: HostedDependencyStageEntryKind.Directory, mode: 0o755 }]]);
  const directory = (path: string): void => {
    if (!path || path === ".") return; coordinate(path); directory(dirname(path));
    const prior = entries.get(path); if (prior && prior.kind !== HostedDependencyStageEntryKind.Directory) fail();
    entries.set(path, { path, kind: HostedDependencyStageEntryKind.Directory, mode: 0o755 });
  };
  let total = 0;
  for (const file of files) {
    coordinate(file.path); directory(dirname(file.path));
    if (entries.has(file.path) || ![0o644, 0o755].includes(file.mode) || !(file.bytes instanceof Uint8Array) ||
        (total += file.bytes.length) > 64 * 1024 * 1024) fail();
    entries.set(file.path, { path: file.path, kind: HostedDependencyStageEntryKind.File, mode: file.mode, bytes: file.bytes.length, sha256: hash(file.bytes) });
  }
  for (const local of commitment.packages) { directory(local.path); for (const path of local.directories) directory(local.path + "/" + path); }
  if (entries.size > 16384) fail();
  return { version: 1, commitment: structuredClone(commitment), entries: [...entries.values()].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))) };
}
const stable = (a: BigIntStats, b: BigIntStats): boolean => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid &&
  (!a.isFile() || a.nlink === b.nlink && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs);
/** Retained nofollow inode/content/membership observation. Root node_modules is
 * the only output exception; its identity/owner remain checked, its children
 * are verified later by the genuine full output observer. No name exclusions. */
export function observeHostedDependencyLocalStage(root: string, stage: HostedDependencyLocalStage,
  inputSha256: string, inputOwnerUid = 0, outputOwnerUid = 65532): string {
  if (stage.version !== 1 || !Array.isArray(stage.entries) || stage.entries.length < 3 || stage.entries.length > 16384 ||
      !Number.isSafeInteger(inputOwnerUid) || inputOwnerUid < 0 || !Number.isSafeInteger(outputOwnerUid) || outputOwnerUid < 0) fail();
  const entries: readonly HostedDependencyLocalStageEntry[] = stage.entries;
  const expected = new Map(entries.map(entry => [entry.path, entry]));
  if (expected.size !== entries.length || expected.get("")?.kind !== HostedDependencyStageEntryKind.Directory) fail();
  const facts: unknown[] = [], observedFiles = new Map<string, { bytes: number; sha256: string; mode: number }>();
  const childrenByPath = new Map<string, string[]>();
  for (const entry of entries) if (entry.path) {
    coordinate(entry.path); const parent = dirname(entry.path) === "." ? "" : dirname(entry.path);
    if (expected.get(parent)?.kind !== HostedDependencyStageEntryKind.Directory) fail();
    const children = childrenByPath.get(parent) ?? []; children.push(entry.path.slice(parent ? parent.length + 1 : 0)); childrenByPath.set(parent, children);
  }
  const rootChildren = childrenByPath.get("") ?? []; rootChildren.push("node_modules"); childrenByPath.set("", rootChildren);
  for (const children of childrenByPath.values()) children.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const retained: { fd: number; path: string; before: BigIntStats }[] = []; const started = performance.now(); let total = 0;
  const check = (): void => { if (performance.now() - started > 10000) fail(); };
  const names = (path: string): string[] => {
    const result: string[] = [], iterator = opendirSync(path, { encoding: "latin1", bufferSize: 32 });
    try { for (;;) { check(); const entry = iterator.readSync(); if (!entry) break;
      if (result.length >= 16384) fail(); const raw = Buffer.from(entry.name, "latin1"), name = new TextDecoder("utf-8", { fatal: true }).decode(raw);
      if (!Buffer.from(name).equals(raw)) fail(); result.push(name);
    } } finally { iterator.closeSync(); }
    return result.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  };
  try {
    for (const entry of entries) {
      check(); if (entry.path) coordinate(entry.path); const path = join(root, entry.path), before = lstatSync(path, { bigint: true });
      if (before.uid !== BigInt(inputOwnerUid) || Number(before.mode & 0o7777n) !== entry.mode || before.isSymbolicLink()) fail();
      if (entry.kind === HostedDependencyStageEntryKind.Directory) {
        if (!before.isDirectory() || entry.mode !== 0o755) fail();
        const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); retained.push({ fd, path, before });
        if (!stable(before, fstatSync(fd, { bigint: true }))) fail();
        const children = childrenByPath.get(entry.path) ?? [];
        if (JSON.stringify(names(path)) !== JSON.stringify(children)) fail();
        facts.push([entry.path, String(before.dev), String(before.ino), String(before.mode), String(before.uid), String(before.gid)]);
      } else if (entry.kind === HostedDependencyStageEntryKind.File) {
        if (!before.isFile() || before.nlink !== 1n || ![0o644, 0o755].includes(entry.mode) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 ||
            before.size !== BigInt(entry.bytes) || (total += entry.bytes) > 64 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(entry.sha256)) fail();
        const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); retained.push({ fd, path, before });
        if (!stable(before, fstatSync(fd, { bigint: true }))) fail(); const content = createHash("sha256"), buffer = Buffer.alloc(65536); let position = 0;
        while (position < entry.bytes) { check(); const count = readSync(fd, buffer, 0, Math.min(buffer.length, entry.bytes - position), position);
          if (!count) fail(); content.update(buffer.subarray(0, count)); position += count;
        }
        if (readSync(fd, buffer, 0, 1, position)) fail(); const sha256 = content.digest("hex"); if (sha256 !== entry.sha256) fail();
        observedFiles.set(entry.path, { bytes: position, sha256, mode: entry.mode });
        facts.push([entry.path, String(before.dev), String(before.ino), String(before.mode), String(before.uid), String(before.gid), String(before.nlink), String(before.size), String(before.mtimeNs), String(before.ctimeNs), sha256]);
      } else fail();
    }
    const outputPath = join(root, "node_modules"), output = lstatSync(outputPath, { bigint: true });
    if (!output.isDirectory() || output.isSymbolicLink() || output.uid !== BigInt(outputOwnerUid) || (output.mode & 0o7777n) !== 0o755n) fail();
    const outputFd = openSync(outputPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); retained.push({ fd: outputFd, path: outputPath, before: output });
    facts.push(["node_modules", String(output.dev), String(output.ino), String(output.mode), String(output.uid), String(output.gid)]);
    const file = (path: string) => { const value = observedFiles.get(path); if (!value) fail(); return value; };
    const c = stage.commitment;
    const wantedFiles = new Set(["package.json", c.lockName]), wantedDirectories = new Set([""]);
    const parent = (path: string): void => { if (!path || path === ".") return; coordinate(path); wantedDirectories.add(path); parent(dirname(path)); };
    for (const local of c.packages) { parent(local.path); wantedFiles.add(local.path + "/package.json");
      for (const path of local.directories) parent(local.path + "/" + path);
      for (const copied of local.files) { wantedFiles.add(local.path + "/" + copied.path); parent(dirname(local.path + "/" + copied.path)); }
    }
    if (wantedFiles.size !== observedFiles.size || [...observedFiles.keys()].some(path => !wantedFiles.has(path)) ||
        entries.filter(entry => entry.kind === HostedDependencyStageEntryKind.Directory).length !== wantedDirectories.size ||
        [...wantedDirectories].some(path => expected.get(path)?.kind !== HostedDependencyStageEntryKind.Directory)) fail();
    if (![1, 2].includes(c.version) || Object.keys(c).sort().join(",") !==
        (c.version === 2 ? "edges,layout,lock,lockName,packages,registrySelection,root,version" : "edges,layout,lock,lockName,packages,root,version")) fail();
    if (c.version === 2) {
      const selection = c.registrySelection;
      if (!selection || Object.keys(selection).sort().join(",") !== "absentOptionalPeers,arch,excludedScriptPackages,libc,platform,revision" ||
          selection.revision !== "linux_x64_glibc_optional_absent_v1" || selection.platform !== "linux" || selection.arch !== "x64" || selection.libc !== "glibc" ||
          !Array.isArray(selection.excludedScriptPackages) || !Array.isArray(selection.absentOptionalPeers) ||
          !selection.excludedScriptPackages.length && !selection.absentOptionalPeers.length) fail();
      if (selection.excludedScriptPackages.length > 8192 || selection.absentOptionalPeers.length > 8192 ||
          selection.excludedScriptPackages.some(path => typeof path !== "string" || path.length > 4096 || !path.startsWith("node_modules/"))) fail();
      for (const peer of selection.absentOptionalPeers) {
        if (!peer || Object.keys(peer).sort().join(",") !== "declaringPath,name,resolutionSearchPaths,spec" ||
            typeof peer.declaringPath !== "string" || typeof peer.name !== "string" || typeof peer.spec !== "string" || peer.spec.length > 4096 ||
            !Array.isArray(peer.resolutionSearchPaths) || peer.resolutionSearchPaths.length > 128 ||
            peer.resolutionSearchPaths.some(path => typeof path !== "string" || path.length > 4096 || !path.startsWith("node_modules/"))) fail();
      }
    }
    const actual = { version: c.version, lockName: c.lockName, root: file("package.json").sha256, lock: file(c.lockName).sha256,
      layout: c.layout, packages: c.packages.map(local => ({ path: local.path, kind: local.kind, package: file(local.path + "/package.json").sha256,
        directories: local.directories, files: local.files.map(copied => { const value = file(local.path + "/" + copied.path);
          return { path: copied.path, mode: value.mode, bytes: value.bytes, sha256: value.sha256 }; }) })), edges: c.edges, ...(c.version === 2 ? { registrySelection: c.registrySelection } : {}) };
    if (hash(Buffer.from(JSON.stringify(actual) + "\n")) !== inputSha256 || JSON.stringify(actual) !== JSON.stringify(c)) fail();
    // Re-enumerate after all content reads to deny an added/removed input.
    for (const entry of entries) if (entry.kind === HostedDependencyStageEntryKind.Directory) {
      const children = childrenByPath.get(entry.path) ?? [];
      if (JSON.stringify(names(join(root, entry.path))) !== JSON.stringify(children)) fail();
    }
    for (const item of retained) { check(); if (!stable(item.before, fstatSync(item.fd, { bigint: true })) || !stable(item.before, lstatSync(item.path, { bigint: true }))) fail(); }
    return JSON.stringify(facts);
  } finally { let failed = false; for (const item of retained.reverse()) { try { closeSync(item.fd); } catch { failed = true; } } if (failed) fail(); }
}
/** Copies only already-qualified finite bytes into a newly created empty TEST
 * or protected stage. It grants no authority and never reads an original path. */
export function writeHostedDependencyLocalStage(root: string, stage: HostedDependencyLocalStage, files: readonly HostedDependencyLocalStageFile[]): void {
  const byPath = new Map(files.map(file => [file.path, file]));
  if (byPath.size !== files.length) fail();
  for (const entry of stage.entries) {
    if (!entry.path) continue; coordinate(entry.path);
    if (entry.kind === HostedDependencyStageEntryKind.Directory) mkdirSync(join(root, entry.path), { mode: 0o755 });
    else {
      const file = byPath.get(entry.path); if (!file || file.mode !== entry.mode || file.bytes.length !== entry.bytes || hash(file.bytes) !== entry.sha256) fail();
      const fd = openSync(join(root, entry.path), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, entry.mode);
      try { fchmodSync(fd, entry.mode); writeFileSync(fd, file.bytes); fsyncSync(fd); } finally { closeSync(fd); }
      byPath.delete(entry.path);
    }
  }
  if (byPath.size) fail();
  for (const entry of stage.entries) if (entry.kind === HostedDependencyStageEntryKind.Directory) {
    const fd = openSync(join(root, entry.path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fchmodSync(fd, entry.mode); fsyncSync(fd); } finally { closeSync(fd); }
  }
}
