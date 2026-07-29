import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  constants,
} from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import {
  AgentRuntimeTaskResultStatus,
} from "@vioxen/subscription-runtime/core";
import {
  agentRuntimeTaskProtocolVersionV3,
  parseAgentRuntimeTaskResult,
  type AgentRuntimeTaskResultV3,
} from "@vioxen/subscription-runtime/agent-runtime-task";
import {
  LogicalThreadBusyError,
  LogicalThreadExecutionStatus,
  LogicalThreadStoreCorruptError,
  type LogicalThreadExecutionRecord,
  type LogicalThreadState,
  type LogicalThreadStore,
  type LogicalThreadTransaction,
} from "../../agent-runtime-task-runner/logical-thread";

const storageVersion = "agent-runtime-logical-thread-v1" as const;
const encryptionAlgorithm = "aes-256-gcm" as const;
const nonceBytes = 12;
const authTagBytes = 16;
const encryptionKeyBytes = 32;
const privateDirectoryMode = 0o700;
const privateFileMode = 0o600;
const maxEncryptedRecordBytes = 16 * 1024 * 1024;
const maxLockRecordBytes = 64 * 1024;

type EncryptedRecord = {
  readonly storageVersion: typeof storageVersion;
  readonly algorithm: typeof encryptionAlgorithm;
  readonly encryptedPayload: string;
  readonly nonce: string;
  readonly authTag: string;
};

type LockRecord = {
  readonly storageVersion: "agent-runtime-logical-thread-lock-v1";
  readonly lockId: string;
  readonly pid: number;
  readonly acquiredAt: string;
};

export class FileLogicalThreadStore implements LogicalThreadStore {
  private readonly rootDir: string;
  private readonly threadsDir: string;
  private readonly executionsDir: string;
  private readonly locksDir: string;
  private readonly keyPath: string;
  private keyPromise: Promise<Buffer> | undefined;

  constructor(input: {
    readonly rootDir: string;
    readonly keyPath?: string;
  }) {
    this.rootDir = resolve(input.rootDir);
    this.threadsDir = join(this.rootDir, "threads");
    this.executionsDir = join(this.rootDir, "executions");
    this.locksDir = join(this.rootDir, "locks");
    this.keyPath = input.keyPath ??
      join(this.rootDir, "logical-thread-encryption.key");
  }

  async withExclusive<T>(input: {
    readonly threadId: string;
    readonly action: (transaction: LogicalThreadTransaction) => Promise<T>;
  }): Promise<T> {
    await ensurePrivateDirectoryTree(this.rootDir, this.rootDir);
    await this.encryptionKey();
    await ensurePrivateDirectoryTree(this.rootDir, this.threadsDir);
    await ensurePrivateDirectoryTree(this.rootDir, this.executionsDir);
    const lock = await this.acquireLock(input.threadId);
    try {
      let current = await this.readState(input.threadId);
      const transaction: LogicalThreadTransaction = {
        readState: () => current,
        readExecution: async (executionId) =>
          await this.readExecution(input.threadId, executionId),
        writeState: async (state) => {
          assertThreadIdentity(input.threadId, state.threadId);
          const validated = parseThreadState(state, input.threadId);
          await this.writeEncrypted(
            this.threadPath(input.threadId),
            `thread:${hashText(input.threadId)}`,
            validated,
          );
          current = validated;
        },
        writeExecution: async (record) => {
          const validated = parseExecutionRecord(
            record,
            input.threadId,
            record.executionId,
          );
          await this.writeEncrypted(
            this.executionPath(input.threadId, record.executionId),
            executionAad(input.threadId, record.executionId),
            validated,
          );
        },
      };
      return await input.action(transaction);
    } finally {
      await lock.release();
    }
  }

  private async encryptionKey(): Promise<Buffer> {
    this.keyPromise ??= loadOrCreateEncryptionKey({
      keyPath: this.keyPath,
      stateDirs: [this.threadsDir, this.executionsDir],
    });
    return await this.keyPromise;
  }

