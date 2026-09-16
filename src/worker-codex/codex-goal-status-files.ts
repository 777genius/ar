import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, open, readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { DefaultRedactor } from "@vioxen/subscription-runtime/core";

const execFileAsync = promisify(execFile);
const gitStatusTimeoutMs = 5_000;

// Runtime events are single-line JSON records. This is deliberately larger than
// the human log-tail budget while still bounding every status/brief inspection.
export const CODEX_GOAL_RUNTIME_EVENT_MAX_READ_BYTES = 256 * 1024;

export async function readCodexGoalResultSummary(path: string): Promise<{
  readonly status?: string;
  readonly reason?: string;
}> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(parsed)) return {};
    return {
      ...(typeof parsed.status === "string" ? { status: parsed.status } : {}),
      ...(typeof parsed.reason === "string"
        ? { reason: redactStatusText(parsed.reason) }
        : {}),
    };
  } catch {
    return {};
  }
}

export async function readCodexGoalProgressSummary(path: string): Promise<{
  readonly exists?: boolean;
  readonly status?: string;
  readonly updatedAt?: string;
  readonly heartbeatAgeMs?: number;
  readonly pid?: number;
  readonly resultStatus?: string;
  readonly reason?: string;
  readonly attemptCount?: number;
  readonly currentAccount?: string;
  readonly warning?: string;
}> {
  try {
    const [item, parsed] = await Promise.all([
      stat(path),
      readCodexGoalProgressFile(path),
    ]);
    const updatedAt = parsed.updatedAt ?? item.mtime.toISOString();
    const updatedAtMs = Date.parse(updatedAt);
    return {
      exists: item.isFile(),
      ...(parsed.status ? { status: parsed.status } : {}),
      updatedAt,
      ...(Number.isFinite(updatedAtMs)
        ? { heartbeatAgeMs: Date.now() - updatedAtMs }
        : {}),
      ...(typeof parsed.pid === "number" ? { pid: parsed.pid } : {}),
      ...(parsed.resultStatus ? { resultStatus: parsed.resultStatus } : {}),
      ...(parsed.reason ? { reason: redactStatusText(parsed.reason) } : {}),
      ...(typeof parsed.attemptCount === "number"
        ? { attemptCount: parsed.attemptCount }
        : {}),
      ...(parsed.currentAccount ? { currentAccount: parsed.currentAccount } : {}),
    };
  } catch (error) {
    const safeMessage = error instanceof Error ? error.message : "progress_unreadable";
    return safeMessage.includes("ENOENT")
      ? { exists: false }
      : { exists: false, warning: "progress file is unreadable: " + safeMessage };
  }
}

