import { isHostedDependencyWorkspace } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { execFile } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { withHostedActivationFence } from "@vioxen/subscription-runtime/provider-codex";
import { HostedDependencyRootPurpose, captureCurrentHostedDependencyRootPurpose,
  assertCurrentHostedDependencyRootPurpose, type HostedDependencyRootPurposeContext,
  isHostedDependencySignedTaskId, requiresCurrentHostedDependencyRootPurpose,
  type HostedDependencyManagedGitScope } from "./hosted-dependency-root-purpose";
import { readHostedDependencyPrivateScratchOperations, type HostedDependencyPrivateScratch, readManagedDependencyPrivateIndex } from "./hosted-dependency-private-scratch";
import { parsePatchCoverage } from "./git-patch-content-coverage";
import { promisify } from "node:util";
import type { SafeExecutionCommandRunner } from "@vioxen/subscription-runtime/worker-core";
const execute = promisify(execFile);

export function managedDependencyGitEnvironment(): NodeJS.ProcessEnv {
  return cleanEnvironment();
}
export const managedDependencyGitFlags: readonly string[] = Object.freeze([
  "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "diff.external=",
]);
/** Only fixed Git hygiene executes on the privileged side. Other commands and
 * project code belong to the contained provider/tool unit, never this adapter.
 */
export class ManagedDependencyGitRunner implements SafeExecutionCommandRunner {
  #context: HostedDependencyRootPurposeContext | undefined;
  async run(input: Parameters<SafeExecutionCommandRunner["run"]>[0]) {
    if (!isHostedDependencyWorkspace(input.cwd) || input.command !== "/usr/bin/git") throw new Error("dependency_host_git_unsupported");
    if (classifyManagedDependencyGitArgs(input.args) === ManagedDependencyGitOperation.PrivateIndex) throw new Error("dependency_host_git_private_index_required");
    const context = this.#context ?? captureManagedDependencyGitContext(input.cwd);
    if (context === undefined) throw new Error("dependency_host_git_unsupported");
    assertManagedDependencyGitContext(context, input.cwd); this.#context = context;
    const result = await runManagedDependencyGitBuffer(context, input.args, {
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      ...(input.maxBufferBytes === undefined ? {} : { maxBufferBytes: input.maxBufferBytes }),
      ...(input.abortSignal === undefined ? {} : { abortSignal: input.abortSignal }),
    });
    return { stdout: String(result.stdout), stderr: String(result.stderr) };
  }
}

export async function isLinkedGitWorktree(workspacePath: string): Promise<boolean> {
  // A protected repository has a fixed standalone .git directory. A denial
  // must never fall through to an unqualified PATH or repository-discovery read.
  const context = captureManagedDependencyGitContext(workspacePath);
  if (context !== undefined) {
    const { stdout } = await runManagedDependencyGitBuffer(context, ["rev-parse",
      "--path-format=absolute", "--git-dir", "--git-common-dir"], { timeoutMs: 5_000 });
    const expected = join(assertManagedDependencyGitContext(context).workspace.canonicalPath, ".git");
    const paths = stdout.toString("utf8").trim().split(/\r?\n/);
    if (paths.length !== 2 || paths.some(path => path !== expected)) throw new Error("dependency_host_git_repository_indirection");
    return false;
  }
  try {
    const { stdout } = await execute("git", [
      "-C",
      workspacePath,
      "rev-parse",
      "--path-format=absolute",
      "--git-dir",
      "--git-common-dir",
    ], { timeout: 5_000 });
    const [gitDir, gitCommonDir] = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return Boolean(gitDir && gitCommonDir && gitDir !== gitCommonDir);
  } catch {
    return false;
  }
}


/** Syntax classification only. Actual current purpose, executable/config pins,
 * output membership and private index custody are independently mandatory. */
