/**
 * Narrow host-access ports for project-control use cases.
 *
 * The application layer must not spawn raw host processes directly. It asks
 * these ports to run a fixed binary (git, the project validator, the disk
 * usage probe) with an explicit argument vector and never shell-interpolated
 * input. Adapters own the actual `child_process` call; use cases stay testable
 * and provider-neutral so admission/reservation can later run under a
 * non-Codex provider without touching host wiring.
 */

export type HostCommandResult = {
  readonly stdout: string;
  readonly stderr: string;
};

export type HostCommandBufferResult = {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
};

export type ProjectControlGitRunInput = {
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly maxBuffer?: number;
  readonly env?: NodeJS.ProcessEnv;
};

export interface ProjectControlGitPort {
  /**
   * Runs `git` with the given argument vector and returns decoded text
   * streams. Rejects when git exits non-zero, preserving the underlying
   * error's `code`/`stderr`/`message` fields so callers can keep inspecting
   * them (for example the exit-code-1 "not an ancestor" contract).
   */
  run(input: ProjectControlGitRunInput): Promise<HostCommandResult>;

  /**
   * Same as {@link run} but returns raw byte streams, for digesting binary
   * patch output where utf8 decoding would corrupt the bytes.
   */
  runBuffered(
    input: ProjectControlGitRunInput,
  ): Promise<HostCommandBufferResult>;
}

export type ProjectControlValidatorRunInput = {
  readonly validatorPath: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly maxBuffer?: number;
};

export interface ProjectControlValidatorRunnerPort {
  /**
   * Runs a project-owned validator script under the current Node runtime.
   * Rejects (propagating the underlying error) when the validator exits
   * non-zero or exceeds its limits.
   */
  run(input: ProjectControlValidatorRunInput): Promise<HostCommandResult>;
}

export interface HostDiskUsagePort {
  /**
   * Reports the bytes available under `path`, or `undefined` when the probe
   * output cannot be parsed. Rejects (propagating the underlying error) when
   * the probe itself fails, so callers can build their own unreadable-root
   * evidence.
   */
  availableBytes(input: { readonly path: string }): Promise<number | undefined>;
}
