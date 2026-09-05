import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const ownerFileName = "owner.json";
const ownerMaxBytes = 4 * 1024;
const legacyOwnerGraceMs = 100;

type LockOwner = {
  readonly v: 1;
  readonly token: string;
  readonly hostname: string;
  readonly pid: number;
  readonly acquiredAt: string;
};

export async function withDirectoryLock<T>(
  input: {
    readonly lockPath: string;
    readonly parentDir: string;
    readonly lockTtlMs: number;
    readonly lockAcquireTimeoutMs: number;
    readonly lockPollMs: number;
    readonly timeoutError: string;
  },
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  await mkdir(input.parentDir, { recursive: true, mode: 0o700 });
  let acquiredOwner: LockOwner | undefined;
  while (true) {
    const owner: LockOwner = {
      v: 1,
      token: randomUUID(),
      hostname: hostname(),
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
    };
    try {
      await mkdir(input.lockPath, { recursive: false, mode: 0o700 });
      const acquiringPath = join(input.lockPath, `.acquiring-${owner.token}`);
      const temporaryOwnerPath = join(input.lockPath, `.owner-${owner.token}.tmp`);
      try {
        await mkdir(acquiringPath, { mode: 0o700 });
        await writeFile(temporaryOwnerPath, `${JSON.stringify(owner)}\n`, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
        await rename(temporaryOwnerPath, join(input.lockPath, ownerFileName));
        await rm(acquiringPath, { recursive: true });
        if ((await readOwner(join(input.lockPath, ownerFileName)))?.token !==
            owner.token || await pathExists(join(input.lockPath, ".reclaim"))) {
          throw new LockAcquisitionLostError();
        }
      } catch (error) {
        await rm(temporaryOwnerPath, { force: true }).catch(() => undefined);
        await rm(acquiringPath, { recursive: true, force: true }).catch(() => undefined);
        if ((await readOwner(join(input.lockPath, ownerFileName)))?.token ===
            owner.token) {
          await releaseOwnedLock(input.lockPath, owner.token);
        }
        throw error;
      }
      acquiredOwner = owner;
      break;
    } catch (error) {
      if (error instanceof LockAcquisitionLostError) continue;
      if (!isNodeError(error, "EEXIST")) throw error;
      if (await reclaimAbandonedLock(input)) continue;
      if (performance.now() - startedAt > input.lockAcquireTimeoutMs) {
        throw new Error(input.timeoutError);
      }
      await sleep(input.lockPollMs);
    }
  }
  return await runWithLease(input, acquiredOwner, fn);
}

async function runWithLease<T>(
  input: Parameters<typeof withDirectoryLock>[0],
  owner: LockOwner,
  fn: () => Promise<T>,
): Promise<T> {
  const directoryHandle = await open(input.lockPath, "r").catch(async (error) => {
    await releaseOwnedLock(input.lockPath, owner.token);
    throw error;
  });
  let stopped = false;
  let renewal = Promise.resolve();
  let heartbeat: NodeJS.Timeout | undefined;
  const scheduleHeartbeat = (): void => {
    heartbeat = setTimeout(() => {
      renewal = (async () => {
      if (stopped) return;
      const now = new Date();
      await directoryHandle.utimes(now, now);
      })().catch(() => undefined).finally(() => {
        if (!stopped) scheduleHeartbeat();
      });
    }, Math.max(1, Math.floor(input.lockTtlMs / 3)));
    heartbeat.unref();
  };
  scheduleHeartbeat();
  let actionFailed = false;
  try {
    return await fn();
  } catch (error) {
    actionFailed = true;
    throw error;
  } finally {
    stopped = true;
    if (heartbeat) clearTimeout(heartbeat);
    await renewal;
    let cleanupError: unknown;
    try {
      await directoryHandle.close();
    } catch (error) {
      cleanupError = error;
    }
    try {
      await releaseOwnedLock(input.lockPath, owner.token);
    } catch (error) {
      cleanupError ??= error;
    }
    if (!actionFailed && cleanupError !== undefined) throw cleanupError;
  }
}

async function reclaimAbandonedLock(
  input: Parameters<typeof withDirectoryLock>[0],
): Promise<boolean> {
  let metadata;
  try {
    metadata = await stat(input.lockPath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return true;
    throw error;
  }
  const observedOwner = await readOwner(join(input.lockPath, ownerFileName));
  if (!mayReclaim(observedOwner, Date.now() - metadata.mtimeMs, input.lockTtlMs)) {
    return false;
  }

  const claim = await acquireReclaimClaim(input.lockPath);
  if (!claim) return false;
  try {
    const currentOwner = await readOwner(join(input.lockPath, ownerFileName));
    if (!sameOwner(observedOwner, currentOwner) ||
      !mayReclaim(currentOwner, Date.now() - metadata.mtimeMs, input.lockTtlMs)) {
      return false;
    }
    const stalePath = `${input.lockPath}.stale-${randomUUID()}`;
    try {
      await rename(input.lockPath, stalePath);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return true;
      throw error;
    }
    await rm(stalePath, { recursive: true, force: true });
    return true;
  } finally {
    await releaseReclaimClaim(input.lockPath, claim);
  }
}

async function acquireReclaimClaim(lockPath: string): Promise<LockOwner | undefined> {
  const claimPath = join(lockPath, ".reclaim");
  const claim: LockOwner = {
    v: 1,
    token: randomUUID(),
    hostname: hostname(),
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
  };
  try {
    await mkdir(claimPath, { mode: 0o700 });
    await writeFile(join(claimPath, ownerFileName), `${JSON.stringify(claim)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    return claim;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    if (!isNodeError(error, "EEXIST")) {
      if ((await readOwner(join(claimPath, ownerFileName)))?.token === claim.token) {
        await rm(claimPath, { recursive: true, force: true }).catch(() => undefined);
      }
      throw error;
    }
    await recoverAbandonedReclaimClaim(claimPath);
    return undefined;
  }
}

async function recoverAbandonedReclaimClaim(claimPath: string): Promise<void> {
  const metadata = await stat(claimPath).catch(() => undefined);
  if (!metadata) return;
  const owner = await readOwner(join(claimPath, ownerFileName));
  if (!mayReclaim(owner, Date.now() - metadata.mtimeMs, legacyOwnerGraceMs)) return;
  const stalePath = `${claimPath}.stale-${randomUUID()}`;
  try {
    await rename(claimPath, stalePath);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
    return;
  }
  if (sameOwner(owner, await readOwner(join(stalePath, ownerFileName)))) {
    await rm(stalePath, { recursive: true, force: true });
  } else {
    await rename(stalePath, claimPath).catch(() => undefined);
  }
}

async function releaseReclaimClaim(lockPath: string, claim: LockOwner): Promise<void> {
  const claimPath = join(lockPath, ".reclaim");
  if ((await readOwner(join(claimPath, ownerFileName)))?.token === claim.token) {
    await rm(claimPath, { recursive: true, force: true });
  }
}

function mayReclaim(
  owner: LockOwner | undefined,
  ageMs: number,
  ttlMs: number,
): boolean {
  if (!owner) return ageMs >= Math.max(ttlMs, legacyOwnerGraceMs);
  if (owner.hostname !== hostname()) return false;
  return !processIsAlive(owner.pid);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error, "EPERM");
  }
}

async function releaseOwnedLock(lockPath: string, token: string): Promise<void> {
  if ((await readOwner(join(lockPath, ownerFileName)))?.token !== token) return;
  const releasedPath = `${lockPath}.released-${token}`;
  try {
    await rename(lockPath, releasedPath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return;
    throw error;
  }
  if ((await readOwner(join(releasedPath, ownerFileName)))?.token === token) {
    await rm(releasedPath, { recursive: true, force: true });
    return;
  }
  await rename(releasedPath, lockPath).catch(() => undefined);
}

async function readOwner(path: string): Promise<LockOwner | undefined> {
  let handle;
  try {
    handle = await open(path, "r");
    const buffer = Buffer.alloc(ownerMaxBytes + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const read = await handle.read(
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        bytesRead,
      );
      if (read.bytesRead === 0) break;
      bytesRead += read.bytesRead;
    }
    if (bytesRead > ownerMaxBytes) return undefined;
    const parsed: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
    return isLockOwner(parsed) ? parsed : undefined;
  } catch (error) {
    if (isNodeError(error, "ENOENT") || error instanceof SyntaxError) return undefined;
    throw error;
  } finally {
    await handle?.close();
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

function sameOwner(left: LockOwner | undefined, right: LockOwner | undefined): boolean {
  return left?.token === right?.token && left?.pid === right?.pid &&
    left?.hostname === right?.hostname;
}

function isLockOwner(value: unknown): value is LockOwner {
  return typeof value === "object" && value !== null &&
    (value as LockOwner).v === 1 &&
    typeof (value as LockOwner).token === "string" &&
    (value as LockOwner).token.length > 0 &&
    typeof (value as LockOwner).hostname === "string" &&
    (value as LockOwner).hostname.length > 0 &&
    Number.isSafeInteger((value as LockOwner).pid) &&
    (value as LockOwner).pid > 0 &&
    typeof (value as LockOwner).acquiredAt === "string";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

class LockAcquisitionLostError extends Error {}