  private async readState(threadId: string): Promise<LogicalThreadState | null> {
    const value = await this.readEncrypted(
      this.threadPath(threadId),
      `thread:${hashText(threadId)}`,
    );
    if (value === null) return null;
    try {
      return parseThreadState(value, threadId);
    } catch {
      throw new LogicalThreadStoreCorruptError();
    }
  }

  private async readExecution(
    threadId: string,
    executionId: string,
  ): Promise<LogicalThreadExecutionRecord | null> {
    const value = await this.readEncrypted(
      this.executionPath(threadId, executionId),
      executionAad(threadId, executionId),
    );
    if (value === null) return null;
    try {
      return parseExecutionRecord(value, threadId, executionId);
    } catch {
      throw new LogicalThreadStoreCorruptError();
    }
  }

  private async readEncrypted(
    path: string,
    aad: string,
  ): Promise<unknown | null> {
    let text: string;
    try {
      text = await readSecureFile(path, maxEncryptedRecordBytes, "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return null;
      throw error;
    }
    try {
      const record = parseEncryptedRecord(JSON.parse(text));
      const decipher = createDecipheriv(
        encryptionAlgorithm,
        await this.encryptionKey(),
        Buffer.from(record.nonce, "base64url"),
        { authTagLength: authTagBytes },
      );
      decipher.setAAD(Buffer.from(aad, "utf8"));
      decipher.setAuthTag(Buffer.from(record.authTag, "base64url"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(record.encryptedPayload, "base64url")),
        decipher.final(),
      ]);
      return JSON.parse(plaintext.toString("utf8"));
    } catch {
      throw new LogicalThreadStoreCorruptError();
    }
  }

  private async writeEncrypted(
    path: string,
    aad: string,
    value: unknown,
  ): Promise<void> {
    const nonce = randomBytes(nonceBytes);
    const cipher = createCipheriv(
      encryptionAlgorithm,
      await this.encryptionKey(),
      nonce,
      { authTagLength: authTagBytes },
    );
    cipher.setAAD(Buffer.from(aad, "utf8"));
    const encrypted = Buffer.concat([
      cipher.update(Buffer.from(JSON.stringify(value), "utf8")),
      cipher.final(),
    ]);
    const record: EncryptedRecord = {
      storageVersion,
      algorithm: encryptionAlgorithm,
      encryptedPayload: encrypted.toString("base64url"),
      nonce: nonce.toString("base64url"),
      authTag: cipher.getAuthTag().toString("base64url"),
    };
    const serialized = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > maxEncryptedRecordBytes) {
      throw new LogicalThreadStoreCorruptError();
    }
    await writeAtomic(this.rootDir, path, serialized);
  }

  private async acquireLock(threadId: string): Promise<{
    readonly release: () => Promise<void>;
  }> {
    await ensurePrivateDirectoryTree(this.rootDir, this.locksDir);
    const path = join(this.locksDir, `${hashText(threadId)}.lock`);
    const lockId = randomUUID();
    let created = false;
    try {
      await mkdir(path, { mode: privateDirectoryMode });
      created = true;
      await assertPrivateDirectory(path);
      const acquiredAt = new Date().toISOString();
      await writeLockRecord(this.rootDir, path, {
        storageVersion: "agent-runtime-logical-thread-lock-v1",
        lockId,
        pid: process.pid,
        acquiredAt,
      });
      return {
        release: async () => {
          await releaseLock(path, lockId);
        },
      };
    } catch (error) {
      if (isNodeError(error, "EEXIST")) {
        throw new LogicalThreadBusyError(threadId);
      }
      if (created) {
        await rm(path, { recursive: true, force: true }).catch(() => undefined);
      }
      throw error;
    }
  }

  private threadPath(threadId: string): string {
    return join(this.threadsDir, `${hashText(threadId)}.json`);
  }

  private executionPath(threadId: string, executionId: string): string {
    return join(
      this.executionsDir,
      hashText(threadId),
      `${hashText(executionId)}.json`,
    );
  }
}