export async function readLastCodexGoalRuntimeEvent(path: string): Promise<{
  readonly event?: string;
  readonly timestamp?: string;
  readonly level?: string;
  readonly warning?: string;
}> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    const { size } = await handle.stat();
    if (size === 0) return {};

    // The stat size fixes the snapshot boundary: concurrent appends are left for
    // the next observation rather than being mixed into this record.
    const readLength = Math.min(size, CODEX_GOAL_RUNTIME_EVENT_MAX_READ_BYTES);
    const start = size - readLength;
    const buffer = Buffer.allocUnsafe(readLength);
    let bytesRead = 0;
    while (bytesRead < readLength) {
      const read = await handle.read(
        buffer,
        bytesRead,
        readLength - bytesRead,
        start + bytesRead,
      );
      if (read.bytesRead === 0) break;
      bytesRead += read.bytesRead;
    }

    const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
    let lineIndex = lines.length - 1;
    while (lineIndex >= 0 && !(lines[lineIndex] ?? "").trim()) lineIndex -= 1;
    if (lineIndex < 0) {
      return start === 0
        ? {}
        : { warning: boundedRuntimeEventWarning("last non-empty record was not found") };
    }
    if (start > 0 && lineIndex === 0) {
      return {
        warning: boundedRuntimeEventWarning(
          "last record begins outside the inspection window",
        ),
      };
    }

    const line = lines[lineIndex] ?? "";
    const parsed: unknown = JSON.parse(line);
    if (!isRecord(parsed)) return {};
    return {
      ...(typeof parsed.event === "string"
        ? { event: redactStatusText(parsed.event) }
        : {}),
      ...(typeof parsed.timestamp === "string" ? { timestamp: parsed.timestamp } : {}),
      ...(typeof parsed.level === "string" ? { level: redactStatusText(parsed.level) } : {}),
    };
  } catch (error) {
    return isMissingFileError(error)
      ? {}
      : { warning: "runtime event file is unreadable or its last record is malformed" };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function boundedRuntimeEventWarning(reason: string): string {
  return `runtime event ${reason}; inspected only the bounded ${CODEX_GOAL_RUNTIME_EVENT_MAX_READ_BYTES}-byte suffix`;
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    error.code === "ENOENT";
}

export type CodexGoalWorkspaceStatus = {
  readonly exists?: boolean;
  readonly dirty?: boolean;
  readonly changedFiles?: readonly string[];
  readonly warning?: string;
};

export async function gitWorkspaceStatus(
  path: string,
): Promise<CodexGoalWorkspaceStatus> {
  try {
    const { stdout } = await execFileAsync("git", [
      "-C",
      path,
      "status",
      "--porcelain",
      "--untracked-files=all",
    ], { timeout: gitStatusTimeoutMs });
    const changedFiles = stdout
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => statusPorcelainPath(line))
      .filter((path) => path.length > 0)
      .sort((left, right) => left.localeCompare(right));
    return {
      exists: true,
      dirty: changedFiles.length > 0,
      changedFiles,
    };
  } catch {
    let exists = false;
    try {
      await access(path, constants.F_OK);
      exists = true;
    } catch {
      exists = false;
    }
    return {
      exists,
      dirty: false,
      changedFiles: [],
      warning: exists
        ? path + " is not a readable git worktree"
        : path + " workspace_missing",
    };
  }
}

export async function logFileStatus(path: string): Promise<{
  readonly exists?: boolean;
  readonly updatedAt?: string;
  readonly byteLength?: number;
}> {
  try {
    const item = await stat(path);
    return {
      exists: item.isFile(),
      ...(item.isFile() ? { updatedAt: item.mtime.toISOString() } : {}),
      ...(item.isFile() ? { byteLength: item.size } : {}),
    };
  } catch {
    return { exists: false };
  }
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readCodexGoalProgressFile(
  path: string,
): Promise<{
  readonly status?: string;
  readonly updatedAt?: string;
  readonly pid?: number;
  readonly resultStatus?: string;
  readonly reason?: string;
  readonly attemptCount?: number;
  readonly currentAccount?: string;
}> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isRecord(parsed)) return {};
  return {
    ...(typeof parsed.status === "string" ? { status: parsed.status } : {}),
    ...(typeof parsed.updatedAt === "string" ? { updatedAt: parsed.updatedAt } : {}),
    ...(typeof parsed.pid === "number" ? { pid: parsed.pid } : {}),
    ...(typeof parsed.resultStatus === "string"
      ? { resultStatus: parsed.resultStatus }
      : {}),
    ...(typeof parsed.reason === "string"
      ? { reason: redactStatusText(parsed.reason) }
      : {}),
    ...(typeof parsed.attemptCount === "number"
      ? { attemptCount: parsed.attemptCount }
      : {}),
    ...(typeof parsed.currentAccount === "string"
      ? { currentAccount: parsed.currentAccount }
      : {}),
  };
}

function statusPorcelainPath(line: string): string {
  const path = line.length > 3 ? line.slice(3).trim() : line.trim();
  const renameTarget = path.split(" -> ").at(-1);
  return renameTarget?.trim() ?? path;
}

function redactStatusText(value: string): string {
  return new DefaultRedactor().redact(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
