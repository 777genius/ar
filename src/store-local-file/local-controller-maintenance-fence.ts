import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type LocalControllerMaintenanceFence = {
  readonly path: string;
  readonly ownerToken: string;
};

export type LocalControllerActivityLease = {
  readonly path: string;
  readonly ownerToken: string;
};

export async function acquireLocalControllerMaintenanceFence(input: {
  readonly controllerJobRootDir: string;
  readonly owner: string;
}): Promise<LocalControllerMaintenanceFence> {
  const root = resolve(input.controllerJobRootDir);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const path = join(root, ".controller-maintenance-fence.json");
  const ownerToken = randomUUID();
  const temporaryPath = `${path}.${process.pid}.${ownerToken}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify({
    schemaVersion: 1,
    owner: input.owner,
    ownerToken,
    pid: process.pid,
    processStartIdentity: await processStartIdentity(process.pid),
    createdAt: new Date().toISOString(),
  })}\n`, { mode: 0o600, flag: "wx" });
  try {
    await link(temporaryPath, path);
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) throw error;
    if (await recoverDeadFence(path)) {
      return await acquireLocalControllerMaintenanceFence(input);
    }
    throw new Error("controller_maintenance_fence_active");
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
  try {
    if (await liveActivityLeaseCount(root) > 0) {
      throw new Error("controller_maintenance_activity_active");
    }
  } catch (error) {
    await unlink(path).catch(() => undefined);
    throw error;
  }
  return { path, ownerToken };
}

export async function acquireLocalControllerActivityLease(input: {
  readonly controllerJobRootDir: string;
  readonly owner: string;
}): Promise<LocalControllerActivityLease> {
  const root = resolve(input.controllerJobRootDir);
  await assertLocalControllerMaintenanceFenceOpen(root);
  const directory = join(root, ".controller-activity-leases");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const ownerToken = randomUUID();
  const path = join(directory, `${ownerToken}.json`);
  await writeFile(path, `${JSON.stringify({
    schemaVersion: 1,
    owner: input.owner,
    ownerToken,
    pid: process.pid,
    processStartIdentity: await processStartIdentity(process.pid),
    createdAt: new Date().toISOString(),
  })}\n`, { mode: 0o600, flag: "wx" });
  try {
    await assertLocalControllerMaintenanceFenceOpen(root);
  } catch (error) {
    await unlink(path).catch(() => undefined);
    throw error;
  }
  return { path, ownerToken };
}

export async function releaseLocalControllerActivityLease(
  lease: LocalControllerActivityLease,
): Promise<void> {
  const owner: unknown = JSON.parse(await readFile(lease.path, "utf8"));
  if (!isRecord(owner) || owner.ownerToken !== lease.ownerToken) {
    throw new Error("controller_activity_lease_owner_mismatch");
  }
  await unlink(lease.path);
}

export async function withLocalControllerActivityLease<T>(input: {
  readonly controllerJobRootDir: string;
  readonly owner: string;
  readonly effect: () => Promise<T>;
}): Promise<T> {
  const lease = await acquireLocalControllerActivityLease(input);
  try {
    return await input.effect();
  } finally {
    await releaseLocalControllerActivityLease(lease);
  }
}

export async function assertLocalControllerMaintenanceFenceOpen(
  controllerJobRootDir: string,
): Promise<void> {
  try {
    await readFile(join(resolve(controllerJobRootDir), ".controller-maintenance-fence.json"));
    throw new Error("controller_maintenance_fence_active");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return;
    throw error;
  }
}

export async function releaseLocalControllerMaintenanceFence(
  fence: LocalControllerMaintenanceFence,
): Promise<void> {
  const owner: unknown = JSON.parse(await readFile(fence.path, "utf8"));
  if (!isRecord(owner) || owner.ownerToken !== fence.ownerToken) {
    throw new Error("controller_maintenance_fence_owner_mismatch");
  }
  await unlink(fence.path);
}

async function recoverDeadFence(path: string): Promise<boolean> {
  const observedBytes = await readFile(path);
  const owner: unknown = JSON.parse(observedBytes.toString("utf8"));
  if (
    !isRecord(owner) || typeof owner.pid !== "number" ||
    !Number.isInteger(owner.pid) || owner.pid <= 0 ||
    typeof owner.processStartIdentity !== "string"
  ) return false;
  const currentIdentity = await observedProcessStartIdentity(owner.pid);
  if (currentIdentity === owner.processStartIdentity) return false;
  const fencedPath = `${path}.stale-${
    createHash("sha256").update(observedBytes).digest("hex")
  }`;
  let claimMatches = false;
  try {
    await link(path, fencedPath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return true;
    if (!isNodeError(error, "EEXIST")) throw error;
  }
  try {
    const [current, fenced] = await Promise.all([stat(path), stat(fencedPath)]);
    claimMatches = current.dev === fenced.dev && current.ino === fenced.ino &&
      (await readFile(fencedPath)).equals(observedBytes);
    if (!claimMatches) return false;
    await unlink(path).catch((error) => {
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

async function liveActivityLeaseCount(root: string): Promise<number> {
  const directory = join(root, ".controller-activity-leases");
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return 0;
    throw error;
  }
  let live = 0;
  for (const entry of entries) {
    const path = join(directory, entry);
    const owner: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(owner) || typeof owner.pid !== "number" ||
      typeof owner.processStartIdentity !== "string"
    ) {
      live += 1;
      continue;
    }
    const current = await observedProcessStartIdentity(owner.pid);
    if (current === owner.processStartIdentity) live += 1;
    else await unlink(path).catch(() => undefined);
  }
  return live;
}

async function processStartIdentity(pid: number): Promise<string> {
  const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "lstart="]);
  const value = stdout.trim();
  if (!value) throw new Error("controller_maintenance_process_identity_unavailable");
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
      throw new Error("controller_maintenance_process_identity_indeterminate");
    }
    throw new Error("controller_maintenance_process_identity_indeterminate");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}