async function loadOrCreateEncryptionKey(input: {
  readonly keyPath: string;
  readonly stateDirs: readonly string[];
}): Promise<Buffer> {
  try {
    return await readEncryptionKey(input.keyPath);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
  if (await anyStateExists(input.stateDirs)) {
    throw new LogicalThreadStoreCorruptError();
  }
  await ensurePrivateDirectoryTree(
    dirname(input.keyPath),
    dirname(input.keyPath),
  );
  try {
    await writeFile(input.keyPath, randomBytes(encryptionKeyBytes), {
      flag: "wx",
      mode: privateFileMode,
    });
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) throw error;
  }
  return await readEncryptionKey(input.keyPath);
}

async function readEncryptionKey(path: string): Promise<Buffer> {
  const key = await readSecureFile(path, encryptionKeyBytes);
  if (key.byteLength !== encryptionKeyBytes) {
    throw new LogicalThreadStoreCorruptError();
  }
  return key;
}

async function anyStateExists(paths: readonly string[]): Promise<boolean> {
  for (const path of paths) {
    try {
      await assertPrivateDirectory(path);
      if ((await readdir(path)).length > 0) return true;
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
  }
  return false;
}

async function writeAtomic(
  rootDir: string,
  path: string,
  text: string,
): Promise<void> {
  await ensurePrivateDirectoryTree(rootDir, dirname(path));
  await assertSecurePathAbsentOrRegularFile(path);
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, text, {
      flag: "wx",
      mode: privateFileMode,
    });
    await assertPrivateRegularFile(tempPath);
    await rename(tempPath, path);
    await assertPrivateRegularFile(path);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function writeLockRecord(
  rootDir: string,
  path: string,
  record: LockRecord,
): Promise<void> {
  await writeAtomic(
    rootDir,
    join(path, "owner.json"),
    `${JSON.stringify(record)}\n`,
  );
}

async function releaseLock(path: string, lockId: string): Promise<void> {
  const record = await readLockRecord(path);
  if (record?.lockId === lockId) {
    await rm(path, { recursive: true, force: true });
  }
}

async function readLockRecord(path: string): Promise<LockRecord | null> {
  try {
    await assertPrivateDirectory(path);
    const value = JSON.parse(
      await readSecureFile(
        join(path, "owner.json"),
        maxLockRecordBytes,
        "utf8",
      ),
    );
    if (
      !isRecord(value) ||
      value.storageVersion !== "agent-runtime-logical-thread-lock-v1" ||
      typeof value.lockId !== "string" ||
      typeof value.pid !== "number" ||
      typeof value.acquiredAt !== "string"
    ) {
      return null;
    }
    return value as LockRecord;
  } catch {
    return null;
  }
}

async function ensurePrivateDirectoryTree(
  rootDir: string,
  targetDir: string,
): Promise<void> {
  const root = resolve(rootDir);
  const target = resolve(targetDir);
  const relativeTarget = relative(root, target);
  if (
    relativeTarget === ".." ||
    relativeTarget.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
  ) {
    throw new LogicalThreadStoreCorruptError();
  }
  await mkdir(root, { recursive: true, mode: privateDirectoryMode });
  await assertPrivateDirectory(root);
  if (!relativeTarget) return;
  let current = root;
  for (const segment of relativeTarget.split(/[\\/]/u)) {
    current = join(current, segment);
    try {
      await mkdir(current, { mode: privateDirectoryMode });
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
    }
    await assertPrivateDirectory(current);
  }
}

async function assertPrivateDirectory(path: string): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) throw error;
    throw new LogicalThreadStoreCorruptError();
  }
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o777) !== privateDirectoryMode
  ) {
    throw new LogicalThreadStoreCorruptError();
  }
}

