import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type LocalConsumedOutputLedgerMaintenanceLease = {
  readonly lockPath: string;
  readonly ownerToken: string;
};

export async function acquireConsumedOutputLedgerMaintenanceLock(input: {
  readonly ledgerRoot: string;
  readonly owner: string;
}): Promise<LocalConsumedOutputLedgerMaintenanceLease> {
  const lockBoundary = await realpath(dirname(dirname(resolve(input.ledgerRoot))));
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
  return { lockPath, ownerToken };
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
  const owner: unknown = JSON.parse(await readFile(lease.lockPath, "utf8"));
  if (!isRecord(owner) || owner.ownerToken !== lease.ownerToken) {
    throw new Error("consumed_output_ledger_maintenance_lock_owner_mismatch");
  }
  await unlink(lease.lockPath);
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
