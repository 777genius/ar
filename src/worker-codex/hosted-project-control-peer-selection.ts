import { hostedDependencySystemdRunExecutable } from "../provider-codex/app-server/adapters/hosted-dependency-systemd-command.js";

/** Factual selection only. The original receiver separately authenticates and
 * retains these exact bytes, physical aliases, ELF files and original custody.
 * No IO, discovery, spawn, callback, membership or authority is provided here. */
export enum OriginalFullPeerSelectionHeld { Metadata = "original_full_peer_metadata_held", Path = "original_full_peer_path_held", Alias = "original_full_peer_alias_held" }
export enum OriginalFullPeerPackageArchitecture { Amd64 = "amd64", All = "all" }
export enum OriginalFullPeerPriorKind { Symlink = "symlink", Directory = "directory" }
export type OriginalFullPeerFileSelection = Readonly<{ path: string; sha256: string }>;
export type OriginalFullPeerAliasSelection = Readonly<{ path: string; target: string }>;
export type OriginalFullPeerNodeRequirement = Readonly<{ soname: string; sha256: string; package: string }>;
export type OriginalFullPeerSelection = Readonly<{ nodeSha256: string; nodeRequirements: readonly OriginalFullPeerNodeRequirement[];
  signedElfs: readonly OriginalFullPeerFileSelection[]; aliases: readonly OriginalFullPeerAliasSelection[] }>;
export type OriginalFullResolvedPeerSelection = Readonly<{ path: string; sha256: string; aliases: readonly OriginalFullPeerAliasSelection[] }>;
const lib = "/usr/lib/x86_64-linux-gnu/", loader = lib + "ld-linux-x86-64.so.2", interpreter = "/lib64/ld-linux-x86-64.so.2", ss = "/usr/bin/ss";
const maxMetadata = 256 * 1024, maxElfs = 4096, maxAliases = 1024, maxEdges = 16;
const topAliases = ["bin", "sbin", "lib", "lib64"] as const;
const tools = ["/usr/bin/dbus-daemon", ss, "/usr/bin/setpriv", hostedDependencySystemdRunExecutable, "/usr/bin/tini", "/usr/bin/unshare", "/usr/bin/busctl"] as const;
// The original assembler's finite pinned-Node linkage/package selection.
const nodePackages: Readonly<Record<string, string>> = Object.freeze({ "libstdc++.so.6": "libstdc++6", "libgcc_s.so.1": "libgcc-s1", "libc.so.6": "libc6",
  "libm.so.6": "libc6", "libpthread.so.0": "libc6", "libdl.so.2": "libc6", "librt.so.1": "libc6", "ld-linux-x86-64.so.2": "libc6", "libatomic.so.1": "libatomic1", "libz.so.1": "zlib1g" });
