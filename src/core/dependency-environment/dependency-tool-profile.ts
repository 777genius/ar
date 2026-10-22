/** Closed tool configuration, never an execution permit or cache attestation. */
export enum DependencyToolProfileId { ViteVitestConfigFreeV1 = "vite-vitest-config-free-v1" }
export enum DependencyToolOperation { Optimize = "optimize", Test = "test" }
export enum DependencyToolTransformCache { Persisted = "persisted", Temporary = "temporary" }
export const dependencyToolPins = Object.freeze({ vite: "8.3.5", vitest: "4.1.12" });
export const dependencyToolGuestConfigPath = "/run/subscription-runtime-n3/tool-profile.json";

export type DependencyToolFile = { readonly path: string; readonly sha256: string };
export type DependencyToolDirectory = { readonly canonicalPath: string; readonly dev: string; readonly ino: string };
export type DependencyToolRegistration = {
  readonly testFiles: readonly string[];
  readonly optimizerDependencies: readonly string[];
  readonly transformCache: DependencyToolTransformCache;
};
export type DependencyToolProfile = DependencyToolRegistration & {
  readonly version: 1;
  readonly profileId: DependencyToolProfileId.ViteVitestConfigFreeV1;
  readonly pins: typeof dependencyToolPins;
  readonly cache: DependencyToolDirectory;
  readonly node: DependencyToolFile;
  readonly helper: DependencyToolFile;
  readonly readonlyFiles: readonly DependencyToolFile[];
};
export type DependencyToolQualification = {
  readonly version: 1;
  readonly kind: "n3-authenticated-tool-closure";
  readonly installationId: string;
  readonly runtimeSha: string;
  readonly grantDigest: string;
  readonly workspace: DependencyToolDirectory;
  readonly startId: string;
  readonly attemptId: string;
  readonly epoch: number;
  readonly readyRevision: number;
  readonly installKey: string;
  readonly tree: { readonly dev: string; readonly ino: string };
  readonly manifestDigest: string;
  readonly profile: DependencyToolProfile;
  readonly measurement: { readonly entries: number; readonly bytes: string; readonly durationMs: number };
};
export type DependencyToolGuestConfig = {
  readonly version: 1;
  readonly workspace: DependencyToolDirectory;
  readonly tree: { readonly dev: string; readonly ino: string };
  readonly profile: DependencyToolProfile;
};

