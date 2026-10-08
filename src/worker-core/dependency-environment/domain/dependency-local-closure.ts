import { detectSecretLikeContent } from "../../secret-detection";
import {
  DependencyInstallKeyError, DependencyInstallKeyFailure as Failure, DependencyInstallProfile,
  dependencyTestNpmArgv, DependencyInstallArchitecture, DependencyLibcFamily, type DependencyTestNpmToolchain, type DependencyTestNpmInstallKeyInput,
} from "./dependency-install-key";

export enum DependencyLocalClosureKind { PureWorkspaceLink = "pure_workspace_link", PackedDirectory = "packed_directory" }
export enum DependencyLocalInstallLayout { RootOnly = "root_only", RootWithLiteralWorkspaceInputs = "root_with_literal_workspace_inputs" }
export enum DependencyLocalResolutionBase { SourceDirectory = "source_directory" }
export enum DependencyLocalEdgeField {
  Dependencies = "dependencies", DevDependencies = "devDependencies", OptionalDependencies = "optionalDependencies",
  PeerDependencies = "peerDependencies", Workspace = "workspace",
}
export type DependencyLocalCopiedFile = { readonly path: string; readonly mode: number; readonly bytes: Uint8Array };
export type DependencyLocalPackage = {
  readonly path: string; readonly kind: DependencyLocalClosureKind; readonly packageBytes: Uint8Array;
  /** Captured literal pack directories, including empty selectors. */
  readonly directories: readonly string[];
  /** Relative to this package. package.json is represented by packageBytes. */
  readonly files: readonly DependencyLocalCopiedFile[];
};
export type DependencyLocalEdge = {
  readonly declaringPath: string; readonly field: DependencyLocalEdgeField; readonly name: string; readonly spec: string;
  readonly resolutionBase: DependencyLocalResolutionBase; readonly targetPath: string;
  readonly kind: DependencyLocalClosureKind; readonly installedPaths: readonly string[];
};
/** Logical observed inputs only. This DTO does not authorize reads, installation,
 * source links, Ready or effects. Physical custody is a separate adapter fact. */
export enum DependencyLocalRegistrySelectionRevision { LinuxX64GlibcOptionalAbsentV1 = "linux_x64_glibc_optional_absent_v1" }
export type DependencyLocalRegistrySelection = {
  readonly revision: DependencyLocalRegistrySelectionRevision.LinuxX64GlibcOptionalAbsentV1;
  readonly platform: "linux"; readonly arch: DependencyInstallArchitecture.X64; readonly libc: DependencyLibcFamily.Glibc;
  readonly excludedScriptPackages: readonly string[];
  readonly absentOptionalPeers: readonly { readonly declaringPath: string; readonly name: string; readonly spec: string;
    readonly resolutionSearchPaths: readonly string[] }[];
};
type DependencyNpmLocalClosureBody = { readonly profile: DependencyInstallProfile.TestNpmLocalNoLifecycleV1;
  readonly layout: DependencyLocalInstallLayout; readonly packages: readonly DependencyLocalPackage[];
  readonly edges: readonly DependencyLocalEdge[];
};
export type DependencyNpmLocalClosure = DependencyNpmLocalClosureBody & (
  { readonly version: 1 } | { readonly version: 2; readonly registrySelection: DependencyLocalRegistrySelection });
