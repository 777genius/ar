// Finite DATA only; original constructors independently authenticate and hold
// every selected source before submission. Missing rows cannot qualify an entry.
export const originalFullProjectControlSourcePaths = Object.freeze([
  "dist/worker-codex/hosted-project-control-native-origin.js",
  "dist/worker-codex/hosted-project-control-native-handoff.js",
  "dist/worker-codex/hosted-project-control-peer-observer.js",
  "dist/worker-codex/hosted-project-control-peer-selection.js",
  "dist/worker-codex/hosted-project-control-peer-recipe.js",
  "dist/provider-codex/app-server/adapters/hosted-process-descriptors.js",
  "dist/provider-codex/app-server/adapters/hosted-dependency-systemd-command.js",
  "scripts/dependency-retention-os-test/current-full-peer-query.js",
  "dist/provider-codex/app-server/adapters/hosted-project-control-source-catalog.js",
  "dist/provider-codex/app-server/adapters/hosted-signed-tool-elf.js",
  "dist/provider-codex/app-server/adapters/hosted-fd-table.js",
  "dist/core/host-infrastructure/fd-collector-profile.js",
  "dist/worker-codex/hosted-full-backing-stage.js",
  "dist/worker-codex/hosted-full-backing-proc.js",
  "dist/provider-codex/app-server/adapters/hosted-full-backing-stage.js",
  "dist/provider-codex/app-server/adapters/hosted-full-backing-proc.js",
  "dist/provider-codex/app-server/adapters/hosted-private-physical-inputs.js",
]);
export const originalFullProjectControlPeerMetadataPaths = Object.freeze([
  "os-signed-elf-pins.json", "os-packages.json", "os-signed-tool-aliases.json", "os-signed-peer-preload.json",
]);

const runtime = "/opt/subscription-runtime-dependency-os-TEST";
export const originalFullProjectControlEntrySourcePaths = Object.freeze([...new Set([
  runtime + "/toolchain/bin/node", runtime + "/scripts/dependency-retention-os-test/current-full-guest.js",
  runtime + "/scripts/dependency-retention-os-test/current-full-supervisor.js",
  "/etc/systemd/test-units/TEST-retention-supervisor.service", "/usr/lib/systemd/systemd",
  ...originalFullProjectControlSourcePaths.map(path => runtime + "/" + path),
])]);

function preloadCheck(value: unknown): asserts value { if (!value) throw new Error("hosted_full_backing_interval_held"); }
function preloadObject(value: unknown, keys: string): Record<string, unknown> {
  preloadCheck(value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).sort().join(",") === keys.split(",").sort().join(","));
  return value as Record<string, unknown>;
}
function preloadIdentity(value: unknown): Readonly<{dev: string; ino: string}> {
  const row = preloadObject(value, "dev,ino"); preloadCheck(typeof row.dev === "string" && /^[1-9][0-9]*$/.test(row.dev) && typeof row.ino === "string" && /^[1-9][0-9]*$/.test(row.ino));
  return {dev: row.dev, ino: row.ino};
}
export enum OriginalFullPeerPreloadSelectionKind { Absent = "absent", Empty = "empty" }
export type OriginalFullPeerPreloadSelection = Readonly<{ kind: OriginalFullPeerPreloadSelectionKind;
  parent: Readonly<{ dev: string; ino: string }>; file: Readonly<{ dev: string; ino: string }> | null }>;

/** Factual decoder only. The no-argument receiver separately joins original
 * selected seals, entry, file descriptors and negative preload facts. */
export function originalFullProjectControlPreloadData(value: unknown): OriginalFullPeerPreloadSelection {
  const row = preloadObject(value, "schemaVersion,kind,parent,file"); preloadCheck(row.schemaVersion === 1);
  const parent = Object.freeze(preloadIdentity(row.parent));
  if (row.kind === OriginalFullPeerPreloadSelectionKind.Absent) {
    preloadCheck(row.file === null); return Object.freeze({ kind: OriginalFullPeerPreloadSelectionKind.Absent, parent, file: null });
  }
  preloadCheck(row.kind === OriginalFullPeerPreloadSelectionKind.Empty);
  return Object.freeze({ kind: OriginalFullPeerPreloadSelectionKind.Empty, parent, file: Object.freeze(preloadIdentity(row.file)) });
}

/** Copied original preparation case facts; only sealed producer joins authorize an entry. */
export enum OriginalFullProjectControlPreparedCase { Positive = "positive", ParentCrashH1 = "parent_crash_h1" }
