import { execFile } from "node:child_process";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { verifyTestTerminalAttemptCheckpoint } from "./test-terminal-attempt-checkpoint";

const execFileAsync = promisify(execFile);

export type DisposableTestRestoreReceipt = {
  readonly checkpointId: string;
  readonly sealSha256: string;
  readonly snapshotId: string;
  readonly destination: string;
  readonly checks: readonly string[];
  readonly elapsedMs: number;
  readonly terminalWatermark: string;
  readonly recoveryPointAt: string;
  readonly rpoMs: number;
  readonly rollbackPointer: string | null;
  readonly routingDisabled: true;
};

/** Local disposable exercise only. No activation, replay, or source routing. */
export async function restoreDisposableTestCheckpoint(input: {
  readonly testRoot: string;
  readonly sealDirectory: string;
  readonly expectedSealSha256: string;
  readonly repositoryDirectory: string;
  readonly destination: string;
  readonly receiptPath: string;
  readonly generatedTestPassword: string;
}): Promise<DisposableTestRestoreReceipt> {
  if (!isAbsolute(input.testRoot) || !basename(input.testRoot).startsWith("test-") ||
      !basename(input.destination).startsWith("test-checkpoint-restored-") ||
      input.generatedTestPassword.length < 32) {
    throw new Error("terminal_checkpoint_disposable_scope_invalid");
  }
  const root = await realpath(input.testRoot);
  if (root !== input.testRoot) throw new Error("terminal_checkpoint_disposable_scope_invalid");
  for (const path of [input.sealDirectory, input.repositoryDirectory, input.destination, input.receiptPath]) {
    const rel = relative(root, path);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error("terminal_checkpoint_disposable_scope_invalid");
    }
  }
  const sealRealPath = await realpath(input.sealDirectory);
  if (!inside(root, sealRealPath)) throw new Error("terminal_checkpoint_disposable_scope_invalid");
  for (const path of [input.repositoryDirectory, input.destination, input.receiptPath]) {
    const parent = await realpath(dirname(path));
    if (await exists(path) || (parent !== root && !inside(root, parent))) {
      throw new Error("terminal_checkpoint_disposable_scope_invalid");
    }
  }
  const manifest = await verifyTestTerminalAttemptCheckpoint(
    input.sealDirectory, input.expectedSealSha256);
  const started = performance.now();
  const testTemp = process.env.TMPDIR ?? root;
  const env = { PATH: process.env.PATH ?? "", RESTIC_PASSWORD: input.generatedTestPassword,
    XDG_CACHE_HOME: join(root, "restic-cache"),
    TMPDIR: testTemp, TMP: testTemp, TEMP: testTemp };
  const run = async (...args: string[]) => execFileAsync("restic", args, {
    env, timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
  });
  await run("-r", input.repositoryDirectory, "init");
  await run("-r", input.repositoryDirectory, "backup", "--tag", manifest.checkpointId,
    "--", input.sealDirectory);
  const snapshots = JSON.parse((await run("-r", input.repositoryDirectory, "snapshots", "--json")).stdout) as unknown;
  if (!Array.isArray(snapshots) || snapshots.length !== 1 ||
      !snapshots[0] || typeof snapshots[0] !== "object" ||
      !("id" in snapshots[0]) || typeof snapshots[0].id !== "string") {
    throw new Error("terminal_checkpoint_snapshot_identity_invalid");
  }
  const snapshotId = snapshots[0].id;
  await run("-r", input.repositoryDirectory, "restore", snapshotId,
    "--target", input.destination);
  const restoredDirectory = join(input.destination, input.sealDirectory.slice(1));
  const restored = await verifyTestTerminalAttemptCheckpoint(
    restoredDirectory, input.expectedSealSha256);
  if (restored.checkpointId !== manifest.checkpointId ||
      JSON.stringify(restored.identity) !== JSON.stringify(manifest.identity)) {
    throw new Error("terminal_checkpoint_restored_identity_mismatch");
  }
  const receipt: DisposableTestRestoreReceipt = {
    checkpointId: manifest.checkpointId,
    sealSha256: input.expectedSealSha256,
    snapshotId,
    destination: restoredDirectory,
    checks: ["manifest_digest", "payload_hashes", "sqlite_integrity",
      "journal_result_event_sequence", "artifact_references", "sqlite_sequence"],
    elapsedMs: Math.round(performance.now() - started),
    terminalWatermark: manifest.terminalAt,
    recoveryPointAt: manifest.capturedAt,
    rpoMs: Math.max(0, Date.parse(manifest.capturedAt) - Date.parse(manifest.terminalAt)),
    rollbackPointer: manifest.previousCheckpointId ?? null,
    routingDisabled: true,
  };
  const file = await open(input.receiptPath, "wx", 0o400);
  try { await file.writeFile(`${JSON.stringify(receipt, null, 2)}\n`); await file.sync(); }
  finally { await file.close(); }
  return receipt;
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return Boolean(rel) && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}
