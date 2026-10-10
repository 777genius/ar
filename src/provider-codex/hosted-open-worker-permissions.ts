import { lstatSync, realpathSync, type Stats } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { HostedCodexPermissionProfileId } from "./hosted-codex-permissions";

export const hostedOpenWorkerReadRoots: readonly string[] = Object.freeze(["/opt/nodejs", "/srv/workers/jobs"]);
export const hostedOpenWorkerExtraDenyDirectories: readonly string[] = Object.freeze(["/etc/credstore", "/etc/credstore.encrypted"]);
export const hostedOpenWorkerForbiddenReadRoots: readonly string[] = Object.freeze(["/", "/srv", "/srv/workers"]);

type OpenWorkerPaths = {
  readonly workspacePath: string;
  readonly toolRoot: string;
  readonly commitAllowed: boolean;
  /** Qualification tests may supply isolated temporary roots. */
  readonly readRoots?: readonly string[];
};

export enum OpenWorkerLayoutErrorCode {
  PathNotNormalized = "path_not_normalized",
  ToolRootPlacement = "tool_root_placement",
  ReadRootForbidden = "read_root_forbidden",
  ProfileUnsafe = "profile_unsafe",
  ProfileSectionDrift = "profile_section_drift",
  ProfileKeyConflict = "profile_key_conflict",
  ProfileRootNotDenied = "profile_root_not_denied",
  PathUnreadable = "path_unreadable",
  WriteRootSecretOverlap = "write_root_secret_overlap",
  ReadRootSecretOverlap = "read_root_secret_overlap",
  ToolGitPresence = "tool_git_presence",
  ToolRootNotDirectory = "tool_root_not_directory",
  ToolRootOwner = "tool_root_owner",
  ToolRootMode = "tool_root_mode",
  ToolRootIsWorkspace = "tool_root_is_workspace",
  PathEntryUnsafe = "path_entry_unsafe",
  DeniedRootContainsReadRoot = "denied_root_contains_read_root",
  DenyRootNotDirectory = "deny_root_not_directory",
  DenyRootAliasMismatch = "deny_root_alias_mismatch",
}

function invalid(code: OpenWorkerLayoutErrorCode): never {
  throw new Error(`hosted_open_worker_layout_invalid:${code}`);
}
function contains(parent: string, child: string): boolean {
  return parent === child || child.startsWith(parent === "/" ? parent : `${parent}/`);
}
function overlaps(a: string, b: string): boolean { return contains(a, b) || contains(b, a); }
function validatePath(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path) invalid(OpenWorkerLayoutErrorCode.PathNotNormalized);
}
function validatedPaths(input: OpenWorkerPaths): readonly string[] {
  const reads = input.readRoots ?? hostedOpenWorkerReadRoots;
  [input.workspacePath, input.toolRoot, ...reads].forEach(validatePath);
  if (input.toolRoot !== `${input.workspacePath}.tool` || overlaps(input.workspacePath, input.toolRoot)) {
    invalid(OpenWorkerLayoutErrorCode.ToolRootPlacement);
  }
  if (reads.some(path => hostedOpenWorkerForbiddenReadRoots.includes(path))) invalid(OpenWorkerLayoutErrorCode.ReadRootForbidden);
  return reads;
}

/** Adds explicit open-worker grants without regenerating any strict policy text. */
export function renderHostedOpenWorkerProfilesToml(input: OpenWorkerPaths & {
  readonly strictProfilesToml: string;
  readonly denyDirectories: readonly string[];
}): string {
  const reads = validatedPaths(input);
  input.denyDirectories.forEach(validatePath);
  if (input.strictProfilesToml.includes("danger-full-access")) invalid(OpenWorkerLayoutErrorCode.ProfileUnsafe);
  let rendered = input.strictProfilesToml;
  for (const profile of [HostedCodexPermissionProfileId.ReadOnly, HostedCodexPermissionProfileId.WorkspaceWrite]) {
    const header = `[permissions.${profile}.filesystem]`;
    const lines = rendered.split("\n");
    const indexes = lines.flatMap((line, index) => line === header ? [index] : []);
    if (indexes.length !== 1) invalid(OpenWorkerLayoutErrorCode.ProfileSectionDrift);
    const start = indexes[0]!;
    const end = lines.findIndex((line, index) => index > start && line.startsWith("["));
    const section = lines.slice(start + 1, end < 0 ? undefined : end);
    const keys = new Map<string, string>();
    for (const line of section) {
      const match = line.match(/^\s*("(?:[^"\\]|\\.)*")\s*=\s*("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/);
      if (!match && line.trim() && !line.trim().startsWith("#")) invalid(OpenWorkerLayoutErrorCode.ProfileSectionDrift);
      if (match) {
        let key: string, value: string;
        try { key = JSON.parse(match[1]!) as string; value = JSON.parse(match[2]!) as string; }
        catch { invalid(OpenWorkerLayoutErrorCode.ProfileSectionDrift); }
        if (key !== ":root" && key !== ":minimal") validatePath(key);
        if (keys.has(key) && keys.get(key) !== value) invalid(OpenWorkerLayoutErrorCode.ProfileKeyConflict);
        keys.set(key, value);
      }
    }
    if (keys.get(":root") !== "deny") invalid(OpenWorkerLayoutErrorCode.ProfileRootNotDenied);
    const additions: string[] = [];
    const grants = [...reads.map(path => [path, "read"] as const),
      ...[`${input.toolRoot}/home`, `${input.toolRoot}/tmp`].map(path => [path, "write"] as const),
      ...(input.commitAllowed && profile === HostedCodexPermissionProfileId.WorkspaceWrite ? [[`${input.toolRoot}/git`, "write"] as const] : []),
      ...input.denyDirectories.map(path => [path, "deny"] as const)];
    for (const [path, access] of grants) {
      validatePath(path);
      if (keys.has(path) && keys.get(path) !== access) invalid(OpenWorkerLayoutErrorCode.ProfileKeyConflict);
      if (!keys.has(path)) additions.push(`${JSON.stringify(path)} = ${JSON.stringify(access)}`);
      keys.set(path, access);
    }
    lines.splice(start + 1, 0, ...additions);
    rendered = lines.join("\n");
  }
  return rendered;
}

