import { DependencyInstallProfile } from "./dependency-install-key";
import type { DependencySourceBindingReference } from "./dependency-receipt";
import type { DependencyLocalOutputEvidence, DependencySourceBindingFields, DependencySourceBindingRecord, DependencySourceBindingOutputBody } from "../ports/dependency-source-binding";

export class DependencySourceBindingRecordError extends Error {
  constructor() { super("dependency_source_binding_record_invalid"); }
}
function fail(): never { throw new DependencySourceBindingRecordError(); }
const decimal = (value: unknown): value is string => typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) && value.length <= 40;
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const canonical = (value: unknown): value is string => typeof value === "string" && value.length <= 4096 && value.startsWith("/") &&
  !/[\x00-\x1f\x7f]/.test(value) && (value === "/" || value.slice(1).split("/").every(part => !!part && part !== "." && part !== ".."));
const coordinate = (value: unknown): value is string => typeof value === "string" && value.length <= 4096 && (!value ||
  /^[a-zA-Z0-9._@+-]+(?:\/[a-zA-Z0-9._@+-]+)*$/.test(value) && !value.split("/").some(part => [".", "..", "node_modules", ".git"].includes(part)));
function exact(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
}
const bodyFields = ["version", "profile", "generation", "workspace", "coverageRevision", "installKey", "tree", "manifestDigest", "operationId",
  "installerCompletionSha256", "closureDigest", "sourceLinks", "directories", "ancestors"] as const;
export function assertDependencyOutputReference(value: unknown): asserts value is DependencySourceBindingReference {
  if (!exact(value, ["path", "identity", "sha256"]) || !canonical(value.path) || !digest(value.sha256) ||
      !exact(value.identity, ["dev", "ino"]) || !decimal(value.identity.dev) || !decimal(value.identity.ino) || BigInt(value.identity.ino) === 0n) fail();
}
function fields(value: unknown, expected: readonly string[], version: 1 | 2): asserts value is DependencySourceBindingFields & { readonly version: 1 | 2 } & Record<string, unknown> {
  if (!exact(value, expected) || value.version !== version || value.profile !== DependencyInstallProfile.TestNpmLocalNoLifecycleV1 ||
      typeof value.generation !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.generation) || value.operationId !== value.generation ||
      !exact(value.workspace, ["canonicalPath", "dev", "ino"]) || !canonical(value.workspace.canonicalPath) || value.workspace.canonicalPath === "/" ||
      !exact(value.tree, ["dev", "ino"]) || ![value.workspace.dev, value.workspace.ino, value.tree.dev, value.tree.ino].every(decimal) ||
      typeof value.coverageRevision !== "string" || !value.coverageRevision.length || value.coverageRevision.trim() !== value.coverageRevision ||
      value.coverageRevision.length > 1024 || /[\x00-\x1f\x7f]|sk-[A-Za-z0-9_-]{12,}|Bearer\s/i.test(value.coverageRevision) ||
      ![value.installKey, value.manifestDigest, value.installerCompletionSha256, value.closureDigest].every(digest) ||
      !Array.isArray(value.sourceLinks) || !Array.isArray(value.directories) || !Array.isArray(value.ancestors) ||
      value.sourceLinks.length > 128 || value.directories.length > 512 || value.ancestors.length > 512) fail();
  const ancestors = value.ancestors;
  if (version === 2 && (BigInt(String(value.workspace.ino)) === 0n || BigInt(String(value.tree.ino)) === 0n)) fail();
  const pins: unknown[] = [...value.ancestors, ...value.directories];
  for (const pin of pins) if (!exact(pin, ["path", "dev", "ino", "mode", "mountId"]) ||
      ![pin.dev, pin.ino, pin.mode, pin.mountId].every(decimal) || (BigInt(String(pin.mode)) & 0o170000n) !== 0o40000n ||
      BigInt(String(pin.ino)) === 0n || BigInt(String(pin.mountId)) === 0n) fail();
  const paths = pins.map(pin => { if (!pin || typeof pin !== "object" || !("path" in pin) || typeof pin.path !== "string") return fail(); return pin.path; });
  if (!value.directories.some((pin: unknown) => !!pin && typeof pin === "object" && "path" in pin && pin.path === "") || new Set(paths).size !== pins.length) fail();
  for (const pin of value.ancestors) if (!canonical(pin.path)) fail();
  for (const pin of value.directories) if (!coordinate(pin.path)) fail();
  const ancestry = ["/"]; let ancestor = "";
  for (const part of value.workspace.canonicalPath.split("/").filter(Boolean).slice(0, -1)) { ancestor += "/" + part; ancestry.push(ancestor); }
  if (ancestors.length !== ancestry.length || ancestry.some(path => !ancestors.some((pin: { path: unknown }) => pin.path === path))) fail();
  for (const pin of value.directories) if (pin.path && !value.directories.some((parent: { path: unknown }) =>
    parent.path === (pin.path.includes("/") ? pin.path.slice(0, pin.path.lastIndexOf("/")) : ""))) fail();
  const linkPaths = new Set<string>();
  for (const link of value.sourceLinks) {
    if (!exact(link, ["path", "target", "sourcePath", "packageManifestSha256", "closureDigest"]) || !Array.isArray(link.path) ||
        !coordinate(link.sourcePath) || !link.sourcePath || !digest(link.packageManifestSha256) || link.closureDigest !== value.closureDigest ||
        typeof link.target !== "string" || Buffer.from(link.target, "base64").toString("base64") !== link.target ||
        !value.directories.some((pin: { path: unknown }) => pin.path === link.sourcePath)) fail();
    const parts = link.path.map((part: unknown) => {
      if (typeof part !== "string" || part.length > 1024) return fail();
      const bytes = Buffer.from(part, "base64");
      if (!bytes.length || bytes.toString("base64") !== part || bytes.includes(47) || bytes.includes(0)) return fail();
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    });
    const installed = "node_modules/" + parts.join("/"), base = installed.slice(0, installed.lastIndexOf("/"));
    if (!/^node_modules\/(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(installed)) fail();
    const from = base.split("/"), to = link.sourcePath.split("/"); let shared = 0;
    while (shared < from.length && shared < to.length && from[shared] === to[shared]) shared++;
    const relative = [...from.slice(shared).map(() => ".."), ...to.slice(shared)].join("/");
    if (Buffer.from(relative).toString("base64") !== link.target) fail();
    const key = JSON.stringify(link.path); if (linkPaths.has(key)) fail(); linkPaths.add(key);
  }
}
export function assertDependencySourceBindingRecord(value: unknown): asserts value is DependencySourceBindingRecord {
  if (!value || typeof value !== "object" || !("version" in value)) fail();
  if (value.version === 1) fields(value, bodyFields, 1);
  else if (value.version === 2) { fields(value, [...bodyFields, "outputReference"], 2); assertDependencyOutputReference(value.outputReference); }
  else fail();
}
/** Frozen V2 body order. No physical observation, hashing or authority is supplied.
 * outputReference is excluded so genuine evidence can be issued before its ref. */
