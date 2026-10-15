import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { CodexGoalWorkspaceStatus } from "../codex-goal-status-files";

const execute = promisify(execFile);
const invalid = (): never => { throw new Error("TEST_source_status_scope_invalid"); };

/** Source-only observation port. Physical TEST ownership permits this fixed
 * offline reader; it does not issue a hosted origin, purpose or Native grant. */
export async function sdkSourceWorkspaceStatusReader(jobRoot: string) {
  const root = await lstat(jobRoot, { bigint: true });
  if (!root.isDirectory() || root.isSymbolicLink() || (root.mode & 0o7777n) !== 0o700n ||
      await realpath(jobRoot) !== jobRoot) invalid();
  const selected = new Set([join(jobRoot, "source"), join(jobRoot, "workspace")]);
  const identities = new Map<string, { dev: bigint; ino: bigint; gitDev: bigint; gitIno: bigint }>();
  const validate = async (path: string): Promise<void> => {
    if (!selected.has(path)) invalid();
    const current = await lstat(jobRoot, { bigint: true }), directory = await lstat(path, { bigint: true });
    if (!current.isDirectory() || current.dev !== root.dev || current.ino !== root.ino ||
        current.uid !== root.uid || current.mode !== root.mode || await realpath(jobRoot) !== jobRoot ||
        !directory.isDirectory() || directory.isSymbolicLink() || directory.dev !== root.dev ||
        directory.uid !== root.uid || (directory.mode & 0o022n) || await realpath(path) !== path) invalid();
    const identity = identities.get(path);
    if (identity && (identity.dev !== directory.dev || identity.ino !== directory.ino)) invalid();
    const metadata = join(path, ".git"), git = await lstat(metadata, { bigint: true });
    if (!git.isDirectory() || git.isSymbolicLink() || git.uid !== root.uid || (git.mode & 0o022n) ||
        await realpath(metadata) !== metadata || identity && (identity.gitDev !== git.dev || identity.gitIno !== git.ino)) invalid();
    try { await lstat(join(metadata, "commondir")); invalid(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    identities.set(path, { dev: directory.dev, ino: directory.ino, gitDev: git.dev, gitIno: git.ino });
  };
  return async (path: string): Promise<CodexGoalWorkspaceStatus> => {
    await validate(path);
    const { stdout } = await execute("/usr/bin/git", ["--no-optional-locks", "-c", "core.fsmonitor=false",
      "-c", "core.hooksPath=/dev/null", "-c", "status.renames=false", `--git-dir=${join(path, ".git")}`, `--work-tree=${path}`,
      "status", "--porcelain=v1", "-z", "--untracked-files=all"], {
      encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024,
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1" },
    });
    await validate(path);
    if (stdout !== "" && !stdout.endsWith("\0")) invalid();
    const records = stdout === "" ? [] : stdout.slice(0, -1).split("\0");
    if (records.some(record => !/^(?:\?\?|!!|[ MADRCUT][ MADRCUT]) .+$/s.test(record))) invalid();
    const changedFiles = records.map(record => record.slice(3)).sort();
    return { exists: true, dirty: changedFiles.length !== 0, changedFiles };
  };
}