function entry(path: string): Stats | undefined {
  try { return lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    invalid(OpenWorkerLayoutErrorCode.PathUnreadable);
  }
}

/** Read-only preflight; returns directory masks beneath admitted read roots, including paths that do not exist yet. */
export function assertHostedOpenWorkerLayout(input: OpenWorkerPaths & {
  readonly secretRoots: readonly string[];
  readonly deniedRoots: readonly string[];
  readonly pathEnv: string;
  readonly ownerUid?: number;
}): { readonly denyDirectories: readonly string[] } {
  const reads = validatedPaths(input);
  const writes = [input.workspacePath, input.toolRoot, `${input.toolRoot}/home`, `${input.toolRoot}/tmp`, `${input.toolRoot}/git`];
  [...writes, ...input.secretRoots, ...input.deniedRoots, ...hostedOpenWorkerExtraDenyDirectories].forEach(validatePath);
  if (writes.some(write => input.secretRoots.some(secret => overlaps(write, secret)))) invalid(OpenWorkerLayoutErrorCode.WriteRootSecretOverlap);
  if (writes.some(write => input.deniedRoots.some(denied => overlaps(write, denied)))) invalid(OpenWorkerLayoutErrorCode.WriteRootSecretOverlap);
  if (reads.some(read => input.secretRoots.some(secret => overlaps(read, secret)))) invalid(OpenWorkerLayoutErrorCode.ReadRootSecretOverlap);
  if (Boolean(entry(`${input.toolRoot}/git`)) !== input.commitAllowed) invalid(OpenWorkerLayoutErrorCode.ToolGitPresence);
  for (const path of [input.toolRoot, `${input.toolRoot}/home`, `${input.toolRoot}/tmp`, ...(input.commitAllowed ? [`${input.toolRoot}/git`] : [])]) {
    const info = entry(path);
    if (!info?.isDirectory() || info.isSymbolicLink()) invalid(OpenWorkerLayoutErrorCode.ToolRootNotDirectory);
    if (info.uid !== (input.ownerUid ?? 0)) invalid(OpenWorkerLayoutErrorCode.ToolRootOwner);
    if (path === input.toolRoot && (info.mode & 0o077) !== 0) invalid(OpenWorkerLayoutErrorCode.ToolRootMode);
  }
  if (entry(`${input.toolRoot}/.git`)) invalid(OpenWorkerLayoutErrorCode.ToolRootIsWorkspace);
  for (const path of input.pathEnv.split(":")) {
    if (!path || !isAbsolute(path) || resolve(path) !== path ||
        [input.workspacePath, input.toolRoot, "/srv/workers/jobs"].some(root => contains(root, path))) {
      invalid(OpenWorkerLayoutErrorCode.PathEntryUnsafe);
    }
  }
  const denied: string[] = [];
  for (const path of [...input.deniedRoots, ...hostedOpenWorkerExtraDenyDirectories]) {
    // Check aliases before admission: an outside spelling can resolve into a read root.
    const info = entry(path);
    let ancestor = path;
    while (!entry(ancestor)) ancestor = dirname(ancestor);
    const real = resolve(realpathSync(ancestor), relative(ancestor, path));
    if (real !== path && reads.some(read => contains(read, real))) invalid(OpenWorkerLayoutErrorCode.DenyRootAliasMismatch);
    if (reads.some(read => contains(path, read))) invalid(OpenWorkerLayoutErrorCode.DeniedRootContainsReadRoot);
    if (!reads.some(read => contains(read, path)) && !hostedOpenWorkerExtraDenyDirectories.includes(path)) {
      continue;
    }
    // Keep missing entries: Codex re-applies deny masks at every command start and
    // skips paths that do not exist yet, so a directory created later stays hidden.
    if (info && (!info.isDirectory() || info.isSymbolicLink())) invalid(OpenWorkerLayoutErrorCode.DenyRootNotDirectory);
    denied.push(path);
  }
  return { denyDirectories: [...new Set(denied)].filter(path => !denied.some(other => other !== path && contains(other, path))) };
}
