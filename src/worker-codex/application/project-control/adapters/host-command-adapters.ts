import { execFile } from "node:child_process";
import { promisify } from "node:util";

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

/**
 * Runs the real `git` binary via `child_process.execFile`, forwarding only the
 * explicit options a caller set so unset fields keep Node's execFile defaults
 * (behavior-neutral with the previous inline calls).
 */
export class ExecFileProjectControlGitAdapter implements ProjectControlGitPort {
  async run(input: ProjectControlGitRunInput): Promise<HostCommandResult> {
    const { stdout, stderr } = await execFileAsync("git", [...input.args], {
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
    const { stdout, stderr } = await execFileAsync("git", [...input.args], {
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
