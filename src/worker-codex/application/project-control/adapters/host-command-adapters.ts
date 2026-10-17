import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  originalHostedProjectControlAllocationPathPresent,
  originalHostedProjectControlAllocationPublication,
  originalHostedProjectControlGitRoleForPath,
  runOriginalHostedProjectControlGit,
} from "../../../hosted-project-control-native-allocation";
import { OriginalControlGitOperation, OriginalControlGitRole, originalControlGitBranch, originalControlGitMaximumMilliseconds, originalControlGitOutputMaxBytes } from "../../../hosted-project-control-git-recipe";

import type {
  HostCommandBufferResult,
  HostCommandResult,
  HostDiskUsagePort,
  ProjectControlGitPort,
  ProjectControlGitRunInput,
  ProjectControlValidatorRunInput,
  ProjectControlValidatorRunnerPort,
} from "../ports/host-command-port";

export type {
  HostCommandBufferResult,
  HostCommandResult,
  HostDiskUsagePort,
  ProjectControlGitPort,
  ProjectControlGitRunInput,
  ProjectControlValidatorRunInput,
  ProjectControlValidatorRunnerPort,
} from "../ports/host-command-port";

const execFileAsync = promisify(execFile);

const DISK_USAGE_TIMEOUT_MS = 8_000;
const DISK_USAGE_MAX_BUFFER = 256 * 1024;

// Public readers may issue independent queries concurrently. Serialize only
// this original allocation's finite effects; each turn rechecks live custody.
let originalGitTail: Promise<unknown> = Promise.resolve();
function originalGitSelected(input: ProjectControlGitRunInput): boolean {
  return (input.cwd !== undefined && originalHostedProjectControlAllocationPathPresent(input.cwd)) ||
    input.args.some(arg => originalHostedProjectControlAllocationPathPresent(arg) ||
      (arg.includes("=") && originalHostedProjectControlAllocationPathPresent(arg.slice(arg.indexOf("=") + 1))));
}
async function runOriginalGit(input: ProjectControlGitRunInput, binary: string): Promise<HostCommandResult> {
  const execute = async (): Promise<HostCommandResult> => {
    if ((input.timeoutMs !== undefined && (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < originalControlGitMaximumMilliseconds)) ||
        (input.maxBuffer !== undefined && (!Number.isSafeInteger(input.maxBuffer) || input.maxBuffer < originalControlGitOutputMaxBytes)))
      throw new Error("project_control_original_git_limits_held");
    const selected = originalHostedProjectControlAllocationPublication().selectors;
    const args = [...input.args];
    const at = args.indexOf("-C"), prefix = args.slice(0, at);
    const prefixes: readonly (readonly string[])[] = [[], ["--literal-pathspecs"], ["-c", "core.hooksPath=/dev/null"],
      ["--literal-pathspecs", "-c", "core.hooksPath=/dev/null"], ["--no-optional-locks"],
      ["--no-optional-locks", "-c", "core.fsmonitor=false", "--literal-pathspecs"]];
    if ((binary !== "git" && binary !== "/usr/bin/git") || input.env !== undefined || at < 0 ||
        !prefixes.some(row => row.length === prefix.length && row.every((value, index) => value === prefix[index])) ||
        (input.cwd !== undefined && input.cwd !== args[at + 1])) throw new Error("project_control_original_git_options_held");
    const path = args[at + 1], command = args.slice(at + 2);
    // Admission's read-only port uses rev-parse without --verify. Normalize
    // only the same finite HEAD/full-object queries, never arbitrary refs.
    if (command.length === 2 && command[0] === "rev-parse" &&
        (command[1] === "HEAD" || /^[a-f0-9]{40}\^\{(?:commit|tree)\}$/.test(command[1]!))) command.splice(1, 0, "--verify");
    if (path !== selected.source && path !== selected.workspace) throw new Error("project_control_original_git_path_held");
    const role = originalHostedProjectControlGitRoleForPath(path);
    const same = (expected: readonly string[]) => command.length === expected.length && command.every((value, index) => value === expected[index]);
    let operation: OriginalControlGitOperation | undefined;
    let revision: string | null = null;
    if (same(["rev-parse", "--verify", "HEAD"])) operation = OriginalControlGitOperation.Head;
    else if (same(["rev-parse", "--verify", "HEAD^{commit}"])) operation = OriginalControlGitOperation.Commit;
    else if (same(["rev-parse", "--verify", "HEAD^{tree}"])) operation = OriginalControlGitOperation.Tree;
    else if (command.length === 3 && command[0] === "rev-parse" && command[1] === "--verify" && /^[a-f0-9]{40}\^\{(?:commit|tree)\}$/.test(command[2]!)) {
      revision = command[2]!.slice(0, 40);
      operation = command[2]!.endsWith("{commit}") ? OriginalControlGitOperation.Commit : OriginalControlGitOperation.Tree;
    } else if (same(["symbolic-ref", "--short", "HEAD"]) || same(["rev-parse", "--abbrev-ref", "HEAD"])) operation = OriginalControlGitOperation.Branch;
    else if (same(["status", "--porcelain", "--untracked-files=all"])) operation = OriginalControlGitOperation.Status;
    else if (same(["status", "--porcelain"])) operation = OriginalControlGitOperation.StatusDefault;
    else if (same(["rev-parse", "--show-toplevel"])) operation = OriginalControlGitOperation.TopLevel;
    else if (same(["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"])) operation = OriginalControlGitOperation.Metadata;
    else if (same(["remote"])) operation = OriginalControlGitOperation.Remote;
    else if (same(["config", "--get-regexp", "^filter\\..*\\.(clean|process)$"])) operation = OriginalControlGitOperation.Filters;
    else if (role === OriginalControlGitRole.Source && same(["worktree", "list", "--porcelain"])) operation = OriginalControlGitOperation.Worktrees;
    else if (role === OriginalControlGitRole.Source && same(["for-each-ref", "--format=%(refname)", "refs/heads/" + originalControlGitBranch])) operation = OriginalControlGitOperation.FindBranch;
    else if (role === OriginalControlGitRole.Source && command.length === 4 && command[0] === "update-ref" && command[1] === "refs/heads/" + originalControlGitBranch && /^[a-f0-9]{40}$/.test(command[2]!) && command[3] === "0".repeat(40)) {
      operation = OriginalControlGitOperation.PublishBranch; revision = command[2]!;
    }
    if (operation === undefined) throw new Error("project_control_original_git_tuple_held");
    const result = await runOriginalHostedProjectControlGit(role, operation, revision);
    if (result.code !== 0 || result.signal !== "") {
      const error = new Error("project_control_original_git_exit");
      Object.assign(error, { code: result.code, signal: result.signal, stderr: "" }); throw error;
    }
    return { stdout: result.stdout, stderr: "" };
  };
  const result = originalGitTail.then(execute, execute);
  originalGitTail = result.then(() => undefined, () => undefined);
  return result;
}

