import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type LocalConsumedOutputLedgerMaintenanceLease = {
  readonly lockPath: string;
  readonly ownerToken: string;
  readonly ledgerRoot: string;
  readonly device?: number;
  readonly inode?: number;
};

export async function acquireConsumedOutputLedgerMaintenanceLock(input: {
  readonly ledgerRoot: string;
  readonly owner: string;
}): Promise<LocalConsumedOutputLedgerMaintenanceLease> {
  const requestedRoot = await canonicalProspectiveRoot(input.ledgerRoot);
  const rootMetadata = await optionalDirectoryIdentity(requestedRoot);
  const lockBoundary = await realpath(dirname(dirname(requestedRoot)));
  const lockPath = join(
    lockBoundary,
    ".consumed-output-ledger-maintenance.lock",
  );
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const ownerToken = randomUUID();
  const temporaryPath = `${lockPath}.${process.pid}.${ownerToken}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify({
    schemaVersion: 1,
    owner: input.owner,
    ownerToken,
    pid: process.pid,
    processStartIdentity: await processStartIdentity(process.pid),
    createdAt: new Date().toISOString(),
  })}\n`, { mode: 0o600, flag: "wx" });
  try {
    await link(temporaryPath, lockPath);
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) throw error;
    if (await recoverDeadOwner(lockPath)) {
      return await acquireConsumedOutputLedgerMaintenanceLock(input);
    }
    throw new Error("consumed_output_ledger_maintenance_locked");
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
  if (rootMetadata && !await directoryIdentityMatches(requestedRoot, rootMetadata)) {
    await releaseOwnedMaintenanceLock(lockPath, ownerToken);
    throw new Error("consumed_output_ledger_maintenance_root_identity_drift");
  }
  return {
    lockPath,
    ownerToken,
    ledgerRoot: requestedRoot,
    ...(rootMetadata ? {
      device: rootMetadata.dev,
      inode: rootMetadata.ino,
    } : {}),
  };
}

async function recoverDeadOwner(lockPath: string): Promise<boolean> {
  const observedBytes = await readFile(lockPath);
  const owner: unknown = JSON.parse(observedBytes.toString("utf8"));
  if (
    !isRecord(owner) || typeof owner.pid !== "number" ||
    !Number.isInteger(owner.pid) || owner.pid <= 0 ||
    typeof owner.processStartIdentity !== "string"
  ) {
    return false;
  }
  const currentIdentity = await observedProcessStartIdentity(owner.pid);
  if (currentIdentity === owner.processStartIdentity) return false;
  const fencedPath = `${lockPath}.stale-${
    createHash("sha256").update(observedBytes).digest("hex")
  }`;
  let claimMatches = false;
  try {
    await link(lockPath, fencedPath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return true;
    if (!isNodeError(error, "EEXIST")) throw error;
  }
  try {
    const [current, fenced] = await Promise.all([stat(lockPath), stat(fencedPath)]);
    claimMatches = current.dev === fenced.dev && current.ino === fenced.ino &&
      (await readFile(fencedPath)).equals(observedBytes);
    if (!claimMatches) return false;
    await unlink(lockPath).catch((error) => {
      if (!isNodeError(error, "ENOENT")) throw error;
    });
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return true;
    throw error;
  } finally {
    if (claimMatches) await unlink(fencedPath).catch(() => undefined);
  }
}

export async function releaseConsumedOutputLedgerMaintenanceLock(
  lease: LocalConsumedOutputLedgerMaintenanceLease,
): Promise<void> {
  const drifted = lease.device !== undefined && lease.inode !== undefined &&
    !await directoryIdentityMatches(lease.ledgerRoot, {
      dev: lease.device,
      ino: lease.inode,
    });
  const owner: unknown = JSON.parse(await readFile(lease.lockPath, "utf8"));
  if (!isRecord(owner) || owner.ownerToken !== lease.ownerToken) {
    throw new Error("consumed_output_ledger_maintenance_lock_owner_mismatch");
  }
  await unlink(lease.lockPath);
  if (drifted) {
    throw new Error("consumed_output_ledger_maintenance_root_identity_drift");
  }
}

async function canonicalProspectiveRoot(value: string): Promise<string> {
  const requested = resolve(value);
  const missing: string[] = [];
  let current = requested;
  while (true) {
    try {
      const metadata = await lstat(current);
      if (!metadata.isDirectory() && !metadata.isSymbolicLink()) {
        throw new Error("consumed_output_ledger_maintenance_root_unsafe");
      }
      return join(await realpath(current), ...missing.reverse());
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.push(basename(current));
      current = parent;
    }
  }
}

async function optionalDirectoryIdentity(
  path: string,
): Promise<{ readonly dev: number; readonly ino: number } | undefined> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("consumed_output_ledger_maintenance_root_unsafe");
    }
    return { dev: metadata.dev, ino: metadata.ino };
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function directoryIdentityMatches(
  path: string,
  expected: { readonly dev: number; readonly ino: number },
): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    return !metadata.isSymbolicLink() && metadata.isDirectory() &&
      metadata.dev === expected.dev && metadata.ino === expected.ino &&
      await realpath(path) === path;
  } catch {
    return false;
  }
}

async function releaseOwnedMaintenanceLock(
  lockPath: string,
  ownerToken: string,
): Promise<void> {
  try {
    const owner: unknown = JSON.parse(await readFile(lockPath, "utf8"));
    if (isRecord(owner) && owner.ownerToken === ownerToken) await unlink(lockPath);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
}

async function processStartIdentity(pid: number): Promise<string> {
  const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "lstart="]);
  const value = stdout.trim();
  if (!value) throw new Error("consumed_output_ledger_process_identity_unavailable");
  return value;
}

async function observedProcessStartIdentity(pid: number): Promise<string | undefined> {
  try {
    return await processStartIdentity(pid);
  } catch {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (isNodeError(error, "ESRCH")) return undefined;
      throw new Error("consumed_output_ledger_process_identity_indeterminate");
    }
    throw new Error("consumed_output_ledger_process_identity_indeterminate");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}