export type DependencyTestNpmLocalInstallKeyInput = DependencyTestNpmInstallKeyInput & { readonly closure: DependencyNpmLocalClosure };
export type DependencyLocalInstallKey = {
  readonly profile: DependencyInstallProfile.TestNpmLocalNoLifecycleV1; readonly canonicalBytes: Uint8Array; readonly installKey: string;
};
export type DependencyLocalManifest = {
  readonly name: string; readonly version: string; readonly workspaces: readonly string[];
  readonly dependencies: readonly { readonly field: DependencyLocalEdgeField; readonly name: string; readonly spec: string }[];
  readonly files: readonly string[]; readonly requiredFiles: readonly string[];
  readonly raw: Readonly<Record<string, unknown>>;
};
function fail(reason: Failure = Failure.UnsupportedClosure): never { throw new DependencyInstallKeyError(reason); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(Failure.InvalidInputs);
  return value as Record<string, unknown>;
}
function allowed(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) fail();
}
export const dependencyLocalPackageName = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/;
const installedPath = /^node_modules\/(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+(?:\/node_modules\/(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)*$/;
const version = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?$/;
const registrySpec = /^[0-9xX*~^<>=| .+-]+$/;
const fields = [DependencyLocalEdgeField.Dependencies, DependencyLocalEdgeField.DevDependencies,
  DependencyLocalEdgeField.OptionalDependencies, DependencyLocalEdgeField.PeerDependencies] as const;
const lifecycle = new Set(["preinstall", "install", "postinstall", "prepublish", "preprepare", "prepare", "postprepare",
  "prepack", "pack", "postpack", "prepublishOnly", "publish", "postpublish"]);
const manifestKeys = ["name", "version", "private", "description", "license", ...fields, "peerDependenciesMeta", "engines", "os", "cpu",
  "libc", "main", "module", "type", "exports", "files", "author", "repository", "keywords", "homepage", "bugs", "funding",
  "scripts", "workspaces", "browser", "bin"];
const lockKeys = ["name", "version", "resolved", "integrity", "dev", "optional", "devOptional", "peer", "license", "deprecated",
  ...fields, "peerDependenciesMeta", "engines", "os", "cpu", "libc", "bin", "funding", "hasInstallScript", "link", "workspaces"];

/** Closed selectors use canonical ASCII coordinates; observed descendant file
 * names may be any round-trippable UTF-8 name without control/glob characters. */
export function validateDependencyLocalPath(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value || value.length > 4096 ||
      !/^[a-zA-Z0-9._@+-]+(?:\/[a-zA-Z0-9._@+-]+)*$/.test(value) ||
      detectSecretLikeContent(value) || value.split("/").some((part) => part === "." || part === ".." || part === "node_modules" || part === ".git")) fail();
}
function observedPath(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value || value.length > 4096 || /[\x00-\x1f\x7f\\*?!\[\]{}]/.test(value) ||
      detectSecretLikeContent(value) || value.split("/").some((part) => !part || part === "." || part === ".." || part === "node_modules" || part === ".git")) fail();
}
const credential = /(?:auth(?:token)?|authorization|cookie|credentials?|api[-_]?key|token|secret|password|passwd|private[-_]?key)$/i;
function scanString(value: string): void {
  if (detectSecretLikeContent(value)) fail();
  if (value.includes("://")) {
    let url: URL; try { url = new URL(value); } catch { return; }
    if (url.username || url.password || [...url.searchParams.keys()].some((key) => /auth|token|secret|password|key/i.test(key))) fail();
  }
}
// Linear lexical scan preserves values discarded by JSON.parse. Metadata
// refuses duplicate members while retaining dependency-name map semantics.
function scanJsonTokens(text: string, rejectCredentialKeys: boolean, rejectDuplicates: boolean): void {
  let offset = 0, tokens = 0, structure = 0, depth = 0;
  const objects: Set<string>[] = [];
  while (offset < text.length) {
    if (text[offset] !== '"') {
      if ("{}[],:".includes(text[offset]!)) {
        if (++structure > 65536) fail(Failure.InvalidInputs);
        if (text[offset] === "{" || text[offset] === "[") { if (++depth > 128) fail(Failure.InvalidInputs); }
        else if (text[offset] === "}" || text[offset] === "]") depth = Math.max(0, depth - 1);
      }
      if (rejectDuplicates && text[offset] === "{") objects.push(new Set());
      else if (rejectDuplicates && text[offset] === "}") objects.pop();
      offset++; continue;
    }
    const start = offset++; let closed = false;
    while (offset < text.length) {
      if (text[offset] === "\\") { offset += 2; continue; }
      if (text[offset++] === '"') { closed = true; break; }
    }
    if (!closed) break;
    if (++tokens > 65536) fail(Failure.InvalidInputs);
    let decoded: unknown; try { decoded = JSON.parse(text.slice(start, offset)); } catch { continue; }
    if (typeof decoded !== "string") continue;
    scanString(decoded);
    let next = offset; while (next < text.length && /\s/.test(text[next]!)) next++;
    if (text[next] === ":") {
      if (rejectCredentialKeys && credential.test(decoded)) fail();
      if (rejectDuplicates) {
        const current = objects.at(-1); if (current?.has(decoded)) fail(); current?.add(decoded);
      }
    }
  }
}
/** Original copied data is validated before it can enter a digest or stage.
 * Buffer detection deliberately retains the global reject-opaque policy. */
