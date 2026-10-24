// Coordinates local custody operations without depending on a provider adapter.
import { createHash, randomBytes } from "node:crypto";
import { link, mkdir, readFile, readlink, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  localFileLeaseDefaultLockAcquireTimeoutMs as defaultLockAcquireTimeoutMs,
  localFileLeaseDefaultLockPollMs as defaultLockPollMs,
  localFileLeaseDefaultLockTtlMs as defaultLockTtlMs,
  localFileLeaseLockStorageVersion,
} from "../session-leases/domain/local-file-lease-store-policy";

type LocalFileProviderLockOptions = {
  readonly rootDir: string;
  readonly now?: () => Date;
  readonly lockTtlMs?: number;
  readonly lockAcquireTimeoutMs?: number;
  readonly lockPollMs?: number;
};

type PersistedLockRecord = {
  readonly storageVersion: typeof localFileLeaseLockStorageVersion;
  readonly lockId: string;
  readonly providerInstanceIdHash: string;
  readonly pid: number;
  readonly acquiredAt: string;
  readonly expiresAt: string;
  readonly ownerProcess?: {
    readonly bootId: string;
    readonly pidNamespace: string;
    readonly startTimeTicks: string;
  };
};

const bootIdPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const pidNamespacePattern = /^pid:\[[1-9]\d*\]$/;

/** Local filesystem transactions share one lock per provider across all processes.
 * TTL permits recovery only after the owner process exits; a delayed live owner
 * must never lose its lock while it can still rename a session record.
 */
export class LocalFileProviderLock {
  constructor(private readonly options: LocalFileProviderLockOptions) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private lockDir(): string {
    return join(this.options.rootDir, "leases", "locks");
  }

  private lockPath(providerInstanceId: string): string {
    return join(this.lockDir(), `${hashText(providerInstanceId)}.lock`);
  }

  async run<T>(
    providerInstanceId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    await mkdir(this.lockDir(), { recursive: true, mode: 0o700 });
    const lockId = `local-file-lock:${randomBytes(16).toString("hex")}`;
    const lockPath = this.lockPath(providerInstanceId);
    const deadline =
      Date.now() +
      (this.options.lockAcquireTimeoutMs ?? defaultLockAcquireTimeoutMs);
    await this.acquireProviderLock({
      providerInstanceId,
      lockId,
      lockPath,
      deadline,
    });
    try {
      return await operation();
    } finally {
      await this.releaseProviderLock({
        providerInstanceId,
        lockId,
        lockPath,
      });
    }
  }

  private async acquireProviderLock(input: {
    readonly providerInstanceId: string;
    readonly lockId: string;
    readonly lockPath: string;
    readonly deadline: number;
  }): Promise<void> {
    const pollMs = this.options.lockPollMs ?? defaultLockPollMs;
    const ownerProcess = await readProcessIdentity(process.pid);
    while (true) {
      const now = this.now();
      const record: PersistedLockRecord = {
        storageVersion: localFileLeaseLockStorageVersion,
        lockId: input.lockId,
        providerInstanceIdHash: hashText(input.providerInstanceId),
        pid: process.pid,
        ...(ownerProcess ? { ownerProcess } : {}),
        acquiredAt: now.toISOString(),
        expiresAt: new Date(
          now.getTime() + (this.options.lockTtlMs ?? defaultLockTtlMs),
        ).toISOString(),
      };
      try {
        const candidate = `${input.lockPath}.${process.pid}.${randomBytes(6).toString("hex")}.candidate`;
        try {
          await writeFile(candidate, `${JSON.stringify(record, null, 2)}\n`, {
            flag: "wx",
            mode: 0o600,
          });
          await link(candidate, input.lockPath);
        } finally {
          await rm(candidate, { force: true });
        }
        return;
      } catch (error) {
        if (!isAlreadyExistsError(error)) throw error;
      }

      const existing = await this.readLockRecord(input.lockPath);
      if (!existing) {
        if (Date.now() >= input.deadline) {
          throw new Error("local_file_lease_lock_timeout");
        }
        await delay(pollMs);
        continue;
      }
      if (isLockExpired(existing, this.now()) && await isLockOwnerGone(existing)) {
        await this.removeLockIfMatchesGuarded({
          providerInstanceId: input.providerInstanceId,
          lockId: existing.lockId,
          lockPath: input.lockPath,
          deadline: input.deadline,
        });
        continue;
      }

      if (Date.now() >= input.deadline) {
        throw new Error("local_file_lease_lock_timeout");
      }
      await delay(pollMs);
    }
  }