export function encodeDependencySourceBindingOutputBody(value: DependencySourceBindingOutputBody): string {
  fields(value, bodyFields, 2);
  return JSON.stringify({ version: 2, profile: value.profile, generation: value.generation,
    workspace: { canonicalPath: value.workspace.canonicalPath, dev: value.workspace.dev, ino: value.workspace.ino }, coverageRevision: value.coverageRevision,
    installKey: value.installKey, tree: { dev: value.tree.dev, ino: value.tree.ino }, manifestDigest: value.manifestDigest, operationId: value.operationId,
    installerCompletionSha256: value.installerCompletionSha256, closureDigest: value.closureDigest,
    sourceLinks: value.sourceLinks.map(link => ({ path: [...link.path], target: link.target, sourcePath: link.sourcePath,
      packageManifestSha256: link.packageManifestSha256, closureDigest: link.closureDigest })),
    directories: value.directories.map(pin => ({ path: pin.path, dev: pin.dev, ino: pin.ino, mode: pin.mode, mountId: pin.mountId })),
    ancestors: value.ancestors.map(pin => ({ path: pin.path, dev: pin.dev, ino: pin.ino, mode: pin.mode, mountId: pin.mountId })),
  }) + "\n";
}
export function assertDependencyLocalOutputEvidence(value: unknown): asserts value is DependencyLocalOutputEvidence {
  if (!exact(value, ["version", "profile", "generation", "operationId", "workspace", "coverageRevision", "installKey", "closureDigest", "inputSha256", "profileSha256",
      "start", "creator", "completion", "terminal", "tree", "manifestVersion", "manifestDigest", "manifestPlacementRevision", "verifiedBindingSha256"]) ||
      value.version !== 1 || value.manifestVersion !== 2 || value.profile !== DependencyInstallProfile.TestNpmLocalNoLifecycleV1 ||
      typeof value.generation !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.generation) || value.operationId !== value.generation ||
      !exact(value.workspace, ["canonicalPath", "dev", "ino"]) || !canonical(value.workspace.canonicalPath) || value.workspace.canonicalPath === "/" ||
      !exact(value.tree, ["dev", "ino"]) || ![value.workspace.dev, value.workspace.ino, value.tree.dev, value.tree.ino].every(decimal) ||
      typeof value.coverageRevision !== "string" || !value.coverageRevision.length || value.coverageRevision.trim() !== value.coverageRevision ||
      value.coverageRevision.length > 1024 || /[\x00-\x1f\x7f]|sk-[A-Za-z0-9_-]{12,}|Bearer\s/i.test(value.coverageRevision) ||
      ![value.installKey, value.closureDigest, value.inputSha256, value.profileSha256, value.manifestDigest, value.manifestPlacementRevision, value.verifiedBindingSha256].every(digest)) fail();
  if (BigInt(String(value.workspace.ino)) === 0n || BigInt(String(value.tree.ino)) === 0n) fail();
  for (const reference of [value.start, value.creator, value.completion, value.terminal]) assertDependencyOutputReference(reference);
}
