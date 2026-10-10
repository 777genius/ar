import { assertHostedOrdinaryEffectPaths } from "../provider-codex/app-server/adapters/hosted-ordinary-writer-extent";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  StrictResultRecorder,
  MAX_RETAINED_TERMINAL_ARCHIVE_PATCH_BYTES,
  assertRetainedTerminalArchivePatchSize,
  type RuntimePatchPreserverPort,
  type RuntimeResultArtifact,
  type RuntimeResultEnvelope,
  type RuntimeResultWriterPort,
} from "@vioxen/subscription-runtime/worker-core";
import { LocalTerminalCheckpointAdmission } from "@vioxen/subscription-runtime/store-local-file";

const execFileAsync = promisify(execFile);
const defaultGitCommandTimeoutMs = 10_000;

export class AtomicJsonRuntimeResultWriter implements RuntimeResultWriterPort {
  constructor(private readonly terminalCheckpointJobRootDir?: string) {}

  async writeResult(input: {
    readonly path: string;
    readonly result: RuntimeResultEnvelope;
  }): Promise<void> {
    assertHostedOrdinaryEffectPaths([input.path]);
    if (this.terminalCheckpointJobRootDir) {
      await new LocalTerminalCheckpointAdmission(this.terminalCheckpointJobRootDir).withWriter(
        () => writeAtomicJson(input.path, input.result),
      );
    } else {
      await writeAtomicJson(input.path, input.result);
    }
  }
}

export function createCodexGoalResultRecorder(input: {
  readonly outputPath: string;
  readonly clock?: { now(): Date };
  readonly terminalCheckpointJobRootDir?: string;
}): StrictResultRecorder {
  return new StrictResultRecorder({
    outputPath: input.outputPath,
    writer: new AtomicJsonRuntimeResultWriter(input.terminalCheckpointJobRootDir),
    ...(input.clock === undefined ? {} : { clock: input.clock }),
  });
}

export class GitPatchPreserver implements RuntimePatchPreserverPort {
  constructor(private readonly options: {
    readonly gitBinaryPath?: string;
  } = {}) {}

  async preserve(input: {
    readonly workspacePath: string;
    readonly outputPath: string;
  }): Promise<RuntimeResultArtifact | null> {
    const patch = await captureGitWorkspacePatch({
      workspacePath: input.workspacePath,
      ...(this.options.gitBinaryPath
        ? { gitBinaryPath: this.options.gitBinaryPath }
        : {}),
    });
    if (!patch.trim()) return null;
    await mkdir(dirname(input.outputPath), { recursive: true, mode: 0o700 });
    await writeFile(input.outputPath, patch, {
      encoding: "utf8",
      mode: 0o600,
    });
    const item = await stat(input.outputPath);
    return {
      kind: "patch",
      path: input.outputPath,
      byteLength: item.size,
    };
  }
}

export async function captureGitWorkspacePatch(input: {
  readonly workspacePath: string;
  readonly gitBinaryPath?: string;
}): Promise<string> {
  const gitBinaryPath = input.gitBinaryPath ?? "git";
  const hasHead = await gitHasHead({
    gitBinaryPath,
    workspacePath: input.workspacePath,
  });
  // Disable presentation drivers. Git clean conversions can still normalize
  // bytes; callers claiming raw identity must separately check eligibility.
  const trackedPatch = await gitDiff({
    retention: true,
    gitBinaryPath,
    workspacePath: input.workspacePath,
    args: hasHead
      ? ["diff", "--binary", "--no-ext-diff", "--no-textconv", "--no-renames", "HEAD", "--"]
      : ["diff", "--binary", "--no-ext-diff", "--no-textconv", "--"],
  });
  const patches: string[] = [];
  let bytes = 0;
  const append = (patch: string) => {
    if (!patch) return;
    const size = Buffer.byteLength(patch, "utf8") + (patch.endsWith("\n") ? 0 : 1);
    assertRetainedTerminalArchivePatchSize(bytes + size);
    bytes += size;
    patches.push(ensureTrailingNewline(patch));
  };
  append(trackedPatch);
  for (const path of await gitUntrackedPaths({ gitBinaryPath, workspacePath: input.workspacePath })) {
    append(await gitDiff({
      retention: true,
      gitBinaryPath, workspacePath: input.workspacePath,
      args: ["diff", "--binary", "--no-ext-diff", "--no-textconv", "--no-index", "--", "/dev/null", path],
      allowDifferenceExitCode: true,
    }));
  }
  return patches.join("");
}

