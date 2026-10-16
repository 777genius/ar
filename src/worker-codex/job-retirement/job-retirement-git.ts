import { execFileSync } from "node:child_process";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, realpathSync,
  rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { managedDependencyGitEnvironment, managedDependencyGitFlags } from "../managed-dependency-git-hygiene";
import { researchCustody } from "../research-launch-files";
import { JobRetirementRefusal, refuseRetirement } from "./job-retirement-contract";

const gitTimeoutMs = 120_000, gitMaxBytes = 32 * 1024 * 1024;
/** Root reads of foreign repositories: no hooks, fsmonitor, system or global
 * config, attributes file, transport, submodule recursion, pager, replace
 * objects or optional locks. Only `inspectRetirementRepository` may run it on a
 * repository it has not checked yet. Handoff capture formatting flags are kept
 * so recomputed patches are byte-comparable with a packet. */
export function retirementGitBytes(repository: string, args: readonly string[], index?: string, input?: Buffer): Buffer {
  return git(["-C", repository, "--no-replace-objects", "--literal-pathspecs", ...managedDependencyGitFlags,
    "-c", "core.attributesFile=/dev/null", "-c", "protocol.allow=never", "-c", "submodule.recurse=false", "-c", "core.pager=cat",
    // Change detection uses every stat field and no cached untracked listing.
    "-c", "core.trustctime=true", "-c", "core.checkStat=default", "-c", "core.untrackedCache=false", "-c", "core.splitIndex=false",
    "-c", "core.quotepath=false", "-c", "core.fileMode=true", "-c", "gc.auto=0", "-c", "maintenance.auto=false", ...args], index, input);
}
function git(args: readonly string[], index?: string, input?: Buffer): Buffer {
  researchCustody("/usr/bin/git");
  try {
    return execFileSync("/usr/bin/git", args, { cwd: "/", env: { ...managedDependencyGitEnvironment(), GIT_NO_LAZY_FETCH: "1", GIT_PAGER: "cat",
      ...(index ? { GIT_INDEX_FILE: index } : {}) }, timeout: gitTimeoutMs, maxBuffer: gitMaxBytes,
      ...(input ? { input } : {}), stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] });
  } catch (error) {
    // A repository too large for the bounded run is named, not a bare spawn error.
    if (["ETIMEDOUT", "ENOBUFS"].includes((error as NodeJS.ErrnoException).code ?? "")) refuseRetirement(JobRetirementRefusal.GitLimitExceeded);
    throw error;
  }
}
export type RetirementGit = (args: readonly string[]) => Buffer;
/** Status and diff trust the stat data cached in the index, and whoever wrote
 * the index controls it. They run on a private index holding the same staged
 * entries without any stat data, which Git refreshes by hashing every file, so
 * no edit hides behind forged stat data. The repository's index is only read. */
export function withContentRefreshedIndex<T>(workspace: string, effect: (git: RetirementGit) => T): T {
  const staged = retirementGitBytes(workspace, ["ls-files", "-z", "--stage"]);
  const directory = mkdtempSync(join(tmpdir(), "job-retirement-index-"));
  try {
    const index = join(directory, "index"), run: RetirementGit = args => retirementGitBytes(workspace, args, index);
    retirementGitBytes(workspace, ["update-index", "-z", "--index-info"], index, staged);
    run(["update-index", "-q", "--refresh", "--unmerged"]);
    return effect(run);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
/** Diffs never run a driver or look into a nested repository; status takes
 * `--ignore-submodules=all` alone. */
export const retirementDiffFlags: readonly string[] = Object.freeze(["--no-ext-diff", "--no-textconv", "--ignore-submodules=all"]);
/** Git and its metadata files report resolved paths; compare those, never spellings. */
export function canonicalRetirementPath(path: string): string {
  try { return realpathSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return normalize(path); throw error; }
}
export const retirementGitText = (repository: string, args: readonly string[]): string => retirementGitBytes(repository, args).toString("utf8").trim();

export type RetirementRepository = Readonly<{ head: string; gitDir: string; commonDir: string; linked: boolean }>;
/** Only root can change it: root's, no link, no group or other write. */
const rootOnly = (stat: { uid: number; mode: number }) => stat.uid === 0 && (stat.mode & 0o022) === 0;
function rootOwned(path: string, missing: JobRetirementRefusal): boolean {
  try { const stat = lstatSync(path); return rootOnly(stat) && !stat.isSymbolicLink(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return refuseRetirement(missing); throw error; }
}
/** A root-owned regular file, read without following a link or blocking on a
 * FIFO; `undefined` when absent. */
function rootFileText(path: string, maxBytes: number, reason: JobRetirementRefusal): string | undefined {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; return refuseRetirement(reason); }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || !rootOnly(stat) || stat.size > maxBytes) return refuseRetirement(reason);
    const bytes = Buffer.alloc(stat.size);
    if (readSync(fd, bytes, 0, stat.size, 0) !== stat.size) return refuseRetirement(reason);
    return bytes.toString("utf8");
  } finally { closeSync(fd); }
}
const notRepository = (): never => refuseRetirement(JobRetirementRefusal.ManifestInvalid);
/** Where Git will look, derived from the files alone before Git runs: a
 * standalone `.git` directory, or a linked worktree whose `.git` file, the
 * registration's `commondir` and its `gitdir` back link all agree. */