export enum ManagedDependencyGitOperation {
  RepositoryIdentity = "repository_identity",
  AuthoredStatus = "authored_status",
  AuthoredDiff = "authored_diff",
  AuthoredIndexEntries = "authored_index_entries",
  AuthoredTreeEntries = "authored_tree_entries",
  AuthoredBlob = "authored_blob",
  PrivateIndex = "private_index",
  AuthoredNoIndexDiff = "authored_no_index_diff",
}
const objectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
function exactArgs(args: readonly string[], expected: readonly string[]): boolean {
  return args.length === expected.length && args.every((value, index) => value === expected[index]);
}
function authoredPath(path: string): boolean {
  return path.length > 0 && path.length <= 4096 && !path.includes("\0") &&
    !path.includes("\\") && !path.startsWith("/") &&
    path.split("/").every(segment => segment.length > 0 && segment !== ".." &&
      segment !== ".git" && segment !== "node_modules" && segment !== ".cache") &&
    (path === "." || !path.split("/").includes("."));
}
/** No command, option prefix, config override, helper, filter or caller pathspec
 * magic is accepted beyond these inventoried read/private-index operations. */
export function classifyManagedDependencyGitArgs(args: readonly string[]): ManagedDependencyGitOperation {
  const deny = (): never => { throw new Error("dependency_host_git_unsupported"); };
  if (args.length === 0 || args.length > 1024 || args.some(arg => typeof arg !== "string" || arg.includes("\0") || arg.length > 4096)) return deny();
  const identity: readonly (readonly string[])[] = [
    ["rev-parse", "--verify", "HEAD"], ["rev-parse", "--verify", "HEAD^{tree}"],
    ["rev-parse", "HEAD^{tree}"], ["rev-parse", "--is-inside-work-tree"],
    ["rev-parse", "--is-inside-work-tree", "--show-prefix", "--show-toplevel"],
    ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"],
    ["rev-parse", "--path-format=absolute", "--git-path", "index"],
    ["rev-parse", "--path-format=absolute", "--git-path", "objects"],
    ["rev-parse", "--path-format=absolute", "--shared-index-path"],
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    ["merge-base", "HEAD", "origin/main"],
  ];
  if (identity.some(expected => exactArgs(args, expected))) return ManagedDependencyGitOperation.RepositoryIdentity;
  if ([["status", "--porcelain=v2", "-z", "--untracked-files=all"],
    ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."],
    ["status", "--porcelain", "--untracked-files=all"]].some(expected => exactArgs(args, expected))) {
    return ManagedDependencyGitOperation.AuthoredStatus;
  }
  if (args[0] === "cat-file" && args[1] === "blob" && args.length === 3 && objectId.test(args[2]!)) {
    return ManagedDependencyGitOperation.AuthoredBlob;
  }
  if (exactArgs(args, ["apply", "--cached", "--whitespace=nowarn", "-"]) ||
      exactArgs(args, ["write-tree"]) || args.length === 2 && args[0] === "read-tree" &&
      (args[1] === "HEAD" || objectId.test(args[1]!))) return ManagedDependencyGitOperation.PrivateIndex;
  if (args[0] === "ls-files") {
    const end = args.indexOf("--"), options = end < 0 ? args : args.slice(0, end);
    if (![["ls-files", "--others", "--exclude-standard", "-z"],
      ["ls-files", "--stage", "-z"]].some(expected => exactArgs(options, expected)) ||
      end >= 0 && (end === args.length - 1 || !args.slice(end + 1).every(authoredPath))) return deny();
    return ManagedDependencyGitOperation.AuthoredIndexEntries;
  }
  if (args[0] === "ls-tree") {
    const offset = args[1] === "-z" ? 2 : 1, ref = args[offset];
    if (!(ref === "HEAD" || typeof ref === "string" && objectId.test(ref)) ||
        args[offset + 1] !== "--" || args.length <= offset + 2 ||
        !args.slice(offset + 2).every(authoredPath)) return deny();
    return ManagedDependencyGitOperation.AuthoredTreeEntries;
  }
  if (args[0] === "diff") {
    if (args.length === 9 && exactArgs(args.slice(0, 7), ["diff", "--cached", "--no-ext-diff",
      "--name-only", "--no-renames", "--diff-filter=A", "-z"]) && objectId.test(args[7]!) &&
      args[8] === "--") return ManagedDependencyGitOperation.AuthoredDiff;
    if (args.length === 6 && exactArgs(args.slice(0, 5), ["diff", "--binary", "--no-index", "--", "/dev/null"]) &&
        authoredPath(args[5]!)) return ManagedDependencyGitOperation.AuthoredNoIndexDiff;
    const end = args.indexOf("--");
    if (end < 1 || !args.slice(end + 1).every(authoredPath)) return deny();
    const options = args.slice(1, end);
    const known = new Set(["--relative", "--cached", "--binary", "--no-ext-diff", "--no-renames",
      "--name-only", "--numstat", "--stat", "-z"]);
    const seen = new Set<string>(); let reference = false;
    for (const option of options) {
      if (option === "HEAD" || objectId.test(option)) {
        if (reference) return deny(); reference = true; continue;
      }
      if (!known.has(option) || seen.has(option)) return deny(); seen.add(option);
    }
    if (!seen.has("--no-ext-diff") && !seen.has("--no-renames")) return deny();
    if (["--name-only", "--numstat", "--stat"].filter(option => seen.has(option)).length > 1) return deny();
    return ManagedDependencyGitOperation.AuthoredDiff;
  }
  return deny();
}