export async function captureGitWorkspaceChangedFiles(input: {
  readonly workspacePath: string;
  readonly gitBinaryPath?: string;
}): Promise<readonly string[]> {
  const gitBinaryPath = input.gitBinaryPath ?? "git";
  const hasHead = await gitHasHead({
    gitBinaryPath,
    workspacePath: input.workspacePath,
  });
  const tracked = await gitDiff({
    gitBinaryPath,
    workspacePath: input.workspacePath,
    args: hasHead
      ? ["diff", "--name-only", "--no-renames", "-z", "HEAD", "--"]
      : ["diff", "--name-only", "-z", "--"],
  });
  const untracked = await gitUntrackedPaths({
    gitBinaryPath,
    workspacePath: input.workspacePath,
  });
  return [...new Set([
    ...tracked.split("\0").filter(Boolean),
    ...untracked,
  ])].sort();
}

/** Fail closed before using a Git patch as proof of unchanged authored bytes.
 * Attribute/config inspection does not invoke clean or process filters.
 */
export async function assertGitWorkspaceRawPatchIdentitySupported(
  workspacePath: string,
): Promise<void> {
  const options = { timeout: defaultGitCommandTimeoutMs, maxBuffer: 16 * 1024 * 1024 };
  // assume-unchanged and skip-worktree can hide raw source edits from both
  // status and diff, including the clean failed_no_output closure path.
  const { stdout: flags } = await execFileAsync("git", ["-C", workspacePath,
    "ls-files", "-v", "-z"], options);
  if (flags && !flags.endsWith("\0")) {
    throw new Error("failed_no_output_git_index_uncertain");
  }
  for (const entry of flags ? flags.slice(0, -1).split("\0") : []) {
    if (entry.length < 3 || entry[1] !== " ") {
      throw new Error("failed_no_output_git_index_uncertain");
    }
    if (entry[0] !== "H") throw new Error("failed_no_output_git_index_flags_present");
  }
  let autocrlf: string;
  try {
    ({ stdout: autocrlf } = await execFileAsync("git", ["-C", workspacePath,
      "config", "--get", "core.autocrlf"], options));
  } catch (error) {
    if (!isRecord(error) || error.code !== 1) throw error;
    autocrlf = "false";
  }
  if (!/^(false|no|off|0)$/i.test(autocrlf.trim())) {
    throw new Error("failed_no_output_git_conversion_unsupported");
  }
  // check-attr prints the same sentinel for -filter and filter=unset (and
  // for an absent filter and filter=unspecified). Deny configured drivers
  // with those names rather than interpreting ambiguous output as safe.
  try {
    await execFileAsync("git", ["-C", workspacePath, "config", "--name-only",
      "--get-regexp", "^filter\\.(unset|unspecified)\\.(clean|process)$"], options);
  } catch (error) {
    if (!isRecord(error) || error.code !== 1) throw error;
    // No ambiguous driver configuration.
    return await assertNoGitPathConversions(workspacePath, options);
  }
  throw new Error("failed_no_output_git_conversion_unsupported");
}

