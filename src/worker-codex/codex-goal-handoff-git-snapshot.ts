import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  isHandoffExecErrorWithStdout as isExecErrorWithStdout,
  isHandoffNodeError as isNodeError,
} from "./codex-goal-handoff-artifact-guards";
import { withLiteralGitPathspecs } from "./git-literal-pathspecs";
import { resolveManagedDependencyGitContext, runManagedDependencyGitWithEnvironment,
  type HandoffGitSelection } from "./managed-dependency-git";

const execFileAsync = promisify(execFile);

export async function assertHandoffGitHeadUnchanged(
  workspacePath: string,
  expectedHead: string,
  gitBinaryPath?: HandoffGitSelection,
): Promise<void> {
  const currentHead = await handoffGitText(
    workspacePath,
    ["rev-parse", "--verify", "HEAD"],
    undefined,
    gitBinaryPath,
  );
  if (currentHead !== expectedHead) {
    throw new Error("handoff_head_changed_during_materialization");
  }
}

export async function handoffGitNullPaths(
  cwd: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
  gitBinaryPath?: HandoffGitSelection,
): Promise<readonly string[]> {
  const output = await handoffGitOutput(
    cwd,
    args,
    2 * 1024 * 1024,
    env,
    gitBinaryPath,
  );
  return output.split("\0").filter(Boolean);
}

export async function handoffGitText(
  cwd: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
  gitBinaryPath?: HandoffGitSelection,
): Promise<string> {
  return (
    await handoffGitOutput(cwd, args, 1024 * 1024, env, gitBinaryPath)
  ).trim();
}

export async function handoffGitOutput(
  cwd: string,
  args: readonly string[],
  maxBuffer: number,
  env?: NodeJS.ProcessEnv,
  gitBinaryPath?: HandoffGitSelection,
): Promise<string> {
  const context = resolveManagedDependencyGitContext(cwd, gitBinaryPath);
  if (context !== undefined) {
    try { return (await runManagedDependencyGitWithEnvironment(context, args, env, maxBuffer)).stdout.toString("utf8"); }
    catch (error) {
      // Preserve Git's useful no-index diff result while keeping the original
      // byte-limit guard. Buffer outputs never escape as an error payload.
      if (error && typeof error === "object" && "code" in error && error.code === 1 &&
          "stdout" in error && Buffer.isBuffer(error.stdout) && args[0] === "diff" && args.includes("--no-index")) return error.stdout.toString("utf8");
      throw error;
    }
  }
  const { stdout } = await execFileAsync(
    typeof gitBinaryPath === "string" ? gitBinaryPath : "git",
    withLiteralGitPathspecs([
      "--no-replace-objects",
      "-c",
      "core.quotepath=false",
      "-c",
      "core.fileMode=true",
      ...args,
    ]),
    {
      cwd,
      encoding: "utf8",
      ...(env ? { env } : {}),
      maxBuffer,
      timeout: 15_000,
    },
  );
  return stdout;
}

export async function handoffGitDiffNoIndex(
  cwd: string,
  path: string,
  maxBuffer: number,
  gitBinaryPath?: HandoffGitSelection,
): Promise<string> {
  try {
    return await handoffGitOutput(
      cwd,
      ["diff", "--binary", "--no-index", "--", "/dev/null", path],
      maxBuffer,
      undefined,
      gitBinaryPath,
    );
  } catch (error) {
    if (isExecErrorWithStdout(error) && error.code === 1) return error.stdout;
    if (isNodeError(error, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")) {
      throw new Error("handoff_patch_byte_limit_exceeded");
    }
    throw error;
  }
}