  private async releaseProviderLock(input: {
    readonly providerInstanceId: string;
    readonly lockId: string;
    readonly lockPath: string;
  }): Promise<void> {
    // A live owner cannot be reclaimed, so releasing its own unique lock needs
    // no cleanup mutex. Stale owners always use the guarded removal below.
    await this.removeLockIfMatches(input);
  }

  private async removeLockIfMatchesGuarded(input: {
    readonly providerInstanceId: string;
    readonly lockId: string;
    readonly lockPath: string;
    readonly deadline: number;
  }): Promise<void> {
    const removalLockId = `local-file-lock-cleanup:${randomBytes(16).toString("hex")}`;
    const removalLockPath = this.lockRemovalGuardPath(
      input.lockPath,
      input.lockId,
    );
    const removalProviderInstanceId = `${input.providerInstanceId}:lock-cleanup:${input.lockId}`;
    await this.acquireProviderLock({
      providerInstanceId: removalProviderInstanceId,
      lockId: removalLockId,
      lockPath: removalLockPath,
      deadline: input.deadline,
    });
    try {
      const candidate = await this.readLockRecord(input.lockPath);
      if (candidate?.lockId !== input.lockId) return;
      await this.removeLockIfMatches(input);
    } finally {
      await this.releaseProviderLock({
        providerInstanceId: removalProviderInstanceId,
        lockId: removalLockId,
        lockPath: removalLockPath,
      });
    }
  }

  private async removeLockIfMatches(input: {
    readonly lockId: string;
    readonly lockPath: string;
  }): Promise<void> {
    const candidate = await this.readLockRecord(input.lockPath);
    if (candidate?.lockId !== input.lockId) return;

    const tombstonePath = `${input.lockPath}.${process.pid}.${randomBytes(6).toString("hex")}.removing`;
    try {
      await rename(input.lockPath, tombstonePath);
    } catch (error) {
      if (isMissingFileError(error)) return;
      throw error;
    }

    const existing = await this.readLockRecord(tombstonePath);
    if (existing?.lockId === input.lockId) {
      await rm(tombstonePath, { force: true });
      return;
    }

    try {
      await link(tombstonePath, input.lockPath);
      await rm(tombstonePath, { force: true });
    } catch (error) {
      await rm(tombstonePath, { force: true }).catch(() => {});
      if (!isAlreadyExistsError(error)) {
        throw error;
      }
    }
  }

  private lockRemovalGuardPath(lockPath: string, lockId: string): string {
    // The directory scopes the mutex; root aliases must share its basename.
    // Hashing also keeps recursive recovery paths bounded.
    return join(dirname(lockPath), `${hashText(`${basename(lockPath)}\0${lockId}`)}.cleanup.lock`);
  }