export type { HostedDependencyRootPurposeContext } from "./hosted-dependency-root-purpose";
export type HandoffGitSelection = string | HostedDependencyRootPurposeContext;
/** Exact signed identity grammar shared with the actual producer. This is
 * syntax only; equality with the genuine current task remains mandatory. */
export const isManagedDependencySignedTaskId = isHostedDependencySignedTaskId;
/** Selection data cannot mint a context. A token is always reauthenticated. */
export function resolveManagedDependencyGitContext(workspacePath: string | undefined, selection?: HandoffGitSelection): HostedDependencyRootPurposeContext | undefined {
  if (typeof selection === "object" && selection !== null) {
    assertManagedDependencyGitContext(selection, workspacePath); return selection;
  }
  const context = captureManagedDependencyGitContext(workspacePath);
  if (context !== undefined && selection !== undefined && selection !== "/usr/bin/git") throw new Error("dependency_host_git_unsupported");
  return context;
}
export function captureManagedDependencyGitContext(workspacePath?: string): HostedDependencyRootPurposeContext | undefined {
  // Actual C/R origin is classified before any request-path fallback. Aliases
  // and omitted contexts cannot select legacy IO in a protected outer process.
  const required = requiresCurrentHostedDependencyRootPurpose();
  if (!required && (workspacePath === undefined || !isHostedDependencyWorkspace(workspacePath))) return undefined;
  const context = captureCurrentHostedDependencyRootPurpose(HostedDependencyRootPurpose.ManagedGitReadV1);
  assertManagedDependencyGitContext(context, workspacePath);
  return context;
}
/** Recheck a previously ordinary route before legacy IO or callbacks. This
 * routing fact grants no purpose and cannot switch a started legacy operation. */
