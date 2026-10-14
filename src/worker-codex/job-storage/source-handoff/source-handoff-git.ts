import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { SourceHandoffEntryKind, SourceHandoffFailure as Failure, sourceHandoffFail, type SourceHandoffEntry } from "./source-handoff-contracts";
import { sourceHandoffDigest, sourceHandoffLimits } from "./source-handoff-filesystem";
const execute = promisify(execFile);

/** Builtins only: no checkout/status/diff/filter/hook/fsmonitor/credential helper.
 * No inherited Git mappings/config injection or network command. Restored config
 * stays inert and is never used for write-authority activation. */
async function gitRead(workspace: string, args: readonly string[]): Promise<string> {
  try {
    return (await execute("git", ["--no-optional-locks", "--no-replace-objects", "-C", workspace,
      "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "fsck.skipList=/dev/null", ...args], {
      env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
      timeout: 30_000, maxBuffer: 16 * 1024 ** 2,
    })).stdout;
  } catch { return sourceHandoffFail(Failure.Unsupported); }
}
// LFS pointers are ordinary Git blobs, including dangling/reflog-only ones.
// Their payload is external even after current attributes/.git/lfs disappear.
const lfsPointer = /^version https:\/\/(?:git-lfs|hawser)\.github\.com\/spec\/v1\r?\n/;
async function inspectProtectedGitObjects(workspace: string, entries: readonly SourceHandoffEntry[]): Promise<void> {
  const objects = (await gitRead(workspace, ["cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype) %(objectsize)"]))
    .trim().split("\n").filter(Boolean);
  if (objects.length > sourceHandoffLimits.entries) sourceHandoffFail(Failure.Bounds);
  for (const object of objects) {
    const match = /^([a-f0-9]{40}) (blob|tree|commit|tag) ([0-9]+)$/.exec(object);
    if (!match) sourceHandoffFail(Failure.Unsupported);
    const [, oid, kind, size] = match;
    if (kind === "tree" && (await gitRead(workspace, ["ls-tree", "-z", oid!])).split("\0").some(entry => entry.startsWith("160000 "))) {
      sourceHandoffFail(Failure.Unsupported);
    }
    // Canonical Git LFS pointer spec bounds pointers to at most 1024 bytes.
    if (kind === "blob" && Number(size) <= 1024 && lfsPointer.test(await gitRead(workspace, ["cat-file", "blob", oid!]))) {
      sourceHandoffFail(Failure.Unsupported);
    }
  }
  for (const entry of entries) {
    if (entry.kind === SourceHandoffEntryKind.File && entry.size <= 1024 && entry.path.startsWith("workspace/") &&
        !entry.path.startsWith("workspace/.git/") && lfsPointer.test(await readFile(join(workspace, entry.path.slice("workspace/".length)), "utf8"))) {
      sourceHandoffFail(Failure.Unsupported);
    }
  }
}
export async function inspectSourceHandoffGit(workspace: string, entries: readonly SourceHandoffEntry[]): Promise<string> {
  if (!entries.some(entry => entry.path === "workspace/.git" && entry.kind === SourceHandoffEntryKind.Directory) ||
      entries.some(entry => ["workspace/.gitmodules", "workspace/.lfsconfig", "workspace/.git/modules", "workspace/.git/lfs", "workspace/.git/commondir", "workspace/.git/shallow", "workspace/.git/gc.pid"].includes(entry.path))) {
    sourceHandoffFail(Failure.Unsupported);
  }
  const config = await readFile(join(workspace, ".git", "config"), "utf8");
  if (Buffer.byteLength(config) > 1024 * 1024 || /\[\s*(?:include|includeIf|fsck|extensions)\b/i.test(config) ||
      /^\s*(?:worktree|promisor)\s*=/im.test(config) || /^\s*bare\s*=\s*(?:true|1|yes)\s*$/im.test(config)) sourceHandoffFail(Failure.Unsupported);
  if ((await gitRead(workspace, ["rev-parse", "--absolute-git-dir"])).trim() !== join(workspace, ".git") ||
      ![".git", join(workspace, ".git")].includes((await gitRead(workspace, ["rev-parse", "--git-common-dir"])).trim())) sourceHandoffFail(Failure.Unsupported);
  const index = await gitRead(workspace, ["ls-files", "--stage", "-z"]);
  if (index.split("\0").some(entry => entry.startsWith("160000 "))) sourceHandoffFail(Failure.Unsupported);
  const tracked = (await gitRead(workspace, ["ls-files", "-z"])).split("\0").filter(Boolean);
  for (let offset = 0; offset < tracked.length; offset += 100) {
    for (const cached of [false, true]) {
      const attributes = (await gitRead(workspace, ["check-attr", ...(cached ? ["--cached"] : []), "-z", "filter", "--", ...tracked.slice(offset, offset + 100)])).split("\0");
      for (let part = 2; part < attributes.length; part += 3) {
        if (!["unspecified", "unset"].includes(attributes[part]!)) sourceHandoffFail(Failure.Unsupported);
      }
    }
  }
  await inspectProtectedGitObjects(workspace, entries);
  // Check full object closure without running restored instructions. Dangling
  // objects are included, not pruned or substituted with a reachable-only bundle.
  const closure = (await gitRead(workspace, ["fsck", "--full", "--strict"])).split("\n").sort();
  const facts = [index, await gitRead(workspace, ["rev-parse", "HEAD"]),
    await gitRead(workspace, ["for-each-ref", "--format=%(refname) %(objectname)"]),
    await gitRead(workspace, ["reflog", "show", "--all", "--format=%H %gD %gs"]), closure];
  return sourceHandoffDigest(JSON.stringify(facts));
}

/** Narrow dependency envelope: no external Git/LFS state, and dependency-free
 * source or an already self-contained regular Node dependency tree. Unknown
 * workspace/file/path dependencies or other package ecosystems stay protected.
 * This validates required declared Node graph, never runs package managers. */
export async function inspectSourceHandoffDependencies(workspace: string, entries: readonly SourceHandoffEntry[]): Promise<void> {
  const files = new Set(entries.filter(entry => entry.kind === SourceHandoffEntryKind.File).map(entry => entry.path));
  if (entries.some(entry => /\/(?:Cargo\.toml|go\.mod|requirements[^/]*\.txt|pyproject\.toml|setup\.(?:py|cfg)|Pipfile(?:\.lock)?|pubspec\.yaml|pom\.xml|(?:build|settings)\.gradle(?:\.kts)?|Gemfile|gemspec|[^/]+\.gemspec|composer\.json|[^/]+\.(?:csproj|fsproj|vbproj)|packages\.config|mix\.exs|rebar\.config|Package\.swift|Podfile|CMakeLists\.txt|conanfile\.(?:py|txt)|vcpkg\.json|deps\.edn|project\.clj|\.gitmodules)$/.test(entry.path))) sourceHandoffFail(Failure.Unsupported);
  for (const entry of entries) {
    if (entry.kind !== SourceHandoffEntryKind.File || !entry.path.endsWith("/package.json") || !entry.path.startsWith("workspace/")) continue;
    if (entry.size > 1024 * 1024) sourceHandoffFail(Failure.Bounds);
    let value: Record<string, unknown>;
    try { value = JSON.parse(await readFile(join(workspace, entry.path.slice("workspace/".length)), "utf8")) as Record<string, unknown>; }
    catch { return sourceHandoffFail(Failure.Unsupported); }
    if (!value || typeof value !== "object" || Array.isArray(value) || value.workspaces !== undefined) sourceHandoffFail(Failure.Unsupported);
    for (const key of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      const dependencies = value[key];
      if (dependencies === undefined) continue;
      if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) sourceHandoffFail(Failure.Unsupported);
      for (const [name, target] of Object.entries(dependencies)) {
        if (!/^(?:@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9._-]+$/.test(name) || typeof target !== "string" ||
            /^(?:file:|link:|workspace:|\.\.?\/|\/)/.test(target)) sourceHandoffFail(Failure.Unsupported);
        const parent = entry.path.slice(0, -"/package.json".length);
        let directory = parent, found = false;
        while (directory === "workspace" || directory.startsWith("workspace/")) {
          if (files.has(`${directory}/node_modules/${name}/package.json`)) { found = true; break; }
          const slash = directory.lastIndexOf("/");
          if (slash < 0) break;
          directory = directory.slice(0, slash);
        }
        if (!found) sourceHandoffFail(Failure.Unsupported);
      }
    }
  }
}