export function validateDependencyLocalCopiedInput(bytes: Uint8Array, path: string): void {
  observedPath(path);
  if (!(bytes instanceof Uint8Array) || detectSecretLikeContent(Buffer.from(bytes))) fail();
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (/["'](?:auth(?:token)?|credentials?|api[-_]?key|token|secret|password|private[-_]?key)["']\s*:/.test(text)) fail();
  scanJsonTokens(text, true, false);
  const candidate = text.trimStart();
  if (!path.toLowerCase().endsWith(".json") && !["{", "[", '"'].includes(candidate[0] ?? "")) return;
  let decoded: unknown;
  try { decoded = JSON.parse(text); }
  catch { if (path.toLowerCase().endsWith(".json")) fail(); return; }
  const pending: unknown[] = [decoded]; let visited = 0;
  while (pending.length) {
    if (++visited > 65536) fail(Failure.InvalidInputs);
    const value = pending.pop();
    if (typeof value === "string") {
      scanString(value);
    } else if (Array.isArray(value)) {
      if (value.length + pending.length > 65536) fail(Failure.InvalidInputs);
      for (const item of value) pending.push(item);
    }
    else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) {
      if (detectSecretLikeContent(key) || credential.test(key)) fail();
      pending.push(item);
      if (pending.length > 65536) fail(Failure.InvalidInputs);
    }
  }
}
export function resolveDependencyLocalFileSpec(declaringPath: string, spec: string): string {
  if (!spec.startsWith("file:") || spec.length > 4096) fail();
  const raw = spec.slice(5);
  if (!raw || raw.startsWith("/") || !/^[a-zA-Z0-9._@+-]+(?:\/[a-zA-Z0-9._@+-]+)*$/.test(raw)) fail();
  const parts = declaringPath ? declaringPath.split("/") : [];
  for (const part of raw.split("/")) {
    if (part === ".") continue;
    if (part === "..") { if (!parts.length) fail(); parts.pop(); }
    else parts.push(part);
  }
  const result = parts.join("/"); validateDependencyLocalPath(result); return result;
}
function parse(bytes: Uint8Array): Record<string, unknown> {
  if (!(bytes instanceof Uint8Array) || !bytes.length) fail(Failure.InvalidInputs);
  let text: string, value: unknown;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return fail(Failure.InvalidInputs); }
  if (detectSecretLikeContent(text)) fail();
  scanJsonTokens(text, false, true);
  try { value = JSON.parse(text); } catch { return fail(Failure.InvalidInputs); }
  const names = new Set<string>([...fields, "peerDependenciesMeta", "bin"]);
  const pending = [{ value, nameMap: false, packageMap: false, installRecord: true }];
  let visited = 0;
  while (pending.length) {
    if (++visited > 65536) fail(Failure.InvalidInputs);
    const frame = pending.pop()!;
    if (typeof frame.value === "string") {
      if (detectSecretLikeContent(frame.value)) fail();
      if (frame.value.includes("://")) {
        let url: URL; try { url = new URL(frame.value); } catch { continue; }
        if (url.username || url.password || [...url.searchParams.keys()].some((key) => /auth|token|secret|password|key/i.test(key))) fail();
      }
    } else if (Array.isArray(frame.value)) {
      if (frame.value.length + pending.length > 65536) fail(Failure.InvalidInputs);
      for (const value of frame.value) pending.push({ value, nameMap: false, packageMap: false, installRecord: false });
    } else if (frame.value && typeof frame.value === "object") {
      for (const [key, value] of Object.entries(frame.value)) {
        if (detectSecretLikeContent(key) || (!frame.nameMap && !frame.packageMap &&
            /(?:auth(?:token)?|authorization|cookie|credentials?|api[-_]?key|token|secret|password|passwd|private[-_]?key)$/i.test(key))) fail();
        pending.push({ value, installRecord: frame.packageMap,
          nameMap: frame.installRecord && names.has(key), packageMap: frame.installRecord && key === "packages" });
        if (pending.length > 65536) fail(Failure.InvalidInputs);
      }
    }
  }
  return object(value);
}
function dependencies(raw: Record<string, unknown>): DependencyLocalManifest["dependencies"] {
  return fields.flatMap((field) => raw[field] === undefined ? [] : Object.entries(object(raw[field])).map(([name, spec]) => {
    if (!dependencyLocalPackageName.test(name) || typeof spec !== "string" || !spec.trim() || spec.length > 4096 ||
        (!spec.startsWith("file:") && !registrySpec.test(spec))) fail();
    return { field, name, spec };
  }));
}
export function describeDependencyLocalManifest(bytes: Uint8Array, kind?: DependencyLocalClosureKind): DependencyLocalManifest {
  const raw = parse(bytes); allowed(raw, manifestKeys);
  if (typeof raw.name !== "string" || !dependencyLocalPackageName.test(raw.name) ||
      typeof raw.version !== "string" || !version.test(raw.version)) fail();
  if (raw.scripts !== undefined) for (const [name, command] of Object.entries(object(raw.scripts))) {
    if (lifecycle.has(name) || typeof command !== "string") fail();
  }
  if (kind !== undefined && raw.workspaces !== undefined) fail();
  const workspaces = raw.workspaces === undefined ? [] : raw.workspaces;
  if (!Array.isArray(workspaces) || workspaces.length > 128) fail();
  for (const path of workspaces) validateDependencyLocalPath(path);
  if (new Set(workspaces).size !== workspaces.length) fail();
  const copied = kind === DependencyLocalClosureKind.PackedDirectory;
  if (!copied && raw.bin !== undefined) fail();
  const files = raw.files === undefined ? [] : raw.files;
  if (copied && !Array.isArray(raw.files)) fail();
  if (!Array.isArray(files) || files.length > 256) fail();
  for (const path of files) validateDependencyLocalPath(path);
  if (new Set(files).size !== files.length) fail();
  const required: string[] = [];
  if (copied) {
    for (const key of ["main", "browser"]) if (raw[key] !== undefined) {
      validateDependencyLocalPath(raw[key]); required.push(raw[key]);
    }
    if (raw.bin !== undefined) {
      const bin = typeof raw.bin === "string" ? { [raw.name]: raw.bin } : object(raw.bin);
      for (const [name, path] of Object.entries(bin)) {
        if (!dependencyLocalPackageName.test(name)) fail(); validateDependencyLocalPath(path); required.push(path);
      }
    }
  }
  const deps = dependencies(raw);
  if (copied && deps.some((edge) => edge.spec.startsWith("file:"))) fail();
  return { name: raw.name, version: raw.version, workspaces: workspaces.slice(), dependencies: deps,
    files: files.slice(), requiredFiles: [...new Set(required)].sort(), raw };
}
export function dependencyLocalNpmArgv(layout: DependencyLocalInstallLayout): readonly string[] {
  if (layout === DependencyLocalInstallLayout.RootOnly) return dependencyTestNpmArgv;
  if (layout !== DependencyLocalInstallLayout.RootWithLiteralWorkspaceInputs) fail(Failure.UnsupportedProfile);
  return Object.freeze([...dependencyTestNpmArgv.slice(0, -1), "--workspaces=true", "--include-workspace-root=true"]);
}
/** Closed absent-peer syntax only, never version selection or satisfaction. */
function supportedAbsentPeerSyntax(spec: string): boolean {
  const text = spec.replace(/^ +| +$/g, ""); if (text === "*") return true;
  const atom = /^(?:\^|~|>=|<=|>|<|=)?(0|[1-9][0-9]{0,15})\.(0|[1-9][0-9]{0,15})\.(0|[1-9][0-9]{0,15})$/;
  return text.length > 0 && text.split("||").every(branch => {
    const trimmed = branch.replace(/^ +| +$/g, "");
    return trimmed.length > 0 && trimmed.split(/ +/).every(token => {
      const match = atom.exec(token); return !!match && match.slice(1).every(component => Number(component) <= 9007199254740990);
    });
  });
}
/** Fixed selection-only actual-graph recipe. Old graph and ci bytes stay intact. */
export function dependencyLocalRegistrySelectionVerificationArgv(layout: DependencyLocalInstallLayout): readonly string[] {
  const argv = ["ls", "--all", "--json", "--ignore-scripts", "--package-lock-only=false", "--install-strategy=hoisted", "--install-links=true",
    "--include=dev", "--include=optional", "--include=peer", "--strict-peer-deps=false", "--legacy-peer-deps=false", "--workspaces=false"];
  if (layout === DependencyLocalInstallLayout.RootOnly) return Object.freeze(argv);
  if (layout !== DependencyLocalInstallLayout.RootWithLiteralWorkspaceInputs) fail(Failure.UnsupportedProfile);
  return Object.freeze([...argv.slice(0, -1), "--workspaces=true", "--include-workspace-root=true"]);
}
function sameMap(a: unknown, b: unknown): boolean {
  const left = a === undefined ? {} : object(a), right = b === undefined ? {} : object(b);
  const keys = Object.keys(left).sort();
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
}
function sourceMatches(entry: Record<string, unknown>, manifest: DependencyLocalManifest, includeDev = true): void {
  if ((entry.name !== undefined && entry.name !== manifest.name) || entry.version !== manifest.version ||
      fields.some((field) => (includeDev || field !== DependencyLocalEdgeField.DevDependencies || entry[field] !== undefined) &&
        !sameMap(entry[field], manifest.raw[field]))) fail();
}
/** Reconstructs every admitted local edge from manifests and lock coordinates.
 * Supplied edges are compared with this result, never treated as authority. */