  private async readLockRecord(
    path: string,
  ): Promise<PersistedLockRecord | null> {
    try {
      const parsed = JSON.parse(
        await readFile(path, "utf8"),
      ) as Partial<PersistedLockRecord>;
      if (
        parsed.storageVersion !== localFileLeaseLockStorageVersion ||
        typeof parsed.lockId !== "string" ||
        typeof parsed.providerInstanceIdHash !== "string" ||
        typeof parsed.pid !== "number" ||
        typeof parsed.acquiredAt !== "string" ||
        typeof parsed.expiresAt !== "string"
      ) {
        return null;
      }
      return {
        storageVersion: localFileLeaseLockStorageVersion,
        lockId: parsed.lockId,
        providerInstanceIdHash: parsed.providerInstanceIdHash,
        pid: parsed.pid,
        acquiredAt: parsed.acquiredAt,
        expiresAt: parsed.expiresAt,
        ...(parsed.ownerProcess && typeof parsed.ownerProcess.bootId === "string" && bootIdPattern.test(parsed.ownerProcess.bootId) &&
          typeof parsed.ownerProcess.pidNamespace === "string" && pidNamespacePattern.test(parsed.ownerProcess.pidNamespace) &&
          typeof parsed.ownerProcess.startTimeTicks === "string" && /^\d+$/.test(parsed.ownerProcess.startTimeTicks)
          ? { ownerProcess: { bootId: parsed.ownerProcess.bootId, pidNamespace: parsed.ownerProcess.pidNamespace,
            startTimeTicks: parsed.ownerProcess.startTimeTicks } }
          : {}),
      };
    } catch (error) {
      if (isMissingFileError(error)) return null;
      return null;
    }
  }
}

async function isLockOwnerGone(record: PersistedLockRecord): Promise<boolean> {
  if (!Number.isSafeInteger(record.pid) || record.pid <= 0) return false;
  if (process.platform === "linux") {
    const local = await readProcessIdentity(process.pid);
    // A PID, including ESRCH, has meaning only in its recorded namespace/boot.
    // Legacy or unreadable identities cannot prove that another owner is gone.
    if (!record.ownerProcess || !local) return false;
    // Within the single-host contract, a prior boot proves the owner exited.
    // Namespace inode values may legitimately change or be reused after reboot.
    if (record.ownerProcess.bootId !== local.bootId) return true;
    if (record.ownerProcess.pidNamespace !== local.pidNamespace) return false;
  }
  try {
    process.kill(record.pid, 0);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return true;
  }
  if (!record.ownerProcess) return false;
  const current = await readProcessIdentity(record.pid);
  return current !== undefined && current.bootId === record.ownerProcess.bootId &&
    current.pidNamespace === record.ownerProcess.pidNamespace && current.startTimeTicks !== record.ownerProcess.startTimeTicks;
}

async function readProcessIdentity(pid: number): Promise<PersistedLockRecord["ownerProcess"]> {
  if (process.platform !== "linux") return undefined;
  try {
    const [bootId, selfStat, selfStatus, pidNamespace] = await Promise.all([
      readFile("/proc/sys/kernel/random/boot_id", "utf8"),
      readFile("/proc/self/stat", "utf8"),
      readFile("/proc/self/status", "utf8"),
      readlink("/proc/self/ns/pid"),
    ]);
    // Sandboxes may expose a host procfs beside a different PID namespace.
    // Such observations cannot prove the identity of the lock's local PID.
    // NSpid lists one column per namespace starting at the procfs mount's view.
    // Matching the numeric PID alone cannot authenticate that procfs view.
    const namespacePids = /^NSpid:\s+([^\n]+)$/m.exec(selfStatus)?.[1]?.trim().split(/\s+/);
    if (namespacePids?.length !== 1 || namespacePids[0] !== String(process.pid) ||
        !pidNamespacePattern.test(pidNamespace) ||
        selfStat.slice(0, selfStat.indexOf(" ")) !== String(process.pid)) return undefined;
    const stat = pid === process.pid ? selfStat : await readFile(`/proc/${pid}/stat`, "utf8");
    if (stat.slice(0, stat.indexOf(" ")) !== String(pid)) return undefined;
    // comm (field 2) may contain spaces or parentheses; starttime is field 22.
    const startTimeTicks = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[19];
    if (!startTimeTicks || !/^\d+$/.test(startTimeTicks) || !bootIdPattern.test(bootId.trim())) return undefined;
    return { bootId: bootId.trim(), pidNamespace, startTimeTicks };
  } catch { return undefined; }
}

function isLockExpired(record: PersistedLockRecord, now: Date): boolean {
  return new Date(record.expiresAt).getTime() <= now.getTime();
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