async function assertPrivateRegularFile(path: string): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) throw error;
    throw new LogicalThreadStoreCorruptError();
  }
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o777) !== privateFileMode
  ) {
    throw new LogicalThreadStoreCorruptError();
  }
}

async function assertSecurePathAbsentOrRegularFile(path: string): Promise<void> {
  try {
    await assertPrivateRegularFile(path);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return;
    throw error;
  }
}

async function readSecureFile(
  path: string,
  maxBytes: number,
): Promise<Buffer>;
async function readSecureFile(
  path: string,
  maxBytes: number,
  encoding: "utf8",
): Promise<string>;
async function readSecureFile(
  path: string,
  maxBytes: number,
  encoding?: "utf8",
): Promise<Buffer | string> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      (metadata.mode & 0o777) !== privateFileMode ||
      metadata.size > maxBytes
    ) {
      throw new LogicalThreadStoreCorruptError();
    }
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (totalBytes <= maxBytes) {
      const chunk = Buffer.allocUnsafe(
        Math.min(64 * 1024, maxBytes + 1 - totalBytes),
      );
      const { bytesRead } = await handle.read(
        chunk,
        0,
        chunk.byteLength,
        totalBytes,
      );
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      totalBytes += bytesRead;
    }
    if (totalBytes > maxBytes || (await handle.stat()).size > maxBytes) {
      throw new LogicalThreadStoreCorruptError();
    }
    const value = Buffer.concat(chunks, totalBytes);
    return encoding === undefined ? value : value.toString(encoding);
  } catch (error) {
    if (
      isNodeError(error, "ENOENT") ||
      error instanceof LogicalThreadStoreCorruptError
    ) {
      throw error;
    }
    throw new LogicalThreadStoreCorruptError();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function parseEncryptedRecord(value: unknown): EncryptedRecord {
  if (
    !isRecord(value) ||
    value.storageVersion !== storageVersion ||
    value.algorithm !== encryptionAlgorithm ||
    typeof value.encryptedPayload !== "string" ||
    typeof value.nonce !== "string" ||
    typeof value.authTag !== "string"
  ) {
    throw new LogicalThreadStoreCorruptError();
  }
  return value as EncryptedRecord;
}

function parseThreadState(value: unknown, threadId: string): LogicalThreadState {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "threadId",
      "generation",
      "compatibilityHash",
      "providerCheckpoint",
      "activeExecution",
      "lastCompletedExecution",
      "updatedAt",
    ]) ||
    value.threadId !== threadId ||
    !isNonNegativeSafeInteger(value.generation) ||
    !isNonEmptyString(value.compatibilityHash) ||
    !isIsoTimestamp(value.updatedAt) ||
    (value.providerCheckpoint !== undefined &&
      !isNonEmptyString(value.providerCheckpoint))
  ) {
    throw new LogicalThreadStoreCorruptError();
  }
  const activeExecution = value.activeExecution === undefined
    ? undefined
    : parseActiveExecution(value.activeExecution);
  const lastCompletedExecution = value.lastCompletedExecution === undefined
    ? undefined
    : parseCompletedExecution(value.lastCompletedExecution, threadId);
  if (
    (value.generation > 0 && value.providerCheckpoint === undefined) ||
    (value.generation === 0 && value.providerCheckpoint !== undefined) ||
    (lastCompletedExecution?.result.status ===
      AgentRuntimeTaskResultStatus.Completed &&
      value.generation === 0)
  ) {
    throw new LogicalThreadStoreCorruptError();
  }
  return {
    threadId,
    generation: value.generation as number,
    compatibilityHash: value.compatibilityHash,
    ...(value.providerCheckpoint === undefined
      ? {}
      : { providerCheckpoint: value.providerCheckpoint }),
    ...(activeExecution === undefined ? {} : { activeExecution }),
    ...(lastCompletedExecution === undefined
      ? {}
      : { lastCompletedExecution }),
    updatedAt: value.updatedAt,
  };
}

