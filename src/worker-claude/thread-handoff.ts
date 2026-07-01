import { createHash, randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, win32 } from "node:path";

export type ClaudeLogicalThreadState = {
  readonly threadId: string;
  readonly cwd: string;
  readonly generation: number;
  readonly latestSessionId?: string;
  readonly latestBundleId?: string;
  readonly latestProviderInstanceId?: string;
  readonly latestWorkerId?: string;
  readonly updatedAt: string;
};

export interface ClaudeLogicalThreadStore {
  read(threadId: string): Promise<ClaudeLogicalThreadState | null>;
  compareAndSwap(input: {
    readonly threadId: string;
    readonly expectedGeneration: number;
    readonly next: Omit<ClaudeLogicalThreadState, "generation">;
  }): Promise<ClaudeLogicalThreadState>;
  updateExclusive<T>(input: {
    readonly threadId: string;
    readonly update: (
      current: ClaudeLogicalThreadState | null,
    ) => Promise<{
      readonly next: Omit<ClaudeLogicalThreadState, "generation">;
      readonly value: T;
    }>;
  }): Promise<{
    readonly state: ClaudeLogicalThreadState;
    readonly value: T;
  }>;
}

export type ClaudeTranscriptBundle = {
  readonly bundleId: string;
  readonly cwd: string;
  readonly sessionId: string;
  readonly sourceConfigDir: string;
  readonly files: readonly string[];
  readonly capturedAt: string;
};

export interface ClaudeTranscriptBundleStore {
  capture(input: {
    readonly sourceConfigDir: string;
    readonly cwd: string;
    readonly sessionId: string;
  }): Promise<ClaudeTranscriptBundle>;
  materialize(input: {
    readonly bundleId: string;
    readonly targetConfigDir: string;
  }): Promise<ClaudeTranscriptBundle>;
  remove?(input: {
    readonly bundleId: string;
  }): Promise<void>;
}

type ClaudeLogicalThreadLockRecord = {
  readonly storageVersion: "claude-logical-thread-lock-v1";
  readonly lockId: string;
  readonly acquiredAt: string;
  readonly heartbeatAt?: string;
  readonly pid: number;
};

const defaultThreadLockAcquireTimeoutMs = 10_000;
const defaultThreadLockTtlMs = 5 * 60_000;
const defaultThreadLockHeartbeatMs = 30_000;
const threadLockRecordFileName = "owner.json";

export class ClaudeLogicalThreadConflictError extends Error {
  constructor(
    readonly threadId: string,
    readonly expectedGeneration: number,
    readonly actualGeneration: number,
  ) {
    super("claude_logical_thread_generation_conflict");
    this.name = "ClaudeLogicalThreadConflictError";
  }
}