function check(value: unknown, reason = OriginalFullPeerSelectionHeld.Metadata): asserts value { if (!value) throw new Error(reason); }
function object(value: unknown, keys: string): Record<string, unknown> {
  check(value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype &&
    Reflect.ownKeys(value).length === keys.split(",").length && keys.split(",").every(key => Object.hasOwn(value, key) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value")));
  return value as Record<string, unknown>;
}
function json(bytes: Buffer): unknown {
  check(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= maxMetadata);
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error(OriginalFullPeerSelectionHeld.Metadata); }
  check(bytes.equals(Buffer.from(JSON.stringify(value) + "\n"))); return value;
}
function digest(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function natural(value: unknown, positive = false): value is string { return typeof value === "string" && /^(?:0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= 18446744073709551615n && (!positive || value !== "0"); }
function soname(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 255 && /^[A-Za-z0-9_+.-]+$/.test(value) && value !== "." && value !== ".."; }
function packageName(value: unknown): value is string { return typeof value === "string" && value.length <= 255 && /^[a-z0-9][a-z0-9+.-]*$/.test(value); }
function path(value: unknown): value is string { return typeof value === "string" && value.length <= 4096 && /^\/(?:[A-Za-z0-9_+.-]+\/)*[A-Za-z0-9_+.-]+$/.test(value) && !value.split("/").some(part => part === "." || part === ".."); }
function libraryPath(value: string): boolean { return value.startsWith(lib) && soname(value.slice(lib.length)); }
function intermediate(value: string): boolean {
  return libraryPath(value) || value === ss || value === interpreter || value === "/usr/lib64/ld-linux-x86-64.so.2" ||
    value.startsWith("/lib/x86_64-linux-gnu/") && soname(value.slice("/lib/x86_64-linux-gnu/".length));
}
function pins(input: unknown): readonly OriginalFullPeerFileSelection[] {
  check(Array.isArray(input) && input.length > 0 && input.length <= maxElfs);
  const seen = new Set<string>();
  return Object.freeze(input.map(value => {
    const row = object(value, "path,sha256"); check(path(row.path) && /^\/usr\/(?:lib|bin)\//.test(row.path) && digest(row.sha256) && !seen.has(row.path));
    seen.add(row.path); return Object.freeze({ path: row.path, sha256: row.sha256 });
  }));
}
/** Lexical normalization refuses escape above the selected guest root. */
function aliasTarget(alias: OriginalFullPeerAliasSelection, suffix: readonly string[] = []): string {
  check(typeof alias.target === "string" && alias.target.length > 0 && Buffer.byteLength(alias.target) <= 4096 && /^[A-Za-z0-9_+./-]+$/.test(alias.target), OriginalFullPeerSelectionHeld.Alias);
  const parts = (alias.target.startsWith("/") ? alias.target : alias.path.slice(0, alias.path.lastIndexOf("/")) + "/" + alias.target).split("/");
  const normalized: string[] = [];
  for (const part of [...parts, ...suffix]) {
    if (part === "" || part === ".") continue;
    if (part === "..") { check(normalized.length > 0, OriginalFullPeerSelectionHeld.Alias); normalized.pop(); }
    else normalized.push(part);
  }
  const result = "/" + normalized.join("/"); check(path(result), OriginalFullPeerSelectionHeld.Alias); return result;
}
function aliases(input: unknown, signed: readonly OriginalFullPeerFileSelection[]): readonly OriginalFullPeerAliasSelection[] {
  check(Array.isArray(input) && input.length >= 4 && input.length <= maxAliases);
  const signedPaths = new Set(signed.map(row => row.path)); let previous = "";
  const rows = input.map(value => {
    const row = object(value, "path,target"); check(path(row.path) && row.path > previous && typeof row.target === "string" && !signedPaths.has(row.path));
    check(topAliases.some(name => row.path === "/" + name) || libraryPath(row.path) || row.path === "/usr/lib64/ld-linux-x86-64.so.2");
    previous = row.path; const alias = Object.freeze({ path: row.path, target: row.target }), target = aliasTarget(alias);
    if (topAliases.some(name => alias.path === "/" + name)) check(alias.target === "usr" + alias.path && target === "/usr" + alias.path);
    else check(intermediate(target), OriginalFullPeerSelectionHeld.Alias);
    return alias;
  });
  for (const name of topAliases) check(rows.some(row => row.path === "/" + name && row.target === "usr/" + name));
  return Object.freeze(rows);
}

/** A resolved tuple is DATA, never an authenticated file/custody handle. */
export function resolveOriginalFullPeerSelection(selection: OriginalFullPeerSelection, logicalPath: string): OriginalFullResolvedPeerSelection {
  object(selection, "nodeSha256,nodeRequirements,signedElfs,aliases"); check(digest(selection.nodeSha256));
  check(path(logicalPath) && (logicalPath === ss || logicalPath === loader || logicalPath === interpreter || libraryPath(logicalPath)), OriginalFullPeerSelectionHeld.Path);
  check(Array.isArray(selection.nodeRequirements) && selection.nodeRequirements.length > 1 && selection.nodeRequirements.length <= 32);
  const needed = new Set<string>();
  for (const value of selection.nodeRequirements) {
    const row = object(value, "soname,sha256,package");
    check(soname(row.soname) && digest(row.sha256) && packageName(row.package) && Object.hasOwn(nodePackages, row.soname) && nodePackages[row.soname] === row.package && !needed.has(row.soname));
    needed.add(row.soname);
  }
  check(needed.has("ld-linux-x86-64.so.2"));
  const signed = pins(selection.signedElfs), edges = aliases(selection.aliases, signed);
  return resolveRoute(signed, edges, logicalPath);
}
function resolveRoute(signed: readonly OriginalFullPeerFileSelection[], edges: readonly OriginalFullPeerAliasSelection[], logicalPath: string): OriginalFullResolvedPeerSelection {
  const byAlias = new Map(edges.map(row => [row.path, row]));
  const chain: OriginalFullPeerAliasSelection[] = [], visited = new Set<string>(); let current = logicalPath;
  for (;;) {
    check(intermediate(current) && !visited.has(current), OriginalFullPeerSelectionHeld.Alias); visited.add(current);
    const components = current.slice(1).split("/"); let edge: OriginalFullPeerAliasSelection | undefined, suffix: readonly string[] = [];
    for (let i = 0; i < components.length; i++) {
      edge = byAlias.get("/" + components.slice(0, i + 1).join("/"));
      if (edge) { suffix = components.slice(i + 1); break; }
    }
    if (!edge) break;
    check(chain.length < maxEdges, OriginalFullPeerSelectionHeld.Alias); chain.push(edge); current = aliasTarget(edge, suffix);
  }
  check(current === ss || libraryPath(current), OriginalFullPeerSelectionHeld.Path);
  if (logicalPath === ss) check(current === ss, OriginalFullPeerSelectionHeld.Path);
  if (logicalPath === loader || logicalPath === interpreter) check(current === loader, OriginalFullPeerSelectionHeld.Path);
  const selected = signed.find(row => row.path === current); check(selected, OriginalFullPeerSelectionHeld.Path);
  return Object.freeze({ path: selected.path, sha256: selected.sha256, aliases: Object.freeze(chain) });
}

export function decodeOriginalFullPeerSelection(elfPinsBytes: Buffer, packagesBytes: Buffer, aliasesBytes: Buffer): OriginalFullPeerSelection {
  const elf = object(json(elfPinsBytes), "schemaVersion,pins"); check(elf.schemaVersion === 1); const signedElfs = pins(elf.pins), signed = new Map(signedElfs.map(row => [row.path, row.sha256]));
  const packages = object(json(packagesBytes), "schemaVersion,release,releases,packages,usrLayout,pinnedNode");
  const aliasData = object(json(aliasesBytes), "schemaVersion,packages,aliases");
  check(packages.schemaVersion === 1 && packages.release === "ubuntu-noble" && aliasData.schemaVersion === 1 && JSON.stringify(packages.packages) === JSON.stringify(aliasData.packages));
  check(Array.isArray(packages.releases) && packages.releases.length === 3); const releaseNames = new Set<string>();
  for (const value of packages.releases) {
    const row = object(value, "name,sha256"); check(typeof row.name === "string" && row.name.length <= 255 && /^[A-Za-z0-9_.+-]+_InRelease$/.test(row.name) && digest(row.sha256) && !releaseNames.has(row.name)); releaseNames.add(row.name);
  }
  check(Array.isArray(packages.packages) && packages.packages.length > 0 && packages.packages.length <= 256); const packageNames = new Set<string>();
  for (const value of packages.packages) {
    const row = object(value, "package,version,arch,sha256,size"); check(packageName(row.package) && !packageNames.has(row.package) && typeof row.version === "string" &&
      row.version.length > 0 && row.version.length <= 255 && /^[A-Za-z0-9.+:~_-]+$/.test(row.version) && (row.arch === OriginalFullPeerPackageArchitecture.Amd64 || row.arch === OriginalFullPeerPackageArchitecture.All) &&
      digest(row.sha256) && typeof row.size === "number" && Number.isSafeInteger(row.size) && row.size > 0 && row.size <= 512 * 1024 * 1024); packageNames.add(row.package);
  }
  const iproute = packages.packages.map(value => object(value, "package,version,arch,sha256,size")).filter(row => row.package === "iproute2");
  check(iproute.length === 1 && iproute[0]!.version === "6.1.0-1ubuntu6.4" && iproute[0]!.arch === OriginalFullPeerPackageArchitecture.Amd64);
  const usr = object(packages.usrLayout, "aliases,movedEntries,movedBytes,movedManifestSha256,tools");
  check(Array.isArray(usr.aliases) && usr.aliases.length === 4 && Number.isSafeInteger(usr.movedEntries) && Number(usr.movedEntries) >= 0 && Number(usr.movedEntries) <= 20000 &&
    natural(usr.movedBytes) && BigInt(usr.movedBytes) <= 512n * 1024n * 1024n && digest(usr.movedManifestSha256));
  let moved = 0;
  for (const [i, value] of usr.aliases.entries()) {
    const row = object(value, "alias,target,priorKind,movedEntries"), name = topAliases[i]!;
    check(row.alias === "/" + name && row.target === "/usr/" + name && (row.priorKind === OriginalFullPeerPriorKind.Symlink || row.priorKind === OriginalFullPeerPriorKind.Directory) &&
      Number.isSafeInteger(row.movedEntries) && Number(row.movedEntries) >= 0 && Number(row.movedEntries) <= 20000 &&
      (row.priorKind !== OriginalFullPeerPriorKind.Symlink || row.movedEntries === 0)); moved += Number(row.movedEntries);
  }
  check(moved === usr.movedEntries && Array.isArray(usr.tools) && usr.tools.length === tools.length);
  for (const [i, value] of usr.tools.entries()) {
    const row = object(value, "path,sha256,dev,ino,mode,bytes"); check(row.path === tools[i] && digest(row.sha256) && signed.get(String(row.path)) === row.sha256 &&
      natural(row.dev) && natural(row.ino, true) && typeof row.mode === "number" && Number.isInteger(row.mode) && row.mode >= 0 && row.mode <= 0o7777 && !(row.mode & 0o022) && !!(row.mode & 0o111) &&
      natural(row.bytes, true) && BigInt(row.bytes) <= 32n * 1024n * 1024n);
  }
  const node = object(packages.pinnedNode, "sha256,version,requirements,requiredPackages");
  check(digest(node.sha256) && node.version === "v22.23.3" && Array.isArray(node.requirements) && node.requirements.length > 1 && node.requirements.length <= 32 &&
    Array.isArray(node.requiredPackages) && node.requiredPackages.length > 0 && node.requiredPackages.length <= 32);
  const needed = new Set<string>(), required = new Set<string>();
  const nodeRequirements = Object.freeze(node.requirements.map(value => {
    const row = object(value, "soname,sha256,package"); check(soname(row.soname) && digest(row.sha256) && packageName(row.package) && Object.hasOwn(nodePackages, row.soname) &&
      nodePackages[row.soname] === row.package && packageNames.has(row.package) && !needed.has(row.soname)); needed.add(row.soname); required.add(row.package);
    return Object.freeze({ soname: row.soname, sha256: row.sha256, package: row.package });
  }));
  check(needed.has("ld-linux-x86-64.so.2") && JSON.stringify(node.requiredPackages) === JSON.stringify([...required].sort()));
  const selection = Object.freeze({ nodeSha256: node.sha256, nodeRequirements, signedElfs, aliases: aliases(aliasData.aliases, signedElfs) });
  resolveOriginalFullPeerSelection(selection, ss); resolveOriginalFullPeerSelection(selection, loader); resolveOriginalFullPeerSelection(selection, interpreter);
  for (const requirement of nodeRequirements) check(resolveOriginalFullPeerSelection(selection, lib + requirement.soname).sha256 === requirement.sha256);
  // Every captured non-layout edge must close to a signed selected leaf, even
  // when a copied catalogue adds an otherwise unused cycle or missing edge.
  for (const edge of selection.aliases) if (!topAliases.some(name => edge.path === "/" + name)) resolveRoute(signedElfs, selection.aliases, edge.path);
  return selection;
}