function repositoryLayout(workspace: string): Omit<RetirementRepository, "head"> {
  const marker = join(workspace, ".git"), stat = lstatSync(marker);
  if (stat.isDirectory()) {
    if (existsSync(join(marker, "commondir"))) notRepository();
    return { gitDir: canonicalRetirementPath(marker), commonDir: canonicalRetirementPath(marker), linked: false };
  }
  if (!stat.isFile()) return notRepository();
  const pointer = /^gitdir: ([^\n]+)\n?$/.exec(rootFileText(marker, 4096, JobRetirementRefusal.ManifestInvalid) ?? "");
  if (!pointer) return notRepository();
  const gitDir = canonicalRetirementPath(resolve(workspace, pointer[1]!));
  const common = rootFileText(join(gitDir, "commondir"), 4096, JobRetirementRefusal.ManifestInvalid)?.trim();
  const back = rootFileText(join(gitDir, "gitdir"), 4096, JobRetirementRefusal.ManifestInvalid)?.trim();
  if (!common || !back) return notRepository();
  const commonDir = canonicalRetirementPath(resolve(gitDir, common));
  if (dirname(gitDir) !== join(commonDir, "worktrees") || canonicalRetirementPath(resolve(gitDir, back)) !== canonicalRetirementPath(marker))
    notRepository();
  return { gitDir, commonDir, linked: true };
}
/** The keys of one configuration file as Git itself reads them, without
 * includes and outside any repository: section, subsection and name. A file Git
 * cannot read is refused. */
function configKeys(path: string): Array<readonly [string, string | undefined, string]> {
  let listed: string;
  try { listed = git(["config", "--file", path, "--null", "--list"]).toString("utf8"); }
  catch { return refuseRetirement(JobRetirementRefusal.GitConfigUnsafe); }
  return listed.split("\0").filter(Boolean).map(entry => {
    const key = entry.split("\n", 1)[0]!, first = key.indexOf("."), last = key.lastIndexOf(".");
    if (first <= 0 || last === key.length - 1) refuseRetirement(JobRetirementRefusal.GitConfigUnsafe);
    return [key.slice(0, first).toLowerCase(), first === last ? undefined : key.slice(first + 1, last), key.slice(last + 1).toLowerCase()] as const;
  });
}
const unsafeCoreKeys = new Set(["fsmonitor", "usebuiltinfsmonitor", "hookspath", "sshcommand", "gitproxy", "askpass", "pager", "editor",
  "worktree", "excludesfile", "attributesfile", "alternaterefscommand", "sparsecheckout", "sparsecheckoutcone", "ignorestat"]);
/** Keys that name a program Git may run, pull in more configuration, add a
 * nested repository, or change which files and edits status and diff see. */
function unsafeConfigKey([section, subsection, name]: readonly [string, string | undefined, string]): boolean {
  switch (section) {
    case "include": case "includeif": case "filter": case "submodule": case "pager": case "hook": return true;
    case "diff": return subsection === undefined ? name === "external" : name === "textconv" || name === "command";
    case "merge": return subsection !== undefined && name === "driver";
    case "core": return unsafeCoreKeys.has(name);
    case "gpg": return name === "program" || name === "defaultkeycommand";
    case "credential": return name === "helper";
    case "difftool": case "mergetool": return name === "cmd" || name === "path";
    case "trailer": return name === "command" || name === "cmd";
    default: return false;
  }
}
/** Root runs Git here, so every configuration file Git reads in the repository
 * must be changeable by root alone and set none of the unsafe keys. The command
 * line already disables hooks, fsmonitor, drivers and transports; this refuses
 * a repository that would need them. */