/**
 * Runs the real `git` binary via `child_process.execFile`, forwarding only the
 * explicit options a caller set so unset fields keep Node's execFile defaults
 * (behavior-neutral with the previous inline calls).
 */
export class ExecFileProjectControlGitAdapter implements ProjectControlGitPort {
  constructor(private readonly binaryPath = "git") {}
  async run(input: ProjectControlGitRunInput): Promise<HostCommandResult> {
    if (originalGitSelected(input)) return runOriginalGit(input, this.binaryPath);
    const { stdout, stderr } = await execFileAsync(this.binaryPath, [...input.args], {
      encoding: "utf8",
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(input.timeoutMs === undefined ? {} : { timeout: input.timeoutMs }),
      ...(input.maxBuffer === undefined ? {} : { maxBuffer: input.maxBuffer }),
      ...(input.env === undefined ? {} : { env: input.env }),
    });
    return { stdout, stderr };
  }

  async runBuffered(
    input: ProjectControlGitRunInput,
  ): Promise<HostCommandBufferResult> {
    // The original finite recipe exposes text queries only; binary patch
    // operations remain unsupported rather than silently using ambient Git.
    if (originalGitSelected(input)) throw new Error("project_control_original_git_buffered_held");
    const { stdout, stderr } = await execFileAsync(this.binaryPath, [...input.args], {
      encoding: "buffer",
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(input.timeoutMs === undefined ? {} : { timeout: input.timeoutMs }),
      ...(input.maxBuffer === undefined ? {} : { maxBuffer: input.maxBuffer }),
      ...(input.env === undefined ? {} : { env: input.env }),
    });
    return { stdout, stderr };
  }
}

/**
 * Runs a project-owned validator script under the current Node runtime
 * (`process.execPath`), mirroring the previous inline `execFile` call.
 */
export class NodeProjectControlValidatorRunnerAdapter
  implements ProjectControlValidatorRunnerPort
{
  async run(input: ProjectControlValidatorRunInput): Promise<HostCommandResult> {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [input.validatorPath, ...input.args],
      {
        cwd: input.cwd,
        encoding: "utf8",
        ...(input.timeoutMs === undefined ? {} : { timeout: input.timeoutMs }),
        ...(input.maxBuffer === undefined
          ? {}
          : { maxBuffer: input.maxBuffer }),
      },
    );
    return { stdout, stderr };
  }
}

/**
 * Reads available disk space with `df -Pk`, parsing the fourth column of the
 * data row (1024-byte blocks) into bytes. Returns `undefined` when the output
 * cannot be parsed; rejects when the probe itself fails.
 */
export class DfHostDiskUsageAdapter implements HostDiskUsagePort {
  async availableBytes(input: {
    readonly path: string;
  }): Promise<number | undefined> {
    const { stdout } = await execFileAsync("df", ["-Pk", input.path], {
      timeout: DISK_USAGE_TIMEOUT_MS,
      maxBuffer: DISK_USAGE_MAX_BUFFER,
    });
    const [, line] = stdout.trim().split(/\n/);
    const availableKb = Number(line?.trim().split(/\s+/)[3]);
    if (!Number.isFinite(availableKb)) return undefined;
    return availableKb * 1024;
  }
}

export const defaultProjectControlGitPort: ProjectControlGitPort =
  new ExecFileProjectControlGitAdapter();

export const defaultProjectControlValidatorRunnerPort: ProjectControlValidatorRunnerPort =
  new NodeProjectControlValidatorRunnerAdapter();

export const defaultHostDiskUsagePort: HostDiskUsagePort =
  new DfHostDiskUsageAdapter();