export class FileClaudeLogicalThreadStore
  implements ClaudeLogicalThreadStore
{
  private readonly threadsDir: string;
  private readonly locksDir: string;

  constructor(private readonly rootDir: string) {
    this.threadsDir = join(rootDir, "threads");
    this.locksDir = join(rootDir, "locks");
  }

  async read(threadId: string): Promise<ClaudeLogicalThreadState | null> {
    try {
      return parseThreadState(await readFile(this.threadPath(threadId), "utf8"));
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    }
  }

  async compareAndSwap(input: {
    readonly threadId: string;
    readonly expectedGeneration: number;
    readonly next: Omit<ClaudeLogicalThreadState, "generation">;
  }): Promise<ClaudeLogicalThreadState> {
    const result = await this.updateExclusive({
      threadId: input.threadId,
      update: async (current) => {
        const actualGeneration = current?.generation ?? 0;
        if (actualGeneration !== input.expectedGeneration) {
          throw new ClaudeLogicalThreadConflictError(
            input.threadId,
            input.expectedGeneration,
            actualGeneration,
          );
        }
        return { next: input.next, value: undefined };
      },
    });
    return result.state;
  }

  async updateExclusive<T>(input: {
    readonly threadId: string;
    readonly update: (
      current: ClaudeLogicalThreadState | null,
    ) => Promise<{
      readonly next: Omit<ClaudeLogicalThreadState, "generation">;
      readonly value: T;
    }>;
  }): Promise<{
    readonly state: ClaudeLogicalThreadState;
    readonly value: T;
  }> {
    return this.withThreadLock(input.threadId, async () => {
      const current = await this.read(input.threadId);
      const { next, value } = await input.update(current);
      const state = await this.writeNextState(
        input.threadId,
        current?.generation ?? 0,
        next,
      );
      return { state, value };
    });
  }

  private async writeNextState(
    threadId: string,
    currentGeneration: number,
    next: Omit<ClaudeLogicalThreadState, "generation">,
  ): Promise<ClaudeLogicalThreadState> {
    const state: ClaudeLogicalThreadState = {
      ...next,
      generation: currentGeneration + 1,
    };
    await mkdir(this.threadsDir, { recursive: true, mode: 0o700 });
    const path = this.threadPath(threadId);
    const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(tempPath, path);
    return state;
  }

  private async withThreadLock<T>(
    threadId: string,
    action: () => Promise<T>,
  ): Promise<T> {
    await mkdir(this.locksDir, { recursive: true, mode: 0o700 });
    const lockPath = join(this.locksDir, `${hashText(threadId)}.lock`);
    const lockId = `thread-lock:${randomUUID()}`;
    const deadline = Date.now() + defaultThreadLockAcquireTimeoutMs;
    while (true) {
      try {
        await mkdir(lockPath, { mode: 0o700 });
        try {
          await writeThreadLockRecord(lockPath, {
            storageVersion: "claude-logical-thread-lock-v1",
            lockId,
            acquiredAt: new Date().toISOString(),
            pid: process.pid,
          });
        } catch (error) {
          await rm(lockPath, { recursive: true, force: true });
          throw error;
        }
        break;
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") throw error;
        await removeStaleThreadLock(lockPath, new Date());
        if (Date.now() >= deadline) {
          throw new Error("claude_logical_thread_lock_timeout");
        }
        await delay(25);
      }
    }

    const heartbeatTimer = startThreadLockHeartbeat(lockPath, lockId);
    try {
      return await action();
    } finally {
      heartbeatTimer.dispose();
      await releaseThreadLock(lockPath, lockId);
    }
  }

  private threadPath(threadId: string): string {
    return join(this.threadsDir, `${hashText(threadId)}.json`);
  }
}