export function qualifyDependencyNpmLocalClosure(input: {
  readonly packageBytes: Uint8Array; readonly lockBytes: Uint8Array; readonly packages: readonly DependencyLocalPackage[];
  readonly selectionToolchain?: DependencyTestNpmToolchain;
}): DependencyNpmLocalClosure {
  const selection = input.selectionToolchain;
  if (selection && (selection.platform !== "linux" || selection.arch !== DependencyInstallArchitecture.X64 ||
      object(selection.libc).family !== DependencyLibcFamily.Glibc || selection.npmVersion !== "10.9.9")) fail(Failure.UnsupportedProfile);
  const excluded = new Set<string>(), registry = new Set<string>();
  const incoming = new Map<string, DependencyLocalEdgeField[]>();
  const absentOptionalPeers: DependencyLocalRegistrySelection["absentOptionalPeers"][number][] = [];
  const root = describeDependencyLocalManifest(input.packageBytes), lock = parse(input.lockBytes);
  allowed(lock, ["name", "version", "lockfileVersion", "requires", "packages"]);
  if (lock.lockfileVersion !== 3 || lock.name !== root.name || lock.version !== root.version ||
      !Array.isArray(input.packages) || input.packages.length > 128) fail();
  const records = object(lock.packages);
  if (!Object.hasOwn(records, "") || Object.keys(records).length > 8192) fail();
  const packages = new Map<string, { value: DependencyLocalPackage; manifest: DependencyLocalManifest }>();
  const names = new Set<string>();
  for (const value of input.packages) {
    allowed(object(value), ["path", "kind", "packageBytes", "directories", "files"]); validateDependencyLocalPath(value.path);
    if (!Object.values(DependencyLocalClosureKind).includes(value.kind) || !Array.isArray(value.files) || value.files.length > 8192 ||
        !Array.isArray(value.directories) || value.directories.length > 8192) fail();
    const manifest = describeDependencyLocalManifest(value.packageBytes, value.kind);
    if (packages.has(value.path) || names.has(manifest.name) || manifest.name === root.name ||
        (root.workspaces.includes(value.path) !== (value.kind === DependencyLocalClosureKind.PureWorkspaceLink))) fail();
    names.add(manifest.name); packages.set(value.path, { value, manifest });
    const seen = new Set<string>();
    if (value.kind === DependencyLocalClosureKind.PureWorkspaceLink && (value.files.length || value.directories.length)) fail();
    for (const path of value.directories) { observedPath(path); if (seen.has(path)) fail(); seen.add(path); }
    for (const file of value.files) {
      allowed(object(file), ["path", "mode", "bytes"]);
      observedPath(file.path);
      if (file.path === "package.json" || ![0o644, 0o755].includes(file.mode) || !(file.bytes instanceof Uint8Array) || seen.has(file.path)) fail();
      validateDependencyLocalCopiedInput(file.bytes, file.path);
      seen.add(file.path);
    }
  }
  const paths = [...packages.keys()];
  if (paths.some((path, i) => paths.some((other, j) => i !== j && other.startsWith(path + "/"))) ||
      root.workspaces.some((path) => !packages.has(path))) fail();
  const edges: DependencyLocalEdge[] = [];
  const referenced = new Set<string>();
  const installedLocal = new Map<string, string[]>();
  for (const [path, data] of Object.entries(records)) {
    const entry = object(data); allowed(entry, lockKeys);
    const scripted = entry.hasInstallScript !== undefined && entry.hasInstallScript !== false;
    if (scripted && (!selection || entry.hasInstallScript !== true)) fail();
    dependencies(entry);
    if (path === "") {
      if (scripted) fail();
      sourceMatches(entry, root);
      if (entry.resolved !== undefined || entry.integrity !== undefined || entry.link !== undefined ||
          JSON.stringify(entry.workspaces ?? []) !== JSON.stringify(root.workspaces)) fail();
      continue;
    }
    if (packages.has(path)) {
      if (scripted) fail();
      const local = packages.get(path)!;
      sourceMatches(entry, local.manifest, local.value.kind === DependencyLocalClosureKind.PureWorkspaceLink);
      if (entry.link !== undefined || entry.resolved !== undefined || entry.integrity !== undefined || entry.workspaces !== undefined) fail();
      continue;
    }
    if (!installedPath.test(path) || path.split("/").some((part) => part === "." || part === "..")) fail();
    if (entry.link === true) {
      if (scripted) fail();
      allowed(entry, ["resolved", "link"]);
      const target = typeof entry.resolved === "string" ? packages.get(entry.resolved) : undefined;
      if (!target || target.value.kind !== DependencyLocalClosureKind.PureWorkspaceLink ||
          path !== `node_modules/${target.manifest.name}` || !Object.hasOwn(records, target.value.path)) fail();
      installedLocal.set(target.value.path, [...(installedLocal.get(target.value.path) ?? []), path]);
    } else if (typeof entry.resolved === "string" && entry.resolved.startsWith("file:")) {
      if (scripted) fail();
      const targetPath = resolveDependencyLocalFileSpec("", entry.resolved), target = packages.get(targetPath);
      if (!target || target.value.kind !== DependencyLocalClosureKind.PackedDirectory) fail();
      sourceMatches(entry, target.manifest, false);
      if (entry.link !== undefined || entry.workspaces !== undefined || (entry.integrity !== undefined &&
          (typeof entry.integrity !== "string" || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(entry.integrity)))) fail();
      installedLocal.set(targetPath, [...(installedLocal.get(targetPath) ?? []), path]);
    } else {
      if (entry.link !== undefined || entry.workspaces !== undefined || typeof entry.resolved !== "string" ||
          typeof entry.integrity !== "string" || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(entry.integrity) ||
          dependencies(entry).some((edge) => edge.spec.startsWith("file:"))) fail();
      let url: URL; try { url = new URL(entry.resolved); } catch { return fail(); }
      if (url.origin !== "https://registry.npmjs.org" || url.username || url.password || url.search || url.hash || !url.pathname.endsWith(".tgz")) fail();
      registry.add(path);
      if (scripted) {
        const os = entry.os;
        const recognized = ["aix", "android", "darwin", "freebsd", "linux", "openbsd", "sunos", "win32"];
        if (["optional", "dev", "devOptional", "peer"].some(key => entry[key] !== undefined && typeof entry[key] !== "boolean") ||
            entry.cpu !== undefined || entry.libc !== undefined || entry.optional !== true || !Array.isArray(os) || !os.length || os.length > recognized.length ||
            os.some(value => typeof value !== "string" || !recognized.includes(value)) || new Set(os).size !== os.length ||
            os.includes("linux") || dependencies(entry).some(edge => edge.field !== DependencyLocalEdgeField.DevDependencies)) fail();
        excluded.add(path);
      }
    }
  }
  const sourceManifests = new Map([["", root], ...[...packages].map(([path, data]) => [path, data.manifest] as const)]);
  const searchPaths = (declaringPath: string, name: string): string[] => {
    const result: string[] = [];
    let path = declaringPath;
    while (true) {
      const candidate = `${path ? path + "/" : ""}node_modules/${name}`;
      result.push(candidate);
      if (!path) return result;
      path = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    }
  };
  const resolveEdge = (declaringPath: string, edge: DependencyLocalManifest["dependencies"][number], optionalPeer = false): string | undefined => {
    const candidates = searchPaths(declaringPath, edge.name);
    const found = candidates.find(path => Object.hasOwn(records, path));
    if (!found) {
      if (!optionalPeer) fail();
      absentOptionalPeers.push({ declaringPath, name: edge.name, spec: edge.spec, resolutionSearchPaths: candidates });
      return undefined;
    }
    incoming.set(found, [...(incoming.get(found) ?? []), edge.field]); return found;
  };
  for (const [declaringPath, manifest] of sourceManifests) {
    const packed = declaringPath && packages.get(declaringPath)!.value.kind === DependencyLocalClosureKind.PackedDirectory;
    for (const edge of manifest.dependencies) {
      // Arborist node.js:905-908 loads dev edges only for top/link targets;
      // ordinary packed dependencies have no installed development closure.
      if (packed && edge.field === DependencyLocalEdgeField.DevDependencies) continue;
      if (!edge.spec.startsWith("file:")) {
        const workspace = [...packages.values()].find((data) => data.manifest.name === edge.name &&
          data.value.kind === DependencyLocalClosureKind.PureWorkspaceLink);
        if (!workspace) {
          for (const location of packed ? installedLocal.get(declaringPath) ?? [] : [declaringPath]) resolveEdge(location, edge);
          continue;
        }
        if (packed) fail();
        if (edge.spec !== "*" && edge.spec !== workspace.manifest.version) fail();
        referenced.add(workspace.value.path);
        if (!installedLocal.get(workspace.value.path)?.includes(resolveEdge(declaringPath, edge)!)) fail();
        edges.push({ declaringPath, ...edge, resolutionBase: DependencyLocalResolutionBase.SourceDirectory,
          targetPath: workspace.value.path, kind: workspace.value.kind, installedPaths: installedLocal.get(workspace.value.path) ?? [] });
        continue;
      }
      if (declaringPath && packages.get(declaringPath)!.value.kind === DependencyLocalClosureKind.PackedDirectory) fail();
      const targetPath = resolveDependencyLocalFileSpec(declaringPath, edge.spec), target = packages.get(targetPath);
      if (!target || target.manifest.name !== edge.name) fail();
      if (!installedLocal.get(targetPath)?.includes(resolveEdge(declaringPath, edge)!)) fail();
      referenced.add(targetPath);
      edges.push({ declaringPath, ...edge, resolutionBase: DependencyLocalResolutionBase.SourceDirectory,
        targetPath, kind: target.value.kind, installedPaths: installedLocal.get(targetPath) ?? [] });
    }
  }
  for (const [path, raw] of Object.entries(records)) {
    if (!installedPath.test(path)) continue;
    const entry = object(raw);
    if (entry.link === true) continue;
    for (const edge of dependencies(entry)) if (edge.field !== DependencyLocalEdgeField.DevDependencies) {
      let optionalPeer = false;
      if (selection && registry.has(path) && edge.field === DependencyLocalEdgeField.PeerDependencies &&
          !searchPaths(path, edge.name).some(candidate => Object.hasOwn(records, candidate))) {
        const peers = object(entry.peerDependencies), metadata = entry.peerDependenciesMeta === undefined ? {} : object(entry.peerDependenciesMeta);
        for (const [name, raw] of Object.entries(metadata)) {
          const meta = object(raw); allowed(meta, ["optional"]);
          if (!Object.hasOwn(peers, name) || typeof meta.optional !== "boolean") fail();
        }
        optionalPeer = metadata[edge.name] !== undefined && object(metadata[edge.name]).optional === true;
        if (optionalPeer && !supportedAbsentPeerSyntax(edge.spec)) fail();
      }
      resolveEdge(path, edge, optionalPeer);
    }
  }
  for (const targetPath of root.workspaces) {
    const target = packages.get(targetPath)!; referenced.add(targetPath);
    edges.push({ declaringPath: "", field: DependencyLocalEdgeField.Workspace, name: target.manifest.name, spec: targetPath,
      resolutionBase: DependencyLocalResolutionBase.SourceDirectory, targetPath, kind: target.value.kind,
      installedPaths: installedLocal.get(targetPath) ?? [] });
  }
  if (!packages.size || paths.some((path) => !referenced.has(path)) || edges.some((edge) => !edge.installedPaths.length)) fail();
  for (const path of excluded) {
    const consumed = incoming.get(path);
    if (!consumed?.length || consumed.some(field => field !== DependencyLocalEdgeField.OptionalDependencies)) fail();
  }
  const visited = new Set<string>(), active = new Set<string>();
  const visit = (path: string): void => {
    if (active.has(path)) fail(); if (visited.has(path)) return;
    active.add(path); for (const edge of edges.filter((edge) => edge.declaringPath === path)) visit(edge.targetPath);
    active.delete(path); visited.add(path);
  };
  visit(""); if (paths.some((path) => !visited.has(path))) fail();
  const selected: { readonly version: 1 } | { readonly version: 2; readonly registrySelection: DependencyLocalRegistrySelection } = excluded.size || absentOptionalPeers.length ? {
    version: 2 as const, registrySelection: { revision: DependencyLocalRegistrySelectionRevision.LinuxX64GlibcOptionalAbsentV1,
      platform: "linux" as const, arch: DependencyInstallArchitecture.X64, libc: DependencyLibcFamily.Glibc,
      excludedScriptPackages: [...excluded].sort(), absentOptionalPeers: absentOptionalPeers.sort((a, b) =>
        JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0) },
  } : { version: 1 as const };
  return { ...selected, profile: DependencyInstallProfile.TestNpmLocalNoLifecycleV1,
    layout: root.workspaces.length ? DependencyLocalInstallLayout.RootWithLiteralWorkspaceInputs : DependencyLocalInstallLayout.RootOnly,
    packages: [...packages.values()].map(({ value }) => value).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    edges: edges.map((edge) => ({ ...edge, installedPaths: [...edge.installedPaths].sort() }))
      .sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0) };
}
