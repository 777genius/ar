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

const execFileAsync = promisify(execFile);
const defaultGitCommandTimeoutMs = 10_000;

export class AtomicJsonRuntimeResultWriter implements RuntimeResultWriterPort {
  async writeResult(input: {
    readonly path: string;
    readonly result: RuntimeResultEnvelope;
  }): Promise<void> {
    await writeAtomicJson(input.path, input.result);
  }
}

export function createCodexGoalResultRecorder(input: {
  readonly outputPath: string;
  readonly clock?: { now(): Date };
}): StrictResultRecorder {
  return new StrictResultRecorder({
    outputPath: input.outputPath,
    writer: new AtomicJsonRuntimeResultWriter(),
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
  const trackedPatch = await gitDiff({
    retention: true,
    gitBinaryPath,
    workspacePath: input.workspacePath,
    args: hasHead
      ? ["diff", "--binary", "--no-renames", "HEAD", "--"]
      : ["diff", "--binary", "--"],
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
      args: ["diff", "--binary", "--no-index", "--", "/dev/null", path],
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

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

export async function writeAtomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tempPath = join(
    dirname(path),
    `.${Date.now()}-${process.pid}-${randomUUID()}-${basenameForTemp(path)}.tmp`,
  );
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
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