export class FileClaudeTranscriptBundleStore
  implements ClaudeTranscriptBundleStore
{
  private readonly bundlesDir: string;

  constructor(private readonly rootDir: string) {
    this.bundlesDir = join(rootDir, "bundles");
  }

  async capture(input: {
    readonly sourceConfigDir: string;
    readonly cwd: string;
    readonly sessionId: string;
  }): Promise<ClaudeTranscriptBundle> {
    const sessionId = requireSafeId(input.sessionId);
    const sourceConfigDir = await realpath(input.sourceConfigDir);
    const transcriptPath = await findTranscriptPath(
      sourceConfigDir,
      sessionId,
    );
    if (!transcriptPath) {
      throw new Error("claude_transcript_not_found");
    }

    const projectDir = dirname(transcriptPath);
    const files = await transcriptBundleFiles(projectDir, sessionId);
    const bundleId = `bundle-${hashText(
      `${input.cwd}:${sessionId}:${Date.now()}:${randomUUID()}`,
    ).slice(0, 24)}`;
    const bundleDir = this.bundleDir(bundleId);
    const filesDir = join(bundleDir, "files");

    await mkdir(filesDir, { recursive: true, mode: 0o700 });
    const relativeFiles: string[] = [];
    for (const filePath of files) {
      const relativePath = requireSafeRelativePath(
        relative(sourceConfigDir, filePath),
      );
      relativeFiles.push(relativePath);
      const targetPath = join(filesDir, relativePath);
      await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
      await cp(filePath, targetPath, { force: true });
    }

    const bundle: ClaudeTranscriptBundle = {
      bundleId,
      cwd: await realpath(input.cwd),
      sessionId,
      sourceConfigDir,
      files: relativeFiles.sort(),
      capturedAt: new Date().toISOString(),
    };
    await writeFile(
      join(bundleDir, "manifest.json"),
      `${JSON.stringify(bundle, null, 2)}\n`,
      { mode: 0o600 },
    );
    return bundle;
  }

  async materialize(input: {
    readonly bundleId: string;
    readonly targetConfigDir: string;
  }): Promise<ClaudeTranscriptBundle> {
    const bundleDir = this.bundleDir(input.bundleId);
    const bundle = parseBundle(
      await readFile(join(bundleDir, "manifest.json"), "utf8"),
    );
    const targetConfigDir = await ensureRealDirectory(input.targetConfigDir);
    const filesDir = join(bundleDir, "files");

    for (const file of bundle.files) {
      const relativePath = requireSafeRelativePath(file);
      const sourcePath = join(filesDir, relativePath);
      const sourceStats = await lstat(sourcePath);
      if (!sourceStats.isFile()) {
        throw new Error("claude_transcript_bundle_file_invalid");
      }
      const targetPath = join(targetConfigDir, relativePath);
      await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
      await cp(sourcePath, targetPath, { force: true });
    }

    return bundle;
  }

  async remove(input: { readonly bundleId: string }): Promise<void> {
    await rm(this.bundleDir(input.bundleId), { recursive: true, force: true });
  }

  private bundleDir(bundleId: string): string {
    return join(this.bundlesDir, requireSafeId(bundleId));
  }
}

async function findTranscriptPath(
  configDir: string,
  sessionId: string,
): Promise<string | null> {
  const projectsDir = join(configDir, "projects");
  try {
    return await findFile(projectsDir, `${sessionId}.jsonl`);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

async function findFile(dir: string, fileName: string): Promise<string | null> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isFile() && entry.name === fileName) return path;
    if (entry.isDirectory()) {
      const found = await findFile(path, fileName);
      if (found) return found;
    }
  }
  return null;
}

async function transcriptBundleFiles(
  projectDir: string,
  sessionId: string,
): Promise<readonly string[]> {
  const main = join(projectDir, `${sessionId}.jsonl`);
  const files = new Set<string>([main]);
  const sessionSidecarDir = join(projectDir, sessionId);
  if (await pathExists(sessionSidecarDir)) {
    for (const file of await listFiles(sessionSidecarDir)) files.add(file);
  }
  const subagentsDir = join(projectDir, "subagents");
  if (await pathExists(subagentsDir)) {
    for (const file of await listFiles(subagentsDir)) files.add(file);
  }
  return [...files].sort();
}

async function listFiles(dir: string): Promise<readonly string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isFile()) files.push(path);
    if (entry.isDirectory()) files.push(...(await listFiles(path)));
  }
  return files;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

async function ensureRealDirectory(path: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  return realpath(path);
}

async function writeThreadLockRecord(
  lockPath: string,
  record: ClaudeLogicalThreadLockRecord,
): Promise<void> {
  await writeFile(
    join(lockPath, threadLockRecordFileName),
    `${JSON.stringify(record, null, 2)}\n`,
    { mode: 0o600 },
  );
}

async function releaseThreadLock(
  lockPath: string,
  lockId: string,
): Promise<void> {
  const record = await readThreadLockRecord(lockPath);
  if (record && record.lockId !== lockId) return;
  await rm(lockPath, { recursive: true, force: true });
}

function startThreadLockHeartbeat(
  lockPath: string,
  lockId: string,
): { readonly dispose: () => void } {
  const timer = setInterval(() => {
    void refreshThreadLockHeartbeat(lockPath, lockId);
  }, defaultThreadLockHeartbeatMs);
  timer.unref();
  return {
    dispose() {
      clearInterval(timer);
    },
  };
}