export function assertRetirementConfigInert(...configs: readonly string[]): void {
  for (const path of configs)
    if (rootFileText(path, 1024 * 1024, JobRetirementRefusal.GitConfigUnsafe) !== undefined && configKeys(path).some(unsafeConfigKey))
      refuseRetirement(JobRetirementRefusal.GitConfigUnsafe);
}
/** A nested repository is one root never inspected and the diff cannot carry. */
function assertNoSubmodules(workspace: string, layout: Omit<RetirementRepository, "head">): void {
  for (const path of [join(workspace, ".gitmodules"), join(layout.gitDir, "modules"), join(layout.commonDir, "modules")]) {
    try { lstatSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    refuseRetirement(JobRetirementRefusal.GitSubmodulePresent);
  }
}
/** Every index entry must be compared with the files: an assume-unchanged or
 * skip-worktree entry would hide an edit from status and diff. A gitlink is a
 * submodule the `.gitmodules` check may not see. */
function assertIndexHonest(workspace: string): void {
  for (const row of retirementGitBytes(workspace, ["ls-files", "-z", "-v", "--stage"]).toString("utf8").split("\0")) {
    if (!row) continue;
    const entry = /^([A-Za-z]) (\d{6}) [0-9a-f]{40,64} [0-3]\t/.exec(row);
    if (!entry || (entry[1] !== "H" && entry[1] !== "M")) refuseRetirement(JobRetirementRefusal.GitIndexMasked);
    if (entry![2] === "160000") refuseRetirement(JobRetirementRefusal.GitSubmodulePresent);
  }
}
/** A workspace is a standalone clone or a linked worktree; anything else is
 * doubt. Ownership, layout, configuration and submodules are checked from the
 * files before Git first runs; Git then has to agree with that layout. */
export function inspectRetirementRepository(workspace: string): RetirementRepository {
  if (!rootOwned(workspace, JobRetirementRefusal.WorkspaceMissing) || !rootOwned(join(workspace, ".git"), JobRetirementRefusal.ManifestInvalid))
    refuseRetirement(JobRetirementRefusal.WorkspaceForeignOwner);
  const layout = repositoryLayout(workspace);
  if (!rootOwned(layout.gitDir, JobRetirementRefusal.ManifestInvalid) || !rootOwned(layout.commonDir, JobRetirementRefusal.ManifestInvalid))
    refuseRetirement(JobRetirementRefusal.WorkspaceForeignOwner);
  assertRetirementConfigInert(join(layout.commonDir, "config"), join(layout.gitDir, "config.worktree"));
  assertNoSubmodules(workspace, layout);
  let head: string;
  try {
    head = retirementGitText(workspace, ["rev-parse", "--verify", "HEAD^{commit}"]);
    const [gitDir, commonDir] = retirementGitText(workspace, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"]).split("\n");
    if (!/^[a-f0-9]{40}$/.test(head) || !gitDir || !commonDir || canonicalRetirementPath(gitDir) !== layout.gitDir ||
        canonicalRetirementPath(commonDir) !== layout.commonDir) throw new Error("git");
  } catch { return notRepository(); }
  assertIndexHonest(workspace);
  return { head, ...layout };
}
/** Commits reachable from `refs` (and every local branch with `allBranches`)
 * that no remote-tracking ref contains. Handoff packets carry no commits, so any
 * such commit would be lost with the repository. */
export function assertNoUnpublishedCommits(repository: string, refs: readonly string[], allBranches = false): void {
  let count: string;
  try { count = retirementGitText(repository, ["rev-list", "--count", ...refs, ...(allBranches ? ["--branches"] : []), "--not", "--remotes"]); }
  catch { return refuseRetirement(JobRetirementRefusal.BranchUnpublishedCommits); }
  if (count !== "0") refuseRetirement(JobRetirementRefusal.BranchUnpublishedCommits);
}
export function existingRefs(repository: string, refs: readonly string[]): string[] {
  return refs.length ? retirementGitText(repository, ["for-each-ref", "--format=%(refname)", ...refs]).split("\n").filter(Boolean) : [];
}
export function assertNoStash(repository: string): void {
  if (existingRefs(repository, ["refs/stash"]).length) refuseRetirement(JobRetirementRefusal.StashPresent);
}
/** Linked worktree registrations of a common Git directory: name to the
 * worktree path it records (`gitdir` minus `/.git`). Bounded and file-based. */
export function linkedWorktrees(commonDir: string): ReadonlyMap<string, string> {
  const root = join(commonDir, "worktrees"), rows = new Map<string, string>();
  let names: string[];
  try { names = readdirSync(root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return rows; throw error; }
  if (names.length > 4096) refuseRetirement(JobRetirementRefusal.WorktreeOutsideUnit);
  for (const name of names) {
    let gitdir: string;
    try { gitdir = readFileSync(join(root, name, "gitdir"), "utf8").trim(); }
    catch { return refuseRetirement(JobRetirementRefusal.WorktreeOutsideUnit); }
    if (!isAbsolute(gitdir) || !gitdir.endsWith("/.git")) refuseRetirement(JobRetirementRefusal.WorktreeOutsideUnit);
    rows.set(name, canonicalRetirementPath(gitdir.slice(0, -"/.git".length)));
  }
  return rows;
}
/** Object stores this one borrows from. Deleting the borrower is safe; HTTP
 * alternates are not a local store and are never expected here. */
export function alternatesOf(objectsDir: string): string[] {
  try { lstatSync(join(objectsDir, "info", "http-alternates")); refuseRetirement(JobRetirementRefusal.AlternatesUnsupported); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  let text: string;
  try { text = readFileSync(join(objectsDir, "info", "alternates"), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const rows = text.split("\n").map(line => line.trim()).filter(line => line && !line.startsWith("#"));
  if (rows.length > 64) refuseRetirement(JobRetirementRefusal.AlternatesUnsupported);
  return rows.map(row => canonicalRetirementPath(isAbsolute(row) ? row : resolve(objectsDir, row)));
}