export function assertUnmanagedDependencyGitRoute(): void {
  if (requiresCurrentHostedDependencyRootPurpose()) throw new Error("dependency_host_git_purpose_required");
}
export function assertManagedDependencyGitContext(context: HostedDependencyRootPurposeContext, workspacePath?: string): HostedDependencyManagedGitScope {
  return withHostedActivationFence(fence => {
    const scope = assertCurrentHostedDependencyRootPurpose(context, HostedDependencyRootPurpose.ManagedGitReadV1, fence);
    if (workspacePath !== undefined && workspacePath !== scope.workspace.canonicalPath) throw new Error("dependency_host_git_scope_mismatch");
    return scope;
  });
}
function within(root: string, path: string): boolean { return path === root || path.startsWith(root + "/"); }
function scopedPath(scope: HostedDependencyManagedGitScope, path: string): string {
  const relativePath = path.startsWith(scope.workspace.canonicalPath + "/") ? path.slice(scope.workspace.canonicalPath.length + 1) : path;
  const absolute = resolve(scope.workspace.canonicalPath, relativePath);
  if (!authoredPath(relativePath) || !within(scope.workspace.canonicalPath, absolute) ||
      !scope.authoredRoots.some(root => within(root.canonicalPath, absolute)) ||
      scope.generatedRoots.some(root => within(root.canonicalPath, absolute))) throw new Error("dependency_host_git_generated_membership");
  return relativePath;
}
export function assertManagedDependencyGitAuthoredPath(context: HostedDependencyRootPurposeContext, path: string): string {
  return scopedPath(assertManagedDependencyGitContext(context), path);
}
function repositoryObjects(scope: HostedDependencyManagedGitScope): string {
  const git = join(scope.workspace.canonicalPath, ".git");
  const directory = lstatSync(git);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== 0 || (directory.mode & 0o022) || realpathSync(git) !== git) throw new Error("dependency_host_git_repository_indirection");
  for (const leaf of ["commondir", "gitdir", "shallow", "info/grafts"]) {
    try { lstatSync(join(git, leaf)); }
    catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue; throw error; }
    throw new Error("dependency_host_git_repository_indirection");
  }
  const path = join(scope.workspace.canonicalPath, ".git/objects"), stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) || realpathSync(path) !== path) throw new Error("dependency_host_git_repository_indirection");
  for (const suffix of ["info/alternates", "info/http-alternates"]) {
    try { lstatSync(join(path, suffix)); }
    catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue; throw error; }
    throw new Error("dependency_host_git_repository_indirection");
  }
  return path;
}
const membership = new WeakMap<HostedDependencyRootPurposeContext, Set<string>>();
function recordMembership(context: HostedDependencyRootPurposeContext, scope: HostedDependencyManagedGitScope, output: Buffer, tree: boolean): void {
  const known = membership.get(context) ?? new Set<string>();
  if (!Buffer.from(output.toString("utf8"), "utf8").equals(output)) throw new Error("dependency_host_git_membership_invalid");
  const rows = output.toString("utf8").split("\0").filter(Boolean);
  if (rows.length > 100_000) throw new Error("dependency_host_git_membership_limit");
  for (const row of rows) {
    const match = (tree ? /^([0-7]{6}) (blob|tree|commit) ([a-f0-9]{40}(?:[a-f0-9]{24})?)\t([\s\S]+)$/ : /^([0-7]{6}) ([a-f0-9]{40}(?:[a-f0-9]{24})?) ([0-3])\t([\s\S]+)$/).exec(row);
    if (!match) throw new Error("dependency_host_git_membership_invalid");
    if (!tree && match[3] !== "0") throw new Error("dependency_host_git_membership_invalid");
    scopedPath(scope, match[4]!);
    if (match[1] === "160000") throw new Error("dependency_host_git_repository_indirection");
    if (tree && match[2] !== "blob") continue;
    known.add(tree ? match[3]! : match[2]!);
  }
  membership.set(context, known);
}
function cleanEnvironment(): NodeJS.ProcessEnv {
  return { PATH: "/nonexistent", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", HOME: "/", TMPDIR: "/nonexistent",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_COUNT: "0", GIT_ATTR_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1" };
}
export async function runManagedDependencyGitBuffer(context: HostedDependencyRootPurposeContext, args: readonly string[], options: {
  readonly timeoutMs?: number; readonly maxBufferBytes?: number; readonly abortSignal?: AbortSignal;
  readonly indexSnapshot?: HostedDependencyPrivateScratch;
  readonly input?: Buffer;
} = {}): Promise<{ stdout: Buffer; stderr: Buffer }> {
  const kind = classifyManagedDependencyGitArgs(args);
  const snapshot = options.indexSnapshot;
  const privateScratch = snapshot === undefined ? undefined : readHostedDependencyPrivateScratchOperations(snapshot);
  if (kind === ManagedDependencyGitOperation.PrivateIndex && snapshot === undefined) throw new Error("dependency_host_git_private_index_required");
  const scope = assertManagedDependencyGitContext(context);
  if (args[0] === "apply" && (options.input === undefined || options.input.length > 16 * 1024 * 1024) ||
      args[0] !== "apply" && options.input !== undefined) throw new Error("dependency_host_git_input_invalid");
  if (options.input !== undefined) {
    const patch = options.input.toString("utf8");
    if (!Buffer.from(patch, "utf8").equals(options.input)) throw new Error("dependency_host_git_input_invalid");
    const coverage = parsePatchCoverage(patch, path => scopedPath(scope, path));
    if (coverage.sections.length === 0 || coverage.sections.length > 1024) throw new Error("dependency_host_git_input_invalid");
  }
  const end = args.indexOf("--");
  if (end >= 0) for (const path of args.slice(end + 1)) if (path !== "/dev/null") scopedPath(scope, path);
  const timeout = options.timeoutMs ?? 15_000, maximum = options.maxBufferBytes ?? 32 * 1024 * 1024;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 15_000 || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 64 * 1024 * 1024) throw new Error("dependency_host_git_budget_invalid");
  const submit = async (fixedArgs: readonly string[]): Promise<{ stdout: Buffer; stderr: Buffer }> => {
      const operation = withHostedActivationFence(fence => {
        const fresh = assertCurrentHostedDependencyRootPurpose(context, HostedDependencyRootPurpose.ManagedGitReadV1, fence);
        const objects = repositoryObjects(fresh), privatePaths = privateScratch?.pathsWithHeldFence(context, fence);
        const env = { ...cleanEnvironment(), TMPDIR: privatePaths?.temporaryDirectory ?? fresh.scratchParent.canonicalPath, ...(privatePaths ? { GIT_INDEX_FILE: privatePaths.indexPath,
          GIT_OBJECT_DIRECTORY: privatePaths.objectDirectory, GIT_ALTERNATE_OBJECT_DIRECTORIES: objects } : {}) };
        const result = execute(fresh.rootGit.executable.path,
          ["--git-dir=" + join(fresh.workspace.canonicalPath, ".git"), "--work-tree=" + fresh.workspace.canonicalPath,
            ...(fixedArgs[0] === "ls-tree" ? ["--literal-pathspecs"] : []),
            "--no-replace-objects", ...managedDependencyGitFlags, "-c", "core.quotepath=false", "-c", "core.fileMode=true", ...fixedArgs],
          { cwd: fresh.workspace.canonicalPath, env, encoding: "buffer", timeout, maxBuffer: maximum,
            ...(options.abortSignal === undefined ? {} : { signal: options.abortSignal }) });
        if (fixedArgs[0] === "apply") result.child.stdin?.end(options.input);
        privateScratch?.observeChild(context, result.child);
        let stderrBytes = 0, stderrLimit = false;
        result.child.stderr?.on("data", (chunk: Buffer) => {
          stderrBytes += chunk.length;
          if (stderrBytes > 64 * 1024 && !stderrLimit) { stderrLimit = true; result.child.kill(); }
        });
        return { result, exceededStderr: () => stderrLimit };
      });
      try {
        const result = await operation.result;
        if (operation.exceededStderr()) throw new Error("dependency_host_git_output_limit_exceeded");
        if (operation.result.child.exitCode === null || operation.result.child.signalCode !== null) {
          throw new Error("dependency_host_git_child_held");
        }
        return result;
      }
      catch (error) {
        if (operation.exceededStderr()) throw new Error("dependency_host_git_output_limit_exceeded");
        throw error;
      } finally {
        privateScratch?.settleChild(context, operation.result.child);
        assertManagedDependencyGitContext(context);
      }
  };
  // Only bounded Git index/tree names under genuine authored roots are read.
  // This is not a filesystem walk or a generated-tree content capture. Tracked
  // generated names are refused before status/diff/blob/private-index effects.
  if (kind !== ManagedDependencyGitOperation.RepositoryIdentity) {
    const roots = scope.authoredRoots.filter(root => within(scope.workspace.canonicalPath, root.canonicalPath))
      .map(root => root.canonicalPath === scope.workspace.canonicalPath ? "." : scopedPath(scope, root.canonicalPath));
    if (roots.length === 0 || roots.length > 512) throw new Error("dependency_host_git_output_scope_missing");
    const index = await submit(["ls-files", "--stage", "-z", "--", ...roots.map(path => `:(top,literal)${path}`)]);
    recordMembership(context, assertManagedDependencyGitContext(context), index.stdout, false);
    const reference = args[0] === "read-tree" ? args[1]! : args[0] === "ls-tree" ? args[args[1] === "-z" ? 2 : 1]! :
      args[0] === "diff" ? args.find(arg => arg === "HEAD" || objectId.test(arg)) ?? "HEAD" : "HEAD";
    const tree = await submit(["ls-tree", "-r", "-z", reference, "--", ...roots]);
    recordMembership(context, assertManagedDependencyGitContext(context), tree.stdout, true);
  }
  if (kind === ManagedDependencyGitOperation.AuthoredBlob && !membership.get(context)?.has(args[2]!)) throw new Error("dependency_host_git_blob_membership");
  let fixedArgs = [...args];
  if (kind === ManagedDependencyGitOperation.AuthoredNoIndexDiff) fixedArgs.splice(1, 0, "--no-ext-diff", "--no-textconv");
  if ([ManagedDependencyGitOperation.AuthoredStatus, ManagedDependencyGitOperation.AuthoredDiff,
      ManagedDependencyGitOperation.AuthoredIndexEntries, ManagedDependencyGitOperation.AuthoredTreeEntries].includes(kind)) {
    const split = fixedArgs.indexOf("--"), paths = split < 0 ? [] : fixedArgs.splice(split + 1);
    if (split < 0) fixedArgs.push("--");
    const includes = paths.length ? paths : scope.authoredRoots.filter(root => within(scope.workspace.canonicalPath, root.canonicalPath))
      .map(root => root.canonicalPath === scope.workspace.canonicalPath ? "." : root.canonicalPath.slice(scope.workspace.canonicalPath.length + 1));
    if (includes.length === 0 || includes.length > 512) throw new Error("dependency_host_git_output_scope_missing");
    if (kind === ManagedDependencyGitOperation.AuthoredTreeEntries) {
      fixedArgs.push(...includes);
    } else {
      fixedArgs.push(...includes.map(path => `:(top,literal)${path}`), ":(top,exclude,glob)**/node_modules/**",
        ":(top,exclude,glob)**/node_modules", ":(top,exclude,literal)node_modules");
      for (const root of scope.generatedRoots) if (within(scope.workspace.canonicalPath, root.canonicalPath)) fixedArgs.push(`:(top,exclude,literal)${root.canonicalPath.slice(scope.workspace.canonicalPath.length + 1)}`);
      for (const root of scope.sourceLookupAncestors) {
        const candidate = join(root.canonicalPath, "node_modules");
        if (within(scope.workspace.canonicalPath, candidate)) fixedArgs.push(`:(top,exclude,literal)${candidate.slice(scope.workspace.canonicalPath.length + 1)}`);
      }
    }
    if (kind === ManagedDependencyGitOperation.AuthoredDiff) fixedArgs.splice(1, 0, "--no-textconv");
  }
  const result = await submit(fixedArgs);
  if (kind === ManagedDependencyGitOperation.AuthoredTreeEntries && args.includes("-z")) recordMembership(context, assertManagedDependencyGitContext(context), result.stdout, true);
  if (kind === ManagedDependencyGitOperation.AuthoredIndexEntries && args.includes("--stage")) recordMembership(context, assertManagedDependencyGitContext(context), result.stdout, false);
  return result;
}

