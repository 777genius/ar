import { createHash } from "node:crypto";
import { builtinModules } from "node:module";
import { posix } from "node:path";
import { qualificationRequiredArtifacts } from "./hosted-ordinary-installation-qualification";

/**
 * The ONE canonical derivation of `ordinary-qualification-source.json` (the only manifest the product defines and validates:
 * `admitQualificationSourceFiles`, "every module this role loads must be listed"). Its digest is the candidate's `sourceScopeSha256`
 * and, by contract, also `runtimeManifestSha256` (every consumer only compares those 64 hex digits). The closure is the required artifacts
 * plus the transitive literal relative imports of the built JavaScript, with the artifact's own package resolved through its `exports`.
 * A load this scan cannot see (a non-literal dynamic load, or the module-require factory) or a third-party package it cannot measure REFUSES the
 * derivation: a manifest that silently omits a loaded module is not closed. Pure: the reader is the only edge.
 */
export const sourceScopeMaxFiles = 512;
export const sourceScopeMaxFileBytes = 32 * 1024 * 1024;
export const sourceScopeMaxTotalBytes = 256 * 1024 * 1024;
export type SourceScopeReader = (artifactRelativePath: string) => Buffer;
export type SourceScopeFile = Readonly<{ path: string; sha256: string }>;
export type SourceScope = Readonly<{ bytes: Buffer; sha256: string; files: readonly SourceScopeFile[]; selfPackageSpecifiers: readonly string[] }>;
// Built from two halves so this module's own text never contains the word it scans for: this file is itself a required artifact and is scanned like any other.
const requireFactory = new RegExp("\\bcreate" + "Require\\b");
const manifestPath =/^(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/;
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
function held(why: string): never { throw new Error(`hosted_source_scope_held:${why}`); }

function resolveSelfPackage(specifier: string, pkg: { name?: unknown; exports?: unknown }): string | undefined {
  if (typeof pkg.name !== "string" || (specifier !== pkg.name && !specifier.startsWith(`${pkg.name}/`))) return undefined;
  const table = pkg.exports && typeof pkg.exports === "object" ? pkg.exports as Record<string, unknown> : {};
  const pick = (value: unknown): string | undefined => typeof value === "string" ? value : value && typeof value === "object"
    ? pick((value as Record<string, unknown>)["import"] ?? (value as Record<string, unknown>)["node"] ?? (value as Record<string, unknown>)["default"]) : undefined;
  const target = pick(table[`.${specifier.slice(pkg.name.length)}`]);
  if (!target || !target.startsWith("./")) held(`self_package_specifier_unresolved:${specifier}`);
  return posix.normalize((target as string).slice(2));
}

export function deriveQualificationSourceScope(read: SourceScopeReader, required: readonly string[] = qualificationRequiredArtifacts): SourceScope {
  const pkg = JSON.parse(read("package.json").toString("utf8")) as { name?: unknown; exports?: unknown };
  const contents = new Map<string, Buffer>(), selfSpecifiers = new Set<string>(), unmeasured = new Set<string>(), queue = [...required];
  let total = 0;
  for (let path = queue.pop(); path !== undefined; path = queue.pop()) {
    if (contents.has(path)) continue;
    if (!manifestPath.test(path) || path.split("/").some(part => part === "." || part === "..")) held(`path_not_listable:${path}`);
    if (contents.size >= sourceScopeMaxFiles) held("closure_exceeds_manifest_bound");
    const bytes = read(path);
    total += bytes.length;
    if (bytes.length > sourceScopeMaxFileBytes || total > sourceScopeMaxTotalBytes) held("closure_byte_bound");
    contents.set(path, bytes);
    if (!/\.(?:js|mjs|cjs)$/.test(path)) continue;
    const text = bytes.toString("utf8");
    // An invisible load is reported as the EXACT unsupported edge (file, line, kind): it is never silently dropped and never turned into an accepted scope.
    for (const [kind, pattern] of [["import", /\bimport\s*\(\s*[^"'\s)]/], ["require", /\brequire\s*\(\s*[^"'\s)]/], ["require_factory", requireFactory]] as const) {
      const hit = pattern.exec(text);
      if (hit) held(`non_literal_dynamic_load:${path}:${kind}@line${text.slice(0, hit.index).split("\n").length}`);
    }
    for (const match of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"']+)["']/g)) {
      const specifier = match[1] ?? "";
      if (!specifier.startsWith(".")) {
        if (specifier.startsWith("node:") || builtinModules.includes(specifier.split("/")[0] ?? "")) continue;
        const self = resolveSelfPackage(specifier, pkg);
        if (self) { selfSpecifiers.add(specifier); queue.push(self); } else unmeasured.add(specifier);
        continue;
      }
      const target = posix.normalize(posix.join(posix.dirname(path), specifier));
      if (!/^(?:dist|host-integration)\//.test(target)) held(`import_leaves_closure:${path}->${specifier}`);
      queue.push(target);
    }
  }
  if (unmeasured.size > 0) held(`unmeasured_external_packages:${[...unmeasured].sort().join(",")}`);
  const files = Object.freeze([...contents.keys()].sort().map((path): SourceScopeFile => Object.freeze({ path, sha256: sha(contents.get(path) ?? held(`unread:${path}`)) })));
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, files }) + "\n");
  return Object.freeze({ bytes, sha256: sha(bytes), files, selfPackageSpecifiers: Object.freeze([...selfSpecifiers].sort()) });
}

/** The admitted manifest on disk must be byte-identical to the derivation: the validator proves every LISTED file matches, this proves nothing loaded is missing. */
export function assertSourceScopeMatchesDerivation(onDisk: Buffer, derived: SourceScope): void {
  if (!onDisk.equals(derived.bytes)) held("manifest_on_disk_differs_from_derivation");
}
/** `runtimeManifestSha256` contract: the digest of the admitted manifest's exact bytes, identical to the candidate's `sourceScopeSha256`. */
export const runtimeManifestSha256Of = (admittedManifestBytes: Buffer): string => sha(admittedManifestBytes);
