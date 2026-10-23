import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import * as files from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { expect, it, vi } from "vitest";
import { LocalFileProviderLock } from "../shared/local-file-custody-lock";
import { captureLocalFileLock } from "./local-file-lock-test-support";

vi.mock("node:fs/promises", async original => ({
  ...await original<typeof import("node:fs/promises")>(),
}));

function signal<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

it.each(["symlink", "relative"])("keeps provider transactions exclusive while reclaiming through a %s root alias", async aliasKind => {
  const parent = await mkdtemp(join(tmpdir(), "ar-custody-alias-"));
  const rootDir = join(parent, "real");
  const aliasRoot = aliasKind === "symlink" ? join(parent, "alias") : relative(process.cwd(), rootDir);
  const providerInstanceId = "alias-session";
  const lockName = `${createHash("sha256").update(providerInstanceId).digest("hex")}.lock`;
  const lockPath = join(rootDir, "leases", "locks", lockName);
  const aliasLockPath = join(aliasRoot, "leases", "locks", lockName);
  const atFirstRemoval = signal(), atAliasRemoval = signal(), firstEntered = signal();
  const aliasGuardAcquired = signal<boolean>(), liveLockRemoved = signal(), thirdEntered = signal();
  const releaseFirst = signal(), releaseThird = signal();
  const operations: Promise<unknown>[] = [];
  let activeOwners = 0, maxActiveOwners = 0;
  let gateFirstRemoval = true, gateAliasRemoval = true, scheduling = true, aliasAttempts = 0;
  const own = async (until?: Promise<void>) => {
    activeOwners += 1;
    maxActiveOwners = Math.max(maxActiveOwners, activeOwners);
    try { await until; }
    finally { activeOwners -= 1; }
  };
  const real = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  try {
    await mkdir(dirname(lockPath), { recursive: true });
    if (aliasKind === "symlink") await symlink(rootDir, aliasRoot, "dir");
    const { ownerProcess } = await captureLocalFileLock(rootDir);
    await writeFile(lockPath, JSON.stringify({ storageVersion: "local-file-lease-lock-v1", lockId: "dead-owner",
      providerInstanceIdHash: "test", pid: 999_999, ownerProcess,
      acquiredAt: "2020-01-01T00:00:00Z", expiresAt: "2020-01-01T00:00:01Z" }));

    vi.spyOn(files, "link").mockImplementation(async (source, target) => {
      // Let the first reclaimer own the replacement before this contender retries.
      if (String(target) === aliasLockPath && ++aliasAttempts > 1) await firstEntered.promise;
      const aliasCleanup = dirname(String(target)) === dirname(aliasLockPath) && String(target).endsWith(".cleanup.lock");
      try {
        await real.link(source, target);
        if (aliasCleanup) aliasGuardAcquired.resolve(true);
      } catch (error) {
        if (aliasCleanup && (error as NodeJS.ErrnoException).code === "EEXIST") aliasGuardAcquired.resolve(false);
        throw error;
      }
    });
    vi.spyOn(files, "rename").mockImplementation(async (source, target) => {
      if (String(source) === lockPath && String(target).endsWith(".removing") && gateFirstRemoval) {
        gateFirstRemoval = false;
        atFirstRemoval.resolve();
        // Distinct cleanup mutexes allow both removers to pass their stale read.
        if (await aliasGuardAcquired.promise) await atAliasRemoval.promise;
      }
      if (String(source) === aliasLockPath && String(target).endsWith(".removing") && gateAliasRemoval && scheduling) {
        gateAliasRemoval = false;
        atAliasRemoval.resolve();
        await firstEntered.promise;
        await real.rename(source, target);
        liveLockRemoved.resolve();
        await thirdEntered.promise;
        return;
      }
      await real.rename(source, target);
    });

    const first = new LocalFileProviderLock({ rootDir }).run(providerInstanceId, async () => {
      firstEntered.resolve();
      await own(releaseFirst.promise);
    });
    operations.push(first);
    await atFirstRemoval.promise;
    const alias = new LocalFileProviderLock({ rootDir: aliasRoot, lockPollMs: 1 }).run(providerInstanceId, () => own());
    operations.push(alias);
    const separateCleanupMutex = await aliasGuardAcquired.promise;
    await firstEntered.promise;
    if (separateCleanupMutex) await liveLockRemoved.promise;

    const third = new LocalFileProviderLock({ rootDir, lockAcquireTimeoutMs: 50, lockPollMs: 1 }).run(providerInstanceId, async () => {
      thirdEntered.resolve();
      await own(releaseThird.promise);
    });
    const thirdSettled = third.then(() => "entered", error => {
      expect(error).toMatchObject({ message: "local_file_lease_lock_timeout" });
      return "blocked";
    });
    operations.push(thirdSettled);
    await Promise.race([thirdEntered.promise, thirdSettled]);
    expect(maxActiveOwners).toBe(1);
    expect(await thirdSettled).toBe("blocked");
    scheduling = false;
    releaseFirst.resolve();
    await Promise.all([first, alias]);
    expect(maxActiveOwners).toBe(1);
  } finally {
    scheduling = false;
    releaseFirst.resolve(); releaseThird.resolve(); thirdEntered.resolve();
    await Promise.allSettled(operations);
    vi.restoreAllMocks();
    try { expect(await readdir(dirname(lockPath))).toEqual([]); }
    finally { await rm(parent, { recursive: true, force: true }); }
  }
});