export async function runManagedDependencyGitWithEnvironment(context: HostedDependencyRootPurposeContext, args: readonly string[], env: NodeJS.ProcessEnv | undefined,
  maxBufferBytes: number, input?: Buffer): Promise<{ stdout: Buffer; stderr: Buffer }> {
  const indexSnapshot = env === undefined ? undefined : readManagedDependencyPrivateIndex(context, env);
  return runManagedDependencyGitBuffer(context, args, { maxBufferBytes,
    ...(indexSnapshot === undefined ? {} : { indexSnapshot }), ...(input === undefined ? {} : { input }) });
}

export async function readManagedDependencyGitBlobs(context: HostedDependencyRootPurposeContext, input: {
  readonly objectNames: readonly string[]; readonly maxBlobBytes: number; readonly maxTotalBytes: number;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<readonly Buffer[]> {
  if (input.objectNames.length > 1024 || input.objectNames.some(name => !objectId.test(name)) ||
      !Number.isSafeInteger(input.maxBlobBytes) || input.maxBlobBytes < 1 || input.maxBlobBytes > 64 * 1024 * 1024 ||
      !Number.isSafeInteger(input.maxTotalBytes) || input.maxTotalBytes < 0 || input.maxTotalBytes > 64 * 1024 * 1024) throw new Error("dependency_host_git_blob_limit_invalid");
  const result: Buffer[] = []; let total = 0;
  for (const name of input.objectNames) {
    let bytes: Buffer;
    try { bytes = (await runManagedDependencyGitWithEnvironment(context, ["cat-file", "blob", name], input.env,
      Math.min(input.maxBlobBytes + 1, 64 * 1024 * 1024))).stdout; }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw new Error("dependency_host_git_blob_limit_exceeded");
      throw error;
    }
    if (bytes.length > input.maxBlobBytes) throw new Error("dependency_host_git_blob_limit_exceeded");
    total += bytes.length;
    if (total > input.maxTotalBytes) throw new Error("dependency_host_git_total_limit_exceeded");
    result.push(bytes);
  }
  return result;
}