export function parseDependencyToolRegistration(value: unknown): DependencyToolRegistration {
  const v = record(value);
  exact(v, ["testFiles", "optimizerDependencies", "transformCache"]);
  const testFiles = strings(v.testFiles, 32, s => /^[A-Za-z0-9_./-]+\.(?:test|spec)\.[cm]?[jt]sx?$/.test(s) && relative(s));
  const optimizerDependencies = strings(v.optimizerDependencies, 32,
    s => /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(s));
  if (!Object.values(DependencyToolTransformCache).includes(v.transformCache as DependencyToolTransformCache)) invalid();
  return Object.freeze({ testFiles, optimizerDependencies, transformCache: v.transformCache as DependencyToolTransformCache });
}
export function parseDependencyToolProfile(value: unknown): DependencyToolProfile {
  const v = record(value);
  exact(v, ["version", "profileId", "pins", "cache", "node", "helper", "readonlyFiles", "testFiles", "optimizerDependencies", "transformCache"]);
  if (v.version !== 1 || v.profileId !== DependencyToolProfileId.ViteVitestConfigFreeV1) invalid();
  const pins = record(v.pins); exact(pins, ["vite", "vitest"]);
  if (pins.vite !== dependencyToolPins.vite || pins.vitest !== dependencyToolPins.vitest) invalid();
  const registration = parseDependencyToolRegistration({ testFiles: v.testFiles, optimizerDependencies: v.optimizerDependencies, transformCache: v.transformCache });
  if (!Array.isArray(v.readonlyFiles) || v.readonlyFiles.length !== 7) invalid();
  const readonlyFiles = Object.freeze(v.readonlyFiles.map(file));
  if (new Set(readonlyFiles.map(f => f.path)).size !== readonlyFiles.length) invalid();
  const helper = file(v.helper), node = file(v.node);
  if (!readonlyFiles.some(f => f.path === helper.path && f.sha256 === helper.sha256)) invalid();
  return Object.freeze({ version: 1, profileId: DependencyToolProfileId.ViteVitestConfigFreeV1, pins: dependencyToolPins,
    ...registration, cache: directory(v.cache), node, helper, readonlyFiles });
}
export function dependencyToolCachePath(jobRootDir: string): string {
  if (!absolute(jobRootDir)) invalid();
  return `${jobRootDir}/tool-cache/${DependencyToolProfileId.ViteVitestConfigFreeV1}`;
}
export function dependencyToolQualificationRecordName(startId: string): string {
  if (!uuid(startId)) invalid();
  return `ordinary-invocations/n3-tools-${startId}.json`;
}
export function parseDependencyToolQualification(value: unknown): DependencyToolQualification {
  const v = record(value);
  exact(v, ["version", "kind", "installationId", "runtimeSha", "grantDigest", "workspace", "startId", "attemptId", "epoch", "readyRevision", "installKey", "tree", "manifestDigest", "profile", "measurement"]);
  if (v.version !== 1 || v.kind !== "n3-authenticated-tool-closure" || !uuid(v.installationId) || !uuid(v.startId) || !uuid(v.attemptId) ||
      !hex(v.runtimeSha, 40) || !hex(v.grantDigest, 64) || !hex(v.installKey, 64) || !hex(v.manifestDigest, 64) ||
      !positive(v.epoch) || !positive(v.readyRevision)) invalid();
  const m = record(v.measurement); exact(m, ["entries", "bytes", "durationMs"]);
  if (!positive(m.entries) || !decimal(m.bytes, false) || !Number.isSafeInteger(m.durationMs) || Number(m.durationMs) < 0) invalid();
  return Object.freeze({ version: 1, kind: "n3-authenticated-tool-closure", installationId: v.installationId as string,
    runtimeSha: v.runtimeSha as string, grantDigest: v.grantDigest as string, workspace: directory(v.workspace),
    startId: v.startId as string, attemptId: v.attemptId as string, epoch: v.epoch as number, readyRevision: v.readyRevision as number,
    installKey: v.installKey as string, tree: tree(v.tree), manifestDigest: v.manifestDigest as string, profile: parseDependencyToolProfile(v.profile),
    measurement: Object.freeze({ entries: m.entries as number, bytes: m.bytes as string, durationMs: m.durationMs as number }) });
}
export function parseDependencyToolGuestConfig(value: unknown): DependencyToolGuestConfig {
  const v = record(value); exact(v, ["version", "workspace", "tree", "profile"]);
  if (v.version !== 1) invalid();
  return Object.freeze({ version: 1, workspace: directory(v.workspace), tree: tree(v.tree), profile: parseDependencyToolProfile(v.profile) });
}
export function dependencyToolGuestConfig(q: DependencyToolQualification): DependencyToolGuestConfig {
  return parseDependencyToolGuestConfig({ version: 1, workspace: q.workspace, tree: q.tree, profile: q.profile });
}
function record(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) invalid();
  return v as Record<string, unknown>;
}
function exact(v: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(v).sort().join(",") !== [...keys].sort().join(",")) invalid();
}
function file(v: unknown): DependencyToolFile {
  const r = record(v); exact(r, ["path", "sha256"]);
  if (!absolute(r.path) || !hex(r.sha256, 64)) invalid();
  return Object.freeze({ path: r.path as string, sha256: r.sha256 as string });
}
function directory(v: unknown): DependencyToolDirectory {
  const r = record(v); exact(r, ["canonicalPath", "dev", "ino"]);
  if (!absolute(r.canonicalPath)) invalid();
  return Object.freeze({ canonicalPath: r.canonicalPath as string, ...tree({ dev: r.dev, ino: r.ino }) });
}
function tree(v: unknown): { readonly dev: string; readonly ino: string } {
  const r = record(v); exact(r, ["dev", "ino"]);
  if (!decimal(r.dev, false) || !decimal(r.ino, true)) invalid();
  return Object.freeze({ dev: r.dev as string, ino: r.ino as string });
}
function strings(v: unknown, max: number, valid: (s: string) => boolean): readonly string[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > max || v.some(s => typeof s !== "string" || s.length > 256 || !valid(s)) || new Set(v).size !== v.length) invalid();
  return Object.freeze([...v] as string[]);
}
function relative(s: string): boolean { return !s.startsWith("/") && !s.split("/").some(p => !p || p === "." || p === ".."); }
function absolute(v: unknown): boolean { return typeof v === "string" && v.startsWith("/") && relative(v.slice(1)) && v.length <= 4096 && !/[\s\0\\]/.test(v); }
function uuid(v: unknown): boolean { return typeof v === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v); }
function hex(v: unknown, length: number): boolean { return typeof v === "string" && v.length === length && /^[a-f0-9]+$/.test(v); }
function decimal(v: unknown, nonzero: boolean): boolean { return typeof v === "string" && (nonzero ? /^[1-9][0-9]{0,19}$/ : /^(?:0|[1-9][0-9]{0,19})$/).test(v); }
function positive(v: unknown): boolean { return typeof v === "number" && Number.isSafeInteger(v) && v > 0; }
function invalid(): never { throw new Error("dependency_tool_profile_invalid"); }
