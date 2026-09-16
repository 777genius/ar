import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  isHandoffExecErrorWithStdout as isExecErrorWithStdout,
  isHandoffNodeError as isNodeError,
} from "./codex-goal-handoff-artifact-guards";
import { withLiteralGitPathspecs } from "./git-literal-pathspecs";

const execFileAsync = promisify(execFile);

export async function assertHandoffGitHeadUnchanged(
  workspacePath: string,
  expectedHead: string,
  gitBinaryPath?: string,
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
  gitBinaryPath?: string,
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
  gitBinaryPath?: string,
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
  gitBinaryPath?: string,
): Promise<string> {
  const { stdout } = await execFileAsync(
    gitBinaryPath ?? "git",
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
  gitBinaryPath?: string,
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
