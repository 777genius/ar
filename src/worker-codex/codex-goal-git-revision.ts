import { resolveManagedDependencyGitContext, runManagedDependencyGitBuffer,
  type HostedDependencyRootPurposeContext } from "./managed-dependency-git";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  RevisionReaderPort,
  RevisionReadResult,
} from "@vioxen/subscription-runtime/worker-core";

const execFileAsync = promisify(execFile);
const gitRevisionTimeoutMs = 5_000;

export class LocalGitRevisionReader implements RevisionReaderPort {
  constructor(private readonly options: {
    readonly gitBinaryPath?: string;
    readonly timeoutMs?: number;
  } = {}) {}

  async readHeadCommit(input: {
    readonly workspacePath: string;
    readonly managedContext?: HostedDependencyRootPurposeContext;
  }): Promise<RevisionReadResult> {
    const context = resolveManagedDependencyGitContext(input.workspacePath, input.managedContext);
    if (context !== undefined) {
      const { stdout } = await runManagedDependencyGitBuffer(context, ["rev-parse", "--verify", "HEAD"],
        { timeoutMs: this.options.timeoutMs ?? gitRevisionTimeoutMs, maxBufferBytes: 1024 * 1024 });
      const commit = stdout.toString("utf8").trim();
      return commit ? { commit } : { reason: "head_commit_empty" };
    }
    try {
      const { stdout } = await execFileAsync(
        this.options.gitBinaryPath ?? "git",
        ["-C", input.workspacePath, "rev-parse", "--verify", "HEAD"],
        { timeout: this.options.timeoutMs ?? gitRevisionTimeoutMs },
      );
      const commit = stdout.trim();
      return commit ? { commit } : { reason: "head_commit_empty" };
    } catch {
      return { reason: "head_commit_unavailable" };
    }
  }
}

export async function readLocalGitHeadCommit(
  workspacePath: string,
  managedContext?: HostedDependencyRootPurposeContext,
): Promise<string | undefined> {
  return (await new LocalGitRevisionReader().readHeadCommit({ workspacePath, ...(managedContext === undefined ? {} : { managedContext }) })).commit;
}