async function refreshThreadLockHeartbeat(
  lockPath: string,
  lockId: string,
): Promise<void> {
  const record = await readThreadLockRecord(lockPath).catch(() => null);
  if (!record || record.lockId !== lockId) return;
  await writeThreadLockRecord(lockPath, {
    ...record,
    heartbeatAt: new Date().toISOString(),
  }).catch(() => {
    // Best effort only. The stale-lock TTL still protects crashed workers.
  });
}

async function removeStaleThreadLock(
  lockPath: string,
  now: Date,
): Promise<boolean> {
  if (!(await isThreadLockStale(lockPath, now))) return false;
  const stalePath = `${lockPath}.${process.pid}.${randomUUID()}.stale`;
  try {
    await rename(lockPath, stalePath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return true;
    if (isNodeError(error) && error.code === "EEXIST") return false;
    throw error;
  }
  await rm(stalePath, { recursive: true, force: true });
  return true;
}

async function isThreadLockStale(lockPath: string, now: Date): Promise<boolean> {
  const record = await readThreadLockRecord(lockPath);
  const lastSeenAtMs = record
    ? Date.parse(record.heartbeatAt ?? record.acquiredAt)
    : await threadLockMtimeMs(lockPath);
  if (lastSeenAtMs === null) return true;
  if (Number.isNaN(lastSeenAtMs)) return true;
  return now.getTime() - lastSeenAtMs >= defaultThreadLockTtlMs;
}

async function threadLockMtimeMs(lockPath: string): Promise<number | null> {
  try {
    return (await stat(lockPath)).mtimeMs;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

async function readThreadLockRecord(
  lockPath: string,
): Promise<ClaudeLogicalThreadLockRecord | null> {
  try {
    return parseThreadLockRecord(
      await readFile(join(lockPath, threadLockRecordFileName), "utf8"),
    );
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    if (error instanceof SyntaxError) return null;
    if (
      error instanceof Error &&
      error.message === "claude_logical_thread_lock_record_invalid"
    ) {
      return null;
    }
    throw error;
  }
}

function parseThreadLockRecord(raw: string): ClaudeLogicalThreadLockRecord {
  const value = JSON.parse(raw) as unknown;
  if (!isRecord(value)) {
    throw new Error("claude_logical_thread_lock_record_invalid");
  }
  const lockId = nonEmptyString(value.lockId);
  const acquiredAt = validIsoDateString(value.acquiredAt);
  const heartbeatAt = optionalIsoDateString(
    value.heartbeatAt,
    "claude_logical_thread_lock_record_invalid",
  );
  const pid = value.pid;
  if (
    value.storageVersion !== "claude-logical-thread-lock-v1" ||
    lockId === null ||
    acquiredAt === null ||
    typeof pid !== "number" ||
    !Number.isSafeInteger(pid)
  ) {
    throw new Error("claude_logical_thread_lock_record_invalid");
  }
  return {
    storageVersion: "claude-logical-thread-lock-v1",
    lockId,
    acquiredAt,
    ...(heartbeatAt === undefined ? {} : { heartbeatAt }),
    pid,
  };
}

function parseThreadState(raw: string): ClaudeLogicalThreadState {
  const value = JSON.parse(raw) as unknown;
  if (!isRecord(value)) {
    throw new Error("claude_logical_thread_state_invalid");
  }
  const threadId = nonEmptyString(value.threadId);
  const cwd = absolutePathString(value.cwd);
  const generation = value.generation;
  const updatedAt = validIsoDateString(value.updatedAt);
  const latestSessionId = optionalSafeId(
    value.latestSessionId,
    "claude_logical_thread_state_invalid",
  );
  const latestBundleId = optionalSafeId(
    value.latestBundleId,
    "claude_logical_thread_state_invalid",
  );
  const latestProviderInstanceId = optionalNonEmptyString(
    value.latestProviderInstanceId,
    "claude_logical_thread_state_invalid",
  );
  const latestWorkerId = optionalNonEmptyString(
    value.latestWorkerId,
    "claude_logical_thread_state_invalid",
  );
  if (
    threadId === null ||
    cwd === null ||
    typeof generation !== "number" ||
    !Number.isSafeInteger(generation) ||
    generation < 0 ||
    updatedAt === null
  ) {
    throw new Error("claude_logical_thread_state_invalid");
  }
  return {
    threadId,
    cwd,
    generation,
    ...(latestSessionId === undefined ? {} : { latestSessionId }),
    ...(latestBundleId === undefined ? {} : { latestBundleId }),
    ...(latestProviderInstanceId === undefined
      ? {}
      : { latestProviderInstanceId }),
    ...(latestWorkerId === undefined ? {} : { latestWorkerId }),
    updatedAt,
  };
}

function optionalSafeId(value: unknown, errorCode: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(errorCode);
  try {
    return requireSafeId(value);
  } catch {
    throw new Error(errorCode);
  }
}

function optionalNonEmptyString(
  value: unknown,
  errorCode: string,
): string | undefined {
  if (value === undefined) return undefined;
  const string = nonEmptyString(value);
  if (string === null) throw new Error(errorCode);
  return string;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function absolutePathString(value: unknown): string | null {
  const string = nonEmptyString(value);
  if (!string) return null;
  return isAbsolute(string) || win32.isAbsolute(string) ? string : null;
}

function validIsoDateString(value: unknown): string | null {
  const string = nonEmptyString(value);
  if (!string || Number.isNaN(Date.parse(string))) return null;
  return string;
}

function optionalIsoDateString(
  value: unknown,
  errorCode: string,
): string | undefined {
  if (value === undefined) return undefined;
  const string = validIsoDateString(value);
  if (string === null) throw new Error(errorCode);
  return string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBundle(raw: string): ClaudeTranscriptBundle {
  const value = JSON.parse(raw) as unknown;
  if (!isRecord(value)) {
    throw new Error("claude_transcript_bundle_invalid");
  }
  const bundleId = optionalSafeId(value.bundleId, "claude_transcript_bundle_invalid");
  const sessionId = optionalSafeId(value.sessionId, "claude_transcript_bundle_invalid");
  const cwd = absolutePathString(value.cwd);
  const sourceConfigDir = absolutePathString(value.sourceConfigDir);
  const capturedAt = validIsoDateString(value.capturedAt);
  if (
    bundleId === undefined ||
    sessionId === undefined ||
    cwd === null ||
    sourceConfigDir === null ||
    capturedAt === null ||
    !Array.isArray(value.files)
  ) {
    throw new Error("claude_transcript_bundle_invalid");
  }
  return {
    bundleId,
    cwd,
    sessionId,
    sourceConfigDir,
    files: value.files.map((file) => {
      if (typeof file !== "string") {
        throw new Error("claude_transcript_bundle_invalid");
      }
      return requireSafeRelativePath(file);
    }),
    capturedAt,
  };
}

function requireSafeId(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(value)) {
    throw new Error("claude_safe_id_required");
  }
  return value;
}

function requireSafeRelativePath(value: string): string {
  const normalizedInput = value.replace(/\\/g, "/");
  const normalizedPath = posix.normalize(normalizedInput);
  if (
    value.length === 0 ||
    value.includes("\0") ||
    isAbsolute(value) ||
    win32.isAbsolute(value) ||
    /^[A-Za-z]:/u.test(value) ||
    normalizedPath === "." ||
    normalizedPath === ".." ||
    normalizedPath.startsWith("../") ||
    normalizedInput.split("/").includes("..")
  ) {
    throw new Error("claude_safe_relative_path_required");
  }
  return normalizedPath;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
