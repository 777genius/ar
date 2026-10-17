import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, readdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { JobRetirementRefusal, jobRetirementLayouts, refuseRetirement } from "./job-retirement-contract";
import { alternatesOf, canonicalRetirementPath } from "./job-retirement-git";

const census = jobRetirementLayouts.referenceCensus;
const manifestMaxBytes = 8 * 1024 * 1024, candidateLimit = 200_000;
const incomplete = (): never => refuseRetirement(JobRetirementRefusal.ReferenceCensusIncomplete);
const inside = (path: string, root: string) => path === root || path.startsWith(root + "/");

function names(path: string): string[] {
  try { return readdirSync(path); }
  catch (error) { if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return []; return incomplete(); }
}
/** Expand `*` within path segments; hidden entries never match. */
function expand(pattern: string): string[] {
  let paths = ["/"];
  for (const part of pattern.split("/").filter(Boolean)) {
    const glob = part.includes("*") ? new RegExp(`^${part.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`) : undefined;
    paths = paths.flatMap(path => glob ? names(path).filter(name => !name.startsWith(".") && glob.test(name)).map(name => join(path, name)) : [join(path, part)]);
  }
  return paths;
}
function boundedText(path: string): string | undefined {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined; return incomplete(); }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > manifestMaxBytes) return incomplete();
    const bytes = Buffer.alloc(stat.size);
    if (readSync(fd, bytes, 0, stat.size, 0) !== stat.size) return incomplete();
    return bytes.toString("utf8");
  } finally { closeSync(fd); }
}
const rawPaths = (text: string): string[] => [...text.matchAll(/\/[^\s"'\\\x00,;:)\]}]+/g)].map(match => match[0]);
/** Workspace paths named by one manifest. An unparseable manifest contributes
 * every absolute path in its raw text, never nothing. */
function manifestPaths(text: string): string[] {
  try {
    const value = JSON.parse(text) as { workspacePath?: unknown };
    if (typeof value.workspacePath === "string" && isAbsolute(value.workspacePath)) return [value.workspacePath];
  } catch { /* Raw scan below keeps the census conservative. */ }
  return rawPaths(text);
}
/** Every absolute path in a parsed manifest, at any depth, but under `skip` keys. */
function absolutePaths(value: unknown, skip: ReadonlySet<string>, found: string[] = []): string[] {
  if (typeof value === "string") { if (isAbsolute(value)) found.push(value); }
  else if (Array.isArray(value)) for (const item of value) absolutePaths(item, skip, found);
  else if (value && typeof value === "object")
    for (const [key, item] of Object.entries(value)) if (!skip.has(key)) absolutePaths(item, skip, found);
  return found;
}
// Denied roots name what a job may not touch, not what it depends on.
const foreignSkip = new Set(["workspacePath", "deniedRoots"]);
/** What the unit's own jobs keep after retirement: state, credentials, logs and evidence. */
const ownStateKeys = ["jobRootDir", "durableHandoffRootDir", "authRootDir", "stateRootDir", "runtimeHomeRootDir", "encryptionKeyPath",
  "runtimeEventsPath", "outputPath", "progressPath", "logPath", "projectPreStartAdmission"] as const;
/** What another job depends on: its workspace (and everything around it) and
 * every other path it names. A unit's own job may keep only its workspace and
 * disposable temporary files inside the unit. */
function manifestClaims(text: string, own: boolean): { workspace?: string; roots: string[] } {
  let value: Record<string, unknown>;
  try { value = JSON.parse(text) as Record<string, unknown>; } catch { return { roots: rawPaths(text) }; }
  if (!value || typeof value !== "object") return { roots: rawPaths(text) };
  if (own) return { roots: absolutePaths(ownStateKeys.map(key => value[key]), new Set()) };
  const workspace = typeof value.workspacePath === "string" && isAbsolute(value.workspacePath) ? value.workspacePath : undefined;
  return { ...(workspace ? { workspace } : {}), roots: absolutePaths(value, foreignSkip) };
}
function candidates(): Set<string> {
  const found = new Set<string>();
  const add = (path: string) => { found.add(resolve(path)); if (found.size > candidateLimit) incomplete(); };
  for (const path of expand(census.bindings)) {
    const text = boundedText(path);
    if (text === undefined) continue;
    let binding: { sourceWorkspacePath?: unknown; scratchRoot?: unknown };
    try { binding = JSON.parse(text) as typeof binding; } catch { return incomplete(); }
    if (typeof binding.sourceWorkspacePath === "string" && isAbsolute(binding.sourceWorkspacePath)) add(binding.sourceWorkspacePath);
    if (typeof binding.scratchRoot === "string" && isAbsolute(binding.scratchRoot))
      for (const workspace of names(join(binding.scratchRoot, "workspaces"))) add(join(binding.scratchRoot, "workspaces", workspace));
  }
  for (const registry of census.registries.flatMap(expand))
    for (const job of names(registry)) {
      const text = boundedText(join(registry, job, "job.json"));
      if (text !== undefined) manifestPaths(text).forEach(add);
    }
  for (const snapshot of expand(census.snapshots)) add(snapshot);
  return found;
}
/** Paths another repository at `repository` depends on: its worktree link
 * target and its borrowed object stores. */
function referencesOf(repository: string): string[] {
  let marker: ReturnType<typeof lstatSync>;
  try { marker = lstatSync(join(repository, ".git")); }
  catch (error) {
    if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return incomplete();
    // A bare snapshot keeps objects at its top level.
    try { return lstatSync(join(repository, "objects")).isDirectory() ? alternatesOf(join(repository, "objects")) : []; }
    catch (inner) { if (["ENOENT", "ENOTDIR"].includes((inner as NodeJS.ErrnoException).code ?? "")) return []; return incomplete(); }
  }
  if (marker.isDirectory()) return alternatesOf(join(repository, ".git", "objects"));
  if (!marker.isFile()) return incomplete();
  const line = readFileSync(join(repository, ".git"), "utf8").trim();
  if (!line.startsWith("gitdir: ")) return incomplete();
  const gitdir = line.slice("gitdir: ".length);
  return [canonicalRetirementPath(isAbsolute(gitdir) ? gitdir : resolve(repository, gitdir))];
}
const bindingClaimKeys = ["sourceWorkspacePath", "scratchRoot", "stateRoot", "registryRootDir"] as const;
/** Refuse when a job or MiMo binding outside the unit claims a path inside it,
 * or a workspace or scratch root that contains it: a shared or nested path still
 * belongs to that owner, whatever this unit's own proofs say. `own` lists the
 * unit's manifests and, for a workstream, its binding; an own job keeping state
 * inside the unit refuses too, since deletion would take it. */
export function assertNoOtherJobClaims(unitRoot: string, own: ReadonlySet<string>): void {
  const root = canonicalRetirementPath(unitRoot);
  for (const path of expand(census.bindings)) {
    if (own.has(path)) continue;
    const text = boundedText(path);
    if (text === undefined) continue;
    let binding: Record<string, unknown>;
    try { binding = JSON.parse(text) as Record<string, unknown>; } catch { return incomplete(); }
    const claim = (key: string) => typeof binding[key] === "string" && isAbsolute(binding[key] as string)
      ? canonicalRetirementPath(binding[key] as string) : undefined;
    const scratch = claim("scratchRoot");
    if (bindingClaimKeys.some(key => { const value = claim(key); return value !== undefined && inside(value, root); }) ||
        (scratch !== undefined && inside(root, scratch))) refuseRetirement(JobRetirementRefusal.WorkspaceShared);
  }
  for (const registry of census.registries.flatMap(expand))
    for (const job of names(registry)) {
      const path = join(registry, job, "job.json"), text = boundedText(path);
      if (text === undefined) continue;
      const ownJob = own.has(path), claims = manifestClaims(text, ownJob);
      if (claims.roots.some(claim => inside(canonicalRetirementPath(claim), root)))
        refuseRetirement(ownJob ? JobRetirementRefusal.StateInsideUnit : JobRetirementRefusal.WorkspaceShared);
      if (claims.workspace) {
        const workspace = canonicalRetirementPath(claims.workspace);
        if (inside(workspace, root) || inside(root, workspace)) refuseRetirement(JobRetirementRefusal.WorkspaceShared);
      }
    }
}
/** Refuse when a repository outside the unit borrows objects from it or is a
 * linked worktree whose metadata lives inside it. Deleting the unit would
 * corrupt that repository. */
export function assertNoForeignReferences(unitRoot: string): void {
  const root = canonicalRetirementPath(unitRoot);
  for (const candidate of candidates()) {
    const resolved = canonicalRetirementPath(candidate);
    if (inside(resolved, root)) continue;
    if (referencesOf(resolved).some(reference => inside(reference, root))) refuseRetirement(JobRetirementRefusal.AlternatesReferenced);
  }
}
