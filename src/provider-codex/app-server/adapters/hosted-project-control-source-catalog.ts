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
  "scripts/dependency-retention-os-test/current-full-control-git.js",
  "dist/worker-codex/hosted-project-control-git-recipe.js",
  "dist/worker-codex/hosted-project-control-native-allocation.js",
  "dist/worker-codex/application/project-control/adapters/host-command-adapters.js",
  "dist/worker-codex/application/project-control/codex-goal-project-refill-readonly.js",
  "dist/worker-codex/project-standalone-workspace.js",
  "dist/worker-codex/codex-goal-status-files.js",
  "dist/worker-codex/protected-job-birth.js",
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
  "os-signed-elf-pins.json", "os-packages.json", "os-signed-tool-aliases.json", "os-signed-peer-preload.json", "os-signed-git-inventory.json",
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

export enum OriginalFullGitEntryKind { Directory = "directory", Regular = "regular", Symlink = "symlink" }
export type OriginalFullGitEntry = Readonly<{ path: string; kind: OriginalFullGitEntryKind;
  sha256: string | null; size: number | null; target: string | null; elf: boolean }>;

/** A complete copied exec-path inventory, not a permission to execute a helper.
 * Scripts and aliases still need the original producer's actual closed recipe. */
export function originalFullProjectControlGitEntryData(value: unknown): readonly OriginalFullGitEntry[] {
  preloadCheck(Array.isArray(value) && value.length > 0 && value.length <= 1024);
  let previous = "";
  const rows = value.map((item: unknown): OriginalFullGitEntry => {
    const row = preloadObject(item, "path,kind,sha256,size,target,elf");
    preloadCheck(typeof row.path === "string" && row.path > previous &&
      (row.path === "/usr/bin/git" || /^\/usr\/lib\/git-core(?:\/[A-Za-z0-9_.+-]+)*$/.test(row.path)) &&
      !row.path.split("/").some(part => part === "." || part === "..") && typeof row.elf === "boolean");
    previous = row.path;
    if (row.kind === OriginalFullGitEntryKind.Regular) {
      preloadCheck(typeof row.sha256 === "string" && /^[a-f0-9]{64}$/.test(row.sha256) &&
        Number.isSafeInteger(row.size) && (row.size as number) >= (row.elf ? 20 : 0) && (row.size as number) <= 32 * 1024 * 1024 && row.target === null);
      return Object.freeze({ path: row.path, kind: OriginalFullGitEntryKind.Regular, sha256: row.sha256,
        size: row.size as number, target: null, elf: row.elf });
    }
    preloadCheck(row.sha256 === null && row.size === null && row.elf === false);
    if (row.kind === OriginalFullGitEntryKind.Directory) {
      preloadCheck(row.target === null); return Object.freeze({ path: row.path, kind: OriginalFullGitEntryKind.Directory,
        sha256: null, size: null, target: null, elf: false });
    }
    preloadCheck(row.kind === OriginalFullGitEntryKind.Symlink && typeof row.target === "string" &&
      row.target.length > 0 && Buffer.byteLength(row.target) <= 4096 && /^[A-Za-z0-9_+./-]+$/.test(row.target));
    return Object.freeze({ path: row.path, kind: OriginalFullGitEntryKind.Symlink, sha256: null,
      size: null, target: row.target, elf: false });
  });
  preloadCheck(rows.some(row => row.path === "/usr/bin/git" && row.kind === OriginalFullGitEntryKind.Regular && row.elf) &&
    rows.some(row => row.path === "/usr/lib/git-core" && row.kind === OriginalFullGitEntryKind.Directory));
  const directories = new Set(rows.filter(row => row.kind === OriginalFullGitEntryKind.Directory).map(row => row.path));
  for (const row of rows) if (row.path.startsWith("/usr/lib/git-core/")) {
    preloadCheck(directories.has(row.path.slice(0, row.path.lastIndexOf("/"))));
  }
  return Object.freeze(rows);
}

/** Fixed Git executable facts only. Every selected symlink must terminate at
 * an inventoried regular ELF with the same independently signed pin. This is
 * not filesystem custody, an ELF dependency closure or permission to execute. */
export function originalFullProjectControlGitExecutableData(entriesValue: unknown, pinsValue: unknown):
  readonly Readonly<{ path: string; resolvedPath: string; sha256: string }>[] {
  const entries = originalFullProjectControlGitEntryData(entriesValue);
  preloadCheck(Array.isArray(pinsValue) && pinsValue.length > 0 && pinsValue.length <= 4096);
  const pins = new Map<string, string>();
  for (const value of pinsValue) {
    const row = preloadObject(value, "path,sha256");
    preloadCheck(typeof row.path === "string" && /^\/usr\/(?:lib|bin)\//.test(row.path) &&
      !row.path.split("/").some(part => part === "." || part === "..") &&
      typeof row.sha256 === "string" && /^[a-f0-9]{64}$/.test(row.sha256) && !pins.has(row.path));
    pins.set(row.path, row.sha256);
  }
  const byPath = new Map(entries.map(row => [row.path, row]));
  return Object.freeze(["/usr/bin/git", "/usr/lib/git-core/git-upload-pack"].map(path => {
    let selected = path; const visited = new Set<string>();
    for (;;) {
      preloadCheck(!visited.has(selected) && visited.size < 16); visited.add(selected);
      const row = byPath.get(selected); preloadCheck(row);
      if (row.kind !== OriginalFullGitEntryKind.Symlink) {
        preloadCheck(row.kind === OriginalFullGitEntryKind.Regular && row.elf && row.sha256 !== null && pins.get(selected) === row.sha256);
        return Object.freeze({ path, resolvedPath: selected, sha256: row.sha256 });
      }
      preloadCheck(row.target !== null);
      const target = row.target.startsWith("/") ? row.target : selected.slice(0, selected.lastIndexOf("/")) + "/" + row.target;
      const parts: string[] = [];
      for (const part of target.split("/")) {
        if (part === "" || part === ".") continue;
        if (part === "..") { preloadCheck(parts.length > 0); parts.pop(); }
        else parts.push(part);
      }
      selected = "/" + parts.join("/");
      preloadCheck(selected === "/usr/bin/git" || selected.startsWith("/usr/lib/git-core/"));
    }
  }));
}

/** Validates copied signed-image facts only. This does not select an entry,
 * authenticate package bytes or enroll a filesystem alias. */
export function originalFullProjectControlToolAliasData(value: unknown): readonly Readonly<{ path: string; target: string }>[] {
  preloadCheck(Array.isArray(value) && value.length <= 1024);
  let previous = "";
  const rows = value.map((item: unknown) => {
    const row = preloadObject(item, "path,target");
    preloadCheck(typeof row.path === "string" && row.path > previous &&
      /^\/(?:usr\/(?:lib|lib64|bin)\/|(?:lib64|lib|bin|sbin)$)/.test(row.path) &&
      !row.path.split("/").some(part => part === "." || part === "..") &&
      typeof row.target === "string" && row.target.length > 0 && Buffer.byteLength(row.target) <= 4096 &&
      !/[\0-\x20\x7f]/.test(row.target));
    previous = row.path;
    return Object.freeze({ path: row.path, target: row.target });
  });
  return Object.freeze(rows);
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
