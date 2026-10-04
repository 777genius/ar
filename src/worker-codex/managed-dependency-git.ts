import { isHostedDependencyWorkspace } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SafeExecutionCommandRunner } from "@vioxen/subscription-runtime/worker-core";
const execute = promisify(execFile);

export function managedDependencyGitEnvironment(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !name.startsWith("GIT_") && !name.startsWith("LD_") && name !== "DYLD_INSERT_LIBRARIES"));
  return { ...env, PATH: "/usr/bin:/bin", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
}
export const managedDependencyGitFlags: readonly string[] = Object.freeze([
  "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "diff.external=",
]);
/** Only fixed Git hygiene executes on the privileged side. Other commands and
 * project code belong to the contained provider/tool unit, never this adapter.
 */
export class ManagedDependencyGitRunner implements SafeExecutionCommandRunner {
  async run(input: Parameters<SafeExecutionCommandRunner["run"]>[0]) {
    if (!isHostedDependencyWorkspace(input.cwd) || input.command !== "/usr/bin/git") throw new Error("dependency_host_git_unsupported");
    const result = await execute("/usr/bin/git", [...managedDependencyGitFlags, ...input.args], {
      cwd: input.cwd, env: managedDependencyGitEnvironment(),
      ...(input.timeoutMs === undefined ? {} : { timeout: input.timeoutMs }),
      ...(input.maxBufferBytes === undefined ? {} : { maxBuffer: input.maxBufferBytes }),
      ...(input.abortSignal === undefined ? {} : { signal: input.abortSignal }),
    });
    return { stdout: String(result.stdout), stderr: String(result.stderr) };
  }
}
