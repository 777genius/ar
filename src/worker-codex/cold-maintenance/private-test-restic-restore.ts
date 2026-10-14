import { execFile } from "node:child_process";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { verifyPrivateColdMaintenance } from "./private-cold-capture";

const exec = promisify(execFile);
function fail(): never { throw new Error("cold_maintenance_disposable_restore_invalid"); }
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (e) { if (typeof e === "object" && e !== null && "code" in e && e.code === "ENOENT") return false; throw e; }
}
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return !!rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Archives an already verified inert TEST receipt, then verifies authenticated restore. */
export async function encryptedDisposableTestColdRestore(input: {
  readonly testRoot: string; readonly captureDirectory: string; readonly expectedManifestSha256: string;
  readonly repositoryDirectory: string; readonly destination: string; readonly receiptPath: string;
  readonly generatedTestPassword: string; readonly restorePassword?: string;
}): Promise<{ readonly snapshotId: string; readonly restoredDirectory: string;
  readonly manifestSha256: string; readonly routingDisabled: true }> {
  if (!isAbsolute(input.testRoot) || resolve(input.testRoot) !== input.testRoot ||
      !basename(input.testRoot).startsWith("test-") ||
      await realpath(input.testRoot) !== input.testRoot ||
      !inside(await realpath(tmpdir()), input.testRoot) ||
      !basename(input.destination).startsWith("test-cold-restored-") ||
      input.generatedTestPassword.length < 32) fail();
  const root = input.testRoot;
  for (const path of [input.captureDirectory, input.repositoryDirectory, input.destination, input.receiptPath]) {
    if (!isAbsolute(path) || resolve(path) !== path || !inside(root, path) ||
        await realpath(dirname(path)) !== root) fail();
  }
  if (!basename(input.captureDirectory).startsWith("cold-maintenance-")) fail();
  if (await exists(input.repositoryDirectory) || await exists(input.destination) || await exists(input.receiptPath)) fail();
  if (await realpath(input.captureDirectory) !== input.captureDirectory) fail();
  const original = await verifyPrivateColdMaintenance(input.captureDirectory, input.expectedManifestSha256);
  if (!original.files.some((file) => file.kind === "sqlite" && file.probe)) fail();
  const env = { PATH: process.env.PATH ?? "", RESTIC_PASSWORD: input.generatedTestPassword,
    XDG_CACHE_HOME: join(root, "restic-cache"), TMPDIR: root, TMP: root, TEMP: root };
  const run = async (password: string, ...args: string[]) => {
    try { return await exec("restic", args, { env: { ...env, RESTIC_PASSWORD: password },
      timeout: 120_000, maxBuffer: 1024 * 1024 }); }
    catch { fail(); }
  };
  await run(input.generatedTestPassword, "-r", input.repositoryDirectory, "init");
  await run(input.generatedTestPassword, "-r", input.repositoryDirectory, "backup", "--", input.captureDirectory);
  const snapshots: unknown = JSON.parse((await run(input.generatedTestPassword,
    "-r", input.repositoryDirectory, "snapshots", "--json")).stdout);
  if (!Array.isArray(snapshots) || snapshots.length !== 1 || !snapshots[0] ||
      typeof snapshots[0] !== "object" || !("id" in snapshots[0]) ||
      typeof snapshots[0].id !== "string" || !/^[a-f0-9]{64}$/.test(snapshots[0].id)) fail();
  const snapshotId = snapshots[0].id;
  await run(input.restorePassword ?? input.generatedTestPassword,
    "-r", input.repositoryDirectory, "restore", snapshotId, "--target", input.destination);
  const restoredDirectory = join(input.destination, input.captureDirectory.slice(1));
  const restored = await verifyPrivateColdMaintenance(restoredDirectory, input.expectedManifestSha256);
  if (JSON.stringify(restored) !== JSON.stringify(original)) fail();
  const receipt = { kind: "inert_test_cold_maintenance_restore", snapshotId,
    restoredDirectory, manifestSha256: input.expectedManifestSha256, routingDisabled: true as const };
  const file = await open(input.receiptPath, "wx", 0o400);
  try { await file.writeFile(`${JSON.stringify(receipt)}\n`); await file.sync(); }
  finally { await file.close(); }
  return { snapshotId, restoredDirectory, manifestSha256: input.expectedManifestSha256, routingDisabled: true };
}