function parseExecutionRecord(
  value: unknown,
  threadId: string,
  executionId: string,
): LogicalThreadExecutionRecord {
  if (!isRecord(value) || value.executionId !== executionId) {
    throw new LogicalThreadStoreCorruptError();
  }
  if (value.status === LogicalThreadExecutionStatus.Active) {
    return parseActiveExecution(value);
  }
  if (value.status === LogicalThreadExecutionStatus.Completed) {
    return parseCompletedExecution(value, threadId);
  }
  throw new LogicalThreadStoreCorruptError();
}

function parseActiveExecution(value: unknown): LogicalThreadExecutionRecord & {
  readonly status: LogicalThreadExecutionStatus.Active;
} {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "status",
      "executionId",
      "requestHash",
      "startedAt",
    ]) ||
    value.status !== LogicalThreadExecutionStatus.Active ||
    !isNonEmptyString(value.executionId) ||
    !isNonEmptyString(value.requestHash) ||
    !isIsoTimestamp(value.startedAt)
  ) {
    throw new LogicalThreadStoreCorruptError();
  }
  return {
    status: LogicalThreadExecutionStatus.Active,
    executionId: value.executionId,
    requestHash: value.requestHash,
    startedAt: value.startedAt,
  };
}

function parseCompletedExecution(
  value: unknown,
  threadId: string,
): LogicalThreadExecutionRecord & {
  readonly status: LogicalThreadExecutionStatus.Completed;
} {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "status",
      "executionId",
      "requestHash",
      "result",
      "workspaceEffectFingerprint",
      "completedAt",
    ]) ||
    value.status !== LogicalThreadExecutionStatus.Completed ||
    !isNonEmptyString(value.executionId) ||
    !isNonEmptyString(value.requestHash) ||
    !isIsoTimestamp(value.completedAt)
  ) {
    throw new LogicalThreadStoreCorruptError();
  }
  if (
    !isRecord(value.result) ||
    !hasOnlyKeys(
      value.result,
      value.result.status === AgentRuntimeTaskResultStatus.Completed
        ? [
            "protocolVersion",
            "status",
            "outputText",
            "structuredOutput",
            "telemetry",
            "warnings",
            "thread",
          ]
        : [
            "protocolVersion",
            "status",
            "failure",
            "telemetry",
            "warnings",
            "lifecycle",
          ],
    )
  ) {
    throw new LogicalThreadStoreCorruptError();
  }
  const result = parseAgentRuntimeTaskResult(value.result);
  if (result.protocolVersion !== agentRuntimeTaskProtocolVersionV3) {
    throw new LogicalThreadStoreCorruptError();
  }
  const typedResult = result as AgentRuntimeTaskResultV3;
  const completed = typedResult.status === AgentRuntimeTaskResultStatus.Completed;
  const workspaceEffectFingerprint =
    typeof value.workspaceEffectFingerprint === "string"
      ? value.workspaceEffectFingerprint
      : undefined;
  if (
    (completed &&
      (!isNonEmptyString(workspaceEffectFingerprint) ||
        typedResult.thread.id !== threadId)) ||
    (!completed && value.workspaceEffectFingerprint !== undefined)
  ) {
    throw new LogicalThreadStoreCorruptError();
  }
  return {
    status: LogicalThreadExecutionStatus.Completed,
    executionId: value.executionId,
    requestHash: value.requestHash,
    result: typedResult,
    ...(workspaceEffectFingerprint === undefined
      ? {}
      : { workspaceEffectFingerprint }),
    completedAt: value.completedAt,
  };
}

function executionAad(threadId: string, executionId: string): string {
  return `execution:${hashText(threadId)}:${hashText(executionId)}`;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertThreadIdentity(expected: string, actual: string): void {
  if (expected !== actual) throw new Error("logical_thread_identity_mismatch");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isNodeError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code;
}
