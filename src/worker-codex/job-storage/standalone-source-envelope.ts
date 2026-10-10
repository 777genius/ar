import { execFile } from "node:child_process";
import { lstat, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

export enum StandaloneSourceEnvelopeStatus {
  CaptureRequired = "capture-required",
  Unsupported = "unsupported",
}
export enum StandaloneSourceEnvelopeReason {
  SharedGit = "shared-git",
  GitLock = "git-lock",
  Alternates = "alternates",
  Dependencies = "external-dependencies",
  UnclassifiedLink = "unclassified-link",
  Unavailable = "inventory-unavailable",
}
export type StandaloneSourceEnvelope =
  | { readonly status: StandaloneSourceEnvelopeStatus.Unsupported; readonly reason: StandaloneSourceEnvelopeReason }
  | { readonly status: StandaloneSourceEnvelopeStatus.CaptureRequired; readonly workspace: string;
      readonly gitDirectory: string; readonly uniqueIgnoredPaths: readonly string[] };
const execute = promisify(execFile);

/** Read-only feasibility inventory. Never a snapshot/restore/coverage receipt.
 * Caller must first quiesce source writers; later capture must revalidate this
 * entire envelope. Filenames are inventory; ignored files are never discarded. */
export async function inspectStandaloneSourceEnvelope(workspacePath: string): Promise<StandaloneSourceEnvelope> {
  const unsupported = (reason: StandaloneSourceEnvelopeReason): StandaloneSourceEnvelope => ({ status: StandaloneSourceEnvelopeStatus.Unsupported, reason });
  try {
    const workspace = await realpath(workspacePath), gitDirectory = join(workspace, ".git"), device = (await lstat(workspace)).dev;
    if (workspace !== resolve(workspacePath) || !(await lstat(gitDirectory)).isDirectory()) return unsupported(StandaloneSourceEnvelopeReason.SharedGit);
    if (["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_INDEX_FILE"]
      .some(key => process.env[key] !== undefined)) return unsupported(StandaloneSourceEnvelopeReason.SharedGit);
    const git = async (...args: string[]) => (await execute("git", ["--no-optional-locks", "--no-replace-objects",
      "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", workspace, ...args],
      { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 })).stdout;
    for (const flag of ["--absolute-git-dir", "--git-common-dir"]) {
      const actual = (await git("rev-parse", flag)).trim();
      if (await realpath(resolve(workspace, actual)) !== gitDirectory) return unsupported(StandaloneSourceEnvelopeReason.SharedGit);
    }
    if (await exists(join(gitDirectory, "objects", "info", "alternates")) ||
        await exists(join(gitDirectory, "objects", "info", "http-alternates"))) return unsupported(StandaloneSourceEnvelopeReason.Alternates);
    if (await exists(join(workspace, ".gitmodules")) || await exists(join(gitDirectory, "modules")) ||
        await exists(join(gitDirectory, "lfs"))) return unsupported(StandaloneSourceEnvelopeReason.Dependencies);
    const tracked = (await git("ls-files", "-z")).split("\0").filter(Boolean);
    if ((await git("ls-files", "--stage", "-z")).split("\0").some(entry => entry.startsWith("160000 "))) {
      return unsupported(StandaloneSourceEnvelopeReason.Dependencies);
    }
    if (tracked.length) {
      // Read attributes only; no checkout, filter execution, hooks or restored config effects.
      const attributes = (await execute("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null",
        "-C", workspace, "check-attr", "-z", "filter", "--", ...tracked],
        { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 })).stdout.split("\0");
      for (let index = 2; index < attributes.length; index += 3) {
        if (!["unspecified", "unset"].includes(attributes[index]!)) return unsupported(StandaloneSourceEnvelopeReason.Dependencies);
      }
    }
    let entries = 0;
    const scan = async (directory: string, inGit: boolean): Promise<StandaloneSourceEnvelopeReason | undefined> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (++entries > 100_000) return StandaloneSourceEnvelopeReason.Unavailable;
        const path = join(directory, entry.name), metadata = await lstat(path);
        if (!inGit && entry.name === ".git" && path !== gitDirectory) return StandaloneSourceEnvelopeReason.Dependencies;
        if (metadata.dev !== device) return StandaloneSourceEnvelopeReason.Dependencies;
        if (inGit && entry.name.endsWith(".lock")) return StandaloneSourceEnvelopeReason.GitLock;
        if (metadata.isSymbolicLink() || (!metadata.isDirectory() && (!metadata.isFile() || metadata.nlink !== 1))) {
          return StandaloneSourceEnvelopeReason.UnclassifiedLink;
        }
        if (metadata.isDirectory()) {
          const problem = await scan(path, inGit || path === gitDirectory);
          if (problem) return problem;
        }
      }
      return undefined;
    };
    const problem = await scan(workspace, false);
    if (problem) return unsupported(problem);
    const uniqueIgnoredPaths = (await git("ls-files", "--others", "--ignored", "--exclude-standard", "-z")).split("\0").filter(Boolean).sort();
    return { status: StandaloneSourceEnvelopeStatus.CaptureRequired, workspace, gitDirectory, uniqueIgnoredPaths };
  } catch { return unsupported(StandaloneSourceEnvelopeReason.Unavailable); }
}
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