async function assertNoGitPathConversions(
  workspacePath: string,
  options: { readonly timeout: number; readonly maxBuffer: number },
): Promise<void> {
  const { stdout: paths } = await execFileAsync("git", ["-C", workspacePath,
    "ls-files", "--cached", "--others", "--exclude-standard", "-z"], options);
  if (!paths) return;
  const attributes = ["filter", "text", "eol", "working-tree-encoding", "ident", "crlf"];
  const output = await new Promise<string>((resolve, reject) => {
    const child = execFile("git", ["-C", workspacePath, "check-attr", "-z",
      "--stdin", ...attributes], options, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
    child.stdin!.on("error", reject);
    child.stdin!.end(paths);
  });
  const fields = output.split("\0");
  if (fields.pop() !== "" || fields.length % 3 !== 0 ||
      fields.length !== paths.split("\0").slice(0, -1).length * attributes.length * 3) {
    throw new Error("failed_no_output_git_conversion_uncertain");
  }
  for (let i = 0; i < fields.length; i += 3) {
    if (!fields[i] || !attributes.includes(fields[i + 1]!) ||
        !["unspecified", "unset"].includes(fields[i + 2]!)) {
      throw new Error("failed_no_output_git_conversion_unsupported");
    }
  }
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

export async function writeAtomicJson(path: string, value: unknown): Promise<void> {
  assertHostedOrdinaryEffectPaths([path]);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tempPath = join(
    dirname(path),
    `.${Date.now()}-${process.pid}-${randomUUID()}-${basenameForTemp(path)}.tmp`,
  );
  assertHostedOrdinaryEffectPaths([tempPath, path]);
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  assertHostedOrdinaryEffectPaths([tempPath, path]);
  await rename(tempPath, path);
}

async function gitHasHead(input: {
  readonly gitBinaryPath: string;
  readonly workspacePath: string;
}): Promise<boolean> {
  try {
    await execFileAsync(input.gitBinaryPath, [
      "-C",
      input.workspacePath,
      "rev-parse",
      "--verify",
      "HEAD",
    ], { timeout: defaultGitCommandTimeoutMs });
    return true;
  } catch {
    return false;
  }
}

async function gitDiff(input: {
  readonly gitBinaryPath: string;
  readonly workspacePath: string;
  readonly args: readonly string[];
  readonly allowDifferenceExitCode?: boolean;
  readonly retention?: boolean;
}): Promise<string> {
  try {
    const { stdout } = await execFileAsync(input.gitBinaryPath, [
      "-C",
      input.workspacePath,
      ...input.args,
    ], {
      maxBuffer: input.retention ? MAX_RETAINED_TERMINAL_ARCHIVE_PATCH_BYTES : 16 * 1024 * 1024,
      timeout: defaultGitCommandTimeoutMs,
    });
    return stdout;
  } catch (error) {
    if (input.retention && isRecord(error) &&
        error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" &&
        typeof error.message === "string" && error.message.includes("stdout")) {
      assertRetainedTerminalArchivePatchSize(MAX_RETAINED_TERMINAL_ARCHIVE_PATCH_BYTES + 1);
    }
    if (
      input.allowDifferenceExitCode === true &&
      isExecDifferenceWithStdout(error)
    ) {
      return error.stdout;
    }
    throw error;
  }
}

async function gitUntrackedPaths(input: {
  readonly gitBinaryPath: string;
  readonly workspacePath: string;
}): Promise<readonly string[]> {
  const { stdout } = await execFileAsync(input.gitBinaryPath, [
    "-C",
    input.workspacePath,
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ], {
    maxBuffer: 16 * 1024 * 1024,
    timeout: defaultGitCommandTimeoutMs,
  });
  return stdout.split("\0").filter(Boolean);
}

function basenameForTemp(path: string): string {
  return path.split(/[\\/]/).at(-1)?.replace(/[^A-Za-z0-9_.-]/g, "_") ||
    "runtime-result";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExecDifferenceWithStdout(
  error: unknown,
): error is { readonly code: 1; readonly stdout: string } {
  return isRecord(error) &&
    error.code === 1 &&
    typeof error.stdout === "string";
}
